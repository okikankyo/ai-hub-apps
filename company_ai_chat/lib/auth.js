// セッション認証(HttpOnly Cookie + DB 保存トークン)
'use strict';

const crypto = require('node:crypto');
const { db, verifyPassword } = require('./db');

const SESSION_TTL_HOURS = 24 * 7;

// リバースプロキシ(Coolify/Traefik等)配下で BASE_URL が https:// なら
// Cookie に Secure を付与する。プロキシ~コンテナ間は平文でも、
// ブラウザ~公開エンドポイント間が HTTPS であれば安全に付与できる。
const SECURE = (process.env.BASE_URL || '').startsWith('https://') ? '; Secure' : '';

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

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000).toISOString();
  await db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  return token;
}

async function login(username, password) {
  const user = await db.prepare('SELECT * FROM users WHERE username = ? AND disabled = 0').get(username);
  // password_hash が空のユーザー(Google ログイン専用)はパスワードでは入れない
  if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) return null;
  return { token: await createSession(user.id), user };
}

async function logout(token) {
  if (token) await db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// リクエストからログイン中ユーザーを取得。未ログインなら null。
async function getUser(req) {
  const token = parseCookies(req).session;
  if (!token) return null;
  const row = await db.prepare(`
    SELECT u.*, s.token AS session_token, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND u.disabled = 0
  `).get(token);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    await logout(token);
    return null;
  }
  return row;
}

function sessionCookie(token) {
  return `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_HOURS * 3600}${SECURE}`;
}

function clearCookie() {
  return `session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${SECURE}`;
}

function oauthStateCookie(state) {
  return `oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${SECURE}`;
}

function clearOauthStateCookie() {
  return `oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${SECURE}`;
}

module.exports = {
  login, logout, getUser, sessionCookie, clearCookie, parseCookies, createSession,
  oauthStateCookie, clearOauthStateCookie,
};
