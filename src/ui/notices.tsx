/**
 * 通知の共通表示部品。どの画面でも同じ見た目・同じ意味で表示する。
 * - 種類は色だけでなくアイコンとラベルでも区別する (赤は「期限超過」だけに使う)
 * - 各通知は「何が起きたか (タイトル)・なぜ (理由)・何をするか (操作)」を必ず表示し、押すと対象へ移動する
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlarmClock, AlertTriangle, Bell, CheckCircle2, ChevronDown, ChevronRight, Inbox, Info, ShieldCheck, type LucideIcon } from 'lucide-react';
import { useAppData } from '../app/AppData';
import { parseHash } from '../app/router';
import { formatDateJa, formatDateTimeJa } from '../domain/date';
import { NOTICE_KIND_LABEL, NOTICE_MODULE_LABEL, isUnread, type AppNotice, type NoticeKind, type NoticeModule } from '../domain/notifications';
import { cx } from './primitives';

export const NOTICE_KIND_UI: Record<NoticeKind | 'done', { icon: LucideIcon; label: string; chip: string; dot: string }> = {
  overdue: { icon: AlarmClock, label: NOTICE_KIND_LABEL.overdue, chip: 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-950 dark:text-red-200 dark:ring-red-900', dot: 'bg-red-600 text-white' },
  approval: { icon: ShieldCheck, label: NOTICE_KIND_LABEL.approval, chip: 'bg-violet-50 text-violet-800 ring-violet-200 dark:bg-violet-950 dark:text-violet-200 dark:ring-violet-900', dot: 'bg-violet-600 text-white' },
  review: { icon: Inbox, label: NOTICE_KIND_LABEL.review, chip: 'bg-navy-50 text-navy-800 ring-navy-200 dark:bg-navy-800 dark:text-navy-100 dark:ring-navy-700', dot: 'bg-navy-700 text-white dark:bg-navy-400 dark:text-navy-950' },
  attention: { icon: AlertTriangle, label: NOTICE_KIND_LABEL.attention, chip: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-900', dot: 'bg-amber-500 text-navy-950' },
  info: { icon: Info, label: NOTICE_KIND_LABEL.info, chip: 'bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700', dot: 'bg-slate-500 text-white' },
  done: { icon: CheckCircle2, label: '完了', chip: 'bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-900', dot: 'bg-emerald-600 text-white' },
};

export function NoticeKindChip({ kind }: { kind: NoticeKind | 'done' }) {
  const ui = NOTICE_KIND_UI[kind];
  return (
    <span className={cx('inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset', ui.chip)} data-kind={kind}>
      <ui.icon className="size-3" aria-hidden />
      {ui.label}
    </span>
  );
}

/** ナビゲーションの件数バッジ。色は最も重い種類 (期限超過がある時だけ赤) */
export function NavCountBadge({ count, worst, label, className }: { count: number; worst: NoticeKind | null; label: string; className?: string }) {
  if (count <= 0) return null;
  return (
    <span className={cx('min-w-[1.25rem] rounded-full px-1.5 text-center text-[11px] font-bold leading-5', NOTICE_KIND_UI[worst ?? 'review'].dot, className)} aria-label={label} data-testid="nav-badge" data-kind={worst ?? ''}>
      {count > 99 ? '99+' : count}
    </span>
  );
}

export const formatNoticeAt = (at: string) => (at.includes('T') ? formatDateTimeJa(at) : formatDateJa(at));

