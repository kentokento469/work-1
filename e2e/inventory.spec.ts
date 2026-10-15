/**
 * Phase 3 業務シナリオE2E (動作検証 1〜15) — iPhone 13 相当 / デスクトップ
 * 新入社員 → 機器の自動提案 → 承認(予約) → 在庫減 → 不足検知 → 発注候補 → 発注書 → 承認 → 入荷 → 在庫反映
 * 貸出・返却履歴 / 故障問い合わせ → 代替機 / 退職者の返却タスク / バックアップ復元 / 再読み込み後の整合性
 * 操作回数 (タップ・入力) を計測し、test-results/ux-metrics-inventory-*.json に出力する。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

function counter() {
  const c = { taps: 0, inputs: 0 };
  return {
    c,
    tap: async (l: Locator) => {
      c.taps++;
      await l.click();
    },
    fill: async (l: Locator, v: string) => {
      c.inputs++;
      await l.fill(v);
    },
    select: async (l: Locator, v: { label?: string; index?: number }) => {
      c.taps++;
      await l.selectOption(v);
    },
    reset: () => {
      c.taps = 0;
      c.inputs = 0;
    },
    snapshot: () => ({ ...c, total: c.taps + c.inputs }),
  };
}

function isoAfter(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function gotoHash(page: Page, hash: string) {
  await page.evaluate((h) => (window.location.hash = h), hash);
}

const item = (page: Page, name: string) => page.locator(`[data-item-name="${name}"]`);
async function available(page: Page, name: string): Promise<number> {
  await gotoHash(page, `#/inventory?tab=stock&q=${encodeURIComponent(name)}`);
  return Number((await item(page, name).getByTestId('available').innerText()).replace(/\D/g, ''));
}
/** 提案カードを開く (件数が多いと折りたたまれている) */
async function openProposal(page: Page, title: string | RegExp, tap?: (l: Locator) => Promise<void>): Promise<Locator> {
  const card = page.getByTestId('proposal-card').filter({ hasText: title });
  await expect(card).toHaveCount(1);
  if ((await card.getByTestId('apply-proposal').count()) === 0) await (tap ?? ((l: Locator) => l.click()))(card.locator('button[aria-expanded]'));
  return card;
}

const NAME = 'テスト 機器太郎';
const NUMBER = 'T9301';
const LAPTOP = 'ノートPC（標準機）';
const MOUSE = 'マウス（無線）';

async function onHand(page: Page, name: string): Promise<number> {
  await gotoHash(page, `#/inventory?tab=stock&q=${encodeURIComponent(name)}`);
  const t = await item(page, name).getByText(/実在庫 \d+/).innerText();
  return Number(t.match(/実在庫 (\d+)/)![1]);
}

async function countStore(page: Page, store: string): Promise<number> {
  return page.evaluate(async (s) => {
    const db = await new Promise<IDBDatabase>((r) => {
      const req = indexedDB.open('workcore');
      req.onsuccess = () => r(req.result);
    });
    return new Promise<number>((r) => {
      const c = db.transaction(s).objectStore(s).count();
      c.onsuccess = () => r(c.result);
    });
  }, store);
}

