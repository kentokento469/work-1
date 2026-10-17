/**
 * 在庫・IT資産・購買・自動化のアプリケーションサービス。
 *
 * 整合性のルール (すべて1トランザクション内で検証・更新する)
 * - 数量の変更は必ず入出庫台帳 (stockMovements) を追記し、保管場所別在庫 (stockLevels) と同時に更新する
 * - 出庫は「保管場所の在庫」と「利用可能数 (予約分を除く)」の両方を超えられない → マイナス在庫・予約分の横取りを防ぐ
 * - 資産の貸出は status が未使用 (または同じ社員に予約済み) の時だけ → 同一機器の重複貸出を防ぐ
 * - 入荷は承認済み発注の未入荷数量まで → 入荷未完了の数量を在庫に加算しない
 * - 発注候補は在庫変更と同じトランザクションで同期し、1品目1件まで → 二重発注候補を防ぐ
 * - 画面操作には requestId を付け、同じ操作の再送 (連打・再読み込み・通信再試行) は2回目以降を無視する
 * - 履歴のある品目・資産・発注は物理削除せず、無効化・廃棄・取消で管理する
 */
import type { WorkCoreDB } from '../data/db';
import { DATA_STORES } from '../data/db';
import { addDays, today as todayISO } from '../domain/date';
import { generateId, nowISO } from '../domain/id';
import { computeAllStock, computeStockStatus, validateItem, validateQuantity, type ItemInput } from '../domain/inventory/stock';
import { planSuggestionSync } from '../domain/inventory/suggestions';
import { ASSET_STATUS_LABEL, PO_STATUS_LABEL, type Asset, type AssetEvent, type AssetStatus, type EquipmentRule, type Item, type PurchaseOrder, type Reservation, type StockMovement, type Supplier } from '../domain/inventory/types';
import type { DataSnapshot, Task } from '../domain/types';
import { ALL_AUTOMATIONS } from '../automation/registry';
import { type AutomationAction } from '../automation/engine';
import { createInventoryDemo } from '../demo/inventoryDemo';
import { createDefaultEquipmentRules, createDefaultItems } from '../domain/inventory/defaults';
import { AppError, abortWith, appendInquiryEvent, inquiryEvent, logActivity, storageErrorMessage, type WriteTx } from './common';

/** 二重処理を検知した場合は duplicated: true (何も変更していない) */
export type OpResult<T = null> = { duplicated: true; value?: undefined } | { duplicated: false; value: T };

const ALL = [...DATA_STORES, 'meta'] as const;

export interface AssetInput {
  itemId: string | null;
  name: string;
  category: Asset['category'];
  maker: string;
  model: string;
  serialNumber: string;
  purchaseDate: string | null;
  purchaseCost: number | null;
  warrantyUntil: string | null;
  locationId: string | null;
  notes: string;
}

/** 状態遷移のルール (手動変更)。使用中→廃棄 などは返却を経由させる */
const MANUAL_TRANSITIONS: Record<AssetStatus, AssetStatus[]> = {
  unused: ['repair', 'broken', 'disposal_planned'],
  reserved: [],
  in_use: ['repair', 'broken'],
  repair: ['unused', 'broken', 'disposal_planned'],
  broken: ['repair', 'disposal_planned'],
  disposal_planned: ['disposed', 'unused'],
  disposed: [],
};

export class InventoryService {
  constructor(private readonly db: WorkCoreDB, private readonly clock: () => string = todayISO) {}

  // =============== 共通 ===============

  /** 同じ requestId の操作が処理済みか (二重処理防止) */
  private async seen(tx: WriteTx, requestId: string | undefined): Promise<boolean> {
    return !!requestId && !!(await tx.objectStore('meta').get(`req:${requestId}`));
  }
  private async remember(tx: WriteTx, requestId: string | undefined) {
    if (requestId) await tx.objectStore('meta').put({ key: `req:${requestId}`, value: nowISO() });
  }

  private async items(tx: WriteTx) {
    return tx.objectStore('items').getAll();
  }

  private async stockContext(tx: WriteTx) {
    const [stockLevels, reservations, assets, purchaseOrders] = await Promise.all([
      tx.objectStore('stockLevels').getAll(),
      tx.objectStore('reservations').getAll(),
      tx.objectStore('assets').getAll(),
      tx.objectStore('purchaseOrders').getAll(),
    ]);
    return { stockLevels, reservations, assets, purchaseOrders };
  }

  private async itemStatus(tx: WriteTx, item: Item) {
    return computeStockStatus(item, await this.stockContext(tx));
  }

  /**
   * 発注候補の同期 (自動化「在庫不足：発注候補の自動作成」)。在庫を変える処理の最後に同じトランザクションで呼ぶ。
   * 作成した候補は自動化の処理履歴にも記録する。
   */
  private async syncSuggestions(tx: WriteTx) {
    const items = await this.items(tx);
    const ctx = await this.stockContext(tx);
    const suggestions = await tx.objectStore('purchaseSuggestions').getAll();
    const plan = planSuggestionSync(items.filter((i) => i.active), computeAllStock(items, ctx), suggestions, nowISO());
    // 「見送り」にした品目は、不足が解消するまで候補を作り直さない
    const dismissed = new Set(suggestions.filter((s) => s.status === 'dismissed').map((s) => s.itemId));
    const store = tx.objectStore('purchaseSuggestions');
    for (const s of plan.create) {
      if (dismissed.has(s.itemId)) continue;
      await store.put(s);
      const item = items.find((i) => i.id === s.itemId);
      await tx.objectStore('automationRuns').put({
        id: generateId('run'),
        automationId: 'low-stock-reorder',
        key: s.id,
        status: 'auto',
        title: `発注候補を自動作成：${item?.name ?? ''} ${s.quantity}${item?.unit ?? ''}`,
        results: s.reasons,
        error: null,
        at: s.createdAt,
      });
    }
    for (const s of plan.update) await store.put(s);
    for (const s of plan.resolve) await store.put(s);
    // 不足が解消した品目の「見送り」も閉じる (次に不足したら再び候補にする)
    const stillShort = new Set([...plan.create, ...plan.update].map((s) => s.itemId));
    const openItems = new Set(suggestions.filter((s) => s.status === 'open').map((s) => s.itemId));
    const stock = computeAllStock(items, ctx);
    for (const s of suggestions.filter((x) => x.status === 'dismissed')) {
      if (!stillShort.has(s.itemId) && !openItems.has(s.itemId) && (stock.get(s.itemId)?.recommendedQty ?? 0) === 0) await store.put({ ...s, status: 'resolved', updatedAt: nowISO() });
    }
  }

  /** 保管場所別在庫の増減 + 台帳の追記。マイナスにならないことを検証する */
  private async applyMovement(
    tx: WriteTx,
    item: Item,
    m: Omit<StockMovement, 'id' | 'at' | 'balanceAfter' | 'itemId'>,
  ): Promise<StockMovement> {
    const levels = tx.objectStore('stockLevels');
    const change = async (locationId: string, delta: number) => {
      const id = `${item.id}@${locationId}`;
      const cur = (await levels.get(id)) ?? { id, itemId: item.id, locationId, quantity: 0 };
      const next = cur.quantity + delta;
      if (next < 0) throw new AppError(`在庫が不足しています（${item.name}：この保管場所の在庫 ${cur.quantity}${item.unit}）`);
      await levels.put({ ...cur, quantity: next });
    };
    if (m.type === 'transfer') {
      await change(m.locationId, -m.quantity);
      await change(m.toLocationId!, m.quantity);
    } else await change(m.locationId, m.delta);
    const all = await levels.index('byItem').getAll(item.id);
    const movement: StockMovement = { ...m, id: generateId('mov'), itemId: item.id, at: nowISO(), balanceAfter: all.reduce((a, l) => a + l.quantity, 0) };
    await tx.objectStore('stockMovements').add(movement);
    return movement;
  }

  private async getItem(tx: WriteTx, itemId: string): Promise<Item> {
    const item = await tx.objectStore('items').get(itemId);
    if (!item) throw new AppError('品目が見つかりません');
    return item;
  }

