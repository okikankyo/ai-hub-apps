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
  modelPref: 'luna',     // テキスト相談はGPT-5.6 Luna固定。画像生成のみ別モード。
  templates: [],         // チャット開始画面のテンプレート一覧(ユーザー個人用)
  templatesExpanded: false,
  templateEditMode: false, // チャット画面内でのテンプレート編集モード
  templateSnapshot: null,  // 編集モードに入った時点のテンプレート一覧(「リセット」で戻す先)
  abortController: null,   // 生成中の「停止」ボタン用
  projects: [],            // チャットをまとめるプロジェクト(フォルダ)
  projectsCollapsed: {},   // プロジェクトIDごとの折りたたみ状態
  archivedOpen: false,     // サイドバーの「アーカイブ済み」を開いているか
  renamingConvId: null,    // インラインで名前変更中の会話ID
  pendingProjectId: null,  // 「このプロジェクトで新規チャット」で次に作る会話の所属先
  attachments: [],         // 送信前の添付ファイル [{kind:'image',url,name} | {kind:'text',name,content}]
};

const TEMPLATE_VISIBLE_COUNT = 3; // これを超える分はドリルダウンで畳む
const TEMPLATE_MIN_COUNT = 1;
const TEMPLATE_MAX_COUNT = 5;

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

// ユーザー発言の表示(添付画像のmarkdown参照だけを<img>にする。他はプレーンテキスト)
function renderUserContent(text) {
  return esc(text).replace(
    /!\[([^\]]*)\]\((\/api\/files\/[\w.-]+)\)/g,
    '<img src="$2" alt="$1" class="attach-image" loading="lazy">'
  );
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
    await loadProjects();
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

async function loadProjects() {
  try { state.projects = await api('/api/projects'); } catch { state.projects = []; }
}

// モバイル幅でのサイドバー(会話履歴)開閉。PC幅では見た目に影響しない。
function openMobileSidebar() {
  document.querySelector('.sidebar')?.classList.add('mobile-open');
  document.getElementById('sidebar-backdrop')?.classList.add('show');
}
function closeMobileSidebar() {
  document.querySelector('.sidebar')?.classList.remove('mobile-open');
  document.getElementById('sidebar-backdrop')?.classList.remove('show');
}

