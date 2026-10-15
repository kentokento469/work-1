/**
 * 郵便番号データ (日本郵便 KEN_ALL を整形した jp-postal パッケージ) から、
 * 郵便番号の先頭3桁ごとの小さな JSON (public/vendor/postal/XXX.json) を生成する。
 * - WorkCore 自身から配信するため、住所検索で外部サービスに郵便番号を送らない (オフラインでも可)
 * - 郵便番号データは日本郵便が「著作権を主張しません。自由に配布していただいて結構です」としている
 *   (https://www.post.japanpost.jp/zipcode/download.html)
 * 町域の「以下に掲載がない場合」「（次のビルを除く）」などの注記は、住所欄に入れないよう除去する。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'vendor', 'postal');
const stamp = join(out, '_version.json');
const pkg = JSON.parse(readFileSync(join(root, 'node_modules', 'jp-postal', 'package.json'), 'utf8'));
if (existsSync(stamp) && JSON.parse(readFileSync(stamp, 'utf8')).source === `jp-postal@${pkg.version}`) {
  console.log('[build-postal-data] 最新 → public/vendor/postal');
  process.exit(0);
}

export const PREFS = ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'];

/** 町域の注記を除いて、住所欄にそのまま入れられる形にする */
function cleanTown(t) {
  if (/以下に掲載がない場合|の次に番地がくる場合/.test(t)) return '';
  if (/^(.+?[町村])一円$/.test(t) && !/^一円$/.test(t)) return '';
  return t.replace(/（.*?）|\(.*?\)/g, '').replace(/（.*$/, '').trim();
}

const { default: data } = await import(join(root, 'node_modules', 'jp-postal', 'index.mjs'));
const groups = new Map();
let n = 0;
for (const [zip, rows] of Object.entries(data)) {
  if (!/^\d{7}$/.test(zip)) continue;
  const seen = new Set();
  const list = [];
  for (const [pref, city, town] of rows) {
    const p = PREFS.indexOf(pref);
    if (p < 0) throw new Error(`都道府県が不明: ${pref} (${zip})`);
    const t = cleanTown(town);
    const key = `${p}|${city}|${t}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push([p, city, t]);
  }
  const g = zip.slice(0, 3);
  if (!groups.has(g)) groups.set(g, {});
  groups.get(g)[zip.slice(3)] = list;
  n++;
}
mkdirSync(out, { recursive: true });
for (const [g, obj] of groups) writeFileSync(join(out, `${g}.json`), JSON.stringify(obj));
writeFileSync(stamp, JSON.stringify({ source: `jp-postal@${pkg.version}`, codes: n, files: groups.size, generatedAt: new Date().toISOString() }));
console.log(`[build-postal-data] 郵便番号 ${n}件 → ${groups.size}ファイル (public/vendor/postal)`);
