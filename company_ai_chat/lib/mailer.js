// Gmail SMTP(アプリパスワード)でのメール送信。
// SMTP_USER/SMTP_PASS が未設定の場合は何もせず、ログにスキップした旨だけ出す。
'use strict';

const nodemailer = require('nodemailer');

const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const ENABLED = Boolean(SMTP_USER && SMTP_PASS);

const transporter = ENABLED
  ? nodemailer.createTransport({ service: 'gmail', auth: { user: SMTP_USER, pass: SMTP_PASS } })
  : null;

async function sendMail(to, subject, text) {
  if (!ENABLED || !to) {
    if (!ENABLED) console.log(`[mailer] SMTP未設定のため送信スキップ: ${subject} -> ${to}`);
    return;
  }
  try {
    await transporter.sendMail({ from: `社内AIチャット <${SMTP_USER}>`, to, subject, text });
  } catch (err) {
    console.error('[mailer] 送信失敗:', err.message);
  }
}

module.exports = { sendMail, ENABLED };
