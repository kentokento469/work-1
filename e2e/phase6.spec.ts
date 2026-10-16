/**
 * Phase 6 E2E: 通知・ナビゲーション・情報到達性
 * iPhone 13 相当 / デスクトップ の2環境。下部ナビ (タスク・メニュー) の検証は iPhone 相当のみ。
 */
import { expect, test, type Page } from '@playwright/test';

async function gotoHash(page: Page, hash: string) {
  await page.evaluate((h) => (window.location.hash = h), hash);
}
async function start(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
}
/** 表示中のナビ (スマホ=下部ナビ、PC=サイドバー) の未処理件数 */
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
const todayISO = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
type TaskRow = { id: string; title: string; status: string; dueDate: string };

test('[Phase6] A. タスクの件数＝要対応の一覧（原因を1件ずつ特定）→ 通知から対象へ → 完了で件数が減る', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await start(page);
  const tasks = await readStore<TaskRow>(page, 'tasks');
  const overdue = tasks.filter((t) => t.status !== 'done' && t.dueDate < todayISO());
  expect(overdue.length).toBeGreaterThan(1);
  // ナビの数字 = 期限超過の未完了タスク数 (計算元: 実データ)
  expect(await navBadge(page, '#/tasks')).toBe(overdue.length);
  await expect(page.locator('nav a[href="#/tasks"]:visible [data-testid="nav-badge"]').first()).toHaveAttribute('aria-label', new RegExp(`未処理 ${overdue.length}件（期限超過 ${overdue.length}）`));

  // タブから入ると、一覧に埋もれず「要対応」に同じ件数・同じタスクが並ぶ (1回の操作で原因が分かる)
  await page.locator('nav a[href="#/tasks"]:visible').first().click();
  const section = page.getByTestId('task-attention');
  await expect(section).toBeVisible();
  await expect(page.getByTestId('task-attention-count')).toHaveText(String(overdue.length));
  // Phase 7 から要対応は普段閉じた1行で表示する
  if (await page.getByTestId('task-attention-more').isVisible()) await page.getByTestId('task-attention-more').click();
  const titles = await section.locator('[data-testid="task-item"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-task-title')));
  expect(titles.sort()).toEqual(overdue.map((t) => t.title).sort());
  // 各タスクに理由 (何日過ぎているか) が表示される
  await expect(section.getByTestId('task-note').first()).toContainText('日過ぎています');
  const box = await section.boundingBox();
  expect(box!.y).toBeLessThan(page.viewportSize()!.height); // スクロールせずに見える位置

  // 通知センターから1件を開く → タスク画面で対象が強調表示され、URL の focus は外れる
  await gotoHash(page, '#/notifications');
  const row = page.locator('[data-notice-type="task_overdue"]').first();
  const targetId = (await row.getAttribute('data-notice-id'))!.replace('task_overdue:', '');
  await row.locator('a').click();
  await expect(page).toHaveURL(/#\/tasks/);
  const target = page.locator(`[data-focus-id="${targetId}"]`).first();
  await expect(target).toBeInViewport();
  await expect(target).toHaveClass(/wc-focus/);
  await expect.poll(() => page.evaluate(() => location.hash)).not.toContain('focus=');

  // その場で完了にする → ナビ・要対応の件数が1減り、通知は解消済みの履歴へ
  await target.getByRole('combobox').selectOption('done');
  await expect.poll(() => navBadge(page, '#/tasks')).toBe(overdue.length - 1);
  await expect(page.getByTestId('task-attention-count')).toHaveText(String(overdue.length - 1));
  await gotoHash(page, '#/notifications?view=history');
  await expect(page.locator(`[data-testid="history-row"][data-notice-id="task_overdue:${targetId}"]`)).toBeVisible();
  // 再読み込みしても件数・履歴が保たれる
  await page.reload();
  await expect(page.locator(`[data-testid="history-row"][data-notice-id="task_overdue:${targetId}"]`)).toBeVisible();
  expect(await navBadge(page, '#/tasks')).toBe(overdue.length - 1);
  expect(errors).toEqual([]);
});