async function assertNoOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test('[Phase3] 入社→機器提案→承認→在庫減→不足→発注→承認→入荷→在庫反映', async ({ page }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const op = counter();
  const metrics: Record<string, unknown> = { device: info.project.name };

  await page.goto('/');
  await expect(page.getByTestId('inventory-summary')).toBeVisible();
  const laptopBefore = await available(page, LAPTOP);
  const mouseBefore = await available(page, MOUSE);
  expect(laptopBefore).toBe(2); // デモ: 未使用 2台

  // 1. 新入社員を登録 (翌日入社 → 最優先で機器を割り当てる)
  await gotoHash(page, '#/employees');
  await page.getByRole('button', { name: '新規登録' }).click();
  const dialog = page.getByRole('dialog', { name: '社員の新規登録' });
  await dialog.getByLabel('社員番号').fill(NUMBER);
  await dialog.getByLabel('氏名').fill(NAME);
  await dialog.getByLabel('所属部署').selectOption({ label: '総務部' });
  await dialog.getByLabel('入社日').fill(isoAfter(1));
  await dialog.getByRole('button', { name: '登録する' }).click();
  await expect(page.getByText(`${NAME}さんを登録しました`)).toBeVisible();

  // 2〜3. 自動化センターで必要機器と在庫を確認 → 承認して予約
  op.reset();
  await gotoHash(page, '#/');
  await op.tap(page.getByTestId('dash-proposals'));
  const card = await openProposal(page, `${NAME}さんの入社準備機器`, op.tap);
  await expect(card).toContainText(LAPTOP);
  await expect(card).toContainText('予約');
  await op.tap(card.getByTestId('apply-proposal'));
  await expect(page.getByText(/承認して実行しました/)).toBeVisible();
  metrics.approveOnboarding = op.snapshot();
  await expect(page.getByTestId('proposal-card').filter({ hasText: `${NAME}さんの入社準備機器` })).toHaveCount(0);
  // 処理履歴に記録される
  await expect(page.getByTestId('automation-runs')).toContainText(`${NAME}さんの入社準備機器`);

  // 4. 利用可能数が減る (実在庫は変わらない = 予約)
  expect(await available(page, LAPTOP)).toBe(laptopBefore - 1);
  expect(await available(page, MOUSE)).toBe(mouseBefore - 1);
  await expect(item(page, MOUSE)).not.toContainText('予約 0');

  // 社員詳細に予約が出る (同じ情報を再入力しない)
  await gotoHash(page, '#/employees');
  await page.getByRole('link', { name: new RegExp(NAME) }).first().click();
  await expect(page.getByTestId('employee-equipment')).toContainText(LAPTOP);
  // 機器のタスクも自動生成
  await gotoHash(page, '#/tasks?status=open&source=automation');
  await expect(page.getByTestId('task-list')).toContainText(NAME);

  // 5〜6. 不足検知 → 発注候補 (自動作成・下書き)
  await gotoHash(page, '#/inventory?tab=orders');
  const sugg = page.locator(`[data-suggestion-item="${LAPTOP}"]`);
  await expect(sugg).toBeVisible();
  await expect(sugg).toContainText('推奨');
  // 7. 発注書を作成 → 承認申請 → 承認
  op.reset();
  // 他の候補を外してノートPCだけにする
  const checks = page.getByTestId('suggestion-list').getByRole('checkbox');
  for (let i = 0; i < (await checks.count()); i++) {
    const cb = checks.nth(i);
    const label = await cb.getAttribute('aria-label');
    if ((label === `${LAPTOP}を発注書に含める`) !== (await cb.isChecked())) await op.tap(cb);
  }
  metrics.deselectOtherSuggestions = op.snapshot();
  op.reset();
  await op.tap(page.getByTestId('create-orders'));
  await expect(page.getByTestId('order-detail')).toBeVisible();
  await expect(page.getByTestId('order-detail')).toContainText('下書き');
  await op.tap(page.getByTestId('po-submit'));
  await expect(page.getByTestId('order-detail')).toContainText('承認待ち');
  await op.fill(page.getByLabel('承認者'), '佐藤 健一');
  await op.tap(page.getByTestId('po-approve'));
  await expect(page.getByTestId('order-detail')).toContainText('入荷待ち');
  metrics.orderToApproval = op.snapshot();
  // 承認済み = 発注残。候補は消える (二重提案しない)
  await gotoHash(page, '#/inventory?tab=orders');
  await expect(page.locator(`[data-suggestion-item="${LAPTOP}"]`)).toHaveCount(0);
  await page.getByTestId('order-list').locator('a').filter({ hasText: LAPTOP }).filter({ hasText: '入荷待ち' }).first().click();

  // 8. 入荷登録 (連打しても1回だけ)
  const assetsBefore = await countStore(page, 'assets');
  op.reset();
  const stepper = page.getByRole('group', { name: `${LAPTOP}の入荷数` });
  const remainingText = await page.getByTestId('order-detail').getByText(/今回の入荷数（未入荷 \d+）/).innerText();
  const remaining = Number(remainingText.match(/未入荷 (\d+)/)![1]);
  // 未入荷数が初期値として入っている (全数入荷なら数量入力は不要)
  await expect(stepper.getByRole('spinbutton')).toHaveValue(String(remaining));
  op.c.taps++;
  await page.getByTestId('po-receive').dblclick();
  await expect(page.getByTestId('order-detail')).toContainText('入荷完了');
  metrics.receive = op.snapshot();

  // 9. 在庫に反映 (個体管理品は資産が自動登録され、入荷待ちの予約に引き当てられる)
  expect(await countStore(page, 'assets')).toBe(assetsBefore + remaining);
  const laptopAfter = await available(page, LAPTOP);
  expect(laptopAfter).toBeGreaterThanOrEqual(0);
  // 再読み込み後も同じ値 (重複処理なし)
  await page.reload();
  expect(await available(page, LAPTOP)).toBe(laptopAfter);
  await gotoHash(page, '#/inventory?tab=orders&pstatus=received');
  await expect(page.getByTestId('order-list').locator('a').filter({ hasText: LAPTOP })).not.toHaveCount(0);

  await assertNoOverflow(page);
  writeFileSync(join('test-results', `ux-metrics-inventory-${info.project.name}.json`), JSON.stringify(metrics, null, 2));
  console.log('UX_METRICS_INV', JSON.stringify(metrics));
  expect(errors).toEqual([]);
});

