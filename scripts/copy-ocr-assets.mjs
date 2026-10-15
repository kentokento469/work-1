/**
 * OCR・PDF処理に必要なファイルを node_modules から public/vendor/ にコピーする。
 * 外部CDNに依存せず、WorkCore と同じ場所 (GitHub Pages) から配信するため。
 * public/vendor/ は生成物なので git には含めない (.gitignore)。npm run dev / build の前に自動実行される。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = (p) => join(root, 'node_modules', p);
const out = join(root, 'public', 'vendor');

const files = [
  ['tesseract.js/dist/worker.min.js', 'ocr/worker.min.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'ocr/tesseract-core-simd-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-lstm.wasm.js', 'ocr/tesseract-core-lstm.wasm.js'],
  // 高速・小容量の best_int モデル (日本語 約2MB・英語 約3MB)
  ['@tesseract.js-data/jpn/4.0.0_best_int/jpn.traineddata.gz', 'ocr/lang/jpn.traineddata.gz'],
  ['@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'ocr/lang/eng.traineddata.gz'],
  ['pdfjs-dist/legacy/build/pdf.worker.min.mjs', 'pdfjs/pdf.worker.min.mjs'],
];
const dirs = [
  ['pdfjs-dist/cmaps', 'pdfjs/cmaps'],
  ['pdfjs-dist/standard_fonts', 'pdfjs/standard_fonts'],
];

let copied = 0;
for (const [from, to] of files) {
  const src = nm(from);
  const dst = join(out, to);
  if (!existsSync(src)) throw new Error(`見つかりません: ${src}（npm install を実行してください）`);
  if (existsSync(dst) && (to === 'ocr/worker.min.js' || statSync(dst).size === statSync(src).size)) continue;
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst);
  copied++;
}
for (const [from, to] of dirs) {
  const dst = join(out, to);
  if (existsSync(dst)) continue;
  cpSync(nm(from), dst, { recursive: true });
  copied++;
}
/*
 * tesseract.js 7.0.0 の不具合の回避:
 * 言語データを { code, data } で直接渡すと、初期化時に言語名として data (バイト列) を使ってしまい失敗する
 * (src/worker-script/index.js の initialize: `l.data` → 正しくは `l.code`)。
 * WorkCore は言語データを端末のキャッシュから渡すため、配信用のコピーだけをこの1か所修正する。
 */
const workerPath = join(out, 'ocr/worker.min.js');
const BUG = '"string"==typeof t?t:t.data})).join("+")';
const FIX = '"string"==typeof t?t:t.code})).join("+")';
const w = readFileSync(workerPath, 'utf8');
if (w.includes(BUG)) {
  writeFileSync(workerPath, w.replace(BUG, FIX));
  copied++;
} else if (!w.includes(FIX)) throw new Error('tesseract.js の worker の構成が想定と異なります（バージョンを確認してください）');

console.log(`[copy-ocr-assets] ${copied ? `${copied}件をコピー` : '最新'} → public/vendor`);
