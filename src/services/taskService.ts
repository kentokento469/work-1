/**
 * タスク管理のサービス (Phase 7)。
 *
 * 手動のタスクも、入社準備・問い合わせ・自動化などから生成されたタスクも、同じ tasks ストア・同じ処理で扱う。
 * - 担当部署・期限・社員は任意。タスク名だけで登録できる
 * - 繰り返し: 完了したときに次回を1件だけ作る (nextOccurrenceId で二重生成を防ぐ)
 * - サブタスク: 1段まで。親を削除するとサブタスクも一緒に削除し、元に戻すと一緒に戻る
 * - プロジェクト: 削除してもタスクは消さず、所属を外す (元に戻すと再び所属させる)
 */
import { generateId, nowISO } from '../domain/id';
import { addDays, diffDays } from '../domain/date';
import { nextScheduledDue } from '../domain/recurrence';
import { TASK_STATUS_LABEL, type ChecklistItem, type Project, type Task, type TaskSource, type TaskStatus } from '../domain/types';
import { validateTask, type TaskInput } from '../domain/validation';
import type { WorkCoreDB } from '../data/db';
import { AppError, abortWith, appendInquiryEvent, conflictError, fieldError, guardTx, inquiryEvent, logActivity, type UpdateOptions, type WriteTx } from './common';

export interface DeletedTask extends Task {
  /** 一緒に削除したサブタスク (元に戻す用) */
  removedSubtasks?: Task[];
}

const TASK_STORES = ['tasks', 'employees', 'departments', 'projects', 'activities', 'inquiries'] as const;

/** 入力の正規化 (空白の除去・重複の除去・存在しない前提タスクの除外・繰り返しの基準日の補完) */
function normalize(input: TaskInput, existingIds: Set<string>): TaskInput {
  const tags = input.tags ? [...new Set(input.tags.map((t) => t.trim()).filter(Boolean))] : undefined;
  const checklist = input.checklist?.map((c) => ({ id: c.id || generateId('chk'), text: c.text.trim(), done: !!c.done })).filter((c) => c.text);
  const dependsOn = input.dependsOn ? [...new Set(input.dependsOn)].filter((id) => existingIds.has(id)) : undefined;
  const recurrence = input.recurrence ? { ...input.recurrence, anchor: input.recurrence.anchor ?? input.dueDate ?? undefined } : input.recurrence;
  return {
    ...input,
    title: input.title.trim(),
    assignee: input.assignee.trim(),
    description: input.description.trim(),
    assigneeDepartmentId: input.assigneeDepartmentId || null,
    dueDate: input.dueDate || null,
    startDate: input.startDate || null,
    projectId: input.projectId || null,
    parentTaskId: input.parentTaskId || null,
    ...(tags !== undefined && { tags }),
    ...(checklist !== undefined && { checklist }),
    ...(dependsOn !== undefined && { dependsOn }),
    ...(recurrence !== undefined && { recurrence }),
  };
}

export class TaskService {
  constructor(private readonly db: WorkCoreDB, private readonly clock: () => string) {}

  private async context(tx: WriteTx, selfId?: string) {
    const [emps, depts, projects, tasks] = await Promise.all([
      tx.objectStore('employees').getAllKeys(),
      tx.objectStore('departments').getAllKeys(),
      tx.objectStore('projects').getAllKeys(),
      tx.objectStore('tasks').getAll(),
    ]);
    return { employeeIds: emps, departmentIds: depts, projectIds: projects, tasks, selfId };
  }

  /** 問い合わせ由来のタスクの状態変化を、問い合わせの対応履歴にも残す */
  private async reflectToInquiry(tx: WriteTx, before: Task, after: Task) {
    if (!after.inquiryId || before.status === after.status) return;
    await appendInquiryEvent(tx, after.inquiryId, inquiryEvent('task', `タスク「${after.title}」が「${TASK_STATUS_LABEL[after.status]}」になりました`));
  }

