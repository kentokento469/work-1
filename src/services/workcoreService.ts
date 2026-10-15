/**
 * アプリケーションサービス層 (社員・タスク・入社準備・部署・データ管理)。
 * 画面からの操作はすべてここを経由し、検証 → 永続化 → 操作履歴記録 を1トランザクションで行う。
 * UI (React) には依存しないため、テストや将来のAPI化でもそのまま使える。
 * ヘルプデスク関連は HelpdeskService (this.helpdesk) に分離している。
 */
import { buildOnboardingPlan, materializePlan, type OnboardingPlan, type PlanItemOverride } from '../automation/onboardingEngine';
import { today as todayISO } from '../domain/date';
import { generateId, nowISO } from '../domain/id';
import { cleanContact, normalizeEmployeeNumber, validateEmployee, validateRule, validateTask, type EmployeeInput, type RuleInput, type TaskInput } from '../domain/validation';
import { TASK_STATUS_LABEL, type DataSnapshot, type Department, type Employee, type OnboardingRule, type Task, type TaskStatus } from '../domain/types';
import type { BackupFile } from '../data/backup';
import { DATA_STORES, STORE_NAMES, type WorkCoreDB } from '../data/db';
import { emptyInventory } from '../domain/inventory/defaults';
import { InventoryService } from './inventoryService';
import { createDemoData, createHelpdeskDemoData } from '../demo/demoData';
import { createDefaultInquiryCategories } from '../domain/helpdesk/defaults';
import { AppError, abortWith, appendInquiryEvent, fieldError, inquiryEvent, logActivity, type WriteTx } from './common';
import { HelpdeskService } from './helpdeskService';
import { ALL_AUTOMATIONS } from '../automation/registry';
import { pendingProposals } from '../automation/engine';
import { AUTOMATION_SETTING_ID, readAutomationSettings, ruleSetting, type RuleSetting } from '../automation/settings';
import { computeAllStock } from '../domain/inventory/stock';
import { DocumentService } from './documentService';
import type { DocumentFile } from '../domain/documents/types';

export { AppError } from './common';

/** 削除の取り消し (Undo) 用に保持するデータ */
export interface DeletedEmployee {
  employee: Employee;
  tasks: Task[];
  /** 関連付けを外した書類 (取り消し時に戻す) */
  unlinkedDocumentIds?: string[];
}

export class WorkCoreService {
  readonly helpdesk: HelpdeskService;
  readonly inventory: InventoryService;
  readonly documents: DocumentService;

  constructor(private readonly db: WorkCoreDB, private readonly clock: () => string = todayISO) {
    this.helpdesk = new HelpdeskService(db, clock);
    this.inventory = new InventoryService(db, clock);
    this.documents = new DocumentService(db, clock, this.inventory);
  }

  today(): string {
    return this.clock();
  }

  // ---------- 読み込み ----------

  async loadSnapshot(): Promise<DataSnapshot> {
    const tx = this.db.transaction([...DATA_STORES], 'readonly');
    const entries = await Promise.all(DATA_STORES.map(async (name) => [name, await tx.objectStore(name).getAll()] as const));
    await tx.done;
    const data = Object.fromEntries(entries) as unknown as DataSnapshot;
    data.departments.sort((a, b) => a.order - b.order);
    data.activities.sort((a, b) => b.at.localeCompare(a.at));
    data.inquiryCategories.sort((a, b) => a.order - b.order);
    data.inquiries.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    data.items.sort((a, b) => a.code.localeCompare(b.code));
    data.assets.sort((a, b) => a.assetNumber.localeCompare(b.assetNumber));
    data.stockMovements.sort((a, b) => b.at.localeCompare(a.at));
    data.assetEvents.sort((a, b) => b.at.localeCompare(a.at));
    data.purchaseOrders.sort((a, b) => b.number.localeCompare(a.number));
    data.locations.sort((a, b) => a.order - b.order);
    data.equipmentRules.sort((a, b) => a.order - b.order);
    data.automationRuns.sort((a, b) => b.at.localeCompare(a.at));
    data.documents.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return data;
  }

