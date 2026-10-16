/**
 * Phase 9: データ整合性・保護・復旧。
 * 社員の削除方針・編集の競合検出・上書き前の退避・整合性の点検と修復・バックアップの暗号化・旧版からの段階的な移行。
 */
import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { createService } from '../test/helpers';
import { createBackup, validateBackup } from '../data/backup';
import { decryptBackupText, encryptBackupText, isEncryptedBackupText, validatePassword } from '../data/backupCrypto';
import { DB_VERSION, openWorkCoreDB } from '../data/db';
import { generateId } from '../domain/id';
import { tasksToCsv } from '../data/csv';
import { AppError, classifyStorageError, storageErrorMessage } from './common';
import { WorkCoreService, planEmployeeTaskDeletion } from './workcoreService';

const simple = { employeeId: null, description: '', assigneeDepartmentId: null, assignee: '', priority: 'medium' as const, dueDate: null, status: 'todo' as const };

async function setup() {
  const { service, db } = await createService();
  await service.ensureInitialized();
  return { s: service, db };
}
/** 機器の貸与・予約がなく削除できる社員 */
async function deletableEmployee(s: WorkCoreService) {
  const d = await s.loadSnapshot();
  return d.employees.find((e) => !d.assets.some((a) => a.assigneeId === e.id && (a.status === 'in_use' || a.status === 'reserved')) && !d.reservations.some((r) => r.employeeId === e.id && (r.status === 'active' || r.status === 'backorder')))!;
}
async function expectClean(s: WorkCoreService) {
  expect(await s.checkIntegrity()).toEqual({ errors: [], repairs: [] });
}

describe('社員の削除：完了済みのタスクは業務履歴として残す (A6)', () => {
  it('未完了のタスクとそのサブタスクは削除、完了済みは関連付けを外して氏名を残す。元に戻すと元どおり', async () => {
    const { s } = await setup();
    const emp = await deletableEmployee(s);
    const open = await s.createTask({ ...simple, title: '未完了', employeeId: emp.id });
    const openSub = await s.createTask({ ...simple, title: '未完了の子（完了済み）', parentTaskId: open.id, status: 'done' });
    const done = await s.createTask({ ...simple, title: '完了済み', employeeId: emp.id, status: 'done' });
    const doneSub = await s.createTask({ ...simple, title: '完了済みの子（未完了）', parentTaskId: done.id });
    const before = await s.loadSnapshot();
    const plan = planEmployeeTaskDeletion(emp.id, before.tasks);
    expect(plan.remove.map((t) => t.id)).toEqual(expect.arrayContaining([open.id, openSub.id]));
    expect(plan.keep.map((t) => t.id)).toContain(done.id);
    expect(plan.keep.every((t) => t.status === 'done')).toBe(true);

    const del = await s.deleteEmployee(emp.id);
    let d = await s.loadSnapshot();
    const ids = new Set(d.tasks.map((t) => t.id));
    expect(ids.has(open.id) || ids.has(openSub.id)).toBe(false);
    const kept = d.tasks.find((t) => t.id === done.id)!;
    expect(kept.employeeId).toBeNull();
    expect(kept.formerEmployee).toEqual({ id: emp.id, name: emp.name, employeeNumber: emp.employeeNumber });
    // 残したタスクの未完了のサブタスクは、親から対象社員を引き継いでいるため「その社員の未完了タスク」として削除される
    expect(ids.has(doneSub.id)).toBe(false);
    expect(d.activities[0]!.message).toContain('完了済みのタスク');
    // 削除後のバックアップは修復なしで復元できる。CSV には削除時点の氏名
    await expectClean(s);
    expect(tasksToCsv(d)).toContain(`${emp.name}（削除済み）`);

    await s.restoreEmployee(del);
    d = await s.loadSnapshot();
    expect(d.tasks.find((t) => t.id === done.id)?.employeeId).toBe(emp.id);
    expect(d.tasks.find((t) => t.id === done.id)?.formerEmployee).toBeUndefined();
    expect(d.tasks.find((t) => t.id === open.id)?.employeeId).toBe(emp.id);
    expect(d.tasks.some((t) => t.id === openSub.id)).toBe(true);
    expect(d.tasks.some((t) => t.id === doneSub.id)).toBe(true);
    await expectClean(s);
  });
});

