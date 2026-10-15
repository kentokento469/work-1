import { EMPLOYEE_STATUS_LABEL, PRIORITY_LABEL, TASK_STATUS_LABEL, type DataSnapshot } from '../domain/types';

/** Excel で UTF-8 として認識させるための BOM */
export const UTF8_BOM = '﻿';

export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  // CSVインジェクション対策: 数式として解釈される先頭文字をエスケープ
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers, ...rows].map((r) => r.map(escapeCsvCell).join(','));
  // Excel 互換のため CRLF
  return UTF8_BOM + lines.join('\r\n') + '\r\n';
}

export function employeesToCsv(data: Pick<DataSnapshot, 'employees' | 'departments'>): string {
  const dept = new Map(data.departments.map((d) => [d.id, d.name]));
  const rows = [...data.employees]
    .sort((a, b) => a.employeeNumber.localeCompare(b.employeeNumber))
    .map((e) => [
      e.employeeNumber,
      e.name,
      dept.get(e.departmentId) ?? '',
      e.position,
      e.employmentType,
      e.hireDate,
      e.retireDate ?? '',
      EMPLOYEE_STATUS_LABEL[e.status],
      e.notes,
    ]);
  return toCsv(['社員番号', '氏名', '所属部署', '役職', '雇用区分', '入社日', '退職日', '在籍ステータス', '備考'], rows);
}

export function tasksToCsv(data: Pick<DataSnapshot, 'tasks' | 'employees' | 'departments'>): string {
  const dept = new Map(data.departments.map((d) => [d.id, d.name]));
  const emp = new Map(data.employees.map((e) => [e.id, e]));
  const rows = [...data.tasks]
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .map((t) => {
      const e = t.employeeId ? emp.get(t.employeeId) : undefined;
      return [
        t.title,
        e ? e.employeeNumber : '',
        e ? e.name : '',
        dept.get(t.assigneeDepartmentId) ?? '',
        t.assignee,
        PRIORITY_LABEL[t.priority],
        t.dueDate,
        TASK_STATUS_LABEL[t.status],
        t.source === 'onboarding' ? '入社準備(自動)' : '手動',
        t.completedAt ?? '',
        t.description,
      ];
    });
  return toCsv(
    ['タスク名', '対象社員番号', '対象社員', '担当部署', '担当者', '優先度', '期限', '進捗状況', '登録元', '完了日時', '詳細'],
    rows,
  );
}
