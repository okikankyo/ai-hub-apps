// OpenAI API 呼び出し(ストリーミング / 分類)とコスト計算。
// OPENAI_API_KEY 未設定時はモックモードで動作する(動作確認用)。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DATA_DIR } = require('./db');

const API_KEY = process.env.OPENAI_API_KEY || '';
const API_BASE = process.env.OPENAI_API_BASE || 'https://api.openai.com/v1';
const CHAT_MODEL = process.env.CHAT_MODEL || 'gpt-4o-mini';
const CLASSIFIER_MODEL = process.env.CLASSIFIER_MODEL || 'gpt-4o-mini';
const USD_JPY = Number(process.env.USD_JPY || 150);
const MOCK = !API_KEY;

// ルーティング先モデル(環境変数で差し替え可能)
const LIGHT_MODEL = process.env.ROUTER_LIGHT_MODEL || 'gpt-5-mini';   // 軽いタスク用
const HEAVY_MODEL = process.env.ROUTER_HEAVY_MODEL || 'gpt-5';        // 高度なタスク用
const IMAGE_MODEL = process.env.IMAGE_MODEL || 'gpt-image-1';         // 画像生成用
const IMAGE_COST_JPY = Number(process.env.IMAGE_COST_JPY || 6);       // 画像1枚の概算コスト(円)

const IMAGES_DIR = path.join(DATA_DIR, 'images');
fs.mkdirSync(IMAGES_DIR, { recursive: true });

// USD / 100万トークン。必要に応じて追記する。
const PRICING = {
  'gpt-5':         { input: 1.25, output: 10 },
  'gpt-5-mini':    { input: 0.25, output: 2 },
  'gpt-5-nano':    { input: 0.05, output: 0.4 },
  'gpt-5.1':       { input: 1.25, output: 10 },
  'gpt-4o':        { input: 2.5,  output: 10 },
  'gpt-4o-mini':   { input: 0.15, output: 0.6 },
  'gpt-4.1':       { input: 2.0,  output: 8 },
  'gpt-4.1-mini':  { input: 0.4,  output: 1.6 },
  'gpt-4.1-nano':  { input: 0.1,  output: 0.4 },
};
const DEFAULT_PRICE = { input: 2.5, output: 10 };

function costJpy(model, promptTokens, completionTokens) {
  const p = PRICING[model] || DEFAULT_PRICE;
  const usd = (promptTokens * p.input + completionTokens * p.output) / 1e6;
  return usd * USD_JPY;
}

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  'あなたは社内向けAIアシスタントです。丁寧な日本語で、簡潔かつ正確に回答してください。';

