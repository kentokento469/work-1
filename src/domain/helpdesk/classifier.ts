/**
 * 問い合わせ自動分類 (ルールベース)。
 *
 * - 外部AIは使わず、キーワード一致 + スコアリング + 条件分岐で判定する
 * - すべての判定に「根拠 (一致した語・加点理由)」を残し、画面で確認できるようにする
 * - 根拠が弱い/拮抗する場合は無理に分類せず「その他・要確認」にする
 * - 最終決定は担当者が行う (この関数は候補を返すだけ)
 */
import { normalizeText } from '../text';
import type { InquiryCategory, Priority } from '../types';
import { CAT } from './defaults';

export interface CategoryCandidate {
  categoryId: string;
  name: string;
  score: number;
  matched: string[];
}

export interface PriorityReason {
  label: string;
  terms: string[];
  weight: number;
}

export interface ClassificationResult {
  categoryId: string;
  needsReview: boolean;
  confidence: 'high' | 'medium' | 'low';
  candidates: CategoryCandidate[];
  priority: Priority;
  priorityScore: number;
  priorityReasons: PriorityReason[];
  /** 画面表示用の判定理由 */
  reasons: string[];
}

/** 強いキーワード1語あたりの点数 */
const STRONG = 2;
/** カテゴリ確定に必要な最低点 (= 強いキーワード1語以上) */
const MIN_SCORE = 2;

/**
 * 単独ではカテゴリを決められない「弱い手がかり」。
 * アカウント系カテゴリに +1 するだけなので、「ログインできない」だけでは分類しない。
 */
const WEAK_ACCOUNT_TERMS = ['ログイン', 'サインイン', 'パスワード', 'password', 'パスコード', '認証', 'アカウント'];
const ACCOUNT_CATEGORIES: string[] = [CAT.microsoft, CAT.google, CAT.apple, CAT.access];

/** 他の語の一部を誤検出しないよう、先に「場所だけ確保する」語 (加点なし) */
const NEUTRAL_TERMS = ['キーワード', 'キャビネット'];

interface PriorityGroup {
  label: string;
  weight: number;
  terms: string[];
}

/**
 * 優先度の加点グループ。グループごとに1回だけ加点する (同じ種類の語の繰り返しで過剰に上がらない)。
 * 影響範囲 (impact) と緊急度 (urgency) を分けて評価する ITIL の考え方を簡略化したもの。
 */
const PRIORITY_GROUPS: PriorityGroup[] = [
  {
    label: 'セキュリティ事故の可能性',
    weight: 3,
    terms: ['ウイルス', 'マルウェア', 'ランサム', '不審なメール', '不審なファイル', '不審なリンク', 'フィッシング', '乗っ取', '情報漏', '漏洩', '漏えい', '紛失', '盗難', '不正アクセス', '不正ログイン'],
  },
  {
    label: '影響範囲が広い',
    weight: 2,
    terms: ['全員', '全社', '社内全体', '全部署', '部署全体', 'フロア全体', '全拠点', 'みんな', '複数人', '複数の社員', '誰も'],
  },
  {
    label: '業務が止まっている',
    weight: 1,
    terms: ['業務が止', '仕事ができない', '仕事にならない', '作業ができない', '作業できない', '起動しない', '電源が入らない', '接続できない', 'つながらない', '繋がらない', '全く使えない'],
  },
  {
    label: '時間的な緊急性',
    weight: 1,
    terms: ['至急', '緊急', '急ぎ', '今日中', '本日中', '今すぐ', 'すぐに', '締め切り', '締切', '商談', '来客'],
  },
  {
    label: '緊急性が低い表現',
    weight: -1,
    terms: ['急ぎません', '急ぎではない', '急ぎではありません', 'いつでも', '時間がある時', '時間があるとき', 'お手すき', '手が空いた', '要望', 'ご相談', '教えてください'],
  },
];

interface Span {
  start: number;
  end: number;
  term: string;
  owner: string; // categoryId / 'weak' / 'neutral' / priority label
}

/** 全候補語の出現位置を求め、長い語を優先して重ならないものだけ採用する (最長一致) */
function longestMatch(text: string, dictionary: { term: string; owner: string }[]): Span[] {
  const all: Span[] = [];
  for (const { term, owner } of dictionary) {
    const t = normalizeText(term);
    if (!t) continue;
    let from = 0;
    for (;;) {
      const i = text.indexOf(t, from);
      if (i < 0) break;
      all.push({ start: i, end: i + t.length, term, owner });
      from = i + 1;
    }
  }
  all.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const taken: Span[] = [];
  for (const s of all) if (!taken.some((x) => s.start < x.end && x.start < s.end)) taken.push(s);
  return taken;
}

