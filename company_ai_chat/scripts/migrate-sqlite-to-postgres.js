#!/usr/bin/env node
// 既存のSQLiteデータを、DATABASE_URLで指定したNeon/PostgreSQLへ一度だけ移行する。
'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { db, DATA_DIR } = require('../lib/db');

const sourcePath = process.env.SOURCE_DB || path.join(DATA_DIR, 'app.db');
const source = new DatabaseSync(sourcePath);
const tables = [
  ['departments', ['id', 'name', 'monthly_budget_jpy', 'unlock_month', 'advance_used', 'advance_month', 'created_at']],
  ['users', ['id', 'username', 'display_name', 'password_hash', 'role', 'department_id', 'disabled', 'created_at', 'google_sub', 'email', 'status', 'requested_name', 'requested_department']],
  ['sessions', ['token', 'user_id', 'expires_at']],
  ['projects', ['id', 'user_id', 'name', 'created_at']],
  ['conversations', ['id', 'user_id', 'title', 'pinned', 'archived', 'project_id', 'created_at', 'updated_at']],
  ['messages', ['id', 'conversation_id', 'role', 'content', 'model', 'created_at']],
  ['usage_log', ['id', 'user_id', 'department_id', 'model', 'kind', 'prompt_tokens', 'completion_tokens', 'cost_jpy', 'created_at']],
  ['classifications', ['id', 'user_id', 'department_id', 'label', 'created_at']],
  ['warnings', ['id', 'user_id', 'type', 'message', 'month', 'acknowledged', 'created_at']],
  ['prompt_templates', ['id', 'user_id', 'label', 'prompt', 'position', 'created_at', 'updated_at']],
];

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  await db.ready;
  for (const [table, columns] of tables) {
    const rows = source.prepare(`SELECT ${columns.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(table)}`).all();
    for (const row of rows) {
      const names = columns.map(quoteIdentifier).join(', ');
      // db adapterの ? 置換を使うため、値の位置だけ ? に戻す。
      await db.prepare(`INSERT INTO ${quoteIdentifier(table)} (${names}) VALUES (${columns.map(() => '?').join(', ')})`)
        .run(...columns.map((column) => row[column]));
    }
    if (table !== 'sessions') {
      const max = (await db.prepare(`SELECT COALESCE(MAX(id), 0) AS max_id FROM ${quoteIdentifier(table)}`).get()).max_id;
      await db.exec(`ALTER TABLE ${quoteIdentifier(table)} ALTER COLUMN id RESTART WITH ${Math.max(1, Number(max) + 1)}`);
    }
    console.log(`${table}: ${rows.length} rows`);
  }
  await db.exec("DELETE FROM sessions WHERE expires_at < CURRENT_TIMESTAMP");
  console.log('SQLite to PostgreSQL migration completed.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
