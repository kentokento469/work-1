import { computeAllStock } from '../domain/inventory/stock';
import { ASSET_STATUS_LABEL, INVENTORY_CATEGORY_LABEL, MOVEMENT_TYPE_LABEL } from '../domain/inventory/types';
import { DOCUMENT_STATUS_LABEL, DOCUMENT_TYPE_LABEL, EXTRACTION_METHOD_LABEL, FIELD_DEFS, type DocumentRecord, type DocumentType } from '../domain/documents/types';
import { EMPLOYEE_STATUS_LABEL, INQUIRY_STATUS_LABEL, PRIORITY_LABEL, TASK_STATUS_LABEL, type DataSnapshot } from '../domain/types';

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
      e.contact?.phone ?? '',
      e.contact?.email ?? '',
      e.contact?.postalCode ?? '',
      e.contact ? `${e.contact.prefecture}${e.contact.city}${e.contact.town}${e.contact.addressLine ? ` ${e.contact.addressLine}` : ''}`.trim() : '',
    ]);
  return toCsv(['社員番号', '氏名', '所属部署', '役職', '雇用区分', '入社日', '退職日', '在籍ステータス', '備考', '電話番号', 'メールアドレス', '郵便番号', '住所'], rows);
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
        t.source === 'onboarding' ? '入社準備(自動)' : t.source === 'inquiry' ? '問い合わせ' : t.source === 'automation' ? '自動化' : '手動',
        t.completedAt ?? '',
        t.description,
      ];
    });
  return toCsv(
    ['タスク名', '対象社員番号', '対象社員', '担当部署', '担当者', '優先度', '期限', '進捗状況', '登録元', '完了日時', '詳細'],
    rows,
  );
}

export function inquiriesToCsv(data: Pick<DataSnapshot, 'inquiries' | 'inquiryCategories' | 'departments' | 'tasks'>): string {
  const cat = new Map(data.inquiryCategories.map((c) => [c.id, c.name]));
  const dept = new Map(data.departments.map((d) => [d.id, d.name]));
  const rows = [...data.inquiries]
    .sort((a, b) => a.number.localeCompare(b.number))
    .map((i) => {
      const tasks = data.tasks.filter((t) => t.inquiryId === i.id);
      return [
        i.number,
        i.receivedAt,
        i.requesterName,
        i.requesterDepartmentId ? (dept.get(i.requesterDepartmentId) ?? '') : '',
        i.title,
        cat.get(i.categoryId) ?? '',
        PRIORITY_LABEL[i.priority],
        INQUIRY_STATUS_LABEL[i.status],
        i.assignee,
        i.dueDate,
        i.resolvedAt ?? '',
        i.closedAt ?? '',
        // "1/2" は Excel で日付に変換されるため文字で表す
        `完了${tasks.filter((t) => t.status === 'done').length}・全${tasks.length}`,
        i.body,
        i.resolution,
      ];
    });
  return toCsv(
    ['問い合わせ番号', '受付日時', '申請者', '所属部署', '件名', 'カテゴリ', '優先度', 'ステータス', '担当者', '対応期限', '解決日時', '完了日時', '対応タスク', '詳細', '解決内容'],
    rows,
  );
}

export function itemsToCsv(data: DataSnapshot): string {
  const stock = computeAllStock(data.items, data);
  const loc = new Map(data.locations.map((l) => [l.id, l.name]));
  const rows = data.items.map((i) => {
    const s = stock.get(i.id)!;
    return [i.code, i.name, INVENTORY_CATEGORY_LABEL[i.category], i.maker, i.model, i.unit, i.tracking === 'asset' ? '個体' : '数量', s.onHand, s.reserved, s.available, s.backorder, s.onOrder, i.minStock, i.targetStock, i.unitPrice, i.unitPrice * s.onHand, loc.get(i.defaultLocationId ?? '') ?? '', i.active ? '有効' : '無効', i.notes, i.createdAt, i.updatedAt];
  });
  return toCsv(['品目ID', '名称', 'カテゴリ', 'メーカー', '型番', '管理単位', '管理方法', '実在庫', '予約数', '利用可能数', '入荷待ち需要', '発注残', '最低在庫数', '適正在庫数', '参考単価', '参考在庫額', '保管場所', '状態', '備考', '登録日時', '更新日時'], rows);
}

export function movementsToCsv(data: DataSnapshot): string {
  const item = new Map(data.items.map((i) => [i.id, i]));
  const loc = new Map(data.locations.map((l) => [l.id, l.name]));
  const emp = new Map(data.employees.map((e) => [e.id, e.name]));
  const rows = [...data.stockMovements]
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((m) => [m.at, item.get(m.itemId)?.code ?? '', item.get(m.itemId)?.name ?? '', MOVEMENT_TYPE_LABEL[m.type], m.delta, m.quantity, loc.get(m.locationId) ?? '', m.toLocationId ? (loc.get(m.toLocationId) ?? '') : '', m.balanceAfter, m.reason, m.employeeId ? (emp.get(m.employeeId) ?? '') : '']);
  return toCsv(['日時', '品目ID', '品目名', '種別', '増減', '数量', '保管場所', '移動先', '処理後の在庫', '理由', '社員'], rows);
}

