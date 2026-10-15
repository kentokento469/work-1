/**
 * 入力値の正規化・検証 (純粋関数・UI非依存)。
 * 全角の数字・英字・記号を半角へ、表記ゆれを吸収して保存形式をそろえる。
 */

/** 全角英数字・記号を半角に (カタカナ・漢字はそのまま)。全角スペースは半角に */
export function toHalfWidth(s: string): string {
  return s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, ' ').replace(/[‐‑‒–—―−ー－]/g, (c) => (c === 'ー' ? c : '-'));
}

/** 数字だけを取り出す (全角も可) */
export const digitsOnly = (s: string) => toHalfWidth(s).replace(/\D/g, '');

/** 金額・数量の入力を整数に。「¥12,345」「１２３４５円」も可。不正な文字があれば null */
export function parseInteger(raw: string): { value: number | null; invalid: boolean } {
  const t = toHalfWidth(raw).replace(/[¥￥円,\s]/g, '');
  if (!t) return { value: null, invalid: false };
  if (!/^-?\d+$/.test(t)) return { value: null, invalid: true };
  const n = Number(t);
  return Number.isSafeInteger(n) ? { value: n, invalid: false } : { value: null, invalid: true };
}

/** 3桁区切り (表示用) */
export const formatThousands = (n: number) => n.toLocaleString('ja-JP');

/** メールアドレスの形式 (一般的な範囲。厳密な RFC 準拠ではない) */
export function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(s.trim());
}

/** メールアドレスの正規化 (全角→半角・前後空白除去・ドメインを小文字) */
export function normalizeEmail(s: string): string {
  const t = toHalfWidth(s).trim().replace(/＠/g, '@');
  const at = t.lastIndexOf('@');
  return at > 0 ? `${t.slice(0, at)}@${t.slice(at + 1).toLowerCase()}` : t;
}
