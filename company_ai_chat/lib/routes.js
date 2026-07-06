// API ルートハンドラ
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { db, hashPassword, currentMonth, DEFAULT_TEMPLATES } = require('./db');
const auth = require('./auth');
const openai = require('./openai');
const pop = require('./pop');
const docs = require('./docs');
const google = require('./google_auth');
const mailer = require('./mailer');

const PRIVATE_RATIO_WARN = Number(process.env.PRIVATE_RATIO_WARN || 0.3); // 警告する私的利用率
const PRIVATE_MIN_COUNT = Number(process.env.PRIVATE_MIN_COUNT || 5);     // 警告に必要な最低判定数
const BUDGET_ALERT_RATIO = 0.8;                                           // 予算アラート閾値

// ---- 予算・ロック関連 ----
// 月の予算を「1ヶ月30日・3日ごと」で10期間に分割し、少しずつ解放していくペース配分方式。
// 総額(1500円など)をユーザーには見せず、期間ごとの利用ペースだけを見せる。
const PERIOD_DAYS = 3;
const PERIOD_COUNT = 10;
const MAX_ADVANCE_PER_MONTH = 3; // 「前倒しで使う」の月間上限回数

function monthCostJpy(departmentId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(cost_jpy), 0) AS c FROM usage_log
    WHERE department_id = ? AND strftime('%Y-%m', created_at) = ?
  `).get(departmentId, currentMonth());
  return row.c;
}

function userMonthCostJpy(userId, month) {
  return db.prepare(`
    SELECT COALESCE(SUM(cost_jpy), 0) AS c FROM usage_log
    WHERE user_id = ? AND strftime('%Y-%m', created_at) = ?
  `).get(userId, month).c;
}

// 当日が月内のどの3日間期間(0-9番目)に属するかを求める。
// 31日目がある月は最後(10番目)の期間に含める。
function periodInfo(now = new Date()) {
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed
  const day = now.getDate();
  const periodIndex = Math.min(PERIOD_COUNT - 1, Math.floor((day - 1) / PERIOD_DAYS));
  const monthKey = `${year}-${String(month + 1).padStart(2, '0')}`;
  const periodStartDay = periodIndex * PERIOD_DAYS + 1;
  const isLastPeriod = periodIndex === PERIOD_COUNT - 1;
  const lastDayOfMonth = new Date(year, month + 1, 0).getDate();
  const periodEndDay = isLastPeriod ? lastDayOfMonth : periodStartDay + PERIOD_DAYS - 1;
  const nextPeriodDate = isLastPeriod ? new Date(year, month + 1, 1) : new Date(year, month, periodStartDay + PERIOD_DAYS);
  return {
    monthKey,
    periodIndex,
    periodKey: `${monthKey}-P${periodIndex}`,
    periodsElapsed: periodIndex + 1, // 1-10
    periodStartDay,
    periodEndDay,
    nextPeriodLabel: `${nextPeriodDate.getMonth() + 1}/${nextPeriodDate.getDate()}`,
  };
}

function periodCostJpy(departmentId, info) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(cost_jpy), 0) AS c FROM usage_log
    WHERE department_id = ? AND strftime('%Y-%m', created_at) = ?
      AND CAST(strftime('%d', created_at) AS INTEGER) BETWEEN ? AND ?
  `).get(departmentId, info.monthKey, info.periodStartDay, info.periodEndDay);
  return row.c;
}

function deptStatus(dept) {
  const info = periodInfo();
  const used = monthCostJpy(dept.id);
  const periodBudget = dept.monthly_budget_jpy / PERIOD_COUNT;
  // 前倒し分は当月内でのみ有効(月が変われば0に戻る)
  const advanceUsed = dept.advance_month === info.monthKey ? dept.advance_used : 0;
  const releasedPeriods = Math.min(PERIOD_COUNT, info.periodsElapsed + advanceUsed);
  const releasedBudget = dept.monthly_budget_jpy * releasedPeriods / PERIOD_COUNT;
  const unlockedByAdmin = dept.unlock_month === info.monthKey;
  const overReleased = used >= releasedBudget;
  const locked = overReleased && !unlockedByAdmin;
  return {
    id: dept.id,
    name: dept.name,
    monthly_budget_jpy: dept.monthly_budget_jpy,
    used_jpy: used,
    ratio: releasedBudget > 0 ? used / releasedBudget : 0,
    locked,
    over_budget: overReleased,
    unlocked_by_admin: unlockedByAdmin,
    // ペース配分(ユーザー向け表示用): 総額ではなく期間の進み具合を見せる
    period_number: info.periodsElapsed,
    period_total: PERIOD_COUNT,
    period_budget_jpy: periodBudget,
    period_used_jpy: periodCostJpy(dept.id, info),
    next_period_label: info.nextPeriodLabel,
    advance_used: advanceUsed,
    advance_remaining: Math.max(0, MAX_ADVANCE_PER_MONTH - advanceUsed),
    advance_available: releasedPeriods < PERIOD_COUNT && advanceUsed < MAX_ADVANCE_PER_MONTH,
  };
}

function getUserDept(user) {
  if (!user.department_id) return null;
  const dept = db.prepare('SELECT * FROM departments WHERE id = ?').get(user.department_id);
  return dept ? deptStatus(dept) : null;
}

// ---- テンプレート(ユーザーごとの個人管理) ----

// 初めてテンプレートを開くユーザーに、個人用の初期セットを複製する
function seedUserTemplatesIfEmpty(userId) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM prompt_templates WHERE user_id = ?').get(userId).n;
  if (count > 0) return;
  const insert = db.prepare('INSERT INTO prompt_templates (user_id, label, prompt, position) VALUES (?, ?, ?, ?)');
  DEFAULT_TEMPLATES.forEach((t, i) => insert.run(userId, t.label, t.prompt, i));
}

