/**
 * JSONバックアップの生成と、復元時のスキーマ・整合性検証。
 * 外部から読み込むデータは信用せず、全レコードを型ガードで検証してから採用する。
 *
 * 互換性: schemaVersion 1 (Phase 1)・2 (Phase 2) のバックアップも読み込める。
 *   - v1: ヘルプデスク関連データは空、カテゴリは初期値で補う。タスクに inquiryId: null を補う
 *   - v1/v2: 在庫・資産・購買は空 (保管場所・仕入先は初期マスタ) で補う
 *   - v1〜v3: 書類は空で補う
 *
 * v4 (Phase 4) から、書類の元ファイルを files に Base64 で含められる (任意)。
 * 復元前に各ファイルの SHA-256 を計算し、書類に記録したハッシュと一致するかを検証する。
 */
import { isValidISODate } from '../domain/date';
import { repairOptionalReferences } from './repair';
import { validateRecurrence } from '../domain/recurrence';
import { createDefaultInquiryCategories } from '../domain/helpdesk/defaults';
import { emptyInventory } from '../domain/inventory/defaults';
import { DOCUMENT_STATUSES, DOCUMENT_TYPES, EXTRACTION_METHODS, FIELD_KEYS, type DocumentFile } from '../domain/documents/types';
import { sha256Hex } from '../domain/documents/hash';
import { ASSET_STATUSES, INVENTORY_CATEGORIES, MOVEMENT_TYPES, PO_STATUSES } from '../domain/inventory/types';
import { isEmployeeStatus, isEmploymentType, isPriority, isTaskStatus, normalizeEmployeeNumber } from '../domain/validation';
import {
  INQUIRY_STATUSES,
  type ActivityLog,
  type DataSnapshot,
  type Department,
  type Employee,
  type Faq,
  type Inquiry,
  type InquiryCategory,
  type OnboardingRule,
  type Task,
} from '../domain/types';

export const BACKUP_APP_ID = 'WorkCore';
export const BACKUP_SCHEMA_VERSION = 6;
const SUPPORTED_VERSIONS = [1, 2, 3, 4, 5, 6];

/** 書類の元ファイル (Base64)。バックアップに含めるかは出力時に選べる */
export interface BackupDocumentFile {
  id: string;
  documentId: string;
  name: string;
  mime: string;
  size: number;
  hash: string;
  createdAt: string;
  base64: string;
}

export interface BackupFile {
  app: typeof BACKUP_APP_ID;
  schemaVersion: number;
  exportedAt: string;
  data: DataSnapshot;
  files?: BackupDocumentFile[];
}

export function createBackup(data: DataSnapshot, now = new Date(), files?: DocumentFile[]): BackupFile {
  const b: BackupFile = { app: BACKUP_APP_ID, schemaVersion: BACKUP_SCHEMA_VERSION, exportedAt: now.toISOString(), data };
  if (files) b.files = files.map(({ data: buf, ...meta }) => ({ ...meta, base64: bufferToBase64(buf) }));
  return b;
}

export function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

export function base64ToBuffer(b64: string): ArrayBuffer | null {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  } catch {
    return null;
  }
}

/**
 * 元ファイルを復号し、サイズとハッシュを検証する (非同期)。
 * 1件でも一致しなければ復元しない (壊れたファイルを書類に結び付けない)
 */
export async function decodeBackupFiles(backup: BackupFile): Promise<{ ok: true; files: DocumentFile[] } | { ok: false; errors: string[] }> {
  const errors: string[] = [];
  const files: DocumentFile[] = [];
  for (const f of backup.files ?? []) {
    const buf = base64ToBuffer(f.base64);
    if (!buf) {
      errors.push(`元ファイル「${f.name}」を復号できません`);
      continue;
    }
    if (buf.byteLength !== f.size) errors.push(`元ファイル「${f.name}」のサイズが記録と一致しません`);
    else if ((await sha256Hex(buf)) !== f.hash) errors.push(`元ファイル「${f.name}」の内容が記録（ハッシュ）と一致しません。ファイルが破損している可能性があります`);
    else files.push({ id: f.id, documentId: f.documentId, name: f.name, mime: f.mime, size: f.size, hash: f.hash, createdAt: f.createdAt, data: buf });
  }
  return errors.length ? { ok: false, errors: errors.slice(0, 10) } : { ok: true, files };
}

