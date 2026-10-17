/**
 * Phase 10: アクセシビリティの自動検査 (axe-core・WCAG 2.2 AA の自動で判定できる項目)。
 * 主要な全画面と主要なダイアログを、ライトモード・ダークモードで検査する。
 * 自動検査で見つけられるのは WCAG の一部 (目安として3〜4割) で、スクリーンリーダーでの実際の読み上げ・操作の分かりやすさは
 * 手動の確認が必要 (docs/PHASE10_RESULTS.md)。
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from './fixtures';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function gotoHash(page: Page, hash: string) {
  await page.evaluate((h) => (window.location.hash = h), hash);
}
async function ids(page: Page, store: string): Promise<string[]> {
  return page.evaluate(async (store) => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('workcore');
      q.onsuccess = () => r(q.result);
    });
    const keys = await new Promise<string[]>((r) => {
      const q = db.transaction(store).objectStore(store).getAllKeys();
      q.onsuccess = () => r(q.result as string[]);
    });
    db.close();
    return keys;
  }, store);
}
type Found = { where: string; id: string; impact: string; help: string; nodes: string[] };
async function scan(page: Page, where: string, found: Found[], include?: string) {
  // アニメーション (fade-in) の途中の半透明な色で誤検出しないよう、表示が落ち着いてから検査する
  await page.waitForTimeout(400);
  let b = new AxeBuilder({ page }).withTags(TAGS);
  if (include) b = b.include(include);
  const r = await b.analyze();
  for (const v of r.violations) {
    found.push({ where, id: v.id, impact: v.impact ?? '', help: v.help, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) });
    if (process.env.A11Y_DEBUG) for (const n of v.nodes) console.log(`DETAIL\t${v.id}\t${n.html.slice(0, 160).replace(/\s+/g, ' ')}\t${(n.any[0]?.message ?? n.failureSummary ?? '').replace(/\s+/g, ' ').slice(0, 200)}`);
  }
}

for (const scheme of ['light', 'dark'] as const) {
  test(`[Phase10] アクセシビリティ (WCAG 2.2 AA の自動検査)：全画面・主要なダイアログ（${scheme === 'light' ? 'ライト' : 'ダーク'}モード）`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
    const found: Found[] = [];
    const emp = (await ids(page, 'employees'))[0]!;
    const inq = (await ids(page, 'inquiries'))[0]!;
    const item = (await ids(page, 'items'))[0]!;
    const asset = (await ids(page, 'assets'))[0]!;
    const po = (await ids(page, 'purchaseOrders'))[0];
    const doc = (await ids(page, 'documents'))[0];
    const faq = (await ids(page, 'faqs'))[0];
    const routes: [string, string][] = [
      ['#/', 'ダッシュボード'],
      ['#/employees', '社員一覧'],
      [`#/employees/${emp}`, '社員の詳細'],
      ['#/onboarding', '入社準備'],
      ['#/tasks', 'タスク（リスト）'],
      ['#/tasks?view=board', 'タスク（ボード）'],
      ['#/tasks?view=calendar', 'タスク（カレンダー）'],
      ['#/tasks?view=projects', 'タスク（プロジェクト）'],
      ['#/helpdesk', 'ヘルプデスク'],
      ['#/helpdesk/new', '問い合わせの受付'],
      [`#/helpdesk/${inq}`, '問い合わせの詳細'],
      ['#/faq', 'FAQ'],
      ...(faq ? ([[`#/faq/${faq}`, 'FAQ の詳細']] as [string, string][]) : []),
      ['#/inventory', '在庫'],
      ['#/inventory?tab=assets', 'IT資産'],
      ['#/inventory?tab=orders', '発注'],
      [`#/inventory/items/${item}`, '品目の詳細'],
      [`#/inventory/assets/${asset}`, '資産の詳細'],
      ...(po ? ([[`#/inventory/orders/${po}`, '発注書の詳細']] as [string, string][]) : []),
      ['#/inventory/stocktake', '棚卸し'],
      ['#/documents', '書類'],
      ['#/documents/new', '書類の取り込み'],
      ...(doc ? ([[`#/documents/${doc}`, '書類の詳細']] as [string, string][]) : []),
      ['#/automation', '自動化センター'],
      ['#/notifications', '通知センター'],
      ['#/data', 'データ管理'],
      ['#/settings', '設定'],
      ['#/menu', 'メニュー'],
    ];
    for (const [hash, name] of routes) {
      await gotoHash(page, hash);
      await page.waitForLoadState('networkidle');
      await scan(page, name, found);
    }
    // 主要なダイアログ
    await gotoHash(page, '#/employees');
    await page.getByRole('button', { name: /新規登録|社員を登録/ }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await scan(page, '社員の登録ダイアログ', found, '[role="dialog"]');
    await page.keyboard.press('Escape');
    await gotoHash(page, '#/tasks');
    await page.getByTestId('task-new').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByTestId('task-details').locator('summary').click();
    await scan(page, 'タスクの作成ダイアログ（詳細を開いた状態）', found, '[role="dialog"]');
    await page.keyboard.press('Escape');
    // 入力エラーの表示
    await gotoHash(page, '#/helpdesk/new');
    await page.getByRole('button', { name: /受け付ける|登録|送信/ }).last().click();
    await scan(page, '問い合わせの受付（入力エラー表示）', found);

    const summary = found.map((f) => `[${f.impact}] ${f.where}: ${f.id} — ${f.help} :: ${f.nodes.join(' | ')}`);
    console.log(`\n=== axe (${scheme}) ${found.length} violations ===\n${summary.join('\n')}\n`);
    expect(summary).toEqual([]);
  });
}

test('[Phase10] キーボードだけで操作できる：本文へスキップ・タスクの追加・ダイアログのフォーカス（閉じ込めと戻り）', async ({ page, isMobile }) => {
  test.skip(!!isMobile, 'キーボード操作は PC で検証');
  await page.goto('/#/tasks');
  await expect(page.getByTestId('quick-add-input')).toBeVisible();
  // 1. 最初の Tab で「本文へスキップ」が見える → Enter で本文へ
  await page.keyboard.press('Tab');
  const skip = page.getByTestId('skip-link');
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
  // 2. 本文から Tab でクイック追加の入力欄へ (ナビを通らない) → 入力して Enter で登録
  let reached = false;
  for (let i = 0; i < 15 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await page.getByTestId('quick-add-input').evaluate((el) => el === document.activeElement);
  }
  expect(reached).toBe(true);
  await page.keyboard.type('キーボードで追加');
  await page.keyboard.press('Enter');
  await expect(page.getByText('「キーボードで追加」を追加しました')).toBeVisible();
  // 3. ボタンを Enter で開く → フォーカスはダイアログの中 → Tab を繰り返してもダイアログの外へ出ない → Esc で閉じて元のボタンへ戻る
  await page.getByTestId('task-new').focus();
  await page.keyboard.press('Enter');
  const dlg = page.getByRole('dialog');
  await expect(dlg).toBeVisible();
  await expect.poll(() => dlg.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab');
    expect(await dlg.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  await expect(page.getByTestId('task-new')).toBeFocused();
  // フォーカスの位置が見える (アウトラインまたはリング)
  const visible = await page.getByTestId('task-new').evaluate((el) => {
    const cs = getComputedStyle(el);
    return (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none';
  });
  expect(visible).toBe(true);
});

test('[Phase10] 幅 320px（400% 拡大相当）でも横スクロールなしで表示できる', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'スマホの表示で検証');
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
  const overflow: string[] = [];
  for (const hash of ['#/', '#/employees', '#/tasks', '#/tasks?view=board', '#/tasks?view=calendar', '#/helpdesk', '#/helpdesk/new', '#/inventory', '#/inventory?tab=orders', '#/documents', '#/automation', '#/notifications', '#/data', '#/settings', '#/menu', '#/onboarding']) {
    await page.evaluate((h) => (window.location.hash = h), hash);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(200);
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    if (w > 321) overflow.push(`${hash}: ${w}px`);
  }
  expect(overflow).toEqual([]);
});