// ---- 私的利用の集計・警告 ----

function privateStats(userId, month) {
  const rows = db.prepare(`
    SELECT label, COUNT(*) AS n FROM classifications
    WHERE user_id = ? AND strftime('%Y-%m', created_at) = ?
    GROUP BY label
  `).all(userId, month);
  const counts = { work: 0, private: 0, unknown: 0 };
  for (const r of rows) counts[r.label] = r.n;
  const judged = counts.work + counts.private;
  return { ...counts, judged, private_ratio: judged > 0 ? counts.private / judged : 0 };
}

// 分類のたびに呼ぶ。閾値超過なら同月1回だけ自動警告を作成する。
function maybeWarnPrivateUsage(user) {
  const month = currentMonth();
  const stats = privateStats(user.id, month);
  if (stats.judged < PRIVATE_MIN_COUNT || stats.private_ratio < PRIVATE_RATIO_WARN) return;
  const exists = db.prepare(
    "SELECT 1 FROM warnings WHERE user_id = ? AND type = 'private_ratio' AND month = ?"
  ).get(user.id, month);
  if (exists) return;
  db.prepare('INSERT INTO warnings (user_id, type, message, month) VALUES (?, ?, ?, ?)').run(
    user.id,
    'private_ratio',
    `今月の利用のうち私的利用と判定された割合が ${Math.round(stats.private_ratio * 100)}% に達しています。` +
      '本ツールは業務目的での利用をお願いします。',
    month
  );
}

// ---- ユーティリティ ----

// 予算入力を数値に変換する。カンマ・空白は許容し、
// 解釈できない値は null を返す(0円への化けを防ぐ)。
function parseBudget(value) {
  const cleaned = String(value).replace(/[,\s円]/g, '');
  if (cleaned === '') return null; // 空欄を0円と解釈してロックさせない
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
  return true; // handle() の「処理済み」戻り値としてそのまま返せるようにする
}

async function readBody(req, maxBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > maxBytes) throw new Error('body too large');
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}

function requireUser(req, res) {
  const user = auth.getUser(req);
  if (!user) {
    json(res, 401, { error: 'ログインしてください' });
    return null;
  }
  return user;
}

function requireAdmin(req, res) {
  const user = requireUser(req, res);
  if (!user) return null;
  if (user.role !== 'admin') {
    json(res, 403, { error: '管理者権限が必要です' });
    return null;
  }
  return user;
}

// ---- メール通知 ----

async function notifyAdminsOfNewApplication(user) {
  const admins = db.prepare(
    "SELECT email FROM users WHERE role = 'admin' AND status = 'active' AND disabled = 0 AND email IS NOT NULL"
  ).all();
  const url = process.env.BASE_URL || '';
  const body =
    `社内AIチャットに利用申請がありました。\n\n` +
    `氏名: ${user.requested_name || user.display_name}\n` +
    `メール: ${user.email}\n` +
    `希望部署: ${user.requested_department || '(未記入)'}\n\n` +
    `管理画面のユーザータブから、部署を割り当てて承認してください。\n${url}`;
  for (const a of admins) {
    await mailer.sendMail(a.email, '【社内AIチャット】新規ユーザーの承認依頼', body);
  }
}

async function notifyUserApproved(user) {
  if (!user.email) return;
  const url = process.env.BASE_URL || '';
  await mailer.sendMail(
    user.email,
    '【社内AIチャット】アカウントが承認されました',
    `${user.requested_name || user.display_name} 様\n\n` +
      `社内AIチャットのご利用が承認されました。下記URLからログインしてご利用いただけます。\n${url}`
  );
}

// ---- Google ログイン ----

function redirect(res, location, extraCookie) {
  const headers = { Location: location };
  if (extraCookie) headers['Set-Cookie'] = extraCookie;
  res.writeHead(302, headers);
  res.end();
  return true;
}

function handleGoogleStart(req, res) {
  if (!google.ENABLED) {
    return redirect(res, '/?login_error=' + encodeURIComponent('Googleログインが未設定です(GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)'));
  }
  const state = crypto.randomBytes(16).toString('hex');
  return redirect(res, google.authUrl(state), auth.oauthStateCookie(state));
}

async function handleGoogleCallback(req, res, url) {
  const fail = (msg) => redirect(res, '/?login_error=' + encodeURIComponent(msg), auth.clearOauthStateCookie());
  try {
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    if (!code || !state || state !== auth.parseCookies(req).oauth_state) {
      return fail('Googleログインに失敗しました(state不一致)。もう一度お試しください。');
    }
    const profile = await google.exchangeCode(code);

    // google_sub → email の順で既存ユーザーを探し、なければ承認待ちで新規作成
    let user = db.prepare('SELECT * FROM users WHERE google_sub = ?').get(profile.sub);
    if (!user) {
      user = db.prepare('SELECT * FROM users WHERE email = ? OR username = ?').get(profile.email, profile.email);
      if (user) db.prepare('UPDATE users SET google_sub = ?, email = ? WHERE id = ?').run(profile.sub, profile.email, user.id);
    }
    if (!user) {
      const id = db.prepare(`
        INSERT INTO users (username, display_name, password_hash, role, department_id, google_sub, email, status)
        VALUES (?, ?, '', 'user', NULL, ?, ?, 'pending')
      `).run(profile.email, profile.name, profile.sub, profile.email).lastInsertRowid;
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      console.log(`[auth] Google 新規ユーザー(承認待ち): ${profile.email}`);
    }
    if (user.disabled) return fail('このアカウントは停止されています。管理者にお問い合わせください。');

    const token = auth.createSession(user.id);
    res.setHeader('Set-Cookie', [auth.sessionCookie(token), auth.clearOauthStateCookie()]);
    return redirect(res, '/');
  } catch (err) {
    console.error('[google auth]', err.message);
    return fail('Googleログインに失敗しました。もう一度お試しください。');
  }
}