  /** トランザクション内の処理を実行し、業務エラーなら取り消して投げ直す */
  private async run<T>(stores: readonly string[], fn: (tx: WriteTx) => Promise<T>): Promise<T> {
    const tx = this.db.transaction(stores as never, 'readwrite') as unknown as WriteTx;
    try {
      const r = await fn(tx);
      await tx.done;
      return r;
    } catch (e) {
      return abortWith(tx, e instanceof AppError ? e : new AppError(storageErrorMessage(e)));
    }
  }

  // =============== 品目マスタ ===============

  async saveItem(input: ItemInput, id?: string): Promise<Item> {
    return this.run(ALL, async (tx) => {
      const all = await this.items(tx);
      const e = validateItem(input, { existing: all, selfId: id });
      if (Object.keys(e).length) throw new AppError(Object.values(e)[0]!, e);
      const now = nowISO();
      const current = id ? all.find((i) => i.id === id) : undefined;
      if (id && !current) throw new AppError('品目が見つかりません');
      if (current && current.tracking !== input.tracking) {
        const used = (await tx.objectStore('stockMovements').index('byItem').count(id)) + (await tx.objectStore('assets').index('byItem').count(id));
        if (used) throw new AppError('入出庫・資産の履歴がある品目は管理方法（数量／個体）を変更できません', { tracking: '変更できません' });
      }
      const item: Item = {
        ...(current ?? { id: generateId('item'), active: true, createdAt: now }),
        ...input,
        code: input.code.trim().toUpperCase(),
        name: input.name.trim(),
        unit: input.unit.trim(),
        updatedAt: now,
      } as Item;
      await tx.objectStore('items').put(item);
      await this.syncSuggestions(tx);
      await logActivity(tx, 'inventory', id ? 'update' : 'create', `品目「${item.name}」(${item.code}) を${id ? '更新' : '登録'}しました`, item.id);
      return item;
    });
  }

  /** 履歴がなければ削除、あれば無効化 (履歴を消さない) */
  async removeItem(id: string): Promise<'deleted' | 'deactivated'> {
    return this.run(ALL, async (tx) => {
      const item = await this.getItem(tx, id);
      const [mv, as, rs, pos, rules] = await Promise.all([
        tx.objectStore('stockMovements').index('byItem').count(id),
        tx.objectStore('assets').index('byItem').count(id),
        tx.objectStore('reservations').index('byItem').count(id),
        tx.objectStore('purchaseOrders').getAll(),
        tx.objectStore('equipmentRules').getAll(),
      ]);
      const used = mv + as + rs + pos.filter((p) => p.lines.some((l) => l.itemId === id)).length;
      const st = await this.itemStatus(tx, item);
      if (st.onHand > 0) throw new AppError(`在庫が ${st.onHand}${item.unit} 残っているため削除・無効化できません。出庫または在庫調整で0にしてください`);
      if (used > 0 || rules.some((r) => r.itemId === id)) {
        await tx.objectStore('items').put({ ...item, active: false, updatedAt: nowISO() });
        for (const r of rules.filter((x) => x.itemId === id)) await tx.objectStore('equipmentRules').put({ ...r, enabled: false });
        await this.syncSuggestions(tx);
        await logActivity(tx, 'inventory', 'deactivate', `品目「${item.name}」を無効化しました（履歴は保持）`, id);
        return 'deactivated';
      }
      await tx.objectStore('items').delete(id);
      // 削除した品目を指す発注候補・書類の明細の品目を残さない
      for (const sg of await tx.objectStore('purchaseSuggestions').index('byItem').getAll(id)) await tx.objectStore('purchaseSuggestions').delete(sg.id);
      for (const d of await tx.objectStore('documents').getAll())
        if (d.lines.some((l) => l.itemId === id)) await tx.objectStore('documents').put({ ...d, lines: d.lines.map((l) => (l.itemId === id ? { ...l, itemId: null } : l)) });
      await logActivity(tx, 'inventory', 'delete', `品目「${item.name}」を削除しました（履歴なし）`, id);
      return 'deleted';
    });
  }

  async setItemActive(id: string, active: boolean): Promise<void> {
    await this.run(ALL, async (tx) => {
      const item = await this.getItem(tx, id);
      await tx.objectStore('items').put({ ...item, active, updatedAt: nowISO() });
      await this.syncSuggestions(tx);
      await logActivity(tx, 'inventory', active ? 'activate' : 'deactivate', `品目「${item.name}」を${active ? '有効' : '無効'}にしました`, id);
    });
  }

  // =============== 入出庫 ===============

  async receive(p: { itemId: string; quantity: number; locationId: string; reason: string; requestId?: string }): Promise<OpResult<StockMovement>> {
    return this.run(ALL, async (tx) => {
      if (await this.seen(tx, p.requestId)) return { duplicated: true } as const;
      const item = await this.getItem(tx, p.itemId);
      if (item.tracking === 'asset') throw new AppError('個体管理の品目は「資産を登録」または発注の入荷登録で追加してください');
      const qe = validateQuantity(p.quantity);
      if (qe) throw new AppError(qe, { quantity: qe });
      const m = await this.applyMovement(tx, item, { type: 'receive', delta: p.quantity, quantity: p.quantity, locationId: p.locationId, toLocationId: null, reason: p.reason || '入庫', refType: 'manual', refId: null, employeeId: null });
      await this.allocateBackorders(tx, item);
      await this.syncSuggestions(tx);
      await this.remember(tx, p.requestId);
      await logActivity(tx, 'inventory', 'receive', `${item.name} を ${p.quantity}${item.unit} 入庫しました（在庫 ${m.balanceAfter}）`, item.id);
      return { duplicated: false, value: m } as const;
    });
  }

  /** 出庫。予約済みの数量は出庫できない (予約の引き渡しは fulfillReservation を使う) */
  async issue(p: { itemId: string; quantity: number; locationId: string; reason: string; employeeId?: string | null; requestId?: string }): Promise<OpResult<StockMovement>> {
    return this.run(ALL, async (tx) => {
      if (await this.seen(tx, p.requestId)) return { duplicated: true } as const;
      const item = await this.getItem(tx, p.itemId);
      if (item.tracking === 'asset') throw new AppError('個体管理の品目は資産台帳から「貸出」してください');
      const st = await this.itemStatus(tx, item);
      const qe = validateQuantity(p.quantity, Math.max(0, st.available));
      if (qe) throw new AppError(st.available < p.quantity ? `利用可能数（${st.available}${item.unit}）を超えています。予約分 ${st.reserved}${item.unit} は出庫できません` : qe, { quantity: qe });
      const m = await this.applyMovement(tx, item, { type: 'issue', delta: -p.quantity, quantity: p.quantity, locationId: p.locationId, toLocationId: null, reason: p.reason || '出庫', refType: p.employeeId ? 'employee' : 'manual', refId: p.employeeId ?? null, employeeId: p.employeeId ?? null });
      await this.syncSuggestions(tx);
      await this.remember(tx, p.requestId);
      await logActivity(tx, 'inventory', 'issue', `${item.name} を ${p.quantity}${item.unit} 出庫しました（在庫 ${m.balanceAfter}）`, item.id);
      return { duplicated: false, value: m } as const;
    });
  }

  async transfer(p: { itemId: string; quantity: number; fromLocationId: string; toLocationId: string; requestId?: string }): Promise<OpResult<StockMovement>> {
    return this.run(ALL, async (tx) => {
      if (await this.seen(tx, p.requestId)) return { duplicated: true } as const;
      const item = await this.getItem(tx, p.itemId);
      if (p.fromLocationId === p.toLocationId) throw new AppError('移動元と移動先が同じです');
      const qe = validateQuantity(p.quantity);
      if (qe) throw new AppError(qe);
      const m = await this.applyMovement(tx, item, { type: 'transfer', delta: 0, quantity: p.quantity, locationId: p.fromLocationId, toLocationId: p.toLocationId, reason: '保管場所の移動', refType: 'manual', refId: null, employeeId: null });
      await this.remember(tx, p.requestId);
      await logActivity(tx, 'inventory', 'transfer', `${item.name} を ${p.quantity}${item.unit} 移動しました`, item.id);
      return { duplicated: false, value: m } as const;
    });
  }

