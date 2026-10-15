import { describe, expect, it } from 'vitest';
import { formatPhone, cleanPhoneTyping } from './phone';
import { formatPostal, lookupPostal, normalizePostal } from './postal';
import { isEmail, normalizeEmail, parseInteger, toHalfWidth } from './normalize';

describe('電話番号', () => {
  it.each([
    ['09012345678', '090-1234-5678', 'mobile'],
    ['０９０１２３４５６７８', '090-1234-5678', 'mobile'],
    ['090-1234-5678', '090-1234-5678', 'mobile'],
    ['0312345678', '03-1234-5678', 'fixed'],
    ['0451234567', '045-123-4567', 'fixed'],
    ['0466123456', '0466-12-3456', 'fixed'],
    ['0463123456', '0463-12-3456', 'fixed'],
    ['0499212345', '04992-1-2345', 'fixed'],
    ['05012345678', '050-1234-5678', 'ip'],
    ['0120123456', '0120-123-456', 'toll_free'],
    ['08001234567', '0800-123-4567', 'toll_free'],
  ])('%s → %s', (raw, out, kind) => {
    const r = formatPhone(raw);
    expect(r.value).toBe(out);
    expect(r.valid).toBe(true);
    expect(r.kind).toBe(kind);
  });
  it('桁数が合わない番号は整形せず、無効として残す（勝手にハイフンを入れない）', () => {
    expect(formatPhone('031234')).toEqual({ value: '031234', valid: false, kind: null });
    expect(formatPhone('090123456789').valid).toBe(false);
    expect(formatPhone('')).toEqual({ value: '', valid: true, kind: null });
  });
  it('入力中は全角を半角にし、数字・ハイフン以外を除く', () => {
    expect(cleanPhoneTyping('０９０ー１２３４')).toBe('090-1234');
    expect(cleanPhoneTyping('090abc1234')).toBe('0901234');
  });
});

describe('郵便番号・住所', () => {
  const data: Record<string, Record<string, [number, string, string][]>> = {
    '254': { '0822': [[13, '平塚市', '菫平']] },
    '498': { '0000': [[22, '弥富市', ''], [23, '桑名郡木曽岬町', '']] },
  };
  const fetcher = async (p: string) => data[p] ?? null;
  it('7桁を正規化し、〒の表示形式にする', () => {
    expect(normalizePostal('〒２５４－０８２２')).toBe('2540822');
    expect(normalizePostal('254082')).toBeNull();
    expect(formatPostal('2540822')).toBe('254-0822');
  });
  it('住所を補完し、複数候補はすべて返す', async () => {
    expect(await lookupPostal('2540822', fetcher)).toEqual({ status: 'found', candidates: [{ prefecture: '神奈川県', city: '平塚市', town: '菫平' }] });
    const r = await lookupPostal('498-0000', fetcher);
    expect(r.status === 'found' && r.candidates.map((c) => c.prefecture)).toEqual(['愛知県', '三重県']);
    expect(await lookupPostal('9999999', fetcher)).toEqual({ status: 'not_found' });
  });
  it('通信失敗はエラーとして返す（登録は続けられる）', async () => {
    const r = await lookupPostal('2540822', async () => {
      throw new Error('offline');
    });
    expect(r.status).toBe('error');
  });
});

describe('全角・半角、数値、メール', () => {
  it('全角英数字・記号を半角に', () => {
    expect(toHalfWidth('ＡＢＣ１２３－４５＠ｅｘ')).toBe('ABC123-45@ex');
    expect(toHalfWidth('カタカナ漢字ー')).toBe('カタカナ漢字ー');
  });
  it('金額は ¥・カンマ・円・全角を許容し、不正な文字を検出', () => {
    expect(parseInteger('¥１２，３４５円')).toEqual({ value: 12345, invalid: false });
    expect(parseInteger('12a')).toEqual({ value: null, invalid: true });
    expect(parseInteger('')).toEqual({ value: null, invalid: false });
  });
  it('メールアドレスの形式・正規化', () => {
    expect(isEmail('taro@example.co.jp')).toBe(true);
    expect(isEmail('taro@example')).toBe(false);
    expect(isEmail('taro example@x.jp')).toBe(false);
    expect(normalizeEmail(' Ｔａｒｏ＠Example.CO.JP ')).toBe('Taro@example.co.jp');
  });
});
