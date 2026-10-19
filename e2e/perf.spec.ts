/**
 * Phase 12: 性能の計測 (通常のテストでは実行しない。PERF=1 のときだけ)。
 *   PERF=1 CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test e2e/perf.spec.ts --project=desktop
 * タスク 1,000 / 10,000 / 50,000 件と、それに比例した社員・問い合わせ・書類・操作履歴を IndexedDB に直接入れて、
 * 起動・一覧・検索・保存・画面移動の時間と、JS のメモリ使用量を測る。結果は docs/PHASE12_RESULTS.md に記録する。
 */
// 固定時計 (fixtures の clock.install) は performance も置き換えるため、計測では使わない
import { expect, test, type Page } from '@playwright/test';

test.skip(!process.env.PERF, 'PERF=1 のときだけ実行');
test.setTimeout(600_000);

const SIZES = (process.env.PERF_SIZES ?? '1000,10000,50000').split(',').map(Number);

async function seed(page: Page, n: number) {
  await page.evaluate(async (n) => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('workcore');
      q.onsuccess = () => r(q.result);
    });
    const at = '2026-09-01T09:00:00.000Z';
    const depts = await new Promise<{ id: string }[]>((r) => {
      const q = db.transaction('departments').objectStore('departments').getAll();
      q.onsuccess = () => r(q.result);
    });
    const emps = Math.max(50, Math.round(n / 20));
    const put = (store: string, rows: unknown[]) =>
      new Promise<void>((r, j) => {
        const tx = db.transaction(store, 'readwrite');
        const s = tx.objectStore(store);
        for (const row of rows) s.put(row);
        tx.oncomplete = () => r();
        tx.onerror = () => j(tx.error);
      });
    const employees = Array.from({ length: emps }, (_, i) => ({
      id: `perf_emp_${i}`,
      employeeNumber: `P${String(i).padStart(6, '0')}`,
      name: `計測 社員${i}`,
      departmentId: depts[i % depts.length]!.id,
      position: '',
      employmentType: '正社員',
      hireDate: '2020-04-01',
      retireDate: null,
      status: 'active',
      notes: '',
      createdAt: at,
      updatedAt: at,
    }));
    await put('employees', employees);
    const statuses = ['todo', 'in_progress', 'done', 'on_hold'];
    const tasks = Array.from({ length: n }, (_, i) => ({
      id: `perf_task_${i}`,
      employeeId: i % 3 === 0 ? `perf_emp_${i % emps}` : null,
      title: `計測用のタスク ${i}（${['見積', '請求', '備品', '採用', '研修'][i % 5]}）`,
      description: i % 7 === 0 ? `メモ ${i}` : '',
      assigneeDepartmentId: i % 2 ? depts[i % depts.length]!.id : null,
      assignee: i % 4 === 0 ? `担当${i % 30}` : '',
      priority: ['high', 'medium', 'low'][i % 3],
      dueDate: i % 5 === 0 ? null : `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      status: statuses[i % 4],
      source: 'manual',
      ruleId: null,
      inquiryId: null,
      tags: i % 6 === 0 ? ['計測'] : undefined,
      createdAt: at,
      updatedAt: at,
      completedAt: i % 4 === 2 ? at : null,
    }));
    for (let i = 0; i < tasks.length; i += 5000) await put('tasks', tasks.slice(i, i + 5000));
    const inquiries = Array.from({ length: Math.round(n / 10) }, (_, i) => ({
      id: `perf_inq_${i}`,
      number: `HD-P${String(i).padStart(6, '0')}`,
      receivedAt: at,
      requesterId: `perf_emp_${i % emps}`,
      requesterName: `計測 社員${i % emps}`,
      requesterDepartmentId: depts[i % depts.length]!.id,
      title: `計測用の問い合わせ ${i}`,
      body: '計測',
      categoryId: 'cat_pc',
      priority: 'medium',
      assignee: '',
      dueDate: '2026-10-20',
      status: ['new', 'in_progress', 'resolved', 'closed'][i % 4],
      resolution: '',
      resolvedAt: null,
      closedAt: null,
      classification: null,
      faqIds: [],
      history: [],
      createdAt: at,
      updatedAt: at,
    }));
    for (let i = 0; i < inquiries.length; i += 5000) await put('inquiries', inquiries.slice(i, i + 5000));
    db.close();
  }, n);
}

async function ms(fn: () => Promise<unknown>): Promise<number> {
  const t = Date.now();
  await fn();
  return Date.now() - t;
}

for (const n of SIZES) {
  test(`[Phase12] 性能：タスク ${n.toLocaleString()} 件`, async ({ page }) => {
    // 保存の内訳の記録を有効にする (src/app/AppData.tsx の perfMark)
    await page.addInitScript(() => ((window as unknown as { __WC_PERF__: boolean }).__WC_PERF__ = true));
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
    await seed(page, n);
    const result: Record<string, number | string> = { tasks: n };
    // 1. 起動 (再読み込みからダッシュボードの表示まで)
    result.startup = await ms(async () => {
      await page.reload();
      await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible({ timeout: 120_000 });
      await expect(page.getByTestId('inventory-summary')).toBeVisible({ timeout: 120_000 });
    });
    // 2. タスク一覧へ移動 (全件のスコープ)
    result.openTaskList = await ms(async () => {
      await page.evaluate(() => (window.location.hash = '#/tasks?status=all'));
      await expect(page.getByTestId('task-count')).toContainText('件', { timeout: 120_000 });
      await expect(page.locator('[data-testid="task-list"] [data-testid="task-item"]').first()).toBeVisible({ timeout: 120_000 });
    });
    result.renderedItems = await page.locator('[data-testid="task-list"] [data-testid="task-item"]').count();
    // 3. 検索 (1文字入力 → 件数の更新)
    result.search = await ms(async () => {
      await page.getByLabel('タスクを検索').fill('請求');
      await expect.poll(async () => (await page.getByTestId('task-count').textContent()) ?? '', { timeout: 120_000 }).not.toContain(`${n}件`);
    });
    await page.getByLabel('タスクを検索').fill('');
    // 4. 絞り込みの切り替え (未完了)
    result.filter = await ms(async () => {
      await page.getByTestId('scope-open').click();
      await expect(page.getByTestId('scope-open')).toHaveAttribute('aria-selected', 'true', { timeout: 120_000 });
      await expect(page.locator('[data-testid="task-list"] [data-testid="task-item"]').first()).toBeVisible({ timeout: 120_000 });
    });
    // 5. 保存 (クイック追加 → 一覧に表示)。3回の中央値と、内訳 (書き込み・読み込み・再計算。AppData の performance.measure)
    const saves: number[] = [];
    const parts: Record<string, number[]> = {};
    for (let k = 0; k < 3; k++) {
      await page.evaluate(() => performance.clearMeasures());
      saves.push(
        await ms(async () => {
          await page.getByTestId('quick-add-input').fill(`計測の保存${k}`);
          await page.getByTestId('quick-add-submit').click();
          await expect(page.getByText(`「計測の保存${k}」を追加しました`)).toBeVisible({ timeout: 120_000 });
        }),
      );
      const m = await page.evaluate(() => performance.getEntriesByType('measure').filter((e) => e.name.startsWith('wc:')).map((e) => [e.name, e.duration] as const));
      const sum: Record<string, number> = {};
      for (const [name, d] of m) sum[name] = (sum[name] ?? 0) + d;
      for (const [name, d] of Object.entries(sum)) (parts[name] ??= []).push(Math.round(d));
    }
    const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
    result.save = median(saves);
    for (const [name, a] of Object.entries(parts)) result[`save_${name.slice(3)}`] = median(a);
    // 6. 画面の移動 (ダッシュボード → 社員 → ヘルプデスク)
    result.navigate = await ms(async () => {
      await page.evaluate(() => (window.location.hash = '#/'));
      await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible({ timeout: 120_000 });
      await page.evaluate(() => (window.location.hash = '#/employees'));
      await expect(page.getByRole('heading', { name: '社員管理' })).toBeVisible({ timeout: 120_000 });
      await page.evaluate(() => (window.location.hash = '#/helpdesk'));
      await expect(page.getByRole('heading', { name: 'ヘルプデスク' })).toBeVisible({ timeout: 120_000 });
    });
    // 7. メモリ (JS ヒープ)
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('HeapProfiler.collectGarbage');
    const { metrics } = await cdp.send('Performance.getMetrics');
    result.heapMB = Math.round((metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0) / 1024 / 1024);
    result.domNodes = metrics.find((m) => m.name === 'Nodes')?.value ?? 0;
    console.log(`PERF ${JSON.stringify(result)}`);
  });
}
