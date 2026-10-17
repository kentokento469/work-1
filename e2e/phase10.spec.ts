/**
 * Phase 10 E2E: 業務フローの往復・再入力の削減と、誤操作の防止。
 * 各テストの「操作数」は、利用者のタップ・入力の回数 (docs/PHASE10_RESULTS.md の改善前後の比較に対応)。
 */
import { expect, test, type Locator, type Page } from './fixtures';

async function gotoHash(page: Page, hash: string) {
  await page.evaluate((h) => (window.location.hash = h), hash);
}
async function start(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
}
async function rows<T>(page: Page, store: string): Promise<T[]> {
  return page.evaluate(async (store) => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('workcore');
      q.onsuccess = () => r(q.result);
    });
    const v = await new Promise<unknown[]>((r) => {
      const q = db.transaction(store).objectStore(store).getAll();
      q.onsuccess = () => r(q.result);
    });
    db.close();
    return v;
  }, store) as Promise<T[]>;
}
/** 利用者の操作 (タップ・入力) を数える */
function counter() {
  let n = 0;
  return {
    tap: async (l: Locator) => {
      n++;
      await l.click();
    },
    fill: async (l: Locator, v: string) => {
      n++;
      await l.fill(v);
    },
    get count() {
      return n;
    },
  };
}

test('[Phase10] 退職：資産の返却と返却確認タスクの完了を1回で（タスク一覧へ戻って完了にする往復がない）', async ({ page }) => {
  await start(page);
  await gotoHash(page, '#/automation');
  const card = page.getByTestId('proposal-card').filter({ hasText: '山田 隆さんの貸与資産の返却' });
  if ((await card.getByTestId('apply-proposal').count()) === 0) await card.locator('button[aria-expanded]').click();
  await card.getByTestId('apply-proposal').click();
  await expect(page.getByText(/承認して実行しました/)).toBeVisible();
  type T = { id: string; title: string; status: string; assetId?: string; ruleId: string | null };
  const task = (await rows<T>(page, 'tasks')).find((t) => (t.ruleId ?? '').startsWith('return:') && t.title.includes('山田 隆'))!;
  expect(task.status).not.toBe('done');

  const op = counter();
  await gotoHash(page, `#/inventory/assets/${task.assetId}`);
  await op.tap(page.getByRole('button', { name: '返却', exact: true }));
  const dlg = page.getByRole('dialog');
  // 返却確認タスクも完了にする (初期値で選択済み)
  await expect(dlg.getByTestId('return-complete-task')).toBeChecked();
  await expect(dlg).toContainText(task.title);
  await op.tap(dlg.getByTestId('return-submit'));
  await expect(page.getByText(/返却を記録しました（返却確認タスク1件を完了）/)).toBeVisible();
  expect(op.count).toBe(2);
  const after = (await rows<T>(page, 'tasks')).find((t) => t.id === task.id)!;
  expect(after.status).toBe('done');
});

