/**
 * ヘルプデスク分析 (純粋関数)。
 * 件数が少なく統計的に意味がない指標は数値を出さず「データ不足」を返す。
 *
 * 解決時間の定義: 受付日時 (receivedAt) から 最初に「解決済み」になった日時 (resolvedAt) までの経過時間。
 * 「完了」までではなく「解決」までとするのは、完了は申請者確認待ちの時間を含み担当者の対応速度を表さないため。
 */
import { bigrams, diceSimilarity } from '../text';
import { PRIORITIES, type Inquiry, type InquiryCategory, type ISODate, type Priority } from '../types';
import { isInquiryOverdue } from './inquiry';

/** 平均・中央値を出すのに必要な最低件数 */
export const MIN_SAMPLES_FOR_DURATION = 3;
/** 頻出問い合わせとみなす最低件数 */
export const MIN_CLUSTER_SIZE = 2;

export type Metric<T> = { status: 'ok'; value: T; sample: number } | { status: 'insufficient'; sample: number; required: number };

export interface HelpdeskStats {
  total: number;
  newCount: number;
  inProgressCount: number;
  waitingCount: number;
  onHoldCount: number;
  resolvedCount: number;
  closedCount: number;
  openCount: number;
  overdueCount: number;
  byCategory: { categoryId: string; name: string; count: number; open: number }[];
  byPriority: { priority: Priority; count: number; open: number }[];
  /** 時間 (h) */
  avgResolutionHours: Metric<number>;
  medianResolutionHours: Metric<number>;
  frequent: { title: string; count: number; categoryId: string; inquiryIds: string[] }[];
  byAssignee: { assignee: string; open: number; overdue: number; resolved: number; avgResolutionHours: Metric<number> }[];
  /** 自動分類の採用率 (担当者が候補を変更しなかった割合) */
  classificationAcceptance: Metric<{ category: number; priority: number }>;
}

export function resolutionHours(i: Inquiry): number | null {
  if (!i.resolvedAt) return null;
  const ms = new Date(i.resolvedAt).getTime() - new Date(i.receivedAt).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms / 3_600_000 : null;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function durationMetric(values: number[], agg: (xs: number[]) => number): Metric<number> {
  if (values.length < MIN_SAMPLES_FOR_DURATION) return { status: 'insufficient', sample: values.length, required: MIN_SAMPLES_FOR_DURATION };
  return { status: 'ok', value: Math.round(agg(values) * 10) / 10, sample: values.length };
}

/** 件名の類似度でまとめる貪欲クラスタリング (同じカテゴリ内のみ) */
function clusterFrequent(inquiries: Inquiry[]) {
  const clusters: { rep: Inquiry; bg: Set<string>; members: Inquiry[] }[] = [];
  const sorted = [...inquiries].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  for (const inq of sorted) {
    const bg = bigrams(inq.title);
    const hit = clusters.find((c) => c.rep.categoryId === inq.categoryId && diceSimilarity(c.bg, bg) >= 0.45);
    if (hit) hit.members.push(inq);
    else clusters.push({ rep: inq, bg, members: [inq] });
  }
  return clusters
    .filter((c) => c.members.length >= MIN_CLUSTER_SIZE)
    .sort((a, b) => b.members.length - a.members.length)
    .slice(0, 5)
    .map((c) => ({ title: c.rep.title, count: c.members.length, categoryId: c.rep.categoryId, inquiryIds: c.members.map((m) => m.id) }));
}

export function computeHelpdeskStats(inquiries: Inquiry[], categories: InquiryCategory[], today: ISODate): HelpdeskStats {
  const count = (s: Inquiry['status']) => inquiries.filter((i) => i.status === s).length;
  const isOpen = (i: Inquiry) => i.status !== 'resolved' && i.status !== 'closed';
  const durations = inquiries.map(resolutionHours).filter((h): h is number => h !== null);

  const byCategory = [...categories]
    .sort((a, b) => a.order - b.order)
    .map((c) => ({
      categoryId: c.id,
      name: c.name,
      count: inquiries.filter((i) => i.categoryId === c.id).length,
      open: inquiries.filter((i) => i.categoryId === c.id && isOpen(i)).length,
    }))
    .filter((c) => c.count > 0);

  const assignees = [...new Set(inquiries.map((i) => i.assignee.trim() || '（未割当）'))];
  const byAssignee = assignees
    .map((a) => {
      const mine = inquiries.filter((i) => (i.assignee.trim() || '（未割当）') === a);
      const d = mine.map(resolutionHours).filter((h): h is number => h !== null);
      return {
        assignee: a,
        open: mine.filter(isOpen).length,
        overdue: mine.filter((i) => isInquiryOverdue(i, today)).length,
        resolved: mine.filter((i) => !isOpen(i)).length,
        avgResolutionHours: durationMetric(d, mean),
      };
    })
    .sort((x, y) => y.open - x.open || y.resolved - x.resolved);

  const classified = inquiries.filter((i) => i.classification);
  const acceptance: Metric<{ category: number; priority: number }> =
    classified.length < 5
      ? { status: 'insufficient', sample: classified.length, required: 5 }
      : {
          status: 'ok',
          sample: classified.length,
          value: {
            category: Math.round((classified.filter((i) => i.classification!.categoryAccepted).length / classified.length) * 100),
            priority: Math.round((classified.filter((i) => i.classification!.priorityAccepted).length / classified.length) * 100),
          },
        };

  return {
    total: inquiries.length,
    newCount: count('new'),
    inProgressCount: count('in_progress'),
    waitingCount: count('waiting'),
    onHoldCount: count('on_hold'),
    resolvedCount: count('resolved'),
    closedCount: count('closed'),
    openCount: inquiries.filter(isOpen).length,
    overdueCount: inquiries.filter((i) => isInquiryOverdue(i, today)).length,
    byCategory,
    byPriority: PRIORITIES.map((p) => ({ priority: p, count: inquiries.filter((i) => i.priority === p).length, open: inquiries.filter((i) => i.priority === p && isOpen(i)).length })),
    avgResolutionHours: durationMetric(durations, mean),
    medianResolutionHours: durationMetric(durations, median),
    frequent: clusterFrequent(inquiries),
    byAssignee,
    classificationAcceptance: acceptance,
  };
}

/** 時間を「3.5時間」「2.1日」のように表示 */
export function formatHours(h: number): string {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}分`;
  if (h < 48) return `${Math.round(h * 10) / 10}時間`;
  return `${Math.round((h / 24) * 10) / 10}日`;
}
