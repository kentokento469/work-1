/**
 * Phase 8 E2E: 異常系・境界の検証 (画面ファイルの読み込み失敗・日付の変更・複数タブ・二重操作・保存領域が使えない)。
 */
import { expect, test, type Page } from './fixtures';

async function gotoHash(page: Page, hash: string) {
  await page.evaluate((h) => (window.location.hash = h), hash);
}
async function start(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
}
async function countTasks(page: Page, title: string) {
  return page.evaluate(async (t) => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('workcore');
      q.onsuccess = () => r(q.result);
    });
    const rows = await new Promise<{ title: string }[]>((r) => {
      const q = db.transaction('tasks').objectStore('tasks').getAll();
      q.onsuccess = () => r(q.result as { title: string }[]);
    });
    db.close();
    return rows.filter((x) => x.title === t).length;
  }, title);
}

test('[Phase8] 画面ファイルを読み込めない（新しい版の公開後など）→ 真っ白にならず再読み込みを案内・再読み込みで回復', async ({ page }) => {
  // 先読み (起動1.5秒後) より前に通知センターの画面ファイルを読めなくする
  await page.route('**/assets/NotificationsPage-*.js', (r) => r.abort());
  await start(page);
  await gotoHash(page, '#/notifications');
  const box = page.getByTestId('error-boundary');
  await expect(box).toContainText('新しいバージョンが公開されています');
  // ナビは使えるまま (アプリ全体は止まらない)
  await page.locator('nav a[href="#/tasks"]:visible').first().click();
  await expect(page.getByTestId('quick-add-input')).toBeVisible();
  await page.unroute('**/assets/NotificationsPage-*.js');
  await gotoHash(page, '#/notifications');
  await page.getByRole('button', { name: '再読み込み' }).click();
  await expect(page.getByRole('heading', { name: '通知センター' })).toBeVisible();
});

test('[Phase8] 開いたまま日付が変わると、期限超過・通知の件数を計算し直す', async ({ page }) => {
  await start(page);
  await gotoHash(page, '#/tasks?status=today');
  const dueToday = await page.locator('[data-testid="task-list"] [data-testid="task-item"]').count();
  expect(dueToday).toBeGreaterThan(0);
  const badge = async () => Number((await page.locator('nav a[href="#/tasks"]:visible [data-testid="nav-badge"]').first().textContent()) ?? 0);
  const before = await badge();
  // 翌日の 9:01 まで進める (1分ごとの日付確認が動く)
  await page.clock.fastForward('24:01:00');
  await expect.poll(badge, { timeout: 10_000 }).toBeGreaterThan(before);
  await page.getByTestId('scope-overdue').click();
  await expect(page.locator('[data-testid="task-list"] [data-testid="task-item"]')).toHaveCount(before + dueToday);
});

test('[Phase8] 二重操作：追加ボタンの連打・Enter の連打でも1件だけ登録', async ({ page }) => {
  await start(page);
  await gotoHash(page, '#/tasks');
  await page.getByTestId('quick-add-input').fill('連打のテスト');
  await page.getByTestId('quick-add-submit').dblclick();
  await expect(page.getByText('「連打のテスト」を追加しました')).toBeVisible();
  await page.waitForTimeout(300);
  expect(await countTasks(page, '連打のテスト')).toBe(1);
  await page.getByTestId('quick-add-input').fill('Enterのテスト');
  await page.getByTestId('quick-add-input').press('Enter');
  await page.getByTestId('quick-add-input').press('Enter');
  await page.waitForTimeout(500);
  expect(await countTasks(page, 'Enterのテスト')).toBe(1);
});

test('[Phase8] 複数タブ：別のタブの変更は再読み込みで反映され、データは壊れない', async ({ page, context }) => {
  await start(page);
  const b = await context.newPage();
  await b.clock.install({ time: new Date('2026-10-15T09:00:00+09:00') });
  await b.goto('/#/tasks');
  await expect(b.getByTestId('quick-add-input')).toBeVisible();
  await gotoHash(page, '#/tasks');
  await page.getByTestId('quick-add-input').fill('タブAで追加');
  await page.getByTestId('quick-add-submit').click();
  await expect(page.getByText('「タブAで追加」を追加しました')).toBeVisible();
  await b.reload();
  await expect(b.locator('[data-task-title="タブAで追加"]')).toBeVisible();
  // タブBで完了 → タブAで再読み込み → 完了が反映
  await b.locator('[data-testid="task-list"] [data-task-title="タブAで追加"]').getByRole('combobox').selectOption('done');
  await page.reload();
  await page.getByTestId('scope-done').click();
  await expect(page.locator('[data-task-title="タブAで追加"]')).toBeVisible();
  expect(await countTasks(page, 'タブAで追加')).toBe(1);
});

test('[Phase8] 保存領域 (IndexedDB) が使えないブラウザでは、真っ白にせず理由と対処を表示', async ({ page }) => {
  await page.addInitScript(() => {
    // プライベートブラウズなどで IndexedDB が使えない状態を再現
    Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'データベースを開けませんでした' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('IndexedDB');
});
