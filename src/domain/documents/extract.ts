/**
 * OCR・PDFテキストから書類の項目を取り出す (純粋関数・UI非依存)。
 *
 * 方針
 * - 読み取れなかった項目は空のままにし、推測で補完しない
 * - 値ごとに「抽出元の行」「確実性」「理由」を残し、確認画面で根拠を見せる
 * - 確実性 (ラベルと形式の一致・検算) と OCR の文字認識信頼度は別に扱う。
 *   文字認識の信頼度が低い行から取った値は、ラベルが一致していても「要確認」に下げる
 */
import { isValidISODate } from '../date';
import type { Certainty, DocumentLine, DocumentType, FieldExtraction, FieldKey, TaxLine } from './types';

export interface SourceLine {
  text: string;
  /** OCR の行の信頼度 (0-100)。PDFテキストなら null */
  confidence: number | null;
}
export interface SourcePage {
  page: number;
  lines: SourceLine[];
}

export interface ExtractionResult {
  type: DocumentType;
  typeReason: string;
  fields: Partial<Record<FieldKey, FieldExtraction>>;
  lines: DocumentLine[];
  taxLines: TaxLine[];
}

/** OCR の行信頼度がこれ未満なら、値は「要確認」にする */
export const LOW_OCR_CONFIDENCE = 70;

// ---------------------------------------------------------------------------
// 正規化
// ---------------------------------------------------------------------------

const CJK = '\\u3000-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uff66-\\uff9f';
const CJK_GAP = new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, 'g');

/** 全角英数→半角、OCRが入れる日本語文字間の空白を除去、円記号の揺れを統一 */
const HAS_CJK = new RegExp(`[${CJK}]`);
const SINGLE_CJK = new RegExp(`^[${CJK}]$`);

/**
 * OCR は日本語の1文字ごとに空白を入れることがある（「領 収 書」）。
 * 1文字の語が半分以上を占める行だけ空白を詰め、「佐藤 健一」のような意図的な空白は残す
 */
function collapseCjkGaps(s: string): string {
  const cjkTokens = s.split(/\s+/).filter((t) => HAS_CJK.test(t));
  const singles = cjkTokens.filter((t) => SINGLE_CJK.test(t)).length;
  return cjkTokens.length >= 2 && singles / cjkTokens.length >= 0.5 ? s.replace(CJK_GAP, '$1') : s;
}

export function normalizeText(s: string): string {
  return collapseCjkGaps(
    s
      .normalize('NFKC')
      .replace(/[‐-―−ー](?=\d)/g, '-') // 数字前の長音・ダッシュ類
      .replace(/[\\￥]/g, '¥'),
  )
    .replace(/(\d)\s*,\s*(?=\d{3}\b)/g, '$1,')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// 値の解析 (確認画面の入力チェックでも使う)
// ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0');
function toIso(y: number, m: number, d: number): string | null {
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  return y >= 1990 && y <= 2100 && isValidISODate(iso) ? iso : null;
}

const ERA: Record<string, number> = { 令和: 2018, R: 2018, 平成: 1988, H: 1988 };

/** 行に含まれる日付をすべて ISO 形式で返す (存在しない日付は除外) */
export function findDates(text: string): string[] {
  const s = normalizeText(text);
  const out: string[] = [];
  const re = /(?:(令和|平成|R|H)\s*(元|\d{1,2})\s*[年./]\s*(\d{1,2})\s*[月./]\s*(\d{1,2})|(\d{4})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2}))\s*日?/g;
  for (const m of s.matchAll(re)) {
    let iso: string | null;
    if (m[1]) iso = toIso(ERA[m[1]]! + (m[2] === '元' ? 1 : Number(m[2])), Number(m[3]), Number(m[4]));
    else iso = toIso(Number(m[5]), Number(m[6]), Number(m[7]));
    if (iso) out.push(iso);
  }
  return out;
}

/** 入力欄の日付を正規化。解釈できなければ null */
export function parseDateInput(v: string): string | null {
  const t = v.trim();
  if (!t) return null;
  if (isValidISODate(t)) return t;
  return findDates(t)[0] ?? null;
}

