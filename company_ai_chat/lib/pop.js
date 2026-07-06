// POP作成ツール — AIを使わず、実際の商品写真+指定テキストをSVGで確実に合成する。
// 「価格が消える/商品が別物になる」というAI生成の不確実性を避けるための、非AIな代替手段。
'use strict';

const COLORS = {
  pink:   { bg: '#fde2e4', accent: '#e83e8c' },
  yellow: { bg: '#fff3cd', accent: '#d9822b' },
  blue:   { bg: '#dbeafe', accent: '#2563eb' },
  green:  { bg: '#dcfce7', accent: '#16a34a' },
  purple: { bg: '#ede9fe', accent: '#7c3aed' },
};

const ASPECTS = {
  square:    { w: 900, h: 900 },
  landscape: { w: 1200, h: 800 },
  portrait:  { w: 800, h: 1200 },
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 商品写真+見出し+価格をPOP風に合成したSVGを組み立てる(AIを使わないため確実に同じ結果になる)
function buildPopSvg({ photoBuffer, photoMime, headline, price, color, aspect }) {
  const { bg, accent } = COLORS[color] || COLORS.pink;
  const { w, h } = ASPECTS[aspect] || ASPECTS.square;
  const pad = Math.round(w * 0.06);
  const photoX = pad;
  const photoY = Math.round(h * 0.16);
  const photoW = w - pad * 2;
  const photoH = h - photoY - Math.round(h * 0.22);
  const photoB64 = photoBuffer.toString('base64');
  const headlineText = esc(String(headline).slice(0, 20));
  const priceText = esc(String(price).slice(0, 20));
  const ribbonW = Math.min(w - pad, headlineText.length * (w * 0.042) + 90);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <rect width="${w}" height="${h}" fill="${bg}"/>
    <clipPath id="photoClip"><rect x="${photoX}" y="${photoY}" width="${photoW}" height="${photoH}" rx="20"/></clipPath>
    <image href="data:${photoMime};base64,${photoB64}" x="${photoX}" y="${photoY}" width="${photoW}" height="${photoH}"
      preserveAspectRatio="xMidYMid slice" clip-path="url(#photoClip)"/>
    <rect x="${photoX}" y="${photoY}" width="${photoW}" height="${photoH}" rx="20" fill="none" stroke="#ffffff" stroke-width="6"/>
    <path d="M0,${Math.round(h * 0.04)} h${ribbonW} l-24,28 l24,28 h-${ribbonW} z" fill="${accent}"/>
    <text x="24" y="${Math.round(h * 0.04) + 38}" font-size="${Math.round(w * 0.038)}" font-weight="700" fill="#ffffff"
      font-family="sans-serif">${headlineText}</text>
    <rect x="${pad}" y="${h - Math.round(h * 0.15)}" width="${w - pad * 2}" height="${Math.round(h * 0.11)}" rx="16" fill="#ffffff"/>
    <text x="${w / 2}" y="${h - Math.round(h * 0.15) + Math.round(h * 0.08)}" text-anchor="middle"
      font-size="${Math.round(w * 0.07)}" font-weight="700" fill="${accent}" font-family="sans-serif">${priceText}</text>
  </svg>`;
}

module.exports = { buildPopSvg, COLORS: Object.keys(COLORS), ASPECTS: Object.keys(ASPECTS) };