function render() {
  const me = state.me;
  const dept = me.department;
  // 総額(月予算)は見せず、今期(3日間)の利用ペースだけを見せる
  const periodRatio = dept && dept.period_budget_jpy > 0 ? Math.min(1, dept.period_used_jpy / dept.period_budget_jpy) : 0;

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
          <div class="my-ratio budget-ring-row">
            <div id="budget-ring"></div>
            <div class="my-ratio-legend">
              <div>利用ペース(${dept.period_number}/${dept.period_total}期)</div>
              <span class="item">${dept.locked ? '🔒 制限中' : '利用中'}</span>
              <div class="muted-note">次の期間: ${dept.next_period_label}〜</div>
            </div>
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
      <div class="sidebar-backdrop" id="sidebar-backdrop"></div>
      <main class="main" id="main"></main>
    </div>
    <div class="chart-tooltip" id="chart-tooltip"></div>
    <div class="ctx-menu" id="ctx-menu"></div>
    <div class="modal-overlay" id="pop-modal"></div>`;

  document.getElementById('sidebar-backdrop').onclick = closeMobileSidebar;

  const myDonut = document.getElementById('my-donut');
  if (myDonut) {
    myDonut.innerHTML = workPrivateDonut(me.my_private_stats.work, me.my_private_stats.private, { size: 64, label: '' });
  }
  const budgetRing = document.getElementById('budget-ring');
  if (budgetRing) {
    budgetRing.innerHTML = usageRing(periodRatio, { size: 64, locked: dept.locked });
  }

  document.getElementById('new-chat').onclick = async () => {
    state.currentConvId = null;
    state.messages = [];
    state.pendingProjectId = null;
    state.view = 'chat';
    closeMobileSidebar();
    render();
  };
  document.getElementById('btn-logout').onclick = async () => {
    await api('/api/logout', { method: 'POST' });
    location.reload();
  };
  const adminBtn = document.getElementById('btn-admin');
  if (adminBtn) adminBtn.onclick = () => {
    state.view = state.view === 'admin' ? 'chat' : 'admin';
    closeMobileSidebar();
    render();
  };

  renderConvList();
  if (state.view === 'admin') renderAdmin();
  else renderChat();
}

function renderConvList() {
  const el = document.getElementById('conv-list');
  const convs = state.conversations;

  const item = (c, indent) => `
    <div class="conv-item ${c.id === state.currentConvId ? 'active' : ''} ${indent ? 'indent' : ''}" data-id="${c.id}">
      ${c.pinned ? '<span class="pin-mark">📌</span>' : ''}
      ${state.renamingConvId === c.id
        ? `<input class="conv-rename" data-rename-input="${c.id}" value="${esc(c.title)}" maxlength="60">`
        : `<span class="conv-title">${esc(c.title)}</span>`}
      <button class="conv-menu-btn" data-menu="${c.id}" title="メニュー">…</button>
    </div>`;

  const pinnedList = convs.filter((c) => c.pinned && !c.archived && !c.project_id);
  const normal = convs.filter((c) => !c.pinned && !c.archived && !c.project_id);
  const archived = convs.filter((c) => c.archived);

  let html = `<div class="side-section">
    <span>プロジェクト</span>
    <button class="side-add" id="add-project" title="新しいプロジェクト">＋</button>
  </div>`;
  for (const p of state.projects) {
    const children = convs.filter((c) => c.project_id === p.id && !c.archived);
    const collapsed = state.projectsCollapsed[p.id];
    html += `
      <div class="project-item" data-project="${p.id}">
        <span class="proj-caret">${collapsed ? '▸' : '▾'}</span>
        <span class="conv-title">📁 ${esc(p.name)}</span>
        <button class="conv-menu-btn" data-proj-menu="${p.id}" title="メニュー">…</button>
      </div>`;
    if (!collapsed) {
      html += children.length
        ? children.map((c) => item(c, true)).join('')
        : '<div class="conv-empty">チャットがありません</div>';
    }
  }
  if (state.projects.length === 0) html += '<div class="conv-empty">＋で作成できます</div>';

  if (pinnedList.length) {
    html += '<div class="side-section"><span>ピン留め</span></div>';
    html += pinnedList.map((c) => item(c, false)).join('');
  }

  html += '<div class="side-section"><span>チャット</span></div>';
  html += normal.length
    ? normal.map((c) => item(c, false)).join('')
    : '<div class="conv-empty">まだチャットがありません</div>';

  if (archived.length) {
    html += `<div class="side-section archived-toggle" id="archived-toggle">
      <span>${state.archivedOpen ? '▾' : '▸'} アーカイブ済み(${archived.length})</span></div>`;
    if (state.archivedOpen) html += archived.map((c) => item(c, false)).join('');
  }

  el.innerHTML = html;

  el.querySelectorAll('.conv-item').forEach((row) => {
    row.onclick = (e) => {
      if (e.target.closest('.conv-menu-btn') || e.target.closest('.conv-rename')) return;
      openConversation(Number(row.dataset.id));
    };
    row.oncontextmenu = (e) => {
      e.preventDefault();
      openConvMenu(Number(row.dataset.id), e.clientX, e.clientY);
    };
  });
  el.querySelectorAll('[data-menu]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const r = btn.getBoundingClientRect();
      openConvMenu(Number(btn.dataset.menu), r.left, r.bottom + 4);
    };
  });
  el.querySelectorAll('.project-item').forEach((row) => {
    row.onclick = (e) => {
      if (e.target.closest('.conv-menu-btn')) return;
      const id = Number(row.dataset.project);
      state.projectsCollapsed[id] = !state.projectsCollapsed[id];
      renderConvList();
    };
    row.oncontextmenu = (e) => {
      e.preventDefault();
      openProjectMenu(Number(row.dataset.project), e.clientX, e.clientY);
    };
  });
  el.querySelectorAll('[data-proj-menu]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const r = btn.getBoundingClientRect();
      openProjectMenu(Number(btn.dataset.projMenu), r.left, r.bottom + 4);
    };
  });

  const addProj = document.getElementById('add-project');
  if (addProj) addProj.onclick = async (e) => {
    e.stopPropagation();
    const name = prompt('プロジェクト名');
    if (!name || !name.trim()) return;
    try {
      await api('/api/projects', { method: 'POST', body: { name: name.trim() } });
      await loadProjects();
      renderConvList();
    } catch (err) { alert(err.message); }
  };
  const archToggle = document.getElementById('archived-toggle');
  if (archToggle) archToggle.onclick = () => {
    state.archivedOpen = !state.archivedOpen;
    renderConvList();
  };

  // インラインの名前変更(Enter/フォーカス外しで確定、Escで取消)
  const renameInput = el.querySelector('.conv-rename');
  if (renameInput) {
    renameInput.focus();
    renameInput.select();
    let done = false;
    const commit = async () => {
      if (done) return;
      done = true;
      const id = Number(renameInput.dataset.renameInput);
      const title = renameInput.value.trim();
      state.renamingConvId = null;
      if (title) {
        try { await api(`/api/conversations/${id}`, { method: 'PATCH', body: { title } }); } catch (err) { alert(err.message); }
        await loadConversations();
      }
      renderConvList();
    };
    renameInput.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); renameInput.blur(); }
      if (e.key === 'Escape') { done = true; state.renamingConvId = null; renderConvList(); }
    };
    renameInput.onblur = commit;
  }
}

async function openConversation(id) {
  state.currentConvId = id;
  state.view = 'chat';
  closeMobileSidebar();
  state.messages = await api(`/api/conversations/${id}/messages`);
  render();
}

// ---------- 会話・プロジェクトのコンテキストメニュー ----------

function closeCtxMenu() {
  const m = document.getElementById('ctx-menu');
  if (m) { m.style.display = 'none'; m.innerHTML = ''; }
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('#ctx-menu')) closeCtxMenu();
});

function showCtxMenu(items, x, y) {
  const m = document.getElementById('ctx-menu');
  if (!m) return;
  m.innerHTML = items.map((it, i) =>
    it === '-' ? '<div class="ctx-sep"></div>'
      : `<button class="ctx-item ${it.danger ? 'danger' : ''}" data-ctx="${i}">${it.label}</button>`
  ).join('');
  m.style.display = 'block';
  // 画面からはみ出さないように位置を調整
  const rect = m.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
  m.querySelectorAll('[data-ctx]').forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      closeCtxMenu();
      const it = items[Number(b.dataset.ctx)];
      if (it && it.action) await it.action();
    };
  });
}

function openConvMenu(id, x, y) {
  const c = state.conversations.find((v) => v.id === id);
  if (!c) return;
  const patch = async (body) => {
    try { await api(`/api/conversations/${id}`, { method: 'PATCH', body }); } catch (err) { alert(err.message); }
    await loadConversations();
    renderConvList();
  };
  const items = [
    { label: c.pinned ? '📌 ピン留めを解除' : '📌 ピン留め', action: () => patch({ pinned: !c.pinned }) },
    { label: '✏️ 名前を変更', action: () => { state.renamingConvId = id; renderConvList(); } },
  ];
  for (const p of state.projects) {
    if (p.id !== c.project_id) {
      items.push({ label: `📁 「${esc(p.name)}」へ移動`, action: () => patch({ project_id: p.id }) });
    }
  }
  if (c.project_id) items.push({ label: '📂 プロジェクトから出す', action: () => patch({ project_id: null }) });
  items.push('-');
  items.push({ label: c.archived ? '🗂 アーカイブを解除' : '🗂 アーカイブ', action: () => patch({ archived: !c.archived }) });
  items.push({
    label: '🗑 削除',
    danger: true,
    action: async () => {
      if (!confirm('この会話を削除しますか?')) return;
      await api(`/api/conversations/${id}`, { method: 'DELETE' });
      if (state.currentConvId === id) {
        state.currentConvId = null;
        state.messages = [];
      }
      await loadConversations();
      render();
    },
  });
  showCtxMenu(items, x, y);
}

function openProjectMenu(id, x, y) {
  const p = state.projects.find((v) => v.id === id);
  if (!p) return;
  showCtxMenu([
    {
      label: '💬 このプロジェクトで新規チャット',
      action: () => {
        state.pendingProjectId = id;
        state.currentConvId = null;
        state.messages = [];
        state.view = 'chat';
        closeMobileSidebar();
        render();
      },
    },
    {
      label: '✏️ 名前を変更',
      action: async () => {
        const name = prompt('プロジェクト名', p.name);
        if (!name || !name.trim()) return;
        try { await api(`/api/projects/${id}`, { method: 'PATCH', body: { name: name.trim() } }); } catch (err) { alert(err.message); }
        await loadProjects();
        renderConvList();
      },
    },
    '-',
    {
      label: '🗑 削除(チャットは残ります)',
      danger: true,
      action: async () => {
        if (!confirm(`プロジェクト「${p.name}」を削除しますか?\n中のチャットは削除されず、一覧に戻ります。`)) return;
        await api(`/api/projects/${id}`, { method: 'DELETE' });
        await loadProjects();
        await loadConversations();
        renderConvList();
      },
    },
  ], x, y);
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
    ? `<div class="banner"><div class="msg">📊 今期の利用ペースが早めです。計画的にご利用ください。</div></div>`
    : '';

  document.getElementById('main').innerHTML = `
    <div class="chat-header">
      <button class="mobile-menu-btn" id="mobile-menu-btn" title="メニュー" aria-label="メニュー">☰</button>
      <span>${state.currentConvId ? esc((state.conversations.find((c) => c.id === state.currentConvId) || {}).title || '') : '新しいチャット'}</span>
      ${me.mock_mode ? '<span class="mock-badge">モックモード(APIキー未設定)</span>' : ''}
    </div>
    ${warningBanners}${budgetBanner}
    ${locked ? `
    <div class="messages">
      <div class="lock-overlay">
        <div class="icon">⏳</div>
        <h2>今期の利用枠を使い切りました</h2>
        <p>部署「${esc(dept.name)}」の今期(${dept.period_number}/${dept.period_total}期)の利用枠を使い切りました。<br>
        ${dept.advance_available
          ? `次の期間(${dept.next_period_label}〜)までお待ちいただくか、急ぎの場合は下のボタンで次の期間の枠を先に使えます。`
          : `今月の前倒し(月3回)はすべて使用済みです。次の期間(${dept.next_period_label}〜)までお待ちください。`}<br>
        予算そのものを増やしたい場合は管理者にご相談ください。</p>
        ${dept.advance_available ? `
        <div class="lock-actions">
          <button class="btn-primary" id="btn-advance">前倒しで使う(残り${dept.advance_remaining}回/月)</button>
        </div>` : ''}
      </div>
    </div>` : `
    <div class="messages" id="messages"><div class="thread" id="thread"></div></div>
    <div class="composer-wrap">
      <div class="attach-row" id="attach-row"></div>
      <div class="composer">
        <button class="attach-btn" id="attach-btn" title="ファイルを添付">📎</button>
        <button class="attach-btn" id="pop-btn" title="POP作成ツール(AIを使わず写真+文字で確実に作る)">🏷️</button>
        <select id="model-pref" class="model-pref" title="使用モデル">
          <option value="luna">GPT-5.6 Luna</option>
          <option value="image">🎨 画像生成</option>
        </select>
        <textarea id="input" rows="1" placeholder="メッセージを入力…(Shift+Enterで送信)"></textarea>
        <button class="send" id="send" title="送信">↑</button>
      </div>
      <input type="file" id="file-input" multiple style="display:none"
        accept="image/png,image/jpeg,image/webp,image/gif,.txt,.md,.csv,.tsv,.json,.log,.pdf,.docx,.xlsx,.xls">
      <div class="composer-note">Shift+Enterで送信、クリックでも送信できます(Enterのみでは改行されます)。テキスト相談はGPT-5.6 Lunaを使います。画像を作りたいときだけ「画像生成」を選んでください。利用状況の分析のため、各メッセージは業務/私的利用の判定のみ行われます。会話の内容自体が管理者に共有されることはありません。</div>
    </div>`}
  `;

  document.querySelectorAll('[data-ack]').forEach((btn) => {
    btn.onclick = async () => {
      await api(`/api/warnings/${btn.dataset.ack}/ack`, { method: 'POST' });
      await loadMe();
      render();
    };
  });
  document.getElementById('mobile-menu-btn').onclick = openMobileSidebar;

  if (locked) {
    const advanceBtn = document.getElementById('btn-advance');
    if (advanceBtn) advanceBtn.onclick = async () => {
      try {
        await api('/api/budget/advance', { method: 'POST' });
      } catch (err) {
        alert(err.message);
      }
      await loadMe();
      render();
    };
    return;
  }

  renderMessages();

  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 180) + 'px';
  };
  input.addEventListener('input', autosize);
  // Enterのみは改行(IME確定時の誤送信を避けるため)、Shift+Enterで送信する
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });
  sendBtn.onclick = sendMessage;
  const modelPref = document.getElementById('model-pref');
  modelPref.value = state.modelPref;
  modelPref.onchange = () => { state.modelPref = modelPref.value; };

  // 添付ファイル
  const fileInput = document.getElementById('file-input');
  document.getElementById('attach-btn').onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    for (const f of Array.from(fileInput.files)) await addAttachment(f);
    fileInput.value = '';
  };
  renderAttachRow();

  document.getElementById('pop-btn').onclick = openPopModal;

  input.focus();
}

// ---------- POP作成ツール(AI不使用、写真+文字を確実に合成) ----------

const POP_COLORS = [
  { id: 'pink', label: 'ピンク', swatch: '#e83e8c' },
  { id: 'yellow', label: 'イエロー', swatch: '#d9822b' },
  { id: 'blue', label: 'ブルー', swatch: '#2563eb' },
  { id: 'green', label: 'グリーン', swatch: '#16a34a' },
  { id: 'purple', label: 'パープル', swatch: '#7c3aed' },
];
const popState = { mode: 'photo', photoFile: null, color: 'pink', aspect: 'square' };

function openPopModal() {
  popState.photoFile = null;
  const modal = document.getElementById('pop-modal');
  renderPopModal(modal);
  modal.classList.add('show');
  modal.onclick = (e) => { if (e.target === modal) closePopModal(); };
}

function renderPopModal(modal) {
  modal.innerHTML = `
    <div class="modal-card">
      <h3>🏷️ POP作成ツール</h3>
      <p class="desc">見出しと価格は必ずそのまま合成されるので、文字が崩れたり変わったりしません。</p>
      <div class="pop-mode-tabs">
        <button type="button" class="pop-mode-tab ${popState.mode === 'photo' ? 'active' : ''}" data-mode="photo">📷 写真から作成</button>
        <button type="button" class="pop-mode-tab ${popState.mode === 'generate' ? 'active' : ''}" data-mode="generate">✨ 新規作成</button>
      </div>
      ${popState.mode === 'photo' ? `
      <p class="desc">AIが商品写真を切り抜き・明るさ補正します(商品自体は変えません)。</p>
      <label>商品写真</label>
      <input type="file" id="pop-photo" accept="image/png,image/jpeg,image/webp,image/gif">
      <div id="pop-preview"></div>` : `
      <p class="desc">AIが説明文から商品画像を新しく作ります。</p>
      <label>作りたい商品の説明</label>
      <textarea id="pop-description" rows="2" maxlength="500" placeholder="例: 青いラピスラズリを使ったゴールドのブレスレット"></textarea>`}
      <label>見出し(例: 夏限定セール)</label>
      <input type="text" id="pop-headline" maxlength="20" placeholder="夏限定セール">
      <label>価格(例: 2980円)</label>
      <input type="text" id="pop-price" maxlength="20" placeholder="2980円">
      <label>色</label>
      <div class="pop-colors">
        ${POP_COLORS.map((c) => `<button type="button" class="pop-color-btn ${c.id === popState.color ? 'active' : ''}"
          data-color="${c.id}" style="background:${c.swatch}" title="${c.label}"></button>`).join('')}
      </div>
      <label>縦横比</label>
      <select id="pop-aspect">
        <option value="square">正方形</option>
        <option value="landscape">横長(名刺サイズ風)</option>
        <option value="portrait">縦長</option>
      </select>
      <div class="modal-actions">
        <button class="btn-ghost" id="pop-cancel">キャンセル</button>
        <button class="btn-primary" id="pop-submit">作成する</button>
      </div>
      <div class="login-error" id="pop-error"></div>
    </div>`;
  document.getElementById('pop-aspect').value = popState.aspect;

  modal.querySelectorAll('.pop-mode-tab').forEach((btn) => {
    btn.onclick = () => { popState.mode = btn.dataset.mode; renderPopModal(modal); };
  });
  const photoInput = document.getElementById('pop-photo');
  if (photoInput) {
    photoInput.onchange = (e) => {
      popState.photoFile = e.target.files[0] || null;
      const preview = document.getElementById('pop-preview');
      preview.innerHTML = popState.photoFile
        ? `<img src="${URL.createObjectURL(popState.photoFile)}" alt="">` : '';
    };
  }
  modal.querySelectorAll('.pop-color-btn').forEach((btn) => {
    btn.onclick = () => {
      popState.color = btn.dataset.color;
      modal.querySelectorAll('.pop-color-btn').forEach((b) => b.classList.toggle('active', b === btn));
    };
  });
  document.getElementById('pop-cancel').onclick = closePopModal;
  document.getElementById('pop-submit').onclick = submitPop;
}

function closePopModal() {
  const modal = document.getElementById('pop-modal');
  modal.classList.remove('show');
  modal.innerHTML = '';
}

async function submitPop() {
  const headline = document.getElementById('pop-headline').value.trim();
  const price = document.getElementById('pop-price').value.trim();
  const aspect = document.getElementById('pop-aspect').value;
  const errorEl = document.getElementById('pop-error');
  errorEl.textContent = '';
  const description = popState.mode === 'generate' ? document.getElementById('pop-description').value.trim() : '';
  if (popState.mode === 'photo' && !popState.photoFile) return (errorEl.textContent = '商品写真を選択してください');
  if (popState.mode === 'generate' && !description) return (errorEl.textContent = '作りたい商品の説明を入力してください');
  if (!headline || !price) return (errorEl.textContent = '見出しと価格を入力してください');

  const submitBtn = document.getElementById('pop-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = '作成中…';
  try {
    const body = { conversation_id: state.currentConvId, mode: popState.mode, headline, price, color: popState.color, aspect };
    if (popState.mode === 'photo') {
      const data = await fileToBase64(popState.photoFile);
      const { url } = await api('/api/upload', { method: 'POST', body: { name: popState.photoFile.name, data } });
      body.photo_url = url;
    } else {
      body.description = description;
    }
    if (!state.currentConvId) {
      const { id } = await api('/api/conversations', { method: 'POST' });
      state.currentConvId = id;
      body.conversation_id = id;
    }
    await api('/api/pop', { method: 'POST', body });
    closePopModal();
    state.messages = await api(`/api/conversations/${state.currentConvId}/messages`);
    await loadConversations();
    await loadMe();
    render();
  } catch (err) {
    errorEl.textContent = err.message;
    submitBtn.disabled = false;
    submitBtn.textContent = '作成する';
  }
}

// ---------- 添付ファイル ----------

const TEXT_FILE_RE = /\.(txt|md|csv|tsv|json|log)$/i;
const DOC_FILE_RE = /\.(pdf|docx|xlsx|xls)$/i;

async function addAttachment(file) {
  if (state.attachments.length >= 4) return alert('添付は一度に4件までです');
  if (/^image\//.test(file.type)) {
    if (file.size > 8_000_000) return alert(`${file.name}: 画像は8MBまでです`);
    try {
      const data = await fileToBase64(file);
      const { url } = await api('/api/upload', { method: 'POST', body: { name: file.name, data } });
      // ファイル名の [ ] ( ) はmarkdown参照を壊すので除去しておく
      state.attachments.push({ kind: 'image', url, name: file.name.replace(/[[\]()]/g, '') || '画像' });
    } catch (err) {
      return alert(`${file.name}: ${err.message}`);
    }
  } else if (TEXT_FILE_RE.test(file.name)) {
    if (file.size > 200_000) return alert(`${file.name}: テキストファイルは200KBまでです`);
    state.attachments.push({ kind: 'text', name: file.name, content: await file.text() });
  } else if (DOC_FILE_RE.test(file.name)) {
    if (file.size > 8_000_000) return alert(`${file.name}: ファイルは8MBまでです`);
    try {
      const data = await fileToBase64(file);
      const { text } = await api('/api/extract-text', { method: 'POST', body: { name: file.name, data } });
      state.attachments.push({ kind: 'text', name: file.name, content: text });
    } catch (err) {
      return alert(`${file.name}: ${err.message}`);
    }
  } else {
    return alert(`${file.name}: 対応していない形式です(画像 / txt / md / csv / pdf / docx / xlsx など)`);
  }
  renderAttachRow();
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('読み込みに失敗しました'));
    r.readAsDataURL(file);
  });
}

function renderAttachRow() {
  const row = document.getElementById('attach-row');
  if (!row) return;
  row.innerHTML = state.attachments.map((a, i) => `
    <span class="attach-chip">
      ${a.kind === 'image' ? `<img src="${a.url}" alt="">` : '📄'} ${esc(a.name)}
      <button data-rm-att="${i}" title="削除">✕</button>
    </span>`).join('');
  row.style.display = state.attachments.length ? 'flex' : 'none';
  row.querySelectorAll('[data-rm-att]').forEach((b) => {
    b.onclick = () => {
      state.attachments.splice(Number(b.dataset.rmAtt), 1);
      renderAttachRow();
    };
  });
}

function renderMessages() {
  const thread = document.getElementById('thread');
  if (!thread) return;
  if (state.messages.length === 0) {
    thread.innerHTML = `
      <div class="empty-state">
        <h2>お手伝いできることはありますか?</h2>
        <p>業務に関する質問・文章作成・翻訳・コード作成などに使えます。</p>
        <p class="empty-state-notice">⚠️ 送信・削除・金額・個人情報に関わる操作の自動確認は行われません。実行前の内容は必ずご自身でご確認ください。</p>
        ${renderTemplateButtons()}
      </div>`;
    attachTemplateButtonHandlers(thread);
    return;
  }
  thread.innerHTML = state.messages.map((m) =>
    m.role === 'user'
      ? `<div class="msg-row user"><div class="msg-user">${renderUserContent(m.content)}</div></div>`
      : `<div class="msg-row"><div class="msg-assistant"><div class="avatar">AI</div><div class="content">${renderMarkdown(m.content)}${
          m.model ? `<div class="msg-model">${esc(m.model)}</div>` : ''
        }</div></div></div>`
  ).join('');
  scrollToBottom();
}

// チャット未経験のユーザー向けのワンクリック定型文ボタン(各ユーザーが自分用に編集)
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
  const editToggle = `<button class="template-btn template-edit-toggle" id="template-edit-toggle">${
    state.templateEditMode ? '✕ 編集を終了' : '✎ テンプレートを編集'}</button>`;
  const editor = state.templateEditMode ? renderTemplateEditorPanel() : '';
  return `<div class="template-row">${buttons}${more}${editToggle}</div>${editor}`;
}

// チャット画面その場でのテンプレート編集パネル(保存/リセット/複製/削除、自分の分のみ)
function renderTemplateEditorPanel() {
  const atMax = state.templates.length >= TEMPLATE_MAX_COUNT;
  const atMin = state.templates.length <= TEMPLATE_MIN_COUNT;
  return `
    <div class="template-editor">
      ${state.templates.map((t) => `
        <div class="template-edit-card" data-tpl-id="${t.id}">
          <input class="tpl-label" value="${esc(t.label)}" maxlength="20" placeholder="ボタンの名前">
          <textarea class="tpl-prompt" rows="2" placeholder="送信される内容">${esc(t.prompt)}</textarea>
          <div class="template-edit-actions">
            <button class="btn-ghost" data-save-tpl="${t.id}">保存</button>
            <button class="btn-ghost" data-reset-tpl="${t.id}">リセット</button>
            <button class="btn-ghost" data-dup-tpl="${t.id}" ${atMax ? 'disabled' : ''}>複製</button>
            <button class="btn-danger" data-del-tpl="${t.id}" ${atMin ? 'disabled' : ''}>削除</button>
          </div>
        </div>`).join('')}
      <button class="btn-ghost template-add-btn" id="add-template" ${atMax ? 'disabled' : ''}>
        ＋ 新規テンプレート追加(${state.templates.length}/${TEMPLATE_MAX_COUNT})
      </button>
    </div>`;
}

function attachTemplateButtonHandlers(root) {
  root.querySelectorAll('[data-template-id]').forEach((btn) => {
    btn.onclick = () => {
      if (state.templateEditMode) return; // 編集モード中はクリックしても送信しない
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
  const editToggle = root.querySelector('#template-edit-toggle');
  if (editToggle) {
    editToggle.onclick = () => {
      state.templateEditMode = !state.templateEditMode;
      // 編集モードに入った瞬間の状態を「リセット」の戻し先として保存しておく
      state.templateSnapshot = state.templateEditMode
        ? state.templates.map((t) => ({ ...t }))
        : null;
      renderMessages();
    };
  }
  if (!state.templateEditMode) return;

  const refreshTemplates = async () => {
    try { state.templates = await api('/api/templates'); } catch { /* 反映は次回でも可 */ }
    renderMessages();
  };
  root.querySelectorAll('[data-save-tpl]').forEach((btn) => {
    btn.onclick = async () => {
      const card = btn.closest('.template-edit-card');
      const label = card.querySelector('.tpl-label').value.trim();
      const prompt = card.querySelector('.tpl-prompt').value.trim();
      if (!label || !prompt) return alert('ボタンの名前と内容を入力してください');
      try {
        await api(`/api/templates/${btn.dataset.saveTpl}`, { method: 'PATCH', body: { label, prompt } });
        await refreshTemplates();
      } catch (err) { alert(err.message); }
    };
  });
  // リセット: このテンプレートを「編集モードに入った時点の内容」に戻す
  // (保存を間違えて上書きしてしまった場合の取り消しに使う)
  root.querySelectorAll('[data-reset-tpl]').forEach((btn) => {
    btn.onclick = async () => {
      const id = Number(btn.dataset.resetTpl);
      const original = (state.templateSnapshot || []).find((t) => t.id === id);
      try {
        if (original) {
          await api(`/api/templates/${id}`, {
            method: 'PATCH', body: { label: original.label, prompt: original.prompt },
          });
        } else {
          // 編集モード中に新規追加したテンプレートは、リセットで削除して無かった状態に戻す
          await api(`/api/templates/${id}`, { method: 'DELETE' });
        }
        await refreshTemplates();
      } catch (err) { alert(err.message); }
    };
  });
  root.querySelectorAll('[data-dup-tpl]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        await api(`/api/templates/${btn.dataset.dupTpl}/duplicate`, { method: 'POST' });
        await refreshTemplates();
      } catch (err) { alert(err.message); }
    };
  });
  root.querySelectorAll('[data-del-tpl]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('このテンプレートを削除しますか?')) return;
      try {
        await api(`/api/templates/${btn.dataset.delTpl}`, { method: 'DELETE' });
        await refreshTemplates();
      } catch (err) { alert(err.message); }
    };
  });
  const addBtn = root.querySelector('#add-template');
  if (addBtn) {
    addBtn.onclick = async () => {
      try {
        await api('/api/templates', {
          method: 'POST',
          body: { label: '新しいテンプレート', prompt: 'ここに送信したい内容を入力してください' },
        });
        await refreshTemplates();
      } catch (err) { alert(err.message); }
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
  let text = input.value.trim();
  if (!text && state.attachments.length === 0) return;

  // 添付を本文に組み込む(画像はmarkdown参照、テキストはコードブロック)
  for (const a of state.attachments) {
    if (a.kind === 'image') text += `\n\n![${a.name}](${a.url})`;
    else text += `\n\n【添付ファイル: ${a.name}】\n\`\`\`\n${a.content}\n\`\`\``;
  }
  text = text.trim();

  // 会話作成の await 中も二重送信を防ぐため、ここで即座にロックする
  state.streaming = true;
  try {
    if (!state.currentConvId) {
      const { id } = await api('/api/conversations', {
        method: 'POST',
        body: state.pendingProjectId ? { project_id: state.pendingProjectId } : {},
      });
      state.currentConvId = id;
      state.pendingProjectId = null;
    }
  } catch (err) {
    state.streaming = false;
    alert('会話の作成に失敗しました: ' + err.message);
    return;
  }

  input.value = '';
  input.style.height = 'auto';
  state.attachments = [];
  renderAttachRow();
  state.messages.push({ role: 'user', content: text });
  renderMessages();
  await executeChat(text);
}