/** 行に含まれる金額 (円) をすべて返す。カンマ区切り・¥・円 に対応 */
export function findAmounts(text: string): number[] {
  const s = normalizeText(text).replace(/(\d{1,2})\s*%/g, ' '); // 税率は金額にしない
  const out: number[] = [];
  for (const m of s.matchAll(/(?<![\d.])[¥]?\s*(\d{1,3}(?:,\d{3})+|\d+)(?![\d.,]*\s*(?:個|台|本|冊|枚|件|点|箱|式|セット|ケース|名|年|月|日|時|分))\s*(円|-)?/g)) {
    const n = Number(m[1]!.replace(/,/g, ''));
    if (Number.isSafeInteger(n)) out.push(n);
  }
  return out;
}

/** 入力欄の金額を正規化 (「¥12,345」「12345円」→ 12345)。解釈できなければ null */
export function parseAmountInput(v: string): number | null {
  const t = normalizeText(v).replace(/[¥円,\s-]/g, '');
  if (!t) return null;
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

export function findRegistrationNumber(text: string): string | null {
  const s = normalizeText(text).replace(/(?<=T[\d\s-]*)[\s-](?=[\d\s-]*\d)/g, '');
  const m = s.match(/T(\d{13})(?!\d)/);
  return m ? `T${m[1]}` : null;
}

export function isRegistrationNumber(v: string): boolean {
  return /^T\d{13}$/.test(v.trim());
}

// ---------------------------------------------------------------------------
// 抽出
// ---------------------------------------------------------------------------

interface Line {
  text: string; // 正規化済み
  raw: string;
  page: number;
  index: number; // 全体での行番号
  confidence: number | null;
}

const TYPE_RULES: { type: DocumentType; re: RegExp; label: string }[] = [
  { type: 'receipt', re: /領\s*収\s*[書証]|レシート/, label: '領収書' },
  { type: 'delivery', re: /納\s*品\s*書|納品明細/, label: '納品書' },
  { type: 'quote', re: /見\s*積\s*書|御見積/, label: '見積書' },
  { type: 'invoice', re: /請\s*求\s*書|御請求|ご請求/, label: '請求書' },
  { type: 'application', re: /申\s*請\s*書|届出書|申込書|^.{0,12}届$/, label: '申請書' },
];

const COMPANY = /(株式会社|有限会社|合同会社|合資会社|一般社団法人|一般財団法人|\(株\)|\(有\)|㈱|㈲|商店|商会|事務所|店$|ストア|マート|サービス)/;

function mk(line: Line, value: string, certainty: Certainty, reasons: string[]): FieldExtraction {
  const r = [...reasons];
  let c = certainty;
  if (line.confidence !== null && line.confidence < LOW_OCR_CONFIDENCE) {
    c = 'low';
    r.push(`この行の文字認識の信頼度が低い（${Math.round(line.confidence)}%）`);
  }
  return { value, evidence: line.raw.trim(), page: line.page, certainty: c, reasons: r, ocrConfidence: line.confidence === null ? null : Math.round(line.confidence) };
}

/** ラベルを含む行から値を探す。値が同じ行になければ次の行も見る */
function labeled<T>(lines: Line[], labels: RegExp, parse: (text: string) => T | null, opts: { exclude?: RegExp } = {}): { line: Line; value: T; sameLine: boolean }[] {
  const out: { line: Line; value: T; sameLine: boolean }[] = [];
  lines.forEach((l, i) => {
    const m = l.text.match(labels);
    if (!m || (opts.exclude && opts.exclude.test(l.text))) return;
    const after = l.text.slice((m.index ?? 0) + m[0].length);
    const v = parse(after);
    if (v !== null) out.push({ line: l, value: v, sameLine: true });
    else {
      const next = lines[i + 1];
      if (next && next.page === l.page) {
        const v2 = parse(next.text);
        if (v2 !== null) out.push({ line: next, value: v2, sameLine: false });
      }
    }
  });
  return out;
}

const firstDate = (t: string) => findDates(t)[0] ?? null;
const lastAmount = (t: string) => {
  const a = findAmounts(t);
  return a.length ? a[a.length - 1]! : null;
};
const textValue = (t: string) => {
  const v = t.replace(/^[\s:：\-]+/, '').trim();
  return v.length >= 1 && v.length <= 80 ? v : null;
};

function detectType(lines: Line[]): { type: DocumentType; reason: string; line: Line | null } {
  // タイトルらしい短い行を優先 (本文中の「請求書を送付します」で誤判定しない)
  const head = lines.slice(0, 12);
  for (const pass of [head.filter((l) => l.text.length <= 16), lines]) {
    for (const l of pass)
      for (const r of TYPE_RULES)
        if (r.re.test(l.text)) return { type: r.type, reason: `「${l.raw.trim()}」から${r.label}と判定`, line: l };
  }
  // タイトルが読み取れなかった場合 (大きな字間の見出しは OCR で崩れやすい) も、本文の定型句から判定する
  const phrase = lines.find((l) => /(上記正に領収|領収いたしました|領収致しました|正に受領)/.test(l.text));
  if (phrase) return { type: 'receipt', reason: `「${phrase.raw.trim()}」から領収書と判定（タイトルは読み取れず）`, line: null };
  if (lines.some((l) => /お預[りか]|お釣|釣銭/.test(l.text)) && lines.some((l) => /合計/.test(l.text)))
    return { type: 'receipt', reason: '「お預り」「お釣り」「合計」があるためレシート（領収書）と判定', line: null };
  return { type: 'other', reason: '書類の種類を示す語が見つかりませんでした', line: null };
}

const TOTAL_LABELS: { re: RegExp; rank: number }[] = [
  { re: /(ご請求金額|御請求金額|請求金額|お支払金額|お支払い金額|領収金額|税込合計|合計金額|総合計|合計\s*\(税込\)|お買上合計|お買上げ合計)/, rank: 3 },
  { re: /(?<!小)合\s*計(?!.*税抜)/, rank: 2 },
  { re: /(金\s*額|計)/, rank: 1 },
];

function extractTotal(lines: Line[], type: DocumentType): FieldExtraction | null {
  for (const { re, rank } of TOTAL_LABELS) {
    const found = labeled(lines, re, lastAmount, { exclude: /小計|税抜|消費税|税額|内税|対象|預|釣|単価|数量/ }).filter((f) => f.value > 0);
    if (!found.length) continue;
    const values = [...new Set(found.map((f) => f.value))];
    // 同じ順位のラベルが複数あるときは最大の金額 (合計欄) を採るが、確認を促す
    const best = found.reduce((a, b) => (b.value > a.value ? b : a));
    const reasons = [`「${best.line.text.match(re)?.[0]}」の行から抽出`];
    let c: Certainty = rank === 3 ? 'high' : rank === 2 ? 'medium' : 'low';
    if (values.length > 1) {
      c = 'low';
      reasons.push(`合計らしい金額が複数あります（${values.map((v) => v.toLocaleString()).join('・')}円）`);
    }
    if (rank === 1) reasons.push('「金額」「計」など曖昧なラベルからの推定');
    return mk(best.line, String(best.value), c, reasons);
  }
  // 領収書の「¥12,345-」形式 (ラベルなし)
  if (type === 'receipt') {
    const yen = lines.filter((l) => /¥\s*[\d,]+\s*-/.test(l.text));
    if (yen.length === 1) return mk(yen[0]!, String(lastAmount(yen[0]!.text)), 'medium', ['「¥金額-」の表記から抽出（ラベルなし）']);
  }
  return null;
}

function extractTax(lines: Line[]): { field: FieldExtraction | null; taxLines: TaxLine[] } {
  const taxLines: TaxLine[] = [];
  for (const l of lines) {
    const rate = l.text.match(/(10|8)\s*%/);
    if (!rate || !/(対象|消費税|税)/.test(l.text)) continue;
    const amounts = findAmounts(l.text.replace(/(10|8)\s*%/g, ''));
    if (!amounts.length) continue;
    const tl: TaxLine = { rate: Number(rate[1]), taxable: null, tax: null };
    if (/対象/.test(l.text) && amounts.length >= 2) {
      tl.taxable = amounts[0]!;
      tl.tax = amounts[amounts.length - 1]!;
    } else if (/対象/.test(l.text)) tl.taxable = amounts[0]!;
    else tl.tax = amounts[amounts.length - 1]!;
    taxLines.push(tl);
  }
  const found = labeled(lines, /(消費税額?|税額|うち消費税|内消費税|\(内税\)|内税)/, lastAmount, { exclude: /対象|税込|税抜|込み?合計/ }).filter((f) => f.value >= 0);
  if (found.length) {
    const values = [...new Set(found.map((f) => f.value))];
    const sumByRate = taxLines.reduce((a, t) => a + (t.tax ?? 0), 0);
    if (values.length > 1 && sumByRate > 0 && values.includes(sumByRate)) {
      const hit = found.find((f) => f.value === sumByRate)!;
      return { field: mk(hit.line, String(sumByRate), 'medium', ['税率別の税額の合計と一致する値を採用']), taxLines };
    }
    const f = found[found.length - 1]!;
    return {
      field: mk(f.line, String(f.value), values.length > 1 ? 'low' : 'high', values.length > 1 ? [`税額らしい値が複数あります（${values.join('・')}円）`] : ['「消費税」の行から抽出']),
      taxLines,
    };
  }
  const taxOnly = taxLines.filter((t) => t.tax !== null);
  if (taxOnly.length) {
    const sum = taxOnly.reduce((a, t) => a + t.tax!, 0);
    const src = lines.find((l) => /(10|8)\s*%/.test(l.text) && /税/.test(l.text))!;
    return { field: mk(src, String(sum), 'medium', ['税率別の税額を合計']), taxLines };
  }
  return { field: null, taxLines };
}

const ITEM_ROW =
  /^(?:\d{1,3}[.)]?\s+)?(.+?)\s+(\d+(?:\.\d+)?)\s*(個|台|本|冊|枚|式|セット|箱|件|点|ケース|袋|組|ロール|巻|丁|m)?\s+[¥]?\s*(\d{1,3}(?:,\d{3})+|\d+)\s+[¥]?\s*(\d{1,3}(?:,\d{3})+|\d+)\s*円?$/;
