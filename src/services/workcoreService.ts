/**
 * アプリケーションサービス層。
 * 画面からの操作はすべてここを経由し、検証 → 永続化 → 操作履歴記録 を1トランザクションで行う。
 * UI (React) には依存しないため、テストや将来のAPI化でもそのまま使える。
 */
import { buildOnboardingPlan, materializePlan, type OnboardingPlan, type PlanItemOverride } from '../automation/onboardingEngine';
import { today as todayISO } from '../domain/date';
import { generateId, nowISO } from '../domain/id';
import {
  normalizeEmployeeNumber,
  validateEmployee,
  validateRule,
  validateTask,
  type EmployeeInput,
  type FieldErrors,
  type RuleInput,
  type TaskInput,
} from '../domain/validation';
import type { ActivityCategory, ActivityLog, DataSnapshot, Department, Employee, OnboardingRule, Task, TaskStatus } from '../domain/types';
import { TASK_STATUS_LABEL } from '../domain/types';
import type { BackupFile } from '../data/backup';
import type { IDBPTransaction, StoreNames } from 'idb';
import { STORE_NAMES, type WorkCoreDB, type WorkCoreSchema } from '../data/db';
import { createDemoData } from '../demo/demoData';

export class AppError extends Error {
  constructor(message: string, public readonly fieldErrors: Record<string, string> = {}) {
    super(message);
    this.name = 'AppError';
  }
}

function fail<T>(errors: FieldErrors<T>): never {
  const fieldErrors = errors as Record<string, string>;
  throw new AppError(Object.values(fieldErrors)[0] ?? '入力内容を確認してください', fieldErrors);
}

const MAX_ACTIVITIES = 300;

type WriteTx = IDBPTransaction<WorkCoreSchema, StoreNames<WorkCoreSchema>[], 'readwrite'>;

export class WorkCoreService {
  constructor(private readonly db: WorkCoreDB, private readonly clock: () => string = todayISO) {}

  today(): string {
    return this.clock();
  }

  // ---------- 読み込み ----------

  async loadSnapshot(): Promise<DataSnapshot> {
    const tx = this.db.transaction(['departments', 'employees', 'tasks', 'rules', 'activities'], 'readonly');
    const [departments, employees, tasks, rules, activities] = await Promise.all([
      tx.objectStore('departments').getAll(),
      tx.objectStore('employees').getAll(),
      tx.objectStore('tasks').getAll(),
      tx.objectStore('rules').getAll(),
      tx.objectStore('activities').getAll(),
    ]);
    await tx.done;
    departments.sort((a, b) => a.order - b.order);
    activities.sort((a, b) => b.at.localeCompare(a.at));
    return { departments, employees, tasks, rules, activities };
  }

  /** 初回起動時のみデモデータを投入する */
  async ensureInitialized(): Promise<boolean> {
    const seeded = await this.db.get('meta', 'initialized');
    if (seeded) return false;
    await this.replaceAll(createDemoData(this.today()), 'デモデータを生成しました（初回起動）');
    return true;
  }

  // ---------- 操作履歴 ----------

  private async log(tx: WriteTx, category: ActivityCategory, action: string, message: string, entityId: string | null = null) {
    const entry: ActivityLog = { id: generateId('act'), at: nowISO(), category, action, message, entityId };
    const store = tx.objectStore('activities');
    await store.put(entry);
    const count = await store.count();
    if (count > MAX_ACTIVITIES) {
      let cursor = await store.index('byAt').openCursor();
      let toDelete = count - MAX_ACTIVITIES;
      while (cursor && toDelete > 0) {
        await cursor.delete();
        toDelete--;
        cursor = await cursor.continue();
      }
    }
  }

  // ---------- 社員 ----------

  private async employeeContext(tx: WriteTx, selfId?: string) {
    const [existing, departments] = await Promise.all([tx.objectStore('employees').getAll(), tx.objectStore('departments').getAll()]);
    return { existing, departmentIds: departments.map((d) => d.id), selfId };
  }

  async createEmployee(input: EmployeeInput): Promise<Employee> {
    const tx = this.db.transaction(['employees', 'departments', 'activities'], 'readwrite');
    const v = validateEmployee(input, await this.employeeContext(tx));
    if (!v.ok) {
      tx.abort();
      await tx.done.catch(() => undefined);
      fail(v.errors);
    }
    const now = nowISO();
    const employee: Employee = {
      ...input,
      id: generateId('emp'),
      employeeNumber: normalizeEmployeeNumber(input.employeeNumber),
      name: input.name.trim(),
      position: input.position.trim(),
      notes: input.notes.trim(),
      retireDate: input.retireDate || null,
      createdAt: now,
      updatedAt: now,
    };
    await tx.objectStore('employees').add(employee);
    await this.log(tx, 'employee', 'create', `社員「${employee.name}」(${employee.employeeNumber}) を登録しました`, employee.id);
    await tx.done;
    return employee;
  }

