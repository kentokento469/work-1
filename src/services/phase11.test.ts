/**
 * Phase 11: 自動化の処理履歴から対象へ移動できる・見送りを取り消せる。
 */
import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { createService, TODAY } from '../test/helpers';
import { INVENTORY_AUTOMATIONS } from '../automation/inventoryAutomations';
import { pendingProposals } from '../automation/engine';
import { computeAllStock } from '../domain/inventory/stock';
import { createBackup, validateBackup } from '../data/backup';

async function setup() {
  const { service } = await createService();
  await service.ensureInitialized();
  const d = await service.loadSnapshot();
  const proposals = pendingProposals(INVENTORY_AUTOMATIONS, { data: d, today: TODAY, stock: computeAllStock(d.items, d) });
  return { s: service, proposals };
}

describe('自動化の処理履歴 (Phase 11)', () => {
  it('実行した処理履歴に、作成したタスクと対象の社員が記録され、バックアップでも保たれる', async () => {
    const { s, proposals } = await setup();
    const p = proposals.find((x) => x.automationId === 'retirement-return')!;
    await s.inventory.applyProposal(p.automationId, p.key, p.actions.map((a) => a.id));
    const d = await s.loadSnapshot();
    const run = d.automationRuns.find((r) => r.key === p.key && r.status === 'applied')!;
    expect(run.targets?.[0]).toEqual({ kind: 'employee', id: p.employeeId });
    const taskTargets = run.targets!.filter((t) => t.kind === 'task');
    expect(taskTargets).toHaveLength(p.actions.length);
    for (const t of taskTargets) expect(d.tasks.some((x) => x.id === t.id)).toBe(true);
    const v = validateBackup(JSON.parse(JSON.stringify(createBackup(d))));
    expect(v.ok && v.backup.data.automationRuns.find((r) => r.id === run.id)?.targets).toEqual(run.targets);
  });

  it('見送りは取り消せる (提案がまた表示される)。見送り以外の記録は取り消せない', async () => {
    const { s, proposals } = await setup();
    const p = proposals[0]!;
    const runId = await s.inventory.dismissProposal(p.automationId, p.key, p.title);
    let d = await s.loadSnapshot();
    expect(pendingProposals(INVENTORY_AUTOMATIONS, { data: d, today: TODAY, stock: computeAllStock(d.items, d) }).some((x) => x.key === p.key)).toBe(false);
    await s.inventory.undoDismissProposal(runId);
    d = await s.loadSnapshot();
    expect(d.automationRuns.some((r) => r.id === runId)).toBe(false);
    expect(pendingProposals(INVENTORY_AUTOMATIONS, { data: d, today: TODAY, stock: computeAllStock(d.items, d) }).some((x) => x.key === p.key)).toBe(true);
    await expect(s.inventory.undoDismissProposal(runId)).rejects.toThrow('見つかりません');
  });
});

describe('個人情報の整理・エラーの分類 (Phase 11)', () => {
  it('退職者の連絡先・備考を削除し、氏名・社員番号は残す。元に戻せる。在籍中の社員は対象外', async () => {
    const { s } = await setup();
    const d = await s.loadSnapshot();
    const retired = d.employees.find((e) => e.status === 'retired')!;
    const active = d.employees.find((e) => e.status === 'active')!;
    const contact = { email: 'a@example.com', phone: '090-0000-0000', postalCode: '', prefecture: '', city: '', town: '', addressLine: '' };
    await s.updateEmployee(retired.id, { employeeNumber: retired.employeeNumber, name: retired.name, departmentId: retired.departmentId, position: retired.position, employmentType: retired.employmentType, hireDate: retired.hireDate, retireDate: retired.retireDate, status: 'retired', notes: '個人的なメモ', contact });
    await expect(s.erasePersonalData([active.id])).rejects.toThrow('退職済みではない');
    const erased = await s.erasePersonalData([retired.id]);
    let e = (await s.loadSnapshot()).employees.find((x) => x.id === retired.id)!;
    expect(e.contact).toBeUndefined();
    expect(e.notes).toBe('');
    expect(e.name).toBe(retired.name);
    expect(e.employeeNumber).toBe(retired.employeeNumber);
    expect((await s.loadSnapshot()).activities[0]!.message).toContain('個人情報の整理');
    await s.restorePersonalData(erased);
    e = (await s.loadSnapshot()).employees.find((x) => x.id === retired.id)!;
    expect(e.contact?.email).toBe('a@example.com');
    expect(e.notes).toBe('個人的なメモ');
  });

  it('エラーを分類し、利用者向けの説明に技術的な詳細を含めない', async () => {
    const { AppError, classifyError, storageErrorMessage } = await import('./common');
    expect(classifyError(new AppError('必須です', { name: '必須' }))).toBe('input');
    expect(classifyError(new AppError('競合', {}, 'conflict'))).toBe('conflict');
    expect(classifyError(new DOMException('q', 'QuotaExceededError'))).toBe('storage');
    expect(classifyError(new TypeError('Failed to fetch'))).toBe('network');
    expect(classifyError(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe('system');
    expect(storageErrorMessage(new TypeError("Cannot read properties of undefined (reading 'x')"))).not.toContain('Cannot read');
  });
});
