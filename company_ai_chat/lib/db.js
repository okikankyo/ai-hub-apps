// SQLite (node:sqlite) データベース層。
// 重要: classifications テーブルにはラベル(work/private)のみ保存し、
// チャット本文は分析目的では一切保持しない。
'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS departments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    monthly_budget_jpy REAL NOT NULL DEFAULT 50000,
    unlock_month TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    department_id INTEGER REFERENCES departments(id),
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL DEFAULT '新しいチャット',
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    department_id INTEGER REFERENCES departments(id),
    model TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat', 'classify')),
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cost_jpy REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_usage_dept_date ON usage_log(department_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_usage_user_date ON usage_log(user_id, created_at);

  -- ラベルのみ。メッセージ本文・会話IDは持たない(プライバシー配慮)。
  CREATE TABLE IF NOT EXISTS classifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    department_id INTEGER REFERENCES departments(id),
    label TEXT NOT NULL CHECK (label IN ('work', 'private', 'unknown')),
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_class_user_date ON classifications(user_id, created_at);

  CREATE TABLE IF NOT EXISTS warnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    type TEXT NOT NULL,           -- 'private_ratio' | 'manual'
    message TEXT NOT NULL,
    month TEXT NOT NULL,          -- 'YYYY-MM' 同月の重複警告防止に使用
    acknowledged INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  -- チャット開始時にワンクリックで送信できる定型文(管理者が管理、最少1件・最大5件)
  CREATE TABLE IF NOT EXISTS prompt_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    prompt TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
`);

// 既存 DB への追加カラム(Google ログイン・承認制対応)
{
  const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!userCols.includes('google_sub')) db.exec('ALTER TABLE users ADD COLUMN google_sub TEXT');
  if (!userCols.includes('email')) db.exec('ALTER TABLE users ADD COLUMN email TEXT');
  if (!userCols.includes('status')) {
    // status: 'active' = 利用可 / 'pending' = 管理者の承認待ち
    db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL');
  // 承認待ちユーザーが自己申告する氏名・希望部署(自由記述、管理者の承認判断の参考用)
  if (!userCols.includes('requested_name')) db.exec('ALTER TABLE users ADD COLUMN requested_name TEXT');
  if (!userCols.includes('requested_department')) db.exec('ALTER TABLE users ADD COLUMN requested_department TEXT');

  // 応答に使ったモデルの記録(ルーティング結果の表示用)
  const msgCols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  if (!msgCols.includes('model')) db.exec('ALTER TABLE messages ADD COLUMN model TEXT');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'));
}

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// 初回起動時のシードデータ
function seed() {
  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (userCount > 0) return;

  const insDept = db.prepare('INSERT INTO departments (name, monthly_budget_jpy) VALUES (?, ?)');
  const adminDeptId = insDept.run('管理部', 30000).lastInsertRowid;
  const salesDeptId = insDept.run('営業部', 50000).lastInsertRowid;
  const devDeptId = insDept.run('開発部', 100000).lastInsertRowid;

  const insUser = db.prepare(
    'INSERT INTO users (username, display_name, password_hash, role, department_id) VALUES (?, ?, ?, ?, ?)'
  );
  insUser.run('admin', '管理者', hashPassword('admin1234'), 'admin', adminDeptId);
  insUser.run('demo', 'デモユーザー', hashPassword('demo1234'), 'user', salesDeptId);
  console.log('[db] 初期データを作成しました (admin/admin1234, demo/demo1234)');
  void devDeptId;
}

seed();

// テンプレートは既存DBにも(初回のみ)用意する
{
  const templateCount = db.prepare('SELECT COUNT(*) AS n FROM prompt_templates').get().n;
  if (templateCount === 0) {
    const insTemplate = db.prepare('INSERT INTO prompt_templates (label, prompt, position) VALUES (?, ?, ?)');
    insTemplate.run(
      '議事録を作成',
      '以下の会議メモから、日時・参加者・議題・決定事項・次のアクションをまとめた議事録を作成してください。\n\n[ここに会議メモを貼り付けてください]',
      0
    );
    insTemplate.run(
      '画像作成',
      'このチャットでは画像生成をお願いします。\n' +
        '画像生成にはChatGPTの画像生成機能を使用してください。\n\n' +
        '生成前に以下を確認してください。\n\n' +
        '1. 用途・シーン\n' +
        '2. テイスト(リアル/イラスト/ポップ/シンプルなど)\n' +
        '3. 入れたい要素・色\n' +
        '4. 縦横比(正方形/横長/縦長)\n\n' +
        '確認したら、まず画像案を出してください。\n' +
        'OKなら生成してください。\n' +
        '気に入らなければ「こうして」で修正します。\n\n' +
        '文字・ロゴ・ラベルについて:\n' +
        '・画像内の文字は勝手に生成・修正しないでください\n' +
        '・日本語が必要な場合は明示的に指定します\n' +
        '・商品ラベル・看板・ロゴ等の文字は、意図的に省略するかぼかしてください',
      1
    );
  }
}

module.exports = { db, hashPassword, verifyPassword, currentMonth, DATA_DIR };
