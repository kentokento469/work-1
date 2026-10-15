import type { ReactNode } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CalendarClock,
  ChevronRight,
  CircleCheckBig,
  ClipboardList,
  Flame,
  ListTodo,
  PieChart,
  UserPlus,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useAppData } from '../app/AppData';
import { navigate } from '../app/router';
import { formatDateJa, formatDateTimeJa } from '../domain/date';
import { TASK_STATUS_LABEL, type ActivityCategory } from '../domain/types';
import { HorizontalBarChart, ProgressBar, ProgressRing, StackedBar } from '../ui/charts';
import { Badge, Card, CardHeader, EmptyState, PageHeader, cx } from '../ui/primitives';
import { DEMO_COMPANY_NAME } from '../demo/demoData';

function StatCard({
  label,
  value,
  unit,
  icon: Icon,
  tone,
  href,
  sub,
  extra,
  className,
}: {
  label: string;
  value: number | string;
  unit?: string;
  icon: LucideIcon;
  tone: 'navy' | 'violet' | 'blue' | 'red' | 'green';
  href: string;
  sub?: string;
  extra?: ReactNode;
  className?: string;
}) {
  const toneCls = {
    navy: 'bg-navy-50 text-navy-700 dark:bg-navy-800 dark:text-navy-200',
    violet: 'bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
    blue: 'bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
    red: 'bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-300',
    green: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  }[tone];
  return (
    <a
      href={href}
      className={cx(
        'group rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(15,31,61,0.04)] transition-all hover:-translate-y-0.5 hover:shadow-md active:translate-y-0 dark:border-navy-800 dark:bg-navy-900',
        className,
      )}
      data-testid={`stat-${label}`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-[12px] font-semibold text-slate-500 dark:text-slate-400">{label}</p>
        <span className={cx('flex size-8 items-center justify-center rounded-lg', toneCls)}>
          <Icon className="size-4" aria-hidden />
        </span>
      </div>
      <div className="mt-1 flex items-end justify-between gap-2">
        <p className="text-[28px] font-bold leading-none tracking-tight tabular-nums text-slate-900 dark:text-white">
          <span data-testid="stat-value">{value}</span>
          {unit && <span className="ml-1 text-sm font-medium text-slate-400">{unit}</span>}
        </p>
        {extra}
      </div>
      {sub && <p className="mt-2 truncate text-[11px] text-slate-500 dark:text-slate-400">{sub}</p>}
    </a>
  );
}

const CATEGORY_LABEL: Record<ActivityCategory, string> = {
  employee: '社員',
  task: 'タスク',
  onboarding: '自動化',
  rule: 'ルール',
  department: '部署',
  data: 'データ',
};

export function DashboardPage() {
  const { stats, data, today, empById } = useAppData();
  const s = stats;

  return (
    <>
      <PageHeader title="ダッシュボード" description={`${DEMO_COMPANY_NAME}（架空）の業務状況をリアルタイムに集計しています`} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatCard label="登録社員数" value={s.employeeCount} unit="名" icon={Users} tone="navy" href="#/employees" sub={`在籍 ${s.activeCount}名（退職者除く）`} />
        <StatCard label="入社予定者" value={s.pendingHireCount} unit="名" icon={UserPlus} tone="violet" href="#/onboarding" sub="入社準備の対象" />
        <StatCard label="未完了タスク" value={s.openTaskCount} unit="件" icon={ListTodo} tone="blue" href="#/tasks?status=open" sub={`全 ${s.totalTaskCount}件中`} />
        <StatCard
          label="期限超過"
          value={s.overdueTaskCount}
          unit="件"
          icon={AlertTriangle}
          tone="red"
          href="#/tasks?status=overdue"
          sub={s.overdueTaskCount > 0 ? '至急対応が必要です' : '期限超過はありません'}
        />
        <StatCard
          label="タスク完了率"
          value={s.completionRate}
          unit="%"
          icon={CircleCheckBig}
          tone="green"
          href="#/tasks?status=done"
          sub={`完了 ${s.doneTaskCount} / ${s.totalTaskCount}件`}
          className="col-span-2 md:col-span-1"
          extra={<ProgressRing value={s.completionRate} size={40} stroke={5} label="タスク完了率" />}
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader title="優先対応が必要な業務" icon={Flame} description="期限超過・期限間近（3日以内）・入社準備の未着手を自動抽出" />
          <div className="px-2 pb-3 pt-2 sm:px-3">
            {s.attention.length === 0 ? (
              <EmptyState icon={CircleCheckBig} title="優先対応が必要な業務はありません" />
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-navy-800">
                {s.attention.slice(0, 7).map((a) => (
                  <li key={a.id}>
                    <a
                      href={a.employeeId ? `#/onboarding?employee=${a.employeeId}` : `#/tasks?focus=${a.taskId}`}
                      className="flex min-h-14 items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-slate-50 dark:hover:bg-navy-800/60"
                    >
                      <span
                        className={cx(
                          'flex size-8 shrink-0 items-center justify-center rounded-full',
                          a.kind === 'overdue'
                            ? 'bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-400'
                            : a.kind === 'due_soon'
                              ? 'bg-amber-50 text-amber-600 dark:bg-amber-950 dark:text-amber-400'
                              : 'bg-violet-50 text-violet-600 dark:bg-violet-950 dark:text-violet-300',
                        )}
                      >
                        {a.kind === 'overdue' ? <AlertTriangle className="size-4" /> : a.kind === 'due_soon' ? <CalendarClock className="size-4" /> : <UserPlus className="size-4" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{a.title}</span>
                        <span className="block truncate text-xs text-slate-500 dark:text-slate-400">{a.detail}</span>
                      </span>
                      <Badge tone={a.kind === 'overdue' ? 'red' : a.kind === 'due_soon' ? 'amber' : 'violet'}>
                        {a.kind === 'overdue' ? '期限超過' : a.kind === 'due_soon' ? '期限間近' : '準備未着手'}
                      </Badge>
                      <ChevronRight className="size-4 shrink-0 text-slate-300" aria-hidden />
                    </a>
                  </li>
                ))}
              </ul>
            )}
            {s.attention.length > 7 && (
              <a href="#/tasks?status=overdue" className="mt-1 block px-2 py-2 text-center text-xs font-semibold text-navy-600 dark:text-navy-300">
                ほか {s.attention.length - 7}件を表示
              </a>
            )}
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="タスク進捗" icon={PieChart} description="ステータス別の件数（タップで絞り込み）" />
          <div className="p-4 sm:p-5">
            <StackedBar
              unit="件"
              onSelect={(k) => navigate(`/tasks?status=${k}`)}
              data={[
                { key: 'todo', label: TASK_STATUS_LABEL.todo, value: s.statusCounts.todo, color: 'var(--color-chart-todo)' },
                { key: 'in_progress', label: TASK_STATUS_LABEL.in_progress, value: s.statusCounts.in_progress, color: 'var(--color-chart-progress)' },
                { key: 'on_hold', label: TASK_STATUS_LABEL.on_hold, value: s.statusCounts.on_hold, color: 'var(--color-chart-hold)' },
                { key: 'done', label: TASK_STATUS_LABEL.done, value: s.statusCounts.done, color: 'var(--color-chart-done)' },
              ]}
            />
          </div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="部署別社員数" icon={BarChart3} description="退職者を除く（タップで社員一覧へ）" />
          <div className="px-3 pb-4 pt-3 sm:px-4">
            <HorizontalBarChart
              unit="名"
              onSelect={(k) => navigate(`/employees?dept=${k}`)}
              data={s.departmentCounts.map((d) => ({ key: d.departmentId, label: d.name, value: d.count }))}
            />
          </div>
        </Card>

        <Card>
          <CardHeader title="入社予定者の準備状況" icon={UserPlus} action={<a href="#/onboarding" className="py-1 text-xs font-semibold text-navy-600 dark:text-navy-300">入社準備へ</a>} />
          <div className="px-4 pb-4 pt-2 sm:px-5">
            {s.hireProgress.length === 0 ? (
              <EmptyState icon={UserPlus} title="入社予定者はいません" />
            ) : (
              <ul className="space-y-1">
                {s.hireProgress.map((h) => {
                  const pct = h.total ? Math.round((h.done / h.total) * 100) : 0;
                  return (
                    <li key={h.employee.id}>
                      <a href={`#/employees/${h.employee.id}`} className="block rounded-lg px-1 py-2.5 transition-colors hover:bg-slate-50 dark:hover:bg-navy-800/60">
                        <div className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate text-sm font-semibold text-slate-800 dark:text-slate-100">
                            {h.employee.name}
                            <span className="ml-2 text-xs font-normal text-slate-500">{formatDateJa(h.employee.hireDate)} 入社</span>
                          </span>
                          {h.total === 0 ? (
                            <Badge tone="violet">未生成</Badge>
                          ) : (
                            <span className="text-xs tabular-nums text-slate-500">
                              {h.done}/{h.total}件・{pct}%
                            </span>
                          )}
                        </div>
                        <div className="mt-1.5 flex items-center gap-2">
                          <ProgressBar value={pct} />
                          <span className={cx('shrink-0 text-[11px] tabular-nums', h.daysUntil <= 7 ? 'font-semibold text-amber-700 dark:text-amber-400' : 'text-slate-400')}>
                            {h.daysUntil >= 0 ? `あと${h.daysUntil}日` : '入社済'}
                          </span>
                        </div>
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader title="最近の操作履歴" icon={Activity} action={<a href="#/data" className="py-1 text-xs font-semibold text-navy-600 dark:text-navy-300">すべて表示</a>} />
        <div className="px-4 pb-4 pt-2 sm:px-5">
          {data.activities.length === 0 ? (
            <EmptyState icon={ClipboardList} title="操作履歴はまだありません" />
          ) : (
            <ol className="relative space-y-3 border-l border-slate-200 pl-4 dark:border-navy-700" data-testid="recent-activity">
              {data.activities.slice(0, 8).map((a) => (
                <li key={a.id} className="relative">
                  <span className="absolute -left-[21px] top-1.5 size-2.5 rounded-full border-2 border-white bg-navy-400 dark:border-navy-900" aria-hidden />
                  <p className="text-sm text-slate-700 dark:text-slate-200">{a.message}</p>
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    {formatDateTimeJa(a.at)}・{CATEGORY_LABEL[a.category]}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </div>
      </Card>
      <p className="mt-4 text-center text-[11px] text-slate-400">基準日 {formatDateJa(today)}・社員 {empById.size}名のデータを集計</p>
    </>
  );
}
