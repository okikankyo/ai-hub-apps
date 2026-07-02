// セッション認証(HttpOnly Cookie + DB 保存トークン)
'use strict';

const crypto = require('node:crypto');
const { db, verifyPassword } = require('./db');

const SESSION_TTL_HOURS = 24 * 7;

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function login(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND disabled = 0').get(username);
  if (!user || !verifyPassword(password, user.password_hash)) return null;
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, expires);
  return { token, user };
}

function logout(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// リクエストからログイン中ユーザーを取得。未ログインなら null。
function getUser(req) {
  const token = parseCookies(req).session;
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.*, s.token AS session_token, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND u.disabled = 0
  `).get(token);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    logout(token);
    return null;
  }
  return row;
}

function sessionCookie(token) {
  // 社内 LAN 想定。HTTPS 配下で運用する場合は Secure を付けること。
  return `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_HOURS * 3600}`;
}

function clearCookie() {
  return 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';
}

module.exports = { login, logout, getUser, sessionCookie, clearCookie, parseCookies };