  /** 在庫調整: 実際に数えた数量を入力し、差分を台帳に記録する (理由必須) */
  async adjust(p: { itemId: string; locationId: string; actualQuantity: number; reason: string; requestId?: string }): Promise<OpResult<StockMovement | null>> {
    return this.run(ALL, async (tx) => {
      if (await this.seen(tx, p.requestId)) return { duplicated: true } as const;
      const item = await this.getItem(tx, p.itemId);
      if (!p.reason.trim()) throw new AppError('調整理由を入力してください', { reason: '理由は必須です' });
      if (!Number.isInteger(p.actualQuantity) || p.actualQuantity < 0) throw new AppError('実数量は0以上の整数で入力してください');
      const lv = await tx.objectStore('stockLevels').get(`${item.id}@${p.locationId}`);
      const delta = p.actualQuantity - (lv?.quantity ?? 0);
      if (delta === 0) return { duplicated: false, value: null } as const;
      const m = await this.applyMovement(tx, item, { type: 'adjust', delta, quantity: Math.abs(delta), locationId: p.locationId, toLocationId: null, reason: p.reason.trim(), refType: 'manual', refId: null, employeeId: null });
      await this.syncSuggestions(tx);
      await this.remember(tx, p.requestId);
      await logActivity(tx, 'inventory', 'adjust', `${item.name} を在庫調整しました（${delta > 0 ? '+' : ''}${delta}、理由：${p.reason.trim()}）`, item.id);
      return { duplicated: false, value: m } as const;
    });
  }

  /**
   * 入出庫の取り消し。履歴は消さず、逆向きの記録 (refType: reversal) を追加する (赤黒訂正と同じ考え方)。
   * 取り消しは1回だけ。取り消すと在庫がマイナスになる・予約分を割り込む場合は拒否する。
   */
  async reverseMovement(movementId: string): Promise<StockMovement> {
    return this.run(ALL, async (tx) => {
      const store = tx.objectStore('stockMovements');
      const orig = await store.get(movementId);
      if (!orig) throw new AppError('取り消す入出庫履歴が見つかりません');
      if (orig.refType === 'reversal') throw new AppError('取り消しの記録は取り消せません');
      if (orig.refType === 'purchase_order' || orig.refType === 'reservation' || orig.refType === 'document' || orig.type === 'stocktake') throw new AppError('発注の入荷・予約の引き渡し・書類からの入庫・棚卸は、取り消しではなく在庫調整で訂正してください');
      const all = await store.index('byItem').getAll(orig.itemId);
      if (all.some((m) => m.refType === 'reversal' && m.refId === orig.id)) throw new AppError('この入出庫は既に取り消されています');
      const item = await this.getItem(tx, orig.itemId);
      const label = { receive: '入庫', issue: '出庫', transfer: '移動', adjust: '在庫調整', stocktake: '棚卸' }[orig.type];
      const base = { quantity: orig.quantity, reason: `取り消し：${label}（${orig.reason}）`, refType: 'reversal' as const, refId: orig.id, employeeId: orig.employeeId };
      const m =
        orig.type === 'transfer'
          ? await this.applyMovement(tx, item, { ...base, type: 'transfer', delta: 0, locationId: orig.toLocationId!, toLocationId: orig.locationId })
          : await this.applyMovement(tx, item, { ...base, type: 'adjust', delta: -orig.delta, quantity: Math.abs(orig.delta), locationId: orig.locationId, toLocationId: null });
      const st = await this.itemStatus(tx, item);
      if (st.available < 0) throw new AppError(`取り消すと利用可能数がマイナスになります（予約 ${st.reserved}${item.unit}）。先に予約を見直してください`);
      if (orig.delta < 0) await this.allocateBackorders(tx, item);
      await this.syncSuggestions(tx);
      await logActivity(tx, 'inventory', 'reverse', `${item.name} の${label}を取り消しました（実在庫 ${m.balanceAfter}）`, item.id);
      return m;
    });
  }

  /** 棚卸: 数えた結果をまとめて反映 (差異のある行だけ台帳に記録) */
  async applyStocktake(counts: { itemId: string; locationId: string; counted: number }[], requestId?: string): Promise<OpResult<number>> {
    return this.run(ALL, async (tx) => {
      if (await this.seen(tx, requestId)) return { duplicated: true } as const;
      let n = 0;
      const stamp = `棚卸 ${this.clock()}`;
      for (const c of counts) {
        if (!Number.isInteger(c.counted) || c.counted < 0) throw new AppError('数えた数量は0以上の整数で入力してください');
        const item = await this.getItem(tx, c.itemId);
        if (item.tracking !== 'quantity') continue;
        const lv = await tx.objectStore('stockLevels').get(`${item.id}@${c.locationId}`);
        const delta = c.counted - (lv?.quantity ?? 0);
        if (delta === 0) continue;
        await this.applyMovement(tx, item, { type: 'stocktake', delta, quantity: Math.abs(delta), locationId: c.locationId, toLocationId: null, reason: stamp, refType: 'stocktake', refId: null, employeeId: null });
        n++;
      }
      await this.syncSuggestions(tx);
      await this.remember(tx, requestId);
      await logActivity(tx, 'inventory', 'stocktake', `棚卸を確定しました（${counts.length}行を確認、差異 ${n}件を反映）`);
      return { duplicated: false, value: n } as const;
    });
  }

  // =============== 予約 ===============

  /** 入荷した数量を、入荷待ちの予約 (古い順) に引き当てる */
  private async allocateBackorders(tx: WriteTx, item: Item, newAssets: Asset[] = []) {
    const store = tx.objectStore('reservations');
    const backorders = (await store.index('byItem').getAll(item.id)).filter((r) => r.status === 'backorder').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const now = nowISO();
    if (item.tracking === 'asset') {
      const free = [...newAssets];
      for (const r of backorders) {
        let rest = r.quantity;
        while (rest > 0 && free.length) {
          const a = free.shift()!;
          const emp = r.employeeId ? await tx.objectStore('employees').get(r.employeeId) : undefined;
          await this.changeAsset(tx, a, { status: 'reserved', assigneeId: r.employeeId, assigneeName: emp?.name ?? '', departmentId: emp?.departmentId ?? null }, 'reserve', `入荷により予約に引当（${r.purpose}）`, r.inquiryId);
          rest--;
        }
        if (rest === r.quantity) break;
        await store.put({ ...r, quantity: rest || r.quantity, status: rest ? 'backorder' : 'fulfilled', updatedAt: now, purpose: rest ? r.purpose : `${r.purpose}（入荷した資産を予約に引当済み）` });
      }
      return;
    }
    let available = (await this.itemStatus(tx, item)).available;
    for (const r of backorders) {
      if (available <= 0) break;
      const q = Math.min(available, r.quantity);
      if (q === r.quantity) await store.put({ ...r, status: 'active', updatedAt: now });
      else {
        await store.put({ ...r, quantity: r.quantity - q, updatedAt: now });
        await store.add({ ...r, id: generateId('rsv'), quantity: q, status: 'active', createdAt: now, updatedAt: now });
      }
      available -= q;
    }
  }

  /** 予約の引き渡し (出庫して予約を完了にする) */
  async fulfillReservation(reservationId: string, locationId: string, requestId?: string): Promise<OpResult> {
    return this.run(ALL, async (tx) => {
      if (await this.seen(tx, requestId)) return { duplicated: true } as const;
      const r = await tx.objectStore('reservations').get(reservationId);
      if (!r) throw new AppError('予約が見つかりません');
      if (r.status !== 'active') throw new AppError(r.status === 'backorder' ? '入荷待ちの予約はまだ引き渡せません' : 'この予約は処理済みです');
      const item = await this.getItem(tx, r.itemId);
      await this.applyMovement(tx, item, { type: 'issue', delta: -r.quantity, quantity: r.quantity, locationId, toLocationId: null, reason: `予約の引き渡し（${r.purpose}）`, refType: 'reservation', refId: r.id, employeeId: r.employeeId });
      await tx.objectStore('reservations').put({ ...r, status: 'fulfilled', updatedAt: nowISO() });
      await this.syncSuggestions(tx);
      await this.remember(tx, requestId);
      await logActivity(tx, 'inventory', 'fulfill', `${item.name} ${r.quantity}${item.unit} を引き渡しました（${r.purpose}）`, item.id);
      return { duplicated: false, value: null } as const;
    });
  }

