import { describe, expect, it } from 'vitest';
import { openDB } from 'idb';
import { createService, TODAY } from '../test/helpers';
import { DB_VERSION, openWorkCoreDB } from '../data/db';
import { generateId } from '../domain/id';
import { createBackup, parseBackupText } from '../data/backup';
import { computeAllStock, computeStockStatus } from '../domain/inventory/stock';
import { ITEM, LOC } from '../domain/inventory/defaults';
import { INVENTORY_AUTOMATIONS } from '../automation/inventoryAutomations';
import { pendingProposals } from '../automation/engine';
import { createDemoData } from '../demo/demoData';
import { WorkCoreService } from './workcoreService';
import type { DataSnapshot } from '../domain/types';

async function setup() {
  const { service } = await createService();
  await service.ensureInitialized();
  return { service, inv: service.inventory };
}
const status = (d: DataSnapshot, itemId: string) => computeStockStatus(d.items.find((i) => i.id === itemId)!, d);
const proposals = (d: DataSnapshot) => pendingProposals(INVENTORY_AUTOMATIONS, { data: d, today: TODAY, stock: computeAllStock(d.items, d) });

/** 台帳 (入出庫履歴) の合計と保管場所別在庫の合計が一致することを検証する */
function expectLedgerConsistent(d: DataSnapshot) {
  for (const item of d.items.filter((i) => i.tracking === 'quantity')) {
    const ledger = d.stockMovements.filter((m) => m.itemId === item.id).reduce((a, m) => a + m.delta, 0);
    const levels = d.stockLevels.filter((l) => l.itemId === item.id).reduce((a, l) => a + l.quantity, 0);
    expect(levels, item.name).toBe(ledger);
    expect(d.stockLevels.every((l) => l.quantity >= 0)).toBe(true);
  }
  // 発注候補は1品目につき最大1件
  const open = d.purchaseSuggestions.filter((s) => s.status === 'open').map((s) => s.itemId);
  expect(new Set(open).size).toBe(open.length);
  // 同じ資産が複数人に割り当てられていない (資産は1人の assignee しか持てない構造 + 予約済み/使用中のみ assignee を持つ)
  for (const a of d.assets) if (a.assigneeId) expect(['reserved', 'in_use']).toContain(a.status);
}

describe('デモデータの整合性', () => {
  it('台帳と在庫が一致し、不足品目に発注候補がある', async () => {
    const { service } = await setup();
    const d = await service.loadSnapshot();
    expectLedgerConsistent(d);
    const sugItems = d.purchaseSuggestions.filter((s) => s.status === 'open').map((s) => s.itemId);
    expect(sugItems).toEqual(expect.arrayContaining([ITEM.cableUsbc, ITEM.toner, ITEM.smartphone]));
    expect(status(d, ITEM.laptop).available).toBe(2);
    expect(status(d, ITEM.mouse).onOrder).toBe(5); // 承認済み発注の未入荷分
  });
});

