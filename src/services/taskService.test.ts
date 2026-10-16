import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { createService, TODAY } from '../test/helpers';
import { openWorkCoreDB } from '../data/db';
import { createBackup, validateBackup } from '../data/backup';
import { tasksToCsv } from '../data/csv';
import { generateId } from '../domain/id';
import type { TaskInput } from '../domain/validation';

async function setup() {
  const { service, db } = await createService();
  await service.ensureInitialized();
  return { s: service, db };
}
const simple = (title: string, extra: Partial<TaskInput> = {}): TaskInput => ({ employeeId: null, title, description: '', assigneeDepartmentId: null, assignee: '', priority: 'medium', dueDate: null, status: 'todo', ...extra });

describe('Phase 7: 汎用タスク', () => {
  it('タスク名だけで登録できる（社員・部署・期限なし）。期限なしは期限超過にならない', async () => {
    const { s } = await setup();
    const t = await s.createTask(simple('  資料を作成する  '));
    expect(t).toMatchObject({ title: '資料を作成する', assigneeDepartmentId: null, dueDate: null, employeeId: null, status: 'todo', source: 'manual' });
    const d = await s.loadSnapshot();
    expect(d.tasks.find((x) => x.id === t.id)).toBeTruthy();
    const { isTaskOverdue } = await import('../domain/analytics');
    expect(isTaskOverdue(t, '2099-01-01')).toBe(false);
  });

  it('タグ・チェックリスト・開始日・プロジェクトを保存し、不正な値は保存しない', async () => {
    const { s } = await setup();
    const p = await s.tasks.saveProject({ name: 'テスト案件', description: '' });
    const t = await s.createTask(simple('PCを準備', { tags: ['IT', ' IT ', '重要'], checklist: [{ id: '', text: 'OS更新', done: false }, { id: '', text: '  ', done: false }], startDate: '2026-10-20', dueDate: '2026-10-25', projectId: p.id }));
    expect(t.tags).toEqual(['IT', '重要']);
    expect(t.checklist?.map((c) => c.text)).toEqual(['OS更新']);
    expect(t.projectId).toBe(p.id);
    await expect(s.createTask(simple('x', { startDate: '2026-10-30', dueDate: '2026-10-25' }))).rejects.toThrow('開始日は期限以前');
    await expect(s.createTask(simple('x', { projectId: 'prj_missing' }))).rejects.toThrow('プロジェクトが存在しません');
    await expect(s.createTask(simple('x', { recurrence: { freq: 'weekly', interval: 1 } }))).rejects.toThrow('期限を設定');
    const done = await s.tasks.toggleChecklistItem(t.id, t.checklist![0]!.id, true);
    expect(done.checklist![0]!.done).toBe(true);
  });

  it('サブタスクは1段まで。親の削除でサブタスクも削除され、元に戻すと一緒に戻る。親の完了時にサブタスクも完了できる', async () => {
    const { s } = await setup();
    const parent = await s.createTask(simple('新しい社員用PCを準備'));
    const a = await s.createTask(simple('PCを用意', { parentTaskId: parent.id }));
    await s.createTask(simple('動作確認', { parentTaskId: parent.id }));
    await expect(s.createTask(simple('孫', { parentTaskId: a.id }))).rejects.toThrow('1段まで');
    const deleted = await s.deleteTask(parent.id);
    expect(deleted.removedSubtasks).toHaveLength(2);
    expect((await s.loadSnapshot()).tasks.filter((t) => t.parentTaskId === parent.id)).toHaveLength(0);
    await s.restoreTask(deleted);
    expect((await s.loadSnapshot()).tasks.filter((t) => t.parentTaskId === parent.id)).toHaveLength(2);
    await s.setTaskStatus(parent.id, 'done', { completeSubtasks: true });
    expect((await s.loadSnapshot()).tasks.filter((t) => t.parentTaskId === parent.id).every((t) => t.status === 'done')).toBe(true);
  });

  it('依存関係: 循環・自分自身は作れない', async () => {
    const { s } = await setup();
    const buy = await s.createTask(simple('機器を購入'));
    const setupT = await s.createTask(simple('初期設定', { dependsOn: [buy.id] }));
    await expect(s.updateTask(buy.id, { ...simple('機器を購入'), dependsOn: [setupT.id] })).rejects.toThrow('循環');
    await expect(s.updateTask(buy.id, { ...simple('機器を購入'), dependsOn: [buy.id] })).rejects.toThrow('自分自身');
    // 存在しない前提は除外して保存する
    const t = await s.updateTask(setupT.id, { ...simple('初期設定'), dependsOn: [buy.id, 'task_missing'] });
    expect(t.dependsOn).toEqual([buy.id]);
  });

  it('繰り返し: 完了で次回を1件だけ作る（完了→未完了→完了でも重複しない）。履歴は残る', async () => {
    const { s } = await setup();
    const t = await s.createTask(simple('経費を確認する', { dueDate: '2026-10-31', recurrence: { freq: 'monthly', interval: 1, monthDay: 'last' } }));
    const r1 = await s.setTaskStatus(t.id, 'done');
    expect(r1.nextOccurrence?.dueDate).toBe('2026-11-30');
    await s.setTaskStatus(t.id, 'todo');
    const r2 = await s.setTaskStatus(t.id, 'done');
    expect(r2.nextOccurrence).toBeNull();
    const d = await s.loadSnapshot();
    const series = d.tasks.filter((x) => (x.seriesId ?? x.id) === t.id);
    expect(series).toHaveLength(2);
    expect(series.filter((x) => x.status === 'done')).toHaveLength(1);
    // 次回の完了でその次 (12/31) を作る
    const r3 = await s.setTaskStatus(r1.nextOccurrence!.id, 'done');
    expect(r3.nextOccurrence?.dueDate).toBe('2026-12-31');
    // 編集で周期を止めると次回は作られない
    const n4 = r3.nextOccurrence!;
    await s.updateTask(n4.id, { ...simple(n4.title, { dueDate: n4.dueDate }), recurrence: null });
    expect((await s.setTaskStatus(n4.id, 'done')).nextOccurrence).toBeNull();
  });

  it('複製・期限の変更・プロジェクト削除（タスクは残る）と元に戻す', async () => {
    const { s } = await setup();
    const p = await s.tasks.saveProject({ name: 'P', description: '' });
    const t = await s.createTask(simple('見積取得', { projectId: p.id, checklist: [{ id: '', text: 'A社', done: true }] }));
    const c = await s.tasks.duplicateTask(t.id);
    expect(c).toMatchObject({ title: '見積取得（コピー）', status: 'todo', projectId: p.id });
    expect(c.checklist![0]!.done).toBe(false);
    expect((await s.tasks.setDueDate(t.id, '2026-11-01')).dueDate).toBe('2026-11-01');
    const del = await s.tasks.deleteProject(p.id);
    let d = await s.loadSnapshot();
    expect(d.projects.some((x) => x.id === p.id)).toBe(false);
    expect(d.tasks.filter((x) => x.id === t.id || x.id === c.id).every((x) => x.projectId === null)).toBe(true);
    await s.tasks.restoreProject(del);
    d = await s.loadSnapshot();
    expect(d.tasks.filter((x) => x.projectId === p.id)).toHaveLength(2);
  });

  it('旧形式 (v5) のデータ・バックアップを読み込める。v6 のバックアップは往復できる。CSV に新しい列', async () => {
    // v5 の DB を作ってから v6 で開く
    const name = `mig_${generateId()}`;
    const v5 = await openWorkCoreDB(name, 5);
    await v5.put('tasks', { id: 'task_old', employeeId: null, title: '旧タスク', description: '', assigneeDepartmentId: 'dept_soumu', assignee: '', priority: 'low', dueDate: '2026-10-01', status: 'todo', source: 'manual', ruleId: null, inquiryId: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', completedAt: null });
    v5.close();
    const v6 = await openWorkCoreDB(name);
    expect(v6.objectStoreNames.contains('projects')).toBe(true);
    expect((await v6.get('tasks', 'task_old'))?.title).toBe('旧タスク');
    v6.close();

    const { s } = await setup();
    await s.tasks.saveProject({ name: 'P', description: '' });
    await s.createTask(simple('新タスク', { tags: ['IT'] }));
    const d = await s.loadSnapshot();
    const b = JSON.parse(JSON.stringify(createBackup(d)));
    expect(b.schemaVersion).toBe(6);
    expect(validateBackup(b).ok).toBe(true);
    const old = { ...b, schemaVersion: 5, data: { ...b.data } };
    delete old.data.projects;
    old.data.tasks = old.data.tasks.filter((t: { projectId?: string }) => !t.projectId);
    const v = validateBackup(old);
    expect(v.ok).toBe(true);
    expect(tasksToCsv(d).split('\n')[0]).toContain('プロジェクト');
    expect(TODAY).toBe('2026-10-15');
  });
});