  async releaseReservation(reservationId: string): Promise<Reservation> {
    return this.run(ALL, async (tx) => {
      const r = await tx.objectStore('reservations').get(reservationId);
      if (!r) throw new AppError('予約が見つかりません');
      if (r.status !== 'active' && r.status !== 'backorder') throw new AppError('この予約は処理済みです');
      await tx.objectStore('reservations').put({ ...r, status: 'released', updatedAt: nowISO() });
      await this.syncSuggestions(tx);
      await logActivity(tx, 'inventory', 'release', `予約（${r.purpose}）を解除しました`, r.itemId);
      return r;
    });
  }

  /** 予約解除の取り消し (Undo) */
  async restoreReservation(r: Reservation): Promise<void> {
    await this.run(ALL, async (tx) => {
      const cur = await tx.objectStore('reservations').get(r.id);
      if (!cur || cur.status !== 'released') throw new AppError('元に戻せません');
      if (r.status === 'active') {
        const item = await this.getItem(tx, r.itemId);
        if ((await this.itemStatus(tx, item)).available < r.quantity) throw new AppError('利用可能な在庫が足りないため元に戻せません');
      }
      await tx.objectStore('reservations').put({ ...r, updatedAt: nowISO() });
      await this.syncSuggestions(tx);
    });
  }

  // =============== IT資産 ===============

  private async nextAssetNumber(tx: WriteTx): Promise<string> {
    const all = await tx.objectStore('assets').getAll();
    const max = all.reduce((m, a) => Math.max(m, Number(/^AST-(\d+)$/.exec(a.assetNumber)?.[1] ?? 0)), 0);
    return `AST-${String(max + 1).padStart(4, '0')}`;
  }

  private async addEvent(tx: WriteTx, e: Omit<AssetEvent, 'id' | 'at'>) {
    await tx.objectStore('assetEvents').add({ ...e, id: generateId('aev'), at: nowISO() });
  }

  /** 資産の状態を変え、履歴を必ず残す */
  private async changeAsset(tx: WriteTx, a: Asset, patch: Partial<Asset>, type: AssetEvent['type'], note: string, inquiryId: string | null = null) {
    const next: Asset = { ...a, ...patch, updatedAt: nowISO() };
    await tx.objectStore('assets').put(next);
    await this.addEvent(tx, {
      assetId: a.id,
      type,
      fromStatus: a.status,
      toStatus: next.status,
      employeeId: next.assigneeId ?? a.assigneeId,
      employeeName: next.assigneeName || a.assigneeName,
      inquiryId,
      note,
    });
    return next;
  }

  private validateAsset(input: AssetInput): void {
    const e: Record<string, string> = {};
    if (!input.name.trim()) e.name = '機器名を入力してください';
    if (input.purchaseCost !== null && (!Number.isFinite(input.purchaseCost) || input.purchaseCost < 0)) e.purchaseCost = '購入金額は0以上で入力してください';
    if (input.purchaseDate && input.warrantyUntil && input.warrantyUntil < input.purchaseDate) e.warrantyUntil = '保証期限は購入日以降にしてください';
    if (Object.keys(e).length) throw new AppError(Object.values(e)[0]!, e);
  }

  async registerAsset(input: AssetInput, requestId?: string): Promise<OpResult<Asset>> {
    return this.run(ALL, async (tx) => {
      if (await this.seen(tx, requestId)) return { duplicated: true } as const;
      this.validateAsset(input);
      const all = await tx.objectStore('assets').getAll();
      const serial = input.serialNumber.trim();
      if (serial && all.some((a) => a.serialNumber.toUpperCase() === serial.toUpperCase())) throw new AppError(`シリアル番号「${serial}」は登録済みです`, { serialNumber: '重複しています' });
      const now = nowISO();
      const asset: Asset = { ...input, serialNumber: serial, name: input.name.trim(), id: generateId('ast'), assetNumber: await this.nextAssetNumber(tx), status: 'unused', assigneeId: null, assigneeName: '', departmentId: null, purchaseOrderId: null, createdAt: now, updatedAt: now };
      await tx.objectStore('assets').add(asset);
      await this.addEvent(tx, { assetId: asset.id, type: 'register', fromStatus: null, toStatus: 'unused', employeeId: null, employeeName: '', inquiryId: null, note: '資産台帳に登録' });
      await this.allocateBackordersForAsset(tx, asset);
      await this.syncSuggestions(tx);
      await this.remember(tx, requestId);
      await logActivity(tx, 'asset', 'register', `資産 ${asset.assetNumber}「${asset.name}」を登録しました`, asset.id);
      return { duplicated: false, value: asset } as const;
    });
  }

  private async allocateBackordersForAsset(tx: WriteTx, asset: Asset) {
    if (!asset.itemId) return;
    const item = await tx.objectStore('items').get(asset.itemId);
    if (item?.tracking === 'asset') await this.allocateBackorders(tx, item, [asset]);
  }

  async updateAsset(id: string, input: AssetInput): Promise<Asset> {
    return this.run(ALL, async (tx) => {
      const a = await tx.objectStore('assets').get(id);
      if (!a) throw new AppError('資産が見つかりません');
      this.validateAsset(input);
      const serial = input.serialNumber.trim();
      const all = await tx.objectStore('assets').getAll();
      if (serial && all.some((x) => x.id !== id && x.serialNumber.toUpperCase() === serial.toUpperCase())) throw new AppError(`シリアル番号「${serial}」は登録済みです`, { serialNumber: '重複しています' });
      const next = await this.changeAsset(tx, a, { ...input, serialNumber: serial, name: input.name.trim() }, 'edit', '台帳の内容を編集');
      await this.syncSuggestions(tx);
      return next;
    });
  }

  /** 貸出 (引き渡し)。同じ機器を複数人に同時に割り当てない */
  async assignAsset(assetId: string, employeeId: string, opts: { requestId?: string; inquiryId?: string | null; loan?: boolean } = {}): Promise<OpResult<Asset>> {
    return this.run(ALL, async (tx) => {
      if (await this.seen(tx, opts.requestId)) return { duplicated: true } as const;
      const next = await this.assignInTx(tx, assetId, employeeId, opts.inquiryId ?? null, !!opts.loan);
      await this.syncSuggestions(tx);
      await this.remember(tx, opts.requestId);
      return { duplicated: false, value: next } as const;
    });
  }

  private async assignInTx(tx: WriteTx, assetId: string, employeeId: string, inquiryId: string | null, loan: boolean): Promise<Asset> {
    const a = await tx.objectStore('assets').get(assetId);
    if (!a) throw new AppError('資産が見つかりません');
    const emp = await tx.objectStore('employees').get(employeeId);
    if (!emp) throw new AppError('社員が見つかりません');
    if (emp.status === 'retired') throw new AppError('退職者には貸し出せません');
    if (a.status === 'reserved' && a.assigneeId !== employeeId) throw new AppError(`${a.assetNumber} は ${a.assigneeName}さんに予約済みです`);
    if (a.status !== 'unused' && a.status !== 'reserved') throw new AppError(`${a.assetNumber} は「${ASSET_STATUS_LABEL[a.status]}」のため貸し出せません`);
    const next = await this.changeAsset(tx, a, { status: 'in_use', assigneeId: emp.id, assigneeName: emp.name, departmentId: emp.departmentId, locationId: null }, loan ? 'loan' : 'assign', loan ? '代替機として貸出' : '貸出（引き渡し）', inquiryId);
    await logActivity(tx, 'asset', 'assign', `資産 ${a.assetNumber} を ${emp.name}さんに${loan ? '代替機として' : ''}貸し出しました`, a.id);
    if (inquiryId) await appendInquiryEvent(tx, inquiryId, inquiryEvent('task', `代替機 ${a.assetNumber}（${a.name}）を貸出`));
    return next;
  }

