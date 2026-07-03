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
  modelPref: 'auto',     // 'auto' | 'light' | 'heavy'
  pendingConfirm: null,  // { text, msg, routerError } 実行前確認の待機状態
  templates: [],         // チャット開始画面のテンプレート一覧
  templatesExpanded: false,
};

const TEMPLATE_VISIBLE_COUNT = 3; // これを超える分はドリルダウンで畳む

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
    try { state.templates = await api('/api/templates'); } catch { state.templates = []; }
    render();
  } else {
    renderLogin();
  }
}

// Google ログイン直後の未承認ユーザー向け画面
function renderPending() {
  const me = state.me;
  const applied = Boolean(me.user.requested_name && me.user.requested_department);

  $app.innerHTML = `
    <div class="login-wrap">
      <div class="login-card" style="text-align:center">
        <div style="font-size:40px">⏳</div>
        <h1 style="font-size:19px">承認待ちです</h1>
        ${applied ? `
        <p style="color:var(--ink-2);font-size:13.5px;line-height:1.8">
          申請を送信しました。管理者が確認して承認するまで、このままお待ちください。<br>
          このページを開いたままにしておけば、承認され次第自動的に利用画面に切り替わります。
        </p>
        <div class="applied-summary">
          <div><span>氏名</span>${esc(me.user.requested_name)}</div>
          <div><span>希望部署</span>${esc(me.user.requested_department)}</div>
        </div>
        <button class="link-btn" id="edit-apply">内容を修正する</button>
        ` : `
        <p style="color:var(--ink-2);font-size:13.5px;line-height:1.8">
          ${esc(me.user.display_name)} さん(${esc(me.user.email || me.user.username)})のアカウントは作成されました。<br>
          お手数ですが、下記に氏名と希望部署を入力して送信してください。管理者が確認のうえ承認します。
        </p>
        <form id="apply-form" style="text-align:left">
          <label>氏名</label>
          <input name="name" value="${esc(me.user.requested_name || me.user.display_name || '')}" required>
          <label>希望部署(自由記述)</label>
          <input name="department" placeholder="例: 営業部" value="${esc(me.user.requested_department || '')}" required>
          <button class="btn-primary" type="submit" style="width:100%;margin-top:16px">申請する</button>
          <div class="login-error" id="apply-error"></div>
        </form>
        `}
        <button class="btn-ghost" id="btn-logout" style="margin-top:14px">ログアウト</button>
      </div>
    </div>`;

  document.getElementById('btn-logout').onclick = async () => {
    await api('/api/logout', { method: 'POST' });
    location.reload();
  };

  const applyForm = document.getElementById('apply-form');
  if (applyForm) {
    applyForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(applyForm);
      try {
        await api('/api/apply', { method: 'POST', body: { name: fd.get('name'), department: fd.get('department') } });
        await loadMe();
        renderPending();
        startPendingPoll();
      } catch (err) {
        document.getElementById('apply-error').textContent = err.message;
      }
    });
  }
  const editBtn = document.getElementById('edit-apply');
  if (editBtn) {
    editBtn.onclick = () => {
      me.user.requested_name = '';
      me.user.requested_department = '';
      renderPending();
    };
  }

  if (applied) startPendingPoll();
}

