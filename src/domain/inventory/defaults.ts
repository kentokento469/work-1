/**
 * 在庫・購買の初期マスタ (DBマイグレーション・デモ初期化・旧バックアップ復元で共通に使う)。
 * 仕入先・連絡先はすべて架空 (example ドメイン)。アプリから連絡・発注は行わない。
 */
import type { DataSnapshot } from '../types';
import type { EquipmentRule, Item, Location, Supplier } from './types';

export const LOC = { main: 'loc_main', it: 'loc_it', warehouse: 'loc_warehouse' } as const;
export const SUP = { pc: 'sup_pc', office: 'sup_office', mobile: 'sup_mobile' } as const;
export const ITEM = {
  laptop: 'item_laptop',
  smartphone: 'item_smartphone',
  monitor: 'item_monitor',
  keyboard: 'item_keyboard',
  mouse: 'item_mouse',
  cableHdmi: 'item_cable_hdmi',
  cableUsbc: 'item_cable_usbc',
  headset: 'item_headset',
  notebook: 'item_notebook',
  toner: 'item_toner',
  paper: 'item_paper',
  nameCard: 'item_namecard',
} as const;

export function createDefaultLocations(): Location[] {
  return [
    { id: LOC.main, name: '本社 総務倉庫', order: 1, active: true },
    { id: LOC.it, name: '情報システム部 保管棚', order: 2, active: true },
    { id: LOC.warehouse, name: '外部倉庫（予備）', order: 3, active: true },
  ];
}

export function createDefaultSuppliers(): Supplier[] {
  return [
    { id: SUP.pc, name: '架空PCサプライ株式会社', contactName: '営業担当（架空）', phone: '000-0000-0001', email: 'sales@pc-supply.example', leadTimeDays: 7, notes: '法人向けPC・周辺機器（架空の仕入先）', active: true },
    { id: SUP.office, name: 'みどり事務用品（架空）', contactName: '受注窓口（架空）', phone: '000-0000-0002', email: 'order@midori-office.example', leadTimeDays: 2, notes: '事務用品・消耗品（架空の仕入先）', active: true },
    { id: SUP.mobile, name: '架空モバイル販売', contactName: '法人営業（架空）', phone: '000-0000-0003', email: 'biz@mobile.example', leadTimeDays: 5, notes: '業務用スマートフォン（架空の仕入先）', active: true },
  ];
}

export function createDefaultItems(ts: string): Item[] {
  const i = (
    id: string,
    code: string,
    name: string,
    category: Item['category'],
    maker: string,
    model: string,
    unit: string,
    tracking: Item['tracking'],
    minStock: number,
    targetStock: number,
    unitPrice: number,
    loc: string,
    sup: string,
  ): Item => ({ id, code, name, category, maker, model, unit, tracking, minStock, targetStock, unitPrice, defaultLocationId: loc, defaultSupplierId: sup, notes: '', active: true, createdAt: ts, updatedAt: ts });
  return [
    i(ITEM.laptop, 'ITM-0001', 'ノートPC（標準機）', 'pc', '架空電機', 'NB-14S', '台', 'asset', 2, 4, 150000, LOC.it, SUP.pc),
    i(ITEM.smartphone, 'ITM-0002', '業務用スマートフォン', 'smartphone', '架空モバイル', 'SP-6', '台', 'asset', 1, 2, 60000, LOC.it, SUP.mobile),
    i(ITEM.monitor, 'ITM-0003', '24インチモニター', 'monitor', '架空ディスプレイ', 'MN-24', '台', 'quantity', 2, 4, 22000, LOC.it, SUP.pc),
    i(ITEM.keyboard, 'ITM-0004', 'キーボード（有線）', 'keyboard', '架空入力機器', 'KB-100', '個', 'quantity', 3, 6, 2500, LOC.it, SUP.pc),
    i(ITEM.mouse, 'ITM-0005', 'マウス（無線）', 'mouse', '架空入力機器', 'MS-200', '個', 'quantity', 3, 8, 1800, LOC.it, SUP.pc),
    i(ITEM.cableHdmi, 'ITM-0006', 'HDMIケーブル 2m', 'cable', '架空ケーブル', 'HD-2M', '本', 'quantity', 4, 10, 900, LOC.it, SUP.pc),
    i(ITEM.cableUsbc, 'ITM-0007', 'USB-C 充電ケーブル', 'cable', '架空ケーブル', 'UC-1M', '本', 'quantity', 4, 10, 1200, LOC.it, SUP.pc),
    i(ITEM.headset, 'ITM-0008', 'ヘッドセット', 'other', '架空オーディオ', 'HS-30', '個', 'quantity', 2, 5, 4500, LOC.it, SUP.pc),
    i(ITEM.notebook, 'ITM-0009', 'ノート・筆記用具セット', 'office', '架空文具', 'ST-SET', 'セット', 'quantity', 5, 15, 600, LOC.main, SUP.office),
    i(ITEM.toner, 'ITM-0010', '複合機トナー（黒）', 'consumable', '架空事務機', 'TN-K', '本', 'quantity', 2, 4, 12000, LOC.main, SUP.office),
    i(ITEM.paper, 'ITM-0011', 'コピー用紙 A4（500枚）', 'consumable', '架空製紙', 'A4-500', '冊', 'quantity', 20, 50, 450, LOC.main, SUP.office),
    i(ITEM.nameCard, 'ITM-0012', '名刺ケース', 'office', '架空文具', 'NC-01', '個', 'quantity', 3, 10, 800, LOC.main, SUP.office),
  ];
}

/** 入社時に必要な機器 (全社共通 + 部署別) */
export function createDefaultEquipmentRules(): EquipmentRule[] {
  const r = (id: string, scope: string, itemId: string, quantity: number, order: number): EquipmentRule => ({ id, scope, itemId, quantity, enabled: true, order });
  return [
    r('eqr_1', 'common', ITEM.laptop, 1, 1),
    r('eqr_2', 'common', ITEM.mouse, 1, 2),
    r('eqr_3', 'common', ITEM.notebook, 1, 3),
    r('eqr_4', 'dept_eigyo', ITEM.smartphone, 1, 4),
    r('eqr_5', 'dept_eigyo', ITEM.nameCard, 1, 5),
    r('eqr_6', 'dept_kaihatsu', ITEM.monitor, 2, 6),
    r('eqr_7', 'dept_kaihatsu', ITEM.keyboard, 1, 7),
    r('eqr_8', 'dept_kaihatsu', ITEM.cableHdmi, 2, 8),
    r('eqr_9', 'dept_joshis', ITEM.monitor, 1, 9),
    r('eqr_10', 'dept_keiri', ITEM.monitor, 1, 10),
  ];
}

export type InventorySnapshot = Pick<
  DataSnapshot,
  'items' | 'stockLevels' | 'stockMovements' | 'reservations' | 'assets' | 'assetEvents' | 'locations' | 'suppliers' | 'purchaseSuggestions' | 'purchaseOrders' | 'equipmentRules' | 'automationRuns'
>;

/** 在庫データが空の状態 (マスタのみ) */
export function emptyInventory(withMasters = true): InventorySnapshot {
  return {
    items: [],
    stockLevels: [],
    stockMovements: [],
    reservations: [],
    assets: [],
    assetEvents: [],
    locations: withMasters ? createDefaultLocations() : [],
    suppliers: withMasters ? createDefaultSuppliers() : [],
    purchaseSuggestions: [],
    purchaseOrders: [],
    equipmentRules: [],
    automationRuns: [],
  };
}
