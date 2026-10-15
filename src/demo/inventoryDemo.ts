/**
 * 在庫・IT資産・購買のデモデータ (すべて架空)。
 * 日付は「今日」基準の相対日付で作り、月別入出庫などの分析が常に意味を持つようにする。
 * 入出庫台帳 (stockMovements) から現在庫 (stockLevels) を計算して作るため、台帳と在庫は必ず一致する。
 */
import { addDays } from '../domain/date';
import { generateId } from '../domain/id';
import { computeAllStock } from '../domain/inventory/stock';
import { planSuggestionSync } from '../domain/inventory/suggestions';
import { createDefaultEquipmentRules, createDefaultItems, createDefaultLocations, createDefaultSuppliers, ITEM, LOC, SUP, type InventorySnapshot } from '../domain/inventory/defaults';
import type { Asset, AssetEvent, Item, PurchaseOrder, StockLevel, StockMovement } from '../domain/inventory/types';
import type { Employee, ISODate } from '../domain/types';

/** 品目ごとの現在庫の目標値と、過去の出庫回数 (月別グラフ用) */
const QTY_PLAN: Record<string, { final: number; issues: number[] }> = {
  [ITEM.monitor]: { final: 3, issues: [1, 2, 1] },
  [ITEM.keyboard]: { final: 4, issues: [1, 1] },
  [ITEM.mouse]: { final: 5, issues: [2, 1, 2, 1] },
  [ITEM.cableHdmi]: { final: 6, issues: [2, 1] },
  [ITEM.cableUsbc]: { final: 3, issues: [2, 2, 1] }, // 最低在庫 4 を下回る → 発注候補
  [ITEM.headset]: { final: 2, issues: [1] },
  [ITEM.notebook]: { final: 12, issues: [3, 2, 3] },
  [ITEM.toner]: { final: 1, issues: [1, 1, 1] }, // 最低在庫 2 を下回る → 発注候補
  [ITEM.paper]: { final: 35, issues: [10, 12, 8, 15] },
  [ITEM.nameCard]: { final: 4, issues: [1, 2] },
};

function iso(today: ISODate, daysAgo: number, hour = 10): string {
  return new Date(`${addDays(today, -daysAgo)}T${String(hour).padStart(2, '0')}:00:00`).toISOString();
}