  /**
   * 完了したタスクが繰り返しなら、次回を1件だけ作る。
   * すでに作成済み (nextOccurrenceId がある) なら作らない = 完了 → 未完了 → 完了 を繰り返しても重複しない
   */
  private async spawnNextOccurrence(tx: WriteTx, task: Task, now: string): Promise<Task | null> {
    if (task.status !== 'done' || !task.recurrence || !task.dueDate || task.nextOccurrenceId) return null;
    // 次回の期限: 前回の予定日 (または完了日) から計算し、休みの日の扱いに従って調整する (Phase 12)
    const { due, raw } = nextScheduledDue(task.recurrence, task.dueDate, this.clock(), this.clock());
    const startDate = task.startDate ? addDays(due, diffDays(task.dueDate, task.startDate)) : null;
    const next: Task = {
      ...task,
      id: generateId('task'),
      status: 'todo',
      dueDate: due,
      startDate,
      recurrence: { ...task.recurrence, lastRaw: raw },
      checklist: task.checklist?.map((c) => ({ ...c, done: false })),
      seriesId: task.seriesId ?? task.id,
      nextOccurrenceId: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    await tx.objectStore('tasks').add(next);
    await tx.objectStore('tasks').put({ ...task, seriesId: task.seriesId ?? task.id, nextOccurrenceId: next.id });
    await logActivity(tx, 'task', 'recur', `繰り返しタスク「${task.title}」の次回（期限 ${due}）を作成しました`, next.id);
    return next;
  }

  async createTask(input: TaskInput, opts: { source?: TaskSource } = {}): Promise<Task> {
    const tx = this.db.transaction([...TASK_STORES], 'readwrite');
    const ctx = await this.context(tx);
    const clean = normalize(input, new Set(ctx.tasks.map((t) => t.id)));
    const v = validateTask(clean, ctx);
    if (!v.ok) return abortWith(tx, fieldError(v.errors));
    const now = nowISO();
    const parent = clean.parentTaskId ? ctx.tasks.find((t) => t.id === clean.parentTaskId) : undefined;
    const task: Task = {
      ...clean,
      // サブタスクは、指定がなければ親のプロジェクト・対象社員を引き継ぐ
      projectId: clean.projectId ?? parent?.projectId ?? null,
      employeeId: clean.employeeId ?? parent?.employeeId ?? null,
      id: generateId('task'),
      source: opts.source ?? 'manual',
      ruleId: null,
      inquiryId: null,
      createdAt: now,
      updatedAt: now,
      completedAt: clean.status === 'done' ? now : null,
    };
    await tx.objectStore('tasks').add(task);
    await logActivity(tx, 'task', 'create', `タスク「${task.title}」を作成しました`, task.id);
    await tx.done;
    return task;
  }

  async updateTask(id: string, input: TaskInput, opts: UpdateOptions = {}): Promise<Task> {
    const tx = this.db.transaction([...TASK_STORES], 'readwrite');
    return guardTx(tx, async () => {
      const current = await tx.objectStore('tasks').get(id);
      if (!current) return abortWith(tx, '対象のタスクが見つかりません（別のタブ・画面で削除された可能性があります）');
      if (opts.expectedUpdatedAt && current.updatedAt !== opts.expectedUpdatedAt) return abortWith(tx, conflictError('タスク', current.updatedAt));
      const ctx = await this.context(tx, id);
      const clean = normalize(input, new Set(ctx.tasks.map((t) => t.id)));
      const v = validateTask(clean, ctx);
      if (!v.ok) return abortWith(tx, fieldError(v.errors));
      const now = nowISO();
      const task: Task = {
        ...current,
        ...clean,
        updatedAt: now,
        completedAt: clean.status === 'done' ? (current.completedAt ?? now) : null,
      };
      await tx.objectStore('tasks').put(task);
      await this.reflectToInquiry(tx, current, task);
      if (current.status !== 'done') await this.spawnNextOccurrence(tx, task, now);
      const statusChanged = current.status !== task.status;
      await logActivity(tx, 'task', 'update', statusChanged ? `タスク「${task.title}」を「${TASK_STATUS_LABEL[task.status]}」に変更しました` : `タスク「${task.title}」を更新しました`, id);
      return task;
    });
  }

  /**
   * ステータス変更。戻り値の previousStatus は Undo 用。
   * completeSubtasks = true なら未完了のサブタスクも完了にする (親の完了時に利用者が選んだ場合)
   */
  async setTaskStatus(id: string, status: TaskStatus, opts: { completeSubtasks?: boolean } = {}): Promise<Task & { previousStatus: TaskStatus; nextOccurrence?: Task | null }> {
    const tx = this.db.transaction(['tasks', 'activities', 'inquiries'], 'readwrite');
    return guardTx(tx, async () => {
      const current = await tx.objectStore('tasks').get(id);
      if (!current) return abortWith(tx, '対象のタスクが見つかりません');
      const now = nowISO();
      const task: Task = { ...current, status, updatedAt: now, completedAt: status === 'done' ? (current.completedAt ?? now) : null };
      await tx.objectStore('tasks').put(task);
      await this.reflectToInquiry(tx, current, task);
      if (status === 'done' && opts.completeSubtasks) {
        const subs = (await tx.objectStore('tasks').getAll()).filter((t) => t.parentTaskId === id && t.status !== 'done');
        for (const s of subs) {
          const done = { ...s, status: 'done' as const, updatedAt: now, completedAt: now };
          await tx.objectStore('tasks').put(done);
          await this.reflectToInquiry(tx, s, done);
        }
      }
      const next = current.status !== 'done' ? await this.spawnNextOccurrence(tx, task, now) : null;
      await logActivity(tx, 'task', 'status', `タスク「${task.title}」を「${TASK_STATUS_LABEL[status]}」に変更しました`, id);
      return { ...task, previousStatus: current.status, nextOccurrence: next };
    });
  }

  /** 削除したタスクを返す (Undo 用)。サブタスクも一緒に削除する */
  async deleteTask(id: string): Promise<DeletedTask> {
    const tx = this.db.transaction(['tasks', 'activities', 'inquiries'], 'readwrite');
    return guardTx(tx, async () => {
      const current = await tx.objectStore('tasks').get(id);
      if (!current) return abortWith(tx, '対象のタスクが見つかりません');
      const subs = (await tx.objectStore('tasks').getAll()).filter((t) => t.parentTaskId === id);
      for (const t of [current, ...subs]) {
        await tx.objectStore('tasks').delete(t.id);
        if (t.inquiryId) await appendInquiryEvent(tx, t.inquiryId, inquiryEvent('task', `タスク「${t.title}」を削除しました`));
      }
      await logActivity(tx, 'task', 'delete', `タスク「${current.title}」を削除しました${subs.length ? `（サブタスク${subs.length}件を含む）` : ''}`, id);
      return { ...current, removedSubtasks: subs };
    });
  }

  async restoreTask(deleted: DeletedTask): Promise<void> {
    const tx = this.db.transaction(['tasks', 'employees', 'inquiries', 'projects', 'activities'], 'readwrite');
    return guardTx(tx, async () => {
      const { removedSubtasks = [], ...task } = deleted;
      if (await tx.objectStore('tasks').get(task.id)) return abortWith(tx, 'このタスクは既に存在します');
      for (const t of [task as Task, ...removedSubtasks]) {
        // 紐付け先が消えていたら紐付けを外して復元する
        const employeeId = t.employeeId && (await tx.objectStore('employees').get(t.employeeId)) ? t.employeeId : null;
        const inquiryId = t.inquiryId && (await tx.objectStore('inquiries').get(t.inquiryId)) ? t.inquiryId : null;
        const projectId = t.projectId && (await tx.objectStore('projects').get(t.projectId)) ? t.projectId : null;
        await tx.objectStore('tasks').put({ ...t, employeeId, inquiryId, projectId });
        if (inquiryId) await appendInquiryEvent(tx, inquiryId, inquiryEvent('task', `タスク「${t.title}」の削除を取り消しました`));
      }
      await logActivity(tx, 'task', 'restore', `タスク「${task.title}」の削除を取り消しました`, task.id);
    });
  }

  /** 複製 (未着手・チェックリスト未完了の状態で作る。繰り返しは別の系列になる) */
  async duplicateTask(id: string): Promise<Task> {
    const tx = this.db.transaction(['tasks', 'activities'], 'readwrite');
    const src = await tx.objectStore('tasks').get(id);
    if (!src) return abortWith(tx, '対象のタスクが見つかりません');
    const now = nowISO();
    const copy: Task = {
      ...src,
      id: generateId('task'),
      title: `${src.title}（コピー）`.slice(0, 100),
      status: 'todo',
      source: 'manual',
      ruleId: null,
      checklist: src.checklist?.map((c) => ({ ...c, id: generateId('chk'), done: false })),
      seriesId: null,
      nextOccurrenceId: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    await tx.objectStore('tasks').add(copy);
    await logActivity(tx, 'task', 'duplicate', `タスク「${src.title}」を複製しました`, copy.id);
    await tx.done;
    return copy;
  }

  /** チェックリストの1項目の完了を切り替える */
  async toggleChecklistItem(taskId: string, itemId: string, done: boolean): Promise<Task> {
    const tx = this.db.transaction(['tasks'], 'readwrite');
    const t = await tx.objectStore('tasks').get(taskId);
    if (!t) return abortWith(tx, '対象のタスクが見つかりません');
    const checklist: ChecklistItem[] = (t.checklist ?? []).map((c) => (c.id === itemId ? { ...c, done } : c));
    const next = { ...t, checklist, updatedAt: nowISO() };
    await tx.objectStore('tasks').put(next);
    await tx.done;
    return next;
  }

  /** 期限だけを変更 (カレンダーからの操作) */
  async setDueDate(taskId: string, dueDate: string | null): Promise<Task> {
    const tx = this.db.transaction([...TASK_STORES], 'readwrite');
    const t = await tx.objectStore('tasks').get(taskId);
    if (!t) return abortWith(tx, '対象のタスクが見つかりません');
    const input: TaskInput = { ...t, dueDate };
    const v = validateTask(input, await this.context(tx, taskId));
    if (!v.ok) return abortWith(tx, fieldError(v.errors));
    const next = { ...t, dueDate, updatedAt: nowISO() };
    await tx.objectStore('tasks').put(next);
    await logActivity(tx, 'task', 'update', `タスク「${t.title}」の期限を${dueDate ?? 'なし'}に変更しました`, taskId);
    await tx.done;
    return next;
  }

  // ---------- プロジェクト ----------

  async saveProject(input: { name: string; description: string }, id?: string): Promise<Project> {
    const name = input.name.trim();
    if (!name) throw new AppError('プロジェクト名を入力してください', { name: 'プロジェクト名を入力してください' });
    if (name.length > 50) throw new AppError('プロジェクト名は50文字以内で入力してください', { name: 'プロジェクト名は50文字以内で入力してください' });
    const tx = this.db.transaction(['projects', 'activities'], 'readwrite');
    const all = await tx.objectStore('projects').getAll();
    if (all.some((p) => p.id !== id && p.name === name && !p.archived)) return abortWith(tx, new AppError(`「${name}」というプロジェクトは既にあります`, { name: '同じ名前のプロジェクトがあります' }));
    const now = nowISO();
    const current = id ? all.find((p) => p.id === id) : undefined;
    if (id && !current) return abortWith(tx, '対象のプロジェクトが見つかりません');
    const project: Project = current ? { ...current, name, description: input.description.trim(), updatedAt: now } : { id: generateId('prj'), name, description: input.description.trim(), archived: false, createdAt: now, updatedAt: now };
    await tx.objectStore('projects').put(project);
    await logActivity(tx, 'project', current ? 'update' : 'create', `プロジェクト「${name}」を${current ? '更新' : '作成'}しました`, project.id);
    await tx.done;
    return project;
  }

  async setProjectArchived(id: string, archived: boolean): Promise<Project> {
    const tx = this.db.transaction(['projects', 'activities'], 'readwrite');
    const p = await tx.objectStore('projects').get(id);
    if (!p) return abortWith(tx, '対象のプロジェクトが見つかりません');
    const next = { ...p, archived, updatedAt: nowISO() };
    await tx.objectStore('projects').put(next);
    await logActivity(tx, 'project', archived ? 'archive' : 'unarchive', `プロジェクト「${p.name}」を${archived ? 'アーカイブ' : 'アーカイブから戻'}しました`, id);
    await tx.done;
    return next;
  }

  /** 削除: タスクは消さず、所属だけ外す。戻り値は元に戻す用 */
  async deleteProject(id: string): Promise<{ project: Project; taskIds: string[] }> {
    const tx = this.db.transaction(['projects', 'tasks', 'activities'], 'readwrite');
    return guardTx(tx, async () => {
      const p = await tx.objectStore('projects').get(id);
      if (!p) return abortWith(tx, '対象のプロジェクトが見つかりません');
      const tasks = (await tx.objectStore('tasks').getAll()).filter((t) => t.projectId === id);
      for (const t of tasks) await tx.objectStore('tasks').put({ ...t, projectId: null });
      await tx.objectStore('projects').delete(id);
      await logActivity(tx, 'project', 'delete', `プロジェクト「${p.name}」を削除しました（タスク${tasks.length}件は残し、所属を外しました）`, id);
      return { project: p, taskIds: tasks.map((t) => t.id) };
    });
  }

  async restoreProject(deleted: { project: Project; taskIds: string[] }): Promise<void> {
    const tx = this.db.transaction(['projects', 'tasks', 'activities'], 'readwrite');
    return guardTx(tx, async () => {
      if (await tx.objectStore('projects').get(deleted.project.id)) return abortWith(tx, 'このプロジェクトは既に存在します');
      await tx.objectStore('projects').put(deleted.project);
      for (const id of deleted.taskIds) {
        const t = await tx.objectStore('tasks').get(id);
        if (t && !t.projectId) await tx.objectStore('tasks').put({ ...t, projectId: deleted.project.id });
      }
      await logActivity(tx, 'project', 'restore', `プロジェクト「${deleted.project.name}」の削除を取り消しました`, deleted.project.id);
    });
  }
}