test('[Phase6] A. メニューの件数＝書類・自動化・入社準備の内訳（1件ずつ特定）→ 提案を開く → 承認で減る', async ({ page, isMobile }) => {
  test.skip(!isMobile, '下部ナビの「メニュー」はスマホ表示のみ');
  await start(page);
  const menuCount = await navBadge(page, '#/menu');
  expect(menuCount).toBeGreaterThan(0);
  await page.locator('nav a[href="#/menu"]:visible').first().click();
  await expect(page.getByTestId('menu-attention-count')).toHaveText(String(menuCount));
  // メニュー内でも発生元の項目に件数が出て、合計が下部ナビの件数と一致
  const perItem = await Promise.all(['documents', 'automation', 'onboarding'].map(async (k) => {
    const b = page.locator(`[data-menu-item="${k}"] [data-testid="nav-badge"]`);
    return (await b.count()) ? Number(await b.innerText()) : 0;
  }));
  expect(perItem.reduce((a, b) => a + b, 0)).toBe(menuCount);
  await page.getByTestId('menu-attention-more').click();
  await expect(page.getByTestId('menu-attention').locator('[data-testid="notice-row"]')).toHaveCount(menuCount);

  // 自動化の提案 → 対象の提案が開いた状態で強調表示 → 承認すると件数が減る
  const row = page.getByTestId('menu-attention').locator('[data-notice-type="automation_proposal"]').filter({ hasText: '入社準備タスク' }).first();
  const focusId = (await row.getAttribute('data-notice-id'))!.replace('automation_proposal:', '');
  await row.locator('a').click();
  await expect(page).toHaveURL(/#\/automation/);
  const card = page.locator(`[data-testid="proposal-card"][data-focus-id="${focusId}"]`);
  await expect(card).toBeInViewport();
  await expect(card.getByTestId('proposal-actions')).toBeVisible(); // 実行内容が開いている
  await expect(page.getByTestId('target-notice')).toContainText('承認待ち');
  await card.getByTestId('apply-proposal').click();
  await expect.poll(() => navBadge(page, '#/menu')).toBe(menuCount - 1);
});

test('[Phase6] B. 全通知から元データへ到達・件数の一致・既読と未処理の区別・存在しない対象', async ({ page, isMobile }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await start(page);
  // 確認待ちの書類を1件作る (書類の通知も検証する)
  await gotoHash(page, '#/documents/new');
  await page.getByLabel('書類の種類').selectOption({ label: '領収書' });
  await page.getByTestId('import-manual').click();
  await expect(page.getByTestId('doc-number')).toBeVisible();

  // 件数の一致: 通知センターの未処理 = 各ナビの件数の合計 = 各画面の「要対応」の件数
  await gotoHash(page, '#/notifications');
  const openCount = Number(await page.getByTestId('notices-count-open').innerText());
  const hrefs = isMobile ? ['#/tasks', '#/helpdesk', '#/inventory', '#/menu'] : ['#/tasks', '#/helpdesk', '#/inventory', '#/documents', '#/automation', '#/onboarding'];
  let sum = 0;
  for (const h of hrefs) sum += await navBadge(page, h);
  expect(sum).toBe(openCount);
  for (const [h, id] of [['#/helpdesk', 'helpdesk-attention'], ['#/inventory', 'inventory-attention'], ['#/documents', 'documents-attention']] as const) {
    const n = await navBadge(page, h === '#/documents' && isMobile ? '__none__' : h);
    await gotoHash(page, h);
    await expect(page.getByTestId(id)).toBeVisible();
    if (!(h === '#/documents' && isMobile)) await expect(page.getByTestId(`${id}-count`)).toHaveText(String(n));
  }

  // 種類ごとに1件ずつ開き、対象 (詳細画面・強調表示された項目) に到達できる
  await gotoHash(page, '#/notifications');
  const types = await page.locator('[data-testid="notice-row"]').evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('data-notice-type')!))]);
  expect(types).toEqual(expect.arrayContaining(['task_overdue', 'inquiry_overdue', 'inquiry_new', 'stock_shortage', 'document_review', 'automation_proposal']));
  for (const type of types) {
    await gotoHash(page, '#/notifications');
    const row = page.locator(`[data-notice-type="${type}"]`).first();
    const id = (await row.getAttribute('data-notice-id'))!;
    await row.locator('a').click();
    if (type === 'task_overdue') await expect(page.locator(`[data-focus-id="${id.split(':')[1]}"]`).first()).toBeInViewport();
    else if (type === 'automation_proposal') await expect(page.locator(`[data-focus-id="${id.slice(id.indexOf(':') + 1)}"]`)).toBeInViewport();
    // Phase 6.1 から在庫不足は「次の操作」の画面 (発注候補・下書きの発注書・品目) へ移動する
    else if (type === 'stock_shortage') await expect(page.locator('[data-focus-id^="sug:"].wc-focus, [data-testid="po-submit"], [data-testid="target-notice"][data-notice-type="stock_shortage"]').first()).toBeVisible();
    else await expect(page.getByTestId('target-notice').filter({ has: page.locator(`[data-notice-type="${type}"]`) }).or(page.locator(`[data-testid="target-notice"][data-notice-type="${type}"]`)).first()).toBeVisible();
  }

  // 既読と未処理の区別: 開いた通知は既読になるが、未処理の件数は変わらない
  await gotoHash(page, '#/notifications?view=unread');
  const unreadBefore = Number(await page.getByTestId('notices-count-unread').innerText());
  expect(unreadBefore).toBeLessThan(openCount); // 上で開いた分が既読
  await page.getByTestId('mark-all-read').click();
  await expect(page.getByTestId('notices-count-unread')).toHaveText('0');
  await expect(page.getByTestId('notices-count-open')).toHaveText(String(openCount));
  await page.reload();
  await expect(page.getByTestId('notices-count-unread')).toHaveText('0');
  // 絞り込み (機能・種類)
  await gotoHash(page, '#/notifications?view=open');
  await page.getByLabel('種類').selectOption({ label: '期限超過' });
  const kinds = await page.locator('[data-testid="notice-row"] [data-kind]').evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('data-kind')))]);
  expect(kinds).toEqual(['overdue']);

  // 存在しない対象 (削除済み・処理済み) は案内を表示
  await gotoHash(page, '#/tasks?focus=task_does_not_exist');
  await expect(page.getByTestId('missing-target')).toContainText('タスク');
  await gotoHash(page, '#/automation?focus=x%7Cy');
  await expect(page.getByTestId('missing-target')).toContainText('自動化の提案');
  await gotoHash(page, '#/helpdesk/inq_missing');
  await expect(page.getByText('問い合わせが見つかりません')).toBeVisible();
  expect(errors).toEqual([]);
});