// ---- ルーティング本体 ----

// handle(req, res, method, pathname) → true なら処理済み
async function handle(req, res, method, pathname, url) {
  if (method === 'GET' && pathname === '/auth/google') return handleGoogleStart(req, res);
  if (method === 'GET' && pathname === '/auth/google/callback') return handleGoogleCallback(req, res, url);

  // 認証
  if (method === 'POST' && pathname === '/api/login') {
    const { username, password } = await readBody(req);
    const result = auth.login(String(username || ''), String(password || ''));
    if (!result) return json(res, 401, { error: 'ユーザー名またはパスワードが違います' });
    res.setHeader('Set-Cookie', auth.sessionCookie(result.token));
    return json(res, 200, { ok: true });
  }
  if (method === 'POST' && pathname === '/api/logout') {
    auth.logout(auth.parseCookies(req).session);
    res.setHeader('Set-Cookie', auth.clearCookie());
    return json(res, 200, { ok: true });
  }

  // ログイン画面用の公開設定
  if (method === 'GET' && pathname === '/api/config') {
    return json(res, 200, { google_enabled: google.ENABLED });
  }

  if (!pathname.startsWith('/api/')) return false;

  // ここから先は要ログイン
  if (pathname.startsWith('/api/admin/')) return handleAdmin(req, res, method, pathname);

  const user = requireUser(req, res);
  if (!user) return true;

  // 定型文テンプレート(ユーザーごとに個人管理、最少1件・最大5件)
  if (method === 'GET' && pathname === '/api/templates') {
    seedUserTemplatesIfEmpty(user.id);
    const rows = db.prepare('SELECT id, label, prompt FROM prompt_templates WHERE user_id = ? ORDER BY position, id').all(user.id);
    return json(res, 200, rows);
  }

  if (method === 'POST' && pathname === '/api/templates') {
    const count = db.prepare('SELECT COUNT(*) AS n FROM prompt_templates WHERE user_id = ?').get(user.id).n;
    if (count >= TEMPLATE_MAX) {
      return json(res, 400, { error: `テンプレートは最大${TEMPLATE_MAX}個までです` });
    }
    const { label, prompt } = await readBody(req);
    if (!String(label || '').trim() || !String(prompt || '').trim()) {
      return json(res, 400, { error: 'ラベルと内容を入力してください' });
    }
    const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM prompt_templates WHERE user_id = ?').get(user.id).p;
    const id = db.prepare('INSERT INTO prompt_templates (user_id, label, prompt, position) VALUES (?, ?, ?, ?)')
      .run(user.id, String(label).trim(), String(prompt).trim(), maxPos + 1).lastInsertRowid;
    return json(res, 200, { id });
  }

  const templateDupMatch = pathname.match(/^\/api\/templates\/(\d+)\/duplicate$/);
  if (method === 'POST' && templateDupMatch) {
    const count = db.prepare('SELECT COUNT(*) AS n FROM prompt_templates WHERE user_id = ?').get(user.id).n;
    if (count >= TEMPLATE_MAX) {
      return json(res, 400, { error: `テンプレートは最大${TEMPLATE_MAX}個までです` });
    }
    const src = db.prepare('SELECT * FROM prompt_templates WHERE id = ? AND user_id = ?').get(Number(templateDupMatch[1]), user.id);
    if (!src) return json(res, 404, { error: 'テンプレートが見つかりません' });
    const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM prompt_templates WHERE user_id = ?').get(user.id).p;
    const id = db.prepare('INSERT INTO prompt_templates (user_id, label, prompt, position) VALUES (?, ?, ?, ?)')
      .run(user.id, `${src.label}のコピー`, src.prompt, maxPos + 1).lastInsertRowid;
    return json(res, 200, { id });
  }

  const templateMatch = pathname.match(/^\/api\/templates\/(\d+)$/);
  if (method === 'PATCH' && templateMatch) {
    const id = Number(templateMatch[1]);
    const existing = db.prepare('SELECT * FROM prompt_templates WHERE id = ? AND user_id = ?').get(id, user.id);
    if (!existing) return json(res, 404, { error: 'テンプレートが見つかりません' });
    const { label, prompt } = await readBody(req);
    if (!String(label || '').trim() || !String(prompt || '').trim()) {
      return json(res, 400, { error: 'ラベルと内容を入力してください' });
    }
    db.prepare("UPDATE prompt_templates SET label = ?, prompt = ?, updated_at = datetime('now', 'localtime') WHERE id = ?")
      .run(String(label).trim(), String(prompt).trim(), id);
    return json(res, 200, { ok: true });
  }

  if (method === 'DELETE' && templateMatch) {
    const id = Number(templateMatch[1]);
    const existing = db.prepare('SELECT * FROM prompt_templates WHERE id = ? AND user_id = ?').get(id, user.id);
    if (!existing) return json(res, 404, { error: 'テンプレートが見つかりません' });
    const count = db.prepare('SELECT COUNT(*) AS n FROM prompt_templates WHERE user_id = ?').get(user.id).n;
    if (count <= TEMPLATE_MIN) {
      return json(res, 400, { error: `テンプレートは最低${TEMPLATE_MIN}個は必要です` });
    }
    db.prepare('DELETE FROM prompt_templates WHERE id = ?').run(id);
    return json(res, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/me') {
    const dept = getUserDept(user);
    const warnings = db.prepare(
      'SELECT id, type, message, created_at FROM warnings WHERE user_id = ? AND acknowledged = 0 ORDER BY id DESC'
    ).all(user.id);
    const stats = privateStats(user.id, currentMonth());
    const myCost = userMonthCostJpy(user.id, currentMonth());
    return json(res, 200, {
      user: {
        id: user.id, username: user.username, display_name: user.display_name,
        role: user.role, status: user.status, email: user.email,
        requested_name: user.requested_name, requested_department: user.requested_department,
      },
      department: dept,
      warnings,
      my_month_cost_jpy: myCost,
      my_private_stats: stats,
      mock_mode: openai.MOCK,
      budget_alert: dept && !dept.locked && dept.ratio >= BUDGET_ALERT_RATIO,
    });
  }

  // 承認待ちユーザーが氏名・希望部署を自己申告する(この時点で管理者に通知メール)
  if (method === 'POST' && pathname === '/api/apply') {
    const { name, department } = await readBody(req);
    const requestedName = String(name || '').trim().slice(0, 50);
    const requestedDept = String(department || '').trim().slice(0, 50);
    if (!requestedName || !requestedDept) {
      return json(res, 400, { error: '氏名と希望部署を入力してください' });
    }
    db.prepare('UPDATE users SET requested_name = ?, requested_department = ? WHERE id = ?')
      .run(requestedName, requestedDept, user.id);
    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    notifyAdminsOfNewApplication(updated).catch((err) => console.error('[mailer]', err.message));
    return json(res, 200, { ok: true });
  }

  if (method === 'POST' && pathname.startsWith('/api/warnings/') && pathname.endsWith('/ack')) {
    const id = Number(pathname.split('/')[3]);
    db.prepare('UPDATE warnings SET acknowledged = 1 WHERE id = ? AND user_id = ?').run(id, user.id);
    return json(res, 200, { ok: true });
  }

  // ここから先(会話・チャット)は承認済みユーザーのみ
  if (user.status === 'pending') {
    return json(res, 403, { error: 'アカウントは管理者の承認待ちです。承認されるまでお待ちください。', pending: true });
  }

  // 次の期間の予算枠を先取りする「前倒しで使う」(月3回まで)
  if (method === 'POST' && pathname === '/api/budget/advance') {
    if (!user.department_id) return json(res, 400, { error: '部署が設定されていません。' });
    const dept = db.prepare('SELECT * FROM departments WHERE id = ?').get(user.department_id);
    const info = periodInfo();
    const used = dept.advance_month === info.monthKey ? dept.advance_used : 0;
    if (used >= MAX_ADVANCE_PER_MONTH) {
      return json(res, 400, { error: `前倒しは月${MAX_ADVANCE_PER_MONTH}回までです。` });
    }
    if (info.periodsElapsed + used >= PERIOD_COUNT) {
      return json(res, 400, { error: '今月分の予算枠はすでにすべて利用可能です。' });
    }
    db.prepare('UPDATE departments SET advance_used = ?, advance_month = ? WHERE id = ?')
      .run(used + 1, info.monthKey, user.department_id);
    return json(res, 200, { department: getUserDept(user) });
  }

  // プロジェクト(チャットのフォルダ分け)
  if (method === 'GET' && pathname === '/api/projects') {
    const rows = db.prepare('SELECT id, name FROM projects WHERE user_id = ? ORDER BY id').all(user.id);
    return json(res, 200, rows);
  }
  if (method === 'POST' && pathname === '/api/projects') {
    const { name } = await readBody(req);
    const trimmed = String(name || '').trim().slice(0, 40);
    if (!trimmed) return json(res, 400, { error: 'プロジェクト名を入力してください' });
    const id = db.prepare('INSERT INTO projects (user_id, name) VALUES (?, ?)').run(user.id, trimmed).lastInsertRowid;
    return json(res, 200, { id });
  }
  const projectMatch = pathname.match(/^\/api\/projects\/(\d+)$/);
  if (projectMatch) {
    const projId = Number(projectMatch[1]);
    const proj = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(projId, user.id);
    if (!proj) return json(res, 404, { error: 'プロジェクトが見つかりません' });
    if (method === 'PATCH') {
      const { name } = await readBody(req);
      const trimmed = String(name || '').trim().slice(0, 40);
      if (!trimmed) return json(res, 400, { error: 'プロジェクト名を入力してください' });
      db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(trimmed, projId);
      return json(res, 200, { ok: true });
    }
    if (method === 'DELETE') {
      // 中のチャットは削除せず、プロジェクト未所属に戻す
      db.prepare('UPDATE conversations SET project_id = NULL WHERE project_id = ?').run(projId);
      db.prepare('DELETE FROM projects WHERE id = ?').run(projId);
      return json(res, 200, { ok: true });
    }
  }

  // 会話
  if (method === 'GET' && pathname === '/api/conversations') {
    const rows = db.prepare(
      'SELECT id, title, updated_at, pinned, archived, project_id FROM conversations WHERE user_id = ? ORDER BY pinned DESC, updated_at DESC'
    ).all(user.id);
    return json(res, 200, rows);
  }
  if (method === 'POST' && pathname === '/api/conversations') {
    const { project_id } = await readBody(req);
    let projId = null;
    if (project_id) {
      const proj = db.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').get(Number(project_id), user.id);
      if (proj) projId = proj.id;
    }
    const id = db.prepare('INSERT INTO conversations (user_id, project_id) VALUES (?, ?)').run(user.id, projId).lastInsertRowid;
    return json(res, 200, { id });
  }

  const convMatch = pathname.match(/^\/api\/conversations\/(\d+)(\/messages)?$/);
  if (convMatch) {
    const convId = Number(convMatch[1]);
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(convId, user.id);
    if (!conv) return json(res, 404, { error: '会話が見つかりません' });
    if (method === 'GET' && convMatch[2]) {
      const rows = db.prepare(
        'SELECT id, role, content, model, created_at FROM messages WHERE conversation_id = ? ORDER BY id'
      ).all(convId);
      return json(res, 200, rows);
    }
    // 名前の変更・ピン留め・アーカイブ・プロジェクト移動
    if (method === 'PATCH' && !convMatch[2]) {
      const body = await readBody(req);
      if (body.title !== undefined) {
        const title = String(body.title).trim().slice(0, 60);
        if (!title) return json(res, 400, { error: 'タイトルを入力してください' });
        db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, convId);
      }
      if (body.pinned !== undefined) {
        db.prepare('UPDATE conversations SET pinned = ? WHERE id = ?').run(body.pinned ? 1 : 0, convId);
      }
      if (body.archived !== undefined) {
        db.prepare('UPDATE conversations SET archived = ? WHERE id = ?').run(body.archived ? 1 : 0, convId);
      }
      if (body.project_id !== undefined) {
        if (body.project_id === null) {
          db.prepare('UPDATE conversations SET project_id = NULL WHERE id = ?').run(convId);
        } else {
          const proj = db.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').get(Number(body.project_id), user.id);
          if (!proj) return json(res, 404, { error: 'プロジェクトが見つかりません' });
          db.prepare('UPDATE conversations SET project_id = ? WHERE id = ?').run(proj.id, convId);
        }
      }
      return json(res, 200, { ok: true });
    }
    if (method === 'DELETE' && !convMatch[2]) {
      // 会話内の生成画像・添付画像ファイルも一緒に削除する(孤児ファイル防止)
      const imageRows = db.prepare(
        "SELECT content FROM messages WHERE conversation_id = ? AND content LIKE '%/api/files/%'"
      ).all(convId);
      for (const row of imageRows) {
        for (const m of row.content.matchAll(/\/api\/files\/([a-f0-9]{16,32}\.(?:png|svg|jpg|jpeg|webp|gif))/g)) {
          try { fs.unlinkSync(path.join(openai.IMAGES_DIR, m[1])); } catch { /* 既に無ければ無視 */ }
        }
      }
      db.prepare('DELETE FROM conversations WHERE id = ?').run(convId);
      return json(res, 200, { ok: true });
    }
  }

  // チャット送信 (SSE ストリーミング)
  if (method === 'POST' && pathname === '/api/chat') {
    return handleChat(req, res, user);
  }

  // 添付画像のアップロード(base64 JSON、8MBまで)
  if (method === 'POST' && pathname === '/api/upload') {
    let body;
    try {
      body = await readBody(req, 12_000_000); // base64膨張分を見込んだ上限
    } catch {
      return json(res, 400, { error: 'ファイルが大きすぎます(8MBまで)' });
    }
    const ext = String(body.name || '').toLowerCase().match(/\.(png|jpe?g|webp|gif)$/)?.[1];
    if (!ext) return json(res, 400, { error: '対応していない形式です(png / jpg / webp / gif)' });
    const buf = Buffer.from(String(body.data || ''), 'base64');
    if (buf.length === 0) return json(res, 400, { error: 'ファイルの読み込みに失敗しました' });
    if (buf.length > 8_000_000) return json(res, 400, { error: 'ファイルサイズは8MBまでです' });
    const file = `${crypto.randomBytes(12).toString('hex')}.${ext === 'jpeg' ? 'jpg' : ext}`;
    await fs.promises.writeFile(path.join(openai.IMAGES_DIR, file), buf);
    return json(res, 200, { url: `/api/files/${file}` });
  }

  // PDF・Word・Excelの添付ファイルからテキストを抽出する(base64 JSON、8MBまで)
  if (method === 'POST' && pathname === '/api/extract-text') {
    let body;
    try {
      body = await readBody(req, 12_000_000);
    } catch {
      return json(res, 400, { error: 'ファイルが大きすぎます(8MBまで)' });
    }
    if (!docs.DOC_EXT_RE.test(String(body.name || ''))) {
      return json(res, 400, { error: '対応していない形式です(pdf / docx / xlsx / xls)' });
    }
    const buf = Buffer.from(String(body.data || ''), 'base64');
    if (buf.length === 0) return json(res, 400, { error: 'ファイルの読み込みに失敗しました' });
    if (buf.length > 8_000_000) return json(res, 400, { error: 'ファイルサイズは8MBまでです' });
    try {
      const text = await docs.extractDocText(body.name, buf);
      return json(res, 200, { text });
    } catch (err) {
      console.error('[extract-text]', err.message);
      return json(res, 400, { error: 'ファイルの読み込みに失敗しました。内容を確認してください' });
    }
  }

  // 商品写真をAIで切り抜き・明るさ補正する時の指示文(商品自体は変えない)
  const POP_ENHANCE_PROMPT =
    '商品の背景を白く綺麗に切り抜いて、明るく鮮明に補正してください。' +
    '商品自体の形・色・デザインは変えないでください。文字は追加しないでください。';

  // POP作成ツール: 見出し・価格は必ずSVGで確実に合成する(価格が消えたり変わったりしない)。
  // 元になる商品画像は「写真から」(AIで切り抜き・明るさ補正)か「新規作成」(AIで一から生成)を選べる。
  if (method === 'POST' && pathname === '/api/pop') {
    const body = await readBody(req);
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
      .get(Number(body.conversation_id), user.id);
    if (!conv) return json(res, 404, { error: '会話が見つかりません' });

    const headline = String(body.headline || '').trim().slice(0, 20);
    const price = String(body.price || '').trim().slice(0, 20);
    if (!headline || !price) return json(res, 400, { error: '見出しと価格を入力してください' });
    const color = pop.COLORS.includes(body.color) ? body.color : 'pink';
    const aspect = pop.ASPECTS.includes(body.aspect) ? body.aspect : 'square';
    const mode = body.mode === 'generate' ? 'generate' : 'photo';

    // 写真の加工・新規生成はAI利用のためコストが発生する。予算ロック中は実行しない。
    const dept = getUserDept(user);
    if (!dept) return json(res, 400, { error: '部署が設定されていません。管理者に連絡してください。' });
    if (dept.locked) {
      return json(res, 403, {
        error: `部署「${dept.name}」の今期の利用枠を使い切りました。次の期間までお待ちいただくか、「前倒しで使う」ボタンをご利用ください。`,
        locked: true,
      });
    }

    const FILE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' };
    let result;
    try {
      if (mode === 'photo') {
        const photoMatch = String(body.photo_url || '').match(/^\/api\/files\/([a-f0-9]{16,32}\.(?:png|jpe?g|webp|gif))$/);
        if (!photoMatch) return json(res, 400, { error: '商品写真をアップロードしてください' });
        let photoBuffer;
        try {
          photoBuffer = await fs.promises.readFile(path.join(openai.IMAGES_DIR, photoMatch[1]));
        } catch {
          return json(res, 400, { error: '写真の読み込みに失敗しました。もう一度アップロードしてください' });
        }
        const photoMime = FILE_MIME[photoMatch[1].split('.').pop()];
        result = await openai.editImage(POP_ENHANCE_PROMPT, [{ buffer: photoBuffer, mime: photoMime, name: photoMatch[1] }]);
      } else {
        const description = String(body.description || '').trim().slice(0, 500);
        if (!description) return json(res, 400, { error: '作りたい商品の説明を入力してください' });
        result = await openai.generateImage(description);
      }
    } catch (err) {
      console.error('[pop]', err);
      return json(res, 400, { error: '画像の作成に失敗しました。時間をおいて再度お試しください' });
    }
    const productBuffer = await fs.promises.readFile(path.join(openai.IMAGES_DIR, result.file));
    const productMime = FILE_MIME[result.file.split('.').pop()];
    const { model: aiModel, costJpy: aiCostJpy } = result;

    const svg = pop.buildPopSvg({ photoBuffer: productBuffer, photoMime: productMime, headline, price, color, aspect });
    const file = `${crypto.randomBytes(12).toString('hex')}.svg`;
    await fs.promises.writeFile(path.join(openai.IMAGES_DIR, file), svg);

    db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)')
      .run(conv.id, 'user', `POP作成(${mode === 'photo' ? '写真から' : '新規作成'}): 見出し「${headline}」/ 価格「${price}」`);
    const msgCount = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(conv.id).n;
    if (msgCount === 1) {
      db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(`POP: ${headline}`.slice(0, 30), conv.id);
    }
    db.prepare(`
      INSERT INTO usage_log (user_id, department_id, model, kind, prompt_tokens, completion_tokens, cost_jpy)
      VALUES (?, ?, ?, 'chat', 0, 0, ?)
    `).run(user.id, user.department_id, aiModel, aiCostJpy);
    db.prepare('INSERT INTO messages (conversation_id, role, content, model) VALUES (?, ?, ?, ?)')
      .run(conv.id, 'assistant', `![POP](/api/files/${file})`, 'pop-tool');
    db.prepare("UPDATE conversations SET updated_at = datetime('now', 'localtime') WHERE id = ?").run(conv.id);
    return json(res, 200, { ok: true, url: `/api/files/${file}` });
  }

  // 生成画像・添付画像の配信(ログイン必須、ファイル名はランダムhexのみ許可)
  const fileMatch = pathname.match(/^\/api\/files\/([a-f0-9]{16,32}\.(?:png|svg|jpg|jpeg|webp|gif))$/);
  if (method === 'GET' && fileMatch) {
    const filePath = path.join(openai.IMAGES_DIR, fileMatch[1]);
    let data;
    try {
      data = await fs.promises.readFile(filePath);
    } catch {
      return json(res, 404, { error: 'not found' });
    }
    const types = {
      png: 'image/png', svg: 'image/svg+xml', jpg: 'image/jpeg',
      jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
    };
    res.writeHead(200, {
      'Content-Type': types[fileMatch[1].split('.').pop()],
      'Cache-Control': 'private, max-age=86400',
    });
    res.end(data);
    return true;
  }

  json(res, 404, { error: 'not found' });
  return true;
}