function scorePriority(text: string): { priority: Priority; score: number; reasons: PriorityReason[] } {
  const spans = longestMatch(
    text,
    PRIORITY_GROUPS.flatMap((g) => g.terms.map((term) => ({ term, owner: g.label }))),
  );
  const reasons: PriorityReason[] = [];
  for (const g of PRIORITY_GROUPS) {
    const terms = [...new Set(spans.filter((s) => s.owner === g.label).map((s) => s.term))];
    if (terms.length) reasons.push({ label: g.label, terms, weight: g.weight });
  }
  const score = reasons.reduce((a, r) => a + r.weight, 0);
  // 高: 加点合計3以上 (例: 影響範囲が広い + 業務停止、またはセキュリティ単独)
  const priority: Priority = score >= 3 ? 'high' : score <= -1 ? 'low' : 'medium';
  return { priority, score, reasons };
}

export function classifyInquiry(title: string, body: string, categories: InquiryCategory[]): ClassificationResult {
  const text = normalizeText(`${title}\n${body}`);
  const active = categories.filter((c) => c.enabled && !c.isFallback);
  const fallback = categories.find((c) => c.isFallback) ?? categories.find((c) => c.id === CAT.other);
  const fallbackId = fallback?.id ?? CAT.other;

  const dictionary = [
    ...NEUTRAL_TERMS.map((term) => ({ term, owner: 'neutral' })),
    ...WEAK_ACCOUNT_TERMS.map((term) => ({ term, owner: 'weak' })),
    ...active.flatMap((c) => c.keywords.map((term) => ({ term, owner: c.id }))),
  ];
  const spans = longestMatch(text, dictionary);
  // 弱い手がかりも最長一致に参加させることで「パスワード」内の「ワード」(Word) を誤検出しない
  const weakTerms = [...new Set(spans.filter((s) => s.owner === 'weak').map((s) => s.term))];

  const candidates: CategoryCandidate[] = active
    .map((c) => {
      const matched = [...new Set(spans.filter((s) => s.owner === c.id).map((s) => s.term))];
      let score = matched.length * STRONG;
      const extra: string[] = [];
      if (weakTerms.length && ACCOUNT_CATEGORIES.includes(c.id)) {
        score += 1;
        extra.push(...weakTerms.map((t) => `${t}(弱)`));
      }
      return { categoryId: c.id, name: c.name, score, matched: [...matched, ...extra] };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  const top = candidates[0];
  const second = candidates[1];
  const reasons: string[] = [];
  let categoryId = fallbackId;
  let needsReview = true;
  let confidence: ClassificationResult['confidence'] = 'low';

  if (!top) {
    reasons.push('カテゴリを示すキーワードが見つからないため「その他・要確認」としました');
  } else if (top.score < MIN_SCORE) {
    reasons.push(`「${weakTerms.join('・')}」だけではどのサービスか判断できないため「その他・要確認」としました`);
  } else if (second && second.score === top.score) {
    reasons.push(`「${top.name}」と「${second.name}」の根拠が同点のため、担当者の確認が必要です`);
  } else {
    categoryId = top.categoryId;
    needsReview = false;
    const margin = top.score - (second?.score ?? 0);
    confidence = top.score >= 4 && margin >= 2 ? 'high' : 'medium';
    reasons.push(`「${top.matched.filter((m) => !m.endsWith('(弱)')).join('・')}」から「${top.name}」と判定（${top.score}点）`);
    if (second) reasons.push(`次点：「${second.name}」（${second.score}点）`);
  }

  const p = scorePriority(text);
  if (p.reasons.length === 0) reasons.push('優先度を上げる・下げる表現がないため標準（中）としました');
  else reasons.push(`優先度：${p.reasons.map((r) => `${r.label}${r.weight > 0 ? '+' : ''}${r.weight}`).join('、')} → 合計${p.score}点`);
  if (p.priority !== 'high' && weakTerms.length && p.reasons.every((r) => r.weight <= 1)) {
    reasons.push('ログイン不可などの症状だけでは影響範囲が分からないため、高優先度にはしていません');
  }

  return { categoryId, needsReview, confidence, candidates: candidates.slice(0, 3), priority: p.priority, priorityScore: p.score, priorityReasons: p.reasons, reasons };
}
