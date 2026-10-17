/**
 * タスクの作成・編集。
 * 基本項目 (タスク名・期限・優先度・進捗) だけで保存できる。担当・部署・社員・プロジェクト・タグ・繰り返し・前提タスク・
 * チェックリスト・サブタスクは「詳細」を開いたときだけ入力する (シンプルなタスクはシンプルに)。
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Copy, ListChecks, Plus, Save, Trash2, X } from 'lucide-react';
import { useAppData } from '../app/AppData';
import { describeRecurrence } from '../domain/recurrence';
import { PRIORITIES, PRIORITY_LABEL, TASK_STATUSES, TASK_STATUS_LABEL, type ChecklistItem, type Priority, type Recurrence, type Task, type TaskStatus } from '../domain/types';
import { validateTask, type FieldErrors, type TaskInput } from '../domain/validation';
import { generateId } from '../domain/id';
import { linkHref, linkLabel } from '../domain/taskLinks';
import { AppError } from '../services/workcoreService';
import { ConflictNotice } from '../ui/ConflictNotice';
import { Modal, ModalCancelButton } from '../ui/Modal';
import { AutoBadge } from '../ui/badges';
import { Button, SelectField, TextAreaField, TextField, cx } from '../ui/primitives';
import { useTaskStatusChange } from './TaskItem';

const WD = ['日', '月', '火', '水', '木', '金', '土'];
type RecurPreset = '' | 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'monthly_last' | 'yearly' | 'custom';

function presetOf(r: Recurrence | null | undefined): RecurPreset {
  if (!r) return '';
  if (r.freq === 'daily' && r.interval === 1) return 'daily';
  if (r.freq === 'weekly' && r.interval === 1) return 'weekly';
  if (r.freq === 'weekly' && r.interval === 2) return 'biweekly';
  if (r.freq === 'monthly' && r.interval === 1) return r.monthDay === 'last' ? 'monthly_last' : 'monthly';
  if (r.freq === 'yearly' && r.interval === 1) return 'yearly';
  return 'custom';
}
function fromPreset(p: RecurPreset, prev: Recurrence | null | undefined): Recurrence | null {
  switch (p) {
    case '':
      return null;
    case 'daily':
      return { freq: 'daily', interval: 1 };
    case 'weekly':
      return { freq: 'weekly', interval: 1, weekdays: prev?.freq === 'weekly' ? prev.weekdays : undefined };
    case 'biweekly':
      return { freq: 'weekly', interval: 2, weekdays: prev?.freq === 'weekly' ? prev.weekdays : undefined };
    case 'monthly':
      return { freq: 'monthly', interval: 1 };
    case 'monthly_last':
      return { freq: 'monthly', interval: 1, monthDay: 'last' };
    case 'yearly':
      return { freq: 'yearly', interval: 1 };
    case 'custom':
      return prev ?? { freq: 'daily', interval: 2 };
  }
}

const hasDetails = (f: TaskInput) =>
  !!(f.startDate || f.assignee || f.assigneeDepartmentId || f.employeeId || f.projectId || f.tags?.length || f.recurrence || f.dependsOn?.length || f.checklist?.length || f.description || f.parentTaskId);

/** 既存のタスクをフォームの入力値にする */
function taskToInput(task: Task): TaskInput {
  return {
    employeeId: task.employeeId,
    title: task.title,
    description: task.description,
    assigneeDepartmentId: task.assigneeDepartmentId,
    assignee: task.assignee,
    priority: task.priority,
    dueDate: task.dueDate,
    status: task.status,
    startDate: task.startDate ?? null,
    projectId: task.projectId ?? null,
    parentTaskId: task.parentTaskId ?? null,
    tags: task.tags ?? [],
    checklist: task.checklist ?? [],
    recurrence: task.recurrence ?? null,
    dependsOn: task.dependsOn ?? [],
    links: task.links ?? [],
  };
}

