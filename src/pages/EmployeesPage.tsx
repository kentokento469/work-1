import { useMemo, useState } from 'react';
import { ChevronRight, Plus, Search, UserPlus, Users, X } from 'lucide-react';
import { useAppData } from '../app/AppData';
import { navigate } from '../app/router';
import { formatDateJa } from '../domain/date';
import { EMPLOYEE_STATUSES, EMPLOYEE_STATUS_LABEL, type Employee } from '../domain/types';
import { EmployeeFormModal } from '../features/EmployeeFormModal';
import { EmployeeStatusBadge } from '../ui/badges';
import { ConfirmDialog } from '../ui/Modal';
import { Button, Card, EmptyState, FilterSelect, PageHeader } from '../ui/primitives';

export function EmployeesPage({ query }: { query: URLSearchParams }) {
  const { data, deptById, stats } = useAppData();
  const [keyword, setKeyword] = useState('');
  const [dept, setDept] = useState(query.get('dept') ?? '');
  const [status, setStatus] = useState(query.get('status') ?? '');
  const [formOpen, setFormOpen] = useState(false);
  const [created, setCreated] = useState<Employee | null>(null);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase().replace(/[\s　]+/g, '');
    return data.employees
      .filter((e) => !dept || e.departmentId === dept)
      .filter((e) => !status || e.status === status)
      .filter((e) => {
        if (!kw) return true;
        const hay = [e.employeeNumber, e.name, e.position, e.notes, deptById.get(e.departmentId)?.name ?? '', e.employmentType]
          .join(' ')
          .toLowerCase()
          .replace(/[\s　]+/g, '');
        return hay.includes(kw);
      })
      .sort((a, b) => a.employeeNumber.localeCompare(b.employeeNumber));
  }, [data.employees, keyword, dept, status, deptById]);

  const taskCount = useMemo(() => {
    const m = new Map<string, { open: number; total: number }>();
    for (const t of data.tasks) {
      if (!t.employeeId) continue;
      const c = m.get(t.employeeId) ?? { open: 0, total: 0 };
      c.total++;
      if (t.status !== 'done') c.open++;
      m.set(t.employeeId, c);
    }
    return m;
  }, [data.tasks]);

  const hasFilter = keyword || dept || status;

  return (
    <>
      <PageHeader
        title="社員管理"
        description={`登録 ${data.employees.length}名（在籍 ${stats.activeCount}名・入社予定 ${stats.pendingHireCount}名）`}
        actions={
          <Button icon={Plus} onClick={() => setFormOpen(true)}>
            新規登録
          </Button>
        }
      />

      <Card className="p-3 sm:p-4">
        <div className="grid gap-2 sm:grid-cols-[1fr_11rem_9rem]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
            <input
              type="search"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="氏名・社員番号・役職などで検索"
              aria-label="キーワード検索"
              className="h-11 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 shadow-sm focus:border-navy-500 focus:outline-none focus:ring-2 focus:ring-navy-500/25 dark:border-navy-700 dark:bg-navy-950"
            />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:contents">
            <FilterSelect label="部署で絞り込み" value={dept} onChange={setDept} options={[{ value: '', label: 'すべての部署' }, ...data.departments.map((d) => ({ value: d.id, label: d.name }))]} />
            <FilterSelect
              label="ステータスで絞り込み"
              value={status}
              onChange={setStatus}
              options={[{ value: '', label: 'すべての状態' }, ...EMPLOYEE_STATUSES.map((s) => ({ value: s, label: EMPLOYEE_STATUS_LABEL[s] }))]}
            />
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between px-1 text-xs text-slate-500">
          <span data-testid="employee-count">{filtered.length}名を表示</span>
          {hasFilter && (
            <button
              type="button"
              className="inline-flex min-h-9 items-center gap-1 font-semibold text-navy-600 dark:text-navy-300"
              onClick={() => {
                setKeyword('');
                setDept('');
                setStatus('');
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
            icon={Users}
            title={hasFilter ? '条件に一致する社員はいません' : '社員が登録されていません'}
            description={hasFilter ? '検索条件を変更してください' : '「新規登録」から社員を追加しましょう'}
          />
        ) : (
          <>
            {/* スマホ: カードリスト */}
            <ul className="divide-y divide-slate-100 md:hidden dark:divide-navy-800">
              {filtered.map((e) => {
                const c = taskCount.get(e.id);
                return (
                  <li key={e.id}>
                    <a href={`#/employees/${e.id}`} className="flex items-center gap-3 px-4 py-3 active:bg-slate-50 dark:active:bg-navy-800">
                      <Avatar name={e.name} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate font-semibold text-slate-800 dark:text-slate-100">{e.name}</p>
                          <EmployeeStatusBadge status={e.status} />
                        </div>
                        <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
                          {e.employeeNumber}・{deptById.get(e.departmentId)?.name ?? '不明'}
                          {e.position && `・${e.position}`}
                        </p>
                        <p className="mt-0.5 text-[11px] text-slate-400">
                          {e.employmentType}・{formatDateJa(e.hireDate)} 入社{c && c.open > 0 ? `・未完了タスク ${c.open}件` : ''}
                        </p>
                      </div>
                      <ChevronRight className="size-4 shrink-0 text-slate-300" aria-hidden />
                    </a>
                  </li>
                );
              })}
            </ul>
            {/* PC: テーブル */}
            <div className="hidden md:block">
              <table className="w-full text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold text-slate-500 dark:border-navy-800 dark:bg-navy-950/40 dark:text-slate-400">
                  <tr>
                    <th className="px-4 py-3">社員番号</th>
                    <th className="px-4 py-3">氏名</th>
                    <th className="px-4 py-3">部署・役職</th>
                    <th className="px-4 py-3">雇用区分</th>
                    <th className="px-4 py-3">入社日</th>
                    <th className="px-4 py-3">ステータス</th>
                    <th className="px-4 py-3 text-right">未完了タスク</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
                  {filtered.map((e) => {
                    const c = taskCount.get(e.id);
                    return (
                      <tr
                        key={e.id}
                        className="cursor-pointer transition-colors hover:bg-slate-50 dark:hover:bg-navy-800/50"
                        onClick={() => navigate(`/employees/${e.id}`)}
                      >
                        <td className="px-4 py-3 font-mono text-xs text-slate-500">{e.employeeNumber}</td>
                        <td className="px-4 py-3">
                          <a href={`#/employees/${e.id}`} className="font-semibold text-slate-800 hover:underline dark:text-slate-100" onClick={(ev) => ev.stopPropagation()}>
                            {e.name}
                          </a>
                        </td>
                        <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                          {deptById.get(e.departmentId)?.name ?? '不明'}
                          {e.position && <span className="text-slate-400">・{e.position}</span>}
                        </td>
                        <td className="px-4 py-3 text-slate-600 dark:text-slate-300">{e.employmentType}</td>
                        <td className="px-4 py-3 tabular-nums text-slate-600 dark:text-slate-300">{formatDateJa(e.hireDate)}</td>
                        <td className="px-4 py-3">
                          <EmployeeStatusBadge status={e.status} />
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-slate-600 dark:text-slate-300">{c ? `${c.open} / ${c.total}` : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      <EmployeeFormModal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSaved={(e, isNew) => {
          if (isNew && e.status !== 'retired') setCreated(e);
        }}
      />
      <ConfirmDialog
        open={!!created}
        title="入社準備タスクを生成しますか？"
        confirmLabel="タスクをプレビュー"
        message={
          <div className="flex gap-3">
            <UserPlus className="mt-0.5 size-5 shrink-0 text-navy-500" aria-hidden />
            <p>
              {created?.name}さん（{created ? deptById.get(created.departmentId)?.name : ''}）の部署・雇用区分・入社日から、必要な準備タスクを自動判定します。
              登録前に内容を確認できます。
            </p>
          </div>
        }
        onConfirm={() => navigate(`/onboarding?employee=${created?.id}`)}
        onClose={() => setCreated(null)}
      />
    </>
  );
}

export function Avatar({ name, size = 'md' }: { name: string; size?: 'md' | 'lg' }) {
  const initial = name.trim().charAt(0) || '?';
  // 名前から安定した色相を決める (識別補助のみ。情報は色に依存しない)
  const hue = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 6;
  const colors = [
    'bg-navy-100 text-navy-800 dark:bg-navy-800 dark:text-navy-100',
    'bg-sky-100 text-sky-800 dark:bg-sky-900 dark:text-sky-100',
    'bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-100',
    'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-100',
    'bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-100',
    'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-100',
  ];
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-full font-bold ${colors[hue]} ${size === 'lg' ? 'size-14 text-xl' : 'size-10 text-sm'}`}
      aria-hidden
    >
      {initial}
    </span>
  );
}
