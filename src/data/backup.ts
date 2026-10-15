/**
 * JSONバックアップの生成と、復元時のスキーマ・整合性検証。
 * 外部から読み込むデータは信用せず、全レコードを型ガードで検証してから採用する。
 */
import { isValidISODate } from '../domain/date';
import {
  isEmployeeStatus,
  isEmploymentType,
  isPriority,
  isTaskStatus,
  normalizeEmployeeNumber,
} from '../domain/validation';
import type { ActivityLog, DataSnapshot, Department, Employee, OnboardingRule, Task } from '../domain/types';

export const BACKUP_APP_ID = 'WorkCore';
export const BACKUP_SCHEMA_VERSION = 1;

export interface BackupFile {
  app: typeof BACKUP_APP_ID;
  schemaVersion: number;
  exportedAt: string;
  data: DataSnapshot;
}

export function createBackup(data: DataSnapshot, now = new Date()): BackupFile {
  return { app: BACKUP_APP_ID, schemaVersion: BACKUP_SCHEMA_VERSION, exportedAt: now.toISOString(), data };
}

export type BackupValidation =
  | { ok: true; backup: BackupFile; counts: Record<keyof DataSnapshot, number> }
  | { ok: false; errors: string[] };

type Rec = Record<string, unknown>;
const isObj = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrOrNull = (v: unknown) => v === null || isStr(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function checkDepartment(v: unknown): v is Department {
  return isObj(v) && isStr(v.id) && isStr(v.name) && v.name.trim() !== '' && isNum(v.order);
}
function checkEmployee(v: unknown): v is Employee {
  return (
    isObj(v) &&
    isStr(v.id) &&
    isStr(v.employeeNumber) &&
    v.employeeNumber.trim() !== '' &&
    isStr(v.name) &&
    isStr(v.departmentId) &&
    isStr(v.position) &&
    isEmploymentType(v.employmentType) &&
    isValidISODate(v.hireDate) &&
    (v.retireDate === null || isValidISODate(v.retireDate)) &&
    isEmployeeStatus(v.status) &&
    isStr(v.notes) &&
    isStr(v.createdAt) &&
    isStr(v.updatedAt)
  );
}
function checkTask(v: unknown): v is Task {
  return (
    isObj(v) &&
    isStr(v.id) &&
    isStrOrNull(v.employeeId) &&
    isStr(v.title) &&
    isStr(v.description) &&
    isStr(v.assigneeDepartmentId) &&
    isStr(v.assignee) &&
    isPriority(v.priority) &&
    isValidISODate(v.dueDate) &&
    isTaskStatus(v.status) &&
    (v.source === 'manual' || v.source === 'onboarding') &&
    isStrOrNull(v.ruleId) &&
    isStr(v.createdAt) &&
    isStr(v.updatedAt) &&
    isStrOrNull(v.completedAt)
  );
}
function checkRule(v: unknown): v is OnboardingRule {
  return (
    isObj(v) &&
    isStr(v.id) &&
    isStr(v.title) &&
    isStr(v.description) &&
    isStr(v.scope) &&
    isStr(v.assigneeDepartmentId) &&
    isStr(v.defaultAssignee) &&
    isPriority(v.priority) &&
    isNum(v.offsetDays) &&
    Array.isArray(v.employmentTypes) &&
    v.employmentTypes.every(isEmploymentType) &&
    typeof v.enabled === 'boolean' &&
    isNum(v.order) &&
    isStr(v.createdAt) &&
    isStr(v.updatedAt)
  );
}
function checkActivity(v: unknown): v is ActivityLog {
  return isObj(v) && isStr(v.id) && isStr(v.at) && isStr(v.category) && isStr(v.action) && isStr(v.message) && isStrOrNull(v.entityId);
}

const MAX_ERRORS = 10;

export function validateBackup(raw: unknown): BackupValidation {
  const errors: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ['JSONの形式が正しくありません'] };
  if (raw.app !== BACKUP_APP_ID) return { ok: false, errors: ['WorkCore のバックアップファイルではありません'] };
  if (raw.schemaVersion !== BACKUP_SCHEMA_VERSION)
    return { ok: false, errors: [`対応していないバージョンです（${String(raw.schemaVersion)}）`] };
  if (!isObj(raw.data)) return { ok: false, errors: ['data 項目がありません'] };
  const d = raw.data;

  const collections = [
    ['departments', '部署', checkDepartment],
    ['employees', '社員', checkEmployee],
    ['tasks', 'タスク', checkTask],
    ['rules', '入社準備ルール', checkRule],
    ['activities', '操作履歴', checkActivity],
  ] as const;

  for (const [key, label, check] of collections) {
    const arr = d[key];
    if (!Array.isArray(arr)) {
      errors.push(`${label}データ（${key}）がありません`);
      continue;
    }
    const ids = new Set<string>();
    arr.forEach((item: unknown, i: number) => {
      if (!(check as (v: unknown) => boolean)(item)) errors.push(`${label} ${i + 1}件目の形式が不正です`);
      else {
        const id = (item as { id: string }).id;
        if (ids.has(id)) errors.push(`${label}のIDが重複しています（${id}）`);
        ids.add(id);
      }
    });
  }
  if (errors.length) return { ok: false, errors: errors.slice(0, MAX_ERRORS) };

  const data = d as unknown as DataSnapshot;

  // 参照整合性
  const deptIds = new Set(data.departments.map((x) => x.id));
  const empIds = new Set(data.employees.map((x) => x.id));
  const nums = new Set<string>();
  for (const e of data.employees) {
    if (!deptIds.has(e.departmentId)) errors.push(`社員「${e.name}」の所属部署が存在しません`);
    const n = normalizeEmployeeNumber(e.employeeNumber);
    if (nums.has(n)) errors.push(`社員番号「${n}」が重複しています`);
    nums.add(n);
  }
  for (const t of data.tasks) {
    if (t.employeeId !== null && !empIds.has(t.employeeId)) errors.push(`タスク「${t.title}」の対象社員が存在しません`);
    if (!deptIds.has(t.assigneeDepartmentId)) errors.push(`タスク「${t.title}」の担当部署が存在しません`);
  }
  for (const r of data.rules) {
    if (r.scope !== 'common' && !deptIds.has(r.scope)) errors.push(`ルール「${r.title}」の適用部署が存在しません`);
    if (!deptIds.has(r.assigneeDepartmentId)) errors.push(`ルール「${r.title}」の担当部署が存在しません`);
  }
  if (errors.length) return { ok: false, errors: errors.slice(0, MAX_ERRORS) };

  const backup: BackupFile = {
    app: BACKUP_APP_ID,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: isStr(raw.exportedAt) ? raw.exportedAt : '',
    data: {
      departments: data.departments,
      // 社員番号は正規化して保存 (DBの一意インデックスと整合させる)
      employees: data.employees.map((e) => ({ ...e, employeeNumber: normalizeEmployeeNumber(e.employeeNumber) })),
      tasks: data.tasks,
      rules: data.rules,
      activities: data.activities,
    },
  };
  return {
    ok: true,
    backup,
    counts: {
      departments: data.departments.length,
      employees: data.employees.length,
      tasks: data.tasks.length,
      rules: data.rules.length,
      activities: data.activities.length,
    },
  };
}

export function parseBackupText(text: string): BackupValidation {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return { ok: false, errors: ['JSONとして読み込めませんでした。ファイルが壊れていないか確認してください'] };
  }
  return validateBackup(raw);
}
