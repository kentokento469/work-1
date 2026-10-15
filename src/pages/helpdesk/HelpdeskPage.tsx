/**
 * ヘルプデスク: 問い合わせ一覧 / 分析。
 * 検索・絞り込み条件は URL に保存するため、詳細から戻っても条件が保たれる。
 */
import { useMemo } from 'react';
import { AttentionSection } from '../../ui/notices';
import { BarChart3, ChevronRight, Headset, List, Plus, Search, X } from 'lucide-react';
import { useAppData } from '../../app/AppData';
import { useQueryState } from '../../app/hooks';
import { navigate } from '../../app/router';
import { isInquiryOverdue } from '../../domain/helpdesk/inquiry';
import { normalizeText } from '../../domain/text';
import { diffDays, formatDateJa, formatDateTimeJa } from '../../domain/date';
import { PRIORITIES, PRIORITY_LABEL, PRIORITY_WEIGHT, type Inquiry } from '../../domain/types';
import { HelpdeskAnalytics } from '../../features/helpdesk/HelpdeskAnalytics';
import { CategoryBadge, InquiryStatusBadge } from '../../features/helpdesk/parts';
import { PriorityBadge } from '../../ui/badges';
import { Button, Card, EmptyState, FilterDisclosure, FilterSelect, PageHeader, cx } from '../../ui/primitives';

type StatusFilter = 'open' | 'new' | 'working' | 'overdue' | 'done' | 'all';
const STATUS_TABS: { key: StatusFilter; label: string; match: (i: Inquiry, today: string) => boolean }[] = [
  { key: 'open', label: '未解決', match: (i) => i.status !== 'resolved' && i.status !== 'closed' },
  { key: 'new', label: '新規', match: (i) => i.status === 'new' },
  { key: 'working', label: '対応中', match: (i) => ['in_progress', 'waiting', 'on_hold'].includes(i.status) },
  { key: 'overdue', label: '期限超過', match: (i, t) => isInquiryOverdue(i, t) },
  { key: 'done', label: '解決・完了', match: (i) => i.status === 'resolved' || i.status === 'closed' },
  { key: 'all', label: 'すべて', match: () => true },
];

const DEFAULTS = { view: 'list', status: 'open', q: '', category: '', priority: '', assignee: '', sort: 'priority' };

