/**
 * Phase 9 E2E: データ整合性・保護・復旧。
 * 社員の削除で完了済みタスクを残す・複数タブの変更の反映と編集の競合・暗号化バックアップ・直前のデータに戻す・
 * データの点検と修復・保存容量不足の表示。
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, testNow, type Page } from './fixtures';

async function gotoHash(page: Page, hash: string) {
  await page.evaluate((h) => (window.location.hash = h), hash);
}
async function start(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
}
/** IndexedDB に直接レコードを書く (旧版の不具合で残ったデータ・別の操作で作られたデータの再現) */
async function putRecords(page: Page, store: string, records: unknown[]) {
  await page.evaluate(
    async ({ store, records }) => {
      const db = await new Promise<IDBDatabase>((r) => {
        const q = indexedDB.open('workcore');
        q.onsuccess = () => r(q.result);
      });
      await new Promise<void>((r) => {
        const tx = db.transaction(store, 'readwrite');
        for (const rec of records) tx.objectStore(store).put(rec);
        tx.oncomplete = () => r();
      });
      db.close();
    },
    { store, records },
  );
}
async function getAll<T>(page: Page, store: string): Promise<T[]> {
  return page.evaluate(async (store) => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('workcore');
      q.onsuccess = () => r(q.result);
    });
    const rows = await new Promise<unknown[]>((r) => {
      const q = db.transaction(store).objectStore(store).getAll();
      q.onsuccess = () => r(q.result);
    });
    db.close();
    return rows;
  }, store) as Promise<T[]>;
}
const at = '2026-10-01T09:00:00.000Z';
const task = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  employeeId: null,
  title,
  description: '',
  assigneeDepartmentId: null,
  assignee: '',
  priority: 'medium',
  dueDate: null,
  status: 'todo',
  source: 'manual',
  ruleId: null,
  inquiryId: null,
  createdAt: at,
  updatedAt: at,
  completedAt: null,
  ...extra,
});
const item = (page: Page, title: string) => page.locator(`[data-testid="task-list"] [data-task-title="${title}"]`);
/** ダイアログを閉じた時の履歴の処理が終わってから再読み込みする */
async function settledReload(page: Page) {
  await expect.poll(() => page.evaluate(() => (history.state as { wcModal?: string } | null)?.wcModal ?? null)).toBeNull();
  await page.reload();
}

test('[Phase9] 社員の削除：未完了のタスクは削除、完了済みのタスクは業務履歴として残す（元に戻すと関連付けも戻る）', async ({ page }) => {
  await start(page);
  const [base] = await getAll<{ id: string; departmentId: string } & Record<string, unknown>>(page, 'employees');
  await putRecords(page, 'employees', [{ ...base, id: 'emp_p9', employeeNumber: 'P9-001', name: '削除 テスト', contact: undefined }]);
  await putRecords(page, 'tasks', [
    task('task_p9_open', '削除される未完了タスク', { employeeId: 'emp_p9' }),
    task('task_p9_done', '残る完了済みタスク', { employeeId: 'emp_p9', status: 'done', completedAt: at }),
  ]);
  await page.reload();
  await gotoHash(page, '#/employees/emp_p9');
  await page.getByRole('button', { name: '削除' }).first().click();
  const dlg = page.getByRole('dialog', { name: '社員を削除しますか？' });
  await expect(dlg.getByTestId('delete-plan-remove')).toContainText('未完了のタスク 1件');
  await expect(dlg.getByTestId('delete-plan-keep')).toContainText('完了済みのタスク 1件は業務履歴として残します');
  await dlg.getByRole('button', { name: '削除する' }).click();
  await expect(page.getByText('削除 テストさんを削除しました')).toBeVisible();

  let tasks = await getAll<{ id: string; employeeId: string | null; formerEmployee?: { name: string } }>(page, 'tasks');
  expect(tasks.some((t) => t.id === 'task_p9_open')).toBe(false);
  expect(tasks.find((t) => t.id === 'task_p9_done')).toMatchObject({ employeeId: null, formerEmployee: { name: '削除 テスト' } });
  await gotoHash(page, '#/tasks?status=done');
  await expect(item(page, '残る完了済みタスク').getByTestId('former-employee')).toContainText('削除 テスト（削除済みの社員）');

  // 元に戻す
  await page.getByRole('status').filter({ hasText: '削除 テストさんを削除しました' }).getByRole('button', { name: '元に戻す' }).click();
  await expect(page.getByText('元に戻しました')).toBeVisible();
  tasks = await getAll(page, 'tasks');
  expect(tasks.find((t) => t.id === 'task_p9_done')?.employeeId).toBe('emp_p9');
  expect(tasks.some((t) => t.id === 'task_p9_open')).toBe(true);
});

