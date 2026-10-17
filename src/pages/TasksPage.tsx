/**
 * タスク管理 (Phase 7)。
 * 上から: クイック追加 → 検索・表示切り替え → 主要な絞り込み (未完了・今日・今週…) → 一覧。
 * 詳細な絞り込み (プロジェクト・タグ・担当・優先度・生成元) は必要な時だけ開く。
 * リスト・ボード・カレンダー・プロジェクトは同じデータを表示し、どこで更新しても即座に反映される。
 */
import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, ClipboardList, Columns3, FolderKanban, List, Search, X } from 'lucide-react';
import { useQueryState } from '../app/hooks';
import { useAppData } from '../app/AppData';
import { useFocusHighlight } from '../app/focus';
import { isTaskOverdue } from '../domain/analytics';
import { addDays, parseISODate } from '../domain/date';
import { compareDue } from '../domain/tasks';
import { PRIORITIES, PRIORITY_LABEL, PRIORITY_WEIGHT, TASK_STATUSES, TASK_STATUS_LABEL, type Task, type TaskStatus } from '../domain/types';
import type { NoticeModule } from '../domain/notifications';
import { TaskFormModal } from '../features/TaskFormModal';
import { TaskItem } from '../features/TaskItem';
import { QuickAdd } from '../features/tasks/QuickAdd';
import { BoardView } from '../features/tasks/BoardView';
import { CalendarView } from '../features/tasks/CalendarView';
import { ProjectsView, projectProgress } from '../features/tasks/ProjectsView';
import { ProgressBar } from '../ui/charts';
import { Card, EmptyState, FilterDisclosure, FilterSelect, PageHeader, cx } from '../ui/primitives';
import { AttentionSection, MissingTargetNotice, TargetNotices } from '../ui/notices';

const TASK_MODULES: NoticeModule[] = ['tasks'];

/** 主要な絞り込み (status パラメータ。旧来の進捗状況の値も受け付ける) */
type Scope = 'open' | 'today' | 'week' | 'upcoming' | 'nodue' | 'overdue' | 'done' | 'all';
const SCOPES: { key: Scope; label: string; desc: string }[] = [
  { key: 'open', label: '未完了', desc: '完了していないすべてのタスク' },
  { key: 'today', label: '今日', desc: '今日が期限、または今日開始のタスク' },
  { key: 'week', label: '今週', desc: '今日から今週の日曜日までが期限' },
  { key: 'upcoming', label: '予定', desc: '期限が明日以降' },
  { key: 'nodue', label: '期限なし', desc: '期限が設定されていない未完了のタスク' },
  { key: 'overdue', label: '期限超過', desc: '期限を過ぎた未完了のタスク' },
  { key: 'done', label: '完了', desc: '完了したタスク' },
  { key: 'all', label: 'すべて', desc: '完了を含むすべて' },
];
const LEGACY_STATUS: TaskStatus[] = ['todo', 'in_progress', 'on_hold'];
type View = 'list' | 'board' | 'calendar' | 'projects';
const VIEWS: { key: View; label: string; icon: typeof List }[] = [
  { key: 'list', label: 'リスト', icon: List },
  { key: 'board', label: 'ボード', icon: Columns3 },
  { key: 'calendar', label: 'カレンダー', icon: CalendarDays },
  { key: 'projects', label: 'プロジェクト', icon: FolderKanban },
];
type SortKey = 'due' | 'priority' | 'updated';

function inScope(t: Task, scope: Scope, today: string, weekEnd: string): boolean {
  const open = t.status !== 'done';
  switch (scope) {
    case 'open':
      return open;
    case 'today':
      return open && (t.dueDate === today || t.startDate === today);
    case 'week':
      return open && !!t.dueDate && t.dueDate >= today && t.dueDate <= weekEnd;
    case 'upcoming':
      return open && !!t.dueDate && t.dueDate > today;
    case 'nodue':
      return open && !t.dueDate;
    case 'overdue':
      return isTaskOverdue(t, today);
    case 'done':
      return !open;
    case 'all':
      return true;
  }
}

