import { computeAllStock } from '../domain/inventory/stock';
import { ASSET_STATUS_LABEL, INVENTORY_CATEGORY_LABEL, MOVEMENT_TYPE_LABEL } from '../domain/inventory/types';
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
