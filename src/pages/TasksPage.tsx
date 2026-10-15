import { useEffect, useMemo, useState } from 'react';
import { ClipboardList, Plus, Search, X } from 'lucide-react';
import { useAppData } from '../app/AppData';
import { isTaskOverdue } from '../domain/analytics';
import { PRIORITIES, PRIORITY_LABEL, PRIORITY_WEIGHT, TASK_STATUS_LABEL, type Task } from '../domain/types';
import { TaskFormModal } from '../features/TaskFormModal';
import { TaskItem } from '../features/TaskItem';
import { Button, Card, EmptyState, FilterSelect, PageHeader, cx } from '../ui/primitives';

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
  const initialStatus = (query.get('status') as StatusFilter | null) ?? 'open';
  const [status, setStatus] = useState<StatusFilter>(STATUS_TABS.some((t) => t.key === initialStatus) ? initialStatus : 'open');
  const [keyword, setKeyword] = useState('');
  const [priority, setPriority] = useState('');
  const [dept, setDept] = useState('');
  const [employee, setEmployee] = useState(query.get('employee') ?? '');
  const [sort, setSort] = useState<SortKey>('due');
  const [editing, setEditing] = useState<Task | null>(null);
  const [creating, setCreating] = useState(false);

  // ダッシュボードから特定タスクを開く (#/tasks?focus=id)
  const focusId = query.get('focus');
  useEffect(() => {
    if (!focusId) return;
    const t = data.tasks.find((x) => x.id === focusId);
    if (t) {
      setStatus('all');
      setEditing(t);
    }
    // focusId が変わった時だけ開く (data.tasks を依存に入れると保存のたびに再オープンしてしまう)
  }, [focusId]);

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
  }, [data.tasks, status, priority, dept, employee, keyword, sort, today, empById]);

  const filteredEmployee = employee ? empById.get(employee) : undefined;
  const hasExtra = keyword || priority || dept || employee;

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
        <div className="grid gap-2 md:grid-cols-[1fr_8rem_10rem_12rem_8rem]">
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
          <div className="grid grid-cols-2 gap-2 md:contents">
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
              label="並び順"
              value={sort}
              onChange={(v) => setSort(v as SortKey)}
              options={[
                { value: 'due', label: '期限順' },
                { value: 'priority', label: '優先度順' },
                { value: 'updated', label: '更新順' },
              ]}
            />
          </div>
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
              onClick={() => {
                setKeyword('');
                setPriority('');
                setDept('');
                setEmployee('');
              }}
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
            description={status === 'overdue' ? '期限超過のタスクはありません。順調です！' : '条件を変更するか、新しいタスクを作成してください'}
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