test('[Phase9] 複数タブ：別のタブの保存が自動で反映され、同じタスクの同時編集は競合として止めて選ばせる', async ({ page, context }) => {
  await start(page);
  await gotoHash(page, '#/tasks');
  await page.getByTestId('quick-add-input').fill('競合のテスト');
  await page.getByTestId('quick-add-submit').click();
  await expect(page.getByText('「競合のテスト」を追加しました')).toBeVisible();

  const b = await context.newPage();
  await b.clock.install({ time: testNow() });
  await b.goto('/#/tasks');
  await expect(item(b, '競合のテスト')).toBeVisible();

  // タブAで編集フォームを開いたまま、タブBで同じタスクを変更して保存
  await item(page, '競合のテスト').getByRole('button').first().click();
  const dlgA = page.getByRole('dialog', { name: 'タスクの編集' });
  await dlgA.getByLabel('タスク名').fill('タブAの変更');
  await item(b, '競合のテスト').getByRole('button').first().click();
  const dlgB = b.getByRole('dialog', { name: 'タスクの編集' });
  await dlgB.getByLabel('タスク名').fill('タブBの変更');
  await dlgB.getByTestId('task-save').click();
  await expect(b.getByText('タスクを更新しました')).toBeVisible();

  // タブAには自動で反映される (再読み込み不要)。入力中のフォームは消えない
  await expect(page.getByText('別のタブでの変更を反映しました')).toBeVisible();
  await expect(dlgA.getByLabel('タスク名')).toHaveValue('タブAの変更');

  // タブAで保存 → 黙って上書きせず、競合を表示
  await dlgA.getByTestId('task-save').click();
  await expect(dlgA.getByTestId('edit-conflict')).toBeVisible();
  let titles = (await getAll<{ title: string }>(page, 'tasks')).map((t) => t.title);
  expect(titles).toContain('タブBの変更');
  expect(titles).not.toContain('タブAの変更');
  // 最新の内容を読み込む → タブBの変更がフォームに入る → 入力し直して保存できる
  await dlgA.getByTestId('conflict-load-latest').click();
  await expect(dlgA.getByLabel('タスク名')).toHaveValue('タブBの変更');
  await dlgA.getByLabel('タスク名').fill('タブBの変更＋タブAの追記');
  await dlgA.getByTestId('task-save').click();
  await expect(page.getByText('タスクを更新しました')).toBeVisible();
  // タブBにも自動で反映
  await expect(item(b, 'タブBの変更＋タブAの追記')).toBeVisible();
  titles = (await getAll<{ title: string }>(page, 'tasks')).map((t) => t.title);
  expect(titles.filter((t) => t.startsWith('タブB'))).toEqual(['タブBの変更＋タブAの追記']);
});