export function HelpdeskPage() {
  const { data, today, helpdeskStats } = useAppData();
  const [f, setF, reset] = useQueryState(DEFAULTS);

  const counts = useMemo(() => Object.fromEntries(STATUS_TABS.map((t) => [t.key, data.inquiries.filter((i) => t.match(i, today)).length])), [data.inquiries, today]);
  const taskStat = useMemo(() => {
    const m = new Map<string, { done: number; total: number }>();
    for (const t of data.tasks) {
      if (!t.inquiryId) continue;
      const c = m.get(t.inquiryId) ?? { done: 0, total: 0 };
      c.total++;
      if (t.status === 'done') c.done++;
      m.set(t.inquiryId, c);
    }
    return m;
  }, [data.tasks]);

  const list = useMemo(() => {
    const tab = STATUS_TABS.find((t) => t.key === f.status) ?? STATUS_TABS[0]!;
    const kw = normalizeText(f.q);
    return data.inquiries
      .filter((i) => tab.match(i, today))
      .filter((i) => !f.category || i.categoryId === f.category)
      .filter((i) => !f.priority || i.priority === f.priority)
      .filter((i) => !f.assignee || (i.assignee || '（未割当）') === f.assignee)
      .filter((i) => !kw || normalizeText(`${i.number} ${i.title} ${i.body} ${i.requesterName} ${i.assignee} ${i.resolution}`).includes(kw))
      .sort((a, b) => {
        if (f.sort === 'received') return b.receivedAt.localeCompare(a.receivedAt);
        if (f.sort === 'due') return a.dueDate.localeCompare(b.dueDate);
        // 優先対応順: 期限超過 → 優先度 → 期限
        const oa = isInquiryOverdue(a, today) ? 1 : 0;
        const ob = isInquiryOverdue(b, today) ? 1 : 0;
        return ob - oa || PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority] || a.dueDate.localeCompare(b.dueDate);
      });
  }, [data.inquiries, f, today]);

  const assignees = useMemo(() => [...new Set(data.inquiries.map((i) => i.assignee || '（未割当）'))].sort(), [data.inquiries]);
  const hasFilter = f.q || f.category || f.priority || f.assignee;
  const catById = useMemo(() => new Map(data.inquiryCategories.map((c) => [c.id, c])), [data.inquiryCategories]);

  return (
    <>
      <PageHeader
        title="ヘルプデスク"
        description={`未解決 ${helpdeskStats.openCount}件・期限超過 ${helpdeskStats.overdueCount}件・全 ${helpdeskStats.total}件`}
        actions={
          <Button icon={Plus} onClick={() => navigate('/helpdesk/new')} data-testid="new-inquiry">
            問い合わせを登録
          </Button>
        }
      />
      <AttentionSection modules={['helpdesk']} description="下部ナビ「問い合わせ」の件数の内訳です（期限超過・未受付）。対応が進むと自動で消えます" testId="helpdesk-attention" />

      <div className="mb-4 grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1 sm:inline-grid dark:bg-navy-900" role="tablist">
        {(
          [
            ['list', '問い合わせ一覧', List],
            ['analytics', '分析', BarChart3],
          ] as const
        ).map(([key, label, Icon]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={f.view === key}
            onClick={() => setF({ view: key })}
            className={cx(
              'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition-colors',
              f.view === key ? 'bg-white text-navy-900 shadow-sm dark:bg-navy-700 dark:text-white' : 'text-slate-500 dark:text-slate-400',
            )}
          >
            <Icon className="size-4" aria-hidden />
            {label}
          </button>
        ))}
      </div>

      {f.view === 'analytics' ? (
        <HelpdeskAnalytics />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label="ステータスで絞り込み">
            {STATUS_TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={f.status === t.key}
                onClick={() => setF({ status: t.key })}
                className={cx(
                  'inline-flex min-h-10 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-semibold transition-colors',
                  f.status === t.key
                    ? 'border-navy-800 bg-navy-800 text-white dark:border-navy-400 dark:bg-navy-500'
                    : 'border-slate-200 bg-white text-slate-600 dark:border-navy-700 dark:bg-navy-900 dark:text-slate-300',
                  t.key === 'overdue' && counts.overdue! > 0 && f.status !== t.key && 'border-red-200 text-red-600 dark:border-red-900 dark:text-red-400',
                )}
              >
                {t.label}
                <span className={cx('rounded-full px-1.5 text-[11px] tabular-nums', f.status === t.key ? 'bg-white/20' : 'bg-slate-100 dark:bg-navy-800')}>{counts[t.key]}</span>
              </button>
            ))}
          </div>

          <Card className="p-3 sm:p-4">
            <div className="grid grid-cols-[1fr_auto] gap-2 md:grid-cols-[1fr_10rem_8rem_9rem_9rem]">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
                <input
                  type="search"
                  value={f.q}
                  onChange={(e) => setF({ q: e.target.value })}
                  placeholder="番号・件名・申請者・内容で検索"
                  aria-label="問い合わせを検索"
                  className="h-11 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 shadow-sm focus:border-navy-500 focus:outline-none focus:ring-2 focus:ring-navy-500/25 dark:border-navy-700 dark:bg-navy-950"
                />
              </div>
              <FilterDisclosure activeCount={[f.category, f.priority, f.assignee].filter(Boolean).length + (f.sort !== 'priority' ? 1 : 0)} className="col-span-2">
                <FilterSelect label="カテゴリ" value={f.category} onChange={(v) => setF({ category: v })} options={[{ value: '', label: '全カテゴリ' }, ...data.inquiryCategories.map((c) => ({ value: c.id, label: c.name }))]} />
                <FilterSelect label="優先度" value={f.priority} onChange={(v) => setF({ priority: v })} options={[{ value: '', label: '全優先度' }, ...PRIORITIES.map((p) => ({ value: p, label: `優先度 ${PRIORITY_LABEL[p]}` }))]} />
                <FilterSelect label="担当者" value={f.assignee} onChange={(v) => setF({ assignee: v })} options={[{ value: '', label: '全担当者' }, ...assignees.map((a) => ({ value: a, label: a }))]} />
                <FilterSelect
                  label="並び順"
                  value={f.sort}
                  onChange={(v) => setF({ sort: v })}
                  options={[
                    { value: 'priority', label: '優先対応順' },
                    { value: 'received', label: '受付が新しい順' },
                    { value: 'due', label: '期限が近い順' },
                  ]}
                />
              </FilterDisclosure>
            </div>
            <div className="mt-2 flex items-center justify-between px-1 text-xs text-slate-500">
              <span data-testid="inquiry-count">{list.length}件を表示</span>
              {hasFilter && (
                <button type="button" className="inline-flex min-h-9 items-center gap-1 font-semibold text-navy-600 dark:text-navy-300" onClick={() => setF({ q: '', category: '', priority: '', assignee: '' })}>
                  <X className="size-3.5" />
                  条件をクリア
                </button>
              )}
            </div>
          </Card>

          <Card className="mt-3 overflow-hidden">
            {list.length === 0 ? (
              <EmptyState
                icon={Headset}
                title={data.inquiries.length === 0 ? '問い合わせはまだありません' : '条件に一致する問い合わせはありません'}
                description={data.inquiries.length === 0 ? '「問い合わせを登録」から受け付けを始めましょう（データ管理画面からデモデータも追加できます）' : undefined}
                action={
                  hasFilter || f.status !== 'open' ? (
                    <Button variant="secondary" onClick={reset}>
                      条件をリセット
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-navy-800" data-testid="inquiry-list">
                {list.map((i) => {
                  const overdue = isInquiryOverdue(i, today);
                  const ts = taskStat.get(i.id);
                  return (
                    <li key={i.id} className={cx('relative', overdue && 'bg-red-50/40 dark:bg-red-950/20')} data-inquiry-title={i.title}>
                      {overdue && <span className="absolute inset-y-0 left-0 w-1 bg-red-500" aria-hidden />}
                      <a href={`#/helpdesk/${i.id}`} className="flex items-start gap-3 px-4 py-3 active:bg-slate-50 sm:px-5 dark:active:bg-navy-800">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-mono text-[11px] text-slate-400">{i.number}</span>
                            <InquiryStatusBadge status={i.status} />
                            <PriorityBadge priority={i.priority} />
                            <CategoryBadge category={catById.get(i.categoryId)} />
                          </div>
                          <p className="mt-1 font-semibold leading-snug text-slate-800 dark:text-slate-100">{i.title}</p>
                          <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-slate-500 dark:text-slate-400">
                            <span>{i.requesterName}</span>
                            <span>{formatDateTimeJa(i.receivedAt)} 受付</span>
                            <span className={cx(overdue && 'font-semibold text-red-600 dark:text-red-400')}>
                              期限 {formatDateJa(i.dueDate)}
                              {overdue && `（${diffDays(i.dueDate, today)}日超過）`}
                            </span>
                            <span>担当 {i.assignee || '未割当'}</span>
                            {ts && (
                              <span>
                                タスク {ts.done}/{ts.total}
                              </span>
                            )}
                          </p>
                        </div>
                        <ChevronRight className="mt-6 size-4 shrink-0 text-slate-300" aria-hidden />
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </>
      )}
    </>
  );
}
