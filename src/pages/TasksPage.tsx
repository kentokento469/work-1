import { useEffect, useMemo, useState } from 'react';
import { useQueryState } from '../app/hooks';
import { ClipboardList, Plus, Search, X } from 'lucide-react';
import { useAppData } from '../app/AppData';
import { isTaskOverdue } from '../domain/analytics';
import { PRIORITIES, PRIORITY_LABEL, PRIORITY_WEIGHT, TASK_STATUS_LABEL, type Task } from '../domain/types';
import { TaskFormModal } from '../features/TaskFormModal';
import { TaskItem } from '../features/TaskItem';
import { Button, Card, EmptyState, FilterDisclosure, FilterSelect, PageHeader, cx } from '../ui/primitives';
import { AttentionSection, MissingTargetNotice, TargetNotices } from '../ui/notices';
import { useFocusHighlight } from '../app/focus';
import type { NoticeModule } from '../domain/notifications';

const TASK_MODULES: NoticeModule[] = ['tasks'];

type StatusFilter = 'all' | 'open' | 'overdue' | 'todo' | 'in_progress' | 'on_hold' | 'done';
const STATUS_TABS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'すべて' },
  { key: 'open', label: '未完了' },
  { key: 'overdue', label: '期限超過' },
  { key: 'todo', label: TASK_STATUS_LABEL.todo },
  { key: 'in_progress', label: TASK_STATUS_LABEL.in_progress },
  { key: 'on_hold', label: TASK_STATUS_LABEL.on_hold },
  { key: 'done', label: TASK_STATUS_LABEL.done },
];

type SortKey = 'due' | 'priority' | 'updated';

