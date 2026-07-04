// OpenAI API 呼び出し(ストリーミング / 分類)とコスト計算。
// OPENAI_API_KEY 未設定時はモックモードで動作する(動作確認用)。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DATA_DIR } = require('./db');

const API_KEY = process.env.OPENAI_API_KEY || '';
const API_BASE = process.env.OPENAI_API_BASE || 'https://api.openai.com/v1';
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

// 添付画像(/api/files/... のmarkdown参照)を含むユーザー発言を、
// OpenAIのマルチモーダル形式(text + image_url)に変換する。
const ATTACHED_IMG_RE = /!\[[^\]]*\]\((\/api\/files\/[a-f0-9]{16,32}\.(?:png|jpg|jpeg|webp|gif))\)/g;
const ATTACH_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
function toApiMessages(history) {
  return history.map((m) => {
    if (m.role !== 'user' || !String(m.content).includes('/api/files/')) return m;
    const refs = [...String(m.content).matchAll(ATTACHED_IMG_RE)];
    if (refs.length === 0) return m;
    const parts = [];
    const text = String(m.content).replace(ATTACHED_IMG_RE, '').trim();
    if (text) parts.push({ type: 'text', text });
    for (const r of refs.slice(0, 4)) { // コスト対策で1メッセージ4枚まで
      const file = r[1].split('/').pop();
      try {
        const data = fs.readFileSync(path.join(IMAGES_DIR, file));
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${ATTACH_MIME[file.split('.').pop()]};base64,${data.toString('base64')}` },
        });
      } catch { /* ファイルが消えていたらテキストのみで続行 */ }
    }
    return parts.length ? { role: 'user', content: parts } : m;
  });
}

// チャット補完をストリーミングで実行する。
// onDelta(text) がトークンごとに呼ばれ、完了時に { content, promptTokens, completionTokens, model } を返す。
async function streamChat(history, onDelta, model = LIGHT_MODEL, signal) {
  if (MOCK) return mockStream(history, onDelta, model, signal);

  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...toApiMessages(history)],
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal,
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

// gpt-5系・o系は temperature 指定と max_tokens を受け付けない(既定値+max_completion_tokens を使う)
function classifierParams(maxTokens) {
  const params = { max_completion_tokens: maxTokens };
  if (!/^(gpt-5|o\d)/.test(CLASSIFIER_MODEL)) params.temperature = 0;
  return params;
}

// ---- 画像生成 ----

// 会話中で決まった縦横比(正方形/横長/縦長)をAPIのsizeパラメータに反映する。
// 未指定なら正方形のまま。
function pickImageSize(prompt) {
  const isDalle3 = /dall-e-3/i.test(IMAGE_MODEL);
  if (/横長|横向き|ランドスケープ|landscape|名刺.*横|横.*名刺/i.test(prompt)) {
    return isDalle3 ? '1792x1024' : '1536x1024';
  }
  if (/縦長|縦向き|ポートレート|portrait|名刺.*縦|縦.*名刺/i.test(prompt)) {
    return isDalle3 ? '1024x1792' : '1024x1536';
  }
  return '1024x1024';
}

// dall-e-3はプロンプト4000文字までだが、gpt-image-1はもっと長く受け付けられる。
// 超過時は「直近の合意内容」を残すため末尾側を優先して切り詰める(先頭切り詰めだと
// 会話の最後に決まった具体的な要件が消えてしまう)。
function truncatePrompt(prompt) {
  const limit = /dall-e-3/i.test(IMAGE_MODEL) ? 4000 : 32000;
  return prompt.length > limit ? prompt.slice(-limit) : prompt;
}

async function generateImage(prompt) {
  if (MOCK) return mockImage(prompt);
  // 会話の書き起こしをそのまま渡すと、画像生成モデルが雑談部分を絵に描こうとしたり
  // 要件を読み違えたりするため、「会話の最終合意内容を1枚の画像にする」ことを明示する
  const finalPrompt =
    '以下はユーザーとアシスタントが画像の内容を相談した会話です。会話全体を踏まえて、' +
    '最後に合意された内容の画像を1枚生成してください。会話文自体を画像内の文字として描画しないでください。\n\n' +
    truncatePrompt(prompt);
  const res = await fetch(`${API_BASE}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: IMAGE_MODEL, prompt: finalPrompt, size: pickImageSize(prompt) }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`image API error ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  // gpt-image-1 は b64_json、dall-e-3 など URL 応答のモデルにも対応する
  const item = json.data?.[0] || {};
  let buf;
  if (item.b64_json) {
    buf = Buffer.from(item.b64_json, 'base64');
  } else if (item.url) {
    const imgRes = await fetch(item.url);
    if (!imgRes.ok) throw new Error(`image download failed ${imgRes.status}`);
    buf = Buffer.from(await imgRes.arrayBuffer());
  } else {
    throw new Error('no image in response');
  }
  const file = `${crypto.randomBytes(12).toString('hex')}.png`;
  fs.writeFileSync(path.join(IMAGES_DIR, file), buf);
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
        ...classifierParams(8),
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
  return Math.ceil(history.reduce((n, m) => n + String(m.content).length, 0) / 3);
}

// ---- モックモード(APIキーなしでの動作確認用) ----

async function mockStream(history, onDelta, model = LIGHT_MODEL, signal) {
  const last = history[history.length - 1]?.content || '';
  const reply =
    `(モック応答 / ${model})「${last.slice(0, 40)}」を受け取りました。` +
    'OPENAI_API_KEY を設定すると実際のモデルが応答します。';
  for (const ch of reply) {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
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
  streamChat, classify, costJpy, estimateTokens, generateImage,
  CLASSIFIER_MODEL, LIGHT_MODEL, HEAVY_MODEL, IMAGE_MODEL, IMAGES_DIR, MOCK, USD_JPY,
};