/** 通知1件。押すと既読にして対象へ移動する */
export function NoticeRow({ notice, showModule = true, compact = false }: { notice: AppNotice; showModule?: boolean; compact?: boolean }) {
  const { noticeState, markNoticesRead } = useAppData();
  const unread = isUnread(noticeState, notice.id);
  const ui = NOTICE_KIND_UI[notice.kind];
  return (
    <li data-testid="notice-row" data-notice-id={notice.id} data-notice-type={notice.type} data-unread={unread ? 'true' : 'false'}>
      <a
        href={notice.href}
        onClick={() => markNoticesRead([notice.id])}
        className="flex min-h-14 items-start gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-slate-50 active:bg-slate-100 dark:hover:bg-navy-800/60 dark:active:bg-navy-800"
      >
        <span className={cx('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full ring-1 ring-inset', ui.chip)}>
          <ui.icon className="size-4" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <NoticeKindChip kind={notice.kind} />
            {showModule && <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">{NOTICE_MODULE_LABEL[notice.module]}</span>}
            {unread && (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-navy-700 dark:text-navy-200">
                <span className="size-1.5 rounded-full bg-navy-600 dark:bg-navy-300" aria-hidden />
                未読
              </span>
            )}
          </span>
          <span className="mt-0.5 block font-semibold leading-snug text-slate-800 dark:text-slate-100">{notice.title}</span>
          <span className="mt-0.5 block text-xs leading-relaxed text-slate-600 dark:text-slate-300">
            <span className="sr-only">理由：</span>
            {notice.reason}
          </span>
          {!compact && (
            <span className="mt-0.5 block text-xs font-semibold text-navy-700 dark:text-navy-200">
              <span className="sr-only">必要な操作：</span>→ {notice.action}
            </span>
          )}
          <span className="mt-0.5 block text-[11px] text-slate-400">{formatNoticeAt(notice.at)}</span>
        </span>
        <ChevronRight className="mt-2 size-4 shrink-0 text-slate-300" aria-hidden />
      </a>
    </li>
  );
}

/**
 * 画面上部の「要対応」セクション。ナビのバッジと同じ件数・同じ対象を表示する。
 * 件数が多い場合は先頭だけ表示し、残りはその場で展開できる。
 */
export function AttentionSection({
  modules,
  title = '要対応',
  description,
  limit = 3,
  testId = 'attention-section',
  children,
}: {
  modules: NoticeModule[];
  title?: string;
  description?: string;
  limit?: number;
  testId?: string;
  /** 一覧の代わりに独自の表示 (例: タスクの行) を出す場合 */
  children?: (items: AppNotice[], expanded: boolean) => ReactNode;
}) {
  const { notices } = useAppData();
  const items = useMemo(() => notices.filter((n) => n.actionable && modules.includes(n.module)), [notices, modules]);
  const [expanded, setExpanded] = useState(false);
  if (!items.length) return null;
  const shown = expanded ? items : items.slice(0, limit);
  const kinds = (['overdue', 'approval', 'review', 'attention'] as NoticeKind[]).map((k) => [k, items.filter((n) => n.kind === k).length] as const).filter(([, c]) => c > 0);
  return (
    <section className="mb-4 rounded-2xl border border-navy-200 bg-white shadow-sm dark:border-navy-700 dark:bg-navy-900" data-testid={testId} aria-labelledby={`${testId}-title`}>
      <div className="flex flex-wrap items-center gap-2 px-4 pt-3 sm:px-5">
        <Bell className="size-4 text-navy-700 dark:text-navy-200" aria-hidden />
        <h2 id={`${testId}-title`} className="text-sm font-bold">
          {title} <span data-testid={`${testId}-count`}>{items.length}</span>件
        </h2>
        <span className="flex flex-wrap gap-1">
          {kinds.map(([k, c]) => (
            <span key={k} className="text-[11px] text-slate-500">
              <NoticeKindChip kind={k} /> {c}
            </span>
          ))}
        </span>
        <a href={`#/notifications?module=${modules.length === 1 ? modules[0] : ''}`} className="ml-auto inline-flex min-h-9 items-center text-xs font-semibold text-navy-600 dark:text-navy-300">
          通知センター
        </a>
      </div>
      <p className="px-4 pt-0.5 text-[11px] text-slate-500 sm:px-5">{description ?? 'ナビの件数の内訳です。対応が終わると自動で消えます（読んだだけでは減りません）'}</p>
      <div className="px-2 pb-2 sm:px-3">{children ? children(shown, expanded) : <ul className="divide-y divide-slate-100 dark:divide-navy-800">{shown.map((n) => <NoticeRow key={n.id} notice={n} showModule={modules.length > 1} />)}</ul>}</div>
      {items.length > limit && (
        <button type="button" onClick={() => setExpanded((v) => !v)} className="flex min-h-11 w-full items-center justify-center gap-1 border-t border-slate-100 text-xs font-semibold text-navy-600 dark:border-navy-800 dark:text-navy-300" aria-expanded={expanded} data-testid={`${testId}-more`}>
          <ChevronDown className={cx('size-4 transition-transform', expanded && 'rotate-180')} aria-hidden />
          {expanded ? '先頭だけ表示' : `残り ${items.length - limit}件を表示`}
        </button>
      )}
    </section>
  );
}

/**
 * 詳細画面の上部に、この対象に関する通知 (なぜ表示されているか・何をするか) を表示する。
 * 表示した時点で既読にする (未処理の件数は、対応が終わるまで変わらない)
 */
export function TargetNotices({ targetId, className }: { targetId: string; className?: string }) {
  const { notices, markNoticesRead } = useAppData();
  const here = parseHash(window.location.hash).path;
  const items = useMemo(() => notices.filter((n) => n.target.id === targetId), [notices, targetId]);
  const ids = items.map((n) => n.id).join(',');
  useEffect(() => {
    if (ids) markNoticesRead(ids.split(','));
  }, [ids, markNoticesRead]);
  if (!items.length) return null;
  return (
    <div className={cx('mb-3 space-y-2', className)} data-testid="target-notices">
      {items.map((n) => {
        const ui = NOTICE_KIND_UI[n.kind];
        return (
          <div key={n.id} className={cx('flex items-start gap-2.5 rounded-xl p-3 text-sm ring-1 ring-inset', ui.chip)} role="status" data-testid="target-notice" data-notice-type={n.type}>
            <ui.icon className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div className="min-w-0">
              <p className="font-bold">
                {ui.label}：{n.reason}
              </p>
              <p className="mt-0.5 text-xs">→ {n.action}</p>
              {/* 操作する画面が別なら、そこへ移動するボタンを出す (この画面で操作できる場合は出さない) */}
              {parseHash(n.href.slice(1)).path !== here && (
                <a
                  href={n.href}
                  className="mt-2 inline-flex min-h-11 items-center gap-1 rounded-lg bg-white px-3 text-sm font-semibold text-navy-800 shadow-sm ring-1 ring-inset ring-slate-200 dark:bg-navy-900 dark:text-white dark:ring-navy-700"
                  data-testid="target-notice-action"
                >
                  {n.actionLabel}
                  <ChevronRight className="size-4" aria-hidden />
                </a>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 通知から移動したが対象が見つからない場合の案内 */
export function MissingTargetNotice({ what, children }: { what: string; children?: ReactNode }) {
  return (
    <div className="mb-3 flex items-start gap-2.5 rounded-xl bg-slate-100 p-3 text-sm text-slate-700 dark:bg-navy-800 dark:text-slate-200" role="status" data-testid="missing-target">
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div>
        <p className="font-semibold">指定された{what}は見つかりませんでした</p>
        <p className="mt-0.5 text-xs">すでに対応が完了したか、削除・変更された可能性があります。{children}</p>
      </div>
    </div>
  );
}
