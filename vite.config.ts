/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { Plugin } from 'vite';

/**
 * Content Security Policy (Phase 11)。GitHub Pages では応答ヘッダーを設定できないため meta で指定する。
 * - 外部への通信・外部のスクリプトを禁止 (データは端末内だけ。意図しない送信を防ぐ)
 * - インラインのスクリプトを禁止 (XSS の被害を抑える)
 * - OCR (tesseract.js) は blob: のワーカーと WebAssembly を使うため、blob: と wasm-unsafe-eval だけを許可
 * 開発サーバー (HMR) では使わず、本番ビルドだけに付ける。meta では frame-ancestors などは指定できない
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self' blob: 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' blob: data:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-src 'self' blob:",
].join('; ');

function cspPlugin(): Plugin {
  return {
    name: 'workcore-csp',
    apply: 'build',
    transformIndexHtml: (html) => html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  };
}

// GitHub Pages のサブパス (/<repo>/) でも動くよう相対パスでビルドし、
// ルーティングはハッシュ方式 (#/employees) を採用している。
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), cspPlugin()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/test/setup.ts'],
  },
});
