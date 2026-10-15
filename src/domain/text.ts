/**
 * 日本語テキスト処理の共通関数。
 * 形態素解析器を使わずに検索・分類するため、正規化 + 文字bigram で類似度を測る。
 */

/** 全角英数・半角カナを統一し (NFKC)、小文字化・空白除去する */
export function normalizeText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\s　]+/g, '');
}

/** 文字bigramの集合 (1文字の語はそのまま) */
export function bigrams(text: string): Set<string> {
  const t = normalizeText(text).replace(/[、。,.!?！？「」『』()（）・:：/／\-ー〜~]/g, '');
  const set = new Set<string>();
  if (t.length === 1) set.add(t);
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

/** Dice係数 (0〜1) */
export function diceSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return (2 * inter) / (a.size + b.size);
}

/** query の bigram のうち target に含まれる割合 (0〜1)。短い検索語向け */
export function coverage(query: Set<string>, target: Set<string>): number {
  if (query.size === 0) return 0;
  let hit = 0;
  for (const x of query) if (target.has(x)) hit++;
  return hit / query.size;
}

/** 正規化済み本文にキーワードが含まれるか */
export function containsKeyword(normalizedText: string, keyword: string): boolean {
  const k = normalizeText(keyword);
  return k.length > 0 && normalizedText.includes(k);
}
