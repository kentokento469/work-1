import { isValidISODate } from './date';
import { isEmail } from './input/normalize';
import { validateRecurrence } from './recurrence';
import {
  EMPLOYEE_STATUSES,
  EMPLOYMENT_TYPES,
  PRIORITIES,
  TASK_STATUSES,
  type Employee,
  type EmployeeContact,
  type EmployeeStatus,
  type EmploymentType,
  type OnboardingRule,
  type Priority,
  type Task,
  type TaskStatus,
} from './types';

export type FieldErrors<T> = Partial<Record<keyof T, string>>;

export interface ValidationResult<T> {
  ok: boolean;
  errors: FieldErrors<T>;
}

function result<T>(errors: FieldErrors<T>): ValidationResult<T> {
  return { ok: Object.keys(errors).length === 0, errors };
}

/** 社員番号の比較キー (前後空白・大文字小文字・全角英数を同一視) */
export function normalizeEmployeeNumber(value: string): string {
  return value
    .trim()
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xfee0))
    .toUpperCase();
}

export type EmployeeInput = Pick<
  Employee,
  'employeeNumber' | 'name' | 'departmentId' | 'position' | 'employmentType' | 'hireDate' | 'retireDate' | 'status' | 'notes' | 'contact'
>;

export function validateEmployee(
  input: EmployeeInput,
  ctx: { existing: Pick<Employee, 'id' | 'employeeNumber'>[]; departmentIds: string[]; selfId?: string },
): ValidationResult<EmployeeInput> {
  const e: FieldErrors<EmployeeInput> = {};
  const num = normalizeEmployeeNumber(input.employeeNumber);
  if (!num) e.employeeNumber = '社員番号を入力してください';
  else if (!/^[A-Z0-9-]{1,20}$/.test(num)) e.employeeNumber = '社員番号は半角英数字とハイフン（20文字以内）で入力してください';
  else if (ctx.existing.some((x) => x.id !== ctx.selfId && normalizeEmployeeNumber(x.employeeNumber) === num))
    e.employeeNumber = `社員番号「${num}」は既に登録されています`;

  if (!input.name.trim()) e.name = '氏名を入力してください';
  else if (input.name.trim().length > 50) e.name = '氏名は50文字以内で入力してください';

  if (!ctx.departmentIds.includes(input.departmentId)) e.departmentId = '所属部署を選択してください';
  if (input.position.length > 50) e.position = '役職は50文字以内で入力してください';
  if (!EMPLOYMENT_TYPES.includes(input.employmentType)) e.employmentType = '雇用区分を選択してください';

  if (!isValidISODate(input.hireDate)) e.hireDate = '入社日を正しく入力してください';
  if (input.retireDate) {
    if (!isValidISODate(input.retireDate)) e.retireDate = '退職日を正しく入力してください';
    else if (isValidISODate(input.hireDate) && input.retireDate < input.hireDate)
      e.retireDate = '退職日は入社日以降の日付を指定してください';
  }
  if (!EMPLOYEE_STATUSES.includes(input.status)) e.status = '在籍ステータスを選択してください';
  else if (input.status === 'retired' && !input.retireDate) e.retireDate = '退職ステータスの場合は退職日を入力してください';
  if (input.notes.length > 1000) e.notes = '備考は1000文字以内で入力してください';
  const c = input.contact;
  if (c) {
    if (c.email.trim() && !isEmail(c.email)) e.contact = 'メールアドレスの形式を確認してください（例：taro@example.co.jp）';
    else if (c.postalCode.trim() && !/^\d{3}-?\d{4}$/.test(c.postalCode.trim())) e.contact = '郵便番号は7桁で入力してください';
    else if (Object.values(c).some((v) => v.length > 200)) e.contact = '連絡先の各項目は200文字以内で入力してください';
  }
  return result(e);
}

/** 連絡先が空なら undefined にする (既存データと同じ形を保つ) */
export function cleanContact(c: EmployeeContact | undefined): EmployeeContact | undefined {
  if (!c) return undefined;
  const t = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, String(v ?? '').trim()])) as unknown as EmployeeContact;
  return Object.values(t).some(Boolean) ? t : undefined;
}

export type TaskInput = Pick<
  Task,
  'employeeId' | 'title' | 'description' | 'assigneeDepartmentId' | 'assignee' | 'priority' | 'dueDate' | 'status'
> &
  Partial<Pick<Task, 'startDate' | 'projectId' | 'parentTaskId' | 'tags' | 'checklist' | 'recurrence' | 'dependsOn' | 'links'>>;

export interface TaskValidationContext {
  employeeIds: string[];
  departmentIds: string[];
  /** 以下は Phase 7 の関連の検査用 (省略時は検査しない) */
  projectIds?: string[];
  tasks?: Pick<Task, 'id' | 'parentTaskId' | 'dependsOn'>[];
  selfId?: string;
}

/** 依存関係をたどって循環するか (selfId が自分自身の前提に戻ってくるか) */
export function createsDependencyCycle(selfId: string, dependsOn: string[], tasks: Pick<Task, 'id' | 'dependsOn'>[]): boolean {
  const byId = new Map(tasks.map((t) => [t.id, t.dependsOn ?? []]));
  const seen = new Set<string>();
  const stack = [...dependsOn];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === selfId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(byId.get(id) ?? []));
  }
  return false;
}