// 承認待ち中、承認されたら自動的に通常画面へ切り替える
let pendingPollTimer = null;
function startPendingPoll() {
  if (pendingPollTimer) return;
  pendingPollTimer = setInterval(async () => {
    const ok = await loadMe();
    if (ok && state.me.user.status !== 'pending') {
      clearInterval(pendingPollTimer);
      pendingPollTimer = null;
      init();
    }
  }, 10000);
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
        <button type="button" class="link-btn" id="toggle-pw-login">パスワードでログイン(管理者用)</button>` : ''}
        <div id="pw-fields" style="${config.google_enabled ? 'display:none' : ''}">
          <label>ユーザー名</label>
          <input name="username" autocomplete="username" ${config.google_enabled ? '' : 'required autofocus'}>
          <label>パスワード</label>
          <input name="password" type="password" autocomplete="current-password" ${config.google_enabled ? '' : 'required'}>
          <button class="btn-primary" type="submit">ログイン</button>
        </div>
        <div class="login-error" id="login-error">${esc(loginError)}</div>
      </form>
    </div>`;
  if (loginError) history.replaceState(null, '', '/');
  const toggleBtn = document.getElementById('toggle-pw-login');
  if (toggleBtn) {
    toggleBtn.onclick = () => {
      const fields = document.getElementById('pw-fields');
      const show = fields.style.display === 'none';
      fields.style.display = show ? '' : 'none';
      fields.querySelectorAll('input').forEach((el) => { el.required = show; });
      toggleBtn.textContent = show ? '閉じる' : 'パスワードでログイン(管理者用)';
    };
  }
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (!fd.get('username') && !fd.get('password')) return; // パスワード欄が隠れている間の誤送信を無視
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
          ${me.my_private_stats && me.my_private_stats.judged > 0 ? `
          <div class="my-ratio">
            <div id="my-donut"></div>
            <div class="my-ratio-legend">
              <div>あなたの業務/プライベート比率</div>
              <span class="item"><span class="swatch" style="background:#2a78d6"></span>業務 ${me.my_private_stats.work}件</span>
              <span class="item"><span class="swatch" style="background:#e34948"></span>プライベート ${me.my_private_stats.private}件</span>
              <div class="muted-note">AIによる目安です</div>
            </div>
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

  const myDonut = document.getElementById('my-donut');
  if (myDonut) {
    myDonut.innerHTML = workPrivateDonut(me.my_private_stats.work, me.my_private_stats.private, { size: 64, label: '' });
  }

  document.getElementById('new-chat').onclick = async () => {
    state.currentConvId = null;
    state.messages = [];
    state.pendingConfirm = null;
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
      state.pendingConfirm = null;
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
        state.pendingConfirm = null;
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
        ${renderTemplateButtons()}
      </div>`;
    attachTemplateButtonHandlers(thread);
    return;
  }
  thread.innerHTML = state.messages.map((m) =>
    m.role === 'user'
      ? `<div class="msg-row user"><div class="msg-user">${esc(m.content)}</div></div>`
      : `<div class="msg-row"><div class="msg-assistant"><div class="avatar">AI</div><div class="content">${renderMarkdown(m.content)}${
          m.model ? `<div class="msg-model">${esc(m.model)}</div>` : ''
        }</div></div></div>`
  ).join('');
  // 実行前確認カードは state から復元する(再描画で消えないように)
  if (state.pendingConfirm) thread.appendChild(buildConfirmCard());
  scrollToBottom();
}

// チャット未経験のユーザー向けのワンクリック定型文ボタン(管理者がテンプレート管理画面で編集)
function renderTemplateButtons() {
  if (!state.templates.length) return '';
  const visible = state.templatesExpanded ? state.templates : state.templates.slice(0, TEMPLATE_VISIBLE_COUNT);
  const hiddenCount = state.templates.length - visible.length;
  const buttons = visible.map((t) =>
    `<button class="template-btn" data-template-id="${t.id}">${esc(t.label)}</button>`).join('');
  let more = '';
  if (hiddenCount > 0) {
    more = `<button class="template-btn template-more" id="template-toggle">+${hiddenCount} その他</button>`;
  } else if (state.templatesExpanded && state.templates.length > TEMPLATE_VISIBLE_COUNT) {
    more = `<button class="template-btn template-more" id="template-toggle">閉じる</button>`;
  }
  return `<div class="template-row">${buttons}${more}</div>`;
}

