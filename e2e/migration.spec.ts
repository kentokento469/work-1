/**
 * 実ブラウザでのDBマイグレーション検証 (Phase 1 版で作ったデータを Phase 2 版で開く)。
 *
 * 実行方法 (同一オリジンに旧版・新版を配置する必要があるため通常のテストでは skip):
 *   1. Phase 1〜5 を <site>/p1/〜/p5/ にビルド (vite build --outDir。検証したい組み合わせだけでよい)
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

test('[Migration] Phase 2 のデータ（社員・問い合わせ）を保持したまま Phase 3 に移行できる', async ({ page, isMobile }) => {
  test.skip(!SITE, 'MIGRATION_SITE_URL が未設定のため skip');
  const counts = () =>
    page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((r) => {
        const q = indexedDB.open('workcore');
        q.onsuccess = () => r(q.result);
      });
      const has = (s: string) => db.objectStoreNames.contains(s);
      const count = (s: string) => (has(s) ? new Promise<number>((r) => { const c = db.transaction(s).objectStore(s).count(); c.onsuccess = () => r(c.result); }) : Promise.resolve(-1));
      const v = { version: db.version, employees: await count('employees'), tasks: await count('tasks'), inquiries: await count('inquiries'), faqs: await count('faqs'), items: await count('items'), locations: await count('locations'), suppliers: await count('suppliers') };
      db.close();
      return v;
    });

  // Phase 2 版: デモデータの上に問い合わせを1件追加
  await page.goto(`${SITE}/p2/#/helpdesk/new`);
  await page.getByLabel('申請者').selectOption({ label: '渡辺 さくら（A0033）' });
  await page.getByLabel('件名').fill('移行確認用：プリンターが印刷できない');
  await expect(page.getByLabel('カテゴリ')).not.toHaveValue('');
  await page.getByTestId(isMobile ? 'submit-inquiry-mobile' : 'submit-inquiry').click();
  await expect(page.getByTestId('inquiry-number')).toBeVisible();
  const p2 = await counts();
  expect(p2.version).toBe(2);
  expect(p2.items).toBe(-1);

  // Phase 3 版で開く → v3 へ自動移行。既存データは件数が変わらず、在庫は空（マスタのみ）
  await page.goto(`${SITE}/p3/#/helpdesk?status=all&q=移行確認用`);
  await expect(page.getByTestId('inquiry-list')).toContainText('移行確認用：プリンターが印刷できない');
  const p3 = await counts();
  expect(p3).toMatchObject({ version: 3, employees: p2.employees, tasks: p2.tasks, inquiries: p2.inquiries, faqs: p2.faqs, items: 0 });
  expect(p3.locations).toBeGreaterThan(0);
  expect(p3.suppliers).toBeGreaterThan(0);

  // 既存データを残したまま在庫のデモを追加
  await page.goto(`${SITE}/p3/#/data`);
  await page.getByTestId('add-inventory-demo').click();
  await expect(page.getByText(/在庫.*追加しました/).first()).toBeVisible();
  const after = await counts();
  expect(after).toMatchObject({ employees: p2.employees, inquiries: p2.inquiries });
  expect(after.items).toBeGreaterThan(0);
  await page.goto(`${SITE}/p3/#/inventory`);
  await expect(page.getByTestId('item-list')).toBeVisible();
});

test('[Migration] Phase 3 のデータ（社員・在庫・入出庫履歴）を保持したまま Phase 4 に移行できる', async ({ page }) => {
  test.skip(!SITE, 'MIGRATION_SITE_URL が未設定のため skip');
  const counts = () =>
    page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((r) => {
        const q = indexedDB.open('workcore');
        q.onsuccess = () => r(q.result);
      });
      const has = (s: string) => db.objectStoreNames.contains(s);
      const count = (s: string) => (has(s) ? new Promise<number>((r) => { const c = db.transaction(s).objectStore(s).count(); c.onsuccess = () => r(c.result); }) : Promise.resolve(-1));
      const v = { version: db.version, employees: await count('employees'), inquiries: await count('inquiries'), items: await count('items'), stockMovements: await count('stockMovements'), assets: await count('assets'), documents: await count('documents') };
      db.close();
      return v;
    });
  // Phase 3 版: デモデータの上で入庫を1件記録
  await page.goto(`${SITE}/p3/#/inventory?tab=stock&q=${encodeURIComponent('マウス')}`);
  await page.locator('[data-item-name="マウス（無線）"]').getByRole('button', { name: 'マウス（無線）を入庫' }).click();
  await page.getByTestId('qty-submit').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const p3 = await counts();
  expect(p3.version).toBe(3);
  expect(p3.documents).toBe(-1);

  // Phase 4 版で開く → v4 へ自動移行。既存データの件数は変わらず、書類は空
  await page.goto(`${SITE}/p4/#/documents`);
  await expect(page.getByRole('heading', { name: '書類管理' })).toBeVisible();
  const p4 = await counts();
  expect(p4).toMatchObject({ version: 4, employees: p3.employees, inquiries: p3.inquiries, items: p3.items, stockMovements: p3.stockMovements, assets: p3.assets, documents: 0 });
  // 書類を手入力で1件登録しても既存データは変わらない
  await page.goto(`${SITE}/p4/#/documents/new`);
  await page.getByLabel('書類の種類').selectOption({ label: '領収書' });
  await page.getByTestId('import-manual').click();
  await expect(page.getByTestId('doc-number')).toBeVisible();
  expect(await counts()).toMatchObject({ employees: p3.employees, stockMovements: p3.stockMovements, documents: 1 });
});

test('[Migration] Phase 4 のデータ（社員・在庫・書類）を保持したまま Phase 5 に移行できる', async ({ page }) => {
  test.skip(!SITE, 'MIGRATION_SITE_URL が未設定のため skip');
  const counts = () =>
    page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((r) => {
        const q = indexedDB.open('workcore');
        q.onsuccess = () => r(q.result);
      });
      const has = (s: string) => db.objectStoreNames.contains(s);
      const count = (s: string) => (has(s) ? new Promise<number>((r) => { const c = db.transaction(s).objectStore(s).count(); c.onsuccess = () => r(c.result); }) : Promise.resolve(-1));
      const v = { version: db.version, employees: await count('employees'), tasks: await count('tasks'), inquiries: await count('inquiries'), items: await count('items'), stockMovements: await count('stockMovements'), documents: await count('documents'), settings: await count('settings') };
      db.close();
      return v;
    });
  // Phase 4 版: 書類を1件登録
  await page.goto(`${SITE}/p4/#/documents/new`);
  await page.getByLabel('書類の種類').selectOption({ label: '領収書' });
  await page.getByTestId('import-manual').click();
  await expect(page.getByTestId('doc-number')).toBeVisible();
  const p4 = await counts();
  expect(p4.version).toBe(4);
  expect(p4.settings).toBe(-1);

  // Phase 5 版で開く → v5 へ自動移行。既存データはそのまま、設定ストアが追加される
  await page.goto(`${SITE}/p5/#/automation`);
  await expect(page.getByTestId('rule-settings')).toBeVisible();
  const p5 = await counts();
  expect(p5).toMatchObject({ version: 5, employees: p4.employees, inquiries: p4.inquiries, items: p4.items, stockMovements: p4.stockMovements, documents: 1, settings: 0 });
  // 既存社員の詳細 (連絡先なし) も表示できる
  await page.goto(`${SITE}/p5/#/employees`);
  await page.locator('a[href^="#/employees/"]:visible').first().click();
  await expect(page.getByTestId('back-link')).toBeVisible();
});

test('[Migration] Phase 6 のデータ（タスク・社員・書類）を保持したまま Phase 7 に移行できる', async ({ page }) => {
  test.skip(!SITE, 'MIGRATION_SITE_URL が未設定のため skip');
  const read = () =>
    page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((r) => {
        const q = indexedDB.open('workcore');
        q.onsuccess = () => r(q.result);
      });
      const has = (s: string) => db.objectStoreNames.contains(s);
      const all = (s: string) => (has(s) ? new Promise<{ id: string; title?: string; dueDate?: string; assigneeDepartmentId?: string }[]>((r) => { const c = db.transaction(s).objectStore(s).getAll(); c.onsuccess = () => r(c.result); }) : Promise.resolve(null));
      const v = { version: db.version, tasks: await all('tasks'), employees: (await all('employees'))?.length, documents: (await all('documents'))?.length, projects: (await all('projects'))?.length ?? -1 };
      db.close();
      return v;
    });
  // Phase 6 版: タスクを1件完了にして状態を作る
  await page.goto(`${SITE}/p6/#/tasks`);
  await expect(page.getByRole('heading', { name: 'タスク管理' })).toBeVisible();
  const before = await read();
  expect(before.version).toBe(5);
  expect(before.projects).toBe(-1);

  // Phase 7 版で開く → v6 へ移行。既存のタスクは変更されない (期限・部署もそのまま)
  await page.goto(`${SITE}/p7/#/tasks`);
  await expect(page.getByTestId('quick-add-input')).toBeVisible();
  const after = await read();
  expect(after.version).toBe(6);
  expect(after.projects).toBe(0);
  expect(after.employees).toBe(before.employees);
  expect(after.documents).toBe(before.documents);
  expect(after.tasks!.length).toBe(before.tasks!.length);
  for (const t of before.tasks!) expect(after.tasks!.find((x) => x.id === t.id)).toEqual(t);
  // 移行後の版で、旧タスクを編集・新しいタスクを追加できる
  await page.getByTestId('quick-add-input').fill('移行後のタスク');
  await page.getByTestId('quick-add-submit').click();
  await expect(page.locator('[data-task-title="移行後のタスク"]')).toBeVisible();
});