export function validateTask(input: TaskInput, ctx: TaskValidationContext): ValidationResult<TaskInput> {
  const e: FieldErrors<TaskInput> = {};
  if (!input.title.trim()) e.title = 'タスク名を入力してください';
  else if (input.title.trim().length > 100) e.title = 'タスク名は100文字以内で入力してください';
  if (input.employeeId !== null && !ctx.employeeIds.includes(input.employeeId)) e.employeeId = '対象社員が存在しません';
  // 担当部署・期限は任意 (Phase 7)。指定した場合だけ存在・形式を確認する
  if (input.assigneeDepartmentId !== null && !ctx.departmentIds.includes(input.assigneeDepartmentId)) e.assigneeDepartmentId = '担当部署が存在しません';
  if (input.assignee.length > 50) e.assignee = '担当者は50文字以内で入力してください';
  if (!PRIORITIES.includes(input.priority)) e.priority = '優先度を選択してください';
  if (input.dueDate !== null && !isValidISODate(input.dueDate)) e.dueDate = '期限を正しく入力してください';
  if (!TASK_STATUSES.includes(input.status)) e.status = '進捗状況を選択してください';
  if (input.description.length > 2000) e.description = '詳細は2000文字以内で入力してください';
  if (input.startDate) {
    if (!isValidISODate(input.startDate)) e.startDate = '開始日を正しく入力してください';
    else if (input.dueDate && isValidISODate(input.dueDate) && input.startDate > input.dueDate) e.startDate = '開始日は期限以前の日付にしてください';
  }
  if (input.tags) {
    if (input.tags.length > 10) e.tags = 'タグは10個までです';
    else if (input.tags.some((t) => !t.trim() || t.length > 20)) e.tags = 'タグは1〜20文字で入力してください';
  }
  if (input.checklist) {
    if (input.checklist.length > 50) e.checklist = 'チェックリストは50項目までです';
    else if (input.checklist.some((c) => !c.text.trim() || c.text.length > 100)) e.checklist = 'チェック項目は1〜100文字で入力してください';
  }
  if (input.recurrence) {
    const r = validateRecurrence(input.recurrence);
    if (r) e.recurrence = r;
    else if (!input.dueDate) e.recurrence = '繰り返すには期限を設定してください（次回の期限の基準になります）';
  }
  if (input.projectId && ctx.projectIds && !ctx.projectIds.includes(input.projectId)) e.projectId = 'プロジェクトが存在しません';
  if (input.parentTaskId && ctx.tasks) {
    const parent = ctx.tasks.find((t) => t.id === input.parentTaskId);
    if (!parent) e.parentTaskId = '親タスクが存在しません';
    else if (input.parentTaskId === ctx.selfId) e.parentTaskId = '自分自身を親タスクにはできません';
    else if (parent.parentTaskId) e.parentTaskId = 'サブタスクの下にはサブタスクを作れません（1段まで）';
    else if (ctx.selfId && ctx.tasks.some((t) => t.parentTaskId === ctx.selfId)) e.parentTaskId = 'サブタスクを持つタスクは、別のタスクのサブタスクにできません';
  }
  if (input.dependsOn?.length && ctx.tasks) {
    if (ctx.selfId && input.dependsOn.includes(ctx.selfId)) e.dependsOn = '自分自身を前提タスクにはできません';
    else if (input.dependsOn.some((id) => !ctx.tasks!.some((t) => t.id === id))) e.dependsOn = '前提タスクが存在しません';
    else if (ctx.selfId && createsDependencyCycle(ctx.selfId, input.dependsOn, ctx.tasks)) e.dependsOn = '前提タスクが循環しています（A→B→A のような関係は作れません）';
  }
  return result(e);
}

export type RuleInput = Pick<
  OnboardingRule,
  'title' | 'description' | 'scope' | 'assigneeDepartmentId' | 'defaultAssignee' | 'priority' | 'offsetDays' | 'employmentTypes' | 'enabled'
>;

export function validateRule(input: RuleInput, ctx: { departmentIds: string[] }): ValidationResult<RuleInput> {
  const e: FieldErrors<RuleInput> = {};
  if (!input.title.trim()) e.title = 'タスク名を入力してください';
  else if (input.title.trim().length > 100) e.title = 'タスク名は100文字以内で入力してください';
  if (input.scope !== 'common' && !ctx.departmentIds.includes(input.scope)) e.scope = '適用範囲を選択してください';
  if (!ctx.departmentIds.includes(input.assigneeDepartmentId)) e.assigneeDepartmentId = '担当部署を選択してください';
  if (!PRIORITIES.includes(input.priority)) e.priority = '優先度を選択してください';
  if (!Number.isInteger(input.offsetDays) || input.offsetDays < -90 || input.offsetDays > 90)
    e.offsetDays = '期限は入社日の前後90日以内（整数）で指定してください';
  if (input.employmentTypes.some((t) => !EMPLOYMENT_TYPES.includes(t))) e.employmentTypes = '雇用区分が不正です';
  return result(e);
}

/** 入社日・退職日から推奨ステータスを判定 (入力補助用) */
export function suggestEmployeeStatus(hireDate: string, retireDate: string | null, todayISO: string): EmployeeStatus {
  if (retireDate && isValidISODate(retireDate) && retireDate <= todayISO) return 'retired';
  if (isValidISODate(hireDate) && hireDate > todayISO) return 'pending';
  return 'active';
}

export const isEmploymentType = (v: unknown): v is EmploymentType =>
  typeof v === 'string' && (EMPLOYMENT_TYPES as readonly string[]).includes(v);
export const isEmployeeStatus = (v: unknown): v is EmployeeStatus =>
  typeof v === 'string' && (EMPLOYEE_STATUSES as readonly string[]).includes(v);
export const isTaskStatus = (v: unknown): v is TaskStatus =>
  typeof v === 'string' && (TASK_STATUSES as readonly string[]).includes(v);
export const isPriority = (v: unknown): v is Priority =>
  typeof v === 'string' && (PRIORITIES as readonly string[]).includes(v);