  /** 初回起動時のみデモデータを投入する */
  async ensureInitialized(): Promise<boolean> {
    const seeded = await this.db.get('meta', 'initialized');
    if (seeded) return false;
    await this.replaceAll(createDemoData(this.today()), 'デモデータを生成しました（初回起動）');
    return true;
  }

  // ---------- 社員 ----------

  private async employeeContext(tx: WriteTx, selfId?: string) {
    const [existing, departments] = await Promise.all([tx.objectStore('employees').getAll(), tx.objectStore('departments').getAllKeys()]);
    return { existing, departmentIds: departments, selfId };
  }

  async createEmployee(input: EmployeeInput): Promise<Employee> {
    const tx = this.db.transaction(['employees', 'departments', 'activities'], 'readwrite');
    const v = validateEmployee(input, await this.employeeContext(tx));
    if (!v.ok) return abortWith(tx, fieldError(v.errors));
    const now = nowISO();
    const employee: Employee = {
      ...input,
      id: generateId('emp'),
      employeeNumber: normalizeEmployeeNumber(input.employeeNumber),
      name: input.name.trim(),
      position: input.position.trim(),
      notes: input.notes.trim(),
      retireDate: input.retireDate || null,
      contact: cleanContact(input.contact),
      createdAt: now,
      updatedAt: now,
    };
    if (!employee.contact) delete employee.contact;
    await tx.objectStore('employees').add(employee);
    await logActivity(tx, 'employee', 'create', `社員「${employee.name}」(${employee.employeeNumber}) を登録しました`, employee.id);
    await tx.done;
    return employee;
  }

  async updateEmployee(id: string, input: EmployeeInput): Promise<Employee> {
    const tx = this.db.transaction(['employees', 'departments', 'activities'], 'readwrite');
    const current = await tx.objectStore('employees').get(id);
    if (!current) return abortWith(tx, '対象の社員が見つかりません');
    const v = validateEmployee(input, await this.employeeContext(tx, id));
    if (!v.ok) return abortWith(tx, fieldError(v.errors));
    const employee: Employee = {
      ...current,
      ...input,
      employeeNumber: normalizeEmployeeNumber(input.employeeNumber),
      name: input.name.trim(),
      position: input.position.trim(),
      notes: input.notes.trim(),
      retireDate: input.retireDate || null,
      contact: cleanContact(input.contact),
      updatedAt: nowISO(),
    };
    if (!employee.contact) delete employee.contact;
    await tx.objectStore('employees').put(employee);
    await logActivity(tx, 'employee', 'update', `社員「${employee.name}」の情報を更新しました`, id);
    await tx.done;
    return employee;
  }

  /**
   * 社員を削除し、紐づくタスクも同時に削除する (孤立データを残さない)。
   * 問い合わせは受付時点の氏名を保持しているので履歴として残る。
   * 戻り値は Undo 用。
   */
  async deleteEmployee(id: string): Promise<DeletedEmployee> {
    const tx = this.db.transaction(['employees', 'tasks', 'activities', 'assets', 'reservations', 'documents'], 'readwrite');
    const employee = await tx.objectStore('employees').get(id);
    if (!employee) return abortWith(tx, '対象の社員が見つかりません');
    // 貸与中・予約中の機器がある社員を削除すると、資産の利用者が不明になるため拒否する
    const [assets, reservations] = await Promise.all([tx.objectStore('assets').index('byAssignee').getAll(id), tx.objectStore('reservations').index('byEmployee').getAll(id)]);
    const holding = assets.filter((a) => a.status === 'in_use' || a.status === 'reserved').length;
    const reserving = reservations.filter((r) => r.status === 'active' || r.status === 'backorder').length;
    if (holding + reserving > 0)
      return abortWith(tx, `貸与中・予約中の機器があるため削除できません（資産${holding}台・予約${reserving}件）。返却または予約解除をしてから削除するか、ステータスを「退職」にしてください`);
    const tasks = await tx.objectStore('tasks').index('byEmployee').getAll(id);
    for (const t of tasks) await tx.objectStore('tasks').delete(t.id);
    // 書類は業務記録なので削除せず、社員との関連付けだけを外す
    const docs = (await tx.objectStore('documents').getAll()).filter((d) => d.employeeId === id);
    for (const d of docs) await tx.objectStore('documents').put({ ...d, employeeId: null, updatedAt: nowISO(), history: [...d.history, { at: nowISO(), message: `関連社員「${employee.name}」の削除により関連付けを解除` }] });
    await tx.objectStore('employees').delete(id);
    await logActivity(tx, 'employee', 'delete', `社員「${employee.name}」を削除しました（関連タスク${tasks.length}件も削除${docs.length ? `・書類${docs.length}件の関連付けを解除` : ''}）`, id);
    await tx.done;
    return { employee, tasks, unlinkedDocumentIds: docs.map((d) => d.id) };
  }