describe('編集の競合検出 (A7：別のタブ・画面の変更を黙って上書きしない)', () => {
  it('タスク：フォームを開いた後に変更されていたら保存しない。最新の更新日時なら保存できる', async () => {
    const { s } = await setup();
    const t = await s.createTask({ ...simple, title: '元の名前' });
    // 別のタブで変更 (更新日時が変わる)
    await new Promise((r) => setTimeout(r, 5));
    const other = await s.updateTask(t.id, { ...simple, title: '別のタブで変更' });
    const err = await s.updateTask(t.id, { ...simple, title: 'このタブで変更' }, { expectedUpdatedAt: t.updatedAt }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('conflict');
    expect((await s.loadSnapshot()).tasks.find((x) => x.id === t.id)?.title).toBe('別のタブで変更');
    // 最新を確認したうえで上書き
    const saved = await s.updateTask(t.id, { ...simple, title: 'このタブで変更' }, { expectedUpdatedAt: other.updatedAt });
    expect(saved.title).toBe('このタブで変更');
  });

  it('社員：同様に競合を検出する。指定しなければ従来どおり保存する', async () => {
    const { s } = await setup();
    const emp = (await s.loadSnapshot()).employees[0]!;
    const input = { employeeNumber: emp.employeeNumber, name: emp.name, departmentId: emp.departmentId, position: emp.position, employmentType: emp.employmentType, hireDate: emp.hireDate, retireDate: emp.retireDate, status: emp.status, notes: emp.notes };
    await new Promise((r) => setTimeout(r, 5));
    await s.updateEmployee(emp.id, { ...input, notes: '別のタブ' });
    const err = await s.updateEmployee(emp.id, { ...input, notes: 'このタブ' }, { expectedUpdatedAt: emp.updatedAt }).catch((e) => e);
    expect((err as AppError).code).toBe('conflict');
    await s.updateEmployee(emp.id, { ...input, notes: '指定なし' });
    expect((await s.loadSnapshot()).employees.find((e) => e.id === emp.id)?.notes).toBe('指定なし');
  });
});

describe('保存の失敗の説明 (A10)', () => {
  it('容量不足・接続切れ・重複・中断を区別し、元のデータが残っていることを伝える', () => {
    const quota = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    expect(classifyStorageError(quota)).toBe('quota');
    expect(storageErrorMessage(quota)).toContain('保存容量が不足');
    expect(storageErrorMessage(quota)).toContain('元のデータは残っています');
    expect(classifyStorageError(new DOMException('x', 'InvalidStateError'))).toBe('unavailable');
    expect(classifyStorageError(new DOMException('x', 'ConstraintError'))).toBe('conflict');
    expect(classifyStorageError(new DOMException('x', 'AbortError'))).toBe('aborted');
    expect(classifyStorageError(new Error('なにか'))).toBe('unknown');
    expect(storageErrorMessage(new Error('なにか'))).toContain('変更をすべて取り消しました');
  });

  it('複数のレコードを書き換える操作は、途中で失敗するとすべて取り消す (A8)', async () => {
    const { s, db } = await setup();
    const emp = await deletableEmployee(s);
    await s.createTask({ ...simple, title: '未完了', employeeId: emp.id });
    const before = await s.loadSnapshot();
    // 削除の途中 (書類の関連付けの解除) で同期的な例外を起こす
    const orig = db.transaction.bind(db);
    const created: { done: Promise<void> }[] = [];
    (db as unknown as { transaction: unknown }).transaction = ((stores: never, mode: never) => {
      const tx = orig(stores, mode);
      created.push(tx);
      const os = tx.objectStore.bind(tx);
      (tx as unknown as { objectStore: unknown }).objectStore = (name: string) => {
        if (name === 'documents') throw new Error('擬似的な障害');
        return os(name as never);
      };
      return tx;
    }) as never;
    const err = await s.deleteEmployee(emp.id).catch((e) => e);
    (db as unknown as { transaction: unknown }).transaction = orig;
    await Promise.all(created.map((t) => t.done.catch(() => undefined)));
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).message).toContain('変更をすべて取り消しました');
    const after = await s.loadSnapshot();
    expect(after.employees.length).toBe(before.employees.length);
    expect(after.tasks.length).toBe(before.tasks.length);
  });
});