export function assetsToCsv(data: DataSnapshot): string {
  const dept = new Map(data.departments.map((d) => [d.id, d.name]));
  const loc = new Map(data.locations.map((l) => [l.id, l.name]));
  const rows = data.assets.map((a) => [a.assetNumber, a.name, INVENTORY_CATEGORY_LABEL[a.category], a.maker, a.model, a.serialNumber, a.purchaseDate ?? '', a.purchaseCost ?? '', a.warrantyUntil ?? '', ASSET_STATUS_LABEL[a.status], a.assigneeName, a.departmentId ? (dept.get(a.departmentId) ?? '') : '', a.locationId ? (loc.get(a.locationId) ?? '') : '', a.notes]);
  return toCsv(['資産管理番号', '機器名', 'カテゴリ', 'メーカー', '型番', 'シリアル番号', '購入日', '購入金額（取得原価）', '保証期限', '使用状況', '利用者', '所属部署', '保管場所', '備考'], rows);
}

// ---------- Phase 4: 書類 ----------

export interface DocumentExportFilter {
  /** 指定したIDのみ (選択出力) */
  ids?: string[];
  /** 発行日 (なければ登録日) の範囲 YYYY-MM-DD */
  from?: string;
  to?: string;
  types?: DocumentType[];
  includeDeleted?: boolean;
}

/** 書類の基準日: 発行日、なければ登録日 */
export const documentDate = (d: DocumentRecord) => d.fields.issueDate || d.createdAt.slice(0, 10);

export function filterDocumentsForExport(docs: DocumentRecord[], f: DocumentExportFilter): DocumentRecord[] {
  const ids = f.ids ? new Set(f.ids) : null;
  return docs
    .filter((d) => (f.includeDeleted ? true : !d.deletedAt))
    .filter((d) => !ids || ids.has(d.id))
    .filter((d) => !f.types?.length || f.types.includes(d.type))
    .filter((d) => (!f.from || documentDate(d) >= f.from) && (!f.to || documentDate(d) <= f.to))
    .sort((a, b) => documentDate(a).localeCompare(documentDate(b)) || a.number.localeCompare(b.number));
}

const num = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : '');

export function documentsToCsv(docs: DocumentRecord[], refs: Pick<DataSnapshot, 'employees' | 'inquiries' | 'purchaseOrders'>): string {
  const emp = new Map(refs.employees.map((e) => [e.id, e]));
  const inq = new Map(refs.inquiries.map((i) => [i.id, i.number]));
  const po = new Map(refs.purchaseOrders.map((p) => [p.id, p.number]));
  const rows = docs.map((d) => {
    const f = d.fields;
    const unconfirmed = d.status === 'needs_review' ? FIELD_DEFS.filter((x) => x.important && !d.reviewed.includes(x.key)).map((x) => x.label) : [];
    return [
      d.number,
      DOCUMENT_TYPE_LABEL[d.type],
      DOCUMENT_STATUS_LABEL[d.status],
      f.title ?? '',
      f.issueDate ?? '',
      f.issuer ?? '',
      f.recipient ?? '',
      f.docNumber ?? '',
      num(f.subtotal),
      num(f.tax),
      num(f.total),
      f.registrationNumber ?? '',
      f.dueDate ?? '',
      f.deliveryDate ?? '',
      f.applicant ?? '',
      f.applicationContent ?? '',
      d.lines.length,
      EXTRACTION_METHOD_LABEL[d.method],
      unconfirmed.join('・'),
      d.employeeId ? (emp.get(d.employeeId)?.name ?? '') : '',
      d.inquiryId ? (inq.get(d.inquiryId) ?? '') : '',
      d.purchaseOrderId ? (po.get(d.purchaseOrderId) ?? '') : '',
      d.file?.name ?? '',
      f.notes ?? '',
      d.createdAt,
      d.updatedAt,
    ];
  });
  return toCsv(
    ['書類ID', '種類', '処理状態', '書類名', '発行日', '発行元', '宛先', '書類番号', '小計(税抜)', '消費税', '合計(税込)', '登録番号', '支払期限', '納品日', '申請者', '申請内容', '明細行数', '抽出元', '未確認の重要項目', '関連社員', '関連問い合わせ', '関連発注書', '元ファイル名', '備考', '登録日時', '更新日時'],
    rows,
  );
}

/** 明細行の出力 (1明細1行。書類の主要項目を各行に繰り返す) */
export function documentLinesToCsv(docs: DocumentRecord[], items: Pick<DataSnapshot, 'items'>['items']): string {
  const itemName = new Map(items.map((i) => [i.id, `${i.code} ${i.name}`]));
  const rows = docs.flatMap((d) =>
    d.lines.map((l, i) => [d.number, DOCUMENT_TYPE_LABEL[d.type], d.fields.issueDate ?? '', d.fields.issuer ?? '', d.fields.docNumber ?? '', i + 1, l.name, l.quantity ?? '', l.unitPrice ?? '', l.amount ?? '', l.itemId ? (itemName.get(l.itemId) ?? '') : '']),
  );
  return toCsv(['書類ID', '種類', '発行日', '発行元', '書類番号', '行', '品名', '数量', '単価', '金額', '対応する在庫品目'], rows);
}
