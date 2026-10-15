import { describe, expect, it } from 'vitest';
import { createService, TODAY } from '../test/helpers';
import { pendingProposals } from '../automation/engine';
import { ALL_AUTOMATIONS } from '../automation/registry';
import { readAutomationSettings, ruleSetting } from '../automation/settings';
import { computeAllStock } from '../domain/inventory/stock';
import type { DataSnapshot } from '../domain/types';

async function setup() {
  const { service } = await createService();
  await service.ensureInitialized();
  return service;
}
const proposals = (d: DataSnapshot, id: string) => {
  const settings = readAutomationSettings(d);
  return pendingProposals(ALL_AUTOMATIONS, { data: d, today: TODAY, stock: computeAllStock(d.items, d) }, (x) => ruleSetting(ALL_AUTOMATIONS.find((a) => a.id === x)!, settings).enabled).filter((p) => p.automationId === id);
};
const newHire = { employeeNumber: 'T5001', name: '連携 太郎', departmentId: 'dept_eigyo', position: '', employmentType: '正社員' as const, hireDate: '2026-11-02', retireDate: null, status: 'pending' as const, notes: '' };

describe('新入社員 → 入社準備タスク', () => {
  it('社員を登録すると提案が出て、承認すると入社準備タスク（source: onboarding）が作られる', async () => {
    const s = await setup();
    const emp = await s.createEmployee(newHire);
    let d = await s.loadSnapshot();
    const p = proposals(d, 'onboarding-tasks').find((x) => x.employeeId === emp.id)!;
    expect(p.actions.length).toBe(9); // 共通7件＋営業部2件 (Phase 1 のルール)
    expect(p.actions.every((a) => !a.requiresApproval)).toBe(true);
    await s.inventory.applyProposal(p.automationId, p.key, p.actions.map((a) => a.id));
    d = await s.loadSnapshot();
    const tasks = d.tasks.filter((t) => t.employeeId === emp.id);
    expect(tasks).toHaveLength(9);
    expect(tasks.every((t) => t.source === 'onboarding' && t.ruleId)).toBe(true);
    // Phase 1 の入社準備画面からは「作成済み」と判定される (同じ仕組みで重複を防ぐ)
    const plan = await s.previewOnboarding(emp.id);
    expect(plan.summary.newCount).toBe(0);
    expect(proposals(d, 'onboarding-tasks').some((x) => x.employeeId === emp.id)).toBe(false);
  });

  it('同じ提案は二重に実行されない（連続実行・処理済みの再実行）', async () => {
    const s = await setup();
    const emp = await s.createEmployee(newHire);
    const d = await s.loadSnapshot();
    const p = proposals(d, 'onboarding-tasks').find((x) => x.employeeId === emp.id)!;
    const ids = p.actions.map((a) => a.id);
    const results = await Promise.allSettled([s.inventory.applyProposal(p.automationId, p.key, ids), s.inventory.applyProposal(p.automationId, p.key, ids)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await expect(s.inventory.applyProposal(p.automationId, p.key, ids)).rejects.toThrow('処理済み');
    expect((await s.loadSnapshot()).tasks.filter((t) => t.employeeId === emp.id)).toHaveLength(9);
  });

  it('「自動で実行」にすると登録後に自動でタスクが作られ、何度呼んでも1回だけ', async () => {
    const s = await setup();
    await s.saveRuleSetting('onboarding-tasks', { enabled: true, mode: 'auto' });
    const emp = await s.createEmployee(newHire);
    const first = await s.runAutoAutomations();
    expect(first.some((r) => r.title.includes('連携 太郎'))).toBe(true);
    const again = await Promise.all([s.runAutoAutomations(), s.runAutoAutomations()]);
    expect(again.flat().filter((r) => r.title.includes('連携 太郎'))).toHaveLength(0);
    const d = await s.loadSnapshot();
    expect(d.tasks.filter((t) => t.employeeId === emp.id)).toHaveLength(9);
    expect(d.automationRuns.some((r) => r.automationId === 'onboarding-tasks' && r.status === 'auto')).toBe(true);
  });

  it('無効にした自動化は提案しない。承認が必要な自動化は自動実行にできない', async () => {
    const s = await setup();
    await s.createEmployee(newHire);
    await s.saveRuleSetting('onboarding-tasks', { enabled: false, mode: 'confirm' });
    expect(proposals(await s.loadSnapshot(), 'onboarding-tasks')).toHaveLength(0);
    await expect(s.saveRuleSetting('onboarding-equipment', { enabled: true, mode: 'auto' })).rejects.toThrow('確認が必要');
    await expect(s.inventory.applyProposal('onboarding-equipment', 'x', ['y'], { auto: true })).rejects.toThrow('自動では実行できません');
  });
});

describe('退職予定者 → 退職手続きタスク', () => {
  it('退職日を設定すると、アカウント確認・書類・社員証のタスクを提案（アカウントの停止そのものは行わない）', async () => {
    const s = await setup();
    let d = await s.loadSnapshot();
    const emp = d.employees.find((e) => e.status === 'active' && !e.retireDate)!;
    await s.updateEmployee(emp.id, { ...emp, retireDate: '2026-11-13' });
    d = await s.loadSnapshot();
    const p = proposals(d, 'retirement-procedures').find((x) => x.employeeId === emp.id)!;
    expect(p.actions.map((a) => a.label).join()).toContain('アカウント停止の確認');
    expect(p.warnings.join()).toContain('実行しません');
    await s.inventory.applyProposal(p.automationId, p.key, p.actions.map((a) => a.id));
    d = await s.loadSnapshot();
    expect(d.tasks.filter((t) => t.employeeId === emp.id && t.ruleId?.startsWith('retire:'))).toHaveLength(3);
    expect(proposals(d, 'retirement-procedures').some((x) => x.employeeId === emp.id)).toBe(false);
  });
});

describe('設定の保存', () => {
  it('設定は settings ストアに保存され、全削除しても残る', async () => {
    const s = await setup();
    await s.saveRuleSetting('retirement-procedures', { enabled: true, mode: 'auto' });
    await s.clearBusinessData();
    const d = await s.loadSnapshot();
    expect(readAutomationSettings(d)['retirement-procedures']).toEqual({ enabled: true, mode: 'auto' });
  });
});