describe('上書き前の退避と「直前のデータに戻す」', () => {
  it('初期化・全削除・復元の直前のデータを退避し、戻せる。戻す前の状態も退避されるので往復できる', async () => {
    const { s } = await setup();
    expect(await s.safety.info()).toBeNull();
    const t = await s.createTask({ ...simple, title: '消したくないタスク' });
    const before = await s.loadSnapshot();
    await s.clearBusinessData();
    expect((await s.loadSnapshot()).tasks).toHaveLength(0);
    const info = await s.safety.info();
    expect(info?.reason).toBe('全削除');
    expect(info?.counts.tasks).toBe(before.tasks.length);

    await s.restoreSafetySnapshot();
    let d = await s.loadSnapshot();
    expect(d.tasks.some((x) => x.id === t.id)).toBe(true);
    expect(d.employees.length).toBe(before.employees.length);
    // 戻す前 (全削除後) の状態が退避されている
    expect((await s.safety.info())?.counts.tasks).toBe(0);
    await s.restoreSafetySnapshot();
    expect((await s.loadSnapshot()).tasks).toHaveLength(0);

    // バックアップからの復元でも退避する
    await s.restoreSafetySnapshot();
    const backup = createBackup(await s.loadSnapshot());
    await s.resetDemoData();
    expect((await s.safety.info())?.reason).toBe('デモデータの初期化');
    await s.restoreBackup(backup);
    expect((await s.safety.info())?.reason).toBe('バックアップから復元');
    d = await s.loadSnapshot();
    expect(d.tasks.some((x) => x.id === t.id)).toBe(true);
  });

  it('退避できない場合は上書きしない', async () => {
    const { s } = await setup();
    const count = (await s.loadSnapshot()).tasks.length;
    (s.safety as unknown as { save: unknown }).save = async () => {
      throw new DOMException('quota', 'QuotaExceededError');
    };
    const err = await s.resetDemoData().catch((e) => e);
    expect((err as AppError).message).toContain('中止しました');
    expect((err as AppError).message).toContain('保存容量');
    expect((await s.loadSnapshot()).tasks.length).toBe(count);
  });
});