export function createInventoryDemo(today: ISODate, employees: Employee[]): InventorySnapshot {
  const ts = iso(today, 180);
  const items = createDefaultItems(ts);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const movements: StockMovement[] = [];
  const levels = new Map<string, StockLevel>();
  const totals = new Map<string, number>();

  const move = (item: Item, type: StockMovement['type'], qty: number, daysAgo: number, reason: string, refType: StockMovement['refType'] = 'manual', refId: string | null = null) => {
    const loc = item.defaultLocationId ?? LOC.main;
    const key = `${item.id}@${loc}`;
    const delta = type === 'issue' ? -qty : qty;
    const lv = levels.get(key) ?? { id: key, itemId: item.id, locationId: loc, quantity: 0 };
    lv.quantity += delta;
    levels.set(key, lv);
    totals.set(item.id, (totals.get(item.id) ?? 0) + delta);
    movements.push({ id: generateId('mov'), itemId: item.id, type, delta, quantity: qty, locationId: loc, toLocationId: null, balanceAfter: totals.get(item.id)!, reason, refType, refId, employeeId: null, at: iso(today, daysAgo) });
  };

  // 発注履歴 (入荷完了 1件 + 承認済み・入荷待ち 1件)
  const po1: PurchaseOrder = {
    id: 'po_demo_1',
    number: `PO-${today.slice(0, 4)}-0001`,
    supplierId: SUP.office,
    status: 'received',
    lines: [{ id: 'pol_1', itemId: ITEM.paper, quantity: 40, unitPrice: 450, receivedQuantity: 40 }],
    expectedDate: addDays(today, -40),
    requestedBy: '加藤 由美',
    approvedBy: '佐藤 健一',
    notes: '',
    history: [
      { at: iso(today, 45), message: '発注候補から作成（下書き）' },
      { at: iso(today, 45, 11), message: '承認申請' },
      { at: iso(today, 44), message: '承認（佐藤 健一）' },
      { at: iso(today, 40), message: '入荷登録：コピー用紙 A4（500枚） 40冊（入荷完了）' },
    ],
    createdAt: iso(today, 45),
    updatedAt: iso(today, 40),
    approvedAt: iso(today, 44),
  };
  const po2: PurchaseOrder = {
    id: 'po_demo_2',
    number: `PO-${today.slice(0, 4)}-0002`,
    supplierId: SUP.pc,
    status: 'approved',
    lines: [{ id: 'pol_2', itemId: ITEM.mouse, quantity: 5, unitPrice: 1800, receivedQuantity: 0 }],
    expectedDate: addDays(today, 3),
    requestedBy: '小林 美咲',
    approvedBy: '中村 拓也',
    notes: '入社予定者分を含む',
    history: [
      { at: iso(today, 4), message: '発注候補から作成（下書き）' },
      { at: iso(today, 4, 11), message: '承認申請' },
      { at: iso(today, 3), message: '承認（中村 拓也）' },
    ],
    createdAt: iso(today, 4),
    updatedAt: iso(today, 3),
    approvedAt: iso(today, 3),
  };

  for (const [itemId, plan] of Object.entries(QTY_PLAN)) {
    const item = itemById.get(itemId)!;
    const issued = plan.issues.reduce((a, b) => a + b, 0);
    const purchased = itemId === ITEM.paper ? 40 : 0;
    move(item, 'receive', plan.final + issued - purchased, 170, '初期在庫の登録');
    if (purchased) move(item, 'receive', purchased, 40, `発注 ${po1.number} の入荷`, 'purchase_order', po1.id);
    plan.issues.forEach((q, i) => move(item, 'issue', q, 150 - i * 35, i % 2 ? '社員への支給' : '補充・交換'));
  }

  // IT資産: 在籍社員に標準PCを1台ずつ、営業部にスマートフォンを貸与
  const assets: Asset[] = [];
  const events: AssetEvent[] = [];
  let seq = 0;
  const addAsset = (itemId: string, opts: { status: Asset['status']; employee?: Employee; purchaseDaysAgo: number; serial: string; notes?: string }) => {
    seq++;
    const item = itemById.get(itemId)!;
    const purchaseDate = addDays(today, -opts.purchaseDaysAgo);
    const a: Asset = {
      id: `ast_demo_${seq}`,
      assetNumber: `AST-${String(seq).padStart(4, '0')}`,
      itemId,
      name: item.name,
      category: item.category,
      maker: item.maker,
      model: item.model,
      serialNumber: opts.serial,
      purchaseDate,
      purchaseCost: item.unitPrice - (opts.purchaseDaysAgo > 700 ? 10000 : 0),
      warrantyUntil: addDays(purchaseDate, 365 * 3),
      status: opts.status,
      assigneeId: opts.employee?.id ?? null,
      assigneeName: opts.employee?.name ?? '',
      departmentId: opts.employee?.departmentId ?? null,
      locationId: opts.employee ? null : LOC.it,
      purchaseOrderId: null,
      notes: opts.notes ?? '',
      createdAt: iso(today, opts.purchaseDaysAgo),
      updatedAt: iso(today, opts.purchaseDaysAgo),
    };
    assets.push(a);
    events.push({ id: generateId('aev'), assetId: a.id, type: 'register', fromStatus: null, toStatus: 'unused', employeeId: null, employeeName: '', inquiryId: null, note: '資産台帳に登録', at: iso(today, opts.purchaseDaysAgo) });
    if (opts.employee && opts.status === 'in_use')
      events.push({ id: generateId('aev'), assetId: a.id, type: 'assign', fromStatus: 'unused', toStatus: 'in_use', employeeId: opts.employee.id, employeeName: opts.employee.name, inquiryId: null, note: '貸出', at: iso(today, Math.max(1, opts.purchaseDaysAgo - 3)) });
    if (opts.status === 'repair' || opts.status === 'disposed')
      events.push({ id: generateId('aev'), assetId: a.id, type: 'status', fromStatus: 'unused', toStatus: opts.status, employeeId: null, employeeName: '', inquiryId: null, note: opts.notes ?? '', at: iso(today, 20) });
    return a;
  };

  const active = employees.filter((e) => e.status === 'active' || e.status === 'leave').sort((a, b) => a.employeeNumber.localeCompare(b.employeeNumber));
  active.forEach((e, i) => addAsset(ITEM.laptop, { status: 'in_use', employee: e, purchaseDaysAgo: 200 + i * 37, serial: `NB14S-${String(10230 + i)}` }));
  addAsset(ITEM.laptop, { status: 'unused', purchaseDaysAgo: 30, serial: 'NB14S-20001' });
  addAsset(ITEM.laptop, { status: 'unused', purchaseDaysAgo: 30, serial: 'NB14S-20002' });
  addAsset(ITEM.laptop, { status: 'repair', purchaseDaysAgo: 900, serial: 'NB14S-09001', notes: '液晶破損のためメーカー修理中' });
  addAsset(ITEM.laptop, { status: 'disposed', purchaseDaysAgo: 1600, serial: 'NB14S-05001', notes: '耐用年数超過のため廃棄（データ消去済み）' });
  active.filter((e) => e.departmentId === 'dept_eigyo').forEach((e, i) => addAsset(ITEM.smartphone, { status: 'in_use', employee: e, purchaseDaysAgo: 300 + i * 20, serial: `SP6-${String(7700 + i)}` }));

  const inv: InventorySnapshot = {
    items,
    stockLevels: [...levels.values()],
    stockMovements: movements,
    reservations: [],
    assets,
    assetEvents: events,
    locations: createDefaultLocations(),
    suppliers: createDefaultSuppliers(),
    purchaseSuggestions: [],
    purchaseOrders: [po1, po2],
    equipmentRules: createDefaultEquipmentRules(),
    automationRuns: [],
  };
  // 在庫不足の品目には、実際の同期ロジックで発注候補を作っておく
  const stock = computeAllStock(items, inv);
  inv.purchaseSuggestions = planSuggestionSync(items, stock, [], iso(today, 0, 9)).create;
  return inv;
}