  async updateEmployee(id: string, input: EmployeeInput): Promise<Employee> {
    const tx = this.db.transaction(['employees', 'departments', 'activities'], 'readwrite');
    const current = await tx.objectStore('employees').get(id);
    if (!current) {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw new AppError('対象の社員が見つかりません');
    }
    const v = validateEmployee(input, await this.employeeContext(tx, id));
    if (!v.ok) {
      tx.abort();
      await tx.done.catch(() => undefined);
      fail(v.errors);
    }
    const employee: Employee = {
      ...current,
      ...input,
      employeeNumber: normalizeEmployeeNumber(input.employeeNumber),
      name: input.name.trim(),
      position: input.position.trim(),
      notes: input.notes.trim(),
      retireDate: input.retireDate || null,
      updatedAt: nowISO(),
    };
    await tx.objectStore('employees').put(employee);
    await this.log(tx, 'employee', 'update', `社員「${employee.name}」の情報を更新しました`, id);
    await tx.done;
    return employee;
  }

  /** 社員を削除し、紐づくタスクも同時に削除する (孤立データを残さない) */
  async deleteEmployee(id: string): Promise<{ deletedTasks: number }> {
    const tx = this.db.transaction(['employees', 'tasks', 'activities'], 'readwrite');
    const emp = await tx.objectStore('employees').get(id);
    if (!emp) {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw new AppError('対象の社員が見つかりません');
    }
    const taskKeys = await tx.objectStore('tasks').index('byEmployee').getAllKeys(id);
    for (const k of taskKeys) await tx.objectStore('tasks').delete(k);
    await tx.objectStore('employees').delete(id);
    await this.log(tx, 'employee', 'delete', `社員「${emp.name}」を削除しました（関連タスク${taskKeys.length}件も削除）`, id);
    await tx.done;
    return { deletedTasks: taskKeys.length };
  }

  // ---------- タスク ----------

  private async taskContext(tx: WriteTx) {
    const [emps, depts] = await Promise.all([tx.objectStore('employees').getAllKeys(), tx.objectStore('departments').getAllKeys()]);
    return { employeeIds: emps, departmentIds: depts };
  }

  async createTask(input: TaskInput): Promise<Task> {
    const tx = this.db.transaction(['tasks', 'employees', 'departments', 'activities'], 'readwrite');
    const v = validateTask(input, await this.taskContext(tx));
    if (!v.ok) {
      tx.abort();
      await tx.done.catch(() => undefined);
      fail(v.errors);
    }
    const now = nowISO();
    const task: Task = {
      ...input,
      id: generateId('task'),
      title: input.title.trim(),
      assignee: input.assignee.trim(),
      description: input.description.trim(),
      source: 'manual',
      ruleId: null,
      createdAt: now,
      updatedAt: now,
      completedAt: input.status === 'done' ? now : null,
    };
    await tx.objectStore('tasks').add(task);
    await this.log(tx, 'task', 'create', `タスク「${task.title}」を作成しました`, task.id);
    await tx.done;
    return task;
  }

  async updateTask(id: string, input: TaskInput): Promise<Task> {
    const tx = this.db.transaction(['tasks', 'employees', 'departments', 'activities'], 'readwrite');
    const current = await tx.objectStore('tasks').get(id);
    if (!current) {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw new AppError('対象のタスクが見つかりません');
    }
    const v = validateTask(input, await this.taskContext(tx));
    if (!v.ok) {
      tx.abort();
      await tx.done.catch(() => undefined);
      fail(v.errors);
    }
    const now = nowISO();
    const task: Task = {
      ...current,
      ...input,
      title: input.title.trim(),
      assignee: input.assignee.trim(),
      description: input.description.trim(),
      updatedAt: now,
      completedAt: input.status === 'done' ? (current.completedAt ?? now) : null,
    };
    await tx.objectStore('tasks').put(task);
    const statusChanged = current.status !== task.status;
    await this.log(
      tx,
      'task',
      'update',
      statusChanged
        ? `タスク「${task.title}」を「${TASK_STATUS_LABEL[task.status]}」に変更しました`
        : `タスク「${task.title}」を更新しました`,
      id,
    );
    await tx.done;
    return task;
  }

  async setTaskStatus(id: string, status: TaskStatus): Promise<Task> {
    const tx = this.db.transaction(['tasks', 'activities'], 'readwrite');
    const current = await tx.objectStore('tasks').get(id);
    if (!current) {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw new AppError('対象のタスクが見つかりません');
    }
    const now = nowISO();
    const task: Task = { ...current, status, updatedAt: now, completedAt: status === 'done' ? (current.completedAt ?? now) : null };
    await tx.objectStore('tasks').put(task);
    await this.log(tx, 'task', 'status', `タスク「${task.title}」を「${TASK_STATUS_LABEL[status]}」に変更しました`, id);
    await tx.done;
    return task;
  }