  /** deleteEmployee の取り消し。社員番号が他で使われていた場合は復元しない */
  async restoreEmployee(deleted: DeletedEmployee): Promise<void> {
    const tx = this.db.transaction(['employees', 'tasks', 'activities', 'documents'], 'readwrite');
    const dup = await tx.objectStore('employees').index('byNumber').get(deleted.employee.employeeNumber);
    if (dup) return abortWith(tx, `社員番号「${deleted.employee.employeeNumber}」が既に使われているため元に戻せません`);
    await tx.objectStore('employees').put(deleted.employee);
    for (const t of deleted.tasks) await tx.objectStore('tasks').put(t);
    for (const did of deleted.unlinkedDocumentIds ?? []) {
      const d = await tx.objectStore('documents').get(did);
      if (d && d.employeeId === null) await tx.objectStore('documents').put({ ...d, employeeId: deleted.employee.id });
    }
    await logActivity(tx, 'employee', 'restore', `社員「${deleted.employee.name}」の削除を取り消しました`, deleted.employee.id);
    await tx.done;
  }

  // ---------- タスク ----------

  private async taskContext(tx: WriteTx) {
    const [emps, depts] = await Promise.all([tx.objectStore('employees').getAllKeys(), tx.objectStore('departments').getAllKeys()]);
    return { employeeIds: emps, departmentIds: depts };
  }

  async createTask(input: TaskInput): Promise<Task> {
    const tx = this.db.transaction(['tasks', 'employees', 'departments', 'activities'], 'readwrite');
    const v = validateTask(input, await this.taskContext(tx));
    if (!v.ok) return abortWith(tx, fieldError(v.errors));
    const now = nowISO();
    const task: Task = {
      ...input,
      id: generateId('task'),
      title: input.title.trim(),
      assignee: input.assignee.trim(),
      description: input.description.trim(),
      source: 'manual',
      ruleId: null,
      inquiryId: null,
      createdAt: now,
      updatedAt: now,
      completedAt: input.status === 'done' ? now : null,
    };
    await tx.objectStore('tasks').add(task);
    await logActivity(tx, 'task', 'create', `タスク「${task.title}」を作成しました`, task.id);
    await tx.done;
    return task;
  }

  /** 問い合わせ由来のタスクの状態変化を、問い合わせの対応履歴にも残す */
  private async reflectToInquiry(tx: WriteTx, before: Task, after: Task) {
    if (!after.inquiryId || before.status === after.status) return;
    await appendInquiryEvent(tx, after.inquiryId, inquiryEvent('task', `タスク「${after.title}」が「${TASK_STATUS_LABEL[after.status]}」になりました`));
  }

