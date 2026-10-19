/**
 * Phase 13R: 差分の反映 (ChangeTracker + loadChanges) が、全件の読み直し (loadSnapshot) と同じ結果になること。
 * 書き込みの記録の漏れ (記録されない put・カーソルでの削除など) があると、ここで差が出る
 */
import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { ChangeTracker } from './changeTracker';
import { openWorkCoreDB } from './db';
import { applyChanges } from './snapshot';
import { createBackup } from './backup';
import { generateId } from '../domain/id';
import { TODAY } from '../test/helpers';
import { WorkCoreService } from '../services/workcoreService';
import type { DataSnapshot } from '../domain/types';

const simple = { employeeId: null, description: '', assigneeDepartmentId: null, assignee: '', priority: 'medium' as const, dueDate: null, status: 'todo' as const };

async function setup() {
  const db = await openWorkCoreDB(`test_${generateId()}`);
  const tracker = new ChangeTracker();
  const s = new WorkCoreService(tracker.wrap(db), () => TODAY);
  await s.ensureInitialized();
  let data = await s.loadSnapshot();
  await tracker.take();
  /** 操作のあとに差分を反映し、全件の読み直しと比べる。変わらなかった種類は同じ配列のままであること */
  const step = async (label: string, op: () => Promise<unknown>) => {
    await op();
    const changes = await tracker.take();
    const next = await s.loadChanges(data, changes);
    const full = await s.loadSnapshot();
    expect(next, label).toEqual(full);
    for (const k of Object.keys(data) as (keyof DataSnapshot)[]) if (!(k in changes)) expect(next[k], `${label}: ${k} は同じ配列`).toBe(data[k]);
    data = next;
    return changes;
  };
  return { s, step, get data() {
    return data;
  } };
}

describe('差分の反映 = 全件の読み直し (Phase 13R)', () => {
  it('タスク: 作成・変更・完了 (繰り返しの次回)・サブタスクを含む削除。変わった種類だけを読む', async () => {
    const { s, step } = await setup();
    let parentId = '';
    const c = await step('作成', async () => (parentId = (await s.createTask({ ...simple, title: '親' })).id));
    expect(Object.keys(c).sort()).toEqual(['activities', 'tasks']);
    expect(c.tasks).toEqual([parentId]);
    await step('サブタスク', () => s.createTask({ ...simple, title: '子', parentTaskId: parentId }));
    await step('繰り返しの完了', async () => {
      const t = await s.createTask({ ...simple, title: '毎週', dueDate: '2026-10-15', recurrence: { freq: 'weekly', interval: 1 } });
      await s.setTaskStatus(t.id, 'done');
    });
    await step('サブタスクごと削除', () => s.deleteTask(parentId));
  });

  it('操作履歴の上限 (300件を超えた分はカーソルで削除される) も一致する', async () => {
    const { s, step, data } = await setup();
    await step('大量の作成', async () => {
      for (let i = 0; i < 320 - data.activities.length; i++) await s.createTask({ ...simple, title: `t${i}` });
    });
  });

  it('在庫・資産・発注・問い合わせ・社員の削除', async () => {
    const { s, step, data } = await setup();
    const item = data.items.find((i) => i.tracking === 'quantity')!;
    const loc = data.locations[0]!;
    await step('入庫', () => s.inventory.receive({ itemId: item.id, quantity: 3, locationId: loc.id, reason: 'テスト', requestId: generateId() }));
    await step('出庫', () => s.inventory.issue({ itemId: item.id, quantity: 1, locationId: loc.id, reason: 'テスト', requestId: generateId() }));
    const emp = data.employees[0]!;
    await step('問い合わせ', () =>
      s.helpdesk.createInquiry({ requesterId: emp.id, title: 'PC が遅い', body: '確認', categoryId: 'cat_pc', priority: 'medium', assignee: '', dueDate: '2026-10-20' }, { requestId: generateId(), classification: null }),
    );
    const sug = (await s.loadSnapshot()).purchaseSuggestions.find((x) => x.status === 'open');
    if (sug) await step('発注書の作成', () => s.inventory.createOrdersFromSuggestions([sug.id], '山田', generateId()));
    const free = data.employees.find((e) => !data.assets.some((a) => a.assigneeId === e.id) && !data.reservations.some((r) => r.employeeId === e.id))!;
    await step('社員の削除', () => s.deleteEmployee(free.id));
  });

  it('復元 (全削除して書き直す) は種類ごとに読み直す', async () => {
    const { s, step } = await setup();
    const backup = createBackup(await s.loadSnapshot());
    await s.createTask({ ...simple, title: '復元で消える' });
    const c = await step('復元', () => s.restoreBackup(backup));
    expect(c.tasks).toBe('all');
  });

  it('中断した書き込みは記録しない', async () => {
    const { s, step } = await setup();
    const c = await step('失敗', () => s.createTask({ ...simple, title: '' }).catch(() => undefined));
    expect(c).toEqual({});
  });
});

describe('applyChanges の並び順', () => {
  it('新しい行は並び順の位置に入り、削除した行は消える', () => {
    const prev = { tasks: [{ id: 'a' }, { id: 'c' }], activities: [{ id: 'x', at: '2026-10-02' }, { id: 'y', at: '2026-10-01' }] } as unknown as DataSnapshot;
    const next = applyChanges(prev, {
      tasks: { rows: new Map([['b', { id: 'b' }], ['c', null]]) },
      activities: { rows: new Map([['z', { id: 'z', at: '2026-10-03' } as never]]) },
    });
    expect(next.tasks.map((t) => t.id)).toEqual(['a', 'b']);
    expect(next.activities.map((t) => t.id)).toEqual(['z', 'x', 'y']);
  });
});
