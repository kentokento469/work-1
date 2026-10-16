/**
 * Phase 5 E2E: スマート入力・郵便番号からの住所補完・戻る操作（履歴／モーダル／スワイプ）・横断自動化
 * iPhone 13 相当 / デスクトップ の2環境で実行する (スワイプはタッチ操作のある iPhone のみ)。
 *
 * 注意: スワイプは Chromium に CDP でタッチ操作を送って検証している。
 * iOS Safari 標準のスワイプ戻り・ホーム画面から起動した単独表示モードは実機で未検証。
 */
import { expect, test, type Locator, type Page, testNow } from './fixtures';

function isoAfter(days: number): string {
  const d = testNow();
  d.setDate(d.getDate() + days);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
async function gotoHash(page: Page, hash: string) {
  await page.evaluate((h) => (window.location.hash = h), hash);
}
async function readStore<T>(page: Page, store: string): Promise<T[]> {
  return page.evaluate(async (s) => {
    const db = await new Promise<IDBDatabase>((r) => {
      const req = indexedDB.open('workcore');
      req.onsuccess = () => r(req.result);
    });
    const rows = await new Promise<unknown[]>((r) => {
      const req = db.transaction(s, 'readonly').objectStore(s).getAll();
      req.onsuccess = () => r(req.result as unknown[]);
    });
    db.close();
    return rows;
  }, store) as Promise<T[]>;
}
async function openNewEmployee(page: Page) {
  await gotoHash(page, '#/employees');
  await page.getByRole('button', { name: '新規登録' }).click();
  const dialog = page.getByRole('dialog', { name: '社員の新規登録' });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function fillBasics(dialog: Locator, number: string, name: string) {
  await dialog.getByLabel('社員番号').fill(number);
  await dialog.getByLabel('氏名').fill(name);
  await dialog.getByLabel('所属部署').selectOption({ label: '営業部' });
  await dialog.getByLabel('入社日').fill(isoAfter(21));
}
/** 電話番号欄に入力して欄を離れた後の値 */
async function phoneAfterBlur(field: Locator, raw: string) {
  await field.fill(raw);
  await field.blur();
  return field;
}
/** モーダルを閉じたときにアプリが行う「履歴を1つ戻す」処理が終わるまで待つ */
async function historySettled(page: Page) {
  await expect.poll(() => page.evaluate(() => (history.state as { wcModal?: string } | null)?.wcModal ?? null)).toBeNull();
}
/** CDP でタッチのスワイプを送る (Chromium のみ) */
async function swipe(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 10) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

test('[Phase5] 電話番号の自動整形（携帯・固定の市外局番桁数・050・0120・全角・貼り付け・IME）とメール', async ({ page, browserName }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
  const dialog = await openNewEmployee(page);
  await dialog.getByTestId('contact-section').locator('summary').click();
  const phone = dialog.getByTestId('employee-phone');
  await expect(phone).toHaveAttribute('type', 'tel');
  await expect(phone).toHaveAttribute('inputmode', 'tel');

  // 1. 携帯・IP電話・フリーダイヤル
  await expect(await phoneAfterBlur(phone, '09012345678')).toHaveValue('090-1234-5678');
  await expect(dialog.getByText('携帯電話')).toBeVisible();
  await expect(await phoneAfterBlur(phone, '05012345678')).toHaveValue('050-1234-5678');
  await expect(await phoneAfterBlur(phone, '0120123456')).toHaveValue('0120-123-456');
  await expect(await phoneAfterBlur(phone, '0800-123-4567'.replace(/-/g, ''))).toHaveValue('0800-123-4567');
  // 2. 固定電話: 市外局番の桁数が異なる (2桁・3桁・4桁・5桁)
  await expect(await phoneAfterBlur(phone, '0312345678')).toHaveValue('03-1234-5678');
  await expect(await phoneAfterBlur(phone, '0451234567')).toHaveValue('045-123-4567');
  await expect(await phoneAfterBlur(phone, '0466123456')).toHaveValue('0466-12-3456');
  await expect(await phoneAfterBlur(phone, '0499212345')).toHaveValue('04992-1-2345');
  // 5. 全角数字・全角ハイフン
  await expect(await phoneAfterBlur(phone, '０９０ー１２３４ー５６７８')).toHaveValue('090-1234-5678');
  // 誤った桁数は保存を止めず、注意だけ出す
  await phoneAfterBlur(phone, '09012345');
  await expect(phone).toHaveValue('09012345');
  await expect(dialog.getByText('電話番号の桁数・形式を確認してください')).toBeVisible();

  // 入力中はハイフンを挿入しない (カーソル位置が動かない)
  await phone.fill('');
  await phone.pressSequentially('0901');
  await expect(phone).toHaveValue('0901');
  expect(await phone.evaluate((el: HTMLInputElement) => el.selectionStart)).toBe(4);
  // 途中にカーソルを置いて追加しても、その位置のまま
  await phone.fill('0901234');
  await phone.evaluate((el: HTMLInputElement) => el.setSelectionRange(3, 3));
  await page.keyboard.type('9');
  await expect(phone).toHaveValue('09091234');
  expect(await phone.evaluate((el: HTMLInputElement) => el.selectionStart)).toBe(4);

  // 貼り付け: 整形してから入る
  await phone.fill('');
  await phone.evaluate((el) => {
    const dt = new DataTransfer();
    dt.setData('text', '０３（１２３４）５６７８');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(phone).toHaveValue('03-1234-5678');

  // 6. IME (日本語入力の変換中) は値を書き換えない。確定・欄を離れた後に整形する (CDP を使うため Chromium のみ)
  if (browserName === 'chromium') {
    await phone.fill('');
    await phone.focus();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: '０９０', selectionStart: 3, selectionEnd: 3 });
    await expect(phone).toHaveValue('０９０');
    await cdp.send('Input.insertText', { text: '０９０１２３４５６７８' });
    await cdp.detach();
    await phone.blur();
    await expect(phone).toHaveValue('090-1234-5678');
  }

  // メール: 全角・大文字ドメインを正規化。誤りは欄を離れた時だけ表示 (入力中にエラーを出し続けない)
  const email = dialog.getByTestId('employee-email');
  await email.pressSequentially('taro@');
  await expect(dialog.getByText('メールアドレスの形式を確認してください')).toHaveCount(0);
  await email.blur();
  await expect(dialog.getByText('メールアドレスの形式を確認してください')).toBeVisible();
  await email.fill(' ｔａｒｏ＠Example.CO.JP ');
  await email.blur();
  await expect(email).toHaveValue('taro@example.co.jp');
  await expect(dialog.getByText('メールアドレスの形式を確認してください')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('[Phase5] 郵便番号から住所を補完（複数候補・手入力を上書きしない・取得失敗時は手入力）→ 保存 → 再読み込み後も保持', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const external: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith('http://localhost:4173/')) external.push(r.url());
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
  const dialog = await openNewEmployee(page);
  await fillBasics(dialog, 'T5001', 'テスト 住所');
  await dialog.getByTestId('contact-section').locator('summary').click();
  const f = (k: string) => dialog.getByTestId(`employee-addr-${k}`);

  // 3. 7桁で自動検索 → 都道府県・市区町村・町域
  await f('postal').fill('２５４０８２２');
  await expect(f('prefecture')).toHaveValue('神奈川県');
  await expect(f('city')).toHaveValue('平塚市');
  await expect(f('town')).toHaveValue('菫平');
  await expect(f('lookup')).toContainText('住所を補完しました');
  await f('postal').blur();
  await expect(f('postal')).toHaveValue('254-0822');
  // 補完後に手で修正できる
  await f('town').fill('菫平（修正）');
  await f('line').fill('1-2-3 テストビル 4階');

  // 手で直した住所は、別の郵便番号でも上書きしない (候補として提示)
  await f('postal').fill('1000001');
  await expect(f('suggest')).toContainText('東京都千代田区千代田');
  await expect(f('town')).toHaveValue('菫平（修正）');
  await f('suggest').getByRole('button', { name: 'この住所を使う' }).click();
  await expect(f('prefecture')).toHaveValue('東京都');
  await expect(f('town')).toHaveValue('千代田');
  await expect(f('line')).toHaveValue('1-2-3 テストビル 4階');

  // 複数の住所がある郵便番号 → 選択
  await f('postal').fill('4980000');
  await expect(f('candidates')).toBeVisible();
  const choices = f('candidates').getByRole('button');
  expect(await choices.count()).toBeGreaterThan(1);
  const chosen = (await choices.nth(1).innerText()).trim();
  await choices.nth(1).click();
  await expect(f('candidates')).toHaveCount(0);
  expect(`${await f('prefecture').inputValue()}${await f('city').inputValue()}${await f('town').inputValue()}`).toBe(chosen);

  // 4. 取得失敗 (通信できない) → 手入力で続けられる・再検索できる
  await page.route('**/vendor/postal/**', (r) => r.abort());
  await f('postal').fill('0600001');
  await expect(f('lookup')).toContainText('手入力で続けられます');
  await f('prefecture').selectOption('北海道');
  await f('city').fill('札幌市中央区');
  await f('town').fill('北一条西（手入力）');
  await page.unroute('**/vendor/postal/**');
  await f('lookup').getByRole('button', { name: '再検索' }).click();
  await expect(f('suggest')).toBeVisible(); // 手入力済みなので上書きせず候補として提示
  await expect(f('city')).toHaveValue('札幌市中央区');
  // 該当なし
  await f('postal').fill('0000000');
  await expect(f('lookup')).toContainText('該当する住所が見つかりません');
  await f('postal').fill('060-0001');

  await dialog.getByTestId('employee-phone').fill('0112345678');
  await dialog.getByRole('button', { name: '登録する' }).click();
  await expect(page.getByText('テスト 住所さんを登録しました')).toBeVisible();

  // 15. IndexedDB に保存され、再読み込み後も残る (電話番号は文字列で保存)
  await page.reload();
  await gotoHash(page, '#/employees?q=T5001');
  await page.getByRole('link', { name: /テスト 住所/ }).first().click();
  await expect(page.getByText('011-234-5678')).toBeVisible();
  await expect(page.getByText(/北海道札幌市中央区北一条西（手入力）/)).toBeVisible();
  const emp = (await readStore<{ employeeNumber: string; contact?: Record<string, string> }>(page, 'employees')).find((e) => e.employeeNumber === 'T5001');
  expect(emp?.contact).toMatchObject({ phone: '011-234-5678', postalCode: '060-0001', prefecture: '北海道', addressLine: '1-2-3 テストビル 4階' });
  expect(typeof emp?.contact?.phone).toBe('string');
  // 住所データは同じサイト内のファイルから読み、外部へは送信しない
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});

test('[Phase5] 戻る操作：一覧の検索条件・スクロール位置・モーダル（未保存の入力は破棄確認）・二重遷移なし', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();

  // 10. 一覧の絞り込み → 詳細 → 「社員一覧」リンク (= 履歴を戻る) で条件・スクロール位置が残る
  await gotoHash(page, '#/employees');
  await page.getByLabel('部署で絞り込み').selectOption({ label: '営業部' });
  await expect(page).toHaveURL(/#\/employees\?dept=/);
  const listUrl = page.url();
  const first = page.locator('a[href^="#/employees/"]:visible').first();
  await first.click();
  await expect(page.getByTestId('back-link')).toBeVisible();
  await page.getByTestId('back-link').click();
  await expect(page).toHaveURL(listUrl);
  await expect(page.getByLabel('部署で絞り込み')).not.toHaveValue('');
  // ブラウザの「進む」で詳細に戻れる (= 戻るリンクが履歴と一致している)
  await page.goForward();
  await expect(page.getByTestId('back-link')).toBeVisible();
  // ブラウザの「戻る」も同じ結果
  await page.goBack();
  await expect(page).toHaveURL(listUrl);
  await expect(page.getByLabel('部署で絞り込み')).not.toHaveValue('');

  // スクロール位置
  await gotoHash(page, '#/employees');
  await page.evaluate(() => window.scrollTo({ top: 400 }));
  await page.waitForTimeout(100);
  const y = await page.evaluate(() => window.scrollY);
  // クリック前に要素までスクロールさせない (離れる時点の位置を正しく比べるため)
  await page.locator('a[href^="#/employees/"]:visible').nth(8).evaluate((el: HTMLElement) => el.click());
  await expect(page.getByTestId('back-link')).toBeVisible();
  await page.goBack();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(y);

  // 8. 1回の「戻る」で1画面だけ戻る
  await gotoHash(page, '#/tasks');
  await gotoHash(page, '#/faq');
  await page.goBack();
  await expect(page).toHaveURL(/#\/tasks/);

  // 11. モーダルを開いた状態で「戻る」→ 画面は移動せずモーダルだけ閉じる
  await gotoHash(page, '#/employees');
  await page.getByRole('button', { name: '新規登録' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveURL(/#\/employees$/);

  // 9. 入力途中で「戻る」→ 閉じずに破棄確認。入力は残る
  await page.getByRole('button', { name: '新規登録' }).click();
  const dialog = page.getByRole('dialog', { name: '社員の新規登録' });
  await dialog.getByLabel('氏名').fill('戻る 確認');
  await page.goBack();
  await expect(dialog).toBeVisible();
  await expect(page.getByText('入力した内容は保存されていません')).toBeVisible();
  await expect(dialog.getByLabel('氏名')).toHaveValue('戻る 確認');
  await page.getByRole('button', { name: '編集を続ける' }).click();
  await expect(dialog.getByLabel('氏名')).toHaveValue('戻る 確認');
  // もう一度戻る → 確認 → 破棄
  await page.goBack();
  await page.getByRole('button', { name: '破棄して閉じる' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/#\/employees$/);
  await historySettled(page);
  // モーダルの履歴は残らない: 次の「戻る」で直前の画面 (上の手順で戻った タスク画面) へ
  await page.goBack();
  await expect(page).toHaveURL(/#\/tasks/);

  // キャンセルで閉じた後も同様
  await gotoHash(page, '#/employees');
  await page.getByRole('button', { name: '新規登録' }).click();
  await page.getByRole('button', { name: 'キャンセル' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await historySettled(page);
  await page.goBack();
  await expect(page).toHaveURL(/#\/tasks/);
  expect(errors).toEqual([]);
});

test('[Phase5] 画面左端からのスワイプで戻る（単独起動モード）・アプリ外へ出ない・モーダル／横スクロールと競合しない', async ({ page, isMobile, browserName }) => {
  test.skip(!isMobile, 'タッチ操作のある iPhone 相当の環境で検証');
  test.skip(browserName !== 'chromium', 'CDP でタッチ操作を送るため Chromium のみ');
  await page.addInitScript(() => {
    (window as Window & { __wcForceSwipeBack?: boolean }).__wcForceSwipeBack = true;
    // 単独起動 (ホーム画面から起動) にはブラウザ標準のスワイプ戻りが無い。
    // Chromium の標準ジェスチャー (横方向のオーバースクロールで戻る) を止めて同じ条件にする
    document.addEventListener('DOMContentLoaded', () => {
      const st = document.createElement('style');
      st.textContent = 'html,body{overscroll-behavior-x:none}';
      document.head.appendChild(st);
    });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
  const W = page.viewportSize()!.width;
  const back = () => swipe(page, { x: 6, y: 420 }, { x: W * 0.7, y: 425 });

  // 起動直後: 戻る画面が無いのでアプリ外へは戻らない
  await back();
  await page.waitForTimeout(400);
  await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
  expect(page.url()).toBe('http://localhost:4173/');

  // 7. 一覧 → 詳細 → スワイプで一覧へ (検索条件つき)
  await gotoHash(page, '#/employees?q=%E5%96%B6%E6%A5%AD');
  await page.locator('a[href^="#/employees/"]:visible').first().click();
  await expect(page.getByTestId('back-link')).toBeVisible();
  await back();
  // 8. 1回のスワイプで1画面だけ
  await expect(page).toHaveURL(/#\/employees\?q=/);
  await expect(page.getByPlaceholder('氏名・社員番号・役職などで検索')).toHaveValue('営業');

  // 端から始まらない横移動・縦スクロールでは戻らない
  await page.locator('a[href^="#/employees/"]:visible').first().click();
  await expect(page.getByTestId('back-link')).toBeVisible();
  const detail = page.url();
  await swipe(page, { x: 120, y: 420 }, { x: W - 10, y: 425 });
  await swipe(page, { x: 6, y: 600 }, { x: 30, y: 200 });
  await page.waitForTimeout(400);
  expect(page.url()).toBe(detail);
  // 短いスワイプ (しきい値未満) は戻らない
  await swipe(page, { x: 6, y: 420 }, { x: 60, y: 420 }, 3);
  await page.waitForTimeout(400);
  expect(page.url()).toBe(detail);

  // 11. モーダルが開いていれば、スワイプはまずモーダルを閉じる
  await gotoHash(page, '#/employees');
  await page.getByRole('button', { name: '新規登録' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await back();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveURL(/#\/employees$/);

  // 横スクロールしている要素の上では戻らない (表・グラフ・タブの横スクロールを優先)
  await page.evaluate(() => {
    const box = document.createElement('div');
    box.id = 'hscroll';
    box.style.cssText = 'overflow-x:auto;width:100%;height:120px';
    box.innerHTML = '<div style="width:2000px;height:100px;background:linear-gradient(90deg,#ddd,#999)"></div>';
    document.querySelector('[data-swipe-surface]')!.prepend(box);
    window.scrollTo({ top: 0 });
    box.scrollLeft = 200;
  });
  const box = await page.locator('#hscroll').boundingBox();
  const before = page.url();
  await swipe(page, { x: Math.max(4, box!.x + 4), y: box!.y + 50 }, { x: W * 0.7, y: box!.y + 55 });
  await page.waitForTimeout(400);
  expect(page.url()).toBe(before);
});

test('[Phase5] 単独起動でない（ブラウザのタブ）ときは標準のスワイプに任せ、二重に戻らない', async ({ page, isMobile, browserName }) => {
  test.skip(!isMobile, 'タッチ操作のある iPhone 相当の環境で検証');
  test.skip(browserName !== 'chromium', 'CDP でタッチ操作を送るため Chromium のみ');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
  await gotoHash(page, '#/tasks');
  await gotoHash(page, '#/faq');
  const W = page.viewportSize()!.width;
  await swipe(page, { x: 6, y: 420 }, { x: W * 0.7, y: 425 });
  await page.waitForTimeout(800);
  // ブラウザ標準のジェスチャー (Chromium のオーバースクロールで戻る) で1画面だけ戻る。
  // アプリの独自スワイプは動かない (動くと2画面戻ってダッシュボードになる)
  await expect(page).toHaveURL(/#\/tasks/);
  await expect(page.getByTestId('swipe-back-indicator')).toHaveCount(0);
  expect(await page.evaluate(() => document.querySelector<HTMLElement>('[data-swipe-surface]')!.style.transform)).toBe('');
});

test('[Phase5] 社員登録 → 入社準備タスクの提案 → 承認 → 二重実行なし／自動実行モード', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();

  // 12. 社員を登録すると、自動化センターに入社準備タスクの提案が出る (自動では作らない)
  const dialog = await openNewEmployee(page);
  await fillBasics(dialog, 'T5101', '自動化 一郎');
  await dialog.getByRole('button', { name: '登録する' }).click();
  await expect(page.getByText('自動化 一郎さんを登録しました')).toBeVisible();
  const emp1 = (await readStore<{ id: string; employeeNumber: string }>(page, 'employees')).find((e) => e.employeeNumber === 'T5101')!;
  const tasksOf = async (id: string) => (await readStore<{ employeeId: string | null; source: string }>(page, 'tasks')).filter((t) => t.employeeId === id && t.source === 'onboarding').length;
  expect(await tasksOf(emp1.id)).toBe(0);

  await gotoHash(page, '#/automation');
  const card = page.locator('[data-automation="onboarding-tasks"][data-proposal-title*="自動化 一郎"]');
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: /入社準備タスク/ }).click();
  await expect(card.getByTestId('proposal-actions').locator('li')).toHaveCount(9);
  // 13. 連打しても1回だけ実行される
  await card.getByTestId('apply-proposal').dblclick();
  await expect(card).toHaveCount(0);
  await expect.poll(() => tasksOf(emp1.id)).toBe(9);
  await page.reload();
  await gotoHash(page, '#/automation');
  await expect(page.getByTestId('proposal-list')).toBeVisible();
  await expect(page.locator('[data-automation="onboarding-tasks"][data-proposal-title*="自動化 一郎"]')).toHaveCount(0);
  expect(await tasksOf(emp1.id)).toBe(9);

  // 自動実行モード: タスク作成だけのルールは「自動で実行」を選べる。在庫を動かすルールは選べない
  await gotoHash(page, '#/automation');
  const rules = page.getByTestId('rule-settings');
  await expect(rules.locator('[data-rule="onboarding-equipment"]')).toContainText('常に承認後に実行');
  await rules.getByTestId('mode-onboarding-tasks-auto').click();
  await expect(rules.getByTestId('mode-onboarding-tasks-auto')).toHaveAttribute('aria-checked', 'true');

  const d2 = await openNewEmployee(page);
  await fillBasics(d2, 'T5102', '自動化 二郎');
  await d2.getByRole('button', { name: '登録する' }).click();
  await expect(page.getByText(/自動化を実行しました：.*自動化 二郎/)).toBeVisible();
  const emp2 = (await readStore<{ id: string; employeeNumber: string }>(page, 'employees')).find((e) => e.employeeNumber === 'T5102')!;
  await expect.poll(() => tasksOf(emp2.id)).toBe(9);
  // 再読み込み・再起動しても二重に実行されない
  await page.reload();
  await expect(page.getByRole('heading', { name: '社員管理' })).toBeVisible();
  await page.waitForTimeout(800);
  expect(await tasksOf(emp2.id)).toBe(9);
  const runs = await readStore<{ automationId: string; status: string; title: string }>(page, 'automationRuns');
  expect(runs.filter((r) => r.automationId === 'onboarding-tasks' && r.title.includes('自動化 二郎'))).toHaveLength(1);
  expect(runs.find((r) => r.title.includes('自動化 二郎'))?.status).toBe('auto');
  // 設定 (自動実行) も保持
  await gotoHash(page, '#/automation');
  await expect(page.getByTestId('mode-onboarding-tasks-auto')).toHaveAttribute('aria-checked', 'true');
  // AI は接続していないことを明示
  await gotoHash(page, '#/settings');
  await expect(page.getByTestId('ai-settings')).toContainText('未接続');
  expect(errors).toEqual([]);
});