  async updateTask(id: string, input: TaskInput): Promise<Task> {
    const tx = this.db.transaction(['tasks', 'employees', 'departments', 'activities', 'inquiries'], 'readwrite');
    const current = await tx.objectStore('tasks').get(id);
    if (!current) return abortWith(tx, '対象のタスクが見つかりません');
    const v = validateTask(input, await this.taskContext(tx));
    if (!v.ok) return abortWith(tx, fieldError(v.errors));
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
    await this.reflectToInquiry(tx, current, task);
    const statusChanged = current.status !== task.status;
    await logActivity(
      tx,
      'task',
      'update',
      statusChanged ? `タスク「${task.title}」を「${TASK_STATUS_LABEL[task.status]}」に変更しました` : `タスク「${task.title}」を更新しました`,
      id,
    );
    await tx.done;
    return task;
  }

  /** ステータス変更。戻り値の previous は Undo 用 */
  async setTaskStatus(id: string, status: TaskStatus): Promise<Task & { previousStatus: TaskStatus }> {
    const tx = this.db.transaction(['tasks', 'activities', 'inquiries'], 'readwrite');
    const current = await tx.objectStore('tasks').get(id);
    if (!current) return abortWith(tx, '対象のタスクが見つかりません');
    const now = nowISO();
    const task: Task = { ...current, status, updatedAt: now, completedAt: status === 'done' ? (current.completedAt ?? now) : null };
    await tx.objectStore('tasks').put(task);
    await this.reflectToInquiry(tx, current, task);
    await logActivity(tx, 'task', 'status', `タスク「${task.title}」を「${TASK_STATUS_LABEL[status]}」に変更しました`, id);
    await tx.done;
    return { ...task, previousStatus: current.status };
  }

  /** 削除したタスクを返す (Undo 用) */
  async deleteTask(id: string): Promise<Task> {
    const tx = this.db.transaction(['tasks', 'activities', 'inquiries'], 'readwrite');
    const current = await tx.objectStore('tasks').get(id);
    if (!current) return abortWith(tx, '対象のタスクが見つかりません');
    await tx.objectStore('tasks').delete(id);
    if (current.inquiryId) await appendInquiryEvent(tx, current.inquiryId, inquiryEvent('task', `タスク「${current.title}」を削除しました`));
    await logActivity(tx, 'task', 'delete', `タスク「${current.title}」を削除しました`, id);
    await tx.done;
    return current;
  }

  async restoreTask(task: Task): Promise<void> {
    const tx = this.db.transaction(['tasks', 'employees', 'inquiries', 'activities'], 'readwrite');
    if (await tx.objectStore('tasks').get(task.id)) return abortWith(tx, 'このタスクは既に存在します');
    // 紐付け先が消えていたら紐付けを外して復元する
    const employeeId = task.employeeId && (await tx.objectStore('employees').get(task.employeeId)) ? task.employeeId : null;
    const inquiryId = task.inquiryId && (await tx.objectStore('inquiries').get(task.inquiryId)) ? task.inquiryId : null;
    await tx.objectStore('tasks').put({ ...task, employeeId, inquiryId });
    if (inquiryId) await appendInquiryEvent(tx, inquiryId, inquiryEvent('task', `タスク「${task.title}」の削除を取り消しました`));
    await logActivity(tx, 'task', 'restore', `タスク「${task.title}」の削除を取り消しました`, task.id);
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
    if (!employee) return abortWith(tx, '対象の社員が見つかりません');
    const [rules, existingTasks, departments] = await Promise.all([
      tx.objectStore('rules').getAll(),
      tx.objectStore('tasks').index('byEmployee').getAll(employeeId),
      tx.objectStore('departments').getAll(),
    ]);
    let plan: OnboardingPlan;
    try {
      plan = buildOnboardingPlan({ employee, rules, existingTasks, departments, today: this.today() });
    } catch (e) {
      return abortWith(tx, e instanceof Error ? e.message : '計画を作成できませんでした');
    }
    const tasks = materializePlan(plan, overrides, nowISO());
    if (tasks.length === 0) return abortWith(tx, '登録対象のタスクがありません（すべて登録済みまたは未選択です）');
    for (const t of tasks) await tx.objectStore('tasks').add(t);
    await logActivity(tx, 'onboarding', 'generate', `${employee.name}さんの入社準備タスクを${tasks.length}件自動生成しました`, employeeId);
    await tx.done;
    return tasks;
  }