export function TasksPage({ query }: { query: URLSearchParams }) {
  const { data, today, empById } = useAppData();
  // 表示条件は URL に保存し、他画面から戻っても保持する
  const [f, setF] = useQueryState({ view: 'list', status: 'open', q: '', priority: '', dept: '', employee: '', source: '', project: '', tag: '', progress: '', sort: 'due', group: '', month: '', day: '' });
  const legacy = LEGACY_STATUS.includes(f.status as TaskStatus) ? (f.status as TaskStatus) : null;
  const scope = (SCOPES.some((s) => s.key === f.status) ? f.status : legacy ? 'all' : 'open') as Scope;
  const progress = legacy ?? (TASK_STATUSES.includes(f.progress as TaskStatus) ? (f.progress as TaskStatus) : '');
  const { q: keyword, priority, dept, employee, source, project, tag } = f;
  const view = (VIEWS.some((v) => v.key === f.view) ? f.view : 'list') as View;
  const sort = f.sort as SortKey;
  const [editing, setEditing] = useState<Task | null>(null);
  const [creating, setCreating] = useState(false);

  const weekEnd = useMemo(() => addDays(today, (7 - parseISODate(today).getDay()) % 7), [today]);

  // 通知・ダッシュボード・関連情報から特定タスクへ (#/tasks?focus=id)
  const focusId = query.get('focus');
  const focusTask = focusId ? data.tasks.find((x) => x.id === focusId) : undefined;
  const [filterAdjusted, setFilterAdjusted] = useState(false);

  /** 主要な絞り込み以外の条件 (検索・詳細条件) */
  const matchesExtra = (t: Task) => {
    if (progress && t.status !== progress) return false;
    if (priority && t.priority !== priority) return false;
    if (dept && t.assigneeDepartmentId !== dept) return false;
    if (employee && t.employeeId !== employee) return false;
    if (source && t.source !== source) return false;
    if (project && (project === 'none' ? !!t.projectId : t.projectId !== project)) return false;
    if (tag && !(t.tags ?? []).includes(tag)) return false;
    const kw = keyword.trim().toLowerCase();
    if (kw) {
      const e = t.employeeId ? empById.get(t.employeeId) : undefined;
      const hay = `${t.title} ${t.description} ${t.assignee} ${e?.name ?? ''} ${(t.tags ?? []).join(' ')} ${(t.checklist ?? []).map((c) => c.text).join(' ')}`.toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  };

  const base = useMemo(() => data.tasks.filter(matchesExtra), [data.tasks, progress, priority, dept, employee, source, project, tag, keyword, empById]);
  const counts = useMemo(() => Object.fromEntries(SCOPES.map((s) => [s.key, base.filter((t) => inScope(t, s.key, today, weekEnd)).length])) as Record<Scope, number>, [base, today, weekEnd]);

  const filtered = useMemo(() => {
    const list = base.filter((t) => inScope(t, scope, today, weekEnd));
    return list.sort((a, b) => {
      if (sort === 'priority') return PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority] || compareDue(a, b);
      if (sort === 'updated') return b.updatedAt.localeCompare(a.updatedAt);
      if (scope === 'done') return (b.completedAt ?? '').localeCompare(a.completedAt ?? '');
      // 期限順: 完了は後ろ、期限なしは期限ありの後
      const da = a.status === 'done' ? 1 : 0;
      const db = b.status === 'done' ? 1 : 0;
      return da - db || compareDue(a, b) || PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority];
    });
  }, [base, scope, sort, today, weekEnd]);

  // 対象が絞り込みやボード・カレンダー表示で隠れていれば、リストで条件を解除して表示する
  const focusVisible = !!focusTask && view === 'list' && (isTaskOverdue(focusTask, today) || filtered.some((t) => t.id === focusTask.id));
  useEffect(() => {
    if (!focusTask || focusVisible) return;
    setF({ view: 'list', status: 'all', q: '', priority: '', dept: '', employee: '', source: '', project: '', tag: '', progress: '' });
    setFilterAdjusted(true);
    // focusId が変わった時だけ調整する
  }, [focusId]);
  useFocusHighlight(focusTask ? focusId : null, focusVisible);

  const filteredEmployee = employee ? empById.get(employee) : undefined;
  const currentProject = project && project !== 'none' ? data.projects.find((p) => p.id === project) : undefined;
  const extraCount = [priority, dept, employee, source, project, tag, f.progress].filter(Boolean).length + (sort !== 'due' ? 1 : 0) + (f.group ? 1 : 0);
  const hasExtra = keyword || extraCount > 0 || legacy;
  const allTags = useMemo(() => [...new Set(data.tasks.flatMap((t) => t.tags ?? []))].sort(), [data.tasks]);
  const clearExtra = () => setF({ q: '', priority: '', dept: '', employee: '', source: '', project: '', tag: '', progress: '', group: '', ...(legacy ? { status: 'open' } : {}) });
  // 新規作成の初期値: 絞り込んでいるプロジェクト・社員を引き継ぐ
  const createDefaults = { ...(currentProject && { projectId: currentProject.id }), ...(filteredEmployee && { employeeId: filteredEmployee.id }) };
  const overdueFocus = !!focusTask && isTaskOverdue(focusTask, today);

  const renderList = (list: Task[]) => (
    <ul className="divide-y divide-slate-100 dark:divide-navy-800" data-testid="task-list">
      {list.map((t) => (
        <TaskItem key={t.id} task={t} onOpen={setEditing} />
      ))}
    </ul>
  );
  const grouped = f.group === 'project' && view === 'list';

  return (
    <>
      <PageHeader
        title="タスク管理"
        description={`未完了 ${data.tasks.filter((t) => t.status !== 'done').length}件・期限超過 ${data.tasks.filter((t) => isTaskOverdue(t, today)).length}件`}
      />

      <QuickAdd defaults={createDefaults} onDetail={() => setCreating(true)} />

      {focusId && !focusTask && <MissingTargetNotice what="タスク" />}
      {employee && !filteredEmployee && <MissingTargetNotice what="社員" />}
      {project && project !== 'none' && !currentProject && <MissingTargetNotice what="プロジェクト" />}
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
      {currentProject && view !== 'projects' && (
        <Card className="mb-3 p-3" data-testid="project-context">
          <div className="flex flex-wrap items-center gap-2">
            <FolderKanban className="size-4 text-navy-600" aria-hidden />
            <p className="font-bold">{currentProject.name}</p>
            <span className="text-xs text-slate-500">{projectProgress(data.tasks, currentProject.id).rate}% 完了（{projectProgress(data.tasks, currentProject.id).done}/{projectProgress(data.tasks, currentProject.id).total}）</span>
            <button type="button" className="ml-auto inline-flex min-h-9 items-center gap-1 text-xs font-semibold text-navy-600 dark:text-navy-300" onClick={() => setF({ project: '' })}>
              <X className="size-3.5" aria-hidden />
              プロジェクトの絞り込みを外す
            </button>
          </div>
          <ProgressBar value={projectProgress(data.tasks, currentProject.id).rate} className="mt-2" label="プロジェクトの完了率" />
        </Card>
      )}
      {filterAdjusted && focusTask && (
        <p className="mb-3 rounded-xl bg-navy-50 p-3 text-xs text-navy-800 dark:bg-navy-800 dark:text-navy-100" role="status" data-testid="filter-adjusted">
          「{focusTask.title}」が絞り込み条件で隠れていたため、条件を解除して表示しています
        </p>
      )}

      {/* 期限超過 (下部ナビの件数の内訳)。一覧を下へ押し出さないよう、普段は閉じた1行で表示する */}
      {!filteredEmployee && view === 'list' && (
        <AttentionSection key={overdueFocus ? 'open' : 'closed'} modules={TASK_MODULES} title="要対応（期限超過）" description="下部ナビ「タスク」の件数の内訳です。完了にするか期限を見直すと消えます" testId="task-attention" limit={overdueFocus ? 99 : 0} compact>
          {(items) => (
            <ul className="divide-y divide-slate-100 dark:divide-navy-800" data-testid="task-attention-list">
              {items.map((n) => {
                const t = data.tasks.find((x) => x.id === n.target.id);
                return t ? <TaskItem key={n.id} task={t} onOpen={setEditing} note={n.reason} /> : null;
              })}
            </ul>
          )}
        </AttentionSection>
      )}

      <Card className="mb-3 p-3 sm:p-4">
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
            <input
              type="search"
              value={keyword}
              onChange={(e) => setF({ q: e.target.value })}
              placeholder="タスク名・メモ・担当者・タグで検索"
              aria-label="タスクを検索"
              className="h-11 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 shadow-sm focus:border-navy-500 focus:outline-none focus:ring-2 focus:ring-navy-500/25 dark:border-navy-700 dark:bg-navy-950"
            />
          </div>
          <div className="inline-flex rounded-lg bg-slate-100 p-1 dark:bg-navy-900" role="tablist" aria-label="表示方式">
            {VIEWS.map((v) => (
              <button key={v.key} type="button" role="tab" aria-selected={view === v.key} onClick={() => setF({ view: v.key })} className={cx('inline-flex min-h-9 min-w-10 items-center justify-center gap-1 rounded-md px-2 text-xs font-semibold', view === v.key ? 'bg-white text-navy-900 shadow-sm dark:bg-navy-700 dark:text-white' : 'text-slate-500 dark:text-slate-400')} aria-label={v.label} data-testid={`view-${v.key}`}>
                <v.icon className="size-4" aria-hidden />
                <span className="hidden sm:inline">{v.label}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="mt-2 grid grid-cols-[1fr] gap-2 md:grid-cols-4">
          <FilterDisclosure activeCount={extraCount} className="md:col-span-4">
            <FilterSelect label="プロジェクト" value={project} onChange={(v) => setF({ project: v })} options={[{ value: '', label: '全プロジェクト' }, { value: 'none', label: 'プロジェクトなし' }, ...data.projects.filter((p) => !p.archived || p.id === project).map((p) => ({ value: p.id, label: p.name }))]} />
            <FilterSelect label="タグ" value={tag} onChange={(v) => setF({ tag: v })} options={[{ value: '', label: '全タグ' }, ...allTags.map((t) => ({ value: t, label: `#${t}` }))]} />
            <FilterSelect label="進捗" value={f.progress || legacy || ''} onChange={(v) => setF({ progress: v, ...(legacy ? { status: 'all' } : {}) })} options={[{ value: '', label: '全進捗' }, ...TASK_STATUSES.map((s) => ({ value: s, label: TASK_STATUS_LABEL[s] }))]} />
            <FilterSelect label="優先度" value={priority} onChange={(v) => setF({ priority: v })} options={[{ value: '', label: '全優先度' }, ...PRIORITIES.map((p) => ({ value: p, label: `優先度 ${PRIORITY_LABEL[p]}` }))]} />
            <FilterSelect label="担当部署" value={dept} onChange={(v) => setF({ dept: v })} options={[{ value: '', label: '全担当部署' }, ...data.departments.map((d) => ({ value: d.id, label: d.name }))]} />
            <FilterSelect label="対象社員" value={employee} onChange={(v) => setF({ employee: v })} options={[{ value: '', label: '全対象社員' }, ...data.employees.filter((e) => data.tasks.some((t) => t.employeeId === e.id)).map((e) => ({ value: e.id, label: e.name }))]} />
            <FilterSelect
              label="生成元"
              value={source}
              onChange={(v) => setF({ source: v })}
              options={[
                { value: '', label: '全生成元' },
                { value: 'manual', label: '手動作成' },
                { value: 'onboarding', label: '入社準備' },
                { value: 'inquiry', label: '問い合わせ' },
                { value: 'automation', label: '自動化' },
              ]}
            />
            <FilterSelect
              label="並び順"
              value={sort}
              onChange={(v) => setF({ sort: v })}
              options={[
                { value: 'due', label: '期限順' },
                { value: 'priority', label: '優先度順' },
                { value: 'updated', label: '更新順' },
              ]}
            />
            <FilterSelect label="グループ" value={f.group} onChange={(v) => setF({ group: v })} options={[{ value: '', label: 'グループなし' }, { value: 'project', label: 'プロジェクト別' }]} />
          </FilterDisclosure>
        </div>
        {hasExtra && (
          <div className="mt-2 flex items-center justify-end px-1 text-xs">
            <button type="button" className="inline-flex min-h-9 items-center gap-1 font-semibold text-navy-600 dark:text-navy-300" onClick={clearExtra}>
              <X className="size-3.5" />
              条件をクリア
            </button>
          </div>
        )}
      </Card>

      {(view === 'list' || view === 'board') && (
        <div className="-mx-4 mb-3 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0" role="tablist" aria-label="タスクの絞り込み" data-no-swipe>
          {SCOPES.map((s) => (
            <button
              key={s.key}
              type="button"
              role="tab"
              aria-selected={scope === s.key && !legacy}
              title={s.desc}
              onClick={() => setF({ status: s.key, ...(legacy ? { progress: legacy } : {}) })}
              className={cx(
                'inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-semibold transition-colors',
                scope === s.key && !legacy ? 'border-navy-800 bg-navy-800 text-white dark:border-navy-400 dark:bg-navy-600' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 dark:border-navy-700 dark:bg-navy-900 dark:text-slate-300',
                s.key === 'overdue' && counts.overdue > 0 && scope !== s.key && 'border-red-200 text-red-600 dark:border-red-900 dark:text-red-400',
              )}
              data-testid={`scope-${s.key}`}
            >
              {s.label}
              <span className={cx('rounded-full px-1.5 text-[11px] tabular-nums', scope === s.key && !legacy ? 'bg-white/20' : 'bg-slate-100 dark:bg-navy-800')}>{counts[s.key]}</span>
            </button>
          ))}
        </div>
      )}

      {view === 'list' && (
        <>
          <p className="mb-1 px-1 text-xs text-slate-500" data-testid="task-count">
            {filteredEmployee ? `${filteredEmployee.name}さんのタスク・` : ''}
            {filtered.length}件を表示{legacy ? `（進捗：${TASK_STATUS_LABEL[legacy]}）` : ''}
          </p>
          <Card className="overflow-hidden">
            {filtered.length === 0 ? (
              <EmptyState
                icon={ClipboardList}
                title="該当するタスクはありません"
                description={scope === 'overdue' ? '期限超過のタスクはありません。順調です！' : filteredEmployee && scope === 'open' ? `${filteredEmployee.name}さんの未完了のタスクはありません（すべて完了しました）` : '上の欄からタスクを追加するか、条件を変更してください'}
              />
            ) : grouped ? (
              <div data-testid="task-groups">
                {[...data.projects.filter((p) => filtered.some((t) => t.projectId === p.id)), null].map((p) => {
                  const list = filtered.filter((t) => (p ? t.projectId === p.id : !t.projectId || !data.projects.some((x) => x.id === t.projectId)));
                  if (!list.length) return null;
                  return (
                    <section key={p?.id ?? 'none'} aria-label={p?.name ?? 'プロジェクトなし'}>
                      <h3 className="flex items-center gap-1.5 border-b border-slate-100 bg-slate-50 px-4 py-2 text-xs font-bold text-slate-600 dark:border-navy-800 dark:bg-navy-950 dark:text-slate-300">
                        <FolderKanban className="size-3.5" aria-hidden />
                        {p?.name ?? 'プロジェクトなし'}（{list.length}）
                      </h3>
                      {renderList(list)}
                    </section>
                  );
                })}
              </div>
            ) : (
              renderList(filtered)
            )}
          </Card>
        </>
      )}
      {view === 'board' && <BoardView tasks={base.filter((t) => (scope === 'open' || scope === 'done' || scope === 'all' ? true : inScope(t, scope, today, weekEnd)))} onOpen={setEditing} />}
      {view === 'calendar' && <CalendarView tasks={base} month={f.month || today.slice(0, 7)} day={f.day} onMonth={(m) => setF({ month: m })} onDay={(d) => setF({ day: d, month: d.slice(0, 7) })} onOpen={setEditing} />}
      {view === 'projects' && <ProjectsView onOpenProject={(id) => setF({ view: 'list', project: id, status: 'all' })} />}

      <TaskFormModal open={creating} onClose={() => setCreating(false)} defaultEmployeeId={employee || null} defaults={createDefaults} />
      <TaskFormModal open={!!editing} onClose={() => setEditing(null)} task={editing ?? undefined} />
    </>
  );
}