test('[Phase6] C. 絞り込みに隠れた対象は表示できる状態に調整・通知から移動後の戻る・関連情報の相互参照', async ({ page }) => {
  await start(page);
  const tasks = await readStore<TaskRow>(page, 'tasks');
  const openNotOverdue = tasks.find((t) => t.status !== 'done' && t.dueDate >= todayISO())!;
  // 「完了」で絞り込んだ一覧に、未完了タスクへのリンクで移動 → 条件を解除して対象を表示
  await gotoHash(page, '#/tasks?status=done');
  await expect(page.getByRole('tab', { name: /完了/ }).last()).toHaveAttribute('aria-selected', 'true');
  await gotoHash(page, `#/tasks?status=done&focus=${openNotOverdue.id}`);
  await expect(page.getByTestId('filter-adjusted')).toBeVisible();
  await expect(page.locator(`[data-testid="task-list"] [data-focus-id="${openNotOverdue.id}"]`)).toBeInViewport();

  // 通知センター (未読タブ) → 対象 → 戻る で、通知センターの表示条件が残る
  await gotoHash(page, '#/notifications?view=unread');
  await page.getByLabel('機能').selectOption({ label: 'ヘルプデスク' });
  await expect(page).toHaveURL(/module=helpdesk/);
  await page.locator('[data-testid="notice-row"] a').first().click();
  await expect(page).toHaveURL(/#\/helpdesk\//);
  await expect(page.getByTestId('target-notice').first()).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/view=unread/);
  await expect(page.getByLabel('機能')).toHaveValue('helpdesk');

  // 関連情報: タスク → 対象社員の詳細 → 貸与機器・関連タスク・問い合わせ
  await gotoHash(page, '#/tasks?status=all');
  const empLink = page.locator('[data-testid="task-list"] a[href^="#/employees/"]').first();
  await empLink.click();
  await expect(page).toHaveURL(/#\/employees\//);
  await expect(page.getByRole('heading', { name: '関連タスク' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '貸与機器・予約' })).toBeVisible();
});
