/**
 * 共通の通知モデル。
 *
 * 通知はすべて実データから毎回導出する (保存した件数やダミーは使わない)。
 * - 同じ原因 (= 同じ対象 × 同じ種類) からは同じ ID の通知が1件だけできる → 重複しない
 * - 原因が解消すれば (タスク完了・問い合わせ解決・承認など) 次の導出で消える → 残留しない
 * - 対象データが削除されれば通知も消える → 参照切れにならない
 *
 * 「未処理」と「未読」は別物として扱う:
 * - 未処理 (actionable): 業務の対応が終わるまで残る。読んだだけでは減らない。ナビのバッジはこの件数
 * - 未読: 通知を開いた (対象を表示した) かどうか。お知らせ (info) は既読で一覧から外れる
 */
import { diffDays } from './date';
import { isTaskOverdue } from './analytics';
import { isInquiryOverdue } from './helpdesk/inquiry';
import { DOCUMENT_TYPE_LABEL } from './documents/types';
import { PRIORITY_LABEL, type DataSnapshot, type ISODate } from './types';
import type { StockStatus } from './inventory/stock';
import type { AutomationProposal } from '../automation/engine';

/** 通知の種類 (見た目と件数の意味を決める) */
export type NoticeKind = 'overdue' | 'approval' | 'review' | 'attention' | 'info';
/** 発生元の機能 */
export type NoticeModule = 'tasks' | 'helpdesk' | 'inventory' | 'documents' | 'automation' | 'onboarding';

export interface AppNotice {
  /** 原因ごとに一意 (`種類:対象ID`)。同じ原因からは同じ ID になる */
  id: string;
  type: NoticeType;
  kind: NoticeKind;
  module: NoticeModule;
  target: { type: 'task' | 'inquiry' | 'item' | 'purchaseOrder' | 'document' | 'proposal' | 'employee' | 'automationRun'; id: string };
  title: string;
  /** なぜ通知されているか */
  reason: string;
  /** 何をすればよいか */
  action: string;
  /** 発生日時 (期限・受付日時・作成日時など、原因が生じた時点) */
  at: string;
  /** 1 = 高い。並び順に使う */
  priority: 1 | 2 | 3;
  /** 遷移先 (ディープリンク。対象を強調表示するための focus を含む) */
  href: string;
  /** 未処理件数に含めるか (false = お知らせ) */
  actionable: boolean;
}

export type NoticeType =
  | 'task_overdue'
  | 'inquiry_overdue'
  | 'inquiry_new'
  | 'stock_shortage'
  | 'po_approval'
  | 'document_review'
  | 'automation_proposal'
  | 'hire_unprepared'
  | 'automation_auto_run';

export const NOTICE_KIND_LABEL: Record<NoticeKind, string> = {
  overdue: '期限超過',
  approval: '承認待ち',
  review: '未処理',
  attention: '注意',
  info: 'お知らせ',
};
export const NOTICE_KIND_DESC: Record<NoticeKind, string> = {
  overdue: '対応期限を過ぎています',
  approval: 'あなたの判断（承認・見送り）が必要です',
  review: '受付・確認などの対応が終わっていません',
  attention: '確認しておくべき状態です',
  info: '自動で行われた処理などのお知らせです（対応は不要）',
};
export const NOTICE_MODULE_LABEL: Record<NoticeModule, string> = {
  tasks: 'タスク',
  helpdesk: 'ヘルプデスク',
  inventory: '在庫・購買',
  documents: '書類',
  automation: '自動化センター',
  onboarding: '入社準備',
};
/** 機能ごとの画面 (通知一覧の「機能の画面へ」) */
export const NOTICE_MODULE_HREF: Record<NoticeModule, string> = {
  tasks: '#/tasks',
  helpdesk: '#/helpdesk',
  inventory: '#/inventory',
  documents: '#/documents',
  automation: '#/automation',
  onboarding: '#/onboarding',
};

/** ナビゲーションの項目 → その項目のバッジに含める機能 */
export const NAV_NOTICE_MODULES: Record<string, NoticeModule[]> = {
  tasks: ['tasks'],
  helpdesk: ['helpdesk'],
  inventory: ['inventory'],
  documents: ['documents'],
  automation: ['automation'],
  onboarding: ['onboarding'],
  // スマホのメニュー: 下部ナビに無い画面の通知をまとめる
  menu: ['documents', 'automation', 'onboarding'],
};