async function handleChat(req, res, user) {
  const { conversation_id, message, model_pref } = await readBody(req);
  const text = String(message || '').trim();
  if (!text) return json(res, 400, { error: 'メッセージが空です' });

  const conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
    .get(Number(conversation_id), user.id);
  if (!conv) return json(res, 404, { error: '会話が見つかりません' });

  // 予算ロック確認
  const dept = getUserDept(user);
  if (!dept) return json(res, 400, { error: '部署が設定されていません。管理者に連絡してください。' });
  if (dept.locked) {
    return json(res, 403, {
      error: `部署「${dept.name}」の今期(${dept.period_number}/${dept.period_total}期)の利用枠を使い切りました。` +
        `次の期間(${dept.next_period_label}〜)までお待ちいただくか、「前倒しで使う」ボタンをご利用ください。`,
      locked: true,
    });
  }

  // モデル・画像生成はユーザーが手動で選択する(自動判定は行わない)
  let route;
  if (model_pref === 'heavy') {
    route = { category: 'heavy', model: openai.HEAVY_MODEL };
  } else if (model_pref === 'image') {
    route = { category: 'image', model: openai.IMAGE_MODEL };
  } else {
    route = { category: 'light', model: openai.LIGHT_MODEL };
  }

  // ユーザー発言を保存し、初回ならタイトルに反映
  db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)').run(conv.id, 'user', text);
  const msgCount = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(conv.id).n;
  if (msgCount === 1) {
    // タイトルには添付ファイル(画像参照・テキスト本文)を含めない
    const plain = text
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/【添付ファイル: [^】]*】\n```[\s\S]*?```/g, '')
      .trim();
    db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run((plain || '添付ファイル').slice(0, 30), conv.id);
  }

  const history = db.prepare(
    'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 20'
  ).all(conv.id).reverse();

  // SSE 開始
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // クライアントが停止/切断した後に書き込みを試みてもエラーにならないようにする
  const send = (event, data) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // 「停止」ボタン押下やタブを閉じるなどでクライアントが切断したら、
  // OpenAI側へのリクエストも中断してトークンの無駄遣いを防ぐ
  const controller = new AbortController();
  let finished = false;
  req.on('close', () => { if (!finished) controller.abort(); });

  const saveAssistant = (content, model, promptTokens, completionTokens, fixedCostJpy) => {
    db.prepare('INSERT INTO messages (conversation_id, role, content, model) VALUES (?, ?, ?, ?)')
      .run(conv.id, 'assistant', content, model);
    db.prepare("UPDATE conversations SET updated_at = datetime('now', 'localtime') WHERE id = ?").run(conv.id);
    const cost = fixedCostJpy !== undefined ? fixedCostJpy : openai.costJpy(model, promptTokens, completionTokens);
    db.prepare(`
      INSERT INTO usage_log (user_id, department_id, model, kind, prompt_tokens, completion_tokens, cost_jpy)
      VALUES (?, ?, ?, 'chat', ?, ?, ?)
    `).run(user.id, user.department_id, model, promptTokens, completionTokens, cost);
    return cost;
  };

  const sendDone = (cost, model) => {
    const after = getUserDept(user);
    send('done', {
      cost_jpy: cost,
      model,
      category: route.category,
      dept: after && { used_jpy: after.used_jpy, budget: after.monthly_budget_jpy, locked: after.locked, ratio: after.ratio },
    });
  };

  if (route.category === 'image') {
    // 画像生成(ストリーミングなし)
    try {
      send('delta', { text: '🎨 画像を生成しています…' });
      // 入力されたテキストをそのままプロンプトとしてAPIに渡す
      const img = await openai.createImage(text);
      const content = `![生成画像](/api/files/${img.file})`;
      const cost = saveAssistant(content, img.model, 0, 0, img.costJpy);
      send('replace', { text: content });
      sendDone(cost, img.model);
    } catch (err) {
      console.error('[image]', err);
      send('error', { message: '画像の生成に失敗しました。時間をおいて再度お試しください。' });
    }
    res.end();
    classifyAsync(user, text);
    return true;
  }

  let partial = '';
  try {
    const result = await openai.streamChat(history, (delta) => {
      partial += delta;
      send('delta', { text: delta });
    }, route.model, controller.signal);
    const cost = saveAssistant(result.content, result.model, result.promptTokens, result.completionTokens);
    sendDone(cost, result.model);
  } catch (err) {
    finished = true;
    // 途中まで生成された分は、停止によるものでも保存し概算トークンで予算に計上する(集計漏れ防止)
    if (partial) {
      saveAssistant(partial, route.model,
        openai.estimateTokens(history), Math.ceil(partial.length / 3));
    }
    if (err.name !== 'AbortError') {
      console.error('[chat]', err);
      send('error', { message: 'AI応答の取得に失敗しました。時間をおいて再度お試しください。' });
    }
  }
  finished = true;
  res.end();

  // 仕事/プライベート判定は応答と切り離して非同期実行(ラベルのみ保存)
  classifyAsync(user, text);
  return true;
}

