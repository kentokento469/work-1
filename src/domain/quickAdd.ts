/**
 * クイック追加の入力から期限の候補を読み取る (純粋関数)。
 * 誤認識で意図しない期限が付かないよう、読み取った結果は「候補」として画面に表示し、利用者が外せるようにする。
 * 対応: 今日 / 明日 / 明後日 / 今週中(金曜) / 来週(月曜) / 来週◯曜 / ◯曜(日) / M/D / M月D日 / 月末
 */
import { addDays, parseISODate, toISODate } from './date';
import type { ISODate } from './types';

const WD = ['日', '月', '火', '水', '木', '金', '土'];

export interface QuickAddResult {
  /** 期限の語句を取り除いたタスク名 (空になる場合は元の入力) */
  title: string;
  dueDate: ISODate | null;
  /** 読み取った語句 (画面に表示) */
  matched: string | null;
}

function nextWeekday(today: ISODate, wd: number, minDays = 0): ISODate {
  const cur = parseISODate(today).getDay();
  let diff = (wd - cur + 7) % 7;
  if (diff < minDays) diff += 7;
  return addDays(today, diff);
}

export function parseQuickAdd(input: string, today: ISODate): QuickAddResult {
  const text = input.trim();
  const year = parseISODate(today).getFullYear();
  const rules: [RegExp, (m: RegExpMatchArray) => ISODate | null][] = [
    [/明後日/, () => addDays(today, 2)],
    [/明日/, () => addDays(today, 1)],
    [/今日/, () => today],
    [/今週中/, () => nextWeekday(today, 5)],
    [/来週([日月火水木金土])曜日?/, (m) => addDays(nextWeekday(today, 1, 1), (WD.indexOf(m[1]!) + 6) % 7)],
    [/来週/, () => nextWeekday(today, 1, 1)],
    [/月末/, () => {
      const d = parseISODate(today);
      return toISODate(new Date(d.getFullYear(), d.getMonth() + 1, 0));
    }],
    [/([日月火水木金土])曜日?/, (m) => nextWeekday(today, WD.indexOf(m[1]!), 0)],
    [/(\d{1,2})\s*[/／月]\s*(\d{1,2})\s*日?/, (m) => {
      const mo = Number(m[1]);
      const da = Number(m[2]);
      if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
      const d = new Date(year, mo - 1, da);
      if (d.getMonth() !== mo - 1) return null; // 存在しない日付 (2/30 など) は読み取らない
      let iso = toISODate(d);
      if (iso < today) iso = toISODate(new Date(year + 1, mo - 1, da)); // 過ぎた日付は来年
      return iso;
    }],
  ];
  for (const [re, f] of rules) {
    const m = text.match(re);
    if (!m) continue;
    const due = f(m);
    if (!due) continue;
    // 「明日までに」「10/20まで」などの助詞もまとめて外す
    const withSuffix = new RegExp(`${m[0].replace(/[/]/g, '\\/')}(までに|まで|中に|に)?[、,\\s]*`);
    const title = text.replace(withSuffix, '').trim();
    // 「月末の確認作業」のように名詞として使われている場合は、タスク名はそのまま残す
    return { title: !title || /^[のを]/.test(title) ? text : title, dueDate: due, matched: m[0] };
  }
  return { title: text, dueDate: null, matched: null };
}
