// OpenAI API 呼び出し(ストリーミング / 分類)とコスト計算。
// OPENAI_API_KEY 未設定時はモックモードで動作する(動作確認用)。
'use strict';

const API_KEY = process.env.OPENAI_API_KEY || '';
const API_BASE = process.env.OPENAI_API_BASE || 'https://api.openai.com/v1';
const CHAT_MODEL = process.env.CHAT_MODEL || 'gpt-4o-mini';
const CLASSIFIER_MODEL = process.env.CLASSIFIER_MODEL || 'gpt-4o-mini';
const USD_JPY = Number(process.env.USD_JPY || 150);
const MOCK = !API_KEY;

// USD / 100万トークン。必要に応じて追記する。
const PRICING = {
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
async function streamChat(history, onDelta) {
  if (MOCK) return mockStream(history, onDelta);

  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
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
    model: CHAT_MODEL,
    promptTokens: usage?.prompt_tokens ?? estimateTokens(history),
    completionTokens: usage?.completion_tokens ?? Math.ceil(content.length / 3),
  };
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

async function mockStream(history, onDelta) {
  const last = history[history.length - 1]?.content || '';
  const reply =
    `(モック応答)「${last.slice(0, 40)}」を受け取りました。` +
    'OPENAI_API_KEY を設定すると実際のモデルが応答します。';
  for (const ch of reply) {
    onDelta(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
  return {
    content: reply,
    model: 'mock',
    promptTokens: estimateTokens(history),
    completionTokens: Math.ceil(reply.length / 3),
  };
}

const PRIVATE_HINTS = ['旅行', '趣味', 'ゲーム', '恋愛', 'レシピ', '映画', '週末', 'プレゼント', '子供', '健康'];
function mockClassify(text) {
  const label = PRIVATE_HINTS.some((w) => text.includes(w)) ? 'private' : 'work';
  return { label, model: 'mock', promptTokens: 0, completionTokens: 0 };
}

module.exports = { streamChat, classify, costJpy, estimateTokens, CHAT_MODEL, CLASSIFIER_MODEL, MOCK, USD_JPY };
