import { useState } from 'react';
import { Building2, CalendarClock, CornerDownRight, FolderKanban, Headset, Laptop, ListChecks, Lock, Repeat, Tag, User } from 'lucide-react';
import { useAppData } from '../app/AppData';
import { isTaskOverdue } from '../domain/analytics';
import { describeRecurrence } from '../domain/recurrence';
import { TASK_STATUSES, TASK_STATUS_LABEL, type Task, type TaskStatus } from '../domain/types';
import { formatDateJa } from '../domain/date';
import { linkHref, linkLabel } from '../domain/taskLinks';
import { AutoBadge, DueDate, PriorityBadge } from '../ui/badges';
import { Modal } from '../ui/Modal';
import { Button, cx } from '../ui/primitives';

const STATUS_STYLE: Record<TaskStatus, string> = {
  todo: 'border-slate-300 bg-white text-slate-700 dark:border-slate-600 dark:bg-navy-950 dark:text-slate-200',
  in_progress: 'border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200',
  done: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  on_hold: 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200',
};

/**
 * その場でステータスを変更する処理。親タスクを完了にするとき未完了のサブタスクがあれば、意図を確認する。
 * 繰り返しタスクを完了すると次回が作られることを通知で知らせる
 */
export function useTaskStatusChange() {
  const { run, data } = useAppData();
  const [confirm, setConfirm] = useState<{ task: Task; open: Task[] } | null>(null);
  const apply = (task: Task, next: TaskStatus, completeSubtasks = false) =>
    run(
      (s) => s.setTaskStatus(task.id, next, { completeSubtasks }),
      (r) => `「${task.title}」を${TASK_STATUS_LABEL[next]}にしました${completeSubtasks ? '（サブタスクも完了）' : ''}${r.nextOccurrence ? `。次回（期限 ${formatDateJa(r.nextOccurrence.dueDate)}）を作成しました` : ''}`,
      { undo: (r) => (s) => s.setTaskStatus(task.id, r.previousStatus) },
    ).catch(() => undefined);
  const change = (task: Task, next: TaskStatus) => {
    const open = next === 'done' ? data.tasks.filter((t) => t.parentTaskId === task.id && t.status !== 'done') : [];
    if (open.length) setConfirm({ task, open });
    else void apply(task, next);
  };
  const dialog = (
    <Modal
      open={!!confirm}
      onClose={() => setConfirm(null)}
      title="未完了のサブタスクがあります"
      description={confirm ? `「${confirm.task.title}」のサブタスクが ${confirm.open.length}件 未完了です` : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={() => setConfirm(null)}>
            キャンセル
          </Button>
          <Button variant="secondary" onClick={() => { const c = confirm!; setConfirm(null); void apply(c.task, 'done'); }} data-testid="complete-parent-only">
            親タスクだけ完了
          </Button>
          <Button onClick={() => { const c = confirm!; setConfirm(null); void apply(c.task, 'done', true); }} data-testid="complete-with-subtasks">
            サブタスクもすべて完了
          </Button>
        </>
      }
    >
      <ul className="list-disc space-y-0.5 pl-5 text-sm">
        {confirm?.open.map((t) => (
          <li key={t.id}>{t.title}</li>
        ))}
      </ul>
    </Modal>
  );
  return { change, dialog };
}

/** その場でステータスを変更できるセレクト (スマホではネイティブのピッカーが開く) */
export function StatusSelect({ task }: { task: Task }) {
  const { change, dialog } = useTaskStatusChange();
  return (
    <>
      <select
        aria-label={`「${task.title}」の進捗状況`}
        value={task.status}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => change(task, e.target.value as TaskStatus)}
        className={cx('h-11 shrink-0 rounded-full border pl-3 pr-7 text-[13px] font-semibold sm:h-9 focus:outline-none focus:ring-2 focus:ring-navy-500/30', STATUS_STYLE[task.status])}
      >
        {TASK_STATUSES.map((s) => (
          <option key={s} value={s}>
            {TASK_STATUS_LABEL[s]}
          </option>
        ))}
      </select>
      {dialog}
    </>
  );
}

const chip = 'inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-600 dark:bg-navy-800 dark:text-slate-300';

