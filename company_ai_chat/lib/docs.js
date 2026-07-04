// PDF・Word・Excelの添付ファイルからテキストを抽出する。
// (txt/md/csv等のプレーンテキスト系はブラウザ側でそのまま読めるため対象外)
//
// PDFは pdf-parse ではなく unpdf を使う。pdf-parse は @napi-rs/canvas
// (プラットフォーム別のネイティブバイナリ)を必須依存として引き込んでしまい、
// このアプリのDocker本番環境(node:22-alpine / musl libc)で動く保証がないため。
// unpdf はcanvas無しのNode/サーバー環境向けに作られたpdf.jsラッパーで、
// テキスト抽出だけなら純JSで完結する。
'use strict';

const { getDocumentProxy, extractText } = require('unpdf');
const mammoth = require('mammoth');
const XLSX = require('xlsx');

const DOC_EXT_RE = /\.(pdf|docx|xlsx|xls)$/i;

async function extractPdf(buffer) {
  const doc = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(doc, { mergePages: true });
  return text.trim();
}

async function extractDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return result.value.trim();
}

function extractSpreadsheet(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  return wb.SheetNames
    .map((name) => `[シート: ${name}]\n${XLSX.utils.sheet_to_csv(wb.Sheets[name])}`)
    .join('\n\n')
    .trim();
}

// 拡張子に応じてテキストを抽出する。極端に長い文書はコスト対策で切り詰める。
async function extractDocText(name, buffer) {
  const ext = String(name).toLowerCase().match(DOC_EXT_RE)?.[1];
  if (!ext) throw new Error(`unsupported extension: ${name}`);
  const text = ext === 'pdf' ? await extractPdf(buffer)
    : ext === 'docx' ? await extractDocx(buffer)
    : extractSpreadsheet(buffer);
  return text.slice(0, 50_000);
}

module.exports = { extractDocText, DOC_EXT_RE };