describe('データの点検と修復', () => {
  it('参照切れを検出し、関連付けの解除で修復する。業務データは消さない', async () => {
    const { s, db } = await setup();
    const t = await s.createTask({ ...simple, title: '参照切れ' });
    await expectClean(s);
    // 旧版の不具合などで残った参照切れを再現
    await db.put('tasks', { ...t, projectId: 'prj_missing', employeeId: 'emp_missing' });
    const r = await s.checkIntegrity();
    expect(r.errors).toEqual([]);
    expect(r.repairs.length).toBeGreaterThan(0);
    const before = (await s.loadSnapshot()).tasks.length;
    const fixed = await s.repairIntegrity();
    expect(fixed).toEqual(r.repairs);
    const d = await s.loadSnapshot();
    expect(d.tasks.length).toBe(before);
    expect(d.tasks.find((x) => x.id === t.id)).toMatchObject({ projectId: null, employeeId: null });
    expect(d.activities[0]!.message).toContain('修復');
    await expectClean(s);
    expect(await s.repairIntegrity()).toEqual([]);
  });

  it('自動で直せない問題 (必須の参照切れ) はエラーとして報告し、修復しない', async () => {
    const { s, db } = await setup();
    const emp = (await s.loadSnapshot()).employees[0]!;
    await db.put('employees', { ...emp, departmentId: 'dept_missing' });
    const r = await s.checkIntegrity();
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe('バックアップの暗号化 (A12)', () => {
  it('暗号化 → 復号で元の内容に戻る。パスワードの誤り・改ざんは復号できない', async () => {
    const { s } = await setup();
    const text = JSON.stringify(createBackup(await s.loadSnapshot()));
    const enc = await encryptBackupText(text, 'correct horse', { iterations: 1000 });
    expect(isEncryptedBackupText(enc)).toBe(true);
    expect(isEncryptedBackupText(text)).toBe(false);
    // 平文の個人情報が含まれない
    const emp = (await s.loadSnapshot()).employees[0]!;
    expect(enc).not.toContain(emp.name);
    const ok = await decryptBackupText(enc, 'correct horse');
    expect(ok.ok && ok.text).toBe(text);
    expect(validateBackup(JSON.parse(ok.ok ? ok.text : '')).ok).toBe(true);
    const wrong = await decryptBackupText(enc, 'wrong password');
    expect(wrong.ok).toBe(false);
    const file = JSON.parse(enc);
    const tampered = JSON.stringify({ ...file, data: (file.data[0] === 'A' ? 'B' : 'A') + file.data.slice(1) });
    expect((await decryptBackupText(tampered, 'correct horse')).ok).toBe(false);
    expect((await decryptBackupText('{broken', 'x')).ok).toBe(false);
    // 同じ内容・同じパスワードでも毎回異なる暗号文 (salt・IV がランダム)
    expect(await encryptBackupText(text, 'correct horse', { iterations: 1000 })).not.toBe(enc);
  });

  it('パスワードの条件', () => {
    expect(validatePassword('short', 'short')).toContain('8文字以上');
    expect(validatePassword('longenough', 'different')).toContain('一致しません');
    expect(validatePassword('longenough', 'longenough')).toBeNull();
  });
});

describe('旧版のデータベースからの段階的な移行', () => {
  const oldTask = (id: string) => ({ id, employeeId: null, title: `旧タスク ${id}`, description: '', assigneeDepartmentId: 'dept_soumu', assignee: '', priority: 'low', dueDate: '2026-10-01', status: 'todo', source: 'manual', ruleId: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', completedAt: null });

  for (const from of [1, 2, 3, 4, 5]) {
    it(`v${from} → v${DB_VERSION}：既存データを保持し、移行後のデータが整合性の点検に合格する`, async () => {
      const name = `mig_${from}_${generateId()}`;
      // 旧版で初期データを作り、その版の形式のタスクを追加する
      const old = await openWorkCoreDB(name, from);
      await old.put('departments', { id: 'dept_soumu', name: '総務部', order: 1 } as never);
      await old.put('tasks', (from === 1 ? oldTask('t1') : { ...oldTask('t1'), inquiryId: null }) as never);
      old.close();

      const db = await openWorkCoreDB(name);
      expect(db.version).toBe(DB_VERSION);
      const task = await db.get('tasks', 't1');
      expect(task?.title).toBe('旧タスク t1');
      expect(task?.inquiryId).toBeNull();
      // 各段階の移行の記録
      for (let v = Math.max(2, from + 1); v <= DB_VERSION; v++) expect(await db.get('meta', `schemaMigratedToV${v}`)).toBeTruthy();
      const s = new WorkCoreService(db, () => '2026-10-15');
      // 移行後の最初の起動で1回だけ点検し、操作履歴に残す
      const v = await s.verifyMigration();
      expect(v).toMatchObject({ from, to: DB_VERSION, errors: [], repairs: [] });
      expect((await s.loadSnapshot()).activities[0]?.message).toContain(`v${from} → v${DB_VERSION}`);
      expect(await s.verifyMigration()).toBeNull();
      expect(await s.checkIntegrity()).toEqual({ errors: [], repairs: [] });
      // 移行後に通常の操作ができる
      await s.createTask({ ...simple, title: '移行後のタスク' });
      expect((await s.loadSnapshot()).tasks).toHaveLength(2);
      db.close();
    });
  }

  it('移行の途中で失敗した場合は旧版のまま残り (部分的に移行しない)、再実行で移行できる', async () => {
    const name = `migfail_${generateId()}`;
    const v5 = await openWorkCoreDB(name, 5);
    await v5.put('tasks', { ...oldTask('t1'), inquiryId: null } as never);
    v5.close();
    // v6 への移行の途中で例外 (ストアの作成後に失敗) → 版の更新全体が取り消される
    const failed = await new Promise<string>((resolve) => {
      const req = indexedDB.open(name, 6);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('projects', { keyPath: 'id' });
        req.transaction!.abort();
      };
      req.onerror = (e) => {
        e.preventDefault();
        resolve(req.error?.name ?? 'error');
      };
      req.onsuccess = () => {
        req.result.close();
        resolve('opened');
      };
    });
    expect(failed).toBe('AbortError');
    const still = await openDB(name);
    expect(still.version).toBe(5);
    expect(still.objectStoreNames.contains('projects')).toBe(false);
    expect((await still.get('tasks', 't1'))?.title).toBe('旧タスク t1');
    still.close();
    // 再実行 (次回の起動) で正常に移行できる
    const db = await openWorkCoreDB(name);
    expect(db.version).toBe(DB_VERSION);
    expect(db.objectStoreNames.contains('projects')).toBe(true);
    expect((await db.get('tasks', 't1'))?.title).toBe('旧タスク t1');
    db.close();
  });
});