export function TaskItem({ task, onOpen, showEmployee = true, note }: { task: Task; onOpen: (t: Task) => void; showEmployee?: boolean; note?: string }) {
  const { today, empById, deptById, data } = useAppData();
  const emp = task.employeeId ? empById.get(task.employeeId) : undefined;
  const inquiry = task.inquiryId ? data.inquiries.find((i) => i.id === task.inquiryId) : undefined;
  const asset = task.assetId ? data.assets.find((a) => a.id === task.assetId) : undefined;
  const project = task.projectId ? data.projects.find((p) => p.id === task.projectId) : undefined;
  const parent = task.parentTaskId ? data.tasks.find((t) => t.id === task.parentTaskId) : undefined;
  const subs = data.tasks.filter((t) => t.parentTaskId === task.id);
  const blockers = (task.dependsOn ?? []).map((id) => data.tasks.find((t) => t.id === id)).filter((t): t is Task => !!t && t.status !== 'done');
  const checklist = task.checklist ?? [];
  const overdue = isTaskOverdue(task, today);
  return (
    <li
      className={cx('relative transition-colors', overdue && 'bg-red-50/40 dark:bg-red-950/20')}
      data-testid="task-item"
      data-task-title={task.title}
      data-focus-id={task.id}
      data-employee-id={task.employeeId ?? ''}
      data-task-status={task.status}
    >
      {overdue && <span className="absolute inset-y-0 left-0 w-1 bg-red-500" aria-hidden />}
      <div className="flex items-start gap-3 px-4 py-3 sm:px-5">
        <div className="min-w-0 flex-1">
          <button type="button" onClick={() => onOpen(task)} className="w-full text-left">
            {parent && (
              <span className="mb-0.5 flex items-center gap-1 text-[11px] text-slate-500" data-testid="task-parent">
                <CornerDownRight className="size-3" aria-hidden />
                {parent.title}
              </span>
            )}
            <p className={cx('font-semibold leading-snug text-slate-800 dark:text-slate-100', task.status === 'done' && 'text-slate-400 line-through dark:text-slate-500')}>{task.title}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              <DueDate task={task} today={today} />
              {task.startDate && (
                <span className="inline-flex items-center gap-1 text-xs text-slate-500">
                  <CalendarClock className="size-3" aria-hidden />
                  開始 {formatDateJa(task.startDate)}
                </span>
              )}
              <PriorityBadge priority={task.priority} />
              {task.source === 'onboarding' && <AutoBadge />}
              {task.source === 'inquiry' && <AutoBadge label="問い合わせ由来" />}
              {task.source === 'automation' && <AutoBadge label="自動化" />}
            </div>
            {(project || task.recurrence || checklist.length > 0 || subs.length > 0 || blockers.length > 0 || (task.tags?.length ?? 0) > 0) && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {project && (
                  <span className={chip} data-testid="task-project">
                    <FolderKanban className="size-3" aria-hidden />
                    {project.name}
                  </span>
                )}
                {task.recurrence && (
                  <span className={chip} data-testid="task-recurrence">
                    <Repeat className="size-3" aria-hidden />
                    {describeRecurrence(task.recurrence)}
                  </span>
                )}
                {checklist.length > 0 && (
                  <span className={chip} data-testid="task-checklist-progress">
                    <ListChecks className="size-3" aria-hidden />
                    {checklist.filter((c) => c.done).length}/{checklist.length}
                  </span>
                )}
                {subs.length > 0 && (
                  <span className={chip} data-testid="task-subtask-progress">
                    サブタスク {subs.filter((t) => t.status === 'done').length}/{subs.length}
                  </span>
                )}
                {blockers.length > 0 && (
                  <span className={cx(chip, 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200')} data-testid="task-blocked" title={blockers.map((b) => b.title).join('、')}>
                    <Lock className="size-3" aria-hidden />
                    前提未完了 {blockers.length}
                  </span>
                )}
                {task.tags?.map((t) => (
                  <span key={t} className={chip}>
                    <Tag className="size-3" aria-hidden />
                    {t}
                  </span>
                ))}
              </div>
            )}
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
              {showEmployee && emp && (
                <span className="inline-flex items-center gap-1">
                  <User className="size-3" aria-hidden />
                  対象：{emp.name}
                </span>
              )}
              {(task.assigneeDepartmentId || task.assignee) && (
                <span className="inline-flex items-center gap-1">
                  <Building2 className="size-3" aria-hidden />
                  {[task.assigneeDepartmentId ? (deptById.get(task.assigneeDepartmentId)?.name ?? '不明な部署') : '', task.assignee].filter(Boolean).join('・')}
                </span>
              )}
            </div>
          </button>
          {note && (
            <p className="mt-1 text-xs font-semibold text-red-700 dark:text-red-300" data-testid="task-note">
              {note}
            </p>
          )}
          {emp && showEmployee && (
            <a href={`#/employees/${emp.id}`} className="mr-3 mt-0.5 inline-flex min-h-8 items-center gap-1 text-xs font-semibold text-navy-600 underline-offset-2 hover:underline dark:text-navy-300">
              <User className="size-3" aria-hidden />
              {emp.name}さんの詳細
            </a>
          )}
          {inquiry && (
            <a href={`#/helpdesk/${inquiry.id}`} className="mr-3 mt-0.5 inline-flex min-h-8 items-center gap-1 text-xs font-semibold text-navy-600 underline-offset-2 hover:underline dark:text-navy-300">
              <Headset className="size-3" aria-hidden />
              問い合わせ {inquiry.number}
            </a>
          )}
          {asset && (
            <a href={`#/inventory/assets/${asset.id}`} className="mr-3 mt-0.5 inline-flex min-h-8 items-center gap-1 text-xs font-semibold text-navy-600 underline-offset-2 hover:underline dark:text-navy-300">
              <Laptop className="size-3" aria-hidden />
              資産 {asset.assetNumber}
            </a>
          )}
          {task.links?.map((l) => (
            <a key={`${l.kind}:${l.id}`} href={linkHref(l)} className="mr-3 mt-0.5 inline-flex min-h-8 items-center gap-1 text-xs font-semibold text-navy-600 underline-offset-2 hover:underline dark:text-navy-300" data-testid="task-link">
              {linkLabel(l, data)}
            </a>
          ))}
        </div>
        <StatusSelect task={task} />
      </div>
    </li>
  );
}