const ITEM_ROW_QTY_AMOUNT = /^(?:\d{1,3}[.)]?\s+)?(.+?)\s+(\d+)\s*(個|台|本|冊|枚|式|セット|箱|件|点|ケース|袋|組)\s+[¥]?\s*(\d{1,3}(?:,\d{3})+|\d+)\s*円?$/;

function extractLines(lines: Line[]): DocumentLine[] {
  const headerIdx = lines.findIndex((l) => /(品\s*名|品\s*目|商品名|内\s*容|摘\s*要|明\s*細)/.test(l.text) && /(数\s*量|金\s*額|単\s*価)/.test(l.text));
  const start = headerIdx >= 0 ? headerIdx + 1 : 0;
  const out: DocumentLine[] = [];
  for (let i = start; i < lines.length; i++) {
    const l = lines[i]!;
    if (headerIdx >= 0 && /(小\s*計|合\s*計|消費税|税抜|税込|対象)/.test(l.text)) break;
    if (/(合計|小計|消費税|対象|お預|釣|請求金額|登録番号)/.test(l.text)) continue;
    let m = l.text.match(ITEM_ROW);
    if (m) {
      const qty = Number(m[2]);
      const unit = Number(m[4]!.replace(/,/g, ''));
      const amount = Number(m[5]!.replace(/,/g, ''));
      const name = m[1]!.replace(/[|｜]/g, ' ').trim();
      if (name.length < 1 || /^\d+$/.test(name)) continue;
      out.push({ id: `ln_${out.length + 1}`, name, quantity: qty, unitPrice: unit, amount, itemId: null, evidence: l.raw.trim() });
      continue;
    }
    m = l.text.match(ITEM_ROW_QTY_AMOUNT);
    if (m && headerIdx >= 0) {
      const name = m[1]!.trim();
      out.push({ id: `ln_${out.length + 1}`, name, quantity: Number(m[2]), unitPrice: null, amount: Number(m[4]!.replace(/,/g, '')), itemId: null, evidence: l.raw.trim() });
    }
  }
  return out;
}

