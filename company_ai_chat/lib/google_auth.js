// Google OAuth 2.0 (OIDC) ログイン。外部ライブラリ不使用。
// GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET を設定すると有効になる。
'use strict';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const BASE_URL = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 8787}`).replace(/\/$/, '');
const REDIRECT_URI = `${BASE_URL}/auth/google/callback`;

const ENABLED = Boolean(CLIENT_ID && CLIENT_SECRET);

function authUrl(state) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

// 認可コードをトークンに交換し、id_token からプロフィールを取り出す。
// トークンは Google のエンドポイントから TLS 経由で直接受け取るため、
// 署名検証は省略してペイロードのデコードのみ行う。
async function exchangeCode(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`token exchange failed ${res.status}: ${body.slice(0, 300)}`);
  }
  const { id_token } = await res.json();
  if (!id_token) throw new Error('no id_token in response');
  const payload = JSON.parse(Buffer.from(id_token.split('.')[1], 'base64url').toString('utf8'));
  if (!payload.email_verified) throw new Error('email not verified');
  return {
    sub: payload.sub,
    email: payload.email,
    name: payload.name || payload.email,
  };
}

module.exports = { ENABLED, authUrl, exchangeCode, REDIRECT_URI };
