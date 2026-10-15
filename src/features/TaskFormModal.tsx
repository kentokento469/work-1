import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Save, Trash2 } from 'lucide-react';
import { useAppData } from '../app/AppData';
import { addDays } from '../domain/date';
import { PRIORITIES, PRIORITY_LABEL, TASK_STATUSES, TASK_STATUS_LABEL, type Priority, type Task, type TaskStatus } from '../domain/types';
import { validateTask, type FieldErrors, type TaskInput } from '../domain/validation';
import { AppError } from '../services/workcoreService';
import { Modal, ModalCancelButton } from '../ui/Modal';
import { AutoBadge } from '../ui/badges';
import { Button, SelectField, TextAreaField, TextField } from '../ui/primitives';

export function TaskFormModal({
  open,
  onClose,
  task,
  defaultEmployeeId,
}: {
  open: boolean;
  onClose: () => void;
  task?: Task;
  defaultEmployeeId?: string | null;
}) {
  const { data, run, today, empById } = useAppData();

  const initial = useMemo<TaskInput>(
    () =>
      task
        ? {
            employeeId: task.employeeId,
            title: task.title,
            description: task.description,
            assigneeDepartmentId: task.assigneeDepartmentId,
            assignee: task.assignee,
            priority: task.priority,
            dueDate: task.dueDate,
            status: task.status,
          }
        : {
            employeeId: defaultEmployeeId ?? null,
            title: '',
            description: '',
            assigneeDepartmentId: '',
            assignee: '',
            priority: 'medium',
            dueDate: addDays(today, 7),
            status: 'todo',
          },
    // 入力中のデータ再読み込みで入力を消さないよう、対象は ID で判定する
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [task?.id, defaultEmployeeId, today, open],
  );

  const [form, setForm] = useState<TaskInput>(initial);
  const [errors, setErrors] = useState<FieldErrors<TaskInput>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(initial);
      setErrors({});
    }
  }, [open, initial]);

  const set = <K extends keyof TaskInput>(key: K, value: TaskInput[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  // 対象社員の選択肢: 退職者は除く (ただし編集中タスクの対象者は残す)
  const employeeOptions = data.employees
    .filter((e) => e.status !== 'retired' || e.id === form.employeeId)
    .sort((a, b) => a.employeeNumber.localeCompare(b.employeeNumber))
    .map((e) => ({ value: e.id, label: `${e.name}（${e.employeeNumber}）` }));

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const v = validateTask(form, { employeeIds: data.employees.map((e) => e.id), departmentIds: data.departments.map((d) => d.id) });
    if (!v.ok) {
      setErrors(v.errors);
      return;
    }
    setSaving(true);
    try {
      await run((s) => (task ? s.updateTask(task.id, form) : s.createTask(form)), task ? 'タスクを更新しました' : 'タスクを作成しました');
      onClose();
    } catch (e) {
      if (e instanceof AppError) setErrors(e.fieldErrors as FieldErrors<TaskInput>);
    } finally {
      setSaving(false);
    }
  };

  /** 削除は確認ダイアログを出さず即実行し、通知の「元に戻す」で取り消せるようにする */
  const deleteTask = async () => {
    if (!task) return;
    try {
      await run((s) => s.deleteTask(task.id), `タスク「${task.title}」を削除しました`, { undo: (deleted) => (s) => s.restoreTask(deleted) });
      onClose();
    } catch {
      /* トースト表示済み */
    }
  };

  const linked = task?.employeeId ? empById.get(task.employeeId) : undefined;

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        dirty={JSON.stringify(form) !== JSON.stringify(initial)}
        title={task ? 'タスクの編集' : 'タスクの新規作成'}
        description={task?.source === 'onboarding' ? `入社準備ルールから自動生成されたタスクです${linked ? `（${linked.name}さん）` : ''}` : undefined}
        footer={
          <>
            {task && (
              <Button variant="ghost" icon={Trash2} className="text-red-600 sm:mr-auto dark:text-red-400" onClick={deleteTask} disabled={saving}>
                削除
              </Button>
            )}
            <ModalCancelButton disabled={saving} />
            <Button type="submit" form="task-form" icon={Save} loading={saving}>
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
        <form id="task-form" onSubmit={submit} noValidate className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField label="タスク名" required value={form.title} onChange={(e) => set('title', e.target.value)} error={errors.title} wrapClassName="sm:col-span-2" maxLength={100} />
          <SelectField
            label="対象社員"
            value={form.employeeId ?? ''}
            onChange={(e) => set('employeeId', e.target.value || null)}
            options={employeeOptions}
            placeholder="（紐付けなし）"
            error={errors.employeeId}
            wrapClassName="sm:col-span-2"
          />
          <SelectField
            label="担当部署"
            required
            value={form.assigneeDepartmentId}
            onChange={(e) => set('assigneeDepartmentId', e.target.value)}
            options={data.departments.map((d) => ({ value: d.id, label: d.name }))}
            placeholder="選択してください"
            error={errors.assigneeDepartmentId}
          />
          <TextField label="担当者" value={form.assignee} onChange={(e) => set('assignee', e.target.value)} error={errors.assignee} placeholder="例：中村 拓也" list="assignee-list" />
          <datalist id="assignee-list">
            {data.employees
              .filter((e) => e.status === 'active')
              .map((e) => (
                <option key={e.id} value={e.name} />
              ))}
          </datalist>
          <SelectField
            label="優先度"
            required
            value={form.priority}
            onChange={(e) => set('priority', e.target.value as Priority)}
            options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))}
            error={errors.priority}
          />
          <TextField label="期限" required type="date" value={form.dueDate} onChange={(e) => set('dueDate', e.target.value)} error={errors.dueDate} />
          <SelectField
            label="進捗状況"
            required
            value={form.status}
            onChange={(e) => set('status', e.target.value as TaskStatus)}
            options={TASK_STATUSES.map((s) => ({ value: s, label: TASK_STATUS_LABEL[s] }))}
            error={errors.status}
            wrapClassName="sm:col-span-2"
          />
          <TextAreaField label="詳細・メモ" value={form.description} onChange={(e) => set('description', e.target.value)} error={errors.description} wrapClassName="sm:col-span-2" maxLength={1000} />
        </form>
      </Modal>
    </>
  );
}
