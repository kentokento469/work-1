/**
 * 営業日の計算 (Phase 12)。日本の祝日 (振替休日・国民の休日を含む) と、会社の休業日 (設定) を考慮する。
 *
 * 祝日は外部のサービスを使わず、祝日法の規則から計算する。
 * - 対象: 2000〜2099年。2020・2021年の東京オリンピックの特例 (海の日・スポーツの日・山の日の移動) と、
 *   2019年の天皇の即位に伴う休日を含む
 * - 春分・秋分の日は天文計算の近似式 (1980〜2099年で有効)。実際の日付は前年2月の官報で決まるため、
 *   将来の年はずれる可能性がある (法改正も反映できない) → 会社の休業日で補正できる
 */
import { addDays, parseISODate } from './date';
import type { ISODate } from './types';

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** その月の第 n 週の月曜日 */
function nthMonday(y: number, m: number, n: number): number {
  const first = new Date(y, m - 1, 1).getDay();
  const firstMonday = 1 + ((8 - first) % 7);
  return firstMonday + (n - 1) * 7;
}

function vernalEquinox(y: number): number {
  return Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
}
function autumnalEquinox(y: number): number {
  return Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
}

/** 祝日法の「国民の祝日」(振替休日・国民の休日を除く) */
function baseHolidays(y: number): Map<string, string> {
  const h = new Map<string, string>();
  const add = (m: number, d: number, name: string) => h.set(ymd(y, m, d), name);
  add(1, 1, '元日');
  add(1, nthMonday(y, 1, 2), '成人の日');
  add(2, 11, '建国記念の日');
  if (y >= 2020) add(2, 23, '天皇誕生日');
  add(3, vernalEquinox(y), '春分の日');
  add(4, 29, y >= 2007 ? '昭和の日' : 'みどりの日');
  add(5, 3, '憲法記念日');
  if (y >= 2007) add(5, 4, 'みどりの日');
  add(5, 5, 'こどもの日');
  if (y === 2020) add(7, 23, '海の日');
  else if (y === 2021) add(7, 22, '海の日');
  else add(7, nthMonday(y, 7, 3), '海の日');
  if (y === 2020) add(8, 10, '山の日');
  else if (y === 2021) add(8, 8, '山の日');
  else if (y >= 2016) add(8, 11, '山の日');
  add(9, nthMonday(y, 9, 3), '敬老の日');
  add(9, autumnalEquinox(y), '秋分の日');
  if (y === 2020) add(7, 24, 'スポーツの日');
  else if (y === 2021) add(7, 23, 'スポーツの日');
  else add(10, nthMonday(y, 10, 2), y >= 2020 ? 'スポーツの日' : '体育の日');
  add(11, 3, '文化の日');
  add(11, 23, '勤労感謝の日');
  if (y <= 2018) add(12, 23, '天皇誕生日');
  if (y === 2019) {
    add(4, 30, '国民の休日');
    add(5, 1, '天皇の即位の日');
    add(5, 2, '国民の休日');
    add(10, 22, '即位礼正殿の儀の行われる日');
  }
  return h;
}

const cache = new Map<number, Map<string, string>>();

/** その年の祝日 (日付 → 名前)。振替休日・国民の休日を含む */
export function japaneseHolidays(y: number): Map<string, string> {
  const hit = cache.get(y);
  if (hit) return hit;
  const h = baseHolidays(y);
  const dates = [...h.keys()].sort();
  // 振替休日: 祝日が日曜日なら、その後の最初の祝日でない日
  for (const d of dates) {
    if (parseISODate(d).getDay() !== 0) continue;
    let s = addDays(d, 1);
    while (h.has(s)) s = addDays(s, 1);
    if (!h.has(s)) h.set(s, '振替休日');
  }
  // 国民の休日: 前日と翌日が祝日で、その日が祝日・日曜でない日
  for (const d of [...h.keys()].sort()) {
    const next = addDays(d, 1);
    const after = addDays(d, 2);
    // 振替休日は「国民の祝日」ではないため、挟む側には数えない
    if (h.get(d) === '振替休日' || h.get(after) === '振替休日') continue;
    if (!h.has(next) && h.has(after) && parseISODate(next).getDay() !== 0) h.set(next, '国民の休日');
  }
  cache.set(y, h);
  return h;
}

export function holidayName(date: ISODate): string | undefined {
  return japaneseHolidays(parseISODate(date).getFullYear()).get(date);
}