  /** 予約 (入社前の確保) */
  private async reserveInTx(tx: WriteTx, assetId: string, employeeId: string): Promise<Asset> {
    const a = await tx.objectStore('assets').get(assetId);
    if (!a) throw new AppError('資産が見つかりません');
    if (a.status !== 'unused') throw new AppError(`${a.assetNumber} は「${ASSET_STATUS_LABEL[a.status]}」のため予約できません`);
    const emp = await tx.objectStore('employees').get(employeeId);
    if (!emp) throw new AppError('社員が見つかりません');
    return this.changeAsset(tx, a, { status: 'reserved', assigneeId: emp.id, assigneeName: emp.name, departmentId: emp.departmentId }, 'reserve', `${emp.name}さんの入社準備として予約`);
  }

  /** 返却。状態 (正常→未使用 / 修理が必要 / 故障) を選べる */
  async returnAsset(assetId: string, condition: 'unused' | 'repair' | 'broken', note: string, requestId?: string, opts: { completeTaskIds?: string[] } = {}): Promise<OpResult<Asset>> {
    return this.run(ALL, async (tx) => {
      if (await this.seen(tx, requestId)) return { duplicated: true } as const;
      const a = await tx.objectStore('assets').get(assetId);
      if (!a) throw new AppError('資産が見つかりません');
      if (a.status !== 'in_use' && a.status !== 'reserved') throw new AppError(`${a.assetNumber} は貸出中ではありません`);
      const next = await this.changeAsset(
        tx,
        a,
        { status: condition, assigneeId: null, assigneeName: '', departmentId: null, locationId: a.locationId ?? 'loc_it' },
        a.status === 'reserved' ? 'release' : 'return',
        `${a.assigneeName}さんから${a.status === 'reserved' ? '予約解除' : '返却'}${condition !== 'unused' ? `（${ASSET_STATUS_LABEL[condition]}）` : ''}${note ? `：${note}` : ''}`,
      );
      // 返却で未使用に戻った資産は、入荷待ちの予約があれば引き当てる
      if (condition === 'unused') await this.allocateBackordersForAsset(tx, next);
      // 返却確認タスク (退職の自動化で作成) を、利用者が選んだ場合は同時に完了にする (返却と完了の二重入力をなくす。Phase 10)
      for (const tid of opts.completeTaskIds ?? []) {
        const t = await tx.objectStore('tasks').get(tid);
        if (!t || t.assetId !== a.id || t.status === 'done') continue;
        const now = nowISO();
        await tx.objectStore('tasks').put({ ...t, status: 'done', updatedAt: now, completedAt: now });
        await logActivity(tx, 'task', 'status', `タスク「${t.title}」を資産の返却とあわせて完了にしました`, t.id);
      }
      await this.syncSuggestions(tx);
      await this.remember(tx, requestId);
      await logActivity(tx, 'asset', 'return', `資産 ${a.assetNumber} が返却されました（${ASSET_STATUS_LABEL[condition]}）`, a.id);
      return { duplicated: false, value: next } as const;
    });
  }

  async setAssetStatus(assetId: string, status: AssetStatus, note: string, inquiryId: string | null = null): Promise<Asset> {
    return this.run(ALL, async (tx) => {
      const a = await tx.objectStore('assets').get(assetId);
      if (!a) throw new AppError('資産が見つかりません');
      if (!MANUAL_TRANSITIONS[a.status].includes(status))
        throw new AppError(
          a.status === 'in_use' && (status === 'disposal_planned' || status === 'disposed')
            ? '使用中の資産は先に返却してください'
            : `「${ASSET_STATUS_LABEL[a.status]}」から「${ASSET_STATUS_LABEL[status]}」には変更できません`,
        );
      const next = await this.changeAsset(tx, a, { status }, 'status', note || `${ASSET_STATUS_LABEL[a.status]} → ${ASSET_STATUS_LABEL[status]}`, inquiryId);
      if (status === 'unused') await this.allocateBackordersForAsset(tx, next);
      await this.syncSuggestions(tx);
      await logActivity(tx, 'asset', 'status', `資産 ${a.assetNumber} を「${ASSET_STATUS_LABEL[status]}」にしました`, a.id);
      return next;
    });
  }

  // =============== 購買 ===============

  private async nextPoNumber(tx: WriteTx): Promise<string> {
    const year = this.clock().slice(0, 4);
    const all = await tx.objectStore('purchaseOrders').getAll();
    const max = all.reduce((m, p) => Math.max(m, p.number.startsWith(`PO-${year}-`) ? Number(p.number.slice(8)) : 0), 0);
    return `PO-${year}-${String(max + 1).padStart(4, '0')}`;
  }

  private poEvent(po: PurchaseOrder, message: string): PurchaseOrder {
    const at = nowISO();
    return { ...po, history: [...po.history, { at, message }], updatedAt: at };
  }

  /** 発注候補 → 発注書 (下書き)。仕入先ごとにまとめる */
  async createOrdersFromSuggestions(suggestionIds: string[], requestedBy: string, requestId?: string): Promise<OpResult<PurchaseOrder[]>> {
    return this.run(ALL, async (tx) => {
      if (await this.seen(tx, requestId)) return { duplicated: true } as const;
      if (!suggestionIds.length) throw new AppError('発注候補を選択してください');
      const sugStore = tx.objectStore('purchaseSuggestions');
      const groups = new Map<string, { item: Item; qty: number; sugId: string }[]>();
      for (const id of suggestionIds) {
        const s = await sugStore.get(id);
        if (!s || s.status !== 'open') throw new AppError('処理済みの発注候補が含まれています。画面を更新してください');
        const item = await this.getItem(tx, s.itemId);
        const sup = item.defaultSupplierId ?? (await tx.objectStore('suppliers').getAll()).find((x) => x.active)?.id;
        if (!sup) throw new AppError('仕入先マスタが登録されていません');
        groups.set(sup, [...(groups.get(sup) ?? []), { item, qty: s.quantity, sugId: s.id }]);
      }
      const now = nowISO();
      const orders: PurchaseOrder[] = [];
      for (const [supplierId, lines] of groups) {
        const po: PurchaseOrder = {
          id: generateId('po'),
          number: await this.nextPoNumber(tx),
          supplierId,
          status: 'draft',
          lines: lines.map((l) => ({ id: generateId('pol'), itemId: l.item.id, quantity: l.qty, unitPrice: l.item.unitPrice, receivedQuantity: 0 })),
          expectedDate: null,
          requestedBy: requestedBy.trim(),
          approvedBy: '',
          notes: '',
          history: [{ at: now, message: `発注候補 ${lines.length}件から作成（下書き）` }],
          createdAt: now,
          updatedAt: now,
          approvedAt: null,
        };
        await tx.objectStore('purchaseOrders').add(po);
        for (const l of lines) {
          const s = (await sugStore.get(l.sugId))!;
          await sugStore.put({ ...s, status: 'ordered', purchaseOrderId: po.id, updatedAt: now });
        }
        orders.push(po);
      }
      await this.syncSuggestions(tx);
      await this.remember(tx, requestId);
      await logActivity(tx, 'purchase', 'create', `発注書（下書き）を${orders.length}件作成しました：${orders.map((o) => o.number).join('、')}`);
      return { duplicated: false, value: orders } as const;
    });
  }

  async dismissSuggestion(id: string): Promise<void> {
    await this.run(ALL, async (tx) => {
      const s = await tx.objectStore('purchaseSuggestions').get(id);
      if (!s || s.status !== 'open') throw new AppError('処理済みの発注候補です');
      await tx.objectStore('purchaseSuggestions').put({ ...s, status: 'dismissed', updatedAt: nowISO() });
      await logActivity(tx, 'purchase', 'dismiss', '発注候補を見送りました（不足が解消するまで再作成しません）', s.itemId);
    });
  }

  async updateOrderDraft(id: string, p: { lines: { id: string; quantity: number; unitPrice: number }[]; expectedDate: string | null; notes: string }): Promise<PurchaseOrder> {
    return this.run(ALL, async (tx) => {
      const po = await tx.objectStore('purchaseOrders').get(id);
      if (!po) throw new AppError('発注書が見つかりません');
      if (po.status !== 'draft') throw new AppError('下書きの発注書だけ編集できます');
      for (const l of p.lines) {
        const qe = validateQuantity(l.quantity);
        if (qe) throw new AppError(qe);
        if (!Number.isFinite(l.unitPrice) || l.unitPrice < 0) throw new AppError('単価は0以上で入力してください');
      }
      const next = this.poEvent({ ...po, lines: po.lines.map((l) => ({ ...l, ...(p.lines.find((x) => x.id === l.id) ?? {}) })), expectedDate: p.expectedDate, notes: p.notes }, '下書きを編集');
      await tx.objectStore('purchaseOrders').put(next);
      await this.syncSuggestions(tx);
      return next;
    });
  }