export function TaskFormModal({
  open,
  onClose,
  task,
  defaultEmployeeId,
  defaults,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  task?: Task;
  defaultEmployeeId?: string | null;
  /** 新規作成時の初期値 (関連データ・プロジェクト・親タスクなど) */
  defaults?: Partial<TaskInput>;
  onSaved?: (t: Task) => void;
}) {
  const { data, run, reload, empById } = useAppData();

  const initial = useMemo<TaskInput>(
    () =>
      task
        ? taskToInput(task)
        : {
            employeeId: defaultEmployeeId ?? null,
            title: '',
            description: '',
            assigneeDepartmentId: null,
            assignee: '',
            priority: 'medium',
            dueDate: null,
            status: 'todo',
            startDate: null,
            projectId: null,
            parentTaskId: null,
            tags: [],
            checklist: [],
            recurrence: null,
            dependsOn: [],
            links: [],
            ...defaults,
          },
    // 入力中のデータ再読み込みで入力を消さないよう、対象は ID で判定する
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [task?.id, defaultEmployeeId, open],
  );

  const [form, setForm] = useState<TaskInput>(initial);
  const [errors, setErrors] = useState<FieldErrors<TaskInput>>({});
  const [saving, setSaving] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [tagText, setTagText] = useState('');
  const [checkText, setCheckText] = useState('');
  const [subText, setSubText] = useState('');
  const { change: changeStatus, dialog: statusDialog } = useTaskStatusChange();
  /** フォームを開いた時点の更新日時 (別のタブ・画面での変更を検出する) */
  const [baseUpdatedAt, setBaseUpdatedAt] = useState<string | undefined>(undefined);
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    if (open) {
      setBaseUpdatedAt(task?.updatedAt);
      setConflict(false);
      setForm(initial);
      setErrors({});
      setDetailsOpen(hasDetails(initial));
      setTagText('');
      setCheckText('');
      setSubText('');
    }
  }, [open, initial]);

  const set = <K extends keyof TaskInput>(key: K, value: TaskInput[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const employeeOptions = data.employees
    .filter((e) => e.status !== 'retired' || e.id === form.employeeId)
    .sort((a, b) => a.employeeNumber.localeCompare(b.employeeNumber))
    .map((e) => ({ value: e.id, label: `${e.name}（${e.employeeNumber}）` }));
  const projectOptions = data.projects.filter((p) => !p.archived || p.id === form.projectId).map((p) => ({ value: p.id, label: p.archived ? `${p.name}（アーカイブ）` : p.name }));
  const allTags = useMemo(() => [...new Set(data.tasks.flatMap((t) => t.tags ?? []))].sort(), [data.tasks]);
  const subtasks = task ? data.tasks.filter((t) => t.parentTaskId === task.id) : [];
  const isSubtask = !!form.parentTaskId;
  const parent = form.parentTaskId ? data.tasks.find((t) => t.id === form.parentTaskId) : undefined;
  // 前提タスクの候補: 自分・自分のサブタスク以外の未完了タスク
  const depCandidates = data.tasks.filter((t) => t.id !== task?.id && t.status !== 'done' && !(form.dependsOn ?? []).includes(t.id)).slice(0, 200);

  const addTag = (raw: string) => {
    const parts = raw.split(/[,、\s]+/).map((x) => x.trim()).filter(Boolean);
    if (!parts.length) return;
    set('tags', [...new Set([...(form.tags ?? []), ...parts])]);
    setTagText('');
  };
  const addCheck = () => {
    if (!checkText.trim()) return;
    set('checklist', [...(form.checklist ?? []), { id: generateId('chk'), text: checkText.trim(), done: false }]);
    setCheckText('');
  };
  const updateCheck = (id: string, patch: Partial<ChecklistItem>) => set('checklist', (form.checklist ?? []).map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const recurPreset = presetOf(form.recurrence);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    await save(baseUpdatedAt);
  };

  const save = async (expectedUpdatedAt: string | undefined) => {
    if (tagText.trim()) addTag(tagText);
    const input: TaskInput = { ...form, tags: tagText.trim() ? [...new Set([...(form.tags ?? []), ...tagText.split(/[,、\s]+/).filter(Boolean)])] : form.tags };
    const v = validateTask(input, { employeeIds: data.employees.map((e) => e.id), departmentIds: data.departments.map((d) => d.id), projectIds: data.projects.map((p) => p.id), tasks: data.tasks, selfId: task?.id });
    if (!v.ok) {
      setErrors(v.errors);
      setDetailsOpen(true);
      return;
    }
    setSaving(true);
    try {
      const saved = await run((s) => (task ? s.updateTask(task.id, input, { expectedUpdatedAt }) : s.createTask(input)), task ? 'タスクを更新しました' : 'タスクを作成しました');
      onClose();
      onSaved?.(saved);
    } catch (e) {
      if (e instanceof AppError && e.code === 'conflict') {
        await reload();
        setConflict(true);
      } else if (e instanceof AppError) {
        setErrors(e.fieldErrors as FieldErrors<TaskInput>);
        setDetailsOpen(true);
      }
    } finally {
      setSaving(false);
    }
  };

  /** 削除は確認ダイアログを出さず即実行し、通知の「元に戻す」で取り消せるようにする */
  const deleteTask = async () => {
    if (!task) return;
    try {
      await run((s) => s.deleteTask(task.id), (d) => `タスク「${task.title}」を削除しました${d.removedSubtasks?.length ? `（サブタスク${d.removedSubtasks.length}件を含む）` : ''}`, { undo: (deleted) => (s) => s.restoreTask(deleted) });
      onClose();
    } catch {
      /* トースト表示済み */
    }
  };
  const duplicate = async () => {
    if (!task) return;
    try {
      await run((s) => s.tasks.duplicateTask(task.id), `「${task.title}」を複製しました`, { undo: (copy) => (s) => s.deleteTask(copy.id) });
      onClose();
    } catch {
      /* トースト表示済み */
    }
  };
  const addSubtask = async () => {
    if (!task || !subText.trim()) return;
    try {
      await run((s) => s.createTask({ employeeId: null, title: subText, description: '', assigneeDepartmentId: null, assignee: '', priority: 'medium', dueDate: null, status: 'todo', parentTaskId: task.id }), 'サブタスクを追加しました');
      setSubText('');
    } catch {
      /* トースト表示済み */
    }
  };

  const latest = task ? data.tasks.find((t) => t.id === task.id) : undefined;
  const loadLatest = () => {
    if (!latest) return;
    setForm(taskToInput(latest));
    setBaseUpdatedAt(latest.updatedAt);
    setConflict(false);
    setErrors({});
  };
  const overwrite = () => {
    setConflict(false);
    void save(latest?.updatedAt);
  };

  const linked = task?.employeeId ? empById.get(task.employeeId) : undefined;
  const checklist = form.checklist ?? [];

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        dirty={JSON.stringify(form) !== JSON.stringify(initial) || !!tagText.trim() || !!checkText.trim()}
        title={task ? 'タスクの編集' : isSubtask ? 'サブタスクの作成' : 'タスクの新規作成'}
        description={task?.source === 'onboarding' ? `入社準備ルールから自動生成されたタスクです${linked ? `（${linked.name}さん）` : ''}` : parent ? `親タスク：${parent.title}` : undefined}
        size="lg"
        footer={
          <>
            {task && (
              <div className="flex gap-2 sm:mr-auto">
                <Button variant="ghost" icon={Trash2} className="text-red-600 dark:text-red-400" onClick={deleteTask} disabled={saving} data-testid="task-delete">
                  削除
                </Button>
                <Button variant="ghost" icon={Copy} onClick={duplicate} disabled={saving} data-testid="task-duplicate">
                  複製
                </Button>
              </div>
            )}
            <ModalCancelButton disabled={saving} />
            <Button type="submit" form="task-form" icon={Save} loading={saving} data-testid="task-save">
              {task ? '更新する' : '作成する'}
            </Button>
          </>
        }
      >
        {task?.source === 'onboarding' && (
          <div className="mb-3">
            <AutoBadge />
          </div>
        )}
        {conflict && <ConflictNotice label="タスク" onLoadLatest={loadLatest} onOverwrite={overwrite} busy={saving} />}
        <form id="task-form" onSubmit={submit} noValidate className="grid grid-cols-2 gap-3 sm:gap-4">
          <TextField label="タスク名" required value={form.title} onChange={(e) => set('title', e.target.value)} error={errors.title} wrapClassName="col-span-2" maxLength={100} autoComplete="off" />
          <div className="col-span-2 sm:col-span-1">
            <TextField label="期限" type="date" value={form.dueDate ?? ''} onChange={(e) => set('dueDate', e.target.value || null)} error={errors.dueDate} hint={form.dueDate ? undefined : '未設定（期限なし）'} />
            {form.dueDate && (
              <button type="button" className="mt-1 inline-flex min-h-9 items-center gap-1 text-xs font-semibold text-navy-600 dark:text-navy-300" onClick={() => set('dueDate', null)}>
                <X className="size-3.5" aria-hidden />
                期限をなしにする
              </button>
            )}
          </div>
          <SelectField label="優先度" value={form.priority} onChange={(e) => set('priority', e.target.value as Priority)} options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))} error={errors.priority} />
          <SelectField label="進捗状況" value={form.status} onChange={(e) => set('status', e.target.value as TaskStatus)} options={TASK_STATUSES.map((s) => ({ value: s, label: TASK_STATUS_LABEL[s] }))} error={errors.status} />

          {/* チェックリスト (軽量な項目。担当・期限は持たない) */}
          <div className="col-span-2 rounded-xl border border-slate-200 p-3 dark:border-navy-700" data-testid="checklist-editor">
            <p className="mb-1.5 flex items-center gap-1.5 text-[13px] font-semibold">
              <ListChecks className="size-4" aria-hidden />
              チェックリスト
              {checklist.length > 0 && <span className="text-xs font-normal text-slate-500">{checklist.filter((c) => c.done).length}/{checklist.length} 完了</span>}
            </p>
            <ul className="space-y-1">
              {checklist.map((c) => (
                <li key={c.id} className="flex items-center gap-2">
                  <input type="checkbox" className="size-5 shrink-0 accent-navy-700" checked={c.done} onChange={(e) => updateCheck(c.id, { done: e.target.checked })} aria-label={`${c.text}を完了`} />
                  <input value={c.text} onChange={(e) => updateCheck(c.id, { text: e.target.value })} className={cx('h-10 min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-2 text-sm hover:border-slate-200 focus:border-navy-500 focus:outline-none dark:hover:border-navy-700', c.done && 'text-slate-400 line-through')} aria-label="チェック項目" maxLength={100} />
                  <button type="button" className="inline-flex size-10 items-center justify-center rounded-lg text-slate-400 hover:text-red-600" onClick={() => set('checklist', checklist.filter((x) => x.id !== c.id))} aria-label={`${c.text}を削除`}>
                    <X className="size-4" />
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-1.5 flex gap-2">
              <input
                value={checkText}
                onChange={(e) => setCheckText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    addCheck();
                  }
                }}
                placeholder="項目を追加（Enter）"
                className="h-10 min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 text-sm dark:border-navy-700 dark:bg-navy-950"
                aria-label="チェック項目を追加"
                maxLength={100}
                data-testid="checklist-input"
              />
              <Button type="button" variant="secondary" icon={Plus} onClick={addCheck} disabled={!checkText.trim()}>
                追加
              </Button>
            </div>
            {errors.checklist && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{errors.checklist}</p>}
          </div>

          {/* サブタスク (担当・期限を持つ独立したタスク。既存のタスクにだけ追加できる) */}
          {task && !isSubtask && (
            <div className="col-span-2 rounded-xl border border-slate-200 p-3 dark:border-navy-700" data-testid="subtask-editor">
              <p className="mb-1.5 text-[13px] font-semibold">
                サブタスク{subtasks.length > 0 && <span className="ml-1 text-xs font-normal text-slate-500">{subtasks.filter((t) => t.status === 'done').length}/{subtasks.length} 完了</span>}
              </p>
              <ul className="space-y-1" data-testid="subtask-list">
                {subtasks.map((t) => (
                  <li key={t.id} className="flex min-h-10 items-center gap-2 text-sm">
                    <input type="checkbox" className="size-5 shrink-0 accent-navy-700" checked={t.status === 'done'} onChange={(e) => changeStatus(t, e.target.checked ? 'done' : 'todo')} aria-label={`${t.title}を完了`} />
                    <span className={cx('flex-1', t.status === 'done' && 'text-slate-400 line-through')}>{t.title}</span>
                    {t.dueDate && <span className="text-xs text-slate-500">{t.dueDate.slice(5).replace('-', '/')}</span>}
                  </li>
                ))}
              </ul>
              <div className="mt-1.5 flex gap-2">
                <input
                  value={subText}
                  onChange={(e) => setSubText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void addSubtask();
                    }
                  }}
                  placeholder="サブタスクを追加（Enter）"
                  className="h-10 min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 text-sm dark:border-navy-700 dark:bg-navy-950"
                  aria-label="サブタスクを追加"
                  maxLength={100}
                  data-testid="subtask-input"
                />
                <Button type="button" variant="secondary" icon={Plus} onClick={() => void addSubtask()} disabled={!subText.trim()}>
                  追加
                </Button>
              </div>
              <p className="mt-1 text-[11px] text-slate-500">サブタスクは担当・期限を持つ独立したタスクとして一覧にも表示されます（1段まで）</p>
            </div>
          )}

          <details open={detailsOpen} onToggle={(e) => setDetailsOpen(e.currentTarget.open)} className="col-span-2 rounded-xl border border-slate-200 p-3 dark:border-navy-700" data-testid="task-details">
            <summary className="flex min-h-10 cursor-pointer items-center text-sm font-semibold">詳細（担当・プロジェクト・タグ・繰り返しなど）</summary>
            <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <TextField label="開始日" type="date" value={form.startDate ?? ''} onChange={(e) => set('startDate', e.target.value || null)} error={errors.startDate} />
              <TextField label="担当者" value={form.assignee} onChange={(e) => set('assignee', e.target.value)} error={errors.assignee} placeholder="例：中村 拓也" list="assignee-list" />
              <datalist id="assignee-list">
                {data.employees
                  .filter((e) => e.status === 'active')
                  .map((e) => (
                    <option key={e.id} value={e.name} />
                  ))}
              </datalist>
              <SelectField label="担当部署" value={form.assigneeDepartmentId ?? ''} onChange={(e) => set('assigneeDepartmentId', e.target.value || null)} options={data.departments.map((d) => ({ value: d.id, label: d.name }))} placeholder="（なし）" error={errors.assigneeDepartmentId} />
              <SelectField label="対象社員" value={form.employeeId ?? ''} onChange={(e) => set('employeeId', e.target.value || null)} options={employeeOptions} placeholder="（なし）" error={errors.employeeId} />
              <SelectField label="プロジェクト" value={form.projectId ?? ''} onChange={(e) => set('projectId', e.target.value || null)} options={projectOptions} placeholder="（なし）" error={errors.projectId} hint={projectOptions.length ? undefined : 'タスク画面の「プロジェクト」で作成できます'} />
              <div>
                <TextField
                  label="タグ"
                  value={tagText}
                  onChange={(e) => setTagText(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.key === 'Enter' || e.key === ',') && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      addTag(tagText);
                    }
                  }}
                  onBlur={() => tagText.trim() && addTag(tagText)}
                  placeholder="例：総務 重要（Enterで追加）"
                  list="tag-list"
                  error={errors.tags}
                  data-testid="tag-input"
                />
                <datalist id="tag-list">
                  {allTags.map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
                {(form.tags?.length ?? 0) > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1" data-testid="tag-chips">
                    {form.tags!.map((t) => (
                      <button key={t} type="button" onClick={() => set('tags', form.tags!.filter((x) => x !== t))} className="inline-flex min-h-8 items-center gap-1 rounded-full bg-navy-50 px-2.5 text-xs font-semibold text-navy-800 dark:bg-navy-800 dark:text-navy-100" aria-label={`タグ「${t}」を外す`}>
                        {t}
                        <X className="size-3" aria-hidden />
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="sm:col-span-2">
                <SelectField
                  label="繰り返し"
                  value={recurPreset}
                  onChange={(e) => set('recurrence', fromPreset(e.target.value as RecurPreset, form.recurrence))}
                  options={[
                    { value: '', label: 'しない' },
                    { value: 'daily', label: '毎日' },
                    { value: 'weekly', label: '毎週' },
                    { value: 'biweekly', label: '隔週' },
                    { value: 'monthly', label: '毎月（期限と同じ日）' },
                    { value: 'monthly_last', label: '毎月 月末' },
                    { value: 'yearly', label: '毎年' },
                    { value: 'custom', label: 'カスタム（間隔を指定）' },
                  ]}
                  error={errors.recurrence}
                  hint={form.recurrence ? `${describeRecurrence(form.recurrence)}：完了すると次回を自動で作成します（期限が必要）` : undefined}
                  data-testid="recurrence-select"
                />
                {form.recurrence && (recurPreset === 'custom' || form.recurrence.freq === 'weekly') && (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {recurPreset === 'custom' && (
                      <>
                        <SelectField label="単位" value={form.recurrence.freq} onChange={(e) => set('recurrence', { ...form.recurrence!, freq: e.target.value as Recurrence['freq'], weekdays: undefined, monthDay: undefined })} options={[{ value: 'daily', label: '日' }, { value: 'weekly', label: '週' }, { value: 'monthly', label: 'か月' }, { value: 'yearly', label: '年' }]} />
                        <TextField label="間隔" type="number" inputMode="numeric" min={1} max={365} value={String(form.recurrence.interval)} onChange={(e) => set('recurrence', { ...form.recurrence!, interval: Math.max(1, Math.min(365, Math.floor(Number(e.target.value) || 1))) })} hint={`${form.recurrence.interval}${{ daily: '日', weekly: '週', monthly: 'か月', yearly: '年' }[form.recurrence.freq]}ごと`} />
                      </>
                    )}
                    {form.recurrence.freq === 'weekly' && (
                      <fieldset className="col-span-2">
                        <legend className="mb-1 text-[13px] font-semibold">曜日（未選択なら期限と同じ曜日）</legend>
                        <div className="flex flex-wrap gap-1.5">
                          {WD.map((w, i) => {
                            const on = form.recurrence!.weekdays?.includes(i) ?? false;
                            return (
                              <button key={w} type="button" aria-pressed={on} onClick={() => set('recurrence', { ...form.recurrence!, weekdays: on ? form.recurrence!.weekdays!.filter((x) => x !== i) : [...(form.recurrence!.weekdays ?? []), i].sort() })} className={cx('size-10 rounded-full border text-sm font-semibold', on ? 'border-navy-700 bg-navy-700 text-white' : 'border-slate-300 text-slate-600 dark:border-navy-700 dark:text-slate-300')}>
                                {w}
                              </button>
                            );
                          })}
                        </div>
                      </fieldset>
                    )}
                    {recurPreset === 'custom' && form.recurrence.freq === 'monthly' && (
                      <SelectField label="日付" value={String(form.recurrence.monthDay ?? '')} onChange={(e) => set('recurrence', { ...form.recurrence!, monthDay: e.target.value === 'last' ? 'last' : e.target.value ? Number(e.target.value) : undefined })} options={[{ value: '', label: '期限と同じ日' }, { value: 'last', label: '月末' }, ...Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: `${i + 1}日` }))]} />
                    )}
                  </div>
                )}
              </div>

              {/* 前提タスク (依存関係)。必須ではない */}
              <div className="sm:col-span-2">
                <SelectField
                  label="前提タスク（このタスクの前に終わらせるもの）"
                  value=""
                  onChange={(e) => e.target.value && set('dependsOn', [...(form.dependsOn ?? []), e.target.value])}
                  options={depCandidates.map((t) => ({ value: t.id, label: t.title }))}
                  placeholder="（追加する場合は選択）"
                  error={errors.dependsOn}
                />
                {(form.dependsOn?.length ?? 0) > 0 && (
                  <ul className="mt-1.5 flex flex-wrap gap-1" data-testid="depends-chips">
                    {form.dependsOn!.map((id) => {
                      const t = data.tasks.find((x) => x.id === id);
                      return (
                        <li key={id}>
                          <button type="button" onClick={() => set('dependsOn', form.dependsOn!.filter((x) => x !== id))} className={cx('inline-flex min-h-8 items-center gap-1 rounded-full px-2.5 text-xs font-semibold', t?.status === 'done' ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200' : 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200')} aria-label={`前提タスク「${t?.title ?? '削除済み'}」を外す`}>
                            {t?.status === 'done' ? '✓ ' : ''}
                            {t?.title ?? '（削除済み）'}
                            <X className="size-3" aria-hidden />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              <TextAreaField label="詳細・メモ" value={form.description} onChange={(e) => set('description', e.target.value)} error={errors.description} wrapClassName="sm:col-span-2" maxLength={2000} />

              {(form.links?.length ?? 0) > 0 && (
                <div className="sm:col-span-2">
                  <p className="mb-1 text-[13px] font-semibold">関連データ</p>
                  <div className="flex flex-wrap gap-2">
                    {form.links!.map((l) => (
                      <a key={`${l.kind}:${l.id}`} href={linkHref(l)} className="inline-flex min-h-9 items-center rounded-lg bg-slate-100 px-3 text-xs font-semibold text-navy-700 dark:bg-navy-800 dark:text-navy-100">
                        {linkLabel(l, data)}
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </details>
        </form>
      </Modal>
      {statusDialog}
    </>
  );
}
