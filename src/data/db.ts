/**
 * IndexedDB 永続化層。
 * 社員番号には一意インデックスを張り、アプリ側の検証に加えて DB レベルでも重複を防ぐ。
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ActivityLog, Department, Employee, OnboardingRule, Task } from '../domain/types';

export const DB_NAME = 'workcore';
export const DB_VERSION = 1;

export interface WorkCoreSchema extends DBSchema {
  departments: { key: string; value: Department };
  employees: { key: string; value: Employee; indexes: { byNumber: string; byDepartment: string } };
  tasks: { key: string; value: Task; indexes: { byEmployee: string; byStatus: string } };
  rules: { key: string; value: OnboardingRule };
  activities: { key: string; value: ActivityLog; indexes: { byAt: string } };
  meta: { key: string; value: { key: string; value: unknown } };
}

export type WorkCoreDB = IDBPDatabase<WorkCoreSchema>;
export const STORE_NAMES = ['departments', 'employees', 'tasks', 'rules', 'activities', 'meta'] as const;

export function openWorkCoreDB(name = DB_NAME): Promise<WorkCoreDB> {
  return openDB<WorkCoreSchema>(name, DB_VERSION, {
    upgrade(db, oldVersion) {
      // 将来のスキーマ変更はバージョン分岐で段階的に移行する
      if (oldVersion < 1) {
        db.createObjectStore('departments', { keyPath: 'id' });
        const emp = db.createObjectStore('employees', { keyPath: 'id' });
        emp.createIndex('byNumber', 'employeeNumber', { unique: true });
        emp.createIndex('byDepartment', 'departmentId');
        const task = db.createObjectStore('tasks', { keyPath: 'id' });
        task.createIndex('byEmployee', 'employeeId');
        task.createIndex('byStatus', 'status');
        db.createObjectStore('rules', { keyPath: 'id' });
        const act = db.createObjectStore('activities', { keyPath: 'id' });
        act.createIndex('byAt', 'at');
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    },
    blocked() {
      console.warn('WorkCore: 他のタブでデータベースが使用中です');
    },
  });
}
