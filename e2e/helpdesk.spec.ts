/**
 * Phase 2 業務シナリオE2E (iPhone 13 相当 / デスクトップ)
 * 問い合わせ登録 → 自動分類 → FAQ候補 → タスク生成 → タスク完了 → 解決 → 完了 → 分析 → 再読込 → バックアップ復元
 * 操作回数 (タップ・入力) を計測し、test-results/ux-metrics-*.json に出力する。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/** 操作回数カウンター (タップ・選択・文字入力をそれぞれ1操作とする) */
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

async function gotoHash(page: Page, hash: string) {
  await page.evaluate((h) => (window.location.hash = h), hash);
}

const navLink = (page: Page, name: string) => page.getByRole('navigation', { name: 'メインメニュー' }).filter({ visible: true }).getByRole('link', { name });

test('[Phase2] 問い合わせ登録 → 自動分類 → タスク生成 → 完了 → 分析 の一連の業務', async ({ page, isMobile }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const op = counter();
  const metrics: Record<string, unknown> = { device: info.project.name };

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
  // 実演ガイドを開始 (操作に応じて自動でチェックが付く)
  await page.getByTestId('start-guide').click();
  await expect(page.getByTestId('demo-guide')).toContainText('0 / 6 完了');
  const before = Number(await page.getByTestId('hd-summary-解決済み').locator('p').nth(1).innerText().then((t) => t.replace(/\D/g, '')));

  // 1. 問い合わせ登録 (ダッシュボードから) ------------------------------------
  op.reset();
  await op.tap(navLink(page, isMobile ? '問い合わせ' : 'ヘルプデスク'));
  await op.tap(page.getByTestId('new-inquiry'));
  await op.select(page.getByLabel('申請者'), { label: '渡辺 さくら（A0033）' });
  await expect(page.getByText('所属：営業部')).toBeVisible(); // 社員情報の再利用 (部署は再入力不要)
  await op.fill(page.getByLabel('件名'), '新入社員のPCが足りません');
  await op.fill(page.getByLabel('詳細内容'), '来週入社する2名分のノートPCが不足しています');

  // 2. 自動分類の候補と根拠
  const panel = page.getByTestId('classification-panel');
  await expect(panel).toContainText('PC・周辺機器');
  await expect(page.getByLabel('カテゴリ')).toHaveValue('cat_pc');
  await expect(page.getByLabel('対応担当者')).toHaveValue('小林 美咲'); // カテゴリ既定担当者を自動入力
  await panel.getByText('判定の根拠を見る').click();
  await expect(page.getByTestId('classification-reasons')).toContainText('PC・周辺機器');

  // 3. 連打しても1件だけ登録される
  const submit = page.getByTestId(isMobile ? 'submit-inquiry-mobile' : 'submit-inquiry');
  op.c.taps++;
  await submit.dblclick();
  await expect(page.getByTestId('inquiry-number')).toBeVisible();
  const number = await page.getByTestId('inquiry-number').innerText();
  metrics.registerInquiry = op.snapshot();

  // 4. タスク提案 → 1件外して承認 → 登録
  op.reset();
  await op.tap(page.getByTestId('next-action').getByRole('button', { name: '対応タスクを作成' }));
  const proposals = page.getByTestId('task-proposals').locator('li');
  await expect(proposals).toHaveCount(3);
  await expect(page.getByTestId('task-proposals')).toContainText('PC在庫の確認');
  await op.tap(page.getByLabel('PCの発注・購入申請を登録する'));
  await op.tap(page.getByTestId('apply-inquiry-tasks'));
  await expect(page.getByText('2件の対応タスクを登録しました')).toBeVisible();
  metrics.createTasks = op.snapshot();
  await expect(page.locator('main').getByText('対応中', { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId('inquiry-tasks').locator('[data-testid=task-item]')).toHaveCount(2);

  // 5. 重複防止: もう一度提案しても作成済みの2件は出ない
  await page.getByRole('button', { name: '提案' }).click();
  await expect(page.getByTestId('task-proposals').locator('li')).toHaveCount(1);
  await expect(page.getByRole('dialog')).toContainText('作成済みのため除外：PC在庫の確認、入社準備タスクとの照合');
  await page.getByRole('dialog').getByRole('button', { name: 'キャンセル' }).click();

  // 6. 解決済みにしても、タスク未完了では完了にできない
  await page.getByRole('button', { name: '解決済み', exact: true }).click();
  await page.getByRole('dialog').getByLabel('解決内容').fill('予備のノートPCを2台貸与し、追加購入を総務に依頼');
  await page.getByTestId('confirm-resolve').click();
  await expect(page.getByText('解決済みにしました')).toBeVisible();
  await page.getByTestId('next-action').getByRole('button', { name: '完了にする' }).click();
  await expect(page.getByTestId('close-checklist')).toContainText('関連タスクがすべて完了（0/2）');
  await page.getByRole('dialog').getByLabel(/申請者.*確認した/).check();
  await expect(page.getByTestId('confirm-close')).toBeDisabled();
  await page.getByRole('dialog').getByRole('button', { name: 'キャンセル' }).click();

  // 7. タスク管理でタスクを完了 → 問い合わせの対応履歴に反映
  for (const title of ['PC在庫の確認', '入社準備タスクとの照合']) {
    await page.getByTestId('inquiry-tasks').getByLabel(`「${title}」の進捗状況`).selectOption('done');
    await expect(page.getByText(`「${title}」を完了にしました`)).toBeVisible();
  }
  await expect(page.getByTestId('inquiry-history')).toContainText('タスク「PC在庫の確認」が「完了」になりました');
  await expect(page.locator('main').getByText('解決済み', { exact: true }).first()).toBeVisible(); // 自動で完了にはならない

  // 8. 完了 (申請者確認)
  op.reset();
  await op.tap(page.getByTestId('next-action').getByRole('button', { name: '完了にする' }));
  await op.tap(page.getByRole('dialog').getByLabel(/申請者.*確認した/));
  await op.tap(page.getByTestId('confirm-close'));
  await expect(page.getByText(`${number} を完了にしました`)).toBeVisible();
  metrics.closeInquiry = op.snapshot();

  // 9. ダッシュボードに反映
  await gotoHash(page, '#/');
  await expect(page.getByTestId('hd-summary-解決済み')).toContainText(String(before + 1));

  await expect(page.getByTestId('demo-guide')).toContainText('5 / 6 完了');

  // 10. 分析
  await gotoHash(page, '#/helpdesk?view=analytics');
  await expect(page.getByTestId('avg-resolution')).toBeVisible();
  await gotoHash(page, '#/');
  await expect(page.getByTestId('demo-guide')).toContainText('6 / 6 完了');
  await gotoHash(page, '#/helpdesk?view=analytics');
  await expect(page.getByTestId('frequent-list')).toContainText('Wi-Fi');
  await expect(page.getByText('定義：受付日時から、最初に「解決済み」にした日時まで')).toBeVisible();

  // 11. 再読み込み後も保持
  await page.reload();
  await gotoHash(page, '#/helpdesk?status=done');
  await page.getByLabel('問い合わせを検索').fill(number);
  await expect(page.getByTestId('inquiry-count')).toHaveText('1件を表示');
  await page.getByTestId('inquiry-list').getByRole('link').first().click();
  await expect(page.locator('main').getByText('完了', { exact: true }).first()).toBeVisible();

  // 12. 検索条件は詳細から戻っても保持される
  await page.goBack();
  await expect(page.getByLabel('問い合わせを検索')).toHaveValue(number);

  // 13. FAQ検索の手順 (計測)
  op.reset();
  await op.tap(navLink(page, isMobile ? 'メニュー' : 'FAQ'));
  if (isMobile) await op.tap(page.getByRole('link', { name: /^FAQ/ }));
  await op.fill(page.getByLabel('FAQを検索'), 'wifi');
  await expect(page.getByTestId('faq-list').locator('li').first()).toContainText('Wi-Fi');
  await op.tap(page.getByTestId('faq-list').getByRole('link').first());
  await expect(page.getByTestId('faq-answer')).toContainText('機内モード');
  metrics.faqSearch = op.snapshot();

  writeFileSync(join(info.outputDir, '..', `ux-metrics-${info.project.name}.json`), JSON.stringify(metrics, null, 2));
  console.log('UX_METRICS', JSON.stringify(metrics));
  expect(errors).toEqual([]);
});

test('[Phase2] 分類不能・過剰判定の防止・秘密情報・FAQ候補', async ({ page }) => {
  await page.goto('/#/helpdesk/new');
  const panel = page.getByTestId('classification-panel');

  await page.getByLabel('件名').fill('ログインできない');
  await expect(panel).toContainText('その他・要確認');
  await expect(panel).toContainText('優先度 中');

  await page.getByLabel('件名').fill('Googleにログインできない');
  await expect(panel).toContainText('Googleアカウント');
  await expect(panel).toContainText('優先度 中'); // ログイン不可だけでは高にしない

  await page.getByLabel('件名').fill('社内全員がネットワークに接続できない');
  await expect(panel).toContainText('ネットワーク');
  await expect(panel).toContainText('優先度 高');

  // 担当者が修正した値は自動で上書きされない
  await page.getByLabel('優先度').selectOption({ label: '低' });
  await page.getByLabel('詳細内容').fill('至急お願いします');
  await page.waitForTimeout(400);
  await expect(page.getByLabel('優先度')).toHaveValue('low');
  await expect(panel).toContainText('担当者が優先度を変更しています');

  // FAQ候補 (確定手順) と過去事例 (未検証) の区別
  await page.getByLabel('件名').fill('会議室のWi-Fiにつながらない');
  const sugg = page.getByTestId('solution-suggestions');
  await expect(sugg).toContainText('FAQ（確認済みの手順）');
  await expect(sugg).toContainText('Wi-Fiにつながらないときの確認手順');
  await expect(sugg).toContainText('参考：過去の対応例（未検証）');

  // 秘密情報
  await page.getByLabel('詳細内容').fill('パスワード: abc12345 で入れません');
  await expect(page.getByText('パスワードらしき文字列があります')).toBeVisible();
  await page.getByRole('button', { name: '自動で伏せ字にする' }).click();
  await expect(page.getByLabel('詳細内容')).toHaveValue('パスワード: ＊＊＊（削除済み） で入れません');
  await expect(page.getByText('パスワードらしき文字列があります')).toHaveCount(0);
});

test('[Phase2] 途中離脱・誤操作からの復帰（下書き・破棄確認・元に戻す）', async ({ page }) => {
  // 下書きの復元
  await page.goto('/#/helpdesk/new');
  await page.getByLabel('件名').fill('プリンターで印刷できない');
  await page.waitForTimeout(700);
  await gotoHash(page, '#/');
  await page.reload();
  await gotoHash(page, '#/helpdesk/new');
  await expect(page.getByText('前回の入力途中の内容を復元しました')).toBeVisible();
  await expect(page.getByLabel('件名')).toHaveValue('プリンターで印刷できない');
  await page.getByRole('button', { name: '破棄して新規入力' }).click();
  await expect(page.getByLabel('件名')).toHaveValue('');

  // モーダル: 入力中に背景をタップしても消えない
  await gotoHash(page, '#/tasks');
  await page.getByRole('button', { name: '新規タスク' }).click();
  await page.getByRole('dialog').getByLabel('タスク名').fill('入力途中のタスク');
  await page.getByTestId('modal-backdrop').click({ position: { x: 10, y: 10 }, force: true });
  await expect(page.getByText('入力した内容は保存されていません')).toBeVisible();
  await page.getByRole('button', { name: '編集を続ける' }).click();
  await expect(page.getByRole('dialog').getByLabel('タスク名')).toHaveValue('入力途中のタスク');
  await page.getByRole('dialog').getByRole('button', { name: 'キャンセル' }).click();
  await page.getByRole('button', { name: '破棄して閉じる' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // 変更がなければ確認なしで閉じる (過剰な確認を出さない)
  await page.getByRole('button', { name: '新規タスク' }).click();
  await page.getByTestId('modal-backdrop').click({ position: { x: 10, y: 10 }, force: true });
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // スクロール位置の復元 (一覧 → 詳細 → 戻る)
  await gotoHash(page, '#/helpdesk?status=all');
  await expect(page.getByTestId('inquiry-list')).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 600));
  await page.waitForTimeout(200);
  await gotoHash(page, '#/helpdesk/inq_demo_3');
  await expect(page.getByTestId('inquiry-number')).toBeVisible();
  await page.goBack();
  await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(600);

  // 削除の取り消し
  await gotoHash(page, '#/tasks');
  await page.getByRole('tab', { name: /すべて/ }).click();
  const first = page.getByTestId('task-item').first();
  const title = (await first.getAttribute('data-task-title'))!;
  const n = await page.getByTestId('task-item').count();
  await first.getByRole('button').first().click();
  await page.getByRole('dialog').getByRole('button', { name: '削除' }).click();
  await expect(page.getByTestId('task-item')).toHaveCount(n - 1);
  await page.getByRole('button', { name: '元に戻す' }).click();
  await expect(page.getByText('元に戻しました')).toBeVisible();
  await expect(page.getByTestId('task-item')).toHaveCount(n);
  await expect(page.locator(`[data-task-title="${title}"]`).first()).toBeVisible();
});

test('[Phase2] FAQ化・バックアップ復元・既存データ保持・iPhoneレイアウト', async ({ page, isMobile }) => {
  await page.goto('/#/helpdesk?status=done');
  await expect(page.getByTestId('inquiry-list')).toBeVisible(); // 初期化完了を待ってから件数を数える
  const employeesBefore = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r) => {
      const req = indexedDB.open('workcore');
      req.onsuccess = () => r(req.result);
    });
    return new Promise<number>((r) => {
      const c = db.transaction('employees').objectStore('employees').count();
      c.onsuccess = () => r(c.result);
    });
  });

  // 解決済み案件からFAQ化 (確認チェックが必須)
  await page.getByTestId('inquiry-list').locator('[data-inquiry-title="Outlookでメールが送信できない"] a').click();
  await page.getByRole('button', { name: 'FAQにする' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('質問（よくある問い合わせ）')).toHaveValue('Outlookでメールが送信できない');
  await expect(dialog.getByRole('button', { name: '保存する' })).toBeDisabled();
  for (const cb of await page.getByTestId('faq-checks').getByRole('checkbox').all()) await cb.check();
  await dialog.getByRole('button', { name: '保存する' }).click();
  await expect(page.getByText('FAQを下書き（無効）として保存しました')).toBeVisible();

  // JSONバックアップ → 問い合わせ削除 → 復元
  await gotoHash(page, '#/data');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-json').click()]);
  const path = join(mkdtempSync(join(tmpdir(), 'workcore-e2e-')), 'backup.json');
  await dl.saveAs(path);
  const backup = JSON.parse(readFileSync(path, 'utf8'));
  expect(backup.schemaVersion).toBe(3);
  expect(backup.data.inquiries.length).toBeGreaterThan(10);
  const [csv] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-inquiries').click()]);
  expect(readFileSync((await csv.path())!, 'utf8').charCodeAt(0)).toBe(0xfeff);

  await page.getByRole('button', { name: /全削除/ }).click();
  await page.getByRole('button', { name: '全削除する' }).click();
  await expect(page.getByText('社員・タスクを全削除しました').or(page.getByText('社員・タスク・問い合わせを全削除しました')).first()).toBeVisible();
  await page.getByTestId('restore-input').setInputFiles(path);
  await page.getByRole('button', { name: '上書きして復元' }).click();
  await expect(page.getByText('バックアップから復元しました').first()).toBeVisible();
  await page.reload();
  await gotoHash(page, '#/faq?state=disabled');
  await expect(page.getByTestId('faq-list')).toContainText('Outlookでメールが送信できない');
  const employeesAfter = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r) => {
      const req = indexedDB.open('workcore');
      req.onsuccess = () => r(req.result);
    });
    return new Promise<number>((r) => {
      const c = db.transaction('employees').objectStore('employees').count();
      c.onsuccess = () => r(c.result);
    });
  });
  expect(employeesAfter).toBe(employeesBefore);

  // iPhone幅で横スクロールが出ない・タップ領域が十分
  if (isMobile) {
    for (const h of ['#/', '#/helpdesk', '#/helpdesk/new', '#/helpdesk?view=analytics', '#/faq', '#/settings', '#/menu', '#/tasks', '#/employees', '#/data']) {
      await gotoHash(page, h);
      await page.waitForTimeout(250);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${h} で横スクロール`).toBeLessThanOrEqual(0);
    }
    const navHeights = await page.getByRole('navigation', { name: 'メインメニュー' }).filter({ visible: true }).getByRole('link').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    expect(Math.min(...navHeights)).toBeGreaterThanOrEqual(44);
  }
});
