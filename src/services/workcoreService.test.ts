import { describe, expect, it } from 'vitest';
import { createService, TODAY } from '../test/helpers';
import { computeDashboard } from '../domain/analytics';
import { createBackup, parseBackupText } from '../data/backup';
import { employeesToCsv, tasksToCsv, UTF8_BOM } from '../data/csv';
import { DEPT } from '../demo/demoData';
import { AppError } from './workcoreService';
import type { EmployeeInput } from '../domain/validation';

const newHire = (over: Partial<EmployeeInput> = {}): EmployeeInput => ({
  employeeNumber: 'N2026-01',
  name: '新入 花子',
  departmentId: DEPT.eigyo,
  position: '',
  employmentType: '正社員',
  hireDate: '2026-11-02',
  retireDate: null,
  status: 'pending',
  notes: '',
  ...over,
});

describe('WorkCoreService: 業務シナリオ', () => {
  it('初回起動時にデモデータを投入し、2回目以降は投入しない', async () => {
    const { service } = await createService();
    expect(await service.ensureInitialized()).toBe(true);
    const snap = await service.loadSnapshot();
    expect(snap.employees.length).toBeGreaterThan(10);
    expect(snap.tasks.length).toBeGreaterThan(0);
    expect(await service.ensureInitialized()).toBe(false);
  });

  it('社員登録 → 入社準備タスク自動生成 → 編集 → 完了 → ダッシュボード反映', async () => {
    const { service } = await createService();
    await service.ensureInitialized();
    const before = computeDashboard(await service.loadSnapshot(), TODAY);

    // 1. 新入社員登録
    const emp = await service.createEmployee(newHire());
    expect(emp.employeeNumber).toBe('N2026-01');

    // 2. プレビュー → 登録
    const plan = await service.previewOnboarding(emp.id);
    expect(plan.summary.newCount).toBe(9); // 共通7 + 営業部2
    const created = await service.applyOnboarding(emp.id, {});
    expect(created).toHaveLength(9);

    // 再生成しても重複しない
    const again = await service.previewOnboarding(emp.id);
    expect(again.summary.newCount).toBe(0);
    await expect(service.applyOnboarding(emp.id, {})).rejects.toBeInstanceOf(AppError);

    // 3. 編集
    const pc = created.find((t) => t.title === 'PC準備')!;
    const edited = await service.updateTask(pc.id, { ...pc, assignee: '小林 美咲', priority: 'medium' });
    expect(edited.assignee).toBe('小林 美咲');

    // 4. 完了
    const doneTask = await service.setTaskStatus(pc.id, 'done');
    expect(doneTask.completedAt).not.toBeNull();

    // 5. ダッシュボード
    const after = computeDashboard(await service.loadSnapshot(), TODAY);
    expect(after.employeeCount).toBe(before.employeeCount + 1);
    expect(after.pendingHireCount).toBe(before.pendingHireCount + 1);
    expect(after.totalTaskCount).toBe(before.totalTaskCount + 9);
    expect(after.doneTaskCount).toBe(before.doneTaskCount + 1);
    expect(after.openTaskCount).toBe(before.openTaskCount + 8);
    expect(after.hireProgress.find((h) => h.employee.id === emp.id)).toMatchObject({ total: 9, done: 1 });

    // 完了を戻すと completedAt がクリアされる
    expect((await service.setTaskStatus(pc.id, 'in_progress')).completedAt).toBeNull();

    // 操作履歴が記録されている
    const snap = await service.loadSnapshot();
    expect(snap.activities[0]?.message).toContain('進行中');
    expect(snap.activities.some((a) => a.message.includes('自動生成'))).toBe(true);
  });

  it('社員番号の重複を防止する（大文字小文字・全角も同一視）', async () => {
    const { service } = await createService();
    await service.ensureInitialized();
    await service.createEmployee(newHire({ employeeNumber: 'abc-1' }));
    await expect(service.createEmployee(newHire({ employeeNumber: 'ＡＢＣ-1' }))).rejects.toThrow('既に登録');
    // 自分自身の番号での更新は許可
    const e = await service.createEmployee(newHire({ employeeNumber: 'Z9' }));
    await expect(service.updateEmployee(e.id, newHire({ employeeNumber: 'z9', name: '改名' }))).resolves.toMatchObject({ name: '改名' });
    await expect(service.updateEmployee(e.id, newHire({ employeeNumber: 'ABC-1' }))).rejects.toThrow('既に登録');
  });

  it('入力値検証エラーはフィールド単位で返る', async () => {
    const { service } = await createService();
    await service.ensureInitialized();
    try {
      await service.createEmployee(newHire({ name: ' ', hireDate: '2026-02-30', status: 'retired' }));
      expect.fail('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      const fe = (e as AppError).fieldErrors;
      expect(fe.name).toBeDefined();
      expect(fe.hireDate).toBeDefined();
      expect(fe.retireDate).toBeDefined();
    }
  });

  it('社員削除時に関連タスクも削除される', async () => {
    const { service } = await createService();
    await service.ensureInitialized();
    const emp = await service.createEmployee(newHire());
    await service.applyOnboarding(emp.id, {});
    const { deletedTasks } = await service.deleteEmployee(emp.id);
    expect(deletedTasks).toBe(9);
    const snap = await service.loadSnapshot();
    expect(snap.tasks.some((t) => t.employeeId === emp.id)).toBe(false);
  });

  it('使用中の部署は削除できない', async () => {
    const { service } = await createService();
    await service.ensureInitialized();
    await expect(service.deleteDepartment(DEPT.eigyo)).rejects.toThrow('使用中');
    const d = await service.addDepartment('法務部');
    await expect(service.addDepartment('法務部')).rejects.toThrow('既に存在');
    await service.deleteDepartment(d.id);
    expect((await service.loadSnapshot()).departments.some((x) => x.id === d.id)).toBe(false);
  });

  it('ルール変更が次回の自動生成に反映される', async () => {
    const { service } = await createService();
    await service.ensureInitialized();
    await service.saveRule({
      title: '営業研修の手配',
      description: '',
      scope: DEPT.eigyo,
      assigneeDepartmentId: DEPT.eigyo,
      defaultAssignee: '高橋 誠',
      priority: 'medium',
      offsetDays: 3,
      employmentTypes: [],
      enabled: true,
    });
    const emp = await service.createEmployee(newHire());
    const plan = await service.previewOnboarding(emp.id);
    expect(plan.items.find((i) => i.title === '営業研修の手配')).toMatchObject({ status: 'new', dueDate: '2026-11-05' });
  });
});

describe('バックアップ・CSV', () => {
  it('JSONバックアップ → 別DBへ復元でデータが一致する', async () => {
    const a = await createService();
    await a.service.ensureInitialized();
    await a.service.createEmployee(newHire());
    const snap = await a.service.loadSnapshot();
    const text = JSON.stringify(createBackup(snap));

    const parsed = parseBackupText(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.counts.employees).toBe(snap.employees.length);

    const b = await createService();
    await b.service.ensureInitialized();
    await b.service.restoreBackup(parsed.backup);
    const restored = await b.service.loadSnapshot();
    expect(restored.employees.map((e) => e.id).sort()).toEqual(snap.employees.map((e) => e.id).sort());
    expect(restored.tasks.length).toBe(snap.tasks.length);
    // 復元後も初回デモ投入はされない
    expect(await b.service.ensureInitialized()).toBe(false);
  });

  it('不正なバックアップは拒否する', () => {
    expect(parseBackupText('not json').ok).toBe(false);
    expect(parseBackupText('{"app":"Other"}').ok).toBe(false);
    const bad = parseBackupText(
      JSON.stringify({ app: 'WorkCore', schemaVersion: 1, data: { departments: [], employees: [{ id: 1 }], tasks: [], rules: [], activities: [] } }),
    );
    expect(bad.ok).toBe(false);
  });

  it('参照整合性の崩れたバックアップは拒否する', async () => {
    const { service } = await createService();
    await service.ensureInitialized();
    const snap = await service.loadSnapshot();
    const broken = { ...snap, departments: snap.departments.filter((d) => d.id !== DEPT.eigyo) };
    const r = parseBackupText(JSON.stringify(createBackup(broken)));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('所属部署が存在しません');
  });

  it('CSVはBOM付き・エスケープ済みで出力される', async () => {
    const { service } = await createService();
    await service.ensureInitialized();
    await service.createEmployee(newHire({ notes: '備考,カンマ"引用"\n改行', name: '=危険 入力' }));
    const snap = await service.loadSnapshot();
    const csv = employeesToCsv(snap);
    expect(csv.startsWith(UTF8_BOM)).toBe(true);
    expect(csv).toContain('"備考,カンマ""引用""\n改行"');
    expect(csv).toContain("'=危険 入力");
    expect(csv.split('\r\n')[0]).toBe(`${UTF8_BOM}社員番号,氏名,所属部署,役職,雇用区分,入社日,退職日,在籍ステータス,備考`);
    expect(tasksToCsv(snap).startsWith(UTF8_BOM)).toBe(true);
  });
});
