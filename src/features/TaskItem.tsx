import { Building2, Headset, Laptop, User } from 'lucide-react';
import { useAppData } from '../app/AppData';
import { isTaskOverdue } from '../domain/analytics';
import { TASK_STATUSES, TASK_STATUS_LABEL, type Task, type TaskStatus } from '../domain/types';
import { AutoBadge, DueDate, PriorityBadge } from '../ui/badges';
import { cx } from '../ui/primitives';

const STATUS_STYLE: Record<TaskStatus, string> = {
  todo: 'border-slate-300 bg-white text-slate-700 dark:border-slate-600 dark:bg-navy-950 dark:text-slate-200',
  in_progress: 'border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200',
  done: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  on_hold: 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200',
};

/** その場でステータスを変更できるセレクト (スマホではネイティブのピッカーが開く) */
export function StatusSelect({ task }: { task: Task }) {
  const { run } = useAppData();
  return (
    <select
      aria-label={`「${task.title}」の進捗状況`}
      value={task.status}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        const next = e.target.value as TaskStatus;
        run((s) => s.setTaskStatus(task.id, next), `「${task.title}」を${TASK_STATUS_LABEL[next]}にしました`, {
          undo: (r) => (s) => s.setTaskStatus(task.id, r.previousStatus),
        }).catch(() => undefined);
      }}
      className={cx('h-11 shrink-0 rounded-full border pl-3 pr-7 text-[13px] font-semibold sm:h-9 focus:outline-none focus:ring-2 focus:ring-navy-500/30', STATUS_STYLE[task.status])}
    >
      {TASK_STATUSES.map((s) => (
        <option key={s} value={s}>
          {TASK_STATUS_LABEL[s]}
        </option>
      ))}
    </select>
  );
}

export function TaskItem({ task, onOpen, showEmployee = true }: { task: Task; onOpen: (t: Task) => void; showEmployee?: boolean }) {
  const { today, empById, deptById, data } = useAppData();
  const emp = task.employeeId ? empById.get(task.employeeId) : undefined;
  const inquiry = task.inquiryId ? data.inquiries.find((i) => i.id === task.inquiryId) : undefined;
  const asset = task.assetId ? data.assets.find((a) => a.id === task.assetId) : undefined;
  const overdue = isTaskOverdue(task, today);
  return (
    <li
      className={cx('relative transition-colors', overdue && 'bg-red-50/40 dark:bg-red-950/20')}
      data-testid="task-item"
      data-task-title={task.title}
    >
      {overdue && <span className="absolute inset-y-0 left-0 w-1 bg-red-500" aria-hidden />}
      <div className="flex items-start gap-3 px-4 py-3 sm:px-5">
        <div className="min-w-0 flex-1">
          <button type="button" onClick={() => onOpen(task)} className="w-full text-left">
            <p className={cx('font-semibold leading-snug text-slate-800 dark:text-slate-100', task.status === 'done' && 'text-slate-400 line-through dark:text-slate-500')}>
              {task.title}
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              <DueDate task={task} today={today} />
              <PriorityBadge priority={task.priority} />
              {task.source === 'onboarding' && <AutoBadge />}
              {task.source === 'inquiry' && <AutoBadge label="問い合わせ由来" />}
              {task.source === 'automation' && <AutoBadge label="自動化" />}
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
              {showEmployee && emp && (
                <span className="inline-flex items-center gap-1">
                  <User className="size-3" aria-hidden />
                  対象：{emp.name}
                </span>
              )}
              <span className="inline-flex items-center gap-1">
                <Building2 className="size-3" aria-hidden />
                {deptById.get(task.assigneeDepartmentId)?.name ?? '不明'}
                {task.assignee && `・${task.assignee}`}
              </span>
            </div>
          </button>
          {inquiry && (
            <a
              href={`#/helpdesk/${inquiry.id}`}
              className="mt-0.5 inline-flex min-h-8 items-center gap-1 text-xs font-semibold text-navy-600 underline-offset-2 hover:underline dark:text-navy-300"
            >
              <Headset className="size-3" aria-hidden />
              問い合わせ {inquiry.number}
            </a>
          )}
          {asset && (
            <a href={`#/inventory/assets/${asset.id}`} className="ml-3 mt-0.5 inline-flex min-h-8 items-center gap-1 text-xs font-semibold text-navy-600 underline-offset-2 hover:underline dark:text-navy-300">
              <Laptop className="size-3" aria-hidden />
              資産 {asset.assetNumber}
            </a>
          )}
        </div>
        <StatusSelect task={task} />
      </div>
    </li>
  );
}
