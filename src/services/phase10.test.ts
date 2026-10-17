/**
 * Phase 10: 業務フローの改善 (再入力・往復の削減) のうち、サービス層で保証するもの。
 */
import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { createService } from '../test/helpers';

describe('退職：資産の返却と返却確認タスクを1回の操作で完了する', () => {
  it('指定した返却確認タスクだけを、返却と同じ操作で完了にする。別の資産のタスク・完了済みは変えない', async () => {
    const { service, db } = await createService();
    await service.ensureInitialized();
    const d = await service.loadSnapshot();
    const [a1, a2] = d.assets.filter((a) => a.status === 'in_use');
    const base = { employeeId: a1!.assigneeId, description: '', assigneeDepartmentId: null, assignee: '', priority: 'medium' as const, dueDate: null, status: 'todo' as const, source: 'automation' as const, inquiryId: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', completedAt: null };
    await db.put('tasks', { ...base, id: 't_ret1', title: '返却確認1', ruleId: `return:${a1!.id}:x`, assetId: a1!.id });
    await db.put('tasks', { ...base, id: 't_ret2', title: '返却確認2', ruleId: `return:${a2!.id}:x`, assetId: a2!.id });
    // 別の資産のタスクを指定しても完了にしない
    await service.inventory.returnAsset(a1!.id, 'unused', '', undefined, { completeTaskIds: ['t_ret1', 't_ret2'] });
    const after = await service.loadSnapshot();
    expect(after.tasks.find((t) => t.id === 't_ret1')).toMatchObject({ status: 'done' });
    expect(after.tasks.find((t) => t.id === 't_ret1')?.completedAt).toBeTruthy();
    expect(after.tasks.find((t) => t.id === 't_ret2')?.status).toBe('todo');
    expect(after.assets.find((a) => a.id === a1!.id)?.status).toBe('unused');
    expect(after.activities.some((x) => x.message.includes('資産の返却とあわせて完了'))).toBe(true);
    // 指定しなければ従来どおりタスクは変えない
    await service.inventory.returnAsset(a2!.id, 'unused', '');
    expect((await service.loadSnapshot()).tasks.find((t) => t.id === 't_ret2')?.status).toBe('todo');
  });
});
