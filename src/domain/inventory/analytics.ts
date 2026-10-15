/**
 * 購買・在庫分析 (純粋関数)。
 *
 * 金額の区別 (会計上の資産評価・在庫評価は行わない)
 * - 参考在庫額   : 参考単価 (品目マスタ) × 実在庫。見積・概算用
 * - 取得原価合計 : 資産台帳の購入金額の合計 (廃棄済みを除く)。減価償却は考慮しない
 * - 発注金額     : 発注書の数量 × 発注時単価。承認済み以降のみ集計 (下書き・承認待ちは別表示)
 */
import { addDays } from '../date';
import type { DataSnapshot, ISODate } from '../types';
import { computeAllStock, referenceStockValue } from './stock';
import { ASSET_STATUSES, INVENTORY_CATEGORIES, INVENTORY_CATEGORY_LABEL, type AssetStatus, type InventoryCategory } from './types';

export interface InventoryStats {
  totalOnHand: number;
  totalAvailable: number;
  assetsInUse: number;
  shortageItems: number;
  openSuggestions: number;
  pendingApproval: number;
  awaitingReceipt: number;
  monthly: { month: string; label: string; receive: number; issue: number; adjust: number }[];
  categoryValue: { category: InventoryCategory; label: string; value: number }[];
  totalReferenceValue: number;
  assetStatus: { status: AssetStatus; count: number }[];
  acquisitionCostTotal: number;
  failureHistory: { at: string; assetNumber: string; assetId: string; text: string; inquiryId: string | null }[];
  supplierAmounts: { supplierId: string; name: string; approved: number; pending: number }[];
}

export function computeInventoryStats(data: DataSnapshot, today: ISODate): InventoryStats {
  const stock = computeAllStock(data.items, data);
  const active = data.items.filter((i) => i.active);
  let totalOnHand = 0;
  let totalAvailable = 0;
  for (const i of active) {
    const s = stock.get(i.id)!;
    totalOnHand += s.onHand;
    totalAvailable += Math.max(0, s.available);
  }

  // 月別入出庫 (直近6か月、移動は在庫総数が変わらないため除外)
  const months: InventoryStats['monthly'] = [];
  const base = new Date(`${today}T00:00:00`);
  for (let i = 5; i >= 0; i--) {
    const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
    months.push({ month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: `${d.getMonth() + 1}月`, receive: 0, issue: 0, adjust: 0 });
  }
  for (const m of data.stockMovements) {
    const d = new Date(m.at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const row = months.find((x) => x.month === key);
    if (!row) continue;
    if (m.type === 'receive') row.receive += m.quantity;
    else if (m.type === 'issue') row.issue += m.quantity;
    else if (m.type === 'adjust' || m.type === 'stocktake') row.adjust += m.delta;
  }

  const catValue = new Map<InventoryCategory, number>();
  for (const i of active) catValue.set(i.category, (catValue.get(i.category) ?? 0) + referenceStockValue(i, stock.get(i.id)!));
  const categoryValue = INVENTORY_CATEGORIES.map((c) => ({ category: c, label: INVENTORY_CATEGORY_LABEL[c], value: catValue.get(c) ?? 0 })).filter((c) => c.value > 0);

  const since = addDays(today, -365);
  const failureHistory = data.assetEvents
    .filter((e) => (e.toStatus === 'repair' || e.toStatus === 'broken' || e.type === 'loan') && e.at.slice(0, 10) >= since)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 10)
    .map((e) => {
      const a = data.assets.find((x) => x.id === e.assetId);
      return { at: e.at, assetNumber: a?.assetNumber ?? '', assetId: e.assetId, text: e.type === 'loan' ? `代替機として貸出（${e.employeeName}）` : `${e.toStatus === 'repair' ? '修理中' : '故障'}：${e.note}`, inquiryId: e.inquiryId };
    });

  const supplierAmounts = data.suppliers
    .map((s) => {
      let approved = 0;
      let pending = 0;
      for (const po of data.purchaseOrders.filter((p) => p.supplierId === s.id)) {
        const amount = po.lines.reduce((a, l) => a + l.quantity * l.unitPrice, 0);
        if (['approved', 'partially_received', 'received'].includes(po.status)) approved += amount;
        else if (po.status === 'draft' || po.status === 'pending_approval') pending += amount;
      }
      return { supplierId: s.id, name: s.name, approved, pending };
    })
    .filter((x) => x.approved + x.pending > 0);

  return {
    totalOnHand,
    totalAvailable,
    assetsInUse: data.assets.filter((a) => a.status === 'in_use').length,
    shortageItems: active.filter((i) => stock.get(i.id)!.shortage).length,
    openSuggestions: data.purchaseSuggestions.filter((s) => s.status === 'open').length,
    pendingApproval: data.purchaseOrders.filter((p) => p.status === 'pending_approval').length,
    awaitingReceipt: data.purchaseOrders.filter((p) => p.status === 'approved' || p.status === 'partially_received').length,
    monthly: months,
    categoryValue,
    totalReferenceValue: categoryValue.reduce((a, c) => a + c.value, 0),
    assetStatus: ASSET_STATUSES.map((st) => ({ status: st, count: data.assets.filter((a) => a.status === st).length })),
    acquisitionCostTotal: data.assets.filter((a) => a.status !== 'disposed').reduce((a, x) => a + (x.purchaseCost ?? 0), 0),
    failureHistory,
    supplierAmounts,
  };
}

export function yen(n: number): string {
  return `¥${Math.round(n).toLocaleString('ja-JP')}`;
}