function extractParties(lines: Line[], type: DocumentType, regLine: Line | null): { issuer: FieldExtraction | null; recipient: FieldExtraction | null } {
  let recipient: FieldExtraction | null = null;
  let recipientLine: Line | null = null;
  for (const l of lines) {
    const m = l.text.match(/^(.+?)\s*(御中|様)(?:\s|$)/);
    if (m && !/(お客様|皆様|各位)/.test(m[1]!) && m[1]!.length <= 40) {
      recipient = mk(l, m[1]!.replace(/^(宛先|宛名)[\s:：]*/, '').trim(), m[2] === '御中' ? 'high' : 'medium', [`「${m[2]}」の前の名称`]);
      recipientLine = l;
      break;
    }
  }
  // 発行元ラベル
  const lab = labeled(lines, /(発行元|請求元|発行者|販売元|販売店|事業者名|会社名|店名)/, textValue);
  if (lab.length) return { issuer: mk(lab[0]!.line, lab[0]!.value, 'high', ['「発行元」などのラベルから抽出']), recipient };

  const candidates = lines.filter((l) => l !== recipientLine && COMPANY.test(l.text) && !/(御中|様)/.test(l.text) && l.text.length <= 40 && !/(振込|口座|銀行|支店)/.test(l.text));
  if (!candidates.length) return { issuer: null, recipient };
  // 登録番号の行に最も近い会社名を発行元とする (適格請求書では発行元の近くに登録番号がある)
  let pick: Line;
  const reasons: string[] = [];
  if (regLine) {
    pick = candidates.reduce((a, b) => (Math.abs(b.index - regLine.index) < Math.abs(a.index - regLine.index) ? b : a));
    reasons.push('登録番号に最も近い会社名');
  } else if (type === 'receipt') {
    pick = candidates[candidates.length - 1]!;
    reasons.push('領収書の下部にある会社・店名（位置からの推定）');
  } else {
    pick = candidates[0]!;
    reasons.push('宛先以外で最初に現れる会社名（位置からの推定）');
  }
  const value = pick.text.replace(/(TEL|電話|〒|FAX).*$/i, '').trim();
  return { issuer: mk(pick, value, candidates.length > 1 ? 'low' : 'medium', candidates.length > 1 ? [...reasons, `会社名らしい行が${candidates.length}件あります`] : reasons), recipient };
}

