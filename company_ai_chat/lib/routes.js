// API ルートハンドラ
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { db, hashPassword, currentMonth } = require('./db');
const auth = require('./auth');
const openai = require('./openai');
const google = require('./google_auth');

const PRIVATE_RATIO_WARN = Number(process.env.PRIVATE_RATIO_WARN || 0.3); // 警告する私的利用率
const PRIVATE_MIN_COUNT = Number(process.env.PRIVATE_MIN_COUNT || 5);     // 警告に必要な最低判定数
const BUDGET_ALERT_RATIO = 0.8;                                           // 予算アラート閾値

// ---- 予算・ロック関連 ----

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

function deptStatus(dept) {
  const used = monthCostJpy(dept.id);
  const overBudget = used >= dept.monthly_budget_jpy;
  const unlocked = dept.unlock_month === currentMonth();
  return {
    id: dept.id,
    name: dept.name,
    monthly_budget_jpy: dept.monthly_budget_jpy,
    used_jpy: used,
    ratio: dept.monthly_budget_jpy > 0 ? used / dept.monthly_budget_jpy : 0,
    locked: overBudget && !unlocked,
    over_budget: overBudget,
    unlocked_by_admin: unlocked,
  };
}

function getUserDept(user) {
  if (!user.department_id) return null;
  const dept = db.prepare('SELECT * FROM departments WHERE id = ?').get(user.department_id);
  return dept ? deptStatus(dept) : null;
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

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new Error('body too large');
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
      },
      department: dept,
      warnings,
      my_month_cost_jpy: myCost,
      my_private_stats: stats,
      mock_mode: openai.MOCK,
      budget_alert: dept && !dept.locked && dept.ratio >= BUDGET_ALERT_RATIO,
    });
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

  // 会話
  if (method === 'GET' && pathname === '/api/conversations') {
    const rows = db.prepare(
      'SELECT id, title, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC'
    ).all(user.id);
    return json(res, 200, rows);
  }
  if (method === 'POST' && pathname === '/api/conversations') {
    const id = db.prepare('INSERT INTO conversations (user_id) VALUES (?)').run(user.id).lastInsertRowid;
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
    if (method === 'DELETE' && !convMatch[2]) {
      // 会話内の生成画像ファイルも一緒に削除する(孤児ファイル防止)
      const imageRows = db.prepare(
        "SELECT content FROM messages WHERE conversation_id = ? AND content LIKE '%/api/files/%'"
      ).all(convId);
      for (const row of imageRows) {
        for (const m of row.content.matchAll(/\/api\/files\/([a-f0-9]{16,32}\.(?:png|svg))/g)) {
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

  // 生成画像の配信(ログイン必須、ファイル名はランダムhexのみ許可)
  const fileMatch = pathname.match(/^\/api\/files\/([a-f0-9]{16,32}\.(?:png|svg))$/);
  if (method === 'GET' && fileMatch) {
    const filePath = path.join(openai.IMAGES_DIR, fileMatch[1]);
    let data;
    try {
      data = await fs.promises.readFile(filePath);
    } catch {
      return json(res, 404, { error: 'not found' });
    }
    res.writeHead(200, {
      'Content-Type': fileMatch[1].endsWith('.png') ? 'image/png' : 'image/svg+xml',
      'Cache-Control': 'private, max-age=86400',
    });
    res.end(data);
    return true;
  }

  json(res, 404, { error: 'not found' });
  return true;
}

async function handleChat(req, res, user) {
  const { conversation_id, message, confirmed, model_pref } = await readBody(req);
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
      error: `部署「${dept.name}」の今月の予算(${Math.round(dept.monthly_budget_jpy).toLocaleString()}円)を超過したためロックされています。管理者に解除を依頼してください。`,
      locked: true,
    });
  }

  // ルーティング: 内容に応じてモデルを自動選択
  let route;
  if (confirmed === true) {
    // sensitive の人間確認済み → 高性能モデルで実行(再分類しない)
    route = { category: 'sensitive', model: openai.HEAVY_MODEL, promptTokens: 0, completionTokens: 0 };
  } else if (model_pref === 'light') {
    route = { category: 'light', model: openai.LIGHT_MODEL, promptTokens: 0, completionTokens: 0 };
  } else if (model_pref === 'heavy') {
    route = { category: 'heavy', model: openai.HEAVY_MODEL, promptTokens: 0, completionTokens: 0 };
  } else {
    route = await openai.routeMessage(text);
  }
  if (route.promptTokens || route.completionTokens) {
    const cost = openai.costJpy(openai.CLASSIFIER_MODEL, route.promptTokens, route.completionTokens);
    db.prepare(`
      INSERT INTO usage_log (user_id, department_id, model, kind, prompt_tokens, completion_tokens, cost_jpy)
      VALUES (?, ?, ?, 'classify', ?, ?, ?)
    `).run(user.id, user.department_id, openai.CLASSIFIER_MODEL, route.promptTokens, route.completionTokens, cost);
  }

  // 送信・削除・金額・個人情報が絡むものは実行前に人間確認を求める
  // (ルーター障害で判定できなかった場合もフェイルクローズでここに来る)
  if (route.category === 'sensitive' && confirmed !== true) {
    return json(res, 200, {
      needs_confirmation: true,
      category: 'sensitive',
      router_error: route.routerFailed === true,
    });
  }

  // ユーザー発言を保存し、初回ならタイトルに反映
  db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)').run(conv.id, 'user', text);
  const msgCount = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(conv.id).n;
  if (msgCount === 1) {
    db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(text.slice(0, 30), conv.id);
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
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

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
      const img = await openai.generateImage(text);
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
    }, route.model);
    const cost = saveAssistant(result.content, result.model, result.promptTokens, result.completionTokens);
    sendDone(cost, result.model);
  } catch (err) {
    console.error('[chat]', err);
    // 途中まで生成された分も保存し、概算トークンで予算に計上する(集計漏れ防止)
    if (partial) {
      saveAssistant(partial, route.model,
        openai.estimateTokens(history), Math.ceil(partial.length / 3));
    }
    send('error', { message: 'AI応答の取得に失敗しました。時間をおいて再度お試しください。' });
  }
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

async function handleAdmin(req, res, method, pathname) {
  const admin = requireAdmin(req, res);
  if (!admin) return true;

  if (method === 'GET' && pathname === '/api/admin/overview') {
    const month = currentMonth();
    const departments = db.prepare('SELECT * FROM departments ORDER BY id').all().map(deptStatus);
    const users = db.prepare(`
      SELECT u.id, u.username, u.display_name, u.role, u.disabled, u.department_id, u.created_at,
             u.email, u.status, (u.google_sub IS NOT NULL) AS is_google, d.name AS department_name
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
