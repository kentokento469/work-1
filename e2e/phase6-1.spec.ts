/**
 * Phase 6.1 E2E: 通知から「通知が求める操作」を完了できるか (通知の約束)。
 * 画面に移動できるだけでは合格にしない。移動先で操作を実行し、通知が更新・解消されるまでを確認する。
 * iPhone 13 相当 / デスクトップ の2環境で実行する。
 */
import { expect, test, type Page } from './fixtures';

async function gotoHash(page: Page, hash: string) {
  await page.evaluate((h) => (window.location.hash = h), hash);
}
async function start(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
}
async function navBadge(page: Page, href: string): Promise<number> {
  const b = page.locator(`nav a[href="${href}"]:visible [data-testid="nav-badge"]`);
  return (await b.count()) ? Number(await b.first().innerText()) : 0;
}
async function readStore<T>(page: Page, store: string): Promise<T[]> {
  return page.evaluate(async (s) => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('workcore');
      q.onsuccess = () => r(q.result);
    });
    const rows = await new Promise<unknown[]>((r) => {
      const q = db.transaction(s).objectStore(s).getAll();
      q.onsuccess = () => r(q.result as unknown[]);
    });
    db.close();
    return rows;
  }, store) as Promise<T[]>;
}
type TaskRow = { id: string; employeeId: string | null; source: string; status: string };
/** 通知センターの未処理一覧に、その ID の通知があるか */
async function noticeExists(page: Page, id: string) {
  await gotoHash(page, '#/notifications?view=open');
  await expect(page.getByTestId('notice-list')).toBeVisible();
  return (await page.locator(`[data-testid="notice-row"][data-notice-id="${id}"]`).count()) > 0;
}
/** 通知センターから種類で1件開き、その通知 ID を返す */
async function openNotice(page: Page, type: string, filter?: string) {
  await gotoHash(page, '#/notifications?view=open');
  let row = page.locator(`[data-testid="notice-row"][data-notice-type="${type}"]`);
  if (filter) row = row.filter({ hasText: filter });
  const id = (await row.first().getAttribute('data-notice-id'))!;
  await row.first().locator('a').click();
  return id;
}