  /** 状態遷移: 下書き → 承認待ち → 承認済み、承認待ち → 差し戻し(下書き)、未入荷なら取消 */
  async transitionOrder(id: string, action: 'submit' | 'approve' | 'reject' | 'cancel', actor: string): Promise<PurchaseOrder> {
    return this.run(ALL, async (tx) => {
      const po = await tx.objectStore('purchaseOrders').get(id);
      if (!po) throw new AppError('発注書が見つかりません');
      const name = actor.trim();
      let next: PurchaseOrder;
      if (action === 'submit') {
        if (po.status !== 'draft') throw new AppError('下書きの発注書だけ承認申請できます');
        next = this.poEvent({ ...po, status: 'pending_approval', requestedBy: name || po.requestedBy }, `承認申請（${name || po.requestedBy || '担当者'}）`);
      } else if (action === 'approve') {
        if (po.status !== 'pending_approval') throw new AppError('承認待ちの発注書だけ承認できます');
        if (!name) throw new AppError('承認者名を入力してください', { actor: '必須です' });
        // 申請者本人による承認を防ぐ (職務の分離)。ログインがないため氏名の一致で判定する (空白の違いは無視)
        const norm = (v: string | null | undefined) => (v ?? '').replace(/[\s　]/g, '');
        if (po.requestedBy && norm(name) === norm(po.requestedBy)) throw new AppError(`申請者（${po.requestedBy}）本人は承認できません。別の担当者が承認してください`, { actor: '申請者とは別の人の名前を入力してください' });
        const sup = await tx.objectStore('suppliers').get(po.supplierId);
        next = this.poEvent({ ...po, status: 'approved', approvedBy: name, approvedAt: nowISO(), expectedDate: po.expectedDate ?? addDays(this.clock(), sup?.leadTimeDays ?? 7) }, `承認（${name}）。外部への発注はアプリ外で行います`);
      } else if (action === 'reject') {
        if (po.status !== 'pending_approval') throw new AppError('承認待ちの発注書だけ差し戻せます');
        next = this.poEvent({ ...po, status: 'draft' }, `差し戻し（${name || '承認者'}）`);
      } else {
        if (!['draft', 'pending_approval', 'approved'].includes(po.status) || po.lines.some((l) => l.receivedQuantity > 0)) throw new AppError('入荷済みの数量がある発注書は取り消せません');
        next = this.poEvent({ ...po, status: 'cancelled' }, `取消（${name || '担当者'}）`);
        // 紐づく発注候補は閉じ、必要なら同期で新しい候補が作られる
        for (const s of await tx.objectStore('purchaseSuggestions').getAll()) if (s.purchaseOrderId === po.id && s.status === 'ordered') await tx.objectStore('purchaseSuggestions').put({ ...s, status: 'resolved', updatedAt: nowISO(), reasons: [...s.reasons, `発注書 ${po.number} の取消により終了`] });
      }
      await tx.objectStore('purchaseOrders').put(next);
      await this.syncSuggestions(tx);
      await logActivity(tx, 'purchase', action, `発注書 ${po.number} を「${PO_STATUS_LABEL[next.status]}」にしました`, po.id);
      return next;
    });
  }

  /**
   * 入荷登録。承認済み発注の未入荷数量までしか登録できない。
   * 数量管理品は入庫 (台帳に記録)、個体管理品は資産を自動登録する。入荷待ちの予約に自動で引き当てる。
   */
  async receiveOrder(id: string, lines: { lineId: string; quantity: number; locationId: string }[], requestId?: string): Promise<OpResult<{ assets: Asset[]; order: PurchaseOrder }>> {
    return this.run(ALL, async (tx) => {
      if (await this.seen(tx, requestId)) return { duplicated: true } as const;
      const { created, order, msgs } = await this.receiveOrderInTx(tx, id, lines, '');
      await this.syncSuggestions(tx);
      await this.remember(tx, requestId);
      await logActivity(tx, 'purchase', 'receive', `発注書 ${order.number} の入荷を登録しました（${msgs.join('、')}）`, order.id);
      return { duplicated: false, value: { assets: created, order } } as const;
    });
  }

  /** 発注書の入荷処理 (トランザクション内)。発注書の画面と、納品書からの引き渡しの両方で使う */
  private async receiveOrderInTx(tx: WriteTx, id: string, lines: { lineId: string; quantity: number; locationId: string }[], via: string) {
    {
      const po = await tx.objectStore('purchaseOrders').get(id);
      if (!po) throw new AppError('発注書が見つかりません');
      if (po.status !== 'approved' && po.status !== 'partially_received') throw new AppError(`「${PO_STATUS_LABEL[po.status]}」の発注書は入荷登録できません（承認済みのみ）`);
      const targets = lines.filter((l) => l.quantity > 0);
      if (!targets.length) throw new AppError('入荷数量を入力してください');
      const created: Asset[] = [];
      const updatedLines = po.lines.map((l) => ({ ...l }));
      const msgs: string[] = [];
      for (const t of targets) {
        const line = updatedLines.find((l) => l.id === t.lineId);
        if (!line) throw new AppError('発注明細が見つかりません');
        const remaining = line.quantity - line.receivedQuantity;
        const qe = validateQuantity(t.quantity, remaining);
        if (qe) throw new AppError(`入荷数量が未入荷数量（${remaining}）を超えています`);
        const item = await this.getItem(tx, line.itemId);
        if (item.tracking === 'asset') {
          const newOnes: Asset[] = [];
          for (let i = 0; i < t.quantity; i++) {
            const now = nowISO();
            const a: Asset = {
              id: generateId('ast'),
              assetNumber: await this.nextAssetNumber(tx),
              itemId: item.id,
              name: item.name,
              category: item.category,
              maker: item.maker,
              model: item.model,
              serialNumber: '',
              purchaseDate: this.clock(),
              purchaseCost: line.unitPrice,
              warrantyUntil: addDays(this.clock(), 365 * 3),
              status: 'unused',
              assigneeId: null,
              assigneeName: '',
              departmentId: null,
              locationId: t.locationId,
              purchaseOrderId: po.id,
              notes: `発注 ${po.number} で入荷（シリアル番号は後で登録）`,
              createdAt: now,
              updatedAt: now,
            };
            await tx.objectStore('assets').add(a);
            await this.addEvent(tx, { assetId: a.id, type: 'register', fromStatus: null, toStatus: 'unused', employeeId: null, employeeName: '', inquiryId: null, note: `発注 ${po.number} の入荷により登録` });
            newOnes.push(a);
          }
          created.push(...newOnes);
          await this.allocateBackorders(tx, item, newOnes);
        } else {
          await this.applyMovement(tx, item, { type: 'receive', delta: t.quantity, quantity: t.quantity, locationId: t.locationId, toLocationId: null, reason: `発注 ${po.number} の入荷`, refType: 'purchase_order', refId: po.id, employeeId: null });
          line.receivedQuantity += t.quantity;
          await this.allocateBackorders(tx, item);
        }
        if (item.tracking === 'asset') line.receivedQuantity += t.quantity;
        msgs.push(`${item.name} ${t.quantity}${item.unit}`);
      }
      const done = updatedLines.every((l) => l.receivedQuantity >= l.quantity);
      const next = this.poEvent({ ...po, lines: updatedLines, status: done ? 'received' : 'partially_received' }, `入荷登録${via}：${msgs.join('、')}${done ? '（入荷完了）' : '（一部入荷）'}`);
      await tx.objectStore('purchaseOrders').put(next);
      return { created, order: next, msgs };
    }
  }

