/**
 * カレンダー表示: 期限 (と開始日) に基づく月表示。日付を選ぶとその日のタスクを一覧し、期限を変更できる。
 * 期限のないタスクは下の「期限なし」に必ず表示する (カレンダーから漏れない)。
 */
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useAppData } from '../../app/AppData';
import { addDays, formatDateJa, parseISODate, toISODate } from '../../domain/date';
import type { Task } from '../../domain/types';
import { Button, Card, CardHeader, cx } from '../../ui/primitives';
import { TaskItem } from '../TaskItem';

const WD = ['日', '月', '火', '水', '木', '金', '土'];

export function CalendarView({ tasks, month, day, onMonth, onDay, onOpen }: { tasks: Task[]; month: string; day: string; onMonth: (m: string) => void; onDay: (d: string) => void; onOpen: (t: Task) => void }) {
  const { today, run } = useAppData();
  const [y, m] = month.split('-').map(Number) as [number, number];
  const first = new Date(y, m - 1, 1);
  const start = addDays(toISODate(first), -first.getDay());
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const weeks = days.slice(35).every((d) => d.slice(0, 7) !== month) ? days.slice(0, 35) : days;
  const byDue = new Map<string, Task[]>();
  for (const t of tasks) if (t.dueDate) byDue.set(t.dueDate, [...(byDue.get(t.dueDate) ?? []), t]);
  const startsOn = (d: string) => tasks.filter((t) => t.startDate === d && t.dueDate !== d);
  const shift = (n: number) => {
    const d = new Date(y, m - 1 + n, 1);
    onMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  };
  const selected = day || today;
  const dayTasks = byDue.get(selected) ?? [];
  const noDue = tasks.filter((t) => !t.dueDate && t.status !== 'done');
  const moveDue = (t: Task, date: string) => run((s) => s.tasks.setDueDate(t.id, date || null), `「${t.title}」の期限を${date ? formatDateJa(date) : 'なし'}にしました`).catch(() => undefined);

  return (
    <div data-testid="calendar">
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2">
          <Button variant="ghost" icon={ChevronLeft} onClick={() => shift(-1)} aria-label="前の月">
            <span className="sr-only">前の月</span>
          </Button>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold" data-testid="calendar-month">
              {y}年{m}月
            </h2>
            <button type="button" className="min-h-9 rounded-lg px-2 text-xs font-semibold text-navy-600 dark:text-navy-300" onClick={() => { onMonth(today.slice(0, 7)); onDay(today); }}>
              今日
            </button>
          </div>
          <Button variant="ghost" icon={ChevronRight} onClick={() => shift(1)} aria-label="次の月">
            <span className="sr-only">次の月</span>
          </Button>
        </div>
        <div className="grid grid-cols-7 border-t border-slate-200 text-center text-[11px] font-semibold text-slate-500 dark:border-navy-800">
          {WD.map((w, i) => (
            <div key={w} className={cx('py-1', i === 0 && 'text-red-500', i === 6 && 'text-blue-500')}>
              {w}
            </div>
          ))}
        </div>
        {/* 日付のボタンの並び (キーボードでは Tab で順に移動)。表のような矢印キーの操作はしないため grid の役割は付けない */}
        <div className="grid grid-cols-7" role="group" aria-label={`${y}年${m}月のタスク`}>
          {weeks.map((d) => {
            const list = byDue.get(d) ?? [];
            const open = list.filter((t) => t.status !== 'done');
            const inMonth = d.slice(0, 7) === month;
            const overdue = d < today && open.length > 0;
            return (
              <button
                key={d}
                type="button"
                aria-pressed={selected === d}
                onClick={() => onDay(d)}
                className={cx(
                  'flex min-h-16 flex-col items-stretch border-t border-slate-100 p-1 text-left align-top dark:border-navy-800 sm:min-h-24',
                  !inMonth && 'bg-slate-50 text-slate-400 dark:bg-navy-950/60',
                  selected === d && 'bg-navy-50 ring-2 ring-inset ring-navy-500 dark:bg-navy-800',
                )}
                data-date={d}
              >
                {/* 読み上げ: 「2026/10/15(木) 今日 期限のタスク 3件」+ 表示中のタスク名 (見た目の日付の数字は読み上げない) */}
                <span className="sr-only">
                  {formatDateJa(d)}
                  {d === today && ' 今日'} 期限のタスク {list.length}件
                </span>
                <span aria-hidden className={cx('mb-0.5 inline-flex size-6 items-center justify-center self-start rounded-full text-xs tabular-nums', d === today && 'bg-navy-700 font-bold text-white')}>
                  {parseISODate(d).getDate()}
                </span>
                {/* スマホは件数、PC はタスク名を表示 */}
                {list.length > 0 && (
                  <span aria-hidden className={cx('rounded px-1 text-[11px] font-semibold sm:hidden', overdue ? 'bg-red-100 text-red-700' : 'bg-navy-100 text-navy-800 dark:bg-navy-700 dark:text-white')} data-testid="calendar-count">
                    {list.length}件
                  </span>
                )}
                <span className="hidden space-y-0.5 sm:block">
                  {list.slice(0, 3).map((t) => (
                    <span key={t.id} className={cx('block truncate rounded px-1 text-[11px]', t.status === 'done' ? 'text-slate-400 line-through' : overdue ? 'bg-red-50 text-red-700' : 'bg-navy-50 text-navy-800 dark:bg-navy-800 dark:text-navy-100')}>
                      {t.title}
                    </span>
                  ))}
                  {list.length > 3 && <span className="block px-1 text-[11px] text-slate-500">ほか{list.length - 3}件</span>}
                </span>
              </button>
            );
          })}
        </div>
      </Card>

      <Card className="mt-3" data-testid="calendar-day">
        <CardHeader title={`${formatDateJa(selected)} が期限のタスク（${dayTasks.length}件）`} description="タスクを押すと詳細。右の日付で期限を変更できます" />
        {dayTasks.length === 0 && startsOn(selected).length === 0 ? (
          <p className="px-5 pb-4 text-sm text-slate-500">この日が期限のタスクはありません</p>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-navy-800">
            {dayTasks.map((t) => (
              <div key={t.id}>
                <ul>
                  <TaskItem task={t} onOpen={onOpen} />
                </ul>
                <label className="flex items-center justify-end gap-2 px-4 pb-2 text-xs text-slate-500 sm:px-5">
                  期限を変更
                  <input type="date" value={t.dueDate ?? ''} onChange={(e) => moveDue(t, e.target.value)} className="h-10 rounded-lg border border-slate-300 bg-white px-2 text-sm dark:border-navy-700 dark:bg-navy-950" aria-label={`「${t.title}」の期限`} data-testid="calendar-move-due" />
                </label>
              </div>
            ))}
            {startsOn(selected).map((t) => (
              <div key={`s_${t.id}`} className="relative">
                <span className="absolute right-4 top-2 z-10 rounded bg-slate-100 px-1.5 text-[11px] text-slate-600 dark:bg-navy-800">開始日</span>
                <ul>
                  <TaskItem task={t} onOpen={onOpen} />
                </ul>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="mt-3" data-testid="calendar-nodue">
        <CardHeader title={`期限なし（未完了 ${noDue.length}件）`} description="カレンダーに表示されないタスク。期限を設定するとカレンダーに表示されます" />
        {noDue.length === 0 ? (
          <p className="px-5 pb-4 text-sm text-slate-500">期限のない未完了タスクはありません</p>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-navy-800">
            {noDue.map((t) => (
              <div key={t.id}>
                <ul>
                  <TaskItem task={t} onOpen={onOpen} />
                </ul>
                <label className="flex items-center justify-end gap-2 px-4 pb-2 text-xs text-slate-500 sm:px-5">
                  期限を設定
                  <input type="date" value="" onChange={(e) => moveDue(t, e.target.value)} className="h-10 rounded-lg border border-slate-300 bg-white px-2 text-sm dark:border-navy-700 dark:bg-navy-950" aria-label={`「${t.title}」の期限`} />
                </label>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