async function classifyAsync(user, text) {
  try {
    const r = await openai.classify(text);
    db.prepare('INSERT INTO classifications (user_id, department_id, label) VALUES (?, ?, ?)')
      .run(user.id, user.department_id, r.label);
    if (r.promptTokens || r.completionTokens) {
      const cost = openai.costJpy(r.model, r.promptTokens, r.completionTokens);
      db.prepare(`
        INSERT INTO usage_log (user_id, department_id, model, kind, prompt_tokens, completion_tokens, cost_jpy)
        VALUES (?, ?, ?, 'classify', ?, ?, ?)
      `).run(user.id, user.department_id, r.model, r.promptTokens, r.completionTokens, cost);
    }
    maybeWarnPrivateUsage(user);
  } catch (err) {
    console.error('[classifyAsync]', err.message);
  }
}

// ---- 管理者 API ----

const TEMPLATE_MIN = 1;
const TEMPLATE_MAX = 5;

async function handleAdmin(req, res, method, pathname) {
  const admin = requireAdmin(req, res);
  if (!admin) return true;

  if (method === 'GET' && pathname === '/api/admin/overview') {
    const month = currentMonth();
    const departments = db.prepare('SELECT * FROM departments ORDER BY id').all().map(deptStatus);
    const users = db.prepare(`
      SELECT u.id, u.username, u.display_name, u.role, u.disabled, u.department_id, u.created_at,
             u.email, u.status, (u.google_sub IS NOT NULL) AS is_google, d.name AS department_name,
             u.requested_name, u.requested_department
      FROM users u LEFT JOIN departments d ON d.id = u.department_id ORDER BY u.id
    `).all().map((u) => {
      const stats = privateStats(u.id, month);
      const cost = userMonthCostJpy(u.id, month);
      const warningCount = db.prepare(
        'SELECT COUNT(*) AS n FROM warnings WHERE user_id = ? AND month = ?'
      ).get(u.id, month).n;
      return { ...u, month_cost_jpy: cost, stats, warning_count: warningCount };
    });
    const daily = db.prepare(`
      SELECT date(created_at) AS day, COALESCE(SUM(cost_jpy), 0) AS cost
      FROM usage_log
      WHERE created_at >= date('now', 'localtime', '-29 days')
      GROUP BY day ORDER BY day
    `).all();
    const recentWarnings = db.prepare(`
      SELECT w.*, u.display_name FROM warnings w JOIN users u ON u.id = w.user_id
      ORDER BY w.id DESC LIMIT 50
    `).all();
    return json(res, 200, { month, departments, users, daily, warnings: recentWarnings });
  }

  if (method === 'POST' && pathname === '/api/admin/departments') {
    const { name, monthly_budget_jpy } = await readBody(req);
    if (!name) return json(res, 400, { error: '部署名は必須です' });
    const budget = monthly_budget_jpy === undefined || monthly_budget_jpy === ''
      ? 50000
      : parseBudget(monthly_budget_jpy);
    if (budget === null) return json(res, 400, { error: '予算は0以上の数値で入力してください' });
    try {
      const id = db.prepare('INSERT INTO departments (name, monthly_budget_jpy) VALUES (?, ?)')
        .run(String(name), budget).lastInsertRowid;
      return json(res, 200, { id });
    } catch {
      return json(res, 400, { error: '同名の部署が既に存在します' });
    }
  }

  const deptMatch = pathname.match(/^\/api\/admin\/departments\/(\d+)$/);
  if (method === 'PATCH' && deptMatch) {
    const id = Number(deptMatch[1]);
    const dept = db.prepare('SELECT * FROM departments WHERE id = ?').get(id);
    if (!dept) return json(res, 404, { error: '部署が見つかりません' });
    const body = await readBody(req);
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) return json(res, 400, { error: '部署名を入力してください' });
      try {
        db.prepare('UPDATE departments SET name = ? WHERE id = ?').run(name, id);
      } catch {
        return json(res, 400, { error: '同名の部署が既に存在します' });
      }
    }
    if (body.monthly_budget_jpy !== undefined) {
      const budget = parseBudget(body.monthly_budget_jpy);
      if (budget === null) return json(res, 400, { error: '予算は0以上の数値で入力してください' });
      db.prepare('UPDATE departments SET monthly_budget_jpy = ? WHERE id = ?').run(budget, id);
    }
    if (body.unlock === true) {
      db.prepare('UPDATE departments SET unlock_month = ? WHERE id = ?').run(currentMonth(), id);
    }
    if (body.unlock === false) {
      db.prepare('UPDATE departments SET unlock_month = NULL WHERE id = ?').run(id);
    }
    return json(res, 200, deptStatus(db.prepare('SELECT * FROM departments WHERE id = ?').get(id)));
  }

  if (method === 'DELETE' && deptMatch) {
    const id = Number(deptMatch[1]);
    const dept = db.prepare('SELECT * FROM departments WHERE id = ?').get(id);
    if (!dept) return json(res, 404, { error: '部署が見つかりません' });
    // 履歴データ(利用ログ・判定結果)は削除せず、所属だけ外して保持する
    db.prepare('UPDATE users SET department_id = NULL WHERE department_id = ?').run(id);
    db.prepare('UPDATE usage_log SET department_id = NULL WHERE department_id = ?').run(id);
    db.prepare('UPDATE classifications SET department_id = NULL WHERE department_id = ?').run(id);
    db.prepare('DELETE FROM departments WHERE id = ?').run(id);
    return json(res, 200, { ok: true });
  }

  if (method === 'POST' && pathname === '/api/admin/users') {
    const { username, display_name, password, role, department_id } = await readBody(req);
    if (!username || !password) return json(res, 400, { error: 'ユーザー名とパスワードは必須です' });
    try {
      const id = db.prepare(`
        INSERT INTO users (username, display_name, password_hash, role, department_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        String(username),
        String(display_name || username),
        hashPassword(String(password)),
        role === 'admin' ? 'admin' : 'user',
        Number(department_id) || null
      ).lastInsertRowid;
      return json(res, 200, { id });
    } catch {
      return json(res, 400, { error: '同名のユーザーが既に存在します' });
    }
  }

  const userMatch = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
  if (method === 'PATCH' && userMatch) {
    const id = Number(userMatch[1]);
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!target) return json(res, 404, { error: 'ユーザーが見つかりません' });
    const body = await readBody(req);
    // 最後の有効な管理者を降格・停止すると誰も管理できなくなるため拒否する
    const removesAdmin = target.role === 'admin' &&
      ((body.role && body.role !== 'admin') || body.disabled === true);
    if (removesAdmin) {
      const others = db.prepare(
        "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?"
      ).get(id).n;
      if (others === 0) {
        return json(res, 400, { error: '最後の管理者を降格・停止することはできません。先に別の管理者を作成してください。' });
      }
    }
    if (body.department_id !== undefined) {
      db.prepare('UPDATE users SET department_id = ? WHERE id = ?').run(Number(body.department_id) || null, id);
    }
    if (body.role) {
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(body.role === 'admin' ? 'admin' : 'user', id);
    }
    if (body.disabled !== undefined) {
      db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(body.disabled ? 1 : 0, id);
      if (body.disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
    // 承認: status を active にする(通常は department_id とセットで送られる)
    if (body.status === 'active' || body.status === 'pending') {
      db.prepare('UPDATE users SET status = ? WHERE id = ?').run(body.status, id);
      if (body.status === 'active' && target.status === 'pending') {
        const approved = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
        notifyUserApproved(approved).catch((err) => console.error('[mailer]', err.message));
      }
    }
    if (body.password) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(body.password)), id);
    } else if (body.password === '') {
      // 明示的な空文字はパスワードログインを無効化する(Googleログイン専用にする)
      db.prepare("UPDATE users SET password_hash = '' WHERE id = ?").run(id);
    }
    if (body.email !== undefined) {
      // Googleログイン時、このメールアドレスと一致すれば既存ユーザーに自動で紐付く
      db.prepare('UPDATE users SET email = ? WHERE id = ?').run(String(body.email) || null, id);
    }
    return json(res, 200, { ok: true });
  }

  // 管理者からの手動警告
  const warnMatch = pathname.match(/^\/api\/admin\/users\/(\d+)\/warn$/);
  if (method === 'POST' && warnMatch) {
    const id = Number(warnMatch[1]);
    const { message } = await readBody(req);
    db.prepare('INSERT INTO warnings (user_id, type, message, month) VALUES (?, ?, ?, ?)').run(
      id,
      'manual',
      String(message || '管理者から利用方法について注意があります。'),
      currentMonth()
    );
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: 'not found' });
  return true;
}

module.exports = { handle };