describe('入出庫と整合性', () => {
  it('入庫・出庫・移動・調整が台帳に残り、在庫と一致する', async () => {
    const { service, inv } = await setup();
    await inv.receive({ itemId: ITEM.keyboard, quantity: 3, locationId: LOC.it, reason: '補充' });
    await inv.issue({ itemId: ITEM.keyboard, quantity: 2, locationId: LOC.it, reason: '支給' });
    await inv.transfer({ itemId: ITEM.keyboard, quantity: 1, fromLocationId: LOC.it, toLocationId: LOC.main });
    await expect(inv.adjust({ itemId: ITEM.keyboard, locationId: LOC.main, actualQuantity: 0, reason: '' })).rejects.toThrow('理由');
    await inv.adjust({ itemId: ITEM.keyboard, locationId: LOC.main, actualQuantity: 0, reason: '紛失' });
    const d = await service.loadSnapshot();
    const kb = status(d, ITEM.keyboard);
    expect(kb.onHand).toBe(4 + 3 - 2 - 1);
    const types = d.stockMovements.filter((m) => m.itemId === ITEM.keyboard).map((m) => m.type);
    expect(types).toEqual(expect.arrayContaining(['receive', 'issue', 'transfer', 'adjust']));
    expect(d.stockMovements.find((m) => m.type === 'adjust')?.reason).toBe('紛失');
    expectLedgerConsistent(d);
  });

  it('入出庫の取り消しは履歴を消さず逆向きの記録を追加し、二重の取り消し・マイナス在庫になる取り消しを拒否する', async () => {
    const { service, inv } = await setup();
    let d = await service.loadSnapshot();
    const before = status(d, ITEM.keyboard).onHand;
    const movesBefore = d.stockMovements.length;
    const r = await inv.receive({ itemId: ITEM.keyboard, quantity: 4, locationId: LOC.it, reason: '補充' });
    const rec = r.value!;
    await inv.reverseMovement(rec.id);
    d = await service.loadSnapshot();
    expect(status(d, ITEM.keyboard).onHand).toBe(before);
    expect(d.stockMovements).toHaveLength(movesBefore + 2); // 元の記録は残る
    expect(d.stockMovements.find((m) => m.refType === 'reversal')?.refId).toBe(rec.id);
    expectLedgerConsistent(d);
    await expect(inv.reverseMovement(rec.id)).rejects.toThrow('既に取り消されています');
    const rev = d.stockMovements.find((m) => m.refType === 'reversal')!;
    await expect(inv.reverseMovement(rev.id)).rejects.toThrow('取り消せません');

    // 入庫後にほぼ全量を出庫済み → 入庫を取り消すと在庫がマイナスになるため拒否 (何も変わらない)
    const r2 = await inv.receive({ itemId: ITEM.headset, quantity: 3, locationId: LOC.it, reason: '補充' });
    d = await service.loadSnapshot();
    const avail = status(d, ITEM.headset).available;
    const emp = d.employees.find((e) => e.status === 'active')!;
    await inv.issue({ itemId: ITEM.headset, quantity: avail - 1, locationId: LOC.it, reason: '支給', employeeId: emp.id });
    await expect(inv.reverseMovement(r2.value!.id)).rejects.toThrow();
    const after = await service.loadSnapshot();
    expect(status(after, ITEM.headset).onHand).toBe(1);
    expectLedgerConsistent(after);
  });

  it('マイナス在庫・利用可能数を超える出庫・不正な数量を拒否する（境界値）', async () => {
    const { service, inv } = await setup();
    const kb = status(await service.loadSnapshot(), ITEM.keyboard).available; // 4
    await expect(inv.issue({ itemId: ITEM.keyboard, quantity: kb + 1, locationId: LOC.it, reason: '' })).rejects.toThrow('利用可能数');
    await expect(inv.issue({ itemId: ITEM.keyboard, quantity: 0, locationId: LOC.it, reason: '' })).rejects.toThrow('1以上');
    await expect(inv.issue({ itemId: ITEM.keyboard, quantity: 1.5, locationId: LOC.it, reason: '' })).rejects.toThrow();
    await expect(inv.issue({ itemId: ITEM.keyboard, quantity: 1, locationId: LOC.main, reason: '' })).rejects.toThrow('在庫が不足'); // その保管場所には0
    await inv.issue({ itemId: ITEM.keyboard, quantity: kb, locationId: LOC.it, reason: 'ちょうど全数' }); // 境界: 全数はOK
    const d = await service.loadSnapshot();
    expect(status(d, ITEM.keyboard).onHand).toBe(0);
    expect(d.stockLevels.every((l) => l.quantity >= 0)).toBe(true);
    // 在庫が0になった → 発注候補が自動作成される
    expect(d.purchaseSuggestions.some((s) => s.itemId === ITEM.keyboard && s.status === 'open')).toBe(true);
  });

  it('同じ requestId の出庫は1回だけ処理される（連打・再読み込み）', async () => {
    const { service, inv } = await setup();
    const rid = generateId('req');
    const r1 = await inv.issue({ itemId: ITEM.paper, quantity: 1, locationId: LOC.main, reason: '', requestId: rid });
    const r2 = await inv.issue({ itemId: ITEM.paper, quantity: 1, locationId: LOC.main, reason: '', requestId: rid });
    expect(r1.duplicated).toBe(false);
    expect(r2.duplicated).toBe(true);
    expect(status(await service.loadSnapshot(), ITEM.paper).onHand).toBe(34);
  });

  it('同時に出庫しても合計が在庫を超えない（二重出庫の防止）', async () => {
    const { service, inv } = await setup();
    const avail = status(await service.loadSnapshot(), ITEM.headset).available; // 2
    const results = await Promise.allSettled([1, 2, 3].map(() => inv.issue({ itemId: ITEM.headset, quantity: 1, locationId: LOC.it, reason: '', requestId: generateId() })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(avail);
    expect(status(await service.loadSnapshot(), ITEM.headset).onHand).toBe(0);
  });

  it('予約分は出庫できず、引き渡しで出庫される', async () => {
    const { service, inv } = await setup();
    // 開発部の入社予定者 (森さん) の必要機器を承認 → モニター2台が予約される
    const d0 = await service.loadSnapshot();
    const p = proposals(d0).find((x) => x.automationId === 'onboarding-equipment' && x.title.includes('森'))!;
    await inv.applyProposal(p.automationId, p.key, p.actions.map((a) => a.id));
    const d1 = await service.loadSnapshot();
    const mon = status(d1, ITEM.monitor);
    expect(mon.reserved).toBe(2);
    expect(mon.available).toBe(1);
    await expect(inv.issue({ itemId: ITEM.monitor, quantity: 2, locationId: LOC.it, reason: '' })).rejects.toThrow('予約分');
    const r = d1.reservations.find((x) => x.itemId === ITEM.monitor && x.status === 'active')!;
    await inv.fulfillReservation(r.id, LOC.it);
    const d2 = await service.loadSnapshot();
    expect(status(d2, ITEM.monitor)).toMatchObject({ onHand: 1, reserved: 0, available: 1 });
    expectLedgerConsistent(d2);
  });

  it('棚卸は差異のある行だけ記録する', async () => {
    const { service, inv } = await setup();
    const r = await inv.applyStocktake([
      { itemId: ITEM.paper, locationId: LOC.main, counted: 35 }, // 差異なし
      { itemId: ITEM.notebook, locationId: LOC.main, counted: 10 }, // -2
    ]);
    expect(r).toMatchObject({ duplicated: false, value: 1 });
    const d = await service.loadSnapshot();
    expect(d.stockMovements.filter((m) => m.type === 'stocktake')).toHaveLength(1);
    expect(status(d, ITEM.notebook).onHand).toBe(10);
  });
});

describe('IT資産', () => {
  it('同一機器を複数人に同時に貸し出せない・状態遷移の制約', async () => {
    const { service, inv } = await setup();
    const d = await service.loadSnapshot();
    const unused = d.assets.find((a) => a.status === 'unused')!;
    const [e1, e2] = d.employees.filter((e) => e.status === 'active');
    await inv.assignAsset(unused.id, e1!.id);
    await expect(inv.assignAsset(unused.id, e2!.id)).rejects.toThrow('貸し出せません');
    await expect(inv.setAssetStatus(unused.id, 'disposed', '')).rejects.toThrow();
    await expect(inv.setAssetStatus(unused.id, 'disposal_planned', '')).rejects.toThrow('返却');
    await inv.returnAsset(unused.id, 'unused', '');
    await inv.setAssetStatus(unused.id, 'disposal_planned', '老朽化');
    await inv.setAssetStatus(unused.id, 'disposed', 'データ消去済み');
    await expect(inv.setAssetStatus(unused.id, 'unused', '')).rejects.toThrow();
    const ev = (await service.loadSnapshot()).assetEvents.filter((x) => x.assetId === unused.id).map((x) => x.type);
    expect(ev).toEqual(expect.arrayContaining(['register', 'assign', 'return', 'status']));
  });

  it('シリアル番号の重複を防ぐ・貸出中の社員は削除できない', async () => {
    const { service, inv } = await setup();
    const d = await service.loadSnapshot();
    const base = { itemId: ITEM.laptop, name: 'ノートPC', category: 'pc' as const, maker: '', model: '', purchaseDate: null, purchaseCost: null, warrantyUntil: null, locationId: LOC.it, notes: '' };
    await inv.registerAsset({ ...base, serialNumber: 'SN-1' });
    await expect(inv.registerAsset({ ...base, serialNumber: 'sn-1' })).rejects.toThrow('登録済み');
    const holder = d.assets.find((a) => a.status === 'in_use')!.assigneeId!;
    await expect(service.deleteEmployee(holder)).rejects.toThrow('貸与中');
  });
});

describe('発注支援', () => {
  it('候補 → 発注書（下書き）→ 承認 → 入荷 で在庫に反映。候補と確定発注を区別し二重候補を作らない', async () => {
    const { service, inv } = await setup();
    let d = await service.loadSnapshot();
    const sug = d.purchaseSuggestions.find((s) => s.itemId === ITEM.toner && s.status === 'open')!;
    expect(sug.quantity).toBe(3); // 適正在庫4 − 見込み1
    const created = await inv.createOrdersFromSuggestions([sug.id], '加藤 由美');
    const po = created.value![0]!;
    d = await service.loadSnapshot();
    expect(d.purchaseSuggestions.find((s) => s.id === sug.id)?.status).toBe('ordered');
    // 下書き中は「発注準備中」として見込みに含める → 同じ品目の候補を作り直さない
    expect(d.purchaseSuggestions.filter((s) => s.itemId === ITEM.toner && s.status === 'open')).toHaveLength(0);
    // 下書き・承認待ちでは入荷登録できない (入荷未完了なのに在庫に加算しない)
    await expect(inv.receiveOrder(po.id, [{ lineId: po.lines[0]!.id, quantity: 1, locationId: LOC.main }])).rejects.toThrow('承認済みのみ');
    expect(status(d, ITEM.toner).onHand).toBe(1);
    await inv.transitionOrder(po.id, 'submit', '加藤 由美');
    await expect(inv.transitionOrder(po.id, 'approve', '')).rejects.toThrow('承認者名');
    // Phase 10: 申請者本人は承認できない (空白の違いも同じ人とみなす)
    await expect(inv.transitionOrder(po.id, 'approve', '加藤　由美')).rejects.toThrow('本人は承認できません');
    await inv.transitionOrder(po.id, 'approve', '佐藤 健一');
    d = await service.loadSnapshot();
    expect(status(d, ITEM.toner)).toMatchObject({ onHand: 1, onOrder: 3 });
    // 未入荷数量を超える入荷は拒否
    await expect(inv.receiveOrder(po.id, [{ lineId: po.lines[0]!.id, quantity: 4, locationId: LOC.main }])).rejects.toThrow('超えています');
    await inv.receiveOrder(po.id, [{ lineId: po.lines[0]!.id, quantity: 1, locationId: LOC.main }]);
    expect((await service.loadSnapshot()).purchaseOrders.find((x) => x.id === po.id)?.status).toBe('partially_received');
    const rid = generateId();
    await inv.receiveOrder(po.id, [{ lineId: po.lines[0]!.id, quantity: 2, locationId: LOC.main }], rid);
    expect((await inv.receiveOrder(po.id, [{ lineId: po.lines[0]!.id, quantity: 2, locationId: LOC.main }], rid)).duplicated).toBe(true);
    d = await service.loadSnapshot();
    expect(d.purchaseOrders.find((x) => x.id === po.id)?.status).toBe('received');
    expect(status(d, ITEM.toner)).toMatchObject({ onHand: 4, onOrder: 0 });
    expectLedgerConsistent(d);
  });

  it('見送った候補は不足が続く間は再作成しない', async () => {
    const { service, inv } = await setup();
    const sug = (await service.loadSnapshot()).purchaseSuggestions.find((s) => s.itemId === ITEM.cableUsbc && s.status === 'open')!;
    await inv.dismissSuggestion(sug.id);
    await inv.issue({ itemId: ITEM.cableUsbc, quantity: 1, locationId: LOC.it, reason: '' });
    expect((await service.loadSnapshot()).purchaseSuggestions.filter((s) => s.itemId === ITEM.cableUsbc && s.status === 'open')).toHaveLength(0);
  });

  it('個体管理品の入荷で資産が自動登録され、入荷待ちの予約に引き当てられる', async () => {
    const { service, inv } = await setup();
    // 営業部の入社予定者 (池田さん) → スマートフォンは在庫0なので入荷待ち
    let d = await service.loadSnapshot();
    const p = proposals(d).find((x) => x.automationId === 'onboarding-equipment' && x.title.includes('池田'))!;
    expect(p.actions.some((a) => a.kind === 'backorder_item' && a.itemId === ITEM.smartphone)).toBe(true);
    await inv.applyProposal(p.automationId, p.key, p.actions.map((a) => a.id));
    d = await service.loadSnapshot();
    expect(status(d, ITEM.smartphone).backorder).toBe(1);
    const sug = d.purchaseSuggestions.find((s) => s.itemId === ITEM.smartphone && s.status === 'open')!;
    expect(sug.reasons.join()).toContain('入荷待ち需要 1');
    const po = (await inv.createOrdersFromSuggestions([sug.id], '小林')).value![0]!;
    await inv.transitionOrder(po.id, 'submit', '小林');
    await inv.transitionOrder(po.id, 'approve', '中村');
    await inv.receiveOrder(po.id, [{ lineId: po.lines[0]!.id, quantity: po.lines[0]!.quantity, locationId: LOC.it }]);
    d = await service.loadSnapshot();
    const ikeda = d.employees.find((e) => e.name === '池田 悠真')!;
    const phone = d.assets.find((a) => a.itemId === ITEM.smartphone && a.assigneeId === ikeda.id);
    expect(phone?.status).toBe('reserved');
    expect(phone?.purchaseOrderId).toBe(po.id);
    expect(status(d, ITEM.smartphone).backorder).toBe(0);
    // 充足したので同じ社員への提案は出ない (スマートフォン分)
    expect(proposals(d).filter((x) => x.employeeId === ikeda.id).flatMap((x) => x.actions).some((a) => 'itemId' in a && a.itemId === ITEM.smartphone)).toBe(false);
  });
});

describe('自動化エンジン（人事・ヘルプデスク連携）', () => {
  it('新入社員の登録 → 必要機器の判定 → 承認で予約・タスク作成。重複実行を防ぐ', async () => {
    const { service, inv } = await setup();
    const emp = await service.createEmployee({ employeeNumber: 'N9001', name: '機器 太郎', departmentId: 'dept_kaihatsu', position: '', employmentType: '正社員', hireDate: '2026-11-16', retireDate: null, status: 'pending', notes: '' });
    const d = await service.loadSnapshot();
    const p = proposals(d).find((x) => x.employeeId === emp.id)!;
    expect(p).toBeDefined();
    expect(p.conditions.join()).toContain('ノートPC');
    // 先に入社する予定者が未使用PCの候補を持つため、この社員は入荷待ちになる (入社日順に割り当てる)
    expect(p.actions.find((a) => a.kind === 'backorder_item' && a.itemId === ITEM.laptop)).toBeDefined();
    expect(p.actions.find((a) => a.kind === 'reserve_item' && a.itemId === ITEM.mouse)).toBeDefined();
    expect(p.actions.filter((a) => a.requiresApproval).length).toBeGreaterThan(0);
    const { results } = await inv.applyProposal(p.automationId, p.key, p.actions.map((a) => a.id));
    expect(results.join()).toContain('タスク「不足機器の発注確認');
    await expect(inv.applyProposal(p.automationId, p.key, p.actions.map((a) => a.id))).rejects.toThrow();
    const after = await service.loadSnapshot();
    expect(proposals(after).find((x) => x.employeeId === emp.id)).toBeUndefined();
    expect(after.tasks.filter((t) => t.employeeId === emp.id && t.source === 'automation').length).toBeGreaterThanOrEqual(1);
    expect(after.automationRuns.some((r) => r.status === 'applied' && r.key === p.key)).toBe(true);
    expectLedgerConsistent(after);
  });

  it('部署異動で不要になった予約の解除を提案し、入社取り消しで全予約を解除する', async () => {
    const { service, inv } = await setup();
    let d = await service.loadSnapshot();
    const mori = d.employees.find((e) => e.name === '森 結衣')!;
    const p = proposals(d).find((x) => x.employeeId === mori.id)!;
    await inv.applyProposal(p.automationId, p.key, p.actions.map((a) => a.id));
    // 開発部 → 経理部に異動 (モニター2台→1台、キーボード・HDMIは不要)
    await service.updateEmployee(mori.id, { ...mori, departmentId: 'dept_keiri' });
    d = await service.loadSnapshot();
    const p2 = proposals(d).find((x) => x.employeeId === mori.id && x.automationId === 'onboarding-equipment')!;
    expect(p2.actions.filter((a) => a.kind === 'release_reservation').length).toBeGreaterThanOrEqual(2);
    await inv.applyProposal(p2.automationId, p2.key, p2.actions.map((a) => a.id));
    d = await service.loadSnapshot();
    expect(status(d, ITEM.monitor).reserved).toBe(1);
    // 入社取り消し (退職扱い) → 予約の全解除を提案
    await service.updateEmployee(mori.id, { ...mori, departmentId: 'dept_keiri', status: 'retired', retireDate: mori.hireDate });
    d = await service.loadSnapshot();
    const p3 = proposals(d).find((x) => x.automationId === 'release-cancelled-hire' && x.employeeId === mori.id)!;
    expect(p3.actions.some((a) => a.kind === 'release_asset')).toBe(true);
    await inv.applyProposal(p3.automationId, p3.key, p3.actions.map((a) => a.id));
    d = await service.loadSnapshot();
    expect(d.assets.some((a) => a.assigneeId === mori.id)).toBe(false);
    expect(d.reservations.filter((r) => r.employeeId === mori.id && (r.status === 'active' || r.status === 'backorder'))).toHaveLength(0);
    expect(status(d, ITEM.laptop).available).toBe(2);
  });

  it('退職予定者の返却タスクを生成する（資産ごと・重複なし）', async () => {
    const { service, inv } = await setup();
    const d = await service.loadSnapshot();
    const p = proposals(d).find((x) => x.automationId === 'retirement-return')!;
    expect(p.title).toContain('山田 隆');
    expect(p.actions).toHaveLength(2); // PC + スマートフォン
    await inv.applyProposal(p.automationId, p.key, p.actions.map((a) => a.id));
    const after = await service.loadSnapshot();
    const tasks = after.tasks.filter((t) => t.title.startsWith('貸与資産の返却確認'));
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.assetId)).toBe(true);
    expect(proposals(after).some((x) => x.automationId === 'retirement-return')).toBe(false);
  });

  it('PC故障の問い合わせ → 代替機の貸出・修理中・タスク・双方向の参照', async () => {
    const { service, inv } = await setup();
    let d = await service.loadSnapshot();
    const holder = d.assets.find((a) => a.status === 'in_use' && a.category === 'pc' && a.assigneeName === '渡辺 さくら')!;
    const { inquiry } = await service.helpdesk.createInquiry(
      { requesterId: holder.assigneeId, title: 'PCが故障した', body: '電源が入らない', categoryId: 'cat_pc', priority: 'high', assignee: '小林 美咲', dueDate: '2026-10-16' },
      { requestId: generateId(), classification: null },
    );
    d = await service.loadSnapshot();
    const p = proposals(d).find((x) => x.automationId === 'failure-replacement' && x.inquiryId === inquiry.id)!;
    expect(p.conditions.join()).toContain(holder.assetNumber);
    await inv.applyProposal(p.automationId, p.key, p.actions.map((a) => a.id));
    d = await service.loadSnapshot();
    expect(d.assets.find((a) => a.id === holder.id)?.status).toBe('repair');
    const loaned = d.assets.find((a) => a.assigneeId === holder.assigneeId && a.status === 'in_use' && a.id !== holder.id)!;
    expect(loaned).toBeDefined();
    // 資産 → 問い合わせ、問い合わせ → タスク・資産 の参照
    expect(d.assetEvents.filter((e) => e.inquiryId === inquiry.id).map((e) => e.assetId)).toEqual(expect.arrayContaining([holder.id, loaned.id]));
    const tasks = d.tasks.filter((t) => t.inquiryId === inquiry.id);
    expect(tasks.map((t) => t.assetId)).toEqual(expect.arrayContaining([holder.id, loaned.id]));
    expect(d.inquiries.find((i) => i.id === inquiry.id)?.history.some((h) => h.message.includes('代替機'))).toBe(true);
    // 貸し出した代替機を「故障機」と誤認して、同じ問い合わせで再提案しない
    expect(proposals(d).filter((x) => x.automationId === 'failure-replacement' && x.inquiryId === inquiry.id)).toHaveLength(0);
  });

  it('代替機の在庫がない故障は入荷待ちを記録し、同じ問い合わせで二重に記録しない', async () => {
    const { service, inv } = await setup();
    let d = await service.loadSnapshot();
    const emp = d.employees.find((e) => e.status === 'active')!;
    for (const a of d.assets.filter((x) => x.status === 'unused' && x.category === 'pc')) await inv.assignAsset(a.id, emp.id);
    d = await service.loadSnapshot();
    const holder = d.assets.find((a) => a.status === 'in_use' && a.category === 'pc' && a.assigneeName === '渡辺 さくら')!;
    const { inquiry } = await service.helpdesk.createInquiry(
      { requesterId: holder.assigneeId, title: 'PCが壊れた', body: '画面が映らない', categoryId: 'cat_pc', priority: 'high', assignee: '小林 美咲', dueDate: '2026-10-16' },
      { requestId: generateId(), classification: null },
    );
    d = await service.loadSnapshot();
    const p = proposals(d).find((x) => x.automationId === 'failure-replacement' && x.inquiryId === inquiry.id)!;
    expect(p.actions.map((a) => a.kind)).toContain('backorder_item');
    // 状態変更は外して、入荷待ちの記録だけ承認しても再提案されない
    await inv.applyProposal(p.automationId, p.key, p.actions.filter((a) => a.kind === 'backorder_item').map((a) => a.id));
    d = await service.loadSnapshot();
    expect(d.reservations.filter((r) => r.key === `replacement:${inquiry.id}`)).toHaveLength(1);
    expect(proposals(d).filter((x) => x.automationId === 'failure-replacement' && x.inquiryId === inquiry.id)).toHaveLength(0);
    expect(d.purchaseSuggestions.some((s) => s.itemId === holder.itemId && s.status === 'open')).toBe(true);
  });

  it('状況が変わった古い提案は実行せず、失敗を処理履歴に残す（全体を取り消し）', async () => {
    const { service, inv } = await setup();
    const d = await service.loadSnapshot();
    const p = proposals(d).find((x) => x.automationId === 'onboarding-equipment')!;
    // 先に別の操作で未使用PCを貸し出してしまう → 提案の前提が変わる
    const emp = d.employees.find((e) => e.status === 'active')!;
    for (const a of d.assets.filter((x) => x.status === 'unused')) await inv.assignAsset(a.id, emp.id);
    await expect(inv.applyProposal(p.automationId, p.key, p.actions.map((a) => a.id))).rejects.toThrow('状況が変わった');
    const after = await service.loadSnapshot();
    expect(after.automationRuns.some((r) => r.status === 'failed')).toBe(true);
    expect(after.reservations.filter((r) => r.status === 'active')).toHaveLength(0); // 部分的な予約が残っていない
  });

  it('提案はデータの並び順に依存しない（承認時の再計算で同じ提案になる）', async () => {
    const { service } = await setup();
    const d = await service.loadSnapshot();
    const shuffled = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, [...(v as unknown[])].reverse()])) as unknown as DataSnapshot;
    const keys = (x: DataSnapshot) => proposals(x).map((p) => `${p.automationId}|${p.key}`).sort();
    expect(keys(shuffled)).toEqual(keys(d));
    expect(keys(d).length).toBeGreaterThanOrEqual(5);
  });

  it('見送った提案は再表示しない', async () => {
    const { service, inv } = await setup();
    const d = await service.loadSnapshot();
    const p = proposals(d).find((x) => x.automationId === 'retirement-return')!;
    await inv.dismissProposal(p.automationId, p.key, p.title);
    expect(proposals(await service.loadSnapshot()).some((x) => x.key === p.key)).toBe(false);
  });
});