// チャット補完をストリーミングで実行する。
// onDelta(text) がトークンごとに呼ばれ、完了時に { content, promptTokens, completionTokens, model } を返す。
async function streamChat(history, onDelta, model = CHAT_MODEL) {
  if (MOCK) return mockStream(history, onDelta, model);

  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI API error ${res.status}: ${body.slice(0, 500)}`);
  }

  let content = '';
  let usage = null;
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let json;
      try { json = JSON.parse(data); } catch { continue; }
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) {
        content += delta;
        onDelta(delta);
      }
      if (json.usage) usage = json.usage;
    }
  }
  return {
    content,
    model,
    promptTokens: usage?.prompt_tokens ?? estimateTokens(history),
    completionTokens: usage?.completion_tokens ?? Math.ceil(content.length / 3),
  };
}

// ---- ルーティング ----
// メッセージ内容から利用モデルを自動選択する。
//   light:     軽い質問・言い換え・SNS文案・メール返信案・チェック・項目整理・画像プロンプト整理
//   heavy:     仕様整理・bot設計・指示書・バグ調査・DB設計・セキュリティ
//   image:     実際の画像生成
//   sensitive: 送信・削除・金額・個人情報 → heavy モデル + 実行前に人間確認

const ROUTER_PROMPT =
  '社内チャットツールのモデルルーターです。ユーザーのメッセージを次の4分類のうち1つに分類し、' +
  '分類名だけを answer してください。\n' +
  'light: 軽い質問、言い換え、SNS文案、メール返信案、文章チェック、項目の整理、画像生成プロンプトの文章化・整理\n' +
  'heavy: 仕様の整理、bot・システムの設計、開発指示書の作成、バグ・不具合の調査、データベース設計、セキュリティに関わる相談\n' +
  'image: 画像・イラスト・ロゴ・写真などを実際に生成してほしい依頼\n' +
  'sensitive: メール送信やデータ削除など実行を伴う操作、金額・支払い・請求に関わるもの、個人情報を含む・扱うもの\n' +
  '回答は light / heavy / image / sensitive のいずれか1語のみ。';

function modelFor(category) {
  if (category === 'heavy' || category === 'sensitive') return HEAVY_MODEL;
  if (category === 'image') return IMAGE_MODEL;
  return LIGHT_MODEL;
}

async function routeMessage(text) {
  if (MOCK) return mockRoute(text);
  try {
    const res = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: CLASSIFIER_MODEL,
        temperature: 0,
        max_tokens: 5,
        messages: [
          { role: 'system', content: ROUTER_PROMPT },
          { role: 'user', content: text.slice(0, 2000) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`router HTTP ${res.status}`);
    const json = await res.json();
    const answer = (json.choices?.[0]?.message?.content || '').toLowerCase();
    const category = ['sensitive', 'image', 'heavy', 'light'].find((c) => answer.includes(c)) || 'light';
    return {
      category,
      model: modelFor(category),
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
    };
  } catch (err) {
    console.error('[router]', err.message);
    // ルーター障害時は安全側(軽量モデル)に倒す
    return { category: 'light', model: LIGHT_MODEL, promptTokens: 0, completionTokens: 0 };
  }
}

// ---- 画像生成 ----

async function generateImage(prompt) {
  if (MOCK) return mockImage(prompt);
  const res = await fetch(`${API_BASE}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: IMAGE_MODEL, prompt: prompt.slice(0, 4000), size: '1024x1024' }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`image API error ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) throw new Error('no image in response');
  const file = `${crypto.randomBytes(12).toString('hex')}.png`;
  fs.writeFileSync(path.join(IMAGES_DIR, file), Buffer.from(b64, 'base64'));
  return { file, model: IMAGE_MODEL, costJpy: IMAGE_COST_JPY };
}

// ユーザー発言が仕事かプライベートかを判定する。ラベルのみ返す。
async function classify(text) {
  if (MOCK) return mockClassify(text);
  try {
    const res = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: CLASSIFIER_MODEL,
        temperature: 0,
        max_tokens: 3,
        messages: [
          {
            role: 'system',
            content:
              '社内チャットツールの利用分析を行います。次のメッセージが業務利用なら "work"、' +
              '私的利用(趣味・娯楽・私生活の相談など)なら "private" とだけ答えてください。' +
              '判断できない場合は "work" と答えてください。',
          },
          { role: 'user', content: text.slice(0, 2000) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`classify HTTP ${res.status}`);
    const json = await res.json();
    const answer = (json.choices?.[0]?.message?.content || '').toLowerCase();
    const label = answer.includes('private') ? 'private' : answer.includes('work') ? 'work' : 'unknown';
    return {
      label,
      model: CLASSIFIER_MODEL,
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
    };
  } catch (err) {
    console.error('[classify]', err.message);
    return { label: 'unknown', model: CLASSIFIER_MODEL, promptTokens: 0, completionTokens: 0 };
  }
}

function estimateTokens(history) {
  return Math.ceil(history.reduce((n, m) => n + m.content.length, 0) / 3);
}

// ---- モックモード(APIキーなしでの動作確認用) ----

async function mockStream(history, onDelta, model = CHAT_MODEL) {
  const last = history[history.length - 1]?.content || '';
  const reply =
    `(モック応答 / ${model})「${last.slice(0, 40)}」を受け取りました。` +
    'OPENAI_API_KEY を設定すると実際のモデルが応答します。';
  for (const ch of reply) {
    onDelta(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
  return {
    content: reply,
    model,
    promptTokens: estimateTokens(history),
    completionTokens: Math.ceil(reply.length / 3),
  };
}

function mockRoute(text) {
  let category = 'light';
  if (/送信|削除|支払|振込|請求|金額|個人情報|マイナンバー|パスワード|住所|電話番号/.test(text)) {
    category = 'sensitive';
  } else if (/(画像|イラスト|ロゴ|写真)[^。]*(生成|作成|作って|描いて)|(生成|作って|描いて)[^。]*(画像|イラスト|ロゴ)/.test(text)) {
    category = 'image';
  } else if (/バグ|不具合|設計|セキュリティ|仕様|データベース|DB|指示書|アーキテクチャ/.test(text)) {
    category = 'heavy';
  }
  return { category, model: modelFor(category), promptTokens: 0, completionTokens: 0 };
}

function mockImage(prompt) {
  const file = `${crypto.randomBytes(12).toString('hex')}.svg`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
    <rect width="512" height="512" fill="#86b6ef"/>
    <text x="256" y="230" font-size="28" text-anchor="middle" fill="#0d366b" font-family="sans-serif">モック生成画像</text>
    <text x="256" y="280" font-size="16" text-anchor="middle" fill="#104281" font-family="sans-serif">${
      prompt.slice(0, 24).replace(/[<>&"]/g, '')}</text>
  </svg>`;
  fs.writeFileSync(path.join(IMAGES_DIR, file), svg);
  return { file, model: 'mock-image', costJpy: 0 };
}

const PRIVATE_HINTS = ['旅行', '趣味', 'ゲーム', '恋愛', 'レシピ', '映画', '週末', 'プレゼント', '子供', '健康'];
function mockClassify(text) {
  const label = PRIVATE_HINTS.some((w) => text.includes(w)) ? 'private' : 'work';
  return { label, model: 'mock', promptTokens: 0, completionTokens: 0 };
}

module.exports = {
  streamChat, classify, costJpy, estimateTokens, routeMessage, generateImage,
  CHAT_MODEL, CLASSIFIER_MODEL, LIGHT_MODEL, HEAVY_MODEL, IMAGE_MODEL, IMAGES_DIR, MOCK, USD_JPY,
};