export type BackupValidation =
  | { ok: true; backup: BackupFile; counts: Record<keyof DataSnapshot, number>; sourceVersion: number; repairs: string[] }
  | { ok: false; errors: string[] };

type Rec = Record<string, unknown>;
const isObj = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrOrNull = (v: unknown) => v === null || isStr(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

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
    (v.contact === undefined || (isObj(v.contact) && Object.values(v.contact).every(isStr))) &&
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
    isStrOrNull(v.assigneeDepartmentId) &&
    isStr(v.assignee) &&
    isPriority(v.priority) &&
    (v.dueDate === null || isValidISODate(v.dueDate)) &&
    isTaskStatus(v.status) &&
    (v.source === 'manual' || v.source === 'onboarding' || v.source === 'inquiry' || v.source === 'automation') &&
    (v.assetId === undefined || isStrOrNull(v.assetId)) &&
    isStrOrNull(v.ruleId) &&
    (v.inquiryId === undefined || isStrOrNull(v.inquiryId)) &&
    isStr(v.createdAt) &&
    isStr(v.updatedAt) &&
    isStrOrNull(v.completedAt) &&
    // Phase 7 の項目 (無い = 未設定)
    (v.startDate === undefined || v.startDate === null || isValidISODate(v.startDate)) &&
    (v.projectId === undefined || isStrOrNull(v.projectId)) &&
    (v.parentTaskId === undefined || isStrOrNull(v.parentTaskId)) &&
    (v.tags === undefined || isStrArr(v.tags)) &&
    (v.checklist === undefined || (Array.isArray(v.checklist) && v.checklist.every((c) => isObj(c) && isStr(c.id) && isStr(c.text) && typeof c.done === 'boolean'))) &&
    (v.recurrence === undefined || v.recurrence === null || validateRecurrence(v.recurrence) === null) &&
    (v.seriesId === undefined || isStrOrNull(v.seriesId)) &&
    (v.nextOccurrenceId === undefined || isStrOrNull(v.nextOccurrenceId)) &&
    (v.dependsOn === undefined || isStrArr(v.dependsOn)) &&
    (v.links === undefined || (Array.isArray(v.links) && v.links.every((l) => isObj(l) && isStr(l.kind) && isStr(l.id))))
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
function checkCategory(v: unknown): v is InquiryCategory {
  return (
    isObj(v) &&
    isStr(v.id) &&
    isStr(v.name) &&
    v.name.trim() !== '' &&
    isStrArr(v.keywords) &&
    isStrOrNull(v.defaultDepartmentId) &&
    isStr(v.defaultAssignee) &&
    isNum(v.slaBusinessDays) &&
    typeof v.enabled === 'boolean' &&
    isNum(v.order) &&
    typeof v.isFallback === 'boolean'
  );
}
function checkInquiry(v: unknown): v is Inquiry {
  return (
    isObj(v) &&
    isStr(v.id) &&
    isStr(v.number) &&
    isStr(v.receivedAt) &&
    isStrOrNull(v.requesterId) &&
    isStr(v.requesterName) &&
    isStrOrNull(v.requesterDepartmentId) &&
    isStr(v.title) &&
    isStr(v.body) &&
    isStr(v.categoryId) &&
    isPriority(v.priority) &&
    isStr(v.assignee) &&
    isValidISODate(v.dueDate) &&
    (INQUIRY_STATUSES as readonly unknown[]).includes(v.status) &&
    isStr(v.resolution) &&
    isStrOrNull(v.resolvedAt) &&
    isStrOrNull(v.closedAt) &&
    (v.classification === null || isObj(v.classification)) &&
    isStrArr(v.faqIds) &&
    Array.isArray(v.history) &&
    v.history.every((h) => isObj(h) && isStr(h.id) && isStr(h.at) && isStr(h.type) && isStr(h.message)) &&
    isStr(v.createdAt) &&
    isStr(v.updatedAt)
  );
}
function checkFaq(v: unknown): v is Faq {
  return (
    isObj(v) &&
    isStr(v.id) &&
    isStr(v.question) &&
    isStr(v.answer) &&
    isStr(v.categoryId) &&
    isStrArr(v.keywords) &&
    typeof v.enabled === 'boolean' &&
    isStrOrNull(v.sourceInquiryId) &&
    isStr(v.createdAt) &&
    isStr(v.updatedAt)
  );
}

const isInt = (v: unknown): v is number => Number.isInteger(v);
const oneOf = (list: readonly string[]) => (v: unknown) => typeof v === 'string' && list.includes(v);
const isDateOrNull = (v: unknown) => v === null || isValidISODate(v);
const isNumOrNull = (v: unknown) => v === null || isNum(v);

function checkItem(v: unknown): boolean {
  return (
    isObj(v) && isStr(v.id) && isStr(v.code) && isStr(v.name) && oneOf(INVENTORY_CATEGORIES)(v.category) && isStr(v.maker) && isStr(v.model) && isStr(v.unit) &&
    (v.tracking === 'quantity' || v.tracking === 'asset') && isInt(v.minStock) && isInt(v.targetStock) && isNum(v.unitPrice) &&
    isStrOrNull(v.defaultLocationId) && isStrOrNull(v.defaultSupplierId) && isStr(v.notes) && typeof v.active === 'boolean' && isStr(v.createdAt) && isStr(v.updatedAt)
  );
}
const checkLevel = (v: unknown) => isObj(v) && isStr(v.id) && isStr(v.itemId) && isStr(v.locationId) && isInt(v.quantity) && v.quantity >= 0;
const checkMovement = (v: unknown) =>
  isObj(v) && isStr(v.id) && isStr(v.itemId) && oneOf(MOVEMENT_TYPES)(v.type) && isInt(v.delta) && isInt(v.quantity) && isStr(v.locationId) && isStrOrNull(v.toLocationId) &&
  isInt(v.balanceAfter) && isStr(v.reason) && isStr(v.refType) && isStrOrNull(v.refId) && isStrOrNull(v.employeeId) && isStr(v.at);
const checkReservation = (v: unknown) =>
  isObj(v) && isStr(v.id) && isStr(v.itemId) && isInt(v.quantity) && v.quantity > 0 && oneOf(['active', 'backorder', 'fulfilled', 'released'])(v.status) &&
  isStrOrNull(v.employeeId) && isStrOrNull(v.inquiryId) && isStr(v.purpose) && isStr(v.key) && isStr(v.createdAt) && isStr(v.updatedAt);
const checkAsset = (v: unknown) =>
  isObj(v) && isStr(v.id) && isStr(v.assetNumber) && isStrOrNull(v.itemId) && isStr(v.name) && oneOf(INVENTORY_CATEGORIES)(v.category) && isStr(v.maker) && isStr(v.model) &&
  isStr(v.serialNumber) && isDateOrNull(v.purchaseDate) && isNumOrNull(v.purchaseCost) && isDateOrNull(v.warrantyUntil) && oneOf(ASSET_STATUSES)(v.status) &&
  isStrOrNull(v.assigneeId) && isStr(v.assigneeName) && isStrOrNull(v.departmentId) && isStrOrNull(v.locationId) && isStrOrNull(v.purchaseOrderId) && isStr(v.notes) &&
  isStr(v.createdAt) && isStr(v.updatedAt);
const checkAssetEvent = (v: unknown) =>
  isObj(v) && isStr(v.id) && isStr(v.assetId) && isStr(v.type) && (v.fromStatus === null || oneOf(ASSET_STATUSES)(v.fromStatus)) && oneOf(ASSET_STATUSES)(v.toStatus) &&
  isStrOrNull(v.employeeId) && isStr(v.employeeName) && isStrOrNull(v.inquiryId) && isStr(v.note) && isStr(v.at);
const checkLocation = (v: unknown) => isObj(v) && isStr(v.id) && isStr(v.name) && isNum(v.order) && typeof v.active === 'boolean';
const checkSupplier = (v: unknown) =>
  isObj(v) && isStr(v.id) && isStr(v.name) && isStr(v.contactName) && isStr(v.phone) && isStr(v.email) && isNum(v.leadTimeDays) && isStr(v.notes) && typeof v.active === 'boolean';
const checkSuggestion = (v: unknown) =>
  isObj(v) && isStr(v.id) && isStr(v.itemId) && isInt(v.quantity) && isStrArr(v.reasons) && oneOf(['open', 'ordered', 'dismissed', 'resolved'])(v.status) &&
  isStrOrNull(v.purchaseOrderId) && isStr(v.createdAt) && isStr(v.updatedAt);
const checkPo = (v: unknown) =>
  isObj(v) && isStr(v.id) && isStr(v.number) && isStr(v.supplierId) && oneOf(PO_STATUSES)(v.status) && isDateOrNull(v.expectedDate) && isStr(v.requestedBy) && isStr(v.approvedBy) &&
  isStr(v.notes) && Array.isArray(v.history) && Array.isArray(v.lines) &&
  v.lines.every((l) => isObj(l) && isStr(l.id) && isStr(l.itemId) && isInt(l.quantity) && l.quantity > 0 && isNum(l.unitPrice) && isInt(l.receivedQuantity) && l.receivedQuantity >= 0 && l.receivedQuantity <= l.quantity) &&
  isStr(v.createdAt) && isStr(v.updatedAt) && isStrOrNull(v.approvedAt);
const checkEquipmentRule = (v: unknown) => isObj(v) && isStr(v.id) && isStr(v.scope) && isStr(v.itemId) && isInt(v.quantity) && v.quantity > 0 && typeof v.enabled === 'boolean' && isNum(v.order);
const checkRun = (v: unknown) => isObj(v) && isStr(v.id) && isStr(v.automationId) && isStr(v.key) && isStr(v.status) && isStr(v.title) && isStrArr(v.results) && isStrOrNull(v.error) && isStr(v.at);

const isStrRecord = (v: unknown) => isObj(v) && Object.entries(v).every(([k, x]) => (FIELD_KEYS as readonly string[]).includes(k) && isStr(x));
const checkDocument = (v: unknown) =>
  isObj(v) && isStr(v.id) && isStr(v.number) && oneOf(DOCUMENT_TYPES)(v.type) && oneOf(DOCUMENT_STATUSES)(v.status) && oneOf(EXTRACTION_METHODS)(v.method) &&
  isStrRecord(v.fields) && isObj(v.extracted) && isStrArr(v.reviewed) && Array.isArray(v.lines) &&
  v.lines.every((l) => isObj(l) && isStr(l.id) && isStr(l.name) && isNumOrNull(l.quantity) && isNumOrNull(l.unitPrice) && isNumOrNull(l.amount) && isStrOrNull(l.itemId)) &&
  Array.isArray(v.taxLines) && Array.isArray(v.pages) && v.pages.every((p) => isObj(p) && isInt(p.page) && isStr(p.text)) &&
  (v.file === null || (isObj(v.file) && isStr(v.file.fileId) && isStr(v.file.name) && isStr(v.file.mime) && isInt(v.file.size) && isStr(v.file.hash) && isInt(v.file.pageCount))) &&
  isStrOrNull(v.employeeId) && isStrOrNull(v.inquiryId) && isStrOrNull(v.purchaseOrderId) && isStrOrNull(v.supplierId) && isStrArr(v.notDuplicateOf) &&
  Array.isArray(v.history) && isStr(v.createdAt) && isStr(v.updatedAt) && isStrOrNull(v.deletedAt);

const MAX_ERRORS = 10;

export function validateBackup(raw: unknown): BackupValidation {
  const errors: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ['JSONの形式が正しくありません'] };
  if (raw.app !== BACKUP_APP_ID) return { ok: false, errors: ['WorkCore のバックアップファイルではありません'] };
  if (!isNum(raw.schemaVersion) || !SUPPORTED_VERSIONS.includes(raw.schemaVersion))
    return { ok: false, errors: [`対応していないバージョンです（${String(raw.schemaVersion)}）`] };
  if (!isObj(raw.data)) return { ok: false, errors: ['data 項目がありません'] };
  const version = raw.schemaVersion;
  const d: Rec = { ...raw.data };

  // v1 → v2 の補完
  if (version === 1) {
    d.inquiries = [];
    d.faqs = [];
    d.inquiryCategories = createDefaultInquiryCategories();
  }
  // v1/v2 → v3 の補完 (在庫・資産・購買は空、保管場所・仕入先は初期マスタ)
  if (version < 3) Object.assign(d, emptyInventory(true));
  // v1〜v3 → v4 の補完 (書類は空)
  if (version < 4) d.documents = [];
  // v1〜v4 → v5 の補完 (設定は既定値)
  if (version < 5) d.settings = [];
  // v5 → v6 の補完 (Phase 7: プロジェクト。タスクの新しい項目は未設定として扱う)
  if (version < 6) {
    d.projects = [];
    // プロジェクトが無かった版のデータに所属が残っていても参照切れにしない
    if (Array.isArray(d.tasks)) d.tasks = d.tasks.map((t) => (isObj(t) && 'projectId' in t ? { ...t, projectId: null } : t));
  }

  const collections = [
    ['departments', '部署', checkDepartment],
    ['employees', '社員', checkEmployee],
    ['tasks', 'タスク', checkTask],
    ['rules', '入社準備ルール', checkRule],
    ['activities', '操作履歴', checkActivity],
    ['inquiryCategories', '問い合わせカテゴリ', checkCategory],
    ['inquiries', '問い合わせ', checkInquiry],
    ['faqs', 'FAQ', checkFaq],
    ['items', '品目', checkItem],
    ['stockLevels', '保管場所別在庫', checkLevel],
    ['stockMovements', '入出庫履歴', checkMovement],
    ['reservations', '予約', checkReservation],
    ['assets', 'IT資産', checkAsset],
    ['assetEvents', '資産履歴', checkAssetEvent],
    ['locations', '保管場所', checkLocation],
    ['suppliers', '仕入先', checkSupplier],
    ['purchaseSuggestions', '発注候補', checkSuggestion],
    ['purchaseOrders', '発注書', checkPo],
    ['equipmentRules', '入社時の必要機器ルール', checkEquipmentRule],
    ['automationRuns', '自動化の処理履歴', checkRun],
    ['documents', '書類', checkDocument],
    ['settings', '設定', (v: unknown) => isObj(v) && isStr(v.id) && isStr(v.updatedAt) && 'value' in v],
    ['projects', 'プロジェクト', (v: unknown) => isObj(v) && isStr(v.id) && isStr(v.name) && isStr(v.description) && typeof v.archived === 'boolean' && isStr(v.createdAt) && isStr(v.updatedAt)],
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

  // 任意の参照の参照切れは修復して取り込む (削除操作の後に作られたバックアップも復元できるように)
  const { data, repairs } = repairOptionalReferences({
    ...(d as unknown as DataSnapshot),
    tasks: (d.tasks as (Task & { inquiryId?: string | null })[]).map((t) => ({ ...t, inquiryId: t.inquiryId ?? null })),
  });

  // 参照整合性
  const deptIds = new Set(data.departments.map((x) => x.id));
  const empIds = new Set(data.employees.map((x) => x.id));
  const catIds = new Set(data.inquiryCategories.map((x) => x.id));
  const inqIds = new Set(data.inquiries.map((x) => x.id));
  const projIds = new Set((data.projects ?? []).map((x) => x.id));
  const taskIds = new Set(data.tasks.map((x) => x.id));
  const nums = new Set<string>();
  for (const e of data.employees) {
    if (!deptIds.has(e.departmentId)) errors.push(`社員「${e.name}」の所属部署が存在しません`);
    const n = normalizeEmployeeNumber(e.employeeNumber);
    if (nums.has(n)) errors.push(`社員番号「${n}」が重複しています`);
    nums.add(n);
  }
  for (const t of data.tasks) {
    if (t.employeeId !== null && !empIds.has(t.employeeId)) errors.push(`タスク「${t.title}」の対象社員が存在しません`);
    if (t.assigneeDepartmentId && !deptIds.has(t.assigneeDepartmentId)) errors.push(`タスク「${t.title}」の担当部署が存在しません`);
    if (t.inquiryId !== null && !inqIds.has(t.inquiryId)) errors.push(`タスク「${t.title}」の生成元問い合わせが存在しません`);
    if (t.projectId && !projIds.has(t.projectId)) errors.push(`タスク「${t.title}」のプロジェクトが存在しません`);
    if (t.parentTaskId && !taskIds.has(t.parentTaskId)) errors.push(`タスク「${t.title}」の親タスクが存在しません`);
  }
  for (const r of data.rules) {
    if (r.scope !== 'common' && !deptIds.has(r.scope)) errors.push(`ルール「${r.title}」の適用部署が存在しません`);
    if (!deptIds.has(r.assigneeDepartmentId)) errors.push(`ルール「${r.title}」の担当部署が存在しません`);
  }
  if (!data.inquiryCategories.some((c) => c.isFallback)) errors.push('「その他・要確認」カテゴリがありません');
  const inqNums = new Set<string>();
  for (const i of data.inquiries) {
    if (!catIds.has(i.categoryId)) errors.push(`問い合わせ「${i.number}」のカテゴリが存在しません`);
    if (inqNums.has(i.number)) errors.push(`問い合わせ番号「${i.number}」が重複しています`);
    inqNums.add(i.number);
  }
  for (const f of data.faqs) if (!catIds.has(f.categoryId)) errors.push(`FAQ「${f.question}」のカテゴリが存在しません`);

  // 在庫・資産・購買の参照整合性
  const itemIds = new Set(data.items.map((i) => i.id));
  const locIds = new Set(data.locations.map((l) => l.id));
  const supIds = new Set(data.suppliers.map((x) => x.id));
  const assetIds = new Set(data.assets.map((a) => a.id));
  const codes = new Set<string>();
  for (const i of data.items) {
    if (codes.has(i.code.toUpperCase())) errors.push(`品目ID「${i.code}」が重複しています`);
    codes.add(i.code.toUpperCase());
  }
  for (const l of data.stockLevels) if (!itemIds.has(l.itemId) || !locIds.has(l.locationId)) errors.push(`在庫（${l.id}）の品目または保管場所が存在しません`);
  for (const m of data.stockMovements) if (!itemIds.has(m.itemId)) errors.push('入出庫履歴の品目が存在しません');
  for (const r of data.reservations) if (!itemIds.has(r.itemId)) errors.push('予約の品目が存在しません');
  const assetNums = new Set<string>();
  for (const a of data.assets) {
    if (a.itemId && !itemIds.has(a.itemId)) errors.push(`資産「${a.assetNumber}」の機種が存在しません`);
    if (assetNums.has(a.assetNumber)) errors.push(`資産管理番号「${a.assetNumber}」が重複しています`);
    assetNums.add(a.assetNumber);
  }
  for (const e of data.assetEvents) if (!assetIds.has(e.assetId)) errors.push('資産履歴の資産が存在しません');
  for (const sg of data.purchaseSuggestions) if (!itemIds.has(sg.itemId)) errors.push('発注候補の品目が存在しません');
  for (const po of data.purchaseOrders) {
    if (!supIds.has(po.supplierId)) errors.push(`発注書「${po.number}」の仕入先が存在しません`);
    if (po.lines.some((l) => !itemIds.has(l.itemId))) errors.push(`発注書「${po.number}」の品目が存在しません`);
  }
  for (const r of data.equipmentRules) if (!itemIds.has(r.itemId)) errors.push('必要機器ルールの品目が存在しません');
  // 台帳と在庫数の一致 (数量管理品)
  const ledger = new Map<string, number>();
  for (const m of data.stockMovements) ledger.set(m.itemId, (ledger.get(m.itemId) ?? 0) + m.delta);
  const levelSum = new Map<string, number>();
  for (const l of data.stockLevels) levelSum.set(l.itemId, (levelSum.get(l.itemId) ?? 0) + l.quantity);
  for (const i of data.items.filter((x) => x.tracking === 'quantity'))
    if ((ledger.get(i.id) ?? 0) !== (levelSum.get(i.id) ?? 0)) errors.push(`品目「${i.name}」の在庫数と入出庫履歴の合計が一致しません`);

  // 書類の参照整合性
  const poIds = new Set(data.purchaseOrders.map((p) => p.id));
  const docNums = new Set<string>();
  const docIds = new Set(data.documents.map((x) => x.id));
  for (const doc of data.documents) {
    if (docNums.has(doc.number)) errors.push(`書類ID「${doc.number}」が重複しています`);
    docNums.add(doc.number);
    if (doc.employeeId && !empIds.has(doc.employeeId)) errors.push(`書類「${doc.number}」の関連社員が存在しません`);
    if (doc.inquiryId && !inqIds.has(doc.inquiryId)) errors.push(`書類「${doc.number}」の関連問い合わせが存在しません`);
    if (doc.purchaseOrderId && !poIds.has(doc.purchaseOrderId)) errors.push(`書類「${doc.number}」の関連発注書が存在しません`);
    if (doc.lines.some((l) => l.itemId && !itemIds.has(l.itemId))) errors.push(`書類「${doc.number}」の明細に存在しない品目があります`);
  }
  const files = raw.files;
  let backupFiles: BackupDocumentFile[] | undefined;
  if (files !== undefined) {
    if (!Array.isArray(files)) errors.push('元ファイル（files）の形式が不正です');
    else {
      backupFiles = [];
      files.forEach((f: unknown, i) => {
        if (!(isObj(f) && isStr(f.id) && isStr(f.documentId) && isStr(f.name) && isStr(f.mime) && isInt(f.size) && isStr(f.hash) && isStr(f.base64) && isStr(f.createdAt)))
          errors.push(`元ファイル ${i + 1}件目の形式が不正です`);
        else if (!docIds.has(f.documentId)) errors.push(`元ファイル「${f.name}」の書類が存在しません`);
        else backupFiles!.push(f as unknown as BackupDocumentFile);
      });
      for (const f of backupFiles) {
        const doc = data.documents.find((x) => x.id === f.documentId)!;
        if (!doc.file || doc.file.fileId !== f.id || doc.file.hash !== f.hash) errors.push(`元ファイル「${f.name}」が書類「${doc.number}」の記録と一致しません`);
      }
    }
  }
  if (errors.length) return { ok: false, errors: errors.slice(0, MAX_ERRORS) };

  const backup: BackupFile = {
    app: BACKUP_APP_ID,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: isStr(raw.exportedAt) ? raw.exportedAt : '',
    data: {
      ...data,
      // 社員番号は正規化して保存 (DBの一意インデックスと整合させる)
      employees: data.employees.map((e) => ({ ...e, employeeNumber: normalizeEmployeeNumber(e.employeeNumber) })),
    },
    ...(backupFiles ? { files: backupFiles } : {}),
  };
  const counts = Object.fromEntries(Object.entries(backup.data).map(([k, v]) => [k, (v as unknown[]).length])) as Record<keyof DataSnapshot, number>;
  return { ok: true, backup, counts, sourceVersion: version, repairs };
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