test('[Phase10] 入社準備：タスクを登録した画面から、次の作業（必要な機器の提案）へ直接移動して承認できる', async ({ page }) => {
  await start(page);
  // 機器の提案が出る入社予定者 (入社準備タスクが未生成の社員)
  await gotoHash(page, '#/employees');
  await page.getByRole('button', { name: '新規登録' }).click();
  const form = page.getByRole('dialog', { name: '社員の新規登録' });
  await form.getByLabel('社員番号').fill('P10-01');
  await form.getByLabel('氏名').fill('フロー 検証');
  await form.getByLabel('所属部署').selectOption({ label: '営業部' });
  await form.getByLabel('入社日').fill('2026-11-02');
  await form.getByRole('button', { name: '登録する' }).click();
  await page.getByRole('button', { name: 'タスクをプレビュー' }).click();
  await page.getByRole('button', { name: /件のタスクを登録する/ }).click();
  await expect(page.getByText(/フロー 検証さんの入社準備タスクを/)).toBeVisible();

  const op = counter();
  await op.tap(page.getByTestId('onboarding-next-equipment'));
  // 対象の提案を強調表示して表示する (強調表示の後、URL の focus は外れる)
  await expect(page).toHaveURL(/#\/automation/);
  const card = page.getByTestId('proposal-card').filter({ hasText: 'フロー 検証' });
  await expect(card).toBeInViewport();
  if ((await card.getByTestId('apply-proposal').count()) === 0) await op.tap(card.locator('button[aria-expanded]'));
  await op.tap(card.getByTestId('apply-proposal'));
  await expect(page.getByText(/承認して実行しました/)).toBeVisible();
  // 改善前: 自動化センターへ移動 (1) ＋ 提案を探して開く (1) ＋ 承認 (1)
  expect(op.count).toBeLessThanOrEqual(3);
});

test('[Phase10] 問い合わせ：解決内容の欄に入力した文は「解決済みにする」に引き継がれる（入力し直さない）', async ({ page }) => {
  await start(page);
  type I = { id: string; status: string; resolution: string };
  const inq = (await rows<I>(page, 'inquiries')).find((i) => i.status === 'in_progress' && !i.resolution)!;
  await gotoHash(page, `#/helpdesk/${inq.id}`);
  const text = '端末を再起動して復旧しました';
  await page.getByRole('main').getByLabel('解決内容').fill(text);
  await page.getByRole('button', { name: '解決済み', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('解決内容')).toHaveValue(text);
  await page.getByTestId('confirm-resolve').click();
  await expect(page.getByText('解決済みにしました')).toBeVisible();
  expect((await rows<I>(page, 'inquiries')).find((i) => i.id === inq.id)?.resolution).toBe(text);
});

test('[Phase10] 発注：申請者の名前が承認者の欄に残らない・申請者本人は承認できない', async ({ page }) => {
  await start(page);
  await gotoHash(page, '#/inventory?tab=orders');
  const boxes = page.locator('[data-testid="suggestion-list"] input[type="checkbox"]');
  await expect(boxes.first()).toBeVisible();
  // 1件だけ選んで発注書 (下書き) を作る
  for (const b of await boxes.all()) if (await b.isChecked()) await b.uncheck();
  await boxes.first().check();
  await page.getByTestId('create-orders').click();
  await expect(page).toHaveURL(/#\/inventory\/orders\//);
  await page.getByLabel('申請者').fill('加藤 由美');
  await page.getByTestId('po-submit').click();
  await expect(page.getByText('承認申請しました')).toBeVisible();
  // 承認者の欄は空 (申請者の名前のまま承認できない)
  await expect(page.getByLabel('承認者')).toHaveValue('');
  await expect(page.getByTestId('po-approve')).toBeDisabled();
  await page.getByLabel('承認者').fill('加藤由美');
  await page.getByTestId('po-approve').click();
  await expect(page.getByText(/本人は承認できません/)).toBeVisible();
  await page.getByLabel('承認者').fill('佐藤 健一');
  await page.getByTestId('po-approve').click();
  await expect(page.getByText('承認しました（入荷待ち）')).toBeVisible();
});

test('[Phase10] プロジェクト：作成するとそのまま開き、続けてタスクを追加できる', async ({ page }) => {
  await start(page);
  await gotoHash(page, '#/tasks?view=projects');
  const op = counter();
  await op.tap(page.getByTestId('project-new'));
  await op.fill(page.getByRole('dialog').getByLabel('プロジェクト名'), '展示会の準備');
  await op.tap(page.getByRole('dialog').getByTestId('project-save'));
  await expect(page.getByTestId('project-context')).toContainText('展示会の準備');
  await op.fill(page.getByTestId('quick-add-input'), 'ブースの申し込み');
  await op.tap(page.getByTestId('quick-add-submit'));
  await expect(page.locator('[data-task-title="ブースの申し込み"]').getByTestId('task-project')).toContainText('展示会の準備');
  // 改善前: 作成後に一覧から新しいプロジェクトを探して開く操作 (1) が必要だった
  expect(op.count).toBe(5);
});

test('[Phase10] 入力途中の下書きは、入力の直後に画面を離れても失われない', async ({ page }) => {
  await start(page);
  await gotoHash(page, '#/helpdesk/new');
  await page.getByLabel('件名').fill('入力の直後に移動');
  // 保存の待ち時間 (0.4秒) より前に別の画面へ
  await gotoHash(page, '#/');
  await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
  await gotoHash(page, '#/helpdesk/new');
  await expect(page.getByText('前回の入力途中の内容を復元しました')).toBeVisible();
  await expect(page.getByLabel('件名')).toHaveValue('入力の直後に移動');
  // 破棄した後は戻らない
  await page.getByRole('button', { name: '破棄して新規入力' }).click();
  await gotoHash(page, '#/');
  await gotoHash(page, '#/helpdesk/new');
  await expect(page.getByLabel('件名')).toHaveValue('');
  await expect(page.getByText('前回の入力途中の内容を復元しました')).toHaveCount(0);
});