/** 会社の営業日の設定 */
export interface BusinessCalendar {
  /** 休みの曜日 (0 = 日 … 6 = 土)。既定は土日 */
  weekendDays: number[];
  /** 日本の祝日を休みにするか (既定: する) */
  observeHolidays: boolean;
  /** 会社の休業日 (年末年始・夏季休業など) */
  companyHolidays: ISODate[];
  /** 祝日でも営業する日 (例: 祝日の出勤日) */
  workdays: ISODate[];
}

export const DEFAULT_CALENDAR: BusinessCalendar = { weekendDays: [0, 6], observeHolidays: true, companyHolidays: [], workdays: [] };

/** アプリ全体で使う営業日の設定 (設定画面で変更でき、データの読み込み時に反映する) */
let current: BusinessCalendar = DEFAULT_CALENDAR;
let companySet = new Set<string>();
let workSet = new Set<string>();
export function setBusinessCalendar(c: BusinessCalendar): void {
  current = c;
  companySet = new Set(c.companyHolidays);
  workSet = new Set(c.workdays);
}
export function getBusinessCalendar(): BusinessCalendar {
  return current;
}

/** 休みの理由 (営業日なら undefined) */
export function closedReason(date: ISODate, c: BusinessCalendar = current): string | undefined {
  const cs = c === current ? companySet : new Set(c.companyHolidays);
  const ws = c === current ? workSet : new Set(c.workdays);
  if (ws.has(date)) return undefined;
  if (cs.has(date)) return '会社の休業日';
  if (c.observeHolidays) {
    const h = holidayName(date);
    if (h) return h;
  }
  const day = parseISODate(date).getDay();
  if (c.weekendDays.includes(day)) return ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'][day];
  return undefined;
}

export function isBusinessDay(date: ISODate, c: BusinessCalendar = current): boolean {
  return closedReason(date, c) === undefined;
}

/** 休みの日なら直前の営業日に前倒しする (締め切りを守る方向) */
export function toPreviousBusinessDayCal(date: ISODate, c: BusinessCalendar = current): ISODate {
  let v = date;
  for (let i = 0; i < 366 && !isBusinessDay(v, c); i++) v = addDays(v, -1);
  return v;
}

/** 休みの日なら直後の営業日に後ろ倒しする */
export function toNextBusinessDay(date: ISODate, c: BusinessCalendar = current): ISODate {
  let v = date;
  for (let i = 0; i < 366 && !isBusinessDay(v, c); i++) v = addDays(v, 1);
  return v;
}

/** n 営業日後 (n < 0 なら前)。起点の日は数えない */
export function addBusinessDays(date: ISODate, n: number, c: BusinessCalendar = current): ISODate {
  let v = date;
  const step = n >= 0 ? 1 : -1;
  for (let left = Math.abs(n); left > 0; ) {
    v = addDays(v, step);
    if (isBusinessDay(v, c)) left--;
  }
  return v;
}

/** a から b までの営業日数 (a を含まず b を含む。b < a なら負) */
export function businessDaysBetween(a: ISODate, b: ISODate, c: BusinessCalendar = current): number {
  if (a === b) return 0;
  const step = a < b ? 1 : -1;
  let n = 0;
  for (let v = a; v !== b; ) {
    v = addDays(v, step);
    if (isBusinessDay(v, c)) n += step;
  }
  return n;
}

/** 年末年始 (12/29〜1/3) の休業日の候補。設定画面の「年末年始を追加」で使う */
export function yearEndHolidays(year: number): ISODate[] {
  return [ymd(year, 12, 29), ymd(year, 12, 30), ymd(year, 12, 31), ymd(year + 1, 1, 1), ymd(year + 1, 1, 2), ymd(year + 1, 1, 3)];
}


/** 設定ストアの id。値は BusinessCalendar */
export const CALENDAR_SETTING_ID = 'calendar';

/** 設定から営業日の設定を読む (無い・壊れている場合は既定値) */
export function readBusinessCalendar(settings: { id: string; value: unknown }[]): BusinessCalendar {
  const v = settings.find((s) => s.id === CALENDAR_SETTING_ID)?.value as Partial<BusinessCalendar> | undefined;
  if (!v || typeof v !== 'object') return DEFAULT_CALENDAR;
  const dates = (x: unknown) => (Array.isArray(x) ? x.filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)).sort() : []);
  const days = Array.isArray(v.weekendDays) ? v.weekendDays.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6) : DEFAULT_CALENDAR.weekendDays;
  return { weekendDays: days, observeHolidays: v.observeHolidays !== false, companyHolidays: dates(v.companyHolidays), workdays: dates(v.workdays) };
}
