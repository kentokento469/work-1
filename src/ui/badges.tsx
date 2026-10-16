import { AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, Circle, Clock, Minus, PauseCircle, Zap } from 'lucide-react';
import { diffDays, formatDateJa } from '../domain/date';
import { isTaskOverdue } from '../domain/analytics';
import {
  EMPLOYEE_STATUS_LABEL,
  PRIORITY_LABEL,
  TASK_STATUS_LABEL,
  type EmployeeStatus,
  type Priority,
  type Task,
  type TaskStatus,
} from '../domain/types';
import { Badge, cx, type Tone } from './primitives';

const EMP_TONE: Record<EmployeeStatus, Tone> = { pending: 'violet', active: 'green', leave: 'amber', retired: 'gray' };
export function EmployeeStatusBadge({ status }: { status: EmployeeStatus }) {
  return <Badge tone={EMP_TONE[status]}>{EMPLOYEE_STATUS_LABEL[status]}</Badge>;
}

const TASK_TONE: Record<TaskStatus, Tone> = { todo: 'gray', in_progress: 'blue', done: 'green', on_hold: 'amber' };
const TASK_ICON = { todo: Circle, in_progress: Clock, done: CheckCircle2, on_hold: PauseCircle };
export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return (
    <Badge tone={TASK_TONE[status]} icon={TASK_ICON[status]}>
      {TASK_STATUS_LABEL[status]}
    </Badge>
  );
}

const PRI_TONE: Record<Priority, Tone> = { high: 'red', medium: 'navy', low: 'gray' };
const PRI_ICON = { high: ArrowUp, medium: Minus, low: ArrowDown };
export function PriorityBadge({ priority }: { priority: Priority }) {
  return (
    <Badge tone={PRI_TONE[priority]} icon={PRI_ICON[priority]}>
      優先度 {PRIORITY_LABEL[priority]}
    </Badge>
  );
}

export function AutoBadge({ label = '自動生成' }: { label?: string }) {
  return (
    <Badge tone="violet" icon={Zap}>
      {label}
    </Badge>
  );
}

/** 期限表示。期限超過・間近を色とアイコンで強調する */
export function DueDate({ task, today, className }: { task: Task; today: string; className?: string }) {
  const overdue = isTaskOverdue(task, today);
  if (!task.dueDate)
    return (
      <span className={cx('inline-flex items-center gap-1 text-xs text-slate-400', className)} data-testid="no-due">
        期限なし
      </span>
    );
  const days = diffDays(today, task.dueDate);
  const soon = task.status !== 'done' && !overdue && days <= 3;
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 text-xs tabular-nums',
        overdue ? 'font-semibold text-red-600 dark:text-red-400' : soon ? 'font-semibold text-amber-700 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400',
        className,
      )}
    >
      {overdue && <AlertTriangle className="size-3.5" aria-hidden />}
      {formatDateJa(task.dueDate)}
      {overdue ? `（${-days}日超過）` : soon ? (days === 0 ? '（本日）' : `（あと${days}日）`) : ''}
    </span>
  );
}