  // ---------- 入社準備ルール ----------

  async saveRule(input: RuleInput, id?: string): Promise<OnboardingRule> {
    const tx = this.db.transaction(['rules', 'departments', 'activities'], 'readwrite');
    const departmentIds = await tx.objectStore('departments').getAllKeys();
    const v = validateRule(input, { departmentIds });
    if (!v.ok) return abortWith(tx, fieldError(v.errors));
    const now = nowISO();
    let rule: OnboardingRule;
    if (id) {
      const current = await tx.objectStore('rules').get(id);
      if (!current) return abortWith(tx, '対象のルールが見つかりません');
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
    await logActivity(tx, 'rule', id ? 'update' : 'create', `入社準備ルール「${rule.title}」を${id ? '更新' : '追加'}しました`, rule.id);
    await tx.done;
    return rule;
  }

  async deleteRule(id: string): Promise<OnboardingRule> {
    const tx = this.db.transaction(['rules', 'activities'], 'readwrite');
    const current = await tx.objectStore('rules').get(id);
    if (!current) return abortWith(tx, '対象のルールが見つかりません');
    await tx.objectStore('rules').delete(id);
    // 生成済みタスクは業務記録として残す (ruleId は重複判定の履歴として保持)
    await logActivity(tx, 'rule', 'delete', `入社準備ルール「${current.title}」を削除しました`, id);
    await tx.done;
    return current;
  }

  async restoreRule(rule: OnboardingRule): Promise<void> {
    const tx = this.db.transaction(['rules', 'activities'], 'readwrite');
    await tx.objectStore('rules').put(rule);
    await logActivity(tx, 'rule', 'restore', `入社準備ルール「${rule.title}」の削除を取り消しました`, rule.id);
    await tx.done;
  }

  // ---------- 部署 ----------

  async addDepartment(name: string): Promise<Department> {
    const trimmed = name.trim();
    if (!trimmed) throw new AppError('部署名を入力してください');
    if (trimmed.length > 30) throw new AppError('部署名は30文字以内で入力してください');
    const tx = this.db.transaction(['departments', 'activities'], 'readwrite');
    const all = await tx.objectStore('departments').getAll();
    if (all.some((d) => d.name === trimmed)) return abortWith(tx, `部署「${trimmed}」は既に存在します`);
    const dept: Department = { id: generateId('dept'), name: trimmed, order: all.reduce((m, d) => Math.max(m, d.order), 0) + 1 };
    await tx.objectStore('departments').add(dept);
    await logActivity(tx, 'department', 'create', `部署「${trimmed}」を追加しました`, dept.id);
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
    if (!current) return abortWith(tx, '対象の部署が見つかりません');
    if (all.some((d) => d.id !== id && d.name === trimmed)) return abortWith(tx, `部署「${trimmed}」は既に存在します`);
    await tx.objectStore('departments').put({ ...current, name: trimmed });
    await logActivity(tx, 'department', 'update', `部署名を「${current.name}」から「${trimmed}」に変更しました`, id);
    await tx.done;
  }

  /** 社員・タスク・ルール・問い合わせカテゴリから参照されている部署は削除できない */
  async deleteDepartment(id: string): Promise<void> {
    const tx = this.db.transaction(['departments', 'employees', 'tasks', 'rules', 'inquiryCategories', 'activities'], 'readwrite');
    const current = await tx.objectStore('departments').get(id);
    if (!current) return abortWith(tx, '対象の部署が見つかりません');
    const [empCount, tasks, rules, cats] = await Promise.all([
      tx.objectStore('employees').index('byDepartment').count(id),
      tx.objectStore('tasks').getAll(),
      tx.objectStore('rules').getAll(),
      tx.objectStore('inquiryCategories').getAll(),
    ]);
    const taskCount = tasks.filter((t) => t.assigneeDepartmentId === id).length;
    const ruleCount = rules.filter((r) => r.scope === id || r.assigneeDepartmentId === id).length;
    const catCount = cats.filter((c) => c.defaultDepartmentId === id).length;
    if (empCount + taskCount + ruleCount + catCount > 0)
      return abortWith(
        tx,
        `この部署は使用中のため削除できません（社員${empCount}名・タスク${taskCount}件・ルール${ruleCount}件・問い合わせカテゴリ${catCount}件）`,
      );
    await tx.objectStore('departments').delete(id);
    await logActivity(tx, 'department', 'delete', `部署「${current.name}」を削除しました`, id);
    await tx.done;
  }

  // ---------- データ管理 ----------

  private async replaceAll(data: DataSnapshot, message: string, files: DocumentFile[] = []): Promise<void> {
    const tx = this.db.transaction([...STORE_NAMES], 'readwrite');
    // 二重送信防止キー (meta の req:*) も含めて全消去する
    await Promise.all(STORE_NAMES.map((s) => tx.objectStore(s).clear()));
    for (const name of DATA_STORES) {
      const store = tx.objectStore(name);
      for (const rec of data[name] as { id: string }[]) await store.put(rec as never);
    }
    for (const f of files) await tx.objectStore('documentFiles').put(f);
    await tx.objectStore('meta').put({ key: 'initialized', value: nowISO() });
    await logActivity(tx, 'data', 'replace', message);
    await tx.done;
  }

  /**
   * バックアップから復元。元ファイルは decodeBackupFiles() で検証済みのものを渡す。
   * 元ファイルを含まないバックアップでは、書類の抽出結果だけが復元され、原本は「なし」と表示される
   */
  async restoreBackup(backup: BackupFile, files: DocumentFile[] = []): Promise<void> {
    await this.replaceAll(
      backup.data,
      `バックアップ（${backup.exportedAt.slice(0, 10) || '日付不明'}）から復元しました${backup.data.documents.length ? `（書類${backup.data.documents.length}件・元ファイル${files.length}件）` : ''}`,
      files,
    );
  }

  /** バックアップ用に元ファイル本体をすべて読む (ゴミ箱の書類も含む) */
  async loadAllDocumentFiles(): Promise<DocumentFile[]> {
    return this.db.getAll('documentFiles');
  }

  async resetDemoData(): Promise<void> {
    await this.replaceAll(createDemoData(this.today()), 'デモデータを初期化しました');
  }

  /** 全データを削除し、部署・ルール・カテゴリだけの空の状態にする */
  async clearBusinessData(): Promise<void> {
    const demo = createDemoData(this.today());
    // 設定 (自動化ルールなど) は業務データではないので残す
    const settings = await this.db.getAll('settings');
    await this.replaceAll(
      {
        ...emptyInventory(true),
        documents: [],
        settings,
        departments: demo.departments,
        rules: demo.rules,
        employees: [],
        tasks: [],
        activities: [],
        inquiries: [],
        faqs: [],
        inquiryCategories: createDefaultInquiryCategories(),
      },
      '社員・タスク・問い合わせ・在庫を全削除しました（部署・ルール・カテゴリ・保管場所・仕入先は初期設定）',
    );
  }

  /**
   * Phase 1 からの移行ユーザー向け: 既存データを残したまま、ヘルプデスクのデモデータだけを追加する。
   * 問い合わせが1件でもあれば何もしない (重複投入防止)。
   */
  async addHelpdeskDemo(): Promise<number> {
    const tx = this.db.transaction(['inquiries', 'faqs', 'inquiryCategories', 'employees', 'tasks', 'departments', 'activities'], 'readwrite');
    if ((await tx.objectStore('inquiries').count()) > 0) return abortWith(tx, '既に問い合わせが登録されているため、デモデータは追加しません');
    const [employees, cats, depts] = await Promise.all([
      tx.objectStore('employees').getAll(),
      tx.objectStore('inquiryCategories').getAll(),
      tx.objectStore('departments').getAllKeys(),
    ]);
    if (employees.length === 0) return abortWith(tx, '社員が登録されていないため、デモの問い合わせを作成できません');
    const demo = createHelpdeskDemoData(this.today(), employees, cats.length ? cats : createDefaultInquiryCategories(), depts);
    if (!cats.length) for (const c of createDefaultInquiryCategories()) await tx.objectStore('inquiryCategories').put(c);
    const existingFaqIds = new Set(await tx.objectStore('faqs').getAllKeys());
    for (const f of demo.faqs) if (!existingFaqIds.has(f.id)) await tx.objectStore('faqs').put(f);
    for (const i of demo.inquiries) await tx.objectStore('inquiries').put(i);
    for (const t of demo.tasks) await tx.objectStore('tasks').put(t);
    await logActivity(tx, 'data', 'demo', `ヘルプデスクのデモデータ（問い合わせ${demo.inquiries.length}件・FAQ${demo.faqs.length}件）を追加しました`);
    await tx.done;
    return demo.inquiries.length;
  }

  // ---------- 設定・自動化 (Phase 5) ----------

  /** 自動化ルールの有効/無効・実行方法を保存する */
  async saveRuleSetting(automationId: string, setting: RuleSetting): Promise<void> {
    const def = ALL_AUTOMATIONS.find((d) => d.id === automationId);
    if (!def) throw new AppError('不明な自動化です');
    if (setting.mode === 'auto' && !def.autoCapable) throw new AppError('この自動化は確認が必要なため、自動実行にはできません');
    const tx = this.db.transaction(['settings', 'activities'], 'readwrite');
    const current = await tx.objectStore('settings').get(AUTOMATION_SETTING_ID);
    const value = { ...((current?.value as Record<string, RuleSetting> | undefined) ?? {}), [automationId]: setting };
    await tx.objectStore('settings').put({ id: AUTOMATION_SETTING_ID, value, updatedAt: nowISO() });
    await logActivity(tx, 'automation', 'setting', `自動化「${def.name}」を${setting.enabled ? (setting.mode === 'auto' ? '自動実行' : '確認してから実行') : '無効'}にしました`);
    await tx.done;
  }

  /**
   * 「自動で実行」に設定された自動化を実行する (データが変わるたびに画面から呼ぶ)。
   * 承認が不要な操作 (タスク作成など) だけの提案に限り、処理履歴に「自動」として記録する。
   * 同じ提案は処理履歴のキーで一度しか実行されない (再読み込み・連続呼び出しでも二重実行しない)
   */
  async runAutoAutomations(): Promise<{ title: string; results: string[] }[]> {
    const data = await this.loadSnapshot();
    const settings = readAutomationSettings(data);
    const defs = ALL_AUTOMATIONS.filter((d) => {
      const s = ruleSetting(d, settings);
      return s.enabled && s.mode === 'auto';
    });
    if (!defs.length) return [];
    const proposals = pendingProposals(defs, { data, today: this.today(), stock: computeAllStock(data.items, data) });
    const done: { title: string; results: string[] }[] = [];
    for (const p of proposals) {
      if (p.actions.some((a) => a.requiresApproval)) continue;
      try {
        const r = await this.inventory.applyProposal(p.automationId, p.key, p.actions.map((a) => a.id), { auto: true });
        done.push({ title: p.title, results: r.results });
      } catch {
        // 処理済み・状況の変化は失敗として処理履歴に残っている (画面の処理を止めない)
      }
    }
    return done;
  }

  async recordExport(message: string): Promise<void> {
    const tx = this.db.transaction(['activities'], 'readwrite');
    await logActivity(tx, 'data', 'export', message);
    await tx.done;
  }
}