test('[Phase3] 貸出・返却の履歴／連打・上限・二重処理の防止', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByTestId('inventory-summary')).toBeVisible();

  // 出庫: 利用可能数を超える数量は登録できない
  const mouse = await available(page, MOUSE);
  const movementsBefore = await countStore(page, 'stockMovements');
  await item(page, MOUSE).getByRole('button', { name: `${MOUSE}を出庫` }).click();
  const qty = page.getByRole('dialog').getByRole('spinbutton', { name: '数量' });
  await qty.fill(String(mouse + 1));
  await expect(page.getByTestId('qty-submit')).toBeDisabled();
  await qty.fill('2');
  await expect(page.getByTestId('qty-preview')).toContainText(`${mouse} → ${mouse - 2}`);
  // 連打しても1回分だけ
  await page.getByTestId('qty-submit').dblclick();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await available(page, MOUSE)).toBe(mouse - 2);
  expect(await countStore(page, 'stockMovements')).toBe(movementsBefore + 1);

  // 貸出 → 返却 (状態が自動で切り替わり、履歴が残る)
  await gotoHash(page, '#/inventory?tab=assets&astatus=unused&item=item_laptop');
  const row = page.getByTestId('asset-list').locator('li').first();
  const num = (await row.getAttribute('data-asset-number'))!;
  await row.getByRole('button', { name: `${num}を貸出` }).click();
  await page.locator('#assign-emp').selectOption({ label: '渡辺 さくら（A0033）' });
  await page.getByTestId('assign-submit').dblclick();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await gotoHash(page, '#/inventory?tab=assets&astatus=in_use');
  const used = page.locator(`[data-asset-number="${num}"]`);
  await expect(used).toContainText('使用中');
  await expect(used).toContainText('渡辺 さくら');
  await used.getByRole('button', { name: `${num}を返却` }).click();
  await expect(page.getByRole('button', { name: '未使用に戻す' }).or(page.locator('[aria-pressed="true"]')).first()).toBeVisible();
  await page.getByTestId('return-submit').dblclick();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await gotoHash(page, '#/inventory?tab=assets&astatus=unused&item=item_laptop');
  await page.locator(`[data-asset-number="${num}"] a`).click();
  await expect(page.getByTestId('asset-number')).toHaveText(num);
  const events = page.getByTestId('asset-events');
  await expect(events).toContainText('渡辺 さくら');
  // 二重処理されていない: 貸出・返却が1件ずつ
  const evs = await page.evaluate(async (n) => {
    const db = await new Promise<IDBDatabase>((r) => {
      const req = indexedDB.open('workcore');
      req.onsuccess = () => r(req.result);
    });
    const all = <T,>(store: string) =>
      new Promise<T[]>((r) => {
        const q = db.transaction(store).objectStore(store).getAll();
        q.onsuccess = () => r(q.result as T[]);
      });
    const asset = (await all<{ id: string; assetNumber: string }>('assets')).find((a) => a.assetNumber === n)!;
    return (await all<{ assetId: string; type: string }>('assetEvents')).filter((e) => e.assetId === asset.id).map((e) => e.type);
  }, num);
  expect(evs.filter((t) => t === 'assign')).toHaveLength(1);
  expect(evs.filter((t) => t === 'return')).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('[Phase3] 故障の問い合わせ → 申請者の機器を特定 → 代替機の提案 → 承認 → タスク', async ({ page, isMobile }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByTestId('inventory-summary')).toBeVisible();
  await gotoHash(page, '#/helpdesk/new');
  await page.getByLabel('申請者').selectOption({ label: '渡辺 さくら（A0033）' });
  await page.getByLabel('件名').fill('ノートPCが故障して起動しない');
  await page.getByLabel('詳細内容').fill('電源ボタンを押しても画面が映りません');
  await expect(page.getByLabel('カテゴリ')).toHaveValue('cat_pc'); // 自動分類
  await page.getByTestId(isMobile ? 'submit-inquiry-mobile' : 'submit-inquiry').click();
  await expect(page.getByTestId('inquiry-number')).toBeVisible();

  // 問い合わせ詳細に、申請者の使用中PCと代替機の提案が出る (再入力不要)
  const eq = page.getByTestId('inquiry-equipment');
  await expect(eq).toContainText('代替機の手配を提案しています');
  await expect(eq).toContainText(LAPTOP);
  const card = eq.getByTestId('proposal-card');
  await expect(card).toContainText('修理中');
  await card.getByTestId('apply-proposal').click();
  await expect(page.getByText(/承認して実行しました/)).toBeVisible();
  await expect(eq.getByTestId('proposal-card')).toHaveCount(0);
  await expect(eq).toContainText('この件で対応');
  await expect(eq).toContainText('修理中');

  // 代替機の貸出・修理手配のタスクが問い合わせに紐づく (問い合わせ由来のタスクとして一覧にも出る)
  await expect(page.getByTestId('inquiry-tasks')).toContainText('代替機の引き渡し');
  await expect(page.getByTestId('inquiry-tasks')).toContainText('故障機の修理手配');
  await gotoHash(page, '#/tasks?status=open&source=inquiry');
  await expect(page.getByTestId('task-list')).toContainText('代替機の引き渡し');
  // 再読み込みしても提案が復活しない (処理済み)
  await page.reload();
  await gotoHash(page, '#/automation');
  await expect(page.getByTestId('proposal-list')).not.toContainText('ノートPCが故障して起動しない');
  expect(errors).toEqual([]);
});

