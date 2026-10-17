/**
 * カンバン表示: 進捗状況ごとの列。PC はドラッグ＆ドロップで移動、スマホは各カードの進捗メニューで変更する
 * (タッチのドラッグだけに依存しない)。列は横スクロールし、スワイプ戻りとは競合させない (data-no-swipe)。
 */
import { useState } from 'react';
import { TASK_STATUS_LABEL, type Task, type TaskStatus } from '../../domain/types';
import { DueDate, PriorityBadge } from '../../ui/badges';
import { cx } from '../../ui/primitives';
import { useAppData } from '../../app/AppData';
import { StatusSelect, useTaskStatusChange } from '../TaskItem';

const COLUMNS: TaskStatus[] = ['todo', 'in_progress', 'on_hold', 'done'];
const DONE_LIMIT = 20;
/** 未完了の列も多すぎると描画が遅くなるため、50件ずつ表示する (Phase 12) */
const COL_PAGE = 50;

export function BoardView({ tasks, onOpen }: { tasks: Task[]; onOpen: (t: Task) => void }) {
  const { today, index } = useAppData();
  const { change, dialog } = useTaskStatusChange();
  const [over, setOver] = useState<TaskStatus | null>(null);
  const [limits, setLimits] = useState<Partial<Record<TaskStatus, number>>>({});
  const project = (t: Task) => (t.projectId ? index.projectById.get(t.projectId)?.name : undefined);
  return (
    <div className="-mx-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0" data-no-swipe data-testid="board">
      <div className="grid min-w-[880px] grid-cols-4 gap-3">
        {COLUMNS.map((st) => {
          const all = tasks.filter((t) => t.status === st);
          const limit = limits[st] ?? COL_PAGE;
          const list = st === 'done' ? [...all].sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '')).slice(0, DONE_LIMIT) : all.slice(0, limit);
          return (
            <section
              key={st}
              aria-label={`${TASK_STATUS_LABEL[st]}（${all.length}件）`}
              className={cx('flex min-h-40 flex-col rounded-2xl bg-slate-100 p-2 dark:bg-navy-900', over === st && 'ring-2 ring-navy-500')}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(st);
              }}
              onDragLeave={() => setOver((o) => (o === st ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                const t = tasks.find((x) => x.id === e.dataTransfer.getData('text/plain'));
                if (t && t.status !== st) change(t, st);
              }}
              data-testid={`board-col-${st}`}
            >
              <h3 className="flex items-center justify-between px-1.5 pb-2 pt-1 text-sm font-bold">
                {TASK_STATUS_LABEL[st]}
                <span className="rounded-full bg-white px-2 text-xs tabular-nums text-slate-600 dark:bg-navy-800 dark:text-slate-300" data-testid={`board-count-${st}`}>
                  {all.length}
                </span>
              </h3>
              <ul className="space-y-2">
                {list.map((t) => (
                  <li
                    key={t.id}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData('text/plain', t.id)}
                    className="rounded-xl border border-slate-200 bg-white p-2.5 shadow-sm dark:border-navy-700 dark:bg-navy-950"
                    data-testid="board-card"
                    data-task-title={t.title}
                    data-focus-id={t.id}
                  >
                    <button type="button" className="w-full text-left" onClick={() => onOpen(t)}>
                      <p className={cx('text-sm font-semibold leading-snug', t.status === 'done' && 'text-slate-400 line-through')}>{t.title}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <DueDate task={t} today={today} />
                        <PriorityBadge priority={t.priority} />
                      </div>
                      {project(t) && <p className="mt-1 truncate text-[11px] text-slate-500">{project(t)}</p>}
                    </button>
                    <div className="mt-2">
                      <StatusSelect task={t} />
                    </div>
                  </li>
                ))}
              </ul>
              {st !== 'done' && all.length > limit && (
                <button type="button" className="mt-2 min-h-11 rounded-lg bg-white text-xs font-semibold text-navy-700 dark:bg-navy-950 dark:text-navy-200" onClick={() => setLimits((l) => ({ ...l, [st]: limit + COL_PAGE }))} data-testid={`board-more-${st}`}>
                  さらに表示（残り{all.length - limit}件）
                </button>
              )}
              {st === 'done' && all.length > DONE_LIMIT && <p className="px-1.5 pt-2 text-[11px] text-slate-500">完了は新しい{DONE_LIMIT}件のみ表示（リスト表示の「完了」ですべて確認できます）</p>}
            </section>
          );
        })}
      </div>
      {dialog}
    </div>
  );
}
