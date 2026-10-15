/**
 * 通知センター: WorkCore 全体の通知を横断して確認する。
 * - 未処理: 対応が終わるまで残る (読んでも減らない)。ナビのバッジの合計と同じ
 * - 未読: まだ開いていない通知 (お知らせを含む)。既読にすると減る
 * - 履歴: 原因が解消した通知 (直近30日)
 */
import { useMemo } from 'react';
import { Bell, CheckCheck, History } from 'lucide-react';
import { useQueryState } from '../app/hooks';
import { useAppData } from '../app/AppData';
import { NOTICE_KIND_DESC, NOTICE_KIND_LABEL, NOTICE_MODULE_HREF, NOTICE_MODULE_LABEL, isUnread, type NoticeKind, type NoticeModule } from '../domain/notifications';
import { NOTICE_KIND_UI, NoticeKindChip, NoticeRow, formatNoticeAt } from '../ui/notices';
import { Button, Card, EmptyState, FilterSelect, PageHeader, cx } from '../ui/primitives';

type View = 'open' | 'unread' | 'history';
const KINDS: NoticeKind[] = ['overdue', 'approval', 'review', 'attention', 'info'];
const MODULES = Object.keys(NOTICE_MODULE_LABEL) as NoticeModule[];

export function NotificationsPage() {
  const { notices, noticeState, unreadCount, markNoticesRead } = useAppData();
  const [f, setF] = useQueryState({ view: 'open', module: '', kind: '' });
  const view = (['open', 'unread', 'history'].includes(f.view) ? f.view : 'open') as View;
  const match = (m: string, k: string) => (!f.module || m === f.module) && (!f.kind || k === f.kind);

  const open = notices.filter((n) => n.actionable);
  const unread = notices.filter((n) => isUnread(noticeState, n.id));
  const history = useMemo(
    () =>
      Object.entries(noticeState.log)
        .filter(([, e]) => e.resolvedAt)
        .map(([id, e]) => ({ id, ...e }))
        .sort((a, b) => b.resolvedAt!.localeCompare(a.resolvedAt!)),
    [noticeState],
  );
  const list = (view === 'open' ? open : unread).filter((n) => match(n.module, n.kind));
  const hist = history.filter((h) => match(h.module, h.kind));

  const tabs: { key: View; label: string; count: number; desc: string }[] = [
    { key: 'open', label: '未処理', count: open.length, desc: '対応が終わるまで残ります（読んだだけでは減りません）。ナビの件数の合計です' },
    { key: 'unread', label: '未読', count: unreadCount, desc: 'まだ開いていない通知です。開くか「すべて既読にする」で減ります。お知らせは既読で一覧から外れます' },
    { key: 'history', label: '解消済み', count: history.length, desc: '原因が解消した通知の履歴（直近30日）' },
  ];
  const current = tabs.find((t) => t.key === view)!;

  return (
    <>
      <PageHeader title="通知センター" description="WorkCore 全体の「対応が必要なこと」とお知らせ。押すと対象の画面へ移動します" />

      <div className="mb-3 grid grid-cols-3 gap-2" role="tablist" aria-label="通知の表示">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={view === t.key}
            onClick={() => setF({ view: t.key })}
            className={cx(
              'flex min-h-14 flex-col items-center justify-center rounded-xl border text-sm font-semibold transition-colors',
              view === t.key ? 'border-navy-700 bg-navy-700 text-white dark:border-navy-400 dark:bg-navy-500' : 'border-slate-200 bg-white text-slate-600 dark:border-navy-700 dark:bg-navy-900 dark:text-slate-300',
            )}
            data-testid={`notices-tab-${t.key}`}
          >
            <span className="text-lg font-bold tabular-nums leading-tight" data-testid={`notices-count-${t.key}`}>
              {t.count}
            </span>
            {t.label}
          </button>
        ))}
      </div>
      <p className="mb-3 px-1 text-xs text-slate-500">{current.desc}</p>

      <Card className="p-3 sm:p-4">
        <div className="grid grid-cols-2 gap-2">
          <FilterSelect label="機能" value={f.module} onChange={(v) => setF({ module: v })} options={[{ value: '', label: 'すべての機能' }, ...MODULES.map((m) => ({ value: m, label: NOTICE_MODULE_LABEL[m] }))]} />
          <FilterSelect label="種類" value={f.kind} onChange={(v) => setF({ kind: v })} options={[{ value: '', label: 'すべての種類' }, ...KINDS.map((k) => ({ value: k, label: NOTICE_KIND_LABEL[k] }))]} />
        </div>
        {f.module && (
          <a href={NOTICE_MODULE_HREF[f.module as NoticeModule]} className="mt-2 inline-flex min-h-9 items-center text-xs font-semibold text-navy-600 dark:text-navy-300">
            {NOTICE_MODULE_LABEL[f.module as NoticeModule]}の画面へ →
          </a>
        )}
      </Card>

      {view === 'unread' && unread.length > 0 && (
        <div className="mt-3 flex justify-end">
          <Button variant="secondary" icon={CheckCheck} onClick={() => markNoticesRead(unread.map((n) => n.id))} data-testid="mark-all-read">
            すべて既読にする
          </Button>
        </div>
      )}

      <Card className="mt-3 overflow-hidden" data-testid="notice-list">
        {view !== 'history' ? (
          list.length === 0 ? (
            <EmptyState icon={Bell} title={view === 'open' ? '対応が必要な通知はありません' : '未読の通知はありません'} description={f.module || f.kind ? '絞り込みを解除すると他の通知が表示される場合があります' : undefined} />
          ) : (
            <ul className="divide-y divide-slate-100 px-2 py-1 dark:divide-navy-800">
              {list.map((n) => (
                <NoticeRow key={n.id} notice={n} />
              ))}
            </ul>
          )
        ) : hist.length === 0 ? (
          <EmptyState icon={History} title="解消済みの通知はありません" />
        ) : (
          <ul className="divide-y divide-slate-100 px-2 py-1 dark:divide-navy-800" data-testid="notice-history">
            {hist.map((h) => (
              <li key={h.id} data-testid="history-row" data-notice-id={h.id}>
                <a href={h.href} className="flex min-h-14 items-start gap-3 rounded-xl px-2 py-2.5 hover:bg-slate-50 dark:hover:bg-navy-800/60">
                  <span className={cx('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full ring-1 ring-inset', NOTICE_KIND_UI.done.chip)}>
                    <CheckCheck className="size-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <NoticeKindChip kind="done" />
                      <span className="text-[11px] text-slate-500">
                        元の種類：{NOTICE_KIND_LABEL[h.kind]}・{NOTICE_MODULE_LABEL[h.module]}
                      </span>
                    </span>
                    <span className="mt-0.5 block font-semibold leading-snug text-slate-700 dark:text-slate-200">{h.title}</span>
                    <span className="mt-0.5 block text-[11px] text-slate-400">
                      検出 {formatNoticeAt(h.firstAt)} → 解消 {formatNoticeAt(h.resolvedAt!)}
                    </span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="mt-4 p-4">
        <p className="mb-2 text-sm font-bold">通知の種類と件数の意味</p>
        <ul className="space-y-1.5 text-xs text-slate-600 dark:text-slate-300">
          {KINDS.map((k) => (
            <li key={k} className="flex items-start gap-2">
              <NoticeKindChip kind={k} />
              <span>{NOTICE_KIND_DESC[k]}</span>
            </li>
          ))}
          <li className="flex items-start gap-2">
            <NoticeKindChip kind="done" />
            <span>原因が解消した通知（履歴に残ります）</span>
          </li>
        </ul>
        <p className="mt-2 text-[11px] text-slate-500">ナビの数字は「未処理」の件数です（期限超過を含む場合だけ赤）。お知らせは数えません。通知はこの端末のデータから自動で作られ、外部には送信されません。</p>
      </Card>
    </>
  );
}
