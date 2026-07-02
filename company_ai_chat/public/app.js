// 社内AIチャット フロントエンド (vanilla JS SPA)
'use strict';

const $app = document.getElementById('app');

const state = {
  me: null,          // /api/me の結果
  conversations: [],
  currentConvId: null,
  messages: [],
  streaming: false,
  view: 'chat',      // 'chat' | 'admin'
  adminTab: 'dashboard',
  adminData: null,
  modelPref: 'auto', // 'auto' | 'light' | 'heavy'
};

// ---------- ユーティリティ ----------

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function yen(n) {
  return Math.round(n).toLocaleString('ja-JP') + '円';
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'エラー'), { status: res.status, data });
  return data;
}

// 簡易 Markdown レンダラ(コードブロック / インラインコード / 太字 / 改行)
function renderMarkdown(text) {
  const parts = String(text).split(/```/);
  let html = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const body = parts[i].replace(/^[\w+-]*\n/, '');
      html += `<pre><code>${esc(body)}</code></pre>`;
    } else {
      let t = esc(parts[i]);
      // 生成画像(自サーバー配信のパスのみ許可)
      t = t.replace(/!\[([^\]]*)\]\((\/api\/files\/[\w.-]+)\)/g,
        '<img src="$2" alt="$1" class="gen-image" loading="lazy">');
      t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
      t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      t = t.replace(/^### (.+)$/gm, '<strong>$1</strong>');
      html += t.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
    }
  }
  return html;
}

// ---------- 初期化 ----------

async function loadMe() {
  try {
    state.me = await api('/api/me');
    return true;
  } catch {
    state.me = null;
    return false;
  }
}

async function init() {
  if (await loadMe()) {
    if (state.me.user.status === 'pending') {
      renderPending();
      return;
    }
    await loadConversations();
    render();
  } else {
    renderLogin();
  }
}

// Google ログイン直後の未承認ユーザー向け画面
function renderPending() {
  const me = state.me;
  $app.innerHTML = `
    <div class="login-wrap">
      <div class="login-card" style="text-align:center">
        <div style="font-size:40px">⏳</div>
        <h1 style="font-size:19px">承認待ちです</h1>
        <p style="color:var(--ink-2);font-size:13.5px;line-height:1.8">
          ${esc(me.user.display_name)} さん(${esc(me.user.email || me.user.username)})のアカウントは作成されました。<br>
          管理者が部署を割り当てて承認すると利用できるようになります。
        </p>
        <button class="btn-ghost" id="btn-logout" style="margin-top:10px">ログアウト</button>
      </div>
    </div>`;
  document.getElementById('btn-logout').onclick = async () => {
    await api('/api/logout', { method: 'POST' });
    location.reload();
  };
}

// ---------- ログイン ----------

async function renderLogin() {
  let config = { google_enabled: false };
  try { config = await api('/api/config'); } catch { /* 既定値のまま */ }
  const loginError = new URLSearchParams(location.search).get('login_error') || '';

  $app.innerHTML = `
    <div class="login-wrap">
      <form class="login-card" id="login-form">
        <h1>💬 社内AIチャット</h1>
        <div class="sub">アカウントでログインしてください</div>
        ${config.google_enabled ? `
        <a class="btn-google" href="/auth/google">
          <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
          Google でログイン
        </a>
        <div class="login-note">初めての方は Google ログイン後、管理者の承認をお待ちください。</div>
        <div class="divider"><span>または</span></div>` : ''}
        <label>ユーザー名</label>
        <input name="username" autocomplete="username" required ${config.google_enabled ? '' : 'autofocus'}>
        <label>パスワード</label>
        <input name="password" type="password" autocomplete="current-password" required>
        <button class="btn-primary" type="submit">ログイン</button>
        <div class="login-error" id="login-error">${esc(loginError)}</div>
      </form>
    </div>`;
  if (loginError) history.replaceState(null, '', '/');
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/login', { method: 'POST', body: { username: fd.get('username'), password: fd.get('password') } });
      await init();
    } catch (err) {
      document.getElementById('login-error').textContent = err.message;
    }
  });
}

// ---------- メインレイアウト ----------

async function loadConversations() {
  state.conversations = await api('/api/conversations');
}

function render() {
  const me = state.me;
  const dept = me.department;
  const usedRatio = dept ? Math.min(1, dept.ratio) : 0;
  const meterClass = dept && dept.locked ? 'over' : usedRatio >= 0.8 ? 'warn' : '';

  $app.innerHTML = `
    <div class="layout">
      <nav class="sidebar">
        <button class="new-chat-btn" id="new-chat">＋ 新しいチャット</button>
        <div class="conv-list" id="conv-list"></div>
        <div class="sidebar-footer">
          <div class="sidebar-user">
            <div class="avatar">${esc(me.user.display_name.slice(0, 1))}</div>
            <div>
              <div class="name">${esc(me.user.display_name)}</div>
              <div class="dept">${dept ? esc(dept.name) : '部署未設定'}${me.user.role === 'admin' ? ' / 管理者' : ''}</div>
            </div>
          </div>
          ${dept ? `
          <div class="budget-meter">
            <div class="meter-label">
              <span>部署予算(今月)</span>
              <span>${yen(dept.used_jpy)} / ${yen(dept.monthly_budget_jpy)}</span>
            </div>
            <div class="meter-track"><div class="meter-fill ${meterClass}" style="width:${(usedRatio * 100).toFixed(1)}%"></div></div>
          </div>` : ''}
          <div class="links">
            ${me.user.role === 'admin' ? `<button class="btn-ghost" id="btn-admin">${state.view === 'admin' ? 'チャットへ' : '管理画面'}</button>` : ''}
            <button class="btn-ghost" id="btn-logout">ログアウト</button>
          </div>
        </div>
      </nav>
      <main class="main" id="main"></main>
    </div>
    <div class="chart-tooltip" id="chart-tooltip"></div>`;

  document.getElementById('new-chat').onclick = async () => {
    state.currentConvId = null;
    state.messages = [];
    state.view = 'chat';
    render();
  };
  document.getElementById('btn-logout').onclick = async () => {
    await api('/api/logout', { method: 'POST' });
    location.reload();
  };
  const adminBtn = document.getElementById('btn-admin');
  if (adminBtn) adminBtn.onclick = () => {
    state.view = state.view === 'admin' ? 'chat' : 'admin';
    render();
  };

  renderConvList();
  if (state.view === 'admin') renderAdmin();
  else renderChat();
}

function renderConvList() {
  const el = document.getElementById('conv-list');
  el.innerHTML = state.conversations.map((c) => `
    <div class="conv-item ${c.id === state.currentConvId ? 'active' : ''}" data-id="${c.id}">
      <span>${esc(c.title)}</span>
      <button class="del" data-del="${c.id}" title="削除">✕</button>
    </div>`).join('');
  el.querySelectorAll('.conv-item').forEach((item) => {
    item.onclick = async (e) => {
      if (e.target.dataset.del) return;
      state.currentConvId = Number(item.dataset.id);
      state.view = 'chat';
      state.messages = await api(`/api/conversations/${state.currentConvId}/messages`);
      render();
    };
  });
  el.querySelectorAll('[data-del]').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('この会話を削除しますか?')) return;
      await api(`/api/conversations/${btn.dataset.del}`, { method: 'DELETE' });
      if (state.currentConvId === Number(btn.dataset.del)) {
        state.currentConvId = null;
        state.messages = [];
      }
      await loadConversations();
      render();
    };
  });
}

// ---------- チャット画面 ----------

function renderChat() {
  const me = state.me;
  const dept = me.department;
  const locked = dept && dept.locked;

  const warningBanners = me.warnings.map((w) => `
    <div class="banner">
      <div class="msg">⚠️ ${esc(w.message)}</div>
      <button class="btn-ghost" data-ack="${w.id}">確認しました</button>
    </div>`).join('');

  const budgetBanner = me.budget_alert
    ? `<div class="banner"><div class="msg">📊 部署予算の消化率が80%を超えました。計画的にご利用ください。</div></div>`
    : '';

  document.getElementById('main').innerHTML = `
    <div class="chat-header">
      <span>${state.currentConvId ? esc((state.conversations.find((c) => c.id === state.currentConvId) || {}).title || '') : '新しいチャット'}</span>
      ${me.mock_mode ? '<span class="mock-badge">モックモード(APIキー未設定)</span>' : ''}
    </div>
    ${warningBanners}${budgetBanner}
    ${locked ? `
    <div class="messages">
      <div class="lock-overlay">
        <div class="icon">🔒</div>
        <h2>予算上限に達しました</h2>
        <p>部署「${esc(dept.name)}」の今月の利用額が予算(${yen(dept.monthly_budget_jpy)})を超えたため、チャットがロックされています。<br>
        続けて利用が必要な場合は管理者にロック解除を依頼してください。</p>
      </div>
    </div>` : `
    <div class="messages" id="messages"><div class="thread" id="thread"></div></div>
    <div class="composer-wrap">
      <div class="composer">
        <select id="model-pref" class="model-pref" title="使用モデル">
          <option value="auto">🪄 自動</option>
          <option value="light">⚡ 軽量</option>
          <option value="heavy">🧠 高性能</option>
        </select>
        <textarea id="input" rows="1" placeholder="メッセージを入力…(Shift+Enterで改行)"></textarea>
        <button class="send" id="send" title="送信">↑</button>
      </div>
      <div class="composer-note">「自動」では内容に応じて最適なモデルに振り分けます。利用状況の分析のため、各メッセージは業務/私的利用の判定のみ行われます。会話の内容自体が管理者に共有されることはありません。</div>
    </div>`}
  `;

  document.querySelectorAll('[data-ack]').forEach((btn) => {
    btn.onclick = async () => {
      await api(`/api/warnings/${btn.dataset.ack}/ack`, { method: 'POST' });
      await loadMe();
      render();
    };
  });

  if (locked) return;

  renderMessages();

  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 180) + 'px';
  };
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });
  sendBtn.onclick = sendMessage;
  const modelPref = document.getElementById('model-pref');
  modelPref.value = state.modelPref;
  modelPref.onchange = () => { state.modelPref = modelPref.value; };
  input.focus();
}

function renderMessages() {
  const thread = document.getElementById('thread');
  if (!thread) return;
  if (state.messages.length === 0) {
    thread.innerHTML = `
      <div class="empty-state">
        <h2>お手伝いできることはありますか?</h2>
        <p>業務に関する質問・文章作成・翻訳・コード作成などに使えます。</p>
      </div>`;
    return;
  }
  thread.innerHTML = state.messages.map((m) =>
    m.role === 'user'
      ? `<div class="msg-row user"><div class="msg-user">${esc(m.content)}</div></div>`
      : `<div class="msg-row"><div class="msg-assistant"><div class="avatar">AI</div><div class="content">${renderMarkdown(m.content)}${
          m.model ? `<div class="msg-model">${esc(m.model)}</div>` : ''
        }</div></div></div>`
  ).join('');
  scrollToBottom();
}

function scrollToBottom() {
  const box = document.getElementById('messages');
  if (box) box.scrollTop = box.scrollHeight;
}

// ストリーミング中はスレッド全体を作り直さず、末尾に追加した1要素だけを更新する
function appendStreamingRow() {
  const thread = document.getElementById('thread');
  const row = document.createElement('div');
  row.className = 'msg-row';
  row.innerHTML = `<div class="msg-assistant"><div class="avatar">AI</div><div class="content"><span class="cursor-blink"></span></div></div>`;
  thread.appendChild(row);
  const content = row.querySelector('.content');
  return {
    update(text) {
      content.innerHTML = renderMarkdown(text) + '<span class="cursor-blink"></span>';
      scrollToBottom();
    },
    remove() {
      row.remove();
    },
  };
}

async function sendMessage() {
  if (state.streaming) return;
  const input = document.getElementById('input');
  const text = input.value.trim();
  if (!text) return;

  if (!state.currentConvId) {
    const { id } = await api('/api/conversations', { method: 'POST' });
    state.currentConvId = id;
  }

  input.value = '';
  input.style.height = 'auto';
  state.messages.push({ role: 'user', content: text });
  renderMessages();
  await executeChat(text, false);
}

async function executeChat(text, confirmed) {
  state.streaming = true;
  const sendBtn = document.getElementById('send');
  if (sendBtn) sendBtn.disabled = true;
  const stream = appendStreamingRow();
  let refreshAfter = true; // 確認ダイアログ表示時は画面を作り直さない

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversation_id: state.currentConvId,
        message: text,
        confirmed,
        model_pref: state.modelPref,
      }),
    });

    // JSON 応答 = ストリーミング以外(エラー or 人間確認の要求)
    if ((res.headers.get('content-type') || '').includes('application/json')) {
      const data = await res.json().catch(() => ({}));
      stream.remove();
      if (data.needs_confirmation) {
        refreshAfter = false;
        showConfirmCard(text);
        return;
      }
      state.messages.push({ role: 'assistant', content: `⚠️ ${data.error || '送信に失敗しました'}` });
      renderMessages();
      return;
    }

    // SSE ストリームを読む
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let acc = '';
    let done = null;
    while (true) {
      const { value, done: eof } = await reader.read();
      if (eof) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const evMatch = block.match(/^event: (.+)$/m);
        const dataMatch = block.match(/^data: (.+)$/m);
        if (!evMatch || !dataMatch) continue;
        const ev = evMatch[1];
        const data = JSON.parse(dataMatch[1]);
        if (ev === 'delta') {
          acc += data.text;
          stream.update(acc);
        } else if (ev === 'replace') {
          acc = data.text; // 画像生成完了時など、進捗表示を最終結果で置き換える
          stream.update(acc);
        } else if (ev === 'done') {
          done = data;
        } else if (ev === 'error') {
          acc += `\n\n⚠️ ${data.message}`;
          stream.update(acc);
        }
      }
    }
    state.messages.push({ role: 'assistant', content: acc, model: done?.model });
    renderMessages();
  } catch (err) {
    state.messages.push({ role: 'assistant', content: `⚠️ 通信エラー: ${err.message}` });
    renderMessages();
  } finally {
    state.streaming = false;
    if (refreshAfter) {
      // 予算メーター・タイトル・警告を最新化(画面全体を再描画)
      await loadMe();
      await loadConversations();
      render();
    } else if (sendBtn) {
      sendBtn.disabled = false;
    }
  }
}

// sensitive 判定時の実行前確認カード
function showConfirmCard(text) {
  const thread = document.getElementById('thread');
  const card = document.createElement('div');
  card.className = 'confirm-card';
  card.innerHTML = `
    <div class="confirm-title">⚠️ 実行前の確認</div>
    <p>この依頼は<strong>送信・削除・金額・個人情報</strong>のいずれかに関わる可能性があると判定されました。<br>
    高性能モデルで慎重に処理しますが、内容を確認のうえ続行してください。</p>
    <div class="confirm-actions">
      <button class="btn-primary" data-proceed>確認して続行</button>
      <button class="btn-ghost" data-cancel>キャンセル</button>
    </div>`;
  thread.appendChild(card);
  scrollToBottom();
  card.querySelector('[data-proceed]').onclick = () => {
    card.remove();
    executeChat(text, true);
  };
  card.querySelector('[data-cancel]').onclick = () => {
    card.remove();
    state.messages.pop(); // 未送信のユーザー発言を取り消す
    renderMessages();
  };
}

// ---------- 管理画面 ----------

async function renderAdmin() {
  const main = document.getElementById('main');
  main.innerHTML = '<div class="admin-wrap"><div class="admin-inner">読み込み中…</div></div>';
  try {
    state.adminData = await api('/api/admin/overview');
  } catch (err) {
    main.innerHTML = `<div class="admin-wrap"><div class="admin-inner">⚠️ ${esc(err.message)}</div></div>`;
    return;
  }
  const d = state.adminData;
  const tabs = [
    ['dashboard', 'ダッシュボード'],
    ['depts', '部署・予算'],
    ['users', 'ユーザー'],
  ];
  main.innerHTML = `
    <div class="admin-wrap"><div class="admin-inner">
      <div class="admin-header"><h1>管理画面 <small style="font-weight:400;color:var(--muted)">${esc(d.month)}</small></h1></div>
      <div class="tabs">${tabs.map(([k, label]) =>
        `<button class="tab ${state.adminTab === k ? 'active' : ''}" data-tab="${k}">${label}</button>`).join('')}
      </div>
      <div id="admin-body"></div>
    </div></div>`;
  main.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => { state.adminTab = b.dataset.tab; renderAdmin(); };
  });
  const body = document.getElementById('admin-body');
  if (state.adminTab === 'dashboard') renderDashboard(body, d);
  else if (state.adminTab === 'depts') renderDepts(body, d);
  else renderUsers(body, d);
}

// --- ダッシュボード ---

function renderDashboard(el, d) {
  const totalCost = d.departments.reduce((s, x) => s + x.used_jpy, 0);
  const totalBudget = d.departments.reduce((s, x) => s + x.monthly_budget_jpy, 0);
  const lockedCount = d.departments.filter((x) => x.locked).length;
  const totalJudged = d.users.reduce((s, u) => s + u.stats.judged, 0);
  const totalPrivate = d.users.reduce((s, u) => s + u.stats.private, 0);

  el.innerHTML = `
    <div class="cards">
      <div class="stat-tile"><div class="label">今月の利用額(全社)</div>
        <div class="value">${yen(totalCost)} <small>/ ${yen(totalBudget)}</small></div></div>
      <div class="stat-tile"><div class="label">ロック中の部署</div>
        <div class="value">${lockedCount} <small>/ ${d.departments.length} 部署</small></div></div>
      <div class="stat-tile"><div class="label">私的利用の割合(全社)</div>
        <div class="value">${totalJudged ? Math.round((totalPrivate / totalJudged) * 100) : 0}<small>%(判定 ${totalJudged} 件)</small></div></div>
    </div>

    <div class="panel">
      <h3>部署別 予算消化状況</h3>
      <p class="desc">今月の利用額と予算。予算超過はロック対象です。</p>
      <div id="chart-budget"></div>
    </div>

    <div class="panel">
      <h3>ユーザー別 業務/私的利用の比率</h3>
      <p class="desc">AIがメッセージごとに判定したラベルの集計です(本文は保存していません)。</p>
      <div class="legend">
        <span class="item"><span class="swatch" style="background:#2a78d6"></span>業務</span>
        <span class="item"><span class="swatch" style="background:#1baf7a"></span>私的利用</span>
      </div>
      <div id="chart-ratio"></div>
    </div>

    <div class="panel">
      <h3>日別 利用コスト(直近30日)</h3>
      <p class="desc">チャット・判定を含む全APIコストです。</p>
      <div id="chart-daily"></div>
    </div>

    <div class="panel">
      <h3>警告履歴</h3>
      <p class="desc">自動警告(私的利用率)と管理者からの手動警告。</p>
      ${d.warnings.length === 0 ? '<p class="desc">警告はまだありません。</p>' : `
      <table class="data">
        <tr><th>日時</th><th>ユーザー</th><th>種別</th><th>内容</th><th>状態</th></tr>
        ${d.warnings.map((w) => `<tr>
          <td>${esc(w.created_at)}</td>
          <td>${esc(w.display_name)}</td>
          <td>${w.type === 'manual' ? '<span class="pill warn">手動</span>' : '<span class="pill warn">自動</span>'}</td>
          <td>${esc(w.message)}</td>
          <td>${w.acknowledged ? '確認済' : '未確認'}</td>
        </tr>`).join('')}
      </table>`}
    </div>`;

  document.getElementById('chart-budget').innerHTML = budgetChart(d.departments);
  document.getElementById('chart-ratio').innerHTML = ratioChart(d.users);
  document.getElementById('chart-daily').innerHTML = dailyChart(d.daily);
  attachChartTooltips(el);
}

// 部署別予算バー(横棒: 予算トラック + 利用額フィル)
function budgetChart(departments) {
  if (departments.length === 0) return '<p class="desc">部署がありません。</p>';
  const W = 960, rowH = 44, labelW = 110, valueW = 210;
  const H = departments.length * rowH + 8;
  const plotW = W - labelW - valueW;
  const max = Math.max(...departments.map((x) => Math.max(x.monthly_budget_jpy, x.used_jpy)), 1);
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="部署別予算消化状況">`;
  departments.forEach((dp, i) => {
    const y = i * rowH + 10;
    const budgetW = (dp.monthly_budget_jpy / max) * plotW;
    const usedW = Math.min((dp.used_jpy / max) * plotW, plotW);
    const over = dp.used_jpy >= dp.monthly_budget_jpy;
    const fill = over ? '#d03b3b' : '#2a78d6';
    const pct = dp.monthly_budget_jpy > 0 ? Math.round(dp.ratio * 100) : 0;
    svg += `
      <text x="0" y="${y + 15}" font-size="13" fill="#0b0b0b">${esc(dp.name)}</text>
      <rect x="${labelW}" y="${y}" width="${budgetW}" height="22" rx="4" fill="#e1e0d9"
        data-tip="${esc(dp.name)} 予算 ${yen(dp.monthly_budget_jpy)}"></rect>
      <rect x="${labelW}" y="${y}" width="${Math.max(usedW, 2)}" height="22" rx="4" fill="${fill}"
        data-tip="${esc(dp.name)} 利用額 ${yen(dp.used_jpy)}(${pct}%)"></rect>
      <text x="${labelW + Math.max(budgetW, usedW) + 10}" y="${y + 15}" font-size="12" fill="#52514e">
        ${yen(dp.used_jpy)} / ${yen(dp.monthly_budget_jpy)}(${pct}%)${over ? ' 超過' : ''}
      </text>`;
  });
  svg += '</svg>';
  return svg;
}

// ユーザー別 業務/私的 積み上げバー(100%)
function ratioChart(users) {
  const rows = users.filter((u) => u.stats.judged > 0);
  if (rows.length === 0) return '<p class="desc">まだ判定データがありません。</p>';
  const W = 960, rowH = 40, labelW = 130, valueW = 130;
  const H = rows.length * rowH + 8;
  const plotW = W - labelW - valueW;
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="ユーザー別 業務/私的利用の比率">`;
  rows.forEach((u, i) => {
    const y = i * rowH + 8;
    const workRatio = u.stats.work / u.stats.judged;
    const workW = workRatio * plotW;
    const privW = plotW - workW;
    const privPct = Math.round((1 - workRatio) * 100);
    svg += `
      <text x="0" y="${y + 14}" font-size="13" fill="#0b0b0b">${esc(u.display_name)}</text>
      <rect x="${labelW}" y="${y}" width="${Math.max(workW, 0)}" height="20" rx="4" fill="#2a78d6"
        data-tip="${esc(u.display_name)} 業務 ${u.stats.work}件(${100 - privPct}%)"></rect>
      <rect x="${labelW + workW + 2}" y="${y}" width="${Math.max(privW - 2, 0)}" height="20" rx="4" fill="#1baf7a"
        data-tip="${esc(u.display_name)} 私的 ${u.stats.private}件(${privPct}%)"></rect>
      <text x="${labelW + plotW + 10}" y="${y + 14}" font-size="12" fill="#52514e">私的 ${privPct}%(${u.stats.judged}件)</text>`;
  });
  svg += '</svg>';
  return svg;
}

// 日別コスト 折れ線
function dailyChart(daily) {
  if (daily.length === 0) return '<p class="desc">まだ利用データがありません。</p>';
  const W = 960, H = 220, padL = 60, padR = 16, padT = 12, padB = 28;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = Math.max(...daily.map((d) => d.cost), 1);
  const x = (i) => padL + (daily.length === 1 ? plotW / 2 : (i / (daily.length - 1)) * plotW);
  const y = (v) => padT + plotH - (v / max) * plotH;

  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="日別利用コスト">`;
  // グリッド + 目盛り
  const fmtAxis = (v) => (max < 10 ? v.toFixed(1) : Math.round(v).toLocaleString());
  for (let g = 0; g <= 3; g++) {
    const v = (max / 3) * g;
    svg += `<line x1="${padL}" y1="${y(v)}" x2="${W - padR}" y2="${y(v)}" stroke="#e1e0d9" stroke-width="1"></line>
      <text x="${padL - 8}" y="${y(v) + 4}" font-size="11" fill="#898781" text-anchor="end">${fmtAxis(v)}</text>`;
  }
  // X軸ラベル(適度に間引く)
  const step = Math.ceil(daily.length / 8);
  daily.forEach((d, i) => {
    if (i % step !== 0 && i !== daily.length - 1) return;
    svg += `<text x="${x(i)}" y="${H - 8}" font-size="11" fill="#898781" text-anchor="middle">${esc(d.day.slice(5))}</text>`;
  });
  // 折れ線
  const points = daily.map((d, i) => `${x(i)},${y(d.cost)}`).join(' ');
  svg += `<polyline points="${points}" fill="none" stroke="#2a78d6" stroke-width="2" stroke-linejoin="round"></polyline>`;
  // ホバー用マーカー(不可視の当たり判定を大きめに)
  daily.forEach((d, i) => {
    svg += `<circle cx="${x(i)}" cy="${y(d.cost)}" r="3.5" fill="#2a78d6" stroke="#fcfcfb" stroke-width="2"
      data-tip="${esc(d.day)}: ${yen(d.cost)}"></circle>
      <circle cx="${x(i)}" cy="${y(d.cost)}" r="12" fill="transparent" data-tip="${esc(d.day)}: ${yen(d.cost)}"></circle>`;
  });
  svg += '</svg>';
  return svg;
}

// data-tip 属性のツールチップ
function attachChartTooltips(root) {
  const tip = document.getElementById('chart-tooltip');
  root.querySelectorAll('[data-tip]').forEach((elm) => {
    elm.addEventListener('mousemove', (e) => {
      tip.textContent = elm.dataset.tip;
      tip.style.display = 'block';
      tip.style.left = e.clientX + 12 + 'px';
      tip.style.top = e.clientY + 12 + 'px';
    });
    elm.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  });
}

// --- 部署・予算タブ ---

function renderDepts(el, d) {
  el.innerHTML = `
    <div class="panel">
      <h3>部署と予算</h3>
      <p class="desc">予算(円/月)を編集できます。超過するとその部署のチャットは自動でロックされ、「ロック解除」で今月分のみ解除できます。</p>
      <table class="data">
        <tr><th>部署</th><th class="num">今月の利用額</th><th class="num">予算(円/月)</th><th>状態</th><th></th></tr>
        ${d.departments.map((dp) => `<tr>
          <td>${esc(dp.name)}</td>
          <td class="num">${yen(dp.used_jpy)}(${Math.round(dp.ratio * 100)}%)</td>
          <td class="num"><input class="inline-input" data-budget="${dp.id}" value="${Math.round(dp.monthly_budget_jpy)}"></td>
          <td>${dp.locked ? '<span class="pill locked">🔒 ロック中</span>'
            : dp.unlocked_by_admin && dp.over_budget ? '<span class="pill unlocked">解除中(今月)</span>'
            : '<span class="pill ok">利用可</span>'}</td>
          <td>
            <button class="btn-ghost" data-save="${dp.id}">保存</button>
            ${dp.locked ? `<button class="btn-primary" style="padding:6px 12px;font-size:13px" data-unlock="${dp.id}">ロック解除</button>` : ''}
            ${dp.unlocked_by_admin ? `<button class="btn-ghost" data-relock="${dp.id}">解除を取消</button>` : ''}
          </td>
        </tr>`).join('')}
      </table>
      <div class="form-row">
        <input id="new-dept-name" placeholder="新しい部署名">
        <input id="new-dept-budget" type="number" placeholder="予算(円/月)" value="50000">
        <button class="btn-primary" id="add-dept">部署を追加</button>
      </div>
    </div>`;

  el.querySelectorAll('[data-save]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.save;
      const val = Number(el.querySelector(`[data-budget="${id}"]`).value);
      await api(`/api/admin/departments/${id}`, { method: 'PATCH', body: { monthly_budget_jpy: val } });
      renderAdmin();
    };
  });
  el.querySelectorAll('[data-unlock]').forEach((b) => {
    b.onclick = async () => {
      await api(`/api/admin/departments/${b.dataset.unlock}`, { method: 'PATCH', body: { unlock: true } });
      renderAdmin();
    };
  });
  el.querySelectorAll('[data-relock]').forEach((b) => {
    b.onclick = async () => {
      await api(`/api/admin/departments/${b.dataset.relock}`, { method: 'PATCH', body: { unlock: false } });
      renderAdmin();
    };
  });
  document.getElementById('add-dept').onclick = async () => {
    const name = document.getElementById('new-dept-name').value.trim();
    if (!name) return;
    await api('/api/admin/departments', {
      method: 'POST',
      body: { name, monthly_budget_jpy: Number(document.getElementById('new-dept-budget').value) },
    });
    renderAdmin();
  };
}

