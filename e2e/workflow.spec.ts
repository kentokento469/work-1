/**
 * 業務シナリオE2Eテスト (Phase 1 動作検証項目 1〜10)
 * iPhone 13 相当 / デスクトップ の2環境で実行する。
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

function isoAfter(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function stat(page: Page, label: string): Promise<number> {
  const text = await page.getByTestId(`stat-${label}`).getByTestId('stat-value').innerText();
  return Number(text);
}

async function gotoHash(page: Page, hash: string) {
  await page.evaluate((h) => (window.location.hash = h), hash);
}

const NAME = 'テスト 新人';
const NUMBER = 'T9001';

test('[Phase1] 入社登録からバックアップ復元・再読み込みまでの業務フロー', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
  const before = {
    pending: await stat(page, '入社予定者'),
    open: await stat(page, '未完了タスク'),
    employees: await stat(page, '登録社員数'),
  };

  // 1. 新入社員を登録 (重複番号のエラー確認も兼ねる)
  await gotoHash(page, '#/employees');
  await page.getByRole('button', { name: '新規登録' }).click();
  const dialog = page.getByRole('dialog', { name: '社員の新規登録' });
  await dialog.getByLabel('社員番号').fill('a0001');
  await expect(dialog.getByText('佐藤 健一 さんが使用中です')).toBeVisible();
  await dialog.getByLabel('社員番号').fill(NUMBER);
  await dialog.getByLabel('氏名').fill(NAME);
  await dialog.getByLabel('所属部署').selectOption({ label: '営業部' });
  await dialog.getByLabel('入社日').fill(isoAfter(21));
  await expect(dialog.getByLabel('在籍ステータス')).toHaveValue('pending');
  await dialog.getByRole('button', { name: '登録する' }).click();
  await expect(page.getByText(`${NAME}さんを登録しました`)).toBeVisible();

  // 2. 入社準備タスクを自動生成 (プレビュー → 登録)
  await page.getByRole('button', { name: 'タスクをプレビュー' }).click();
  await expect(page.getByRole('heading', { name: '2. 生成内容をプレビュー' })).toBeVisible();
  const items = page.getByTestId('plan-items').locator('li');
  await expect(items).toHaveCount(9); // 共通7件 + 営業部2件
  await expect(page.getByTestId('plan-items')).toContainText('名刺発注');
  await expect(page.getByTestId('plan-items')).not.toContainText('GitHubアカウント招待');
  // 1件だけ選択を外す
  await page.getByLabel('備品準備を登録する').uncheck();
  await page.getByTestId('apply-onboarding').click();
  await expect(page.getByText(`${NAME}さんの入社準備タスクを 8件 登録しました`)).toBeVisible();
  // 重複生成されないこと (残るのは選択を外した1件のみ)
  await expect(page.getByTestId('plan-items').locator('li')).toHaveCount(1);
  await expect(page.getByTestId('plan-items')).toContainText('備品準備');

  // 3. タスクを編集
  await page.getByRole('button', { name: 'タスクを確認' }).click();
  await expect(page.getByTestId('task-count')).toContainText(`${NAME}さんのタスク・8件`);
  const pcTask = page.locator('[data-task-title="PC準備"]');
  await pcTask.getByRole('button').first().click();
  const edit = page.getByRole('dialog', { name: 'タスクの編集' });
  await edit.getByLabel('担当者').fill('代理 担当者');
  await edit.getByLabel('優先度').selectOption({ label: '中' });
  await edit.getByRole('button', { name: '更新する' }).click();
  await expect(page.getByText('タスクを更新しました')).toBeVisible();
  await expect(pcTask).toContainText('代理 担当者');

  // 4. タスクを完了
  await pcTask.getByLabel('「PC準備」の進捗状況').selectOption('done');
  await expect(page.getByText('「PC準備」を完了にしました')).toBeVisible();

  // 5. ダッシュボードへの即時反映
  await gotoHash(page, '#/');
  await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
  expect(await stat(page, '入社予定者')).toBe(before.pending + 1);
  expect(await stat(page, '登録社員数')).toBe(before.employees + 1);
  expect(await stat(page, '未完了タスク')).toBe(before.open + 7);
  await expect(page.getByTestId('recent-activity')).toContainText('「PC準備」を「完了」に変更しました');

  // 6. 社員情報を検索
  await gotoHash(page, '#/employees');
  await page.getByLabel('キーワード検索').fill('テスト新人');
  await expect(page.getByTestId('employee-count')).toHaveText('1名を表示');
  await page.getByLabel('キーワード検索').fill(NUMBER.toLowerCase());
  await expect(page.getByTestId('employee-count')).toHaveText('1名を表示');
  await page.getByLabel('部署で絞り込み').selectOption({ label: '開発部' });
  await expect(page.getByTestId('employee-count')).toHaveText('0名を表示');

  // 7. CSV出力
  await gotoHash(page, '#/data');
  const [csvDl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-employees').click()]);
  expect(csvDl.suggestedFilename()).toMatch(/^workcore_employees_\d{8}_\d{4}\.csv$/);
  const csv = readFileSync((await csvDl.path())!, 'utf8');
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  expect(csv).toContain(`${NUMBER},${NAME},営業部`);

  // 8. JSONバックアップ
  const [jsonDl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-json').click()]);
  // テスト出力フォルダ名には日本語が含まれ、setInputFiles が正しく読めないため ASCII パスに保存する
  const backupPath = join(mkdtempSync(join(tmpdir(), 'workcore-e2e-')), 'backup.json');
  await jsonDl.saveAs(backupPath);
  const backup = JSON.parse(readFileSync(backupPath, 'utf8'));
  expect(backup.app).toBe('WorkCore');
  expect(backup.data.employees.some((e: { name: string }) => e.name === NAME)).toBe(true);

  // データを変更 (デモ初期化で登録内容を消す)
  await page.getByTestId('reset-demo').click();
  await page.getByRole('button', { name: '初期化する' }).click();
  await expect(page.getByText('デモデータを初期化しました').first()).toBeVisible();

  // 不正ファイルは拒否される
  await page.getByTestId('restore-input').setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{"app":"Other"}') });
  await expect(page.getByText('WorkCore のバックアップファイルではありません')).toBeVisible();

  // 9. バックアップ復元 (上書き確認あり)
  await page.getByTestId('restore-input').setInputFiles(backupPath);
  const confirm = page.getByRole('dialog', { name: 'バックアップから復元しますか？' });
  await expect(confirm).toContainText('現在のデータをすべて上書き');
  await confirm.getByRole('button', { name: '上書きして復元' }).click();
  await expect(page.getByText('バックアップから復元しました').first()).toBeVisible();

  // 10. 再読み込み後のデータ保持
  await page.reload();
  await gotoHash(page, '#/employees');
  await page.getByLabel('キーワード検索').fill(NAME);
  await expect(page.getByTestId('employee-count')).toHaveText('1名を表示');
  await gotoHash(page, '#/tasks');
  await page.getByRole('tab', { name: /すべて/ }).click();
  await page.getByLabel('タスクを検索').fill(NAME);
  await expect(page.getByTestId('task-count')).toContainText('8件を表示');
  const restoredPc = page.locator('[data-task-title="PC準備"]').filter({ hasText: '代理 担当者' });
  await expect(restoredPc.getByLabel('「PC準備」の進捗状況')).toHaveValue('done');

  expect(errors).toEqual([]);
});

test('[Phase1] ナビゲーション・テーマ切替・入力エラー表示', async ({ page, isMobile }) => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'メインメニュー' }).filter({ visible: true });
  await nav.getByRole('link', { name: isMobile ? 'タスク' : 'タスク管理' }).click();
  await expect(page.getByRole('heading', { name: 'タスク管理' })).toBeVisible();
  if (isMobile) {
    // スマホでは入社準備は「メニュー」内
    await nav.getByRole('link', { name: 'メニュー' }).click();
    // Phase 6 からメニュー上部に「対応が必要な項目」(入社準備の提案など) も並ぶため、メニュー項目を指定する
    await page.locator('[data-menu-item="onboarding"] a').click();
  } else {
    await nav.getByRole('link', { name: '入社準備' }).click();
  }
  await page.getByRole('tab', { name: '準備ルール設定' }).click();
  await expect(page.getByRole('heading', { name: '全社共通' })).toBeVisible();

  // テーマ切替
  const theme = page.getByRole('button', { name: /表示テーマ/ }).filter({ visible: true });
  await theme.click();
  const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
  await theme.click();
  expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).not.toBe(isDark);

  // 必須項目未入力で登録 → フィールドエラー
  if (isMobile) {
    // Phase 3 から下部ナビは「在庫」を優先し、社員管理は「メニュー」内
    await nav.getByRole('link', { name: 'メニュー' }).click();
    await page.locator('[data-menu-item="employees"] a').click();
  } else {
    await nav.getByRole('link', { name: '社員管理' }).click();
  }
  await page.getByRole('button', { name: '新規登録' }).click();
  await page.getByRole('button', { name: '登録する' }).click();
  await expect(page.getByText('氏名を入力してください')).toBeVisible();
  await expect(page.getByText('所属部署を選択してください')).toBeVisible();
  await expect(page.getByText('入社日を正しく入力してください')).toBeVisible();

  // 横スクロールが発生していないこと
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('[Dashboard] 部署別社員数：在籍状況の積み上げバー・凡例・内訳（タップで社員一覧へ）', async ({ page }) => {
  await page.goto('/');
  const card = page.getByTestId('department-breakdown');
  await expect(card).toBeVisible();
  const legend = card.getByTestId('segment-legend');
  for (const l of ['在籍中', '入社予定', '退職予定', '休職中', '退職済']) await expect(legend).toContainText(l);
  // デモ: 営業部は 在籍中3・退職予定1・休職中1・入社予定1・退職済1、在籍人数は 3+1+1=5
  const sales = card.getByRole('button', { name: /^営業部：/ });
  await expect(sales).toContainText('在籍5名');
  await expect(sales).toContainText('退職予定1');
  await expect(sales).toContainText('退職済1');
  await expect(sales).toHaveAttribute('aria-label', /営業部：在籍5名（在籍中3・退職予定1・休職中1・入社予定1・退職済1）/);
  // 人数が少ない区分も見える幅で描画される (最小幅)
  const widths = await sales.locator('span.h-full > span').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
  expect(widths).toHaveLength(5);
  expect(Math.min(...widths)).toBeGreaterThanOrEqual(6);
  await sales.click();
  await expect(page.getByRole('heading', { name: '社員管理' })).toBeVisible();
});
