/**
 * Phase 8: どの削除操作の後でも、作成したバックアップが復元できること (参照切れでバックアップが拒否されない)。
 */
import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { createService } from '../test/helpers';
import { createBackup, validateBackup } from './backup';
import type { WorkCoreService } from '../services/workcoreService';

async function setup() {
  const { service } = await createService();
  await service.ensureInitialized();
  return service;
}
async function expectRestorable(s: WorkCoreService) {
  const b = JSON.parse(JSON.stringify(createBackup(await s.loadSnapshot())));
  const v = validateBackup(b);
  expect(v.ok ? [] : v.errors).toEqual([]);
  // 削除操作そのものが参照切れを残さないこと (修復が必要なら操作側の不具合)
  expect(v.ok ? v.repairs : []).toEqual([]);
}
const simple = { employeeId: null, description: '', assigneeDepartmentId: null, assignee: '', priority: 'medium' as const, dueDate: null, status: 'todo' as const };

describe('削除後もバックアップから復元できる', () => {
  it('初期状態', async () => {
    await expectRestorable(await setup());
  });

  it('社員の削除（社員のタスクに、社員の紐付けがないサブタスクがある）', async () => {
    const s = await setup();
    const d = await s.loadSnapshot();
    const emp = d.employees.find((e) => e.status === 'pending' && !d.assets.some((a) => a.assigneeId === e.id) && !d.reservations.some((r) => r.employeeId === e.id && r.status !== 'released'))!;
    const parent = await s.createTask({ ...simple, title: '親', employeeId: emp.id });
    await s.createTask({ ...simple, title: '子', parentTaskId: parent.id, employeeId: null });
    // サブタスクは親の対象社員を引き継ぐので、明示的に外す
    const child = (await s.loadSnapshot()).tasks.find((t) => t.title === '子')!;
    await s.updateTask(child.id, { ...simple, title: '子', parentTaskId: parent.id, employeeId: null });
    await s.deleteEmployee(emp.id);
    await expectRestorable(s);
  });

  it('品目の削除（発注候補・書類の明細が参照している）', async () => {
    const s = await setup();
    const item = await s.inventory.saveItem({ code: 'TEST-1', name: 'テスト品', category: 'consumable', maker: '', model: '', unit: '個', tracking: 'quantity', minStock: 5, targetStock: 10, unitPrice: 100, defaultLocationId: null, defaultSupplierId: null, notes: '' });
    const doc = (await s.documents.create({ type: 'delivery' })).value!;
    const d = await s.loadSnapshot();
    expect(d.purchaseSuggestions.some((x) => x.itemId === item.id)).toBe(true);
    await s.documents.saveReview(doc.id, { ...d.documents.find((x) => x.id === doc.id)!, lines: [{ id: 'l1', name: 'テスト品', quantity: 1, unitPrice: 100, amount: 100, itemId: item.id }] } as never).catch(() => undefined);
    await s.inventory.removeItem(item.id);
    await expectRestorable(s);
  });

  it('問い合わせ・FAQ・ルール・タスク・プロジェクト・書類の完全削除', async () => {
    const s = await setup();
    let d = await s.loadSnapshot();
    await s.helpdesk.deleteInquiry(d.inquiries[0]!.id);
    await s.helpdesk.deleteFaq(d.faqs[0]!.id);
    await s.deleteRule(d.rules[0]!.id);
    const p = await s.tasks.saveProject({ name: 'X', description: '' });
    const t = await s.createTask({ ...simple, title: 'X', projectId: p.id });
    await s.createTask({ ...simple, title: 'X-1', parentTaskId: t.id });
    await s.deleteTask(t.id);
    await s.tasks.deleteProject(p.id);
    const doc = (await s.documents.create({ type: 'receipt' })).value!;
    await s.documents.trash?.(doc.id).catch(() => undefined);
    await s.documents.purge(doc.id).catch(() => undefined);
    d = await s.loadSnapshot();
    expect(d.inquiries.length).toBeGreaterThan(0);
    await expectRestorable(s);
  });
});

describe('既に参照切れを含むバックアップ (修正前の版で作成) も復元できる', () => {
  it('任意の参照は修復して取り込み、修復内容を返す。必須の参照切れはエラーのまま', async () => {
    const s = await setup();
    const b = JSON.parse(JSON.stringify(createBackup(await s.loadSnapshot())));
    b.data.tasks[0].parentTaskId = 'task_deleted';
    b.data.tasks[1].employeeId = 'emp_deleted';
    b.data.purchaseSuggestions.push({ ...b.data.purchaseSuggestions[0], id: 'sug_orphan', itemId: 'itm_deleted' });
    const v = validateBackup(b);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.repairs.join('\n')).toContain('独立したタスク');
    expect(v.repairs.join('\n')).toContain('発注候補を除外');
    expect(v.backup.data.tasks[0]!.parentTaskId).toBeNull();
    expect(v.backup.data.purchaseSuggestions.some((x) => x.id === 'sug_orphan')).toBe(false);
    // 社員の所属部署 (必須) の参照切れは修復しない
    b.data.employees[0].departmentId = 'dept_deleted';
    expect(validateBackup(b).ok).toBe(false);
  });
});

describe('復元の途中で失敗しても現在のデータは残る（全件を1つのトランザクションで置き換える）', () => {
  it('書き込みに失敗した復元は全体が取り消される', async () => {
    const s = await setup();
    const before = await s.loadSnapshot();
    const b = JSON.parse(JSON.stringify(createBackup(before)));
    b.data.tasks = [];
    const v = validateBackup(b);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    // 元ファイルの保存で失敗させる (キーの無いレコード → put が例外)
    await expect(s.restoreBackup(v.backup, [{ notAFile: true } as never])).rejects.toBeTruthy();
    const after = await s.loadSnapshot();
    expect(after.tasks.length).toBe(before.tasks.length);
    expect(after.employees.length).toBe(before.employees.length);
  });
});
