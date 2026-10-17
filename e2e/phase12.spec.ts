/**
 * Phase 12 E2E: 一覧の段階表示 (性能) と、営業日の設定。
 */
import { expect, test, type Page } from './fixtures';

async function gotoHash(page: Page, hash: string) {
  await page.evaluate((h) => (window.location.hash = h), hash);
}
async function start(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
}
async function addTasks(page: Page, n: number) {
  await page.evaluate(async (n) => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('workcore');
      q.onsuccess = () => r(q.result);
    });
    await new Promise<void>((r) => {
      const tx = db.transaction('tasks', 'readwrite');
      for (let i = 0; i < n; i++)
        tx.objectStore('tasks').put({ id: `bulk_${String(i).padStart(4, '0')}`, employeeId: null, title: `大量のタスク ${String(i).padStart(4, '0')}`, description: '', assigneeDepartmentId: null, assignee: '', priority: 'low', dueDate: null, status: 'todo', source: 'manual', ruleId: null, inquiryId: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', completedAt: null });
      tx.oncomplete = () => r();
    });
    db.close();
  }, n);
}

test('[Phase12] 一覧は100件ずつ表示し「さらに表示」で追加。通知などから100件目より後のタスクへ移動しても表示される', async ({ page }) => {
  await start(page);
  await addTasks(page, 250);
  await page.reload();
  await gotoHash(page, '#/tasks?status=nodue');
  const items = page.locator('[data-testid="task-list"] [data-testid="task-item"]');
  await expect(page.getByTestId('task-count')).toContainText(/\d+件を表示/);
  const total = Number((await page.getByTestId('task-count').textContent())!.match(/(\d+)件を表示/)![1]);
  expect(total).toBeGreaterThan(250);
  await expect(items).toHaveCount(100);
  await page.getByTestId('task-show-more').click();
  await expect(items).toHaveCount(200);
  // 検索を変えると先頭から表示し直す
  await page.getByLabel('タスクを検索').fill('大量のタスク 02');
  await expect(items).toHaveCount(50);
  await expect(page.getByTestId('task-show-more')).toHaveCount(0);
  // 末尾付近のタスクを直接開く (focus) → 100件を超えていても表示・強調される
  await page.getByLabel('タスクを検索').fill('');
  await gotoHash(page, '#/tasks?status=nodue&focus=bulk_0249');
  await expect(page.locator('[data-focus-id="bulk_0249"]')).toBeVisible();
});

test('[Phase12] 営業日の設定：会社の休業日を追加すると、祝日・休業日を避けて期限が決まる', async ({ page }) => {
  await start(page);
  await gotoHash(page, '#/settings');
  const card = page.getByTestId('calendar-settings');
  await expect(card).toContainText('これからの祝日');
  await expect(card).toContainText('2026/11/3(火) 文化の日');
  // 2026/10/16(金) を休業日に → 問い合わせの対応期限 (受付から営業日で数える) が休業日を避ける
  await card.getByTestId('company-holiday-input').fill('2026-10-16');
  await card.getByTestId('company-holiday-add').click();
  await expect(card.getByTestId('company-holidays')).toContainText('2026/10/16(金)');
  await card.getByTestId('company-holiday-yearend').click();
  await expect(card.getByTestId('company-holidays')).toContainText('2027/1/3(日)');
  // 再読み込み後も保持
  await page.reload();
  await gotoHash(page, '#/settings');
  await expect(page.getByTestId('company-holidays')).toContainText('2026/10/16(金)');
  // 問い合わせの対応期限の初期値 (受付日 10/15(木) から3営業日)：10/16 が休業日なので 10/19・10/20・10/21 → 10/21
  await gotoHash(page, '#/helpdesk/new');
  await expect(page.getByLabel('対応期限')).toHaveValue('2026-10-21');
  // 外すと 10/16・10/19・10/20 → 10/20
  await gotoHash(page, '#/settings');
  await page.getByTestId('company-holidays').getByRole('button', { name: '2026/10/16(金) を休業日から外す' }).click();
  await expect(page.getByTestId('company-holidays')).not.toContainText('2026/10/16(金)');
  await gotoHash(page, '#/helpdesk/new');
  await expect(page.getByLabel('対応期限')).toHaveValue('2026-10-20');
});