async function executeChat(text) {
  state.streaming = true;
  state.abortController = new AbortController();
  setSendButtonMode('stop');
  const stream = appendStreamingRow();
  let acc = ''; // catch節でも参照するため try の外で宣言する

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversation_id: state.currentConvId,
        message: text,
        model_pref: state.modelPref,
      }),
      signal: state.abortController.signal,
    });

    // JSON 応答 = ストリーミング以外(エラー)
    if ((res.headers.get('content-type') || '').includes('application/json')) {
      const data = await res.json().catch(() => ({}));
      stream.remove();
      state.messages.push({ role: 'assistant', content: `⚠️ ${data.error || '送信に失敗しました'}` });
      renderMessages();
      return;
    }

    // SSE ストリームを読む
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
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
    if (err.name === 'AbortError') {
      // ここまで生成された内容をそのまま確定させる(サーバー側でも保存済み)
      state.messages.push({ role: 'assistant', content: acc || '(停止しました)' });
    } else {
      state.messages.push({ role: 'assistant', content: `⚠️ 通信エラー: ${err.message}` });
    }
    renderMessages();
  } finally {
    state.streaming = false;
    state.abortController = null;
    setSendButtonMode('send');
    // 予算メーター・タイトル・警告を最新化(画面全体を再描画)
    await loadMe();
    await loadConversations();
    render();
  }
}

