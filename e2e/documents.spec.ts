/**
 * Phase 4 書類処理・OCR・CSV の E2E (iPhone 13 相当 / デスクトップ)。
 * テスト用の書類 (日本語の領収書画像・テキストPDF・画像PDF・納品書PDF) は、架空の内容で Chromium に描画して生成する。
 * OCR は実際に Tesseract.js (日本語＋英語) をブラウザ内で実行する。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const CSS = `body{font-family:'Noto Sans CJK JP','Noto Sans JP',sans-serif;width:560px;padding:32px;background:#fff;color:#111;font-size:20px}h1{text-align:center;letter-spacing:.4em;font-size:34px}.big{font-size:32px;text-align:center;border-bottom:2px solid #000;margin:18px 0}p{margin:8px 0}table{border-collapse:collapse;width:100%;font-size:18px}td,th{padding:4px 6px;text-align:left}`;
const RECEIPT = `<h1>領収書</h1><p>テスト 太郎 様</p><p class="big">¥5,500-</p><p>但し 文房具代として</p><p>上記正に領収いたしました</p><p>発行日 2026年10月12日</p><p>内消費税（10%） ¥500</p><p>みどり事務用品株式会社</p><p>登録番号 T9876543210987</p>`;
const DELIVERY = `<h1>納品書</h1><p>納品書番号 DN-881</p><p>納品日 2026年10月14日</p><p>株式会社あおばテクノサービス 御中</p><p>みどり事務用品株式会社</p><table><tr><th>品名</th><th>数量</th><th>単価</th><th>金額</th></tr><tr><td>コピー用紙 A4</td><td>10 冊</td><td>450</td><td>4,500</td></tr><tr><td>名刺ケース</td><td>3 個</td><td>800</td><td>2,400</td></tr></table><p>合計 6,900</p>`;

const dir = mkdtempSync(join(tmpdir(), 'workcore-docs-'));

/** 架空の書類を描画して PNG / PDF を作る */
async function makeFiles(context: BrowserContext) {
  const p = await context.newPage();
  await p.setViewportSize({ width: 640, height: 800 });
  await p.setContent(`<!doctype html><meta charset="utf-8"><style>${CSS}</style>${RECEIPT}`);
  const png = await p.screenshot({ fullPage: true });
  writeFileSync(join(dir, 'receipt.png'), png);
  await p.pdf({ path: join(dir, 'receipt-text.pdf'), width: '210mm', height: '297mm' });
  // 画像だけのPDF (スキャンしたPDFと同じく文字が埋め込まれていない)
  await p.setContent(`<!doctype html><style>body{margin:0}</style><img src="data:image/png;base64,${png.toString('base64')}" style="width:160mm">`);
  await p.pdf({ path: join(dir, 'receipt-scan.pdf'), width: '210mm', height: '297mm' });
  await p.setContent(`<!doctype html><meta charset="utf-8"><style>${CSS}</style>${DELIVERY}`);
  await p.pdf({ path: join(dir, 'delivery.pdf'), width: '210mm', height: '297mm' });
  await p.close();
}