  /**
   * 納品書の明細を在庫へ引き渡す (Phase 4)。
   * - 確認済みの書類だけ。OCR の結果だけでは在庫を変えない (利用者がこの操作を実行したときだけ)
   * - 1つの書類から反映できるのは1回だけ (二重入庫の防止)。書類・在庫・発注書を同じトランザクションで更新
   * - mode 'purchase_order': 関連発注書の入荷として登録 (未入荷数まで。個体管理品は資産を自動登録)
   * - mode 'receive': 発注書なしで数量管理品を入庫
   */
  async receiveFromDocument(p: {
    documentId: string;
    mode: 'receive' | 'purchase_order';
    locationId: string;
    lines: { itemId: string; quantity: number }[];
    requestId?: string;
  }): Promise<OpResult<{ movements: StockMovement[]; assets: Asset[] }>> {
    return this.run(ALL, async (tx) => {
      if (await this.seen(tx, p.requestId)) return { duplicated: true } as const;
      const doc = await tx.objectStore('documents').get(p.documentId);
      if (!doc) throw new AppError('書類が見つかりません');
      if (doc.deletedAt) throw new AppError('ゴミ箱の書類からは反映できません');
      if (doc.status !== 'confirmed') throw new AppError('確認済みの書類だけ在庫に反映できます。先に抽出内容を確認してください');
      if (doc.inventory) throw new AppError(`この書類は既に在庫へ反映済みです（${doc.inventory.at.slice(0, 10)}）`);
      const targets = p.lines.filter((l) => l.quantity > 0);
      if (!targets.length) throw new AppError('反映する品目と数量を入力してください');
      for (const t of targets) {
        const qe = validateQuantity(t.quantity);
        if (qe) throw new AppError(qe);
      }
      const before = new Set((await tx.objectStore('stockMovements').getAll()).map((m) => m.id));
      let created: Asset[] = [];
      if (p.mode === 'purchase_order') {
        if (!doc.purchaseOrderId) throw new AppError('関連発注書が設定されていません');
        const po = await tx.objectStore('purchaseOrders').get(doc.purchaseOrderId);
        if (!po) throw new AppError('関連発注書が見つかりません');
        const used = new Set<string>();
        const lines = targets.map((t) => {
          const line = po.lines.find((l) => l.itemId === t.itemId && !used.has(l.id) && l.quantity - l.receivedQuantity > 0);
          if (!line) throw new AppError('発注書にない品目、または入荷済みの品目が含まれています');
          used.add(line.id);
          return { lineId: line.id, quantity: t.quantity, locationId: p.locationId };
        });
        const r = await this.receiveOrderInTx(tx, po.id, lines, `（納品書 ${doc.number}）`);
        created = r.created;
      } else {
        for (const t of targets) {
          const item = await this.getItem(tx, t.itemId);
          if (item.tracking === 'asset') throw new AppError(`「${item.name}」は1台ずつ管理する品目のため、発注書の入荷として登録するか、資産台帳に登録してください`);
          await this.applyMovement(tx, item, { type: 'receive', delta: t.quantity, quantity: t.quantity, locationId: p.locationId, toLocationId: null, reason: `納品書 ${doc.number} による入庫`, refType: 'document', refId: doc.id, employeeId: null });
          await this.allocateBackorders(tx, item);
        }
      }
      const movements = (await tx.objectStore('stockMovements').getAll()).filter((m) => !before.has(m.id));
      const now = nowISO();
      await tx.objectStore('documents').put({
        ...doc,
        inventory: { at: now, mode: p.mode, purchaseOrderId: p.mode === 'purchase_order' ? doc.purchaseOrderId : null, lines: targets, movementIds: movements.map((m) => m.id) },
        updatedAt: now,
        history: [...doc.history, { at: now, message: `在庫へ反映：${p.mode === 'purchase_order' ? '発注書の入荷として' : '入庫として'}${targets.length}品目（入出庫履歴${movements.length}件・資産${created.length}台）` }],
      });
      await this.syncSuggestions(tx);
      await this.remember(tx, p.requestId);
      await logActivity(tx, 'inventory', 'receive', `納品書 ${doc.number} の明細を在庫へ反映しました（${targets.length}品目）`, doc.id);
      return { duplicated: false, value: { movements, assets: created } } as const;
    });
  }

  // =============== マスタ ===============

  async saveSupplier(input: Omit<Supplier, 'id'>, id?: string): Promise<Supplier> {
    return this.run(ALL, async (tx) => {
      if (!input.name.trim()) throw new AppError('仕入先名を入力してください', { name: '必須です' });
      if (!Number.isInteger(input.leadTimeDays) || input.leadTimeDays < 0 || input.leadTimeDays > 120) throw new AppError('標準納期は0〜120日で入力してください', { leadTimeDays: '0〜120日' });
      const sup: Supplier = { ...input, name: input.name.trim(), id: id ?? generateId('sup') };
      await tx.objectStore('suppliers').put(sup);
      await logActivity(tx, 'purchase', id ? 'update' : 'create', `仕入先「${sup.name}」を${id ? '更新' : '登録'}しました`, sup.id);
      return sup;
    });
  }

  async saveEquipmentRule(rule: EquipmentRule): Promise<void> {
    await this.run(ALL, async (tx) => {
      if (!Number.isInteger(rule.quantity) || rule.quantity < 1 || rule.quantity > 20) throw new AppError('数量は1〜20で入力してください');
      await this.getItem(tx, rule.itemId);
      await tx.objectStore('equipmentRules').put(rule);
      await logActivity(tx, 'inventory', 'rule', '入社時の必要機器ルールを更新しました');
    });
  }

  async deleteEquipmentRule(id: string): Promise<void> {
    await this.run(ALL, async (tx) => {
      await tx.objectStore('equipmentRules').delete(id);
      await logActivity(tx, 'inventory', 'rule', '入社時の必要機器ルールを削除しました');
    });
  }

  /** Phase 2 以前からの移行ユーザー向け: 既存データを残したまま在庫・資産のデモだけ追加 */
  async addInventoryDemo(): Promise<number> {
    return this.run(ALL, async (tx) => {
      if ((await tx.objectStore('items').count()) > 0) throw new AppError('既に品目が登録されているため、デモデータは追加しません');
      const employees = await tx.objectStore('employees').getAll();
      const demo = createInventoryDemo(this.clock(), employees);
      const locs = new Set(await tx.objectStore('locations').getAllKeys());
      const sups = new Set(await tx.objectStore('suppliers').getAllKeys());
      for (const l of demo.locations) if (!locs.has(l.id)) await tx.objectStore('locations').put(l);
      for (const s of demo.suppliers) if (!sups.has(s.id)) await tx.objectStore('suppliers').put(s);
      for (const name of ['items', 'stockLevels', 'stockMovements', 'assets', 'assetEvents', 'purchaseSuggestions', 'purchaseOrders', 'equipmentRules'] as const) {
        const store = tx.objectStore(name);
        for (const rec of demo[name] as { id: string }[]) await store.put(rec as never);
      }
      await logActivity(tx, 'data', 'demo', `在庫・資産のデモデータ（品目${demo.items.length}件・資産${demo.assets.length}台）を追加しました`);
      return demo.items.length;
    });
  }

  /** 品目カタログと必要機器ルールだけを追加 (在庫0から始める場合) */
  async addDefaultCatalog(): Promise<number> {
    return this.run(ALL, async (tx) => {
      if ((await tx.objectStore('items').count()) > 0) throw new AppError('既に品目が登録されています');
      const items = createDefaultItems(nowISO());
      for (const i of items) await tx.objectStore('items').put(i);
      for (const r of createDefaultEquipmentRules()) await tx.objectStore('equipmentRules').put(r);
      await this.syncSuggestions(tx);
      return items.length;
    });
  }

  // =============== 自動化 ===============

  /** トランザクション内で最新のデータを読み、提案を作り直す (承認時点の状態で判定するため) */
  private async snapshot(tx: WriteTx): Promise<DataSnapshot> {
    const entries = await Promise.all(DATA_STORES.map(async (n) => [n, await tx.objectStore(n).getAll()] as const));
    return Object.fromEntries(entries) as unknown as DataSnapshot;
  }

