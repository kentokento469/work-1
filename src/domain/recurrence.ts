/**
 * 繰り返しタスクの次回期限の計算 (純粋関数)。
 *
 * - 次回は「前回の期限」を基準に計算する (完了日ではない)。期限がずれていかない
 * - 毎月: 指定日 (または基準日の日) が存在しない月は月末に寄せる (31日 → 4月は30日、2月は28/29日)。翌月以降は元の日に戻る
 * - 毎年: 2/29 はうるう年以外は 2/28。うるう年には 2/29 に戻る
 * - 次回が今日より前になる場合 (長く完了しなかった等) は、今日以降の最初の回まで進める。過去の未実行分はまとめて作らない
 */
import { toNextBusinessDay, toPreviousBusinessDayCal } from './calendar';
import { addDays, diffDays, isValidISODate, parseISODate, toISODate } from './date';
import type { ISODate, Recurrence } from './types';

const WEEKDAY = ['日', '月', '火', '水', '木', '金', '土'];

function daysInMonth(y: number, m0: number): number {
  return new Date(y, m0 + 1, 0).getDate();
}
function ymd(iso: ISODate) {
  const d = parseISODate(iso);
  return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), wd: d.getDay() };
}
function make(y: number, m0: number, day: number): ISODate {
  // 月の繰り上がりを正規化してから、その月に存在する日に寄せる
  const base = new Date(y, m0, 1);
  const yy = base.getFullYear();
  const mm = base.getMonth();
  return toISODate(new Date(yy, mm, Math.min(day, daysInMonth(yy, mm))));
}
const weekStart = (iso: ISODate) => addDays(iso, -ymd(iso).wd);

/** 基準日 from の次の回 (from より後) */
function nextAfter(rule: Recurrence, from: ISODate, anchor: ISODate): ISODate {
  const n = Math.max(1, Math.floor(rule.interval || 1));
  switch (rule.freq) {
    case 'daily':
      return addDays(from, n);
    case 'weekly': {
      const days = (rule.weekdays ?? []).filter((x) => x >= 0 && x <= 6);
      if (!days.length) return addDays(from, 7 * n);
      const ws = weekStart(from);
      for (let i = 1; i <= 7 * n + 7; i++) {
        const d = addDays(from, i);
        const w = Math.round(diffDays(ws, weekStart(d)) / 7);
        if (w % n === 0 && days.includes(ymd(d).wd)) return d;
      }
      return addDays(from, 7 * n);
    }
    case 'monthly': {
      const f = ymd(from);
      const target = new Date(f.y, f.m + n, 1);
      const y = target.getFullYear();
      const m = target.getMonth();
      const day = rule.monthDay === 'last' ? daysInMonth(y, m) : (rule.monthDay ?? ymd(anchor).d);
      return make(y, m, day);
    }
    case 'yearly': {
      const f = ymd(from);
      const a = ymd(anchor);
      return make(f.y + n, a.m, a.d);
    }
  }
}

/**
 * 次回の期限。due = 今回の期限、today = 今日。
 * anchor (繰り返しを設定した時の期限) から日・月を取り、月末・うるう年で寄せた日付が次の回に影響しないようにする
 */
export function nextOccurrence(rule: Recurrence, due: ISODate, today: ISODate, anchor: ISODate = due): ISODate {
  let next = nextAfter(rule, due, anchor);
  for (let guard = 0; next < today && guard < 2000; guard++) next = nextAfter(rule, next, anchor);
  return next;
}

export function validateRecurrence(rule: unknown): string | null {
  if (!rule || typeof rule !== 'object') return '繰り返しの設定が正しくありません';
  const r = rule as Recurrence;
  if (!['daily', 'weekly', 'monthly', 'yearly'].includes(r.freq)) return '繰り返しの周期を選んでください';
  if (!Number.isInteger(r.interval) || r.interval < 1 || r.interval > 365) return '繰り返しの間隔は1〜365で指定してください';
  if (r.weekdays && (!Array.isArray(r.weekdays) || r.weekdays.some((x) => !Number.isInteger(x) || x < 0 || x > 6))) return '曜日の指定が正しくありません';
  if (r.monthDay !== undefined && r.monthDay !== 'last' && (!Number.isInteger(r.monthDay) || r.monthDay < 1 || r.monthDay > 31)) return '日付は1〜31日または月末で指定してください';
  if (r.anchor !== undefined && !isValidISODate(r.anchor)) return '繰り返しの基準日が正しくありません';
  if (r.adjust !== undefined && !['none', 'before', 'after'].includes(r.adjust)) return '休みの日の扱いが正しくありません';
  if (r.basis !== undefined && !['due', 'completion'].includes(r.basis)) return '次回の期限の基準が正しくありません';
  if (r.lastRaw !== undefined && !isValidISODate(r.lastRaw)) return '繰り返しの予定日が正しくありません';
  return null;
}

/**
 * 完了したタスクの次回の期限 (Phase 12)。
 * - basis = 'completion' なら完了した日から周期分あと、それ以外は前回の予定日 (調整前) から
 * - adjust に従って休みの日を避ける。調整前の予定日 (raw) を次回の計算の起点として返す
 */
export function nextScheduledDue(rule: Recurrence, due: ISODate, completedOn: ISODate, today: ISODate): { due: ISODate; raw: ISODate } {
  let raw: ISODate;
  if (rule.basis === 'completion') raw = nextAfter({ ...rule, weekdays: undefined, monthDay: undefined }, completedOn, completedOn);
  else raw = nextOccurrence(rule, rule.lastRaw ?? due, today, rule.anchor ?? rule.lastRaw ?? due);
  const adjusted = rule.adjust === 'before' ? toPreviousBusinessDayCal(raw) : rule.adjust === 'after' ? toNextBusinessDay(raw) : raw;
  // 前倒しで今日より前になる場合は今日 (過去の期限のタスクを作らない)
  return { due: adjusted < today ? today : adjusted, raw };
}

/** 画面表示用の説明 (例:「毎月 月末」「隔週 月・木曜」) */
export function describeRecurrence(r: Recurrence): string {
  const n = r.interval;
  switch (r.freq) {
    case 'daily':
      return n === 1 ? '毎日' : `${n}日ごと`;
    case 'weekly': {
      const head = n === 1 ? '毎週' : n === 2 ? '隔週' : `${n}週ごと`;
      return r.weekdays?.length ? `${head} ${[...r.weekdays].sort().map((w) => WEEKDAY[w]).join('・')}曜` : head;
    }
    case 'monthly': {
      const head = n === 1 ? '毎月' : `${n}か月ごと`;
      return r.monthDay === 'last' ? `${head} 月末` : r.monthDay ? `${head} ${r.monthDay}日` : head;
    }
    case 'yearly':
      return n === 1 ? '毎年' : `${n}年ごと`;
  }
}

/** 基準・休みの日の扱いを含めた説明 (例:「毎月 月末・休みの日は前の営業日」「完了から7日ごと」) */
export function describeRecurrenceFull(r: Recurrence): string {
  const unit = { daily: '日', weekly: '週間', monthly: 'か月', yearly: '年' }[r.freq];
  const base = r.basis === 'completion' ? `完了から${r.interval}${unit}後` : describeRecurrence(r);
  const adj = r.adjust === 'before' ? '・休みの日は前の営業日' : r.adjust === 'after' ? '・休みの日は次の営業日' : '';
  return base + adj;
}
