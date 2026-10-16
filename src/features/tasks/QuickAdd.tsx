/**
 * クイック追加: タスク名だけで登録する。期限の語句 (明日・金曜・10/20 など) は候補として表示し、× で外せる。
 * 登録後は一覧に即反映し、「詳細を設定」から期限・担当などを追加できる。
 */
import { useMemo, useState, type FormEvent } from 'react';
import { CalendarClock, Plus, X } from 'lucide-react';
import { useAppData } from '../../app/AppData';
import { formatDateJa } from '../../domain/date';
import { parseQuickAdd } from '../../domain/quickAdd';
import type { Task } from '../../domain/types';
import type { TaskInput } from '../../domain/validation';
import { useDraft } from '../../app/hooks';

const isEmptyDraft = (d: { text: string }) => !d.text.trim();

export function QuickAdd({ defaults, onCreated, onDetail }: { defaults?: Partial<TaskInput>; onCreated?: (t: Task) => void; onDetail?: () => void }) {
  const { run, today } = useAppData();
  // 入力途中の内容は端末に一時保存 (誤って画面を離れても消えない)
  const [text, setText] = useState('');
  const draftValue = useMemo(() => ({ text }), [text]);
  const draft = useDraft('task-quick-add', draftValue, isEmptyDraft, (d) => setText(d.text));
  const [ignoreDate, setIgnoreDate] = useState(false);
  const [busy, setBusy] = useState(false);
  const parsed = parseQuickAdd(text, today);
  const useDate = !!parsed.dueDate && !ignoreDate;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const input: TaskInput = {
        employeeId: null,
        title: useDate ? parsed.title : text.trim(),
        description: '',
        assigneeDepartmentId: null,
        assignee: '',
        priority: 'medium',
        dueDate: useDate ? parsed.dueDate : null,
        status: 'todo',
        ...defaults,
      };
      const t = await run((s) => s.createTask(input), `「${input.title}」を追加しました${input.dueDate ? `（期限 ${formatDateJa(input.dueDate)}）` : ''}`, { undo: (created) => (s) => s.deleteTask(created.id) });
      setText('');
      draft.discard();
      setIgnoreDate(false);
      onCreated?.(t);
    } catch {
      /* トースト表示済み。入力は残す */
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="mb-3" data-testid="quick-add">
      <div className="flex gap-2">
        <input
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setIgnoreDate(false);
          }}
          placeholder="タスクを追加（例：明日までに報告書を確認する）"
          aria-label="タスクを追加"
          maxLength={100}
          enterKeyHint="done"
          className="h-12 min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-4 text-[15px] shadow-sm focus:border-navy-500 focus:outline-none focus:ring-2 focus:ring-navy-500/25 dark:border-navy-700 dark:bg-navy-950"
          data-testid="quick-add-input"
        />
        <button type="submit" disabled={!text.trim() || busy} className="inline-flex h-12 shrink-0 items-center gap-1 rounded-xl bg-navy-800 px-4 text-sm font-semibold text-white shadow-sm disabled:opacity-40 dark:bg-navy-500" data-testid="quick-add-submit">
          <Plus className="size-4" aria-hidden />
          追加
        </button>
      </div>
      {onDetail && !parsed.dueDate && (
        <p className="mt-1 flex justify-end px-1">
          <button type="button" onClick={onDetail} className="inline-flex min-h-9 items-center text-xs font-semibold text-navy-600 dark:text-navy-300" data-testid="task-new">
            詳細を入力して作成
          </button>
        </p>
      )}
      {parsed.dueDate && (
        <p className="mt-1.5 flex flex-wrap items-center gap-2 px-1 text-xs" data-testid="quick-add-date">
          {useDate ? (
            <>
              <span className="inline-flex items-center gap-1 rounded-full bg-navy-50 px-2.5 py-1 font-semibold text-navy-800 dark:bg-navy-800 dark:text-navy-100">
                <CalendarClock className="size-3.5" aria-hidden />
                期限：{formatDateJa(parsed.dueDate)}（「{parsed.matched}」から）
                <button type="button" onClick={() => setIgnoreDate(true)} className="-mr-1 inline-flex size-6 items-center justify-center rounded-full" aria-label="期限を付けない" data-testid="quick-add-date-clear">
                  <X className="size-3.5" />
                </button>
              </span>
              <span className="text-slate-500">タスク名：{parsed.title}</span>
            </>
          ) : (
            <button type="button" onClick={() => setIgnoreDate(false)} className="font-semibold text-navy-600 dark:text-navy-300">
              「{parsed.matched}」を期限にする
            </button>
          )}
        </p>
      )}
    </form>
  );
}
