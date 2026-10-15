import type { ISODate } from './types';

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** ローカルタイムゾーン基準の YYYY-MM-DD を返す (toISOString は UTC になるため使わない) */
export function toISODate(d: Date): ISODate {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function today(): ISODate {
  return toISODate(new Date());
}

export function isValidISODate(value: unknown): value is ISODate {
  if (typeof value !== 'string') return false;
  const m = ISO_DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d;
}

export function parseISODate(value: ISODate): Date {
  const m = ISO_DATE_RE.exec(value);
  if (!m) throw new Error(`不正な日付形式です: ${value}`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function addDays(value: ISODate, days: number): ISODate {
  const d = parseISODate(value);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

/** b - a の日数差 */
export function diffDays(a: ISODate, b: ISODate): number {
  const ms = parseISODate(b).getTime() - parseISODate(a).getTime();
  return Math.round(ms / 86_400_000);
}

export function isWeekend(value: ISODate): boolean {
  const day = parseISODate(value).getDay();
  return day === 0 || day === 6;
}

/** 土日の場合は直前の平日 (金曜) に前倒しする */
export function toPreviousBusinessDay(value: ISODate): ISODate {
  let v = value;
  while (isWeekend(v)) v = addDays(v, -1);
  return v;
}

export function formatDateJa(value: ISODate | null | undefined): string {
  if (!value || !isValidISODate(value)) return '—';
  const d = parseISODate(value);
  const w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}(${w})`;
}

export function formatDateTimeJa(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
