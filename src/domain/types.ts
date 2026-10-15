/**
 * WorkCore ドメインモデル定義。
 * UI・永続化層の双方から参照される唯一の型定義ソース。
 */

export type ISODate = string; // YYYY-MM-DD (ローカル日付)
export type ISODateTime = string; // ISO 8601

export interface Department {
  id: string;
  name: string;
  order: number;
}

export const EMPLOYMENT_TYPES = ['正社員', '契約社員', 'パート・アルバイト', '派遣社員', '業務委託'] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const EMPLOYEE_STATUSES = ['pending', 'active', 'leave', 'retired'] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

export const EMPLOYEE_STATUS_LABEL: Record<EmployeeStatus, string> = {
  pending: '入社予定',
  active: '在籍',
  leave: '休職',
  retired: '退職',
};

export interface Employee {
  id: string;
  employeeNumber: string;
  name: string;
  departmentId: string;
  position: string;
  employmentType: EmploymentType;
  hireDate: ISODate;
  retireDate: ISODate | null;
  status: EmployeeStatus;
  notes: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export const TASK_STATUSES = ['todo', 'in_progress', 'done', 'on_hold'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  todo: '未着手',
  in_progress: '進行中',
  done: '完了',
  on_hold: '保留',
};

export const PRIORITIES = ['high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_LABEL: Record<Priority, string> = {
  high: '高',
  medium: '中',
  low: '低',
};

export const PRIORITY_WEIGHT: Record<Priority, number> = { high: 3, medium: 2, low: 1 };

export type TaskSource = 'manual' | 'onboarding';

export interface Task {
  id: string;
  employeeId: string | null;
  title: string;
  description: string;
  /** 担当部署 (Department.id) */
  assigneeDepartmentId: string;
  assignee: string;
  priority: Priority;
  dueDate: ISODate;
  status: TaskStatus;
  source: TaskSource;
  /** 自動生成元ルール。重複生成防止キーに使用 */
  ruleId: string | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  completedAt: ISODateTime | null;
}

/**
 * 入社準備ルール。
 * scope が 'common' のものは全社員、部署IDのものはその部署の社員にのみ適用。
 * 期限は「入社日 + offsetDays」(負数で入社日前) で算出する。
 */
export interface OnboardingRule {
  id: string;
  title: string;
  description: string;
  scope: 'common' | string;
  assigneeDepartmentId: string;
  defaultAssignee: string;
  priority: Priority;
  offsetDays: number;
  /** 適用対象の雇用区分。空配列なら全区分 */
  employmentTypes: EmploymentType[];
  enabled: boolean;
  order: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type ActivityCategory = 'employee' | 'task' | 'onboarding' | 'rule' | 'department' | 'data';

export interface ActivityLog {
  id: string;
  at: ISODateTime;
  category: ActivityCategory;
  action: string;
  message: string;
  entityId: string | null;
}

/** バックアップ・復元対象となるデータ全体 */
export interface DataSnapshot {
  departments: Department[];
  employees: Employee[];
  tasks: Task[];
  rules: OnboardingRule[];
  activities: ActivityLog[];
}