describe('削除と履歴', () => {
  it('履歴のある品目は削除せず無効化、在庫が残る品目は拒否', async () => {
    const { service, inv } = await setup();
    await expect(inv.removeItem(ITEM.paper)).rejects.toThrow('在庫が');
    await inv.adjust({ itemId: ITEM.headset, locationId: LOC.it, actualQuantity: 0, reason: '廃棄' });
    expect(await inv.removeItem(ITEM.headset)).toBe('deactivated');
    const d = await service.loadSnapshot();
    expect(d.items.find((i) => i.id === ITEM.headset)?.active).toBe(false);
    expect(d.stockMovements.some((m) => m.itemId === ITEM.headset)).toBe(true); // 履歴は残る
    const created = await inv.saveItem({ code: 'TMP-1', name: '一時品目', category: 'other', maker: '', model: '', unit: '個', tracking: 'quantity', minStock: 0, targetStock: 0, unitPrice: 0, defaultLocationId: null, defaultSupplierId: null, notes: '' });
    expect(await inv.removeItem(created.id)).toBe('deleted');
  });
});

describe('マイグレーション（v2 → v3）とバックアップ', () => {
  it('Phase 2 のデータを保持したまま在庫ストアを追加する', async () => {
    const name = `mig3_${generateId()}`;
    const v2 = await openWorkCoreDB(name, 2);
    const p = createDemoData(TODAY);
    const tx = v2.transaction(['employees', 'inquiries', 'meta'], 'readwrite');
    for (const e of p.employees) await tx.objectStore('employees').put(e);
    for (const i of p.inquiries) await tx.objectStore('inquiries').put(i);
    await tx.objectStore('meta').put({ key: 'initialized', value: 'x' });
    await tx.done;
    v2.close();
    const v3 = await openWorkCoreDB(name);
    expect(v3.version).toBe(DB_VERSION);
    const service = new WorkCoreService(v3, () => TODAY);
    expect(await service.ensureInitialized()).toBe(false);
    const d = await service.loadSnapshot();
    expect(d.employees).toHaveLength(p.employees.length);
    expect(d.inquiries).toHaveLength(p.inquiries.length);
    expect(d.items).toEqual([]);
    expect(d.locations.length).toBe(3);
    expect(await service.inventory.addInventoryDemo()).toBeGreaterThan(5);
    await expect(service.inventory.addInventoryDemo()).rejects.toThrow('既に品目');
    expectLedgerConsistent(await service.loadSnapshot());
    v3.close();
    const raw = await openDB(name);
    expect(raw.objectStoreNames.contains('stockMovements')).toBe(true);
    raw.close();
  });

  it('v3 バックアップの往復で在庫が一致し、台帳と在庫の不一致（改ざん）を検出する', async () => {
    const a = await setup();
    await a.inv.issue({ itemId: ITEM.paper, quantity: 5, locationId: LOC.main, reason: '' });
    const snap = await a.service.loadSnapshot();
    const r = parseBackupText(JSON.stringify(createBackup(snap)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = await setup();
    await b.service.restoreBackup(r.backup);
    const restored = await b.service.loadSnapshot();
    expect(status(restored, ITEM.paper).onHand).toBe(30);
    expectLedgerConsistent(restored);
    const tampered = { ...snap, stockLevels: snap.stockLevels.map((l) => (l.itemId === ITEM.paper ? { ...l, quantity: l.quantity + 100 } : l)) };
    const bad = parseBackupText(JSON.stringify(createBackup(tampered)));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join()).toContain('一致しません');
  });

  it('Phase 2 (v2) のバックアップも復元できる', async () => {
    const p = createDemoData(TODAY);
    const v2 = { app: 'WorkCore', schemaVersion: 2, exportedAt: '', data: { departments: p.departments, employees: p.employees, tasks: p.tasks, rules: p.rules, activities: [], inquiries: p.inquiries, faqs: p.faqs, inquiryCategories: p.inquiryCategories } };
    const r = parseBackupText(JSON.stringify(v2));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.backup.data.items).toEqual([]);
  });
});
