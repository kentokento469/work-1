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