  async deleteTask(id: string): Promise<void> {
    const tx = this.db.transaction(['tasks', 'activities'], 'readwrite');
    const current = await tx.objectStore('tasks').get(id);
    if (!current) {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw new AppError('対象のタスクが見つかりません');
    }
    await tx.objectStore('tasks').delete(id);
    await this.log(tx, 'task', 'delete', `タスク「${current.title}」を削除しました`, id);
    await tx.done;
  }

  // ---------- 入社準備自動化 ----------

  async previewOnboarding(employeeId: string): Promise<OnboardingPlan> {
    const tx = this.db.transaction(['employees', 'rules', 'tasks', 'departments'], 'readonly');
    const employee = await tx.objectStore('employees').get(employeeId);
    if (!employee) throw new AppError('対象の社員が見つかりません');
    const [rules, existingTasks, departments] = await Promise.all([
      tx.objectStore('rules').getAll(),
      tx.objectStore('tasks').index('byEmployee').getAll(employeeId),
      tx.objectStore('departments').getAll(),
    ]);
    await tx.done;
    try {
      return buildOnboardingPlan({ employee, rules, existingTasks, departments, today: this.today() });
    } catch (e) {
      throw new AppError(e instanceof Error ? e.message : '計画を作成できませんでした');
    }
  }

  /**
   * プレビュー内容をタスクとして登録する。
   * プレビュー後に別操作でタスクが増えている可能性があるため、書き込みトランザクション内で
   * 計画を再計算し、重複を再チェックしてから登録する。
   */
  async applyOnboarding(employeeId: string, overrides: Record<string, PlanItemOverride>): Promise<Task[]> {
    const tx = this.db.transaction(['employees', 'rules', 'tasks', 'departments', 'activities'], 'readwrite');
    const employee = await tx.objectStore('employees').get(employeeId);
    if (!employee) {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw new AppError('対象の社員が見つかりません');
    }
    const [rules, existingTasks, departments] = await Promise.all([
      tx.objectStore('rules').getAll(),
      tx.objectStore('tasks').index('byEmployee').getAll(employeeId),
      tx.objectStore('departments').getAll(),
    ]);
    let plan: OnboardingPlan;
    try {
      plan = buildOnboardingPlan({ employee, rules, existingTasks, departments, today: this.today() });
    } catch (e) {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw new AppError(e instanceof Error ? e.message : '計画を作成できませんでした');
    }
    const tasks = materializePlan(plan, overrides, nowISO());
    if (tasks.length === 0) {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw new AppError('登録対象のタスクがありません（すべて登録済みまたは未選択です）');
    }
    for (const t of tasks) await tx.objectStore('tasks').add(t);
    await this.log(tx, 'onboarding', 'generate', `${employee.name}さんの入社準備タスクを${tasks.length}件自動生成しました`, employeeId);
    await tx.done;
    return tasks;
  }

  // ---------- 入社準備ルール ----------

  async saveRule(input: RuleInput, id?: string): Promise<OnboardingRule> {
    const tx = this.db.transaction(['rules', 'departments', 'activities'], 'readwrite');
    const departmentIds = await tx.objectStore('departments').getAllKeys();
    const v = validateRule(input, { departmentIds });
    if (!v.ok) {
      tx.abort();
      await tx.done.catch(() => undefined);
      fail(v.errors);
    }
    const now = nowISO();
    let rule: OnboardingRule;
    if (id) {
      const current = await tx.objectStore('rules').get(id);
      if (!current) {
        tx.abort();
        await tx.done.catch(() => undefined);
        throw new AppError('対象のルールが見つかりません');
      }
      rule = { ...current, ...input, title: input.title.trim(), defaultAssignee: input.defaultAssignee.trim(), updatedAt: now };
    } else {
      const all = await tx.objectStore('rules').getAll();
      rule = {
        ...input,
        title: input.title.trim(),
        defaultAssignee: input.defaultAssignee.trim(),
        id: generateId('rule'),
        order: all.reduce((m, r) => Math.max(m, r.order), 0) + 1,
        createdAt: now,
        updatedAt: now,
      };
    }
    await tx.objectStore('rules').put(rule);
    await this.log(tx, 'rule', id ? 'update' : 'create', `入社準備ルール「${rule.title}」を${id ? '更新' : '追加'}しました`, rule.id);
    await tx.done;
    return rule;
  }

