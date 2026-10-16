import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173/',
    acceptDownloads: true,
    // 日付の扱い (今日・期限) を利用環境と同じ日本時間で検証する
    timezoneId: 'Asia/Tokyo',
    locale: 'ja-JP',
    launchOptions: { executablePath: process.env.CHROMIUM_PATH || undefined },
  },
  projects: [
    { name: 'iphone', use: { ...devices['iPhone 13'], browserName: 'chromium' } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    // WebKit (Safari のエンジン) での検証。CI でだけ有効にする (PW_WEBKIT=1)。
    // 注意: Playwright の WebKit は実機 iPhone Safari と同一ではない (実機の検証は別途必要)
    ...(process.env.PW_WEBKIT ? [{ name: 'webkit-iphone', use: { ...devices['iPhone 13'] } }] : []),
  ],
  webServer: {
    command: 'npm run build && npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173/',
    // 古いビルドを誤ってテストしないよう、毎回ビルドしてサーバーを起動する
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
