/**
 * Phase 7 E2E: 汎用タスク管理 (クイック追加・期限なし・プロジェクト・チェックリスト・サブタスク・繰り返し・
 * ボード・カレンダー・関連データ・バックアップ)。iPhone 13 相当 / デスクトップ の2環境で実行する。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page, testNow } from './fixtures';

async function gotoHash(page: Page, hash: string) {
  await page.evaluate((h) => (window.location.hash = h), hash);
}
async function start(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
}
type TaskRow = { id: string; title: string; status: string; dueDate: string | null; assigneeDepartmentId: string | null; employeeId: string | null; projectId?: string | null; parentTaskId?: string | null; checklist?: { done: boolean }[]; seriesId?: string | null; links?: { kind: string; id: string }[] };
async function tasks(page: Page): Promise<TaskRow[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('workcore');
      q.onsuccess = () => r(q.result);
    });
    const rows = await new Promise<unknown[]>((r) => {
      const q = db.transaction('tasks').objectStore('tasks').getAll();
      q.onsuccess = () => r(q.result as unknown[]);
    });
    db.close();
    return rows;
  }) as Promise<TaskRow[]>;
}
const iso = (offset: number) => {
  const d = testNow();
  d.setDate(d.getDate() + offset);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const item = (page: Page, title: string) => page.locator(`[data-testid="task-list"] [data-task-title="${title}"]`);

test('[Phase7] 1〜4. タスク名だけで登録（社員・部署・期限なし）・期限の読み取り・編集・完了・未完了に戻す・複製・削除と復元', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await start(page);
  await page.locator('nav a[href="#/tasks"]:visible').first().click();

  // 1・2. タスク名だけで登録
  await page.getByTestId('quick-add-input').fill('資料を作成する');
  await page.getByTestId('quick-add-submit').click();
  await expect(page.getByText('「資料を作成する」を追加しました')).toBeVisible();
  await expect(page.getByTestId('quick-add-input')).toHaveValue('');
  const t1 = (await tasks(page)).find((t) => t.title === '資料を作成する')!;
  expect(t1).toMatchObject({ dueDate: null, assigneeDepartmentId: null, employeeId: null, status: 'todo' });
  // 3. 期限なしは「期限なし」に表示され、期限超過には数えない
  await expect(item(page, '資料を作成する').getByTestId('no-due')).toBeVisible();
  await page.getByTestId('scope-nodue').click();
  await expect(item(page, '資料を作成する')).toBeVisible();
  await page.getByTestId('scope-overdue').click();
  await expect(item(page, '資料を作成する')).toHaveCount(0);
  await page.getByTestId('scope-open').click();

  // 期限の読み取り (候補として表示 → 外すこともできる)
  await page.getByTestId('quick-add-input').fill('明日までに報告書を確認する');
  await expect(page.getByTestId('quick-add-date')).toContainText('「明日」から');
  await page.getByTestId('quick-add-submit').click();
  await expect(page.getByText(/「報告書を確認する」を追加しました（期限/)).toBeVisible();
  expect((await tasks(page)).find((t) => t.title === '報告書を確認する')?.dueDate).toBe(iso(1));
  await page.getByTestId('quick-add-input').fill('金曜に備品を整理');
  await page.getByTestId('quick-add-date-clear').click();
  await page.getByTestId('quick-add-submit').click();
  await expect(page.getByText('「金曜に備品を整理」を追加しました')).toBeVisible();
  expect((await tasks(page)).find((t) => t.title === '金曜に備品を整理')?.dueDate).toBeNull();

  // 4. 編集 (基本項目だけ・詳細は閉じたまま)
  await item(page, '資料を作成する').getByRole('button').first().click();
  const dlg = page.getByRole('dialog', { name: 'タスクの編集' });
  await expect(dlg.getByTestId('task-details')).not.toHaveAttribute('open', '');
  await dlg.getByLabel('タスク名').fill('提案資料を作成する');
  await dlg.getByLabel('期限').fill(iso(5));
  await dlg.getByTestId('task-save').click();
  await expect(page.getByText('タスクを更新しました')).toBeVisible();
  await expect(item(page, '提案資料を作成する')).toBeVisible();
  // 完了 → 完了タブに移る → 未完了へ戻す
  await item(page, '提案資料を作成する').getByRole('combobox').selectOption('done');
  await expect(item(page, '提案資料を作成する')).toHaveCount(0);
  await page.getByTestId('scope-done').click();
  await item(page, '提案資料を作成する').getByRole('combobox').selectOption('todo');
  await expect(item(page, '提案資料を作成する')).toHaveCount(0);
  await page.getByTestId('scope-open').click();
  await expect(item(page, '提案資料を作成する')).toBeVisible();
  // 複製
  await item(page, '提案資料を作成する').getByRole('button').first().click();
  await page.getByRole('dialog').getByTestId('task-duplicate').click();
  await expect(item(page, '提案資料を作成する（コピー）')).toBeVisible();
  // 削除 → 元に戻す
  await item(page, '提案資料を作成する（コピー）').getByRole('button').first().click();
  await page.getByRole('dialog').getByTestId('task-delete').click();
  await expect(item(page, '提案資料を作成する（コピー）')).toHaveCount(0);
  await page.getByRole('status').filter({ hasText: '削除しました' }).getByRole('button', { name: '元に戻す' }).click();
  await expect(item(page, '提案資料を作成する（コピー）')).toBeVisible();
  // 再読み込みしても残る
  await page.reload();
  await expect(item(page, '提案資料を作成する')).toBeVisible();
  await expect(item(page, '報告書を確認する')).toBeVisible();
  expect(errors).toEqual([]);
});

test('[Phase7] 5〜6. プロジェクト（作成・タスク追加・完了率・削除してもタスクは残る）・チェックリスト・サブタスク（親の完了時に確認）', async ({ page }) => {
  await start(page);
  await gotoHash(page, '#/tasks?view=projects');
  // デモのプロジェクトの完了率は所属タスクの完了数から計算
  await expect(page.locator('[data-project-name="社内PC入れ替え"] [data-testid="project-progress"]')).toContainText('20%（1/5）');
  await page.getByTestId('project-new').click();
  await page.getByRole('dialog').getByLabel('プロジェクト名').fill('E2E案件');
  await page.getByRole('dialog').getByTestId('project-save').click();
  await page.locator('[data-project-name="E2E案件"] button').first().click();
  await expect(page.getByTestId('project-context')).toContainText('E2E案件');
  // プロジェクトを開いた状態のクイック追加は、そのプロジェクトに入る
  await page.getByTestId('quick-add-input').fill('見積を取得する');
  await page.getByTestId('quick-add-submit').click();
  await expect(item(page, '見積を取得する').getByTestId('task-project')).toContainText('E2E案件');
  await expect(page.getByTestId('project-context')).toContainText('0% 完了（0/1）');

  // 6. チェックリスト
  await item(page, '見積を取得する').getByRole('button').first().click();
  let dlg = page.getByRole('dialog', { name: 'タスクの編集' });
  for (const c of ['A社に依頼', 'B社に依頼']) {
    await dlg.getByTestId('checklist-input').fill(c);
    await dlg.getByTestId('checklist-input').press('Enter');
  }
  await dlg.getByLabel('A社に依頼を完了').check();
  await dlg.getByTestId('task-save').click();
  await expect(item(page, '見積を取得する').getByTestId('task-checklist-progress')).toHaveText('1/2');

  // サブタスク (独立したタスク・1段まで)
  await item(page, '見積を取得する').getByRole('button').first().click();
  dlg = page.getByRole('dialog', { name: 'タスクの編集' });
  await dlg.getByTestId('subtask-input').fill('比較表を作る');
  await dlg.getByTestId('subtask-input').press('Enter');
  await expect(dlg.getByTestId('subtask-list')).toContainText('比較表を作る');
  await dlg.getByRole('button', { name: 'キャンセル' }).click();
  await expect(item(page, '比較表を作る').getByTestId('task-parent')).toContainText('見積を取得する');
  await expect(item(page, '見積を取得する').getByTestId('task-subtask-progress')).toHaveText('サブタスク 0/1');
  // 親を完了 → 未完了のサブタスクがあるので確認 → すべて完了
  await item(page, '見積を取得する').getByRole('combobox').selectOption('done');
  await expect(page.getByRole('dialog', { name: '未完了のサブタスクがあります' })).toContainText('比較表を作る');
  await page.getByTestId('complete-with-subtasks').click();
  await expect(page.getByTestId('project-context')).toContainText('100% 完了（2/2）');

  // プロジェクトを削除してもタスクは残り、元に戻すと再び所属する
  await gotoHash(page, '#/tasks?view=projects');
  await page.locator('[data-project-name="E2E案件"] [data-testid="project-delete"]').click();
  await expect(page.getByText('タスク2件は残し、所属を外しました')).toBeVisible();
  expect((await tasks(page)).filter((t) => t.title === '見積を取得する' || t.title === '比較表を作る').every((t) => !t.projectId)).toBe(true);
  await page.getByRole('status').filter({ hasText: '所属を外しました' }).getByRole('button', { name: '元に戻す' }).click();
  await expect(page.locator('[data-project-name="E2E案件"] [data-testid="project-progress"]')).toContainText('100%（2/2）');
});

test('[Phase7] 7〜8. 繰り返しは重複生成しない・リスト／ボード／カレンダーが同じデータを表示・依存関係の表示', async ({ page, isMobile }) => {
  await start(page);
  await gotoHash(page, '#/tasks?status=all&q=%E7%B5%8C%E8%B2%BB');
  // 7. 毎月末の繰り返し: 完了 → 次回 (翌月末) を1件作成。未完了に戻して再完了しても増えない
  const before = (await tasks(page)).filter((t) => t.title === '経費の確認');
  expect(before).toHaveLength(1);
  const cur = before[0]!;
  await item(page, '経費の確認').first().getByRole('combobox').selectOption('done');
  await expect(page.getByText(/次回（期限 .*）を作成しました/)).toBeVisible();
  await expect.poll(async () => (await tasks(page)).filter((t) => t.title === '経費の確認').length).toBe(2);
  const next = (await tasks(page)).find((t) => t.title === '経費の確認' && t.status === 'todo')!;
  const d = new Date(`${cur.dueDate}T00:00:00`);
  const end = new Date(d.getFullYear(), d.getMonth() + 2, 0);
  expect(next.dueDate).toBe(`${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`);
  expect(next.seriesId).toBe(cur.id);
  const doneRow = page.locator(`[data-testid="task-list"] [data-focus-id="${cur.id}"]`);
  await doneRow.getByRole('combobox').selectOption('todo');
  await doneRow.getByRole('combobox').selectOption('done');
  await expect(page.getByText(/を完了にしました/).last()).toBeVisible();
  await page.waitForTimeout(300);
  expect((await tasks(page)).filter((t) => t.title === '経費の確認')).toHaveLength(2);

  // 8. 同じタスクをボード・カレンダーで操作 → リストに反映
  await gotoHash(page, '#/tasks?view=board&q=%E4%BC%9A%E8%AD%B0%E8%B3%87%E6%96%99');
  const card = page.locator('[data-testid="board-col-todo"] [data-testid="board-card"][data-task-title="来週の会議資料を準備する"]');
  await expect(card).toBeVisible();
  await card.getByRole('combobox').selectOption('in_progress');
  await expect(page.locator('[data-testid="board-col-in_progress"] [data-task-title="来週の会議資料を準備する"]')).toBeVisible();
  // PC はドラッグ＆ドロップでも移動できる (スマホは上の進捗メニュー)
  if (!isMobile) {
    await page.locator('[data-testid="board-card"][data-task-title="来週の会議資料を準備する"]').dragTo(page.getByTestId('board-col-on_hold'));
    await expect(page.locator('[data-testid="board-col-on_hold"] [data-task-title="来週の会議資料を準備する"]')).toBeVisible();
    await page.locator('[data-testid="board-col-on_hold"] [data-task-title="来週の会議資料を準備する"]').getByRole('combobox').selectOption('in_progress');
  }
  await page.getByTestId('view-list').click();
  await expect(item(page, '来週の会議資料を準備する').getByRole('combobox')).toHaveValue('in_progress');
  // カレンダー: 期限なしの一覧に表示 → 期限を設定 → その日に表示 → リストにも反映
  await page.getByTestId('view-calendar').click();
  const nodue = page.getByTestId('calendar-nodue');
  await expect(nodue.locator('[data-task-title="来週の会議資料を準備する"]')).toBeVisible();
  await nodue.getByLabel('「来週の会議資料を準備する」の期限').fill(iso(2));
  await expect(nodue.locator('[data-task-title="来週の会議資料を準備する"]')).toHaveCount(0);
  await page.locator(`[data-date="${iso(2)}"]`).click();
  await expect(page.getByTestId('calendar-day').locator('[data-task-title="来週の会議資料を準備する"]')).toBeVisible();
  expect((await tasks(page)).find((t) => t.title === '来週の会議資料を準備する')?.dueDate).toBe(iso(2));

  // 依存関係: 前提が未完了なら「前提未完了」を表示し、前提を完了すると消える
  await gotoHash(page, '#/tasks?status=all&project=prj_pc_replace');
  await expect(item(page, '購入申請').getByTestId('task-blocked')).toContainText('前提未完了 1');
  await item(page, '見積取得').getByRole('combobox').selectOption('done');
  await expect(item(page, '購入申請').getByTestId('task-blocked')).toHaveCount(0);
});

test('[Phase7] 9〜12. 関連データからタスク作成・元の画面へ戻る・自動生成タスク・通知との整合・バックアップ復元後も維持', async ({ page }) => {
  await start(page);
  // 在庫の品目からタスクを作る → タスクから品目へ戻れる
  await gotoHash(page, '#/inventory');
  await page.locator('a[href^="#/inventory/items/"]:visible').first().click();
  const itemUrl = page.url();
  await page.getByTestId('related-task-new').click();
  const dlg = page.getByRole('dialog', { name: 'タスクの新規作成' });
  await expect(dlg.getByLabel('タスク名')).toHaveValue(/の在庫確認$/);
  await dlg.getByTestId('task-save').click();
  await expect(page.getByTestId('related-tasks').locator('[data-testid="task-item"]')).toHaveCount(1);
  const created = (await tasks(page)).find((t) => t.links?.some((l) => l.kind === 'item'))!;
  await gotoHash(page, `#/tasks?focus=${created.id}`);
  await page.locator(`[data-focus-id="${created.id}"] [data-testid="task-link"]`).first().click();
  await expect(page).toHaveURL(itemUrl);

  // 9. 自動生成タスク (入社準備) も同じ一覧・同じ操作で扱える
  await gotoHash(page, '#/tasks?status=open&source=onboarding');
  const onb = page.locator('[data-testid="task-list"] [data-testid="task-item"]').first();
  await expect(onb).toBeVisible();
  expect((await tasks(page)).filter((t) => t.status !== 'done').some((t) => t.assigneeDepartmentId)).toBe(true);

  // 10・11. 期限超過の通知 = 期限ありの未完了のみ (期限なしは数えない)。完了で通知が減る
  const overdue = (await tasks(page)).filter((t) => t.status !== 'done' && t.dueDate && t.dueDate < iso(0));
  await gotoHash(page, '#/notifications?view=open&module=tasks');
  await expect(page.locator('[data-testid="notice-row"][data-notice-type="task_overdue"]')).toHaveCount(overdue.length);
  await page.locator('[data-testid="notice-row"][data-notice-type="task_overdue"] a').first().click();
  const focused = page.locator('[data-testid="task-attention"] [data-testid="task-item"].wc-focus, [data-testid="task-attention"] [data-testid="task-item"]').first();
  await expect(focused).toBeInViewport();
  await focused.getByRole('combobox').selectOption('done');
  await gotoHash(page, '#/notifications?view=open&module=tasks');
  await expect(page.locator('[data-testid="notice-row"][data-notice-type="task_overdue"]')).toHaveCount(overdue.length - 1);

  // 12. バックアップ → 初期化 → 復元 でプロジェクト・関連データ・繰り返しが残る
  await gotoHash(page, '#/data');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-json').click()]);
  const path = join(mkdtempSync(join(tmpdir(), 'workcore-p7-')), 'backup.json');
  await dl.saveAs(path);
  await page.getByTestId('reset-demo').click();
  await page.getByRole('button', { name: '初期化する' }).click();
  await expect(page.getByText('デモデータを初期化しました').first()).toBeVisible();
  expect((await tasks(page)).some((t) => t.id === created.id)).toBe(false);
  await page.getByTestId('restore-input').setInputFiles(path);
  await page.getByRole('dialog', { name: 'バックアップから復元しますか？' }).getByRole('button', { name: '上書きして復元' }).click();
  await expect(page.getByText('バックアップから復元しました').first()).toBeVisible();
  const restored = await tasks(page);
  expect(restored.find((t) => t.id === created.id)?.links?.[0]?.kind).toBe('item');
  await gotoHash(page, '#/tasks?view=projects');
  await expect(page.locator('[data-project-name="社内PC入れ替え"]')).toBeVisible();
});
