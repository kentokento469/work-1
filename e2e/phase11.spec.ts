/**
 * Phase 11 E2E: 自動化の処理履歴から対象へ・見送りの取り消し・退職者の個人情報の整理。
 */
import { expect, test, type Page } from './fixtures';

async function gotoHash(page: Page, hash: string) {
  await page.evaluate((h) => (window.location.hash = h), hash);
}
async function start(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
}

test('[Phase11] 自動化：実行した処理履歴から作成したタスクを開ける。見送りは「元に戻す」で取り消せる', async ({ page }) => {
  await start(page);
  await gotoHash(page, '#/automation');
  const card = page.getByTestId('proposal-card').filter({ hasText: '山田 隆さんの貸与資産の返却' });
  if ((await card.getByTestId('apply-proposal').count()) === 0) await card.locator('button[aria-expanded]').click();
  await card.getByTestId('apply-proposal').click();
  await expect(page.getByText(/承認して実行しました/)).toBeVisible();
  const targets = page.getByTestId('automation-runs').locator('li').first().getByTestId('run-targets');
  await expect(targets).toContainText('社員：山田 隆');
  await targets.getByRole('link', { name: /^タスク：/ }).first().click();
  await expect(page).toHaveURL(/#\/tasks/);
  await expect(page.locator('[data-task-title*="返却確認"]').first()).toBeVisible();

  // 見送り → 元に戻す → 提案が戻る
  await gotoHash(page, '#/automation');
  const first = page.getByTestId('proposal-card').first();
  const title = (await first.getAttribute('data-proposal-title'))!;
  if ((await first.getByRole('button', { name: '見送る', exact: true }).count()) === 0) await first.locator('button[aria-expanded]').click();
  await first.getByRole('button', { name: '見送る', exact: true }).click();
  await expect(page.locator(`[data-testid="proposal-card"][data-proposal-title="${title}"]`)).toHaveCount(0);
  await page.getByRole('status').filter({ hasText: '提案を見送りました' }).getByRole('button', { name: '元に戻す' }).click();
  await expect(page.getByRole('status').filter({ hasText: '見送りを取り消しました' })).toBeVisible();
  await expect(page.locator(`[data-testid="proposal-card"][data-proposal-title="${title}"]`)).toHaveCount(1);
});

test('[Phase11] 個人情報の整理：退職者の連絡先・備考を削除（氏名は残る）・元に戻す', async ({ page }) => {
  await start(page);
  // 退職者に連絡先がある状態を作る
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('workcore');
      q.onsuccess = () => r(q.result);
    });
    const all = await new Promise<{ id: string; status: string }[]>((r) => {
      const q = db.transaction('employees').objectStore('employees').getAll();
      q.onsuccess = () => r(q.result);
    });
    const e = all.find((x) => x.status === 'retired')!;
    await new Promise<void>((r) => {
      const tx = db.transaction('employees', 'readwrite');
      tx.objectStore('employees').put({ ...e, notes: '退職後の連絡先メモ', contact: { email: 'old@example.com', phone: '090-1111-2222', postalCode: '', prefecture: '', city: '', town: '', addressLine: '' } });
      tx.oncomplete = () => r();
    });
    db.close();
  });
  await page.reload();
  await gotoHash(page, '#/data');
  const count = Number((await page.getByTestId('retired-personal-count').textContent())!.replace(/\D/g, ''));
  expect(count).toBeGreaterThan(0);
  await page.getByTestId('erase-retired-personal').click();
  await page.getByRole('dialog', { name: '退職者の連絡先・備考を削除しますか？' }).getByRole('button', { name: '削除する' }).click();
  await expect(page.getByRole('status').filter({ hasText: /退職者\d+名の連絡先・備考を削除しました/ })).toBeVisible();
  await expect(page.getByTestId('retired-personal-count')).toHaveText('0名');
  await page.getByRole('status').filter({ hasText: '連絡先・備考を削除しました' }).getByRole('button', { name: '元に戻す' }).click();
  await expect(page.getByTestId('retired-personal-count')).toHaveText(`${count}名`);
});
