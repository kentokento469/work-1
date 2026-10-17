/**
 * 営業日の設定 (Phase 12)。休みの曜日・日本の祝日・会社の休業日 (年末年始・夏季休業など) を設定する。
 * 期限の自動計算 (入社準備・問い合わせの対応期限・自動化のタスク) と、繰り返しの営業日調整に使う。
 */
import { useMemo, useState } from 'react';
import { CalendarOff, Plus, X } from 'lucide-react';
import { useAppData } from '../app/AppData';
import { japaneseHolidays, readBusinessCalendar, yearEndHolidays, type BusinessCalendar } from '../domain/calendar';
import { formatDateJa, isValidISODate } from '../domain/date';
import { Button, Card, CardHeader, cx } from '../ui/primitives';

const WD = ['日', '月', '火', '水', '木', '金', '土'];

export function CalendarSettingsCard() {
  const { data, run, today } = useAppData();
  const saved = useMemo(() => readBusinessCalendar(data.settings), [data.settings]);
  const [newDate, setNewDate] = useState('');
  const save = (next: BusinessCalendar, msg: string) => run((s) => s.saveBusinessCalendar(next), msg).catch(() => undefined);
  const year = Number(today.slice(0, 4));
  const upcoming = [...japaneseHolidays(year), ...japaneseHolidays(year + 1)].filter(([d]) => d >= today).slice(0, 6);
  const futureCompany = saved.companyHolidays.filter((d) => d >= today);
  const addDates = (dates: string[]) => {
    const merged = [...new Set([...saved.companyHolidays, ...dates])].sort();
    void save({ ...saved, companyHolidays: merged }, `会社の休業日を追加しました（${dates.length}日）`);
  };

  return (
    <Card className="mt-4" data-testid="calendar-settings">
      <CardHeader title="営業日・休業日" icon={CalendarOff} description="期限の自動計算（入社準備・問い合わせの対応期限・自動化のタスク）で、休みの日を避けます" />
      <div className="space-y-4 p-4 sm:p-5 text-sm">
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-semibold">休みの曜日</legend>
          <div className="flex flex-wrap gap-2">
            {WD.map((w, i) => {
              const on = saved.weekendDays.includes(i);
              return (
                <button
                  key={w}
                  type="button"
                  aria-pressed={on}
                  onClick={() => save({ ...saved, weekendDays: on ? saved.weekendDays.filter((d) => d !== i) : [...saved.weekendDays, i].sort() }, `休みの曜日を変更しました`)}
                  className={cx('min-h-11 min-w-11 rounded-lg border px-3 font-semibold', on ? 'border-navy-700 bg-navy-50 text-navy-900 dark:border-navy-400 dark:bg-navy-800 dark:text-white' : 'border-slate-200 text-slate-600 dark:border-navy-700 dark:text-slate-300')}
                  data-testid={`weekend-${i}`}
                >
                  {w}
                </button>
              );
            })}
          </div>
        </fieldset>
        <label className="flex min-h-11 cursor-pointer items-center gap-2">
          <input type="checkbox" className="size-5 accent-navy-700" checked={saved.observeHolidays} onChange={(e) => save({ ...saved, observeHolidays: e.target.checked }, e.target.checked ? '日本の祝日を休みにしました' : '日本の祝日を営業日にしました')} data-testid="observe-holidays" />
          日本の祝日（振替休日・国民の休日を含む）を休みにする
        </label>
        {saved.observeHolidays && (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            これからの祝日：{upcoming.map(([d, n]) => `${formatDateJa(d)} ${n}`).join('、')}
          </p>
        )}
        <div>
          <p className="mb-1.5 text-[13px] font-semibold">会社の休業日</p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs">
              <span className="sr-only">追加する休業日</span>
              <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} className="h-11 rounded-lg border border-slate-300 bg-white px-2 dark:border-navy-700 dark:bg-navy-950" aria-label="追加する休業日" data-testid="company-holiday-input" />
            </label>
            <Button
              variant="secondary"
              icon={Plus}
              disabled={!isValidISODate(newDate) || saved.companyHolidays.includes(newDate)}
              onClick={() => {
                addDates([newDate]);
                setNewDate('');
              }}
              data-testid="company-holiday-add"
            >
              追加
            </Button>
            <Button variant="secondary" onClick={() => addDates(yearEndHolidays(year))} data-testid="company-holiday-yearend">
              年末年始（{year}/12/29〜{year + 1}/1/3）を追加
            </Button>
          </div>
          {futureCompany.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-2" data-testid="company-holidays">
              {futureCompany.map((d) => (
                <li key={d} className="inline-flex min-h-9 items-center gap-1 rounded-full bg-slate-100 pl-3 pr-1 text-xs dark:bg-navy-800">
                  {formatDateJa(d)}
                  <button
                    type="button"
                    className="inline-flex size-8 items-center justify-center rounded-full hover:bg-slate-200 dark:hover:bg-navy-700"
                    aria-label={`${formatDateJa(d)} を休業日から外す`}
                    onClick={() => save({ ...saved, companyHolidays: saved.companyHolidays.filter((x) => x !== d) }, '会社の休業日を外しました')}
                  >
                    <X className="size-4" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">今日以降の休業日は登録されていません。</p>
          )}
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          祝日は祝日法の規則からこの端末で計算します（外部への通信なし）。春分・秋分の日は計算による推定のため、将来の年は官報の発表と異なる場合があります。その場合は会社の休業日で補正してください。
        </p>
      </div>
    </Card>
  );
}
