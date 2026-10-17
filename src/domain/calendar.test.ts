import { afterEach, describe, expect, it } from 'vitest';
import { addBusinessDays, businessDaysBetween, closedReason, DEFAULT_CALENDAR, isBusinessDay, japaneseHolidays, setBusinessCalendar, toNextBusinessDay, toPreviousBusinessDayCal, yearEndHolidays } from './calendar';

const list = (y: number) => [...japaneseHolidays(y).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([d, n]) => `${d} ${n}`);

describe('日本の祝日 (内閣府の公表と照合)', () => {
  it('2026年', () => {
    expect(list(2026)).toEqual([
      '2026-01-01 元日',
      '2026-01-12 成人の日',
      '2026-02-11 建国記念の日',
      '2026-02-23 天皇誕生日',
      '2026-03-20 春分の日',
      '2026-04-29 昭和の日',
      '2026-05-03 憲法記念日',
      '2026-05-04 みどりの日',
      '2026-05-05 こどもの日',
      '2026-05-06 振替休日',
      '2026-07-20 海の日',
      '2026-08-11 山の日',
      '2026-09-21 敬老の日',
      '2026-09-22 国民の休日',
      '2026-09-23 秋分の日',
      '2026-10-12 スポーツの日',
      '2026-11-03 文化の日',
      '2026-11-23 勤労感謝の日',
    ]);
  });
  it('2025年（振替休日が複数）', () => {
    const h = japaneseHolidays(2025);
    expect(h.get('2025-02-24')).toBe('振替休日');
    expect(h.get('2025-05-06')).toBe('振替休日');
    expect(h.get('2025-11-24')).toBe('振替休日');
    expect(h.get('2025-03-20')).toBe('春分の日');
    expect(h.get('2025-09-23')).toBe('秋分の日');
    expect(h.size).toBe(19);
  });
  it('2020・2021年のオリンピック特例、2019年の即位に伴う休日', () => {
    const h20 = japaneseHolidays(2020);
    expect(h20.get('2020-07-23')).toBe('海の日');
    expect(h20.get('2020-07-24')).toBe('スポーツの日');
    expect(h20.get('2020-08-10')).toBe('山の日');
    expect(h20.has('2020-10-12')).toBe(false);
    const h21 = japaneseHolidays(2021);
    expect(h21.get('2021-07-22')).toBe('海の日');
    expect(h21.get('2021-08-09')).toBe('振替休日');
    const h19 = japaneseHolidays(2019);
    expect(h19.get('2019-05-01')).toBe('天皇の即位の日');
    expect(h19.get('2019-04-30')).toBe('国民の休日');
    expect(h19.get('2019-05-06')).toBe('振替休日');
    expect(h19.has('2019-12-23')).toBe(false);
  });
});

describe('営業日', () => {
  afterEach(() => setBusinessCalendar(DEFAULT_CALENDAR));
  it('土日・祝日・会社の休業日は休み。出勤日の指定は営業日', () => {
    expect(isBusinessDay('2026-10-15')).toBe(true); // 木
    expect(closedReason('2026-10-17')).toBe('土曜日');
    expect(closedReason('2026-10-12')).toBe('スポーツの日');
    setBusinessCalendar({ ...DEFAULT_CALENDAR, companyHolidays: ['2026-10-16'], workdays: ['2026-10-12'] });
    expect(closedReason('2026-10-16')).toBe('会社の休業日');
    expect(isBusinessDay('2026-10-12')).toBe(true);
  });
  it('前倒し・後ろ倒し・n営業日後・営業日数', () => {
    // 2026/5/2(土)〜5/6(水・振替休日) は休み
    expect(toPreviousBusinessDayCal('2026-05-05')).toBe('2026-05-01');
    expect(toNextBusinessDay('2026-05-03')).toBe('2026-05-07');
    expect(addBusinessDays('2026-04-30', 2)).toBe('2026-05-07');
    expect(addBusinessDays('2026-05-07', -2)).toBe('2026-04-30');
    expect(businessDaysBetween('2026-04-30', '2026-05-07')).toBe(2);
    expect(businessDaysBetween('2026-05-07', '2026-04-30')).toBe(-2);
  });
  it('年末年始の候補', () => {
    expect(yearEndHolidays(2026)).toEqual(['2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']);
  });
});

describe('繰り返しの次回の期限：休みの日の扱い・完了日基準 (Phase 12)', async () => {
  const { nextScheduledDue, describeRecurrenceFull } = await import('./recurrence');
  it('毎月10日・休みの日は前の営業日：2027/1/10(日)→1/8(金)。翌回は調整前の10日から（ずれていかない）', () => {
    const r1 = nextScheduledDue({ freq: 'monthly', interval: 1, adjust: 'before' }, '2026-12-10', '2026-12-10', '2026-12-10');
    expect(r1).toEqual({ due: '2027-01-08', raw: '2027-01-10' });
    const r2 = nextScheduledDue({ freq: 'monthly', interval: 1, adjust: 'before', lastRaw: r1.raw }, r1.due, '2027-01-08', '2027-01-08');
    expect(r2.due).toBe('2027-02-10'); // 水曜
  });
  it('毎週月曜・休みの日は次の営業日：祝日の月曜 (2026/10/12) → 火曜。翌週は月曜に戻る', () => {
    const r1 = nextScheduledDue({ freq: 'weekly', interval: 1, adjust: 'after' }, '2026-10-05', '2026-10-05', '2026-10-05');
    expect(r1).toEqual({ due: '2026-10-13', raw: '2026-10-12' });
    const r2 = nextScheduledDue({ freq: 'weekly', interval: 1, adjust: 'after', lastRaw: r1.raw }, r1.due, '2026-10-13', '2026-10-13');
    expect(r2.due).toBe('2026-10-19');
  });
  it('完了日基準：期限が過ぎてから完了しても、完了日から周期分あと', () => {
    expect(nextScheduledDue({ freq: 'monthly', interval: 1, basis: 'completion' }, '2026-09-01', '2026-10-15', '2026-10-15').due).toBe('2026-11-15');
    expect(nextScheduledDue({ freq: 'daily', interval: 7, basis: 'completion' }, '2026-10-01', '2026-10-15', '2026-10-15').due).toBe('2026-10-22');
  });
  it('説明', () => {
    expect(describeRecurrenceFull({ freq: 'monthly', interval: 1, monthDay: 'last', adjust: 'before' })).toBe('毎月 月末・休みの日は前の営業日');
    expect(describeRecurrenceFull({ freq: 'monthly', interval: 3, basis: 'completion' })).toBe('完了から3か月後');
  });
});
