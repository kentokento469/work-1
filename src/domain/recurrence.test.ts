import { describe, expect, it } from 'vitest';
import { describeRecurrence, nextOccurrence, validateRecurrence } from './recurrence';

describe('繰り返しの次回期限', () => {
  const T = '2026-01-01';
  it('毎日・n日ごと', () => {
    expect(nextOccurrence({ freq: 'daily', interval: 1 }, '2026-02-28', T)).toBe('2026-03-01');
    expect(nextOccurrence({ freq: 'daily', interval: 3 }, '2026-12-30', T)).toBe('2027-01-02');
  });
  it('毎週・隔週・指定曜日', () => {
    expect(nextOccurrence({ freq: 'weekly', interval: 1 }, '2026-10-12', T)).toBe('2026-10-19'); // 月曜
    expect(nextOccurrence({ freq: 'weekly', interval: 2 }, '2026-10-12', T)).toBe('2026-10-26');
    // 毎週 月・木: 月曜 → 同じ週の木曜 → 翌週の月曜
    expect(nextOccurrence({ freq: 'weekly', interval: 1, weekdays: [1, 4] }, '2026-10-12', T)).toBe('2026-10-15');
    expect(nextOccurrence({ freq: 'weekly', interval: 1, weekdays: [1, 4] }, '2026-10-15', T)).toBe('2026-10-19');
    // 隔週 月・木: 木曜 → 2週後の月曜
    expect(nextOccurrence({ freq: 'weekly', interval: 2, weekdays: [1, 4] }, '2026-10-15', T)).toBe('2026-10-26');
  });
  it('毎月: 存在しない日は月末に寄せ、翌月以降は元の日に戻る', () => {
    const r = { freq: 'monthly' as const, interval: 1, anchor: '2026-01-31' };
    expect(nextOccurrence(r, '2026-01-31', T, '2026-01-31')).toBe('2026-02-28');
    expect(nextOccurrence(r, '2026-02-28', T, '2026-01-31')).toBe('2026-03-31');
    expect(nextOccurrence(r, '2026-03-31', T, '2026-01-31')).toBe('2026-04-30');
    expect(nextOccurrence({ freq: 'monthly', interval: 1 }, '2028-01-31', T)).toBe('2028-02-29'); // うるう年
  });
  it('毎月 月末・指定日・nか月ごと', () => {
    expect(nextOccurrence({ freq: 'monthly', interval: 1, monthDay: 'last' }, '2026-01-31', T)).toBe('2026-02-28');
    expect(nextOccurrence({ freq: 'monthly', interval: 1, monthDay: 'last' }, '2026-02-28', T)).toBe('2026-03-31');
    expect(nextOccurrence({ freq: 'monthly', interval: 1, monthDay: 25 }, '2026-10-25', T)).toBe('2026-11-25');
    expect(nextOccurrence({ freq: 'monthly', interval: 3, monthDay: 10 }, '2026-11-10', T)).toBe('2027-02-10');
  });
  it('毎年: 2/29 はうるう年以外 2/28、うるう年には 2/29 に戻る', () => {
    const r = { freq: 'yearly' as const, interval: 1 };
    expect(nextOccurrence(r, '2028-02-29', T, '2028-02-29')).toBe('2029-02-28');
    expect(nextOccurrence(r, '2031-02-28', '2000-01-01', '2028-02-29')).toBe('2032-02-29');
    expect(nextOccurrence(r, '2026-04-01', T)).toBe('2027-04-01');
  });
  it('長く完了しなかった場合は今日以降の最初の回まで進める（過去分をまとめて作らない）', () => {
    expect(nextOccurrence({ freq: 'weekly', interval: 1 }, '2026-01-05', '2026-10-15')).toBe('2026-10-19');
    expect(nextOccurrence({ freq: 'daily', interval: 1 }, '2026-01-01', '2026-10-15')).toBe('2026-10-15');
  });
  it('検証と説明', () => {
    expect(validateRecurrence({ freq: 'weekly', interval: 0 })).toBeTruthy();
    expect(validateRecurrence({ freq: 'monthly', interval: 1, monthDay: 32 })).toBeTruthy();
    expect(validateRecurrence({ freq: 'monthly', interval: 1, monthDay: 'last' })).toBeNull();
    expect(describeRecurrence({ freq: 'weekly', interval: 2, weekdays: [4, 1] })).toBe('隔週 月・木曜');
    expect(describeRecurrence({ freq: 'monthly', interval: 1, monthDay: 'last' })).toBe('毎月 月末');
  });
});
