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

/** 日付の通し番号 (UTC の 1970-01-01 からの日数)。日数の差だけに使う (タイムゾーン・夏時間の影響を受けない) */
function dayNumber(value: ISODate): number {
  const m = ISO_DATE_RE.exec(value);
  if (!m) throw new Error(`不正な日付形式です: ${value}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000;
}

/** b - a の日数差。通知・ダッシュボードで件数 × 回呼ばれるため、Date オブジェクトを作らずに計算する (Phase 13R) */
export function diffDays(a: ISODate, b: ISODate): number {
  return dayNumber(b) - dayNumber(a);
}

export function isWeekend(value: ISODate): boolean {
  const day = parseISODate(value).getDay();
  return day === 0 || day === 6;
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