  async deleteRule(id: string): Promise<void> {
    const tx = this.db.transaction(['rules', 'activities'], 'readwrite');
    const current = await tx.objectStore('rules').get(id);
    if (!current) {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw new AppError('対象のルールが見つかりません');
    }
    await tx.objectStore('rules').delete(id);
    // 生成済みタスクは業務記録として残す (ruleId は重複判定の履歴として保持)
    await this.log(tx, 'rule', 'delete', `入社準備ルール「${current.title}」を削除しました`, id);
    await tx.done;
  }

  // ---------- 部署 ----------

  async addDepartment(name: string): Promise<Department> {
    const trimmed = name.trim();
    if (!trimmed) throw new AppError('部署名を入力してください');
    if (trimmed.length > 30) throw new AppError('部署名は30文字以内で入力してください');
    const tx = this.db.transaction(['departments', 'activities'], 'readwrite');
    const all = await tx.objectStore('departments').getAll();
    if (all.some((d) => d.name === trimmed)) {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw new AppError(`部署「${trimmed}」は既に存在します`);
    }
    const dept: Department = { id: generateId('dept'), name: trimmed, order: all.reduce((m, d) => Math.max(m, d.order), 0) + 1 };
    await tx.objectStore('departments').add(dept);
    await this.log(tx, 'department', 'create', `部署「${trimmed}」を追加しました`, dept.id);
    await tx.done;
    return dept;
  }

  async renameDepartment(id: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) throw new AppError('部署名を入力してください');
    if (trimmed.length > 30) throw new AppError('部署名は30文字以内で入力してください');
    const tx = this.db.transaction(['departments', 'activities'], 'readwrite');
    const all = await tx.objectStore('departments').getAll();
    const current = all.find((d) => d.id === id);
    if (!current || all.some((d) => d.id !== id && d.name === trimmed)) {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw new AppError(current ? `部署「${trimmed}」は既に存在します` : '対象の部署が見つかりません');
    }
    await tx.objectStore('departments').put({ ...current, name: trimmed });
    await this.log(tx, 'department', 'update', `部署名を「${current.name}」から「${trimmed}」に変更しました`, id);
    await tx.done;
  }

  /** 社員・タスク・ルールから参照されている部署は削除できない */
  async deleteDepartment(id: string): Promise<void> {
    const tx = this.db.transaction(['departments', 'employees', 'tasks', 'rules', 'activities'], 'readwrite');
    const current = await tx.objectStore('departments').get(id);
    const [empCount, tasks, rules] = await Promise.all([
      tx.objectStore('employees').index('byDepartment').count(id),
      tx.objectStore('tasks').getAll(),
      tx.objectStore('rules').getAll(),
    ]);
    const taskCount = tasks.filter((t) => t.assigneeDepartmentId === id).length;
    const ruleCount = rules.filter((r) => r.scope === id || r.assigneeDepartmentId === id).length;
    if (!current || empCount + taskCount + ruleCount > 0) {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw new AppError(
        current
          ? `この部署は使用中のため削除できません（社員${empCount}名・タスク${taskCount}件・ルール${ruleCount}件）`
          : '対象の部署が見つかりません',
      );
    }
    await tx.objectStore('departments').delete(id);
    await this.log(tx, 'department', 'delete', `部署「${current.name}」を削除しました`, id);
    await tx.done;
  }

  // ---------- データ管理 ----------

  private async replaceAll(data: DataSnapshot, message: string): Promise<void> {
    const tx = this.db.transaction([...STORE_NAMES], 'readwrite');
    await Promise.all(STORE_NAMES.map((s) => tx.objectStore(s).clear()));
    for (const d of data.departments) await tx.objectStore('departments').put(d);
    for (const e of data.employees) await tx.objectStore('employees').put(e);
    for (const t of data.tasks) await tx.objectStore('tasks').put(t);
    for (const r of data.rules) await tx.objectStore('rules').put(r);
    for (const a of data.activities) await tx.objectStore('activities').put(a);
    await tx.objectStore('meta').put({ key: 'initialized', value: nowISO() });
    await this.log(tx, 'data', 'replace', message);
    await tx.done;
  }

  async restoreBackup(backup: BackupFile): Promise<void> {
    await this.replaceAll(backup.data, `バックアップ（${backup.exportedAt.slice(0, 10) || '日付不明'}）から復元しました`);
  }

  async resetDemoData(): Promise<void> {
    await this.replaceAll(createDemoData(this.today()), 'デモデータを初期化しました');
  }

  /** 全データを削除し、部署とルールだけの空の状態にする */
  async clearBusinessData(): Promise<void> {
    const demo = createDemoData(this.today());
    await this.replaceAll(
      { departments: demo.departments, rules: demo.rules, employees: [], tasks: [], activities: [] },
      '社員・タスクデータを全削除しました（部署・ルールは初期設定）',
    );
  }

  async recordExport(message: string): Promise<void> {
    const tx = this.db.transaction(['activities'], 'readwrite');
    await this.log(tx, 'data', 'export', message);
    await tx.done;
  }
}