// --- ユーザータブ ---

function renderUsers(el, d) {
  const pending = d.users.filter((u) => u.status === 'pending' && !u.disabled);
  // 拒否(停止)済みの承認待ちユーザーも通常一覧に出し、再開できるようにする
  const activeUsers = d.users.filter((u) => u.status !== 'pending' || u.disabled);

  const pendingPanel = pending.length === 0 ? '' : `
    <div class="panel" style="border-color:var(--warning-border);background:#fffdf5">
      <h3>🔔 承認待ちのユーザー(${pending.length}名)</h3>
      <p class="desc">Googleログインで新規登録されたユーザーです。部署を選んで承認するとチャットを利用できるようになります。</p>
      <table class="data">
        <tr><th>ユーザー</th><th>メール</th><th>登録日時</th><th>部署を割り当てて承認</th><th></th></tr>
        ${pending.map((u) => `<tr>
          <td>${esc(u.display_name)}</td>
          <td>${esc(u.email || '')}</td>
          <td>${esc(u.created_at || '')}</td>
          <td>
            <select data-approve-dept="${u.id}">
              ${d.departments.map((dp) => `<option value="${dp.id}">${esc(dp.name)}</option>`).join('')}
            </select>
            <button class="btn-primary" style="padding:6px 14px;font-size:13px" data-approve="${u.id}">承認</button>
          </td>
          <td><button class="btn-danger" data-reject="${u.id}">拒否</button></td>
        </tr>`).join('')}
      </table>
    </div>`;

  el.innerHTML = pendingPanel + `
    <div class="panel">
      <h3>ユーザー</h3>
      <p class="desc">私的利用率が高いユーザーには「警告を送る」で個別に通知できます(次回ログイン/画面更新時に表示)。</p>
      <table class="data">
        <tr><th>ユーザー</th><th>部署</th><th>権限</th><th class="num">今月の利用額</th><th class="num">私的利用率</th><th class="num">警告</th><th></th></tr>
        ${activeUsers.map((u) => `<tr>
          <td>${esc(u.display_name)} <span style="color:var(--muted);font-size:11.5px">${esc(u.email || '@' + u.username)}</span>
            ${u.is_google ? '<span class="pill unlocked">Google</span>' : ''}
            ${u.disabled ? '<span class="pill locked">停止中</span>' : ''}</td>
          <td>
            <select data-dept-of="${u.id}">
              <option value="">未設定</option>
              ${d.departments.map((dp) => `<option value="${dp.id}" ${dp.id === u.department_id ? 'selected' : ''}>${esc(dp.name)}</option>`).join('')}
            </select>
          </td>
          <td>${u.role === 'admin' ? '<span class="pill admin-role">管理者</span>' : '一般'}</td>
          <td class="num">${yen(u.month_cost_jpy)}</td>
          <td class="num">${u.stats.judged > 0 ? Math.round(u.stats.private_ratio * 100) + '%(' + u.stats.judged + '件)' : '—'}</td>
          <td class="num">${u.warning_count}</td>
          <td>
            <button class="btn-ghost" data-warn="${u.id}">警告を送る</button>
            <button class="btn-ghost" data-toggle="${u.id}" data-disabled="${u.disabled}">${u.disabled ? '再開' : '停止'}</button>
          </td>
        </tr>`).join('')}
      </table>
      <div class="form-row">
        <input id="nu-username" placeholder="ユーザー名">
        <input id="nu-display" placeholder="表示名">
        <input id="nu-password" type="password" placeholder="初期パスワード">
        <select id="nu-dept">${d.departments.map((dp) => `<option value="${dp.id}">${esc(dp.name)}</option>`).join('')}</select>
        <select id="nu-role"><option value="user">一般</option><option value="admin">管理者</option></select>
        <button class="btn-primary" id="add-user">ユーザーを追加</button>
      </div>
    </div>`;

  el.querySelectorAll('[data-approve]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.approve;
      const deptId = Number(el.querySelector(`[data-approve-dept="${id}"]`).value);
      await api(`/api/admin/users/${id}`, {
        method: 'PATCH', body: { status: 'active', department_id: deptId },
      });
      renderAdmin();
    };
  });
  el.querySelectorAll('[data-reject]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('このユーザーを拒否(停止)しますか?')) return;
      await api(`/api/admin/users/${b.dataset.reject}`, { method: 'PATCH', body: { disabled: true } });
      renderAdmin();
    };
  });
  el.querySelectorAll('[data-dept-of]').forEach((sel) => {
    sel.onchange = async () => {
      await api(`/api/admin/users/${sel.dataset.deptOf}`, {
        method: 'PATCH', body: { department_id: Number(sel.value) || null },
      });
      renderAdmin();
    };
  });
  el.querySelectorAll('[data-warn]').forEach((b) => {
    b.onclick = async () => {
      const message = prompt('警告メッセージを入力してください',
        '本ツールの私的利用が確認されています。業務目的でのご利用をお願いします。');
      if (message === null) return;
      await api(`/api/admin/users/${b.dataset.warn}/warn`, { method: 'POST', body: { message } });
      renderAdmin();
    };
  });
  el.querySelectorAll('[data-toggle]').forEach((b) => {
    b.onclick = async () => {
      await api(`/api/admin/users/${b.dataset.toggle}`, {
        method: 'PATCH', body: { disabled: b.dataset.disabled === '0' },
      });
      renderAdmin();
    };
  });
  document.getElementById('add-user').onclick = async () => {
    const username = document.getElementById('nu-username').value.trim();
    const password = document.getElementById('nu-password').value;
    if (!username || !password) return alert('ユーザー名とパスワードを入力してください');
    try {
      await api('/api/admin/users', {
        method: 'POST',
        body: {
          username,
          display_name: document.getElementById('nu-display').value.trim() || username,
          password,
          department_id: Number(document.getElementById('nu-dept').value),
          role: document.getElementById('nu-role').value,
        },
      });
      renderAdmin();
    } catch (err) {
      alert(err.message);
    }
  };
}

init();