test('[Phase3] 退職予定者の返却タスク／提案の見送り', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByTestId('inventory-summary')).toBeVisible();
  await gotoHash(page, '#/automation');
  const card = await openProposal(page, '山田 隆さんの貸与資産の返却');
  await expect(card).toContainText('退職');
  await card.getByTestId('apply-proposal').click();
  await expect(page.getByText(/承認して実行しました/)).toBeVisible();
  await gotoHash(page, '#/tasks?status=open&source=automation');
  await expect(page.getByTestId('task-list')).toContainText('貸与資産の返却確認');
  await expect(page.getByTestId('task-list')).toContainText('山田 隆');

  // 見送り: 提案は消え、処理履歴に残る
  await gotoHash(page, '#/automation');
  const before = await page.getByTestId('proposal-card').count();
  const first = page.getByTestId('proposal-card').first();
  const title = (await first.getAttribute('data-proposal-title'))!;
  if ((await first.getByTestId('apply-proposal').count()) === 0) await first.locator('button[aria-expanded]').click();
  await first.getByRole('button', { name: '見送る' }).click();
  await expect(page.getByTestId('proposal-card')).toHaveCount(before - 1);
  await expect(page.getByTestId('automation-runs')).toContainText(title);
  await page.reload();
  await expect(page.getByTestId('proposal-card')).toHaveCount(before - 1);
  expect(errors).toEqual([]);
});