/** OCR・PDFのテキストから項目を抽出する */
export function extractDocument(pages: SourcePage[], hint?: DocumentType): ExtractionResult {
  const lines: Line[] = [];
  for (const p of pages)
    for (const sl of p.lines) {
      const text = normalizeText(sl.text);
      if (text) lines.push({ text, raw: sl.text, page: p.page, index: lines.length, confidence: sl.confidence });
    }
  const fields: Partial<Record<FieldKey, FieldExtraction>> = {};
  const detected = detectType(lines);
  const type = hint ?? detected.type;
  if (detected.line) fields.title = mk(detected.line, detected.line.text.length <= 20 ? detected.line.text : TYPE_RULES.find((r) => r.type === detected.type)!.label, 'high', [detected.reason]);

  // 登録番号
  const regLine = lines.find((l) => findRegistrationNumber(l.text)) ?? null;
  if (regLine) {
    const v = findRegistrationNumber(regLine.text)!;
    fields.registrationNumber = mk(regLine, v, /登録番号|適格/.test(regLine.text) ? 'high' : 'medium', [/登録番号|適格/.test(regLine.text) ? '「登録番号」の行から抽出' : '「T＋13桁」の形式から抽出（ラベルなし）']);
  }

  // 書類番号
  const num = labeled(lines, /(請求書番号|請求番号|請求No|伝票番号|伝票No|納品書番号|納品番号|見積書番号|見積番号|見積No|領収書番号|領収書No|書類番号|管理番号|申請番号|文書番号|No\.?|NO\.?|№)/, (t) => {
    const m = t.match(/^[\s:：#.]*([A-Za-z0-9][A-Za-z0-9\-_/]{1,30})/);
    return m && /\d/.test(m[1]!) ? m[1]! : null;
  }, { exclude: /T\d{13}|登録番号|TEL|電話|FAX|〒/ });
  if (num.length) fields.docNumber = mk(num[0]!.line, num[0]!.value, num[0]!.sameLine ? 'high' : 'medium', ['番号のラベルから抽出']);

  // 日付
  const due = labeled(lines, /(お支払期限|お支払い期限|支払期限|支払期日|お支払期日|お振込期限|振込期限|振込期日|お支払日|支払予定日)/, firstDate);
  if (due.length) fields.dueDate = mk(due[0]!.line, due[0]!.value, 'high', ['「支払期限」の行から抽出']);
  const deliv = labeled(lines, /(納品日|納入日|お届け日|出荷日)/, firstDate);
  if (deliv.length) fields.deliveryDate = mk(deliv[0]!.line, deliv[0]!.value, 'high', ['「納品日」の行から抽出']);
  const issue = labeled(lines, /(発行日|請求日|領収日|見積日|申請日|作成日|日付|発行年月日|請求年月日|申請年月日|取引日)/, firstDate);
  if (issue.length) fields.issueDate = mk(issue[0]!.line, issue[0]!.value, 'high', [`「${issue[0]!.line.text.match(/(発行日|請求日|領収日|見積日|申請日|作成日|日付|発行年月日|請求年月日|申請年月日|取引日)/)?.[0]}」の行から抽出`]);
  else {
    const used = new Set([fields.dueDate?.value, fields.deliveryDate?.value]);
    const all = lines.flatMap((l) => findDates(l.text).map((d) => ({ l, d }))).filter((x) => !used.has(x.d));
    if (all.length) {
      const distinct = [...new Set(all.map((x) => x.d))];
      fields.issueDate = mk(all[0]!.l, all[0]!.d, distinct.length > 1 ? 'low' : 'medium', distinct.length > 1 ? [`ラベルがなく、日付が${distinct.length}種類あります。最初の日付を仮に採用`] : ['ラベルはないが書類中の唯一の日付']);
    }
  }
  if (type === 'delivery' && !fields.deliveryDate && fields.issueDate) fields.deliveryDate = { ...fields.issueDate, certainty: 'low', reasons: [...fields.issueDate.reasons, '納品日の記載がないため発行日と同じ値を候補にしました'] };

  // 金額
  const total = extractTotal(lines, type);
  if (total) fields.total = total;
  const sub = labeled(lines, /(小\s*計|税抜金額|税抜合計|税抜価格|本体価格|合計\s*\(税抜\))/, lastAmount);
  if (sub.length) fields.subtotal = mk(sub[0]!.line, String(sub[0]!.value), 'high', ['「小計」「税抜」の行から抽出']);
  const tax = extractTax(lines);
  if (tax.field) fields.tax = tax.field;

  // 当事者
  const parties = extractParties(lines, type, regLine);
  if (parties.issuer) fields.issuer = parties.issuer;
  if (parties.recipient) fields.recipient = parties.recipient;

  // 申請書
  const applicant = labeled(lines, /(申請者|申請人|氏\s*名|届出者)/, textValue);
  if (applicant.length) fields.applicant = mk(applicant[0]!.line, applicant[0]!.value, 'medium', ['「申請者」「氏名」の行から抽出']);
  const content = labeled(lines, /(申請内容|申請事由|件\s*名|目\s*的|内\s*容)/, textValue, { exclude: /数量|単価|金額/ });
  if (content.length && type === 'application') fields.applicationContent = mk(content[0]!.line, content[0]!.value, 'medium', ['「申請内容」「件名」の行から抽出']);
  const notes = labeled(lines, /(備\s*考|摘要欄|特記事項)/, textValue);
  if (notes.length) fields.notes = mk(notes[0]!.line, notes[0]!.value, 'medium', ['「備考」の行から抽出']);

  const items = extractLines(lines);
  applyCrossChecks(fields, items, tax.taxLines);
  return { type, typeReason: hint ? '登録時に選択した種類' : detected.reason, fields, lines: items, taxLines: tax.taxLines };
}

/** 検算: 小計＋税＝合計、明細の合計＝小計/合計。合えば確実性を上げ、合わなければ要確認にする */
function applyCrossChecks(fields: Partial<Record<FieldKey, FieldExtraction>>, items: DocumentLine[], taxLines: TaxLine[]) {
  const total = fields.total ? Number(fields.total.value) : null;
  const sub = fields.subtotal ? Number(fields.subtotal.value) : null;
  const tax = fields.tax ? Number(fields.tax.value) : null;
  if (total !== null && sub !== null && tax !== null) {
    if (sub + tax === total) {
      // 3つの値が互いに整合する = 読み取りが正しい可能性が高い。ただし文字認識の信頼度が低い行は要確認のまま
      for (const k of ['total', 'subtotal', 'tax'] as const) {
        const f = fields[k]!;
        const lowOcr = f.ocrConfidence !== null && f.ocrConfidence < LOW_OCR_CONFIDENCE;
        fields[k] = { ...f, certainty: lowOcr ? 'low' : 'high', reasons: [...f.reasons, '検算一致：小計＋消費税＝合計'] };
      }
    } else {
      fields.total = { ...fields.total!, certainty: 'low', reasons: [...fields.total!.reasons, `検算不一致：小計 ${sub.toLocaleString()} ＋ 消費税 ${tax.toLocaleString()} ≠ 合計 ${total.toLocaleString()}`] };
    }
  }
  const lineSum = items.reduce((a, l) => a + (l.amount ?? 0), 0);
  if (items.length && total !== null && sub === null && lineSum !== total && taxLines.length === 0 && tax === null) {
    fields.total = { ...fields.total!, certainty: fields.total!.certainty === 'high' ? 'medium' : fields.total!.certainty, reasons: [...fields.total!.reasons, `明細の合計（${lineSum.toLocaleString()}円）と一致しません`] };
  }
}

// ---------------------------------------------------------------------------
// 確認画面の入力チェック
// ---------------------------------------------------------------------------

export interface FieldIssue {
  key: FieldKey | 'lines';
  level: 'error' | 'warning';
  message: string;
}

/** 形式エラー (保存不可) と、整合性の注意 (保存は可能) を返す */
export function checkFields(fields: Partial<Record<FieldKey, string>>, lines: DocumentLine[]): FieldIssue[] {
  const out: FieldIssue[] = [];
  for (const k of ['issueDate', 'dueDate', 'deliveryDate'] as const) {
    const v = fields[k]?.trim();
    if (v && !isValidISODate(v)) out.push({ key: k, level: 'error', message: '日付は YYYY-MM-DD 形式（例：2026-10-15）で入力してください' });
  }
  for (const k of ['total', 'tax', 'subtotal'] as const) {
    const v = fields[k]?.trim();
    if (v && !/^\d+$/.test(v)) out.push({ key: k, level: 'error', message: '金額は0以上の整数（円）で入力してください' });
  }
  const reg = fields.registrationNumber?.trim();
  if (reg && !isRegistrationNumber(reg)) out.push({ key: 'registrationNumber', level: 'error', message: '登録番号は「T」＋13桁の数字です' });
  const n = (k: FieldKey) => (fields[k] && /^\d+$/.test(fields[k]!) ? Number(fields[k]) : null);
  const total = n('total');
  const sub = n('subtotal');
  const tax = n('tax');
  if (total !== null && sub !== null && tax !== null && sub + tax !== total)
    out.push({ key: 'total', level: 'warning', message: `小計 ${sub.toLocaleString()} ＋ 消費税 ${tax.toLocaleString()} ＝ ${(sub + tax).toLocaleString()} が合計と一致しません` });
  if (total !== null && tax !== null && tax > total) out.push({ key: 'tax', level: 'warning', message: '消費税額が合計金額より大きくなっています' });
  const issue = fields.issueDate;
  const due = fields.dueDate;
  if (issue && due && isValidISODate(issue) && isValidISODate(due) && due < issue) out.push({ key: 'dueDate', level: 'warning', message: '支払期限が発行日より前になっています' });
  for (const l of lines) {
    if (l.quantity !== null && l.unitPrice !== null && l.amount !== null && Math.round(l.quantity * l.unitPrice) !== l.amount)
      out.push({ key: 'lines', level: 'warning', message: `明細「${l.name}」：数量 × 単価 ＝ ${Math.round(l.quantity * l.unitPrice).toLocaleString()} が金額 ${l.amount.toLocaleString()} と一致しません` });
    if (l.quantity !== null && (l.quantity < 0 || !Number.isFinite(l.quantity))) out.push({ key: 'lines', level: 'error', message: `明細「${l.name}」の数量が不正です` });
  }
  return out;
}
