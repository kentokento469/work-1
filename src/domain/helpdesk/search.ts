/**
 * FAQ・過去の対応履歴の検索と解決策候補の提示。
 *
 * 重要: FAQ (担当者が確認・公開した手順) と、過去の問い合わせの解決内容 (未検証の参考情報) は
 * 信頼度が異なるため、結果の種類 (kind) を分けて返す。画面でも明確に区別して表示する。
 */
import { bigrams, coverage, diceSimilarity, normalizeText } from '../text';
import type { Faq, Inquiry } from '../types';

export interface FaqMatch {
  kind: 'faq';
  faq: Faq;
  score: number;
  reasons: string[];
}

export interface PastCaseMatch {
  kind: 'past_case';
  inquiry: Inquiry;
  score: number;
  reasons: string[];
}

const FAQ_MIN_SCORE = 0.25;
const CASE_MIN_SCORE = 0.3;

function keywordHits(normalizedQuery: string, keywords: string[]): string[] {
  return keywords.filter((k) => {
    const nk = normalizeText(k);
    return nk.length > 0 && normalizedQuery.includes(nk);
  });
}

/**
 * 問い合わせ内容 (または検索語) に関連するFAQを返す。
 * スコア = キーワード一致 (1語0.3, 最大0.6) + 質問文との類似度 (最大0.5) + 同一カテゴリ (+0.15)
 */
export function suggestFaqs(query: string, faqs: Faq[], opts: { categoryId?: string; includeDisabled?: boolean; limit?: number } = {}): FaqMatch[] {
  const nq = normalizeText(query);
  if (!nq) return [];
  const qb = bigrams(query);
  const results: FaqMatch[] = [];
  for (const faq of faqs) {
    if (!faq.enabled && !opts.includeDisabled) continue;
    const reasons: string[] = [];
    const hits = keywordHits(nq, faq.keywords);
    let score = Math.min(0.6, hits.length * 0.3);
    if (hits.length) reasons.push(`キーワード一致：${hits.join('・')}`);
    const fb = bigrams(`${faq.question} ${faq.keywords.join(' ')}`);
    // 短い検索語は「検索語がどれだけ含まれるか」、長い文章は「全体の類似度」で評価する
    const sim = qb.size <= 6 ? coverage(qb, fb) * 0.6 : diceSimilarity(qb, fb) * 1.2;
    const simScore = Math.min(0.5, sim);
    if (simScore >= 0.1) reasons.push(`質問文の類似度 ${Math.round(simScore * 200)}%`);
    score += simScore;
    if (opts.categoryId && faq.categoryId === opts.categoryId) {
      score += 0.15;
      reasons.push('同じカテゴリ');
    }
    if (score >= FAQ_MIN_SCORE) results.push({ kind: 'faq', faq, score: Math.round(score * 100) / 100, reasons });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 5);
}

/** 解決済み・完了の過去案件から、解決内容が記録されているものを類似度順に返す */
export function findSimilarCases(query: string, inquiries: Inquiry[], opts: { excludeId?: string; categoryId?: string; limit?: number } = {}): PastCaseMatch[] {
  const qb = bigrams(query);
  if (qb.size === 0) return [];
  const results: PastCaseMatch[] = [];
  for (const inq of inquiries) {
    if (inq.id === opts.excludeId) continue;
    if (inq.status !== 'resolved' && inq.status !== 'closed') continue;
    if (!inq.resolution.trim()) continue;
    const ib = bigrams(`${inq.title} ${inq.body}`);
    const sim = qb.size <= 6 ? coverage(qb, ib) * 0.6 : diceSimilarity(qb, ib) * 1.5;
    let score = Math.min(0.8, sim);
    const reasons = [`内容の類似度 ${Math.round(Math.min(1, sim) * 100)}%`];
    if (opts.categoryId && inq.categoryId === opts.categoryId) {
      score += 0.1;
      reasons.push('同じカテゴリ');
    }
    if (score >= CASE_MIN_SCORE) results.push({ kind: 'past_case', inquiry: inq, score: Math.round(score * 100) / 100, reasons });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 3);
}

/** FAQ一覧の絞り込み検索 (質問・回答・キーワードの部分一致) */
export function filterFaqs(faqs: Faq[], keyword: string): Faq[] {
  const nk = normalizeText(keyword);
  if (!nk) return faqs;
  const ranked = suggestFaqs(keyword, faqs, { includeDisabled: true, limit: faqs.length });
  const ids = new Set(ranked.map((r) => r.faq.id));
  const substring = faqs.filter((f) => !ids.has(f.id) && normalizeText(`${f.question} ${f.answer} ${f.keywords.join(' ')}`).includes(nk));
  return [...ranked.map((r) => r.faq), ...substring];
}
