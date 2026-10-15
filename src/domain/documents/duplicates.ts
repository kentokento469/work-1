/**
 * 書類の重複検出 (純粋関数)。
 * - 完全一致: ファイル内容のハッシュが同じ = 同じファイルの再登録
 * - 一致の可能性が高い: 発行元＋書類番号、または登録番号＋書類番号が同じ
 * - 類似: 発行元・発行日・合計金額のうち複数が一致
 * 同一と断定できない場合は自動で削除・統合しない。判断は利用者が比較画面で行う。
 */
import type { DocumentRecord, FieldKey } from './types';

export type DuplicateLevel = 'exact' | 'likely' | 'similar';
export const DUPLICATE_LEVEL_LABEL: Record<DuplicateLevel, string> = {
  exact: '同じファイル（完全一致）',
  likely: '同じ書類の可能性が高い',
  similar: '似ている書類',
};

export interface DuplicateMatch {
  document: DocumentRecord;
  level: DuplicateLevel;
  reasons: string[];
}

export interface DuplicateProbe {
  id?: string;
  type?: DocumentRecord['type'];
  hash?: string | null;
  fields: Partial<Record<FieldKey, string>>;
  /** 「別の書類」と判断済みの書類 */
  notDuplicateOf?: string[];
}

/** 会社名の表記ゆれ (株式会社/㈱/(株)・空白・全角) を吸収して比較する */
export function normalizeParty(s: string | undefined): string {
  if (!s) return '';
  return s
    .normalize('NFKC')
    .replace(/株式会社|\(株\)|㈱/g, 'カ')
    .replace(/有限会社|\(有\)|㈲/g, 'ユ')
    .replace(/合同会社/g, 'ゴ')
    .replace(/[\s・.,、。]/g, '')
    .toLowerCase();
}
const normNo = (s: string | undefined) => (s ?? '').normalize('NFKC').replace(/[\s\-_/]/g, '').toUpperCase();

const ORDER: Record<DuplicateLevel, number> = { exact: 0, likely: 1, similar: 2 };

/** OCR の誤読・行の分割で発行元の表記が少し崩れても「近い」と判断する (2文字の並びの一致率) */
export function similarParty(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length >= 4 && longer.includes(shorter)) return true;
  const bigrams = (s: string) => new Set(Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2)));
  const x = bigrams(a);
  const y = bigrams(b);
  if (!x.size || !y.size) return false;
  let common = 0;
  for (const g of x) if (y.has(g)) common++;
  return (2 * common) / (x.size + y.size) >= 0.6;
}

export function findDuplicates(probe: DuplicateProbe, docs: DocumentRecord[]): DuplicateMatch[] {
  const out: DuplicateMatch[] = [];
  const f = probe.fields;
  const issuer = normalizeParty(f.issuer);
  const no = normNo(f.docNumber);
  const reg = (f.registrationNumber ?? '').trim();
  for (const d of docs) {
    if (d.id === probe.id || d.deletedAt) continue;
    if (probe.notDuplicateOf?.includes(d.id) || d.notDuplicateOf.includes(probe.id ?? '')) continue;
    if (probe.hash && d.file?.hash === probe.hash) {
      out.push({ document: d, level: 'exact', reasons: ['ファイルの内容（SHA-256）が完全に一致'] });
      continue;
    }
    const g = d.fields;
    const sameIssuer = !!issuer && issuer === normalizeParty(g.issuer);
    const sameNo = !!no && no === normNo(g.docNumber);
    const sameReg = !!reg && reg === (g.registrationNumber ?? '').trim();
    const sameDate = !!f.issueDate && f.issueDate === g.issueDate;
    const sameTotal = !!f.total && f.total === g.total;
    const sameType = !probe.type || probe.type === d.type;
    if (sameNo && sameType && (sameIssuer || sameReg)) {
      out.push({ document: d, level: 'likely', reasons: [`${sameIssuer ? '発行元' : '登録番号'}と書類番号「${g.docNumber}」が一致`, ...(sameTotal ? ['合計金額も一致'] : [])] });
      continue;
    }
    const nearIssuer = !sameIssuer && similarParty(issuer, normalizeParty(g.issuer));
    const hits = [sameIssuer && '発行元', nearIssuer && '発行元（表記が近い）', sameReg && '登録番号', sameDate && '発行日', sameTotal && '合計金額', sameNo && '書類番号'].filter(Boolean) as string[];
    // 金額と日付が同じでも取引先が違えば別の取引の可能性が高いので、取引先 (発行元・登録番号) か書類番号の一致を必須にする
    if (hits.length >= 2 && (sameIssuer || nearIssuer || sameReg || sameNo) && (sameTotal || sameDate)) out.push({ document: d, level: 'similar', reasons: [`${hits.join('・')}が一致`] });
  }
  return out.sort((a, b) => ORDER[a.level] - ORDER[b.level] || b.document.createdAt.localeCompare(a.document.createdAt));
}
