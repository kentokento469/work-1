/**
 * 実ブラウザでのDBマイグレーション検証 (Phase 1 版で作ったデータを Phase 2 版で開く)。
 *
 * 実行方法 (同一オリジンに旧版・新版を配置する必要があるため通常のテストでは skip):
 *   1. Phase 1 (main) を <site>/p1/ に、Phase 2 を <site>/p2/ にビルド
 *   2. <site> を静的配信 (例: python3 -m http.server 4180 -d <site>)
 *   3. MIGRATION_SITE_URL=http://localhost:4180 npx playwright test e2e/migration.spec.ts --project=iphone
 */
import { expect, test } from '@playwright/test';

const SITE = process.env.MIGRATION_SITE_URL;

test('[Migration] Phase 1 のデータを保持したまま Phase 2 に移行できる', async ({ page }) => {
  test.skip(!SITE, 'MIGRATION_SITE_URL が未設定のため skip');

  // Phase 1 版で社員を追加し、タスクを完了にする
  await page.goto(`${SITE}/p1/#/employees`);
  await expect(page.getByRole('heading', { name: '社員管理' })).toBeVisible();
  await page.getByRole('button', { name: '新規登録' }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('社員番号').fill('MIG-001');
  await d.getByLabel('氏名').fill('移行 確認');
  await d.getByLabel('所属部署').selectOption({ label: '経理部' });
  await d.getByLabel('入社日').fill('2026-12-01');
  await d.getByRole('button', { name: '登録する' }).click();
  await expect(page.getByText('移行 確認さんを登録しました')).toBeVisible();
  const p1Counts = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('workcore');
      q.onsuccess = () => r(q.result);
    });
    const count = (s: string) => new Promise<number>((r) => { const c = db.transaction(s).objectStore(s).count(); c.onsuccess = () => r(c.result); });
    const v = { version: db.version, employees: await count('employees'), tasks: await count('tasks') };
    db.close();
    return v;
  });
  expect(p1Counts.version).toBe(1);

  // Phase 2 版で開く → v2 へ自動移行
  await page.goto(`${SITE}/p2/#/employees?q=移行`);
  await expect(page.getByTestId('employee-count')).toHaveText('1名を表示');
  const p2Counts = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('workcore');
      q.onsuccess = () => r(q.result);
    });
    const count = (s: string) => new Promise<number>((r) => { const c = db.transaction(s).objectStore(s).count(); c.onsuccess = () => r(c.result); });
    const tasks = await new Promise<{ inquiryId?: unknown }[]>((r) => { const c = db.transaction('tasks').objectStore('tasks').getAll(); c.onsuccess = () => r(c.result); });
    return { version: db.version, employees: await count('employees'), tasks: await count('tasks'), categories: await count('inquiryCategories'), inquiries: await count('inquiries'), allHaveInquiryId: tasks.every((t) => t.inquiryId === null) };
  });
  expect(p2Counts).toMatchObject({ version: 2, employees: p1Counts.employees, tasks: p1Counts.tasks, inquiries: 0, allHaveInquiryId: true });
  expect(p2Counts.categories).toBeGreaterThanOrEqual(9);

  // 既存データを残したままヘルプデスクのデモを追加
  await page.goto(`${SITE}/p2/#/data`);
  await page.getByTestId('add-helpdesk-demo').click();
  await expect(page.getByText(/ヘルプデスクのデモデータ（問い合わせ\d+件）を追加しました/)).toBeVisible();
  await page.goto(`${SITE}/p2/#/employees?q=移行`);
  await expect(page.getByTestId('employee-count')).toHaveText('1名を表示');
  await page.goto(`${SITE}/p2/#/helpdesk?status=all`);
  await expect(page.getByTestId('inquiry-list').locator('li').first()).toBeVisible();
});
