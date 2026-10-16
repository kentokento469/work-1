import { describe, expect, it } from 'vitest';
import { parseQuickAdd } from './quickAdd';

const T = '2026-10-15'; // 木曜
describe('クイック追加の期限の読み取り', () => {
  it('明日・明後日・今日', () => {
    expect(parseQuickAdd('明日までに報告書を確認する', T)).toEqual({ title: '報告書を確認する', dueDate: '2026-10-16', matched: '明日' });
    expect(parseQuickAdd('明後日 会議の準備', T).dueDate).toBe('2026-10-17');
    expect(parseQuickAdd('今日中に電話', T).dueDate).toBe('2026-10-15');
  });
  it('曜日・来週・今週中・月末', () => {
    expect(parseQuickAdd('金曜に備品を整理', T).dueDate).toBe('2026-10-16');
    expect(parseQuickAdd('木曜 定例', T).dueDate).toBe('2026-10-15'); // 今日が木曜
    expect(parseQuickAdd('来週 顧客に連絡', T).dueDate).toBe('2026-10-19');
    expect(parseQuickAdd('来週水曜までに見積', T).dueDate).toBe('2026-10-21');
    expect(parseQuickAdd('今週中に資料', T).dueDate).toBe('2026-10-16');
    expect(parseQuickAdd('月末の確認作業', T)).toMatchObject({ title: '月末の確認作業', dueDate: '2026-10-31' });
  });
  it('日付 (過ぎた日付は来年・存在しない日付は読まない)', () => {
    expect(parseQuickAdd('10/20 までに提出', T)).toMatchObject({ title: '提出', dueDate: '2026-10-20' });
    expect(parseQuickAdd('11月3日 健康診断', T).dueDate).toBe('2026-11-03');
    expect(parseQuickAdd('4/1 登録情報の更新', T).dueDate).toBe('2027-04-01');
    expect(parseQuickAdd('2/30 テスト', T).dueDate).toBeNull();
  });
  it('期限の語句がなければそのまま', () => {
    expect(parseQuickAdd('  資料を作成する ', T)).toEqual({ title: '資料を作成する', dueDate: null, matched: null });
  });
});
