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
  page: async ({ page }, use) => {
    await page.clock.install({ time: FIXED_NOW });
    await use(page);
  },
});
export { expect };
export type { BrowserContext, Locator, Page } from '@playwright/test';
