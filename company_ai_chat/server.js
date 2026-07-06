#!/usr/bin/env node
// 社内AIチャット — エントリポイント
// 使い方: OPENAI_API_KEY=sk-... node server.js
'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const routes = require('./lib/routes');
const { MOCK, LIGHT_MODEL, HEAVY_MODEL, IMAGE_MODEL } = require('./lib/openai');

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA なので不明なパスは index.html にフォールバック
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, html) => {
        if (err2) return res.writeHead(404).end('not found');
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' }).end(html);
      });
      return;
    }
    // デプロイのたびに更新されるアプリ本体なので、CDN/ブラウザに古い版を
    // 長時間キャッシュされないよう明示的に no-cache を指定する。
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    }).end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    const handled = await routes.handle(req, res, req.method, url.pathname, url);
    if (!handled) serveStatic(res, url.pathname);
  } catch (err) {
    console.error('[server]', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ error: 'サーバーエラーが発生しました' }));
  }
});

server.listen(PORT, () => {
  console.log(`社内AIチャット: http://localhost:${PORT}`);
  console.log(MOCK
    ? '⚠ OPENAI_API_KEY が未設定のためモックモードで起動しました(応答はダミーです)'
    : `モデル: 軽量=${LIGHT_MODEL} / 高性能=${HEAVY_MODEL} / 画像=${IMAGE_MODEL}`);
});
