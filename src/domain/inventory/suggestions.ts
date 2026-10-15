/**
 * 発注候補の同期 (純粋関数)。
 * - 1品目につき「候補」状態の発注候補は最大1件 (二重発注候補の防止)
 * - 不足が続いていれば数量・理由を最新化、不足が解消したら「在庫回復」で閉じる
 * - 発注書を作成済み (発注準備中の数量) の分は見込みに含めるため、重ねて候補を作らない
 */
import { generateId } from '../id';
import { shortageReasons, type StockStatus } from './stock';
import type { Item, PurchaseSuggestion } from './types';

export interface SuggestionSyncPlan {
  create: PurchaseSuggestion[];
  update: PurchaseSuggestion[];
  resolve: PurchaseSuggestion[];
}

export function planSuggestionSync(items: Item[], stock: Map<string, StockStatus>, suggestions: PurchaseSuggestion[], now: string): SuggestionSyncPlan {
  const plan: SuggestionSyncPlan = { create: [], update: [], resolve: [] };
  const openByItem = new Map<string, PurchaseSuggestion>();
  for (const s of suggestions) if (s.status === 'open') openByItem.set(s.itemId, s);
  for (const item of items) {
    const st = stock.get(item.id);
    const open = openByItem.get(item.id);
    if (!st) continue;
    if (st.recommendedQty > 0) {
      const reasons = shortageReasons(item, st);
      if (!open) plan.create.push({ id: generateId('sug'), itemId: item.id, quantity: st.recommendedQty, reasons, status: 'open', purchaseOrderId: null, createdAt: now, updatedAt: now });
      else if (open.quantity !== st.recommendedQty || open.reasons.join() !== reasons.join()) plan.update.push({ ...open, quantity: st.recommendedQty, reasons, updatedAt: now });
    } else if (open) {
      plan.resolve.push({ ...open, status: 'resolved', updatedAt: now, reasons: [...open.reasons, '見込み在庫が最低在庫数以上に回復したため自動で閉じました'] });
    }
  }
  return plan;
}