// 送信ボタンを「送信」⇄「停止」の見た目・動作に切り替える
function setSendButtonMode(mode) {
  const btn = document.getElementById('send');
  if (!btn) return;
  if (mode === 'stop') {
    btn.textContent = '■';
    btn.title = '生成を停止';
    btn.classList.add('stop-mode');
    btn.disabled = false;
    btn.onclick = () => state.abortController?.abort();
  } else {
    btn.textContent = '↑';
    btn.title = '送信';
    btn.classList.remove('stop-mode');
    btn.onclick = sendMessage;
  }
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
      <div class="admin-header">
        <button class="mobile-menu-btn" id="mobile-menu-btn" title="メニュー" aria-label="メニュー">☰</button>
        <h1>管理画面 <small style="font-weight:400;color:var(--muted)">${esc(d.month)}</small></h1>
      </div>
      <div class="tabs">${tabs.map(([k, label]) =>
        `<button class="tab ${state.adminTab === k ? 'active' : ''}" data-tab="${k}">${label}</button>`).join('')}
      </div>
      <div id="admin-body"></div>
    </div></div>`;
  main.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => { state.adminTab = b.dataset.tab; renderAdmin(); };
  });
  document.getElementById('mobile-menu-btn').onclick = openMobileSidebar;
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

// 利用ペースのリング(未使用=グレー、使用=青→黄→オレンジ→赤で段階的に警告)
function usageRing(ratio, opts = {}) {
  const size = opts.size || 64;
  const stroke = opts.stroke || Math.round(size * 0.16);
  const fontBig = opts.fontBig || Math.round(size * 0.24);
  const locked = opts.locked || false;
  const clamped = Math.max(0, Math.min(1, ratio));
  const cx = size / 2, cy = size / 2, r = size / 2 - stroke / 2 - 2;
  const circumference = 2 * Math.PI * r;
  const usedLen = clamped * circumference;
  const color = locked || clamped >= 0.9 ? '#d03b3b'
    : clamped >= 0.75 ? '#e2811a'
    : clamped >= 0.5 ? '#eda100'
    : '#2a78d6';
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="利用ペース">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#e1e0d9" stroke-width="${stroke}"></circle>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round"
      stroke-dasharray="${usedLen} ${circumference}" stroke-dashoffset="0" transform="rotate(-90 ${cx} ${cy})"></circle>
    <text x="${cx}" y="${cy + fontBig * 0.35}" text-anchor="middle" font-size="${fontBig}" font-weight="700" fill="#0b0b0b">${Math.round(clamped * 100)}%</text>
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
    const pct = dp.monthly_budget_jpy > 0 ? Math.round((dp.used_jpy / dp.monthly_budget_jpy) * 100) : 0;
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
      <p class="desc">予算(円/月)は、1ヶ月30日を3日ごと10期間に分けて少しずつ解放するペース配分方式で使われます。利用者には総額を見せず、期間の進み具合だけを表示しています。</p>
      <p class="desc">各期間の枠を使い切るとチャットはロックされ、利用者自身が「前倒し」(次の期間の枠を先取り、月3回まで)で対応できます。「ロック解除」を押すと今月分は無条件で解除されます。</p>
      <p class="desc">部署の利用額は、その部署に所属する全ユーザーの利用額の合計です(ユーザータブで内訳を確認できます)。</p>
      <table class="data">
        <tr><th>部署名</th><th class="num">今月の利用額</th><th class="num">予算(円/月)</th><th>今期</th><th>状態</th><th></th></tr>
        ${d.departments.map((dp) => `<tr>
          <td><input class="inline-input" style="width:140px;text-align:left" data-name="${dp.id}" value="${esc(dp.name)}"></td>
          <td class="num">${yen(dp.used_jpy)}(月間${Math.round((dp.used_jpy / (dp.monthly_budget_jpy || 1)) * 100)}%)</td>
          <td class="num"><input class="inline-input" data-budget="${dp.id}" value="${Math.round(dp.monthly_budget_jpy)}"></td>
          <td>${dp.period_number}/${dp.period_total}期(前倒し${dp.advance_used}/3)</td>
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

init();