function attachTemplateButtonHandlers(root) {
  root.querySelectorAll('[data-template-id]').forEach((btn) => {
    btn.onclick = () => {
      const tpl = state.templates.find((t) => t.id === Number(btn.dataset.templateId));
      if (!tpl) return;
      const input = document.getElementById('input');
      if (input) input.value = tpl.prompt;
      sendMessage();
    };
  });
  const toggle = root.querySelector('#template-toggle');
  if (toggle) {
    toggle.onclick = () => {
      state.templatesExpanded = !state.templatesExpanded;
      renderMessages();
    };
  }
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

  // 会話作成の await 中も二重送信を防ぐため、ここで即座にロックする
  state.streaming = true;
  try {
    if (!state.currentConvId) {
      const { id } = await api('/api/conversations', { method: 'POST' });
      state.currentConvId = id;
    }
  } catch (err) {
    state.streaming = false;
    alert('会話の作成に失敗しました: ' + err.message);
    return;
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
        state.pendingConfirm = { text, routerError: data.router_error === true };
        renderMessages();
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

// sensitive 判定時の実行前確認カード。
// state.pendingConfirm に状態を持たせ、renderMessages() の再描画をまたいでも消えないようにする。
function buildConfirmCard() {
  const { text, routerError } = state.pendingConfirm;
  const card = document.createElement('div');
  card.className = 'confirm-card';
  card.innerHTML = `
    <div class="confirm-title">⚠️ 実行前の確認</div>
    <p>${routerError
      ? '内容の自動判定に失敗したため、安全のため確認を求めています。'
      : 'この依頼は<strong>送信・削除・金額・個人情報</strong>のいずれかに関わる可能性があると判定されました。'}<br>
    高性能モデルで慎重に処理しますが、内容を確認のうえ続行してください。</p>
    <div class="confirm-actions">
      <button class="btn-primary" data-proceed>確認して続行</button>
      <button class="btn-ghost" data-cancel>キャンセル</button>
    </div>`;
  card.querySelector('[data-proceed]').onclick = () => {
    state.pendingConfirm = null;
    executeChat(text, true);
  };
  card.querySelector('[data-cancel]').onclick = () => {
    state.pendingConfirm = null;
    // 末尾がこの確認に対応する未送信発言であれば取り消す(別発言の混入を避ける)
    const last = state.messages[state.messages.length - 1];
    if (last && last.role === 'user' && last.content === text) state.messages.pop();
    renderMessages();
  };
  return card;
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
    ['templates', 'テンプレート'],
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
  else if (state.adminTab === 'users') renderUsers(body, d);
  else renderTemplatesAdmin(body);
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
      <h3>業務 / プライベート比率(全社)</h3>
      <p class="desc">
        AIがメッセージごとに「業務」か「プライベート」かを自動判定した集計です(本文は保存されず、ラベルのみ)。<br>
        <strong>あくまで目安です。</strong>特に観光業では、雑談のようなカジュアルな会話でも接客・案内など業務目的であることが多いため、
        この数字だけで利用者を判断しないようご注意ください。
      </p>
      <div class="donut-row">
        <div id="chart-donut"></div>
        <div class="legend" style="flex-direction:column;gap:10px;justify-content:center">
          <span class="item"><span class="swatch" style="background:#2a78d6"></span>業務 ${totalJudged ? Math.round(((totalJudged - totalPrivate) / totalJudged) * 100) : 0}%(${totalJudged - totalPrivate}件)</span>
          <span class="item"><span class="swatch" style="background:#e34948"></span>プライベート ${totalJudged ? Math.round((totalPrivate / totalJudged) * 100) : 0}%(${totalPrivate}件)</span>
        </div>
      </div>
    </div>

    <div class="panel">
      <h3>ユーザー別 業務/私的利用の比率</h3>
      <p class="desc">AIがメッセージごとに判定したラベルの集計です(本文は保存していません)。上記と同じく目安としてご利用ください。</p>
      <div class="legend">
        <span class="item"><span class="swatch" style="background:#2a78d6"></span>業務</span>
        <span class="item"><span class="swatch" style="background:#e34948"></span>プライベート</span>
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
  document.getElementById('chart-donut').innerHTML = workPrivateDonut(totalJudged - totalPrivate, totalPrivate);
  document.getElementById('chart-ratio').innerHTML = ratioChart(d.users);
  document.getElementById('chart-daily').innerHTML = dailyChart(d.daily);
  attachChartTooltips(el);
}

// 全社の業務/プライベート比率ドーナツチャート(業務=青、プライベート=赤)
function workPrivateDonut(work, priv, opts = {}) {
  const size = opts.size || 200;
  const stroke = opts.stroke || Math.round(size * 0.14);
  const fontBig = opts.fontBig || Math.round(size * 0.13);
  const fontSmall = opts.fontSmall || Math.round(size * 0.06);
  const label = opts.label !== undefined ? opts.label : 'プライベート';
  const total = work + priv;
  const cx = size / 2, cy = size / 2, r = size / 2 - stroke / 2 - 4;
  if (total === 0) {
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="業務/プライベート比率">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#e1e0d9" stroke-width="${stroke}"></circle>
      ${size >= 120 ? `<text x="${cx}" y="${cy + 5}" text-anchor="middle" font-size="${fontSmall}" fill="#898781">判定データなし</text>` : ''}
    </svg>`;
  }
  const circumference = 2 * Math.PI * r;
  const workLen = (work / total) * circumference;
  const privLen = circumference - workLen;
  const privPct = Math.round((priv / total) * 100);
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="業務/プライベート比率">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#e1e0d9" stroke-width="${stroke}"></circle>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#2a78d6" stroke-width="${stroke}"
      stroke-dasharray="${workLen} ${circumference}" stroke-dashoffset="0" transform="rotate(-90 ${cx} ${cy})"
      data-tip="業務 ${work}件"></circle>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#e34948" stroke-width="${stroke}"
      stroke-dasharray="${privLen} ${circumference}" stroke-dashoffset="${-workLen}" transform="rotate(-90 ${cx} ${cy})"
      data-tip="プライベート ${priv}件"></circle>
    <text x="${cx}" y="${cy - (label ? fontSmall * 0.3 : -fontBig * 0.35)}" text-anchor="middle" font-size="${fontBig}" font-weight="700" fill="#0b0b0b">${privPct}%</text>
    ${label ? `<text x="${cx}" y="${cy + fontSmall + 4}" text-anchor="middle" font-size="${fontSmall}" fill="#898781">${esc(label)}</text>` : ''}
  </svg>`;
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
      <rect x="${labelW + workW + 2}" y="${y}" width="${Math.max(privW - 2, 0)}" height="20" rx="4" fill="#e34948"
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
      <p class="desc">部署の利用額は、その部署に所属する全ユーザーの利用額の合計です(ユーザータブで内訳を確認できます)。</p>
      <table class="data">
        <tr><th>部署名</th><th class="num">今月の利用額</th><th class="num">予算(円/月)</th><th>状態</th><th></th></tr>
        ${d.departments.map((dp) => `<tr>
          <td><input class="inline-input" style="width:140px;text-align:left" data-name="${dp.id}" value="${esc(dp.name)}"></td>
          <td class="num">${yen(dp.used_jpy)}(${Math.round(dp.ratio * 100)}%)</td>
          <td class="num"><input class="inline-input" data-budget="${dp.id}" value="${Math.round(dp.monthly_budget_jpy)}"></td>
          <td>${dp.locked ? '<span class="pill locked">🔒 ロック中</span>'
            : dp.unlocked_by_admin && dp.over_budget ? '<span class="pill unlocked">解除中(今月)</span>'
            : '<span class="pill ok">利用可</span>'}</td>
          <td>
            <button class="btn-ghost" data-save="${dp.id}">保存</button>
            ${dp.locked ? `<button class="btn-primary" style="padding:6px 12px;font-size:13px" data-unlock="${dp.id}">ロック解除</button>` : ''}
            ${dp.unlocked_by_admin ? `<button class="btn-ghost" data-relock="${dp.id}">解除を取消</button>` : ''}
            <button class="btn-danger" data-delete-dept="${dp.id}">削除</button>
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
      const name = el.querySelector(`[data-name="${id}"]`).value;
      try {
        await api(`/api/admin/departments/${id}`, { method: 'PATCH', body: { monthly_budget_jpy: val, name } });
        renderAdmin();
      } catch (err) {
        alert(err.message);
      }
    };
  });
  el.querySelectorAll('[data-delete-dept]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('この部署を削除しますか?所属ユーザーは「未設定」になります(利用履歴は保持されます)。')) return;
      await api(`/api/admin/departments/${b.dataset.deleteDept}`, { method: 'DELETE' });
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
      <p class="desc">Googleログインで新規登録されたユーザーです。申請された希望部署を参考に、部署を選んで承認してください。</p>
      <table class="data">
        <tr><th>ユーザー</th><th>メール</th><th>申請した氏名</th><th>希望部署</th><th>登録日時</th><th>部署を割り当てて承認</th><th></th></tr>
        ${pending.map((u) => `<tr>
          <td>${esc(u.display_name)}</td>
          <td>${esc(u.email || '')}</td>
          <td>${u.requested_name ? esc(u.requested_name) : '<span class="muted-note">未申請</span>'}</td>
          <td>${u.requested_department ? esc(u.requested_department) : '<span class="muted-note">未申請</span>'}</td>
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
      <p class="desc">私的利用率が高いユーザーには「警告を送る」で個別に通知できます(次回ログイン/画面更新時に表示)。<br>
      「今月の利用額」は<strong>このユーザー個人</strong>の金額です。部署タブの利用額は、その部署に所属するユーザー全員の金額を合計したものです。</p>
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

// --- テンプレート管理タブ ---

async function renderTemplatesAdmin(el) {
  el.innerHTML = '<div class="panel">読み込み中…</div>';
  let templates;
  try {
    templates = await api('/api/admin/templates');
  } catch (err) {
    el.innerHTML = `<div class="panel">⚠️ ${esc(err.message)}</div>`;
    return;
  }

  const TEMPLATE_MAX = 5;
  const atMax = templates.length >= TEMPLATE_MAX;
  const atMin = templates.length <= 1;

  el.innerHTML = `
    <div class="panel">
      <h3>チャット開始時のテンプレート</h3>
      <p class="desc">
        チャットに慣れていないユーザーでもワンクリックで使えるコピペ済みの定型文です。ボタンを押すと、
        その内容がそのまま送信されてチャットが始まります。最低1個・最大${TEMPLATE_MAX}個まで登録できます
        (現在 ${templates.length}/${TEMPLATE_MAX})。
      </p>
      <div class="template-cards">
        ${templates.map((t) => `
          <div class="template-card">
            <label>ボタンに表示する名前</label>
            <input class="tpl-label" value="${esc(t.label)}" maxlength="20">
            <label>送信される内容</label>
            <textarea class="tpl-prompt" rows="3">${esc(t.prompt)}</textarea>
            <div class="template-card-actions">
              <button class="btn-primary" data-save-tpl="${t.id}">保存</button>
              <button class="btn-ghost" data-reset-tpl="${t.id}">リセット</button>
              <button class="btn-ghost" data-dup-tpl="${t.id}" ${atMax ? 'disabled' : ''}>複製</button>
              <button class="btn-danger" data-del-tpl="${t.id}" ${atMin ? 'disabled title="最低1個は必要です"' : ''}>削除</button>
            </div>
          </div>`).join('')}
      </div>
      <button class="btn-primary" id="add-template" ${atMax ? 'disabled' : ''} style="margin-top:14px">＋ 新規テンプレート追加</button>
    </div>`;

  const refresh = async () => {
    try { state.templates = await api('/api/templates'); } catch { /* 反映は次回でも可 */ }
    renderTemplatesAdmin(el);
  };

  el.querySelectorAll('[data-save-tpl]').forEach((btn) => {
    btn.onclick = async () => {
      const card = btn.closest('.template-card');
      const label = card.querySelector('.tpl-label').value.trim();
      const prompt = card.querySelector('.tpl-prompt').value.trim();
      try {
        await api(`/api/admin/templates/${btn.dataset.saveTpl}`, { method: 'PATCH', body: { label, prompt } });
        await refresh();
      } catch (err) { alert(err.message); }
    };
  });
  el.querySelectorAll('[data-reset-tpl]').forEach((btn) => {
    btn.onclick = () => renderTemplatesAdmin(el); // 再取得して未保存の編集を破棄
  });
  el.querySelectorAll('[data-dup-tpl]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        await api(`/api/admin/templates/${btn.dataset.dupTpl}/duplicate`, { method: 'POST' });
        await refresh();
      } catch (err) { alert(err.message); }
    };
  });
  el.querySelectorAll('[data-del-tpl]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('このテンプレートを削除しますか?')) return;
      try {
        await api(`/api/admin/templates/${btn.dataset.delTpl}`, { method: 'DELETE' });
        await refresh();
      } catch (err) { alert(err.message); }
    };
  });
  const addBtn = document.getElementById('add-template');
  if (addBtn) {
    addBtn.onclick = async () => {
      try {
        await api('/api/admin/templates', {
          method: 'POST',
          body: { label: '新しいテンプレート', prompt: 'ここに送信したい内容を入力してください' },
        });
        await refresh();
      } catch (err) { alert(err.message); }
    };
  }
}

init();
