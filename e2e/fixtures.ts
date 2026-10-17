/**
 * E2E 共通の前提 (Phase 8): 実行日によって結果が変わらないよう、ブラウザの時計を固定日時から開始する。
 * - 2026-10-15 (木) 09:00 日本時間から時間が進む (タイマーは通常どおり動く)
 * - テスト側の日付計算も同じ基準日 (testNow) を使う
 * デモデータは初回起動日を基準に作られるため、期限超過・入社予定などの件数が毎回同じになる。
 */
import { test as base, expect } from '@playwright/test';

export const FIXED_NOW = new Date('2026-10-15T09:00:00+09:00');
/** テスト側で「今日」を基準にする日付計算用 (ブラウザと同じ基準日) */
export const testNow = () => new Date(FIXED_NOW.getTime());

export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    await page.clock.install({ time: FIXED_NOW });
    // 失敗の原因調査用 (Phase 10): 画面の URL の移り変わりとエラーを記録し、失敗したときだけ出力する
    const trail: string[] = [];
    page.on('framenavigated', (f) => f === page.mainFrame() && trail.push(`nav ${f.url().replace(/^https?:\/\/[^/]+/, '')}`));
    page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && trail.push(`${m.type()} ${m.text().slice(0, 200)}`));
    page.on('pageerror', (e) => trail.push(`pageerror ${e.message.slice(0, 200)}`));
    // ダイアログを閉じた直後は、アプリが履歴を1つ戻している途中のことがある。その最中に再読み込みすると
    // 再読み込みが中断される (ERR_ABORTED) ため、戻り終わるのを待ってから再読み込みする (最大2秒)
    const reload = page.reload.bind(page);
    page.reload = async (opts) => {
      await page
        .waitForFunction(() => !(history.state as { wcModal?: string } | null)?.wcModal, undefined, { timeout: 2000 })
        .catch(() => undefined);
      return reload(opts);
    };
    await use(page);
    if (testInfo.status !== testInfo.expectedStatus) {
      const where = await page
        .evaluate(() => `${location.hash} history.length=${history.length} state=${JSON.stringify(history.state)}`)
        .catch(() => '(取得できず)');
      console.log(`[診断] ${testInfo.title}\n  最後の画面: ${where}\n  ${trail.slice(-25).join('\n  ')}`);
    }
  },
});
export { expect };
export type { BrowserContext, Locator, Page } from '@playwright/test';