async function gotoHash(page: Page, hash: string) {
  await page.evaluate((h) => (window.location.hash = h), hash);
}
const field = (page: Page, key: string) => page.locator(`[data-field="${key}"] input, [data-field="${key}"] textarea`).first();
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
/** 取り込み → 解析 (必要なら OCR を準備) → 確認画面まで */
async function importAndProcess(page: Page, testid: string, path: string, opts: { type?: string } = {}) {
  await gotoHash(page, '#/documents/new');
  if (opts.type) await page.getByLabel('書類の種類').selectOption({ label: opts.type });
  await page.getByTestId(testid).setInputFiles(path);
  await expect(page.getByTestId('process-panel')).toBeVisible();
  await expect(page.getByTestId('process-panel')).not.toHaveAttribute('data-ocr-ready', 'checking');
  if ((await page.getByTestId('process-panel').getAttribute('data-ocr-ready')) === 'no') {
    await page.getByTestId('ocr-download').click();
    await expect(page.getByTestId('process-panel')).toHaveAttribute('data-ocr-ready', 'yes', { timeout: 60_000 });
  }
  await page.getByTestId('process-start').click();
  await expect(page.getByTestId('process-panel')).toBeHidden({ timeout: 90_000 });
  if (await page.getByTestId('view-fields').isVisible()) await page.getByTestId('view-fields').click();
  await expect(page.getByTestId('review-form')).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('[Phase4] 画像の取り込み → 日本語OCR → 確認・修正 → 保存 → 再起動後も保持 → 重複警告', async ({ page, context, isMobile }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await makeFiles(context);
  await page.goto('/');
  await expect(page.getByTestId('documents-summary')).toBeVisible();
  const before = { employees: await countStore(page, 'employees'), items: await countStore(page, 'items'), inquiries: await countStore(page, 'inquiries') };

  // 1. 写真ライブラリ (iPhone) / ファイル から画像を取り込む → 2. OCR (初回は準備のダウンロード)
  await importAndProcess(page, isMobile ? 'import-library' : 'import-file', join(dir, 'receipt.png'));
  await expect(page.getByTestId('doc-number')).toHaveText(/DOC-\d{4}-0001/);
  await expect(field(page, 'total')).toHaveValue('5500');
  await expect(field(page, 'issueDate')).toHaveValue('2026-10-12');
  await expect(field(page, 'issuer')).toHaveValue(/みどり事務用品/);
  await expect(field(page, 'registrationNumber')).toHaveValue('T9876543210987');
  // 抽出元の行と文字認識の信頼度を表示
  await expect(page.getByTestId('evidence-total')).toContainText('文字認識');
  // 確認が必要な項目が先頭にまとまっている
  await expect(page.getByTestId('attention-fields')).toContainText('合計金額');
  // 重要項目を確認しないと確認完了できない
  await expect(page.getByTestId('review-confirm')).toBeDisabled();

  // 5. 修正して一時保存 → 確認完了
  // 確認が不要な項目は「その他の項目」に折りたたまれている
  const others = page.getByTestId('review-form').locator('details');
  if (!(await others.getAttribute('open'))) await others.locator('summary').click();
  await field(page, 'notes').fill('文房具代（E2E）');
  await field(page, 'issuer').fill('みどり事務用品株式会社 本店');
  await expect(page.locator('[data-field="issuer"]')).toContainText('修正前');
  await page.getByTestId('review-save').click();
  await expect(page.getByText('一時保存しました（確認待ち）')).toBeVisible();
  for (const k of ['issueDate', 'total']) await page.getByTestId(`review-${k}`).check();
  await page.getByTestId('review-confirm').click();
  await expect(page.getByText('確認済みとして保存しました')).toBeVisible();
  await expect(page.getByTestId('review-actions')).toHaveCount(0);

  // 8. 再起動 (再読み込み) 後も残る
  await page.reload();
  await expect(page.getByTestId('doc-number')).toBeVisible();
  if (isMobile) await page.getByTestId('view-fields').click();
  await expect(field(page, 'issuer')).toHaveValue('みどり事務用品株式会社 本店');
  if (isMobile) await page.getByTestId('view-original').click();
  await expect(page.getByTestId('doc-preview-image')).toBeVisible();

  // 6. 同じファイルの再登録は警告 (中止できる)
  await gotoHash(page, '#/documents/new');
  await page.getByTestId('import-file').setInputFiles(join(dir, 'receipt.png'));
  await expect(page.getByRole('dialog')).toContainText('同じファイルが既に登録されています');
  await page.getByRole('dialog').getByRole('button', { name: 'キャンセル' }).click();
  expect(await countStore(page, 'documents')).toBe(1);

  // 9. Phase 1〜3 のデータはそのまま
  expect(await countStore(page, 'employees')).toBe(before.employees);
  expect(await countStore(page, 'items')).toBe(before.items);
  expect(await countStore(page, 'inquiries')).toBe(before.inquiries);
  expect(errors).toEqual([]);
});

test('[Phase4] テキストPDF・画像PDF の解析経路、類似書類の比較', async ({ page, context }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await makeFiles(context);
  await page.goto('/');
  await expect(page.getByTestId('documents-summary')).toBeVisible();

  // 3. テキストPDF: 埋め込みテキストから直接抽出 (OCR不要)
  await importAndProcess(page, 'import-file', join(dir, 'receipt-text.pdf'));
  await expect(field(page, 'total')).toHaveValue('5500');
  await expect(page.getByTestId('evidence-total')).toContainText('PDFのテキスト');
  const firstNumber = await page.getByTestId('doc-number').innerText();

  // 4. 画像PDF: 文字が埋め込まれていないため OCR の経路を通る
  await importAndProcess(page, 'import-file', join(dir, 'receipt-scan.pdf'));
  await expect(field(page, 'total')).toHaveValue('5500');
  await expect(page.getByTestId('evidence-total')).toContainText('文字認識');
  // 6. 発行元・発行日・金額が同じ書類 → 類似として警告し、比較画面を出す (自動では削除しない)
  await expect(page.getByTestId('duplicate-warning')).toContainText(firstNumber);
  await page.getByTestId('compare-duplicate').first().click();
  await expect(page.getByTestId('compare-table')).toContainText('5500');
  await page.getByTestId('not-duplicate').click();
  await expect(page.getByTestId('duplicate-warning')).toHaveCount(0);
  expect(await countStore(page, 'documents')).toBe(2);
  expect(errors).toEqual([]);
});

test('[Phase4] 納品書 → 確認 → 在庫へ引き渡し（確認と実行の操作が必須・1回だけ）', async ({ page, context }) => {
  test.setTimeout(180_000);
  await makeFiles(context);
  await page.goto('/');
  await expect(page.getByTestId('documents-summary')).toBeVisible();
  const onHand = async () => {
    await gotoHash(page, `#/inventory?tab=stock&q=${encodeURIComponent('コピー用紙')}`);
    const t = await page.locator('[data-item-name="コピー用紙 A4（500枚）"]').getByText(/実在庫 \d+/).innerText();
    return Number(t.match(/実在庫 (\d+)/)![1]);
  };
  const paperBefore = await onHand();

  await importAndProcess(page, 'import-file', join(dir, 'delivery.pdf'), { type: '納品書' });
  await expect(page.getByTestId('line-list').locator('li')).toHaveCount(2);
  // 確認前は在庫に反映できない
  await expect(page.getByTestId('inventory-handoff')).toContainText('確認完了');
  for (const k of ['issuer', 'issueDate', 'total']) await page.getByTestId(`review-${k}`).check();
  await page.getByTestId('review-confirm').click();
  await expect(page.getByText('確認済みとして保存しました')).toBeVisible();
  // OCR / 抽出だけでは在庫は変わっていない
  const docUrl = await page.evaluate(() => window.location.hash);
  expect(await onHand()).toBe(paperBefore);
  await gotoHash(page, docUrl);
  await page.getByTestId('handoff-open').click();
  const rows = page.getByTestId('handoff-rows').locator('li');
  await expect(rows).toHaveCount(2);
  // 品名から品目を推定 (名刺ケースは自動で対応付け、コピー用紙は選択)
  await rows.nth(0).getByLabel('在庫の品目').selectOption({ label: 'ITM-0011 コピー用紙 A4（500枚）' });
  await page.getByTestId('handoff-next').click();
  await expect(page.getByTestId('handoff-summary')).toContainText('＋10');
  await page.getByTestId('handoff-execute').dblclick();
  await expect(page.getByTestId('inventory-handoff-done')).toBeVisible();
  expect(await onHand()).toBe(paperBefore + 10);
  // 再読み込みしても二重反映されない
  await page.reload();
  expect(await onHand()).toBe(paperBefore + 10);
  await gotoHash(page, docUrl);
  await expect(page.getByTestId('inventory-handoff-done')).toBeVisible();
  await expect(page.getByTestId('handoff-open')).toHaveCount(0);
});

test('[Phase4] CSV出力（全件・明細）・バックアップ（元ファイル込み）から復元・iPhoneレイアウト', async ({ page, context, isMobile }) => {
  test.setTimeout(180_000);
  await makeFiles(context);
  await page.goto('/');
  await expect(page.getByTestId('documents-summary')).toBeVisible();
  await importAndProcess(page, 'import-file', join(dir, 'delivery.pdf'), { type: '納品書' });
  await importAndProcess(page, 'import-file', join(dir, 'receipt-text.pdf'));

  // 7. CSV 出力 (期間・種類の指定、明細行の別ファイル)
  await gotoHash(page, '#/documents');
  await page.getByTestId('open-export').click();
  await page.getByTestId('export-scope-range').check();
  await page.getByTestId('export-from').fill('2026-10-13');
  await expect(page.getByTestId('export-count')).toHaveText('出力件数：1件');
  await page.getByTestId('export-scope-all').check();
  await expect(page.getByTestId('export-count')).toHaveText('出力件数：2件');
  const downloads: string[] = [];
  page.on('download', async (d) => downloads.push(readFileSync((await d.path())!, 'utf8')));
  await page.getByTestId('export-download').click();
  await expect.poll(() => downloads.length).toBe(2);
  const [docsCsv, linesCsv] = downloads.sort((a, b) => b.length - a.length);
  expect(docsCsv!.charCodeAt(0)).toBe(0xfeff);
  expect(docsCsv).toContain('みどり事務用品株式会社');
  expect(docsCsv).toContain('6900');
  expect(linesCsv).toContain('コピー用紙 A4');

  // 10. バックアップ (元ファイル込み) → 全削除 → 復元前の内容確認 → 復元
  await gotoHash(page, '#/data');
  await expect(page.getByTestId('backup-include-files')).toBeChecked();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-json').click()]);
  const path = join(dir, `backup-${Date.now()}.json`);
  await dl.saveAs(path);
  const backup = JSON.parse(readFileSync(path, 'utf8'));
  expect(backup.schemaVersion).toBe(5);
  expect(backup.data.documents).toHaveLength(2);
  expect(backup.files).toHaveLength(2);
  await page.getByRole('button', { name: /全削除/ }).click();
  await page.getByRole('button', { name: '全削除する' }).click();
  await expect(page.getByText(/を全削除しました/).first()).toBeVisible();
  expect(await countStore(page, 'documentFiles')).toBe(0);
  await page.getByTestId('restore-input').setInputFiles(path);
  await expect(page.getByRole('dialog')).toContainText('書類：');
  await expect(page.getByRole('dialog')).toContainText('書類の元ファイル：2件（内容のハッシュを検証済み）');
  await page.getByRole('button', { name: '上書きして復元' }).click();
  await expect(page.getByText('バックアップから復元しました').first()).toBeVisible();
  await page.reload();
  expect(await countStore(page, 'documents')).toBe(2);
  expect(await countStore(page, 'documentFiles')).toBe(2);
  await gotoHash(page, '#/documents');
  await page.getByTestId('document-list').locator('a').first().click();
  if (isMobile) await page.getByTestId('view-original').click();
  await expect(page.getByTestId('doc-preview-pdf').locator('canvas')).toBeVisible({ timeout: 20_000 });

  // 改ざんした元ファイルを含むバックアップは復元しない
  backup.files[0].base64 = Buffer.from('broken').toString('base64');
  backup.files[0].size = 6;
  const bad = join(dir, 'bad-backup.json');
  writeFileSync(bad, JSON.stringify(backup));
  await gotoHash(page, '#/data');
  await page.getByTestId('restore-input').setInputFiles(bad);
  await expect(page.getByText(/ハッシュ.*一致しません|破損/).first()).toBeVisible();
  expect(await countStore(page, 'documents')).toBe(2);

  if (isMobile) {
    for (const h of ['#/documents', '#/documents/new', '#/', '#/menu', '#/data']) {
      await gotoHash(page, h);
      await page.waitForTimeout(300);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${h} で横スクロール`).toBeLessThanOrEqual(0);
    }
    await gotoHash(page, '#/documents');
    await page.getByTestId('document-list').locator('a').first().click();
    for (const v of ['original', 'fields']) {
      await page.getByTestId(`view-${v}`).click();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `書類詳細（${v}）で横スクロール`).toBeLessThanOrEqual(0);
    }
  }
});
