import { isValidISODate } from './date';
import {
  EMPLOYEE_STATUSES,
  EMPLOYMENT_TYPES,
  PRIORITIES,
  TASK_STATUSES,
  type Employee,
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
  'employeeNumber' | 'name' | 'departmentId' | 'position' | 'employmentType' | 'hireDate' | 'retireDate' | 'status' | 'notes'
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
  return result(e);
}

export type TaskInput = Pick<
  Task,
  'employeeId' | 'title' | 'description' | 'assigneeDepartmentId' | 'assignee' | 'priority' | 'dueDate' | 'status'
>;

export function validateTask(
  input: TaskInput,
  ctx: { employeeIds: string[]; departmentIds: string[] },
): ValidationResult<TaskInput> {
  const e: FieldErrors<TaskInput> = {};
  if (!input.title.trim()) e.title = 'タスク名を入力してください';
  else if (input.title.trim().length > 100) e.title = 'タスク名は100文字以内で入力してください';
  if (input.employeeId !== null && !ctx.employeeIds.includes(input.employeeId)) e.employeeId = '対象社員が存在しません';
  if (!ctx.departmentIds.includes(input.assigneeDepartmentId)) e.assigneeDepartmentId = '担当部署を選択してください';
  if (input.assignee.length > 50) e.assignee = '担当者は50文字以内で入力してください';
  if (!PRIORITIES.includes(input.priority)) e.priority = '優先度を選択してください';
  if (!isValidISODate(input.dueDate)) e.dueDate = '期限を正しく入力してください';
  if (!TASK_STATUSES.includes(input.status)) e.status = '進捗状況を選択してください';
  if (input.description.length > 1000) e.description = '詳細は1000文字以内で入力してください';
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