  /**
   * 提案を承認して実行する。
   * - 承認時点のデータで提案を再計算し、同じキーの提案がなければ「状況が変わった」として中止 (古い画面からの実行を防ぐ)
   * - 同じキーで実行済み・見送り済みなら中止 (重複実行防止)
   * - 選択された操作をすべて1トランザクションで実行。途中で失敗したら全体を取り消し、失敗を処理履歴に残す
   */
  async applyProposal(automationId: string, key: string, actionIds: string[], opts: { auto?: boolean } = {}): Promise<{ results: string[] }> {
    const def = ALL_AUTOMATIONS.find((d) => d.id === automationId);
    if (!def) throw new AppError('不明な自動化です');
    if (opts.auto && !def.autoCapable) throw new AppError('この自動化は確認が必要なため、自動では実行できません');
    try {
      return await this.run(ALL, async (tx) => {
        const done = (await tx.objectStore('automationRuns').index('byKey').getAll(key)).find((r) => r.automationId === automationId && (r.status === 'applied' || r.status === 'dismissed' || r.status === 'auto'));
        if (done) throw new AppError('この提案は処理済みです（重複実行を防止しました）');
        const data = await this.snapshot(tx);
        const stock = computeAllStock(data.items, data);
        const proposal = def.detect({ data, today: this.clock(), stock }).find((p) => p.key === key);
        if (!proposal) throw new AppError('在庫や社員の状況が変わったため、この提案は実行できません。最新の提案を確認してください');
        const selected = proposal.actions.filter((a) => actionIds.includes(a.id));
        if (!selected.length) throw new AppError('実行する操作を選択してください');
        if (selected.length !== new Set(actionIds).size) throw new AppError('在庫や社員の状況が変わったため、この提案は実行できません。最新の提案を確認してください');
        // 自動実行は、承認が不要な操作 (タスク作成など) だけで構成された提案に限る
        if (opts.auto && selected.some((a) => a.requiresApproval)) throw new AppError('承認が必要な操作を含むため、自動では実行できません');
        const results: string[] = [];
        for (const a of selected) results.push(await this.execute(tx, a, proposal.inquiryId ?? null));
        await this.syncSuggestions(tx);
        if (proposal.inquiryId) await appendInquiryEvent(tx, proposal.inquiryId, inquiryEvent('task', `自動化「${def.name}」を承認：${results.join('／')}`));
        await tx.objectStore('automationRuns').add({ id: generateId('run'), automationId, key, status: opts.auto ? 'auto' : 'applied', title: proposal.title, results, error: null, at: nowISO() });
        await logActivity(tx, 'automation', opts.auto ? 'auto' : 'apply', `自動化「${def.name}」を${opts.auto ? '自動で' : ''}実行しました：${proposal.title}（${results.length}件）`);
        return { results };
      });
    } catch (e) {
      // 失敗も処理履歴に残す (別トランザクション)。重複実行の拒否は失敗として記録しない
      if (e instanceof AppError && !e.message.includes('処理済み')) {
        const tx = this.db.transaction(['automationRuns'], 'readwrite');
        await tx.objectStore('automationRuns').add({ id: generateId('run'), automationId, key, status: 'failed', title: def.name, results: [], error: e.message, at: nowISO() });
        await tx.done;
      }
      throw e;
    }
  }

  async dismissProposal(automationId: string, key: string, title: string): Promise<void> {
    await this.run(ALL, async (tx) => {
      await tx.objectStore('automationRuns').add({ id: generateId('run'), automationId, key, status: 'dismissed', title, results: ['担当者が見送り'], error: null, at: nowISO() });
      await logActivity(tx, 'automation', 'dismiss', `自動化の提案を見送りました：${title}`);
    });
  }

  private async execute(tx: WriteTx, a: AutomationAction, inquiryId: string | null): Promise<string> {
    const now = nowISO();
    switch (a.kind) {
      case 'reserve_asset': {
        const asset = await this.reserveInTx(tx, a.assetId, a.employeeId);
        return `${asset.assetNumber} を予約`;
      }
      case 'loan_asset': {
        const asset = await this.assignInTx(tx, a.assetId, a.employeeId, a.inquiryId, true);
        return `代替機 ${asset.assetNumber} を貸出`;
      }
      case 'reserve_item':
      case 'backorder_item': {
        const item = await this.getItem(tx, a.itemId);
        if (a.kind === 'reserve_item') {
          const st = await this.itemStatus(tx, item);
          if (st.available < a.quantity) throw new AppError(`${item.name} の利用可能数（${st.available}）が足りません`);
        }
        const emp = a.employeeId ? await tx.objectStore('employees').get(a.employeeId) : undefined;
        const r: Reservation = {
          id: generateId('rsv'),
          itemId: item.id,
          quantity: a.quantity,
          status: a.kind === 'reserve_item' ? 'active' : 'backorder',
          employeeId: a.employeeId,
          inquiryId: a.inquiryId,
          purpose: a.inquiryId ? `問い合わせの代替機（${emp?.name ?? ''}）` : `${emp?.name ?? ''}さんの入社準備`,
          key: a.key,
          createdAt: now,
          updatedAt: now,
        };
        await tx.objectStore('reservations').add(r);
        return `${item.name} ${a.quantity}${item.unit} を${a.kind === 'reserve_item' ? '予約' : '入荷待ちとして記録'}`;
      }
      case 'release_reservation': {
        const r = await tx.objectStore('reservations').get(a.reservationId);
        if (!r || (r.status !== 'active' && r.status !== 'backorder')) throw new AppError('予約が既に処理されています');
        if (a.quantity < r.quantity) {
          // 一部だけ解除: 残りは予約のまま、解除した分を別レコードとして記録する
          await tx.objectStore('reservations').put({ ...r, quantity: r.quantity - a.quantity, updatedAt: now });
          await tx.objectStore('reservations').add({ ...r, id: generateId('rsv'), quantity: a.quantity, status: 'released', createdAt: now, updatedAt: now });
        } else await tx.objectStore('reservations').put({ ...r, status: 'released', updatedAt: now });
        return `予約（${r.purpose}）を ${a.quantity} 解除`;
      }
      case 'release_asset': {
        const asset = await tx.objectStore('assets').get(a.assetId);
        if (!asset || asset.status !== 'reserved') throw new AppError('資産の予約が既に処理されています');
        await this.changeAsset(tx, asset, { status: 'unused', assigneeId: null, assigneeName: '', departmentId: null }, 'release', `${asset.assigneeName}さんの予約を解除（自動化）`);
        return `${asset.assetNumber} の予約を解除`;
      }
      case 'set_asset_status': {
        const asset = await tx.objectStore('assets').get(a.assetId);
        if (!asset) throw new AppError('資産が見つかりません');
        await this.changeAsset(tx, asset, { status: a.status }, 'status', a.note, a.inquiryId ?? inquiryId);
        return `${asset.assetNumber} を「${ASSET_STATUS_LABEL[a.status]}」に変更`;
      }
      case 'create_onboarding_task': {
        const exists = (await tx.objectStore('tasks').index('byEmployee').getAll(a.employeeId)).some((t) => t.ruleId === a.ruleId);
        if (exists) return `タスク「${a.title}」は作成済みのためスキップ`;
        await tx.objectStore('tasks').add({
          id: generateId('task'),
          employeeId: a.employeeId,
          title: a.title,
          description: a.description,
          assigneeDepartmentId: a.departmentId,
          assignee: a.assignee,
          priority: a.priority,
          dueDate: a.dueDate,
          status: 'todo',
          source: 'onboarding',
          ruleId: a.ruleId,
          inquiryId: null,
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        });
        return `タスク「${a.title}」を作成`;
      }
      case 'create_task': {
        const exists = (await tx.objectStore('tasks').getAll()).some((t) => t.ruleId === a.ruleKey);
        if (exists) return `タスク「${a.title}」は作成済みのためスキップ`;
        const task: Task = {
          id: generateId('task'),
          employeeId: a.employeeId,
          title: a.title,
          description: a.description,
          assigneeDepartmentId: a.departmentId,
          assignee: a.assignee,
          priority: a.priority,
          dueDate: a.dueDate,
          status: 'todo',
          source: a.inquiryId ? 'inquiry' : 'automation',
          ruleId: a.ruleKey,
          inquiryId: a.inquiryId,
          assetId: a.assetId,
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        };
        await tx.objectStore('tasks').add(task);
        return `タスク「${a.title}」を作成`;
      }
    }
  }
}
