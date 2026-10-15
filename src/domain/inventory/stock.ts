/**
 * 在庫状態の計算 (純粋関数)。
 *
 * 用語 (画面・資料で統一)
 * - 実在庫 (onHand)      : 手元にある数量。数量管理品は保管場所別在庫の合計、個体管理品は「未使用 + 予約済み」の台数
 * - 予約数 (reserved)     : 実在庫のうち、特定の社員・用途に引当済みの数量
 * - 利用可能数 (available) : 実在庫 − 予約数。新たに出庫・貸出できる数量
 * - 入荷待ち需要 (backorder): 予約したいが在庫が足りず、入荷を待っている数量
 * - 発注残 (onOrder)      : 承認済み発注のうち未入荷の数量 (まだ在庫には含めない)
 * - 発注準備中 (planned)  : 下書き・承認待ちの発注書の数量 (二重発注候補の防止にのみ使う)
 * - 見込み在庫 (projected): 利用可能数 − 入荷待ち需要 + 発注残
 * 見込み在庫が最低在庫数を下回ったら「在庫不足」とし、適正在庫数まで補充する数量を推奨する。
 */
import type { Asset, Item, PurchaseOrder, Reservation, StockLevel } from './types';

export interface StockStatus {
  itemId: string;
  onHand: number;
  reserved: number;
  available: number;
  backorder: number;
  onOrder: number;
  planned: number;
  projected: number;
  /** 個体管理品の使用中台数 (参考) */
  inUse: number;
  byLocation: { locationId: string; quantity: number }[];
  shortage: boolean;
  /** 発注候補として推奨する数量 (発注準備中の数量を差し引いた残り) */
  recommendedQty: number;
}

export interface StockContext {
  stockLevels: StockLevel[];
  reservations: Reservation[];
  assets: Asset[];
  purchaseOrders: PurchaseOrder[];
}

const OPEN_PO = new Set(['approved', 'partially_received']);
const PLANNED_PO = new Set(['draft', 'pending_approval']);

export function computeStockStatus(item: Item, ctx: StockContext): StockStatus {
  let onHand = 0;
  let reserved = 0;
  let inUse = 0;
  let byLocation: { locationId: string; quantity: number }[] = [];
  if (item.tracking === 'asset') {
    const mine = ctx.assets.filter((a) => a.itemId === item.id);
    const inStock = mine.filter((a) => a.status === 'unused' || a.status === 'reserved');
    onHand = inStock.length;
    reserved = mine.filter((a) => a.status === 'reserved').length;
    inUse = mine.filter((a) => a.status === 'in_use').length;
    const loc = new Map<string, number>();
    for (const a of inStock) if (a.locationId) loc.set(a.locationId, (loc.get(a.locationId) ?? 0) + 1);
    byLocation = [...loc].map(([locationId, quantity]) => ({ locationId, quantity }));
  } else {
    byLocation = ctx.stockLevels.filter((l) => l.itemId === item.id && l.quantity !== 0).map((l) => ({ locationId: l.locationId, quantity: l.quantity }));
    onHand = byLocation.reduce((a, l) => a + l.quantity, 0);
    reserved = ctx.reservations.filter((r) => r.itemId === item.id && r.status === 'active').reduce((a, r) => a + r.quantity, 0);
  }
  const backorder = ctx.reservations.filter((r) => r.itemId === item.id && r.status === 'backorder').reduce((a, r) => a + r.quantity, 0);
  let onOrder = 0;
  let planned = 0;
  for (const po of ctx.purchaseOrders) {
    for (const l of po.lines) {
      if (l.itemId !== item.id) continue;
      const remaining = Math.max(0, l.quantity - l.receivedQuantity);
      if (OPEN_PO.has(po.status)) onOrder += remaining;
      else if (PLANNED_PO.has(po.status)) planned += remaining;
    }
  }
  const available = onHand - reserved;
  const projected = available - backorder + onOrder;
  const shortage = item.active && projected < item.minStock;
  // 発注準備中の数量も見込みに含めて、二重に推奨しない
  const afterPlanned = projected + planned;
  const recommendedQty = item.active && afterPlanned < item.minStock ? Math.max(1, item.targetStock - afterPlanned) : 0;
  return { itemId: item.id, onHand, reserved, available, backorder, onOrder, planned, projected, inUse, byLocation, shortage, recommendedQty };
}

export function computeAllStock(items: Item[], ctx: StockContext): Map<string, StockStatus> {
  return new Map(items.map((i) => [i.id, computeStockStatus(i, ctx)]));
}

/** 発注候補の判定理由 (画面表示用) */
export function shortageReasons(item: Item, s: StockStatus): string[] {
  const r = [`見込み在庫 ${s.projected}${item.unit} が最低在庫数 ${item.minStock}${item.unit} を下回っています`];
  r.push(`内訳：実在庫 ${s.onHand} − 予約 ${s.reserved} − 入荷待ち需要 ${s.backorder} + 発注残 ${s.onOrder}`);
  if (s.planned) r.push(`作成中の発注書 ${s.planned}${item.unit} を差し引き済み`);
  r.push(`適正在庫数 ${item.targetStock}${item.unit} まで補充する数量を推奨`);
  return r;
}

export interface ItemInput {
  code: string;
  name: string;
  category: Item['category'];
  maker: string;
  model: string;
  unit: string;
  tracking: Item['tracking'];
  minStock: number;
  targetStock: number;
  unitPrice: number;
  defaultLocationId: string | null;
  defaultSupplierId: string | null;
  notes: string;
}

export function validateItem(input: ItemInput, ctx: { existing: Pick<Item, 'id' | 'code'>[]; selfId?: string }): Record<string, string> {
  const e: Record<string, string> = {};
  const code = input.code.trim().toUpperCase();
  if (!code) e.code = '品目IDを入力してください';
  else if (!/^[A-Z0-9-]{1,20}$/.test(code)) e.code = '品目IDは半角英数字とハイフン（20文字以内）で入力してください';
  else if (ctx.existing.some((x) => x.id !== ctx.selfId && x.code.toUpperCase() === code)) e.code = `品目ID「${code}」は既に使われています`;
  if (!input.name.trim()) e.name = '名称を入力してください';
  if (!input.unit.trim()) e.unit = '管理単位を入力してください';
  for (const k of ['minStock', 'targetStock', 'unitPrice'] as const) {
    if (!Number.isFinite(input[k]) || input[k] < 0 || !Number.isInteger(input[k])) e[k] = '0以上の整数で入力してください';
  }
  if (!e.minStock && !e.targetStock && input.targetStock < input.minStock) e.targetStock = '適正在庫数は最低在庫数以上にしてください';
  return e;
}

/** 数量入力の検証 (正の整数・上限) */
export function validateQuantity(q: number, max?: number): string | null {
  if (!Number.isInteger(q) || q <= 0) return '数量は1以上の整数で入力してください';
  if (q > 100000) return '数量が大きすぎます';
  if (max !== undefined && q > max) return `数量が上限（${max}）を超えています`;
  return null;
}

/** 参考在庫額 = 参考単価 × 実在庫。会計上の在庫評価額ではない */
export function referenceStockValue(item: Item, s: StockStatus): number {
  return item.unitPrice * s.onHand;
}