test('[Phase9] 暗号化バックアップ → 全削除 → 誤ったパスワードは拒否 → 正しいパスワードで復元 → 直前のデータに戻す', async ({ page }) => {
  test.setTimeout(90_000);
  await start(page);
  await gotoHash(page, '#/data');
  await expect(page.getByTestId('safety-empty')).toBeVisible();
  const employees = (await getAll<{ name: string }>(page, 'employees')).length;
  const anyName = (await getAll<{ name: string }>(page, 'employees'))[0]!.name;

  await page.getByTestId('backup-encrypt').check();
  await page.getByTestId('backup-password').fill('short');
  await page.getByTestId('backup-password2').fill('short');
  await page.getByTestId('export-json').click();
  await expect(page.getByText('パスワードは8文字以上にしてください')).toBeVisible();
  await page.getByTestId('backup-password').fill('workcore-pass-2026');
  await page.getByTestId('backup-password2').fill('workcore-pass-2026');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-json').click()]);
  expect(dl.suggestedFilename()).toMatch(/\.encrypted\.json$/);
  const path = join(mkdtempSync(join(tmpdir(), 'workcore-p9-')), dl.suggestedFilename());
  await dl.saveAs(path);
  const raw = readFileSync(path, 'utf8');
  expect(JSON.parse(raw).format).toBe('WorkCore-encrypted-backup');
  expect(raw).not.toContain(anyName); // 氏名などが平文で含まれない

  await page.getByRole('button', { name: /全削除/ }).click();
  await page.getByRole('button', { name: '全削除する' }).click();
  await expect(page.getByText('社員・タスクを全削除しました')).toBeVisible();
  expect(await getAll(page, 'employees')).toHaveLength(0);
  await expect(page.getByTestId('safety-card')).toContainText('全削除');

  await page.getByTestId('restore-input').setInputFiles(path);
  const dec = page.getByRole('dialog', { name: '暗号化されたバックアップ' });
  await dec.getByTestId('decrypt-password').fill('wrong-password');
  await dec.getByTestId('decrypt-submit').click();
  await expect(dec).toContainText('パスワードが違うか');
  await dec.getByTestId('decrypt-password').fill('workcore-pass-2026');
  await dec.getByTestId('decrypt-submit').click();
  const confirm = page.getByRole('dialog', { name: 'バックアップから復元しますか？' });
  await expect(confirm).toContainText(`社員：0 → ${employees}件`);
  await expect(confirm).toContainText('現在のデータをこの端末に自動で退避');
  await confirm.getByRole('button', { name: '上書きして復元' }).click();
  await expect(page.getByText('バックアップから復元しました').first()).toBeVisible();
  expect(await getAll(page, 'employees')).toHaveLength(employees);

  // 直前のデータ (= 全削除後の空の状態) に戻す → もう一度で復元後に戻る
  await expect(page.getByTestId('safety-card')).toContainText('バックアップから復元');
  await expect(page.getByTestId('safety-card')).toContainText('社員0名');
  await page.getByTestId('safety-restore').click();
  await page.getByRole('dialog', { name: '直前のデータに戻しますか？' }).getByRole('button', { name: 'このデータに戻す' }).click();
  await expect(page.getByText('直前のデータに戻しました')).toBeVisible();
  expect(await getAll(page, 'employees')).toHaveLength(0);
  await page.getByTestId('safety-restore').click();
  await page.getByRole('dialog', { name: '直前のデータに戻しますか？' }).getByRole('button', { name: 'このデータに戻す' }).click();
  await expect.poll(async () => (await getAll(page, 'employees')).length).toBe(employees);
  // 再読み込み後も残る
  await settledReload(page);
  await gotoHash(page, '#/data');
  await expect(page.getByTestId('safety-card')).toContainText('直前のデータに戻す');
});

test('[Phase9] データの点検：参照切れを見つけて修復する。業務データは消えない', async ({ page }) => {
  await start(page);
  await putRecords(page, 'tasks', [task('task_p9_dangling', '参照切れのタスク', { projectId: 'prj_deleted', employeeId: 'emp_deleted' })]);
  await page.reload();
  await gotoHash(page, '#/data');
  await page.getByTestId('integrity-check').click();
  const result = page.getByTestId('integrity-result');
  await expect(result).toContainText('削除済みのデータを指したままの関連付けがあります');
  await page.getByTestId('integrity-repair').click();
  await expect(page.getByText(/関連付けを修復しました/)).toBeVisible();
  await expect(result).toContainText('問題は見つかりませんでした');
  const t = (await getAll<{ id: string; projectId: string | null; employeeId: string | null }>(page, 'tasks')).find((x) => x.id === 'task_p9_dangling');
  expect(t).toMatchObject({ projectId: null, employeeId: null });
});

test('[Phase9] 保存容量が不足したとき：理由と対処を表示し、データは変更しない。空きができれば保存できる', async ({ page }) => {
  await start(page);
  await gotoHash(page, '#/tasks');
  const before = (await getAll(page, 'tasks')).length;
  // 端末の容量不足を再現 (書き込みが QuotaExceededError になる)
  await page.evaluate(() => {
    const w = window as unknown as { __put?: typeof IDBObjectStore.prototype.put };
    w.__put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.add = IDBObjectStore.prototype.put = function () {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    } as never;
  });
  await page.getByTestId('quick-add-input').fill('容量不足のテスト');
  await page.getByTestId('quick-add-submit').click();
  await expect(page.getByText(/保存容量が不足しているため保存できませんでした/)).toBeVisible();
  // 入力内容は残っている (やり直せる)
  await expect(page.getByTestId('quick-add-input')).toHaveValue('容量不足のテスト');
  await page.evaluate(() => {
    const w = window as unknown as { __put: typeof IDBObjectStore.prototype.put };
    IDBObjectStore.prototype.put = w.__put;
  });
  await page.reload();
  expect((await getAll(page, 'tasks')).length).toBe(before);
});

test('[Phase9] ブラウザによる自動削除からの保護の状態を表示する', async ({ page }) => {
  await start(page);
  await gotoHash(page, '#/data');
  await expect(page.getByTestId('persist-status')).toContainText(/保護：(有効|無効|確認できません)/);
});