test('[Phase6.1] 入社準備の通知 → 対象社員の未完了の準備タスクだけ → 完了で件数が減り、全件完了で通知が消える（戻る・再読み込み）', async ({ page, isMobile }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await start(page);
  const badgeHref = isMobile ? '#/menu' : '#/onboarding';
  const badgeBefore = await navBadge(page, badgeHref);

  const id = await openNotice(page, 'hire_unprepared');
  const empId = id.split(':')[1]!;
  // タスク一覧が「対象社員・入社準備・未完了」に絞り込まれている
  await expect(page).toHaveURL(new RegExp(`#/tasks\\?employee=${empId}&source=onboarding&status=open`));
  const expected = (await readStore<TaskRow>(page, 'tasks')).filter((t) => t.employeeId === empId && t.source === 'onboarding' && t.status !== 'done');
  expect(expected.length).toBeGreaterThan(0);
  const rows = page.locator('[data-testid="task-list"] [data-testid="task-item"]');
  await expect(rows).toHaveCount(expected.length);
  // 対象外の社員のタスク・完了済みのタスクが混入しない
  expect(new Set(await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-employee-id'))))).toEqual(new Set([empId]));
  expect(await rows.evaluateAll((els) => els.filter((e) => e.getAttribute('data-task-status') === 'done').length)).toBe(0);
  // 他の社員の「要対応」も混ぜない。この社員の通知 (理由・件数) を表示
  await expect(page.getByTestId('task-attention')).toHaveCount(0);
  const ctx = page.getByTestId('employee-task-context');
  await expect(ctx.getByTestId('target-notice')).toContainText(`${expected.length}件`);
  await expect(ctx.getByTestId('target-notice-action')).toHaveCount(0); // この画面で操作できるので移動ボタンは出さない

  // 1件完了 → 一覧から消え、通知の件数 (理由) が減る。通知自体は残る (まだ未完了がある)
  await rows.first().getByRole('combobox').selectOption('done');
  await expect(rows).toHaveCount(expected.length - 1);
  if (expected.length > 1) {
    await expect(ctx.getByTestId('target-notice')).toContainText(`${expected.length - 1}件`);
    expect(await navBadge(page, badgeHref)).toBe(badgeBefore);
    // 再読み込みしても同じ絞り込み・同じ件数
    await page.reload();
    await expect(rows).toHaveCount(expected.length - 1);
    // 戻る → 通知センター、進む → 同じ一覧
    await page.goBack();
    await expect(page).toHaveURL(/#\/notifications/);
    await page.goForward();
    await expect(rows).toHaveCount(expected.length - 1);
  }
  // 残りをすべて完了 → 通知が消え、件数が1減る
  for (let n = expected.length - 1; n > 0; n--) {
    await rows.first().getByRole('combobox').selectOption('done');
    await expect(rows).toHaveCount(n - 1);
  }
  await expect(page.getByText('未完了のタスクはありません（すべて完了しました）')).toBeVisible();
  await expect(ctx.getByTestId('target-notice')).toHaveCount(0);
  await expect.poll(() => navBadge(page, badgeHref)).toBe(badgeBefore - 1);
  expect(await noticeExists(page, id)).toBe(false);
  await gotoHash(page, '#/notifications?view=history');
  await expect(page.locator(`[data-testid="history-row"][data-notice-id="${id}"]`)).toBeVisible();
  expect(errors).toEqual([]);
});

test('[Phase6.1] オレンジ色の警告（入社準備画面・要対応）からも同じ操作画面へ移動できる', async ({ page }) => {
  await start(page);
  await gotoHash(page, '#/notifications?view=open');
  const id = (await page.locator('[data-notice-type="hire_unprepared"]').first().getAttribute('data-notice-id'))!;
  const empId = id.split(':')[1]!;
  const count = (await readStore<TaskRow>(page, 'tasks')).filter((t) => t.employeeId === empId && t.source === 'onboarding' && t.status !== 'done').length;

  // 入社準備画面 (社員を選択) の警告バナー → 「未完了の準備タスクを開く」
  await gotoHash(page, `#/onboarding?employee=${empId}`);
  const banner = page.getByTestId('target-notice').filter({ hasText: '注意' }).first();
  await expect(banner).toBeVisible();
  await banner.getByTestId('target-notice-action').click();
  await expect(page).toHaveURL(new RegExp(`#/tasks\\?employee=${empId}&source=onboarding&status=open`));
  await expect(page.locator('[data-testid="task-list"] [data-testid="task-item"]')).toHaveCount(count);
  // 戻ると入社準備画面へ
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`#/onboarding\\?employee=${empId}`));

  // 入社準備画面の「要対応」の行からも同じ
  await page.getByTestId('onboarding-attention').locator(`[data-notice-id="${id}"] a`).click();
  await expect(page.locator('[data-testid="task-list"] [data-testid="task-item"]')).toHaveCount(count);
  // その場で完了できる
  await page.locator('[data-testid="task-list"] [data-testid="task-item"]').first().getByRole('combobox').selectOption('done');
  await expect(page.locator('[data-testid="task-list"] [data-testid="task-item"]')).toHaveCount(count - 1);
});

test('[Phase6.1] 通知の約束：問い合わせ（新規・期限超過）・在庫不足 → 発注 → 承認・書類の確認待ちを、移動先で完了できる', async ({ page }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await start(page);

  // 新しい問い合わせ: 「対応中」を押すと解消
  let id = await openNotice(page, 'inquiry_new');
  await expect(page.getByTestId('target-notice')).toContainText('「対応中」');
  await page.getByRole('group', { name: 'ステータスを変更' }).getByRole('button', { name: '対応中' }).click();
  await expect(page.getByTestId('target-notice')).toHaveCount(0);
  expect(await noticeExists(page, id)).toBe(false);

  // 期限超過の問い合わせ: 「解決済み」で解決内容を記録すると解消
  id = await openNotice(page, 'inquiry_overdue');
  await expect(page.getByTestId('target-notice')).toContainText('「解決済み」');
  await page.getByRole('group', { name: 'ステータスを変更' }).getByRole('button', { name: '解決済み' }).click();
  const resolve = page.getByRole('dialog', { name: '解決済みにする' });
  await resolve.getByLabel('解決内容').fill('E2E：設定を見直して解決');
  await resolve.getByRole('button', { name: '解決済みにする' }).click();
  await expect(resolve).toHaveCount(0);
  expect(await noticeExists(page, id)).toBe(false);

  // 在庫不足: 発注候補 (その候補だけ選択済み) → 発注書（下書き）を作成 → 承認申請 → 承認 で解消
  id = await openNotice(page, 'stock_shortage', '在庫不足');
  if (!/#\/inventory\?tab=orders/.test(page.url())) {
    // 発注候補が無い段階の品目に当たった場合は、発注候補のある品目を選び直す
    id = await openNotice(page, 'stock_shortage');
  }
  await expect(page).toHaveURL(/#\/inventory\?tab=orders/);
  const focused = page.locator('[data-testid="suggestion-list"] li.wc-focus, [data-testid="suggestion-list"] li[data-focus-id]').first();
  await expect(focused).toBeInViewport();
  const checked = await page.locator('[data-testid="suggestion-list"] input[type="checkbox"]').evaluateAll((els) => els.filter((e) => (e as HTMLInputElement).checked).length);
  expect(checked).toBe(1); // 通知の対象の候補だけ
  await page.getByTestId('create-orders').click();
  await expect(page).toHaveURL(/#\/inventory\/orders\//);
  // 次の段階: 通知は発注書 (下書き) の承認申請を案内している
  const poId = page.url().split('/orders/')[1]!;
  await page.getByTestId('po-submit').click();
  await expect(page.getByTestId('target-notice')).toContainText('承認待ち');
  await page.getByLabel('承認者').fill('承認 太郎');
  await page.getByTestId('po-approve').click();
  await expect(page.getByTestId('target-notice')).toHaveCount(0);
  expect(await noticeExists(page, id)).toBe(false);
  expect(await noticeExists(page, `po_approval:${poId}`)).toBe(false);

  // 書類の確認待ち: 重要項目を入力・確認して「確認完了」で解消
  await gotoHash(page, '#/documents/new');
  await page.getByLabel('書類の種類').selectOption({ label: '領収書' });
  await page.getByTestId('import-manual').click();
  await expect(page.getByTestId('doc-number')).toBeVisible();
  id = await openNotice(page, 'document_review');
  await expect(page.getByTestId('target-notice')).toContainText('確認完了');
  const field = (k: string) => page.locator(`[data-field="${k}"] input`).first();
  await field('issuer').fill('テスト商店');
  await field('issueDate').fill('2026-10-10');
  await field('total').fill('1100');
  for (const k of ['issuer', 'issueDate', 'total']) await page.getByTestId(`review-${k}`).check();
  await page.getByTestId('review-confirm').click();
  await expect(page.getByText('確認済みとして保存しました')).toBeVisible();
  await expect(page.getByTestId('target-notice')).toHaveCount(0);
  expect(await noticeExists(page, id)).toBe(false);
  expect(errors).toEqual([]);
});

test('[Phase6.1] 存在しない対象への移動は案内を表示（社員・発注候補・タスク・提案）', async ({ page }) => {
  await start(page);
  await gotoHash(page, '#/tasks?employee=emp_missing&source=onboarding&status=open');
  await expect(page.getByTestId('missing-target')).toContainText('社員');
  await gotoHash(page, '#/inventory?tab=orders&focus=sug%3Amissing');
  await expect(page.getByTestId('missing-target')).toContainText('発注候補');
  await gotoHash(page, '#/tasks?focus=task_missing');
  await expect(page.getByTestId('missing-target')).toContainText('タスク');
  await gotoHash(page, '#/automation?focus=x%7Cy');
  await expect(page.getByTestId('missing-target')).toContainText('自動化の提案');
});
