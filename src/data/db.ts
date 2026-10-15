/**
 * IndexedDB 永続化層。
 * 社員番号・問い合わせ番号には一意インデックスを張り、アプリ側の検証に加えて DB レベルでも重複を防ぐ。
 *
 * スキーマ履歴:
 *  v1 (Phase 1): departments, employees, tasks, rules, activities, meta
 *  v2 (Phase 2): inquiries, faqs, inquiryCategories を追加。既存タスクに inquiryId: null を付与
 */
import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from 'idb';
import { createDefaultInquiryCategories } from '../domain/helpdesk/defaults';
import type { ActivityLog, Department, Employee, Faq, Inquiry, InquiryCategory, OnboardingRule, Task } from '../domain/types';

export const DB_NAME = 'workcore';
export const DB_VERSION = 2;

export interface WorkCoreSchema extends DBSchema {
  departments: { key: string; value: Department };
  employees: { key: string; value: Employee; indexes: { byNumber: string; byDepartment: string } };
  tasks: { key: string; value: Task; indexes: { byEmployee: string; byStatus: string; byInquiry: string } };
  rules: { key: string; value: OnboardingRule };
  activities: { key: string; value: ActivityLog; indexes: { byAt: string } };
  meta: { key: string; value: { key: string; value: unknown } };
  inquiries: { key: string; value: Inquiry; indexes: { byNumber: string; byStatus: string; byRequester: string } };
  faqs: { key: string; value: Faq };
  inquiryCategories: { key: string; value: InquiryCategory };
}

export type WorkCoreDB = IDBPDatabase<WorkCoreSchema>;
export const STORE_NAMES = ['departments', 'employees', 'tasks', 'rules', 'activities', 'meta', 'inquiries', 'faqs', 'inquiryCategories'] as const;

type UpgradeTx = IDBPTransaction<WorkCoreSchema, StoreNames<WorkCoreSchema>[], 'versionchange'>;

/** v1 → v2: Phase 1 のデータを壊さずにヘルプデスク用のストアを追加する */
async function migrateToV2(db: IDBPDatabase<WorkCoreSchema>, tx: UpgradeTx) {
  const inq = db.createObjectStore('inquiries', { keyPath: 'id' });
  inq.createIndex('byNumber', 'number', { unique: true });
  inq.createIndex('byStatus', 'status');
  inq.createIndex('byRequester', 'requesterId');
  db.createObjectStore('faqs', { keyPath: 'id' });
  const cats = db.createObjectStore('inquiryCategories', { keyPath: 'id' });
  for (const c of createDefaultInquiryCategories()) await cats.put(c);

  const tasks = tx.objectStore('tasks');
  tasks.createIndex('byInquiry', 'inquiryId');
  let cursor = await tasks.openCursor();
  while (cursor) {
    const t = cursor.value as Task & { inquiryId?: string | null };
    if (t.inquiryId === undefined) await cursor.update({ ...t, inquiryId: null });
    cursor = await cursor.continue();
  }
  await tx.objectStore('meta').put({ key: 'schemaMigratedToV2', value: new Date().toISOString() });
}

export function openWorkCoreDB(name = DB_NAME, version = DB_VERSION): Promise<WorkCoreDB> {
  return openDB<WorkCoreSchema>(name, version, {
    async upgrade(db, oldVersion, _newVersion, tx) {
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
      if (oldVersion < 2 && version >= 2) await migrateToV2(db, tx);
    },
    blocked() {
      console.warn('WorkCore: 他のタブでデータベースが使用中です');
    },
    blocking() {
      // 新しいバージョンのタブが開かれたら、このタブの接続を閉じて移行を妨げない
      if (typeof window !== 'undefined') window.location.reload();
    },
  });
}