test('[Phase3] バックアップ・復元・再読み込み後の整合性・iPhoneレイアウト', async ({ page, isMobile }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByTestId('inventory-summary')).toBeVisible();

  // 入庫 → 通知の「元に戻す」 (履歴は消さず、取り消しの記録が追加される)
  const mouseHand = await onHand(page, MOUSE);
  const movesStart = await countStore(page, 'stockMovements');
  const receive5 = async () => {
    await item(page, MOUSE).getByRole('button', { name: `${MOUSE}を入庫` }).click();
    await page.getByRole('dialog').getByRole('spinbutton', { name: '数量' }).fill('5');
    await page.getByTestId('qty-submit').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  };
  await receive5();
  await page.getByRole('button', { name: '元に戻す' }).click();
  await expect(page.getByText('取り消しました（取り消しの記録を履歴に追加）')).toBeVisible();
  expect(await onHand(page, MOUSE)).toBe(mouseHand);
  expect(await countStore(page, 'stockMovements')).toBe(movesStart + 2);
  await receive5();
  expect(await onHand(page, MOUSE)).toBe(mouseHand + 5);
  // 再読み込み後も同じ
  await page.reload();
  expect(await onHand(page, MOUSE)).toBe(mouseHand + 5);
  const counts = { items: await countStore(page, 'items'), movements: await countStore(page, 'stockMovements'), assets: await countStore(page, 'assets'), orders: await countStore(page, 'purchaseOrders') };

  // JSONバックアップ・CSV
  await gotoHash(page, '#/data');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-json').click()]);
  const path = join(mkdtempSync(join(tmpdir(), 'workcore-e2e-')), 'backup.json');
  await dl.saveAs(path);
  const backup = JSON.parse(readFileSync(path, 'utf8'));
  expect(backup.schemaVersion).toBe(4);
  expect(backup.data.stockMovements.length).toBe(counts.movements);
  expect(backup.data.assets.length).toBe(counts.assets);
  for (const id of ['export-items', 'export-movements', 'export-assets']) {
    const [csv] = await Promise.all([page.waitForEvent('download'), page.getByTestId(id).click()]);
    const text = readFileSync((await csv.path())!, 'utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.split('\n').length).toBeGreaterThan(3);
  }

  // 全削除 → 復元 → 件数・在庫が一致
  await page.getByRole('button', { name: /全削除/ }).click();
  await page.getByRole('button', { name: '全削除する' }).click();
  await expect(page.getByText(/を全削除しました/).first()).toBeVisible();
  expect(await countStore(page, 'stockMovements')).toBe(0);
  await page.getByTestId('restore-input').setInputFiles(path);
  await page.getByRole('button', { name: '上書きして復元' }).click();
  await expect(page.getByText('バックアップから復元しました').first()).toBeVisible();
  await page.reload();
  expect(await countStore(page, 'items')).toBe(counts.items);
  expect(await countStore(page, 'stockMovements')).toBe(counts.movements);
  expect(await countStore(page, 'assets')).toBe(counts.assets);
  expect(await countStore(page, 'purchaseOrders')).toBe(counts.orders);
  expect(await onHand(page, MOUSE)).toBe(mouseHand + 5);

  // 改ざんしたバックアップ (履歴と在庫が合わない) は拒否され、既存データは壊れない
  backup.data.stockLevels[0].quantity += 7;
  const bad = join(mkdtempSync(join(tmpdir(), 'workcore-e2e-')), 'bad.json');
  writeFileSync(bad, JSON.stringify(backup));
  await gotoHash(page, '#/data');
  await page.getByTestId('restore-input').setInputFiles(bad);
  await expect(page.getByText(/入出庫履歴|整合/).first()).toBeVisible();
  expect(await countStore(page, 'stockMovements')).toBe(counts.movements);

  if (isMobile) {
    const pages = ['#/', '#/inventory', '#/inventory?tab=assets', '#/inventory?tab=orders', '#/inventory?tab=analytics', '#/inventory/stocktake', '#/inventory/items/item_laptop', '#/inventory/items/item_mouse', '#/inventory/orders/po_demo_2', '#/automation', '#/menu', '#/data'];
    for (const h of pages) {
      await gotoHash(page, h);
      await page.waitForTimeout(300);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${h} で横スクロール`).toBeLessThanOrEqual(0);
    }
    await gotoHash(page, '#/inventory?tab=assets');
    const first = page.getByTestId('asset-list').locator('li a').first();
    await first.click();
    await expect(page.getByTestId('asset-number')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  }
  expect(errors).toEqual([]);
});