/** 自動化提案の通知・強調表示で使う識別子 */
export const proposalFocusId = (p: Pick<AutomationProposal, 'automationId' | 'key'>) => `${p.automationId}|${p.key}`;

const KIND_ORDER: Record<NoticeKind, number> = { overdue: 0, approval: 1, review: 2, attention: 3, info: 4 };
const fmtDate = (iso: string) => {
  const [, m, d] = iso.slice(0, 10).split('-');
  return `${Number(m)}/${Number(d)}`;
};

export interface NoticeInput {
  data: DataSnapshot;
  today: ISODate;
  stock: Map<string, StockStatus>;
  /** 有効なルールの承認待ち提案 (AppData と同じもの) */
  proposals: AutomationProposal[];
  /** お知らせとして表示する期間 (日) */
  infoDays?: number;
}

/** 実データから通知を導出する (純粋関数) */
export function deriveNotices({ data, today, stock, proposals, infoDays = 7 }: NoticeInput): AppNotice[] {
  const out: AppNotice[] = [];
  const empName = new Map(data.employees.map((e) => [e.id, e.name]));

  // タスク: 期限超過
  for (const t of data.tasks) {
    if (!isTaskOverdue(t, today)) continue;
    const days = diffDays(t.dueDate, today);
    const who = t.employeeId ? `（${empName.get(t.employeeId) ?? '対象社員'}）` : '';
    out.push({
      id: `task_overdue:${t.id}`,
      type: 'task_overdue',
      kind: 'overdue',
      module: 'tasks',
      target: { type: 'task', id: t.id },
      title: `${t.title}${who}`,
      reason: `期限 ${fmtDate(t.dueDate)} を${days}日過ぎています（優先度 ${PRIORITY_LABEL[t.priority]}・担当 ${t.assignee || '未設定'}）`,
      action: 'タスクを完了にする、または期限・担当を見直してください',
      at: t.dueDate,
      priority: t.priority === 'high' || days >= 7 ? 1 : 2,
      href: `#/tasks?focus=${encodeURIComponent(t.id)}`,
      actionable: true,
    });
  }

  // 問い合わせ: 期限超過 / 新規 (未受付)。両方に当てはまる問い合わせは期限超過の1件だけ (二重に数えない)
  for (const i of data.inquiries) {
    if (isInquiryOverdue(i, today)) {
      const days = diffDays(i.dueDate, today);
      out.push({
        id: `inquiry_overdue:${i.id}`,
        type: 'inquiry_overdue',
        kind: 'overdue',
        module: 'helpdesk',
        target: { type: 'inquiry', id: i.id },
        title: `${i.number} ${i.title}`,
        reason: `回答期限 ${fmtDate(i.dueDate)} を${days}日過ぎています（申請者 ${i.requesterName}）`,
        action: '対応を進めて解決する、または申請者に状況を連絡してください',
        at: i.dueDate,
        priority: 1,
        href: `#/helpdesk/${encodeURIComponent(i.id)}`,
        actionable: true,
      });
    } else if (i.status === 'new') {
      out.push({
        id: `inquiry_new:${i.id}`,
        type: 'inquiry_new',
        kind: 'review',
        module: 'helpdesk',
        target: { type: 'inquiry', id: i.id },
        title: `${i.number} ${i.title}`,
        reason: `新しい問い合わせがまだ受け付けられていません（申請者 ${i.requesterName}・優先度 ${PRIORITY_LABEL[i.priority]}）`,
        action: '内容を確認して「受け付ける」を押してください',
        at: i.receivedAt,
        priority: i.priority === 'high' ? 1 : 2,
        href: `#/helpdesk/${encodeURIComponent(i.id)}`,
        actionable: true,
      });
    }
  }

  // 在庫: 不足
  for (const item of data.items) {
    const s = stock.get(item.id);
    if (!item.active || !s?.shortage) continue;
    out.push({
      id: `stock_shortage:${item.id}`,
      type: 'stock_shortage',
      kind: 'attention',
      module: 'inventory',
      target: { type: 'item', id: item.id },
      title: `${item.name} の在庫不足`,
      reason: `利用可能 ${s.available}${item.unit}（最低在庫 ${item.minStock}${item.unit}${s.backorder ? `・入荷待ち ${s.backorder}${item.unit}` : ''}${s.onOrder ? `・発注残 ${s.onOrder}${item.unit}` : ''}）`,
      action: s.recommendedQty > 0 ? `発注候補（推奨 ${s.recommendedQty}${item.unit}）から発注書を作成してください` : '発注済みの入荷を待つか、在庫を確認してください',
      at: today,
      priority: s.available <= 0 ? 1 : 2,
      href: `#/inventory/items/${encodeURIComponent(item.id)}`,
      actionable: true,
    });
  }

  // 発注書: 承認待ち
  for (const po of data.purchaseOrders) {
    if (po.status !== 'pending_approval') continue;
    const supplier = data.suppliers.find((s) => s.id === po.supplierId)?.name ?? '仕入先未設定';
    out.push({
      id: `po_approval:${po.id}`,
      type: 'po_approval',
      kind: 'approval',
      module: 'inventory',
      target: { type: 'purchaseOrder', id: po.id },
      title: `発注書 ${po.number}（${supplier}）`,
      reason: `承認申請されています（申請者 ${po.requestedBy || '未記入'}・${po.lines.length}品目）`,
      action: '内容を確認して承認、または差し戻してください（外部への発注は行われません）',
      at: po.updatedAt,
      priority: 2,
      href: `#/inventory/orders/${encodeURIComponent(po.id)}`,
      actionable: true,
    });
  }

  // 書類: 確認待ち
  for (const d of data.documents) {
    if (d.deletedAt || d.status !== 'needs_review') continue;
    const issuer = d.fields.issuer ? `・${d.fields.issuer}` : '';
    out.push({
      id: `document_review:${d.id}`,
      type: 'document_review',
      kind: 'review',
      module: 'documents',
      target: { type: 'document', id: d.id },
      title: `${DOCUMENT_TYPE_LABEL[d.type]} ${d.number}${issuer}`,
      reason: '取り込んだ書類の抽出内容がまだ確認されていません',
      action: '原本と照合して重要項目を確認し、「確認完了」にしてください',
      at: d.createdAt,
      priority: 2,
      href: `#/documents/${encodeURIComponent(d.id)}`,
      actionable: true,
    });
  }

  // 自動化: 承認待ちの提案
  for (const p of proposals) {
    const approvals = p.actions.filter((a) => a.requiresApproval).length;
    out.push({
      id: `automation_proposal:${proposalFocusId(p)}`,
      type: 'automation_proposal',
      kind: 'approval',
      module: 'automation',
      target: { type: 'proposal', id: proposalFocusId(p) },
      title: p.title,
      reason: p.conditions[0] ?? '実行条件を満たしました',
      action: `実行内容（${p.actions.length}件${approvals ? `・うち要承認 ${approvals}件` : ''}）を確認して、承認または見送りを選んでください`,
      at: today,
      priority: p.warnings.length ? 1 : 2,
      href: `#/automation?focus=${encodeURIComponent(proposalFocusId(p))}`,
      actionable: true,
    });
  }

  // 入社準備: 入社7日以内で準備タスクが残っている
  for (const e of data.employees) {
    if (e.status !== 'pending') continue;
    const days = diffDays(today, e.hireDate);
    if (days < 0 || days > 7) continue;
    const open = data.tasks.filter((t) => t.employeeId === e.id && t.source === 'onboarding' && t.status !== 'done');
    if (!open.length) continue;
    out.push({
      id: `hire_unprepared:${e.id}`,
      type: 'hire_unprepared',
      kind: 'attention',
      module: 'onboarding',
      target: { type: 'employee', id: e.id },
      title: `${e.name}さんの入社準備`,
      reason: `入社日 ${fmtDate(e.hireDate)}（${days === 0 ? '本日' : `あと${days}日`}）までに未完了の準備タスクが ${open.length}件あります`,
      action: '入社準備画面で未完了のタスクを確認し、完了させてください',
      at: e.hireDate,
      priority: days <= 3 ? 1 : 2,
      href: `#/onboarding?employee=${encodeURIComponent(e.id)}`,
      actionable: true,
    });
  }

  // お知らせ: 直近に自動で実行された処理
  for (const r of data.automationRuns) {
    if (r.status !== 'auto' || diffDays(r.at.slice(0, 10), today) > infoDays) continue;
    out.push({
      id: `automation_auto_run:${r.id}`,
      type: 'automation_auto_run',
      kind: 'info',
      module: 'automation',
      target: { type: 'automationRun', id: r.id },
      title: `自動実行：${r.title}`,
      reason: r.results.length ? r.results.slice(0, 2).join('、') : '自動化ルールにより実行されました',
      action: '内容を確認してください（対応は不要です）',
      at: r.at,
      priority: 3,
      href: `#/automation?focus=${encodeURIComponent(`run:${r.id}`)}`,
      actionable: false,
    });
  }

  return out.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.priority - b.priority || a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

/** ナビ項目ごとの未処理件数と、最も重い種類 (バッジの色に使う) */
export function navNoticeSummary(notices: AppNotice[], navKey: string): { count: number; worst: NoticeKind | null; items: AppNotice[] } {
  const mods = NAV_NOTICE_MODULES[navKey];
  if (!mods) return { count: 0, worst: null, items: [] };
  const items = notices.filter((n) => n.actionable && mods.includes(n.module));
  const worst = items.reduce<NoticeKind | null>((w, n) => (w === null || KIND_ORDER[n.kind] < KIND_ORDER[w] ? n.kind : w), null);
  return { count: items.length, worst, items };
}

// ---------------------------------------------------------------------------
// 既読・履歴 (端末内の設定ストアに保存)
// ---------------------------------------------------------------------------

export const NOTICE_SETTING_ID = 'notifications';

export interface NoticeLogEntry {
  title: string;
  type: NoticeType;
  kind: NoticeKind;
  module: NoticeModule;
  href: string;
  /** 最初に検出した日時 */
  firstAt: string;
  /** 原因が解消した日時 (未解消は null) */
  resolvedAt: string | null;
  /** 既読にした日時 */
  readAt: string | null;
}
export interface NoticeState {
  log: Record<string, NoticeLogEntry>;
}

export function readNoticeState(data: Pick<DataSnapshot, 'settings'>): NoticeState {
  const v = data.settings.find((s) => s.id === NOTICE_SETTING_ID)?.value as Partial<NoticeState> | undefined;
  return { log: v?.log && typeof v.log === 'object' ? v.log : {} };
}

const HISTORY_LIMIT = 300;
const HISTORY_DAYS = 30;

/**
 * 現在の通知と記録を突き合わせる (純粋関数)。
 * 新しい通知は記録に追加、消えた通知は解消済みに、再発した通知は未解消に戻す (既読は解除して再度知らせる)。
 * 変化がなければ changed = false (保存しない)。
 */
export function syncNoticeLog(state: NoticeState, notices: AppNotice[], now: string): { state: NoticeState; changed: boolean } {
  const log: Record<string, NoticeLogEntry> = { ...state.log };
  let changed = false;
  const current = new Set<string>();
  for (const n of notices) {
    current.add(n.id);
    const prev = log[n.id];
    if (!prev) {
      log[n.id] = { title: n.title, type: n.type, kind: n.kind, module: n.module, href: n.href, firstAt: now, resolvedAt: null, readAt: null };
      changed = true;
    } else if (prev.resolvedAt) {
      log[n.id] = { ...prev, title: n.title, kind: n.kind, href: n.href, resolvedAt: null, readAt: null, firstAt: now };
      changed = true;
    } else if (prev.title !== n.title || prev.kind !== n.kind) {
      log[n.id] = { ...prev, title: n.title, kind: n.kind, href: n.href };
      changed = true;
    }
  }
  for (const [id, e] of Object.entries(log)) {
    if (!current.has(id) && !e.resolvedAt) {
      log[id] = { ...e, resolvedAt: now };
      changed = true;
    }
  }
  // 古い解消済みの記録は削除する (容量を増やし続けない)
  const resolved = Object.entries(log)
    .filter(([, e]) => e.resolvedAt)
    .sort((a, b) => b[1].resolvedAt!.localeCompare(a[1].resolvedAt!));
  resolved.forEach(([id, e], idx) => {
    if (idx >= HISTORY_LIMIT || diffDays(e.resolvedAt!.slice(0, 10), now.slice(0, 10)) > HISTORY_DAYS) {
      delete log[id];
      changed = true;
    }
  });
  return { state: { log }, changed };
}

/** 既読にする (純粋関数)。記録に無い ID は無視 */
export function markNoticesRead(state: NoticeState, ids: string[], now: string): { state: NoticeState; changed: boolean } {
  const log = { ...state.log };
  let changed = false;
  for (const id of ids) {
    const e = log[id];
    if (e && !e.readAt) {
      log[id] = { ...e, readAt: now };
      changed = true;
    }
  }
  return { state: { log }, changed };
}

export function isUnread(state: NoticeState, id: string): boolean {
  return !state.log[id]?.readAt;
}
