/**
 * IndexedDB 永続化層。
 * 社員番号・問い合わせ番号には一意インデックスを張り、アプリ側の検証に加えて DB レベルでも重複を防ぐ。
 *
 * スキーマ履歴:
 *  v1 (Phase 1): departments, employees, tasks, rules, activities, meta
 *  v2 (Phase 2): inquiries, faqs, inquiryCategories を追加。既存タスクに inquiryId: null を付与
 *  v3 (Phase 3): 在庫・IT資産・購買・自動化履歴のストアを追加。保管場所・仕入先 (架空) の初期マスタを投入
 */
import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from 'idb';
import { createDefaultInquiryCategories } from '../domain/helpdesk/defaults';
import type { ActivityLog, Department, Employee, Faq, Inquiry, InquiryCategory, OnboardingRule, Task } from '../domain/types';
import type {
  Asset,
  AssetEvent,
  AutomationRun,
  EquipmentRule,
  Item,
  Location,
  PurchaseOrder,
  PurchaseSuggestion,
  Reservation,
  StockLevel,
  StockMovement,
  Supplier,
} from '../domain/inventory/types';
import { createDefaultLocations, createDefaultSuppliers } from '../domain/inventory/defaults';

export const DB_NAME = 'workcore';
export const DB_VERSION = 3;

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
  items: { key: string; value: Item; indexes: { byCode: string } };
  stockLevels: { key: string; value: StockLevel; indexes: { byItem: string } };
  stockMovements: { key: string; value: StockMovement; indexes: { byItem: string; byAt: string } };
  reservations: { key: string; value: Reservation; indexes: { byItem: string; byEmployee: string } };
  assets: { key: string; value: Asset; indexes: { byNumber: string; byItem: string; byAssignee: string } };
  assetEvents: { key: string; value: AssetEvent; indexes: { byAsset: string; byInquiry: string } };
  locations: { key: string; value: Location };
  suppliers: { key: string; value: Supplier };
  purchaseSuggestions: { key: string; value: PurchaseSuggestion; indexes: { byItem: string } };
  purchaseOrders: { key: string; value: PurchaseOrder; indexes: { byNumber: string } };
  equipmentRules: { key: string; value: EquipmentRule };
  automationRuns: { key: string; value: AutomationRun; indexes: { byKey: string } };
}

export type WorkCoreDB = IDBPDatabase<WorkCoreSchema>;
export const STORE_NAMES = [
  'departments',
  'employees',
  'tasks',
  'rules',
  'activities',
  'meta',
  'inquiries',
  'faqs',
  'inquiryCategories',
  'items',
  'stockLevels',
  'stockMovements',
  'reservations',
  'assets',
  'assetEvents',
  'locations',
  'suppliers',
  'purchaseSuggestions',
  'purchaseOrders',
  'equipmentRules',
  'automationRuns',
] as const;

/** バックアップ・スナップショット対象 (meta 以外) */
export const DATA_STORES = STORE_NAMES.filter((s) => s !== 'meta') as Exclude<(typeof STORE_NAMES)[number], 'meta'>[];

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

/** v2 → v3: 在庫・IT資産・購買のストアを追加 (既存データには触れない) */
async function migrateToV3(db: IDBPDatabase<WorkCoreSchema>, tx: UpgradeTx) {
  db.createObjectStore('items', { keyPath: 'id' }).createIndex('byCode', 'code', { unique: true });
  db.createObjectStore('stockLevels', { keyPath: 'id' }).createIndex('byItem', 'itemId');
  const mv = db.createObjectStore('stockMovements', { keyPath: 'id' });
  mv.createIndex('byItem', 'itemId');
  mv.createIndex('byAt', 'at');
  const rs = db.createObjectStore('reservations', { keyPath: 'id' });
  rs.createIndex('byItem', 'itemId');
  rs.createIndex('byEmployee', 'employeeId');
  const as = db.createObjectStore('assets', { keyPath: 'id' });
  as.createIndex('byNumber', 'assetNumber', { unique: true });
  as.createIndex('byItem', 'itemId');
  as.createIndex('byAssignee', 'assigneeId');
  const ae = db.createObjectStore('assetEvents', { keyPath: 'id' });
  ae.createIndex('byAsset', 'assetId');
  ae.createIndex('byInquiry', 'inquiryId');
  const loc = db.createObjectStore('locations', { keyPath: 'id' });
  const sup = db.createObjectStore('suppliers', { keyPath: 'id' });
  db.createObjectStore('purchaseSuggestions', { keyPath: 'id' }).createIndex('byItem', 'itemId');
  db.createObjectStore('purchaseOrders', { keyPath: 'id' }).createIndex('byNumber', 'number', { unique: true });
  db.createObjectStore('equipmentRules', { keyPath: 'id' });
  db.createObjectStore('automationRuns', { keyPath: 'id' }).createIndex('byKey', 'key');
  for (const l of createDefaultLocations()) await loc.put(l);
  for (const s of createDefaultSuppliers()) await sup.put(s);
  await tx.objectStore('meta').put({ key: 'schemaMigratedToV3', value: new Date().toISOString() });
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
      if (oldVersion < 3 && version >= 3) await migrateToV3(db, tx);
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