export function TasksPage({ query }: { query: URLSearchParams }) {
  const { data, today, empById } = useAppData();
  // 検索条件は URL に保存し、他画面から戻っても保持する
  const [f, setF] = useQueryState({ status: 'open', q: '', priority: '', dept: '', employee: '', source: '', sort: 'due' });
  const status = (STATUS_TABS.some((t) => t.key === f.status) ? f.status : 'open') as StatusFilter;
  const { q: keyword, priority, dept, employee, source } = f;
  const sort = f.sort as SortKey;
  const setStatus = (v: StatusFilter) => setF({ status: v });
  const setKeyword = (v: string) => setF({ q: v });
  const setPriority = (v: string) => setF({ priority: v });
  const setDept = (v: string) => setF({ dept: v });
  const setEmployee = (v: string) => setF({ employee: v });
  const setSort = (v: SortKey) => setF({ sort: v });
  const [editing, setEditing] = useState<Task | null>(null);
  const [creating, setCreating] = useState(false);

  // 通知・ダッシュボード・関連情報から特定タスクへ (#/tasks?focus=id)
  const focusId = query.get('focus');
  const focusTask = focusId ? data.tasks.find((x) => x.id === focusId) : undefined;
  const [filterAdjusted, setFilterAdjusted] = useState(false);

  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = { all: data.tasks.length, open: 0, overdue: 0, todo: 0, in_progress: 0, on_hold: 0, done: 0 };
    for (const t of data.tasks) {
      c[t.status]++;
      if (t.status !== 'done') c.open++;
      if (isTaskOverdue(t, today)) c.overdue++;
    }
    return c;
  }, [data.tasks, today]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    const list = data.tasks.filter((t) => {
      if (status === 'open' && t.status === 'done') return false;
      if (status === 'overdue' && !isTaskOverdue(t, today)) return false;
      if (['todo', 'in_progress', 'on_hold', 'done'].includes(status) && t.status !== status) return false;
      if (priority && t.priority !== priority) return false;
      if (dept && t.assigneeDepartmentId !== dept) return false;
      if (employee && t.employeeId !== employee) return false;
      if (source && t.source !== source) return false;
      if (kw) {
        const e = t.employeeId ? empById.get(t.employeeId) : undefined;
        const hay = `${t.title} ${t.description} ${t.assignee} ${e?.name ?? ''}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
    return list.sort((a, b) => {
      if (sort === 'priority') return PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority] || a.dueDate.localeCompare(b.dueDate);
      if (sort === 'updated') return b.updatedAt.localeCompare(a.updatedAt);
      // 期限順: 完了は後ろへ
      const da = a.status === 'done' ? 1 : 0;
      const db = b.status === 'done' ? 1 : 0;
      return da - db || a.dueDate.localeCompare(b.dueDate) || PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority];
    });
  }, [data.tasks, status, priority, dept, employee, source, keyword, sort, today, empById]);

  // 対象が絞り込みで隠れていれば、条件を解除して表示する (期限超過のタスクは上の「要対応」に必ず表示される)
  const focusVisible = !!focusTask && (isTaskOverdue(focusTask, today) || filtered.some((t) => t.id === focusTask.id));
  useEffect(() => {
    if (!focusTask || focusVisible) return;
    setF({ status: 'all', q: '', priority: '', dept: '', employee: '', source: '' });
    setFilterAdjusted(true);
    // focusId が変わった時だけ調整する
  }, [focusId]);
  useFocusHighlight(focusTask ? focusId : null, focusVisible);

  const filteredEmployee = employee ? empById.get(employee) : undefined;
  const hasExtra = keyword || priority || dept || employee || source;

  return (
    <>
      <PageHeader
        title="タスク管理"
        description={`未完了 ${counts.open}件・期限超過 ${counts.overdue}件・完了 ${counts.done}件`}
        actions={
          <Button icon={Plus} onClick={() => setCreating(true)}>
            新規タスク
          </Button>
        }
      />

      {focusId && !focusTask && <MissingTargetNotice what="タスク" />}
      {employee && !filteredEmployee && <MissingTargetNotice what="社員" />}
      {filteredEmployee && (
        <div className="mb-3" data-testid="employee-task-context">
          <p className="mb-2 flex flex-wrap items-center gap-2 text-sm font-bold">
            {filteredEmployee.name}さんの{source === 'onboarding' ? '入社準備' : ''}タスク
            <a href={`#/employees/${filteredEmployee.id}`} className="inline-flex min-h-9 items-center text-xs font-semibold text-navy-600 dark:text-navy-300">
              社員の詳細
            </a>
            {source === 'onboarding' && (
              <a href={`#/onboarding?employee=${filteredEmployee.id}`} className="inline-flex min-h-9 items-center text-xs font-semibold text-navy-600 dark:text-navy-300">
                入社準備（タスクの追加生成）
              </a>
            )}
          </p>
          <TargetNotices targetId={filteredEmployee.id} />
        </div>
      )}
      {filterAdjusted && focusTask && (
        <p className="mb-3 rounded-xl bg-navy-50 p-3 text-xs text-navy-800 dark:bg-navy-800 dark:text-navy-100" role="status" data-testid="filter-adjusted">
          「{focusTask.title}」が絞り込み条件で隠れていたため、条件を解除して表示しています
        </p>
      )}

      {/* 社員で絞り込んでいる時は、その社員のタスクだけを表示する (他の社員の要対応を混ぜない) */}
      {!filteredEmployee && <AttentionSection modules={TASK_MODULES} title="要対応（期限超過）" description="下部ナビ「タスク」の件数の内訳です。完了にするか期限を見直すと消えます" testId="task-attention">
        {(items) => (
          <ul className="divide-y divide-slate-100 dark:divide-navy-800" data-testid="task-attention-list">
            {items.map((n) => {
              const t = data.tasks.find((x) => x.id === n.target.id);
              return t ? <TaskItem key={n.id} task={t} onOpen={setEditing} note={n.reason} /> : null;
            })}
          </ul>
        )}
      </AttentionSection>}

      <div className="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label="進捗状況で絞り込み">
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={status === t.key}
            onClick={() => setStatus(t.key)}
            className={cx(
              'inline-flex min-h-10 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-semibold transition-colors',
              status === t.key
                ? 'border-navy-800 bg-navy-800 text-white dark:border-navy-400 dark:bg-navy-500'
                : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 dark:border-navy-700 dark:bg-navy-900 dark:text-slate-300',
              t.key === 'overdue' && counts.overdue > 0 && status !== t.key && 'border-red-200 text-red-600 dark:border-red-900 dark:text-red-400',
            )}
          >
            {t.label}
            <span className={cx('rounded-full px-1.5 text-[11px] tabular-nums', status === t.key ? 'bg-white/20' : 'bg-slate-100 dark:bg-navy-800')}>{counts[t.key]}</span>
          </button>
        ))}
      </div>

      <Card className="p-3 sm:p-4">
        <div className="grid grid-cols-[1fr_auto] gap-2 md:grid-cols-[1fr_8rem_9rem_10rem_8rem_8rem]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
            <input
              type="search"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="タスク名・担当者・対象社員で検索"
              aria-label="タスクを検索"
              className="h-11 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 shadow-sm focus:border-navy-500 focus:outline-none focus:ring-2 focus:ring-navy-500/25 dark:border-navy-700 dark:bg-navy-950"
            />
          </div>
          <FilterDisclosure activeCount={[priority, dept, employee, source].filter(Boolean).length + (sort !== 'due' ? 1 : 0)} className="col-span-2">
            <FilterSelect label="優先度" value={priority} onChange={setPriority} options={[{ value: '', label: '全優先度' }, ...PRIORITIES.map((p) => ({ value: p, label: `優先度 ${PRIORITY_LABEL[p]}` }))]} />
            <FilterSelect label="担当部署" value={dept} onChange={setDept} options={[{ value: '', label: '全担当部署' }, ...data.departments.map((d) => ({ value: d.id, label: d.name }))]} />
            <FilterSelect
              label="対象社員"
              value={employee}
              onChange={setEmployee}
              options={[
                { value: '', label: '全対象社員' },
                ...data.employees
                  .filter((e) => data.tasks.some((t) => t.employeeId === e.id))
                  .map((e) => ({ value: e.id, label: e.name })),
              ]}
            />
            <FilterSelect
              label="生成元"
              value={source}
              onChange={(v) => setF({ source: v })}
              options={[
                { value: '', label: '全生成元' },
                { value: 'manual', label: '手動作成' },
                { value: 'onboarding', label: '入社準備' },
                { value: 'inquiry', label: '問い合わせ' },
                { value: 'automation', label: '自動化（機器）' },
              ]}
            />
            <FilterSelect
              label="並び順"
              value={sort}
              onChange={(v) => setSort(v as SortKey)}
              options={[
                { value: 'due', label: '期限順' },
                { value: 'priority', label: '優先度順' },
                { value: 'updated', label: '更新順' },
              ]}
            />
          </FilterDisclosure>
        </div>
        <div className="mt-2 flex items-center justify-between px-1 text-xs text-slate-500">
          <span data-testid="task-count">
            {filteredEmployee ? `${filteredEmployee.name}さんのタスク・` : ''}
            {filtered.length}件を表示
          </span>
          {hasExtra && (
            <button
              type="button"
              className="inline-flex min-h-9 items-center gap-1 font-semibold text-navy-600 dark:text-navy-300"
              onClick={() => setF({ q: '', priority: '', dept: '', employee: '', source: '' })}
            >
              <X className="size-3.5" />
              条件をクリア
            </button>
          )}
        </div>
      </Card>

      <Card className="mt-3 overflow-hidden">
        {filtered.length === 0 ? (
          <EmptyState
            icon={ClipboardList}
            title="該当するタスクはありません"
            description={status === 'overdue' ? '期限超過のタスクはありません。順調です！' : filteredEmployee && status === 'open' ? `${filteredEmployee.name}さんの未完了のタスクはありません（すべて完了しました）` : '条件を変更するか、新しいタスクを作成してください'}
          />
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-navy-800" data-testid="task-list">
            {filtered.map((t) => (
              <TaskItem key={t.id} task={t} onOpen={setEditing} />
            ))}
          </ul>
        )}
      </Card>

      <TaskFormModal open={creating} onClose={() => setCreating(false)} defaultEmployeeId={employee || null} />
      <TaskFormModal open={!!editing} onClose={() => setEditing(null)} task={editing ?? undefined} />
    </>
  );
}
