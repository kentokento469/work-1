/**
 * 軽量グラフコンポーネント (外部ライブラリ非依存)。
 * - 値は常にテキストでも併記し、色だけに意味を持たせない
 * - ホバー/タップで詳細ツールチップを表示
 */
import { useState } from 'react';
import { cx } from './primitives';

export interface BarDatum {
  key: string;
  label: string;
  value: number;
}

/** 横棒グラフ (単一系列)。スマホ幅でもラベルが潰れないよう横向き */
export function HorizontalBarChart({ data, unit, onSelect }: { data: BarDatum[]; unit: string; onSelect?: (key: string) => void }) {
  const [hover, setHover] = useState<string | null>(null);
  const max = Math.max(1, ...data.map((d) => d.value));
  const total = data.reduce((a, d) => a + d.value, 0);

  return (
    <div className="space-y-1" role="list">
      {data.map((d) => {
        const pct = (d.value / max) * 100;
        const share = total ? Math.round((d.value / total) * 100) : 0;
        const active = hover === d.key;
        return (
          <button
            key={d.key}
            type="button"
            role="listitem"
            onMouseEnter={() => setHover(d.key)}
            onMouseLeave={() => setHover(null)}
            onFocus={() => setHover(d.key)}
            onBlur={() => setHover(null)}
            onClick={() => onSelect?.(d.key)}
            className={cx(
              'group grid w-full grid-cols-[6.5rem_1fr_3rem] items-center gap-3 rounded-lg px-1 py-1.5 text-left transition-colors',
              active && 'bg-slate-50 dark:bg-navy-800/60',
            )}
            aria-label={`${d.label} ${d.value}${unit}（全体の${share}%）`}
          >
            <span className="truncate text-[13px] text-slate-600 dark:text-slate-300">{d.label}</span>
            <span className="relative h-5">
              <span className="absolute inset-y-0 left-0 w-full rounded bg-slate-100 dark:bg-navy-800" aria-hidden />
              <span
                className="absolute inset-y-0 left-0 rounded bg-[var(--color-chart-bar)] transition-[width] duration-500"
                style={{ width: d.value === 0 ? 0 : `max(${pct}%, 6px)`, opacity: hover && !active ? 0.55 : 1 }}
                aria-hidden
              />
              {active && (
                <span className="pointer-events-none absolute -top-8 left-0 z-10 whitespace-nowrap rounded-md bg-navy-950 px-2 py-1 text-[11px] text-white shadow-lg dark:bg-white dark:text-navy-950">
                  {d.label}：{d.value}
                  {unit}（{share}%）
                </span>
              )}
            </span>
            <span className="text-right text-sm font-semibold tabular-nums text-slate-800 dark:text-slate-100">
              {d.value}
              <span className="ml-0.5 text-[11px] font-normal text-slate-400">{unit}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export interface StackDatum {
  key: string;
  label: string;
  value: number;
  color: string;
}

/** 100% 積み上げ横棒 + 凡例 (件数と割合を併記) */
export function StackedBar({ data, unit, onSelect }: { data: StackDatum[]; unit: string; onSelect?: (key: string) => void }) {
  const [hover, setHover] = useState<string | null>(null);
  const total = data.reduce((a, d) => a + d.value, 0);
  const visible = data.filter((d) => d.value > 0);

  return (
    <div>
      <div className="relative flex h-4 w-full gap-[2px] overflow-visible">
        {total === 0 ? (
          <div className="h-full w-full rounded bg-slate-100 dark:bg-navy-800" />
        ) : (
          visible.map((d, i) => (
            <div
              key={d.key}
              className={cx('relative h-full transition-opacity', i === 0 && 'rounded-l', i === visible.length - 1 && 'rounded-r')}
              style={{ width: `${(d.value / total) * 100}%`, background: d.color, opacity: hover && hover !== d.key ? 0.4 : 1 }}
              onMouseEnter={() => setHover(d.key)}
              onMouseLeave={() => setHover(null)}
              aria-hidden
            />
          ))
        )}
      </div>
      <ul className="mt-4 grid grid-cols-2 gap-2">
        {data.map((d) => {
          const pct = total ? Math.round((d.value / total) * 100) : 0;
          return (
            <li key={d.key}>
              <button
                type="button"
                onMouseEnter={() => setHover(d.key)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(d.key)}
                onBlur={() => setHover(null)}
                onClick={() => onSelect?.(d.key)}
                className={cx(
                  'flex min-h-11 w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors',
                  hover === d.key ? 'border-slate-300 bg-slate-50 dark:border-navy-600 dark:bg-navy-800' : 'border-slate-200 dark:border-navy-800',
                )}
              >
                <span className="size-2.5 shrink-0 rounded-sm" style={{ background: d.color }} aria-hidden />
                <span className="flex-1 text-[13px] text-slate-600 dark:text-slate-300">{d.label}</span>
                <span className="text-sm font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                  {d.value}
                  <span className="ml-0.5 text-[11px] font-normal text-slate-400">
                    {unit}・{pct}%
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** 進捗リング (完了率の表示用) */
export function ProgressRing({ value, size = 56, stroke = 6, label }: { value: number; size?: number; stroke?: number; label: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${label} ${v}%`} className="shrink-0 -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-slate-100 dark:stroke-navy-800" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={stroke}
        strokeLinecap="round"
        stroke="var(--color-chart-done)"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - v / 100)}
        className="transition-[stroke-dashoffset] duration-700"
      />
    </svg>
  );
}

/** 細い進捗バー */
export function ProgressBar({ value, className }: { value: number; className?: string }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className={cx('h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-navy-800', className)} role="progressbar" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full bg-[var(--color-chart-done)] transition-[width] duration-500" style={{ width: `${v}%` }} />
    </div>
  );
}
