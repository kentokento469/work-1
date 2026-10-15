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

export interface SegmentDef {
  key: string;
  label: string;
  /** CSS の色 (var(--color-...)) */
  color: string;
}

export interface SegmentRow {
  key: string;
  label: string;
  values: Record<string, number>;
  /** 右端に大きく表示する数 (例: 在籍人数) */
  primary: number;
}

/**
 * 区分別の積み上げ横棒 (行ごと)。スマホでの見やすさを優先し、
 * 1行目に「名前・主な数」、2行目に棒、3行目に内訳の文字を常に表示する (ホバーに頼らない)。
 * 棒の長さは全行の合計の最大値に対する比率。人数が少ない区分も見えるよう最小幅を付ける。
 */
export function SegmentedBarRows({
  rows,
  segments,
  unit,
  primaryLabel,
  onSelect,
  minSegmentPx = 6,
}: {
  rows: SegmentRow[];
  segments: SegmentDef[];
  unit: string;
  primaryLabel: string;
  onSelect?: (key: string) => void;
  minSegmentPx?: number;
}) {
  const totalOf = (r: SegmentRow) => segments.reduce((a, s) => a + (r.values[s.key] ?? 0), 0);
  const max = Math.max(1, ...rows.map(totalOf));
  return (
    <div>
      <ul className="mb-3 flex flex-wrap gap-x-3 gap-y-1.5" aria-label="凡例" data-testid="segment-legend">
        {segments.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5 text-[11px] text-slate-600 dark:text-slate-300">
            <span className="size-2.5 shrink-0 rounded-sm" style={{ background: s.color }} aria-hidden />
            {s.label}
          </li>
        ))}
      </ul>
      <ul className="space-y-1" data-testid="segment-rows">
        {rows.map((r) => {
          const total = totalOf(r);
          const parts = segments.filter((s) => (r.values[s.key] ?? 0) > 0);
          const summary = parts.map((s) => `${s.label}${r.values[s.key]}`).join('・');
          return (
            <li key={r.key}>
              <button
                type="button"
                onClick={() => onSelect?.(r.key)}
                className="w-full rounded-xl px-2 py-2 text-left transition-colors hover:bg-slate-50 active:bg-slate-100 dark:hover:bg-navy-800/60 dark:active:bg-navy-800"
                aria-label={`${r.label}：${primaryLabel}${r.primary}${unit}${summary ? `（${summary}）` : ''}`}
                data-row={r.key}
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-[13px] font-semibold text-slate-700 dark:text-slate-200">{r.label}</span>
                  <span className="shrink-0 text-sm font-bold tabular-nums text-slate-900 dark:text-white">
                    <span className="mr-1 text-[10px] font-normal text-slate-400">{primaryLabel}</span>
                    {r.primary}
                    <span className="ml-0.5 text-[11px] font-normal text-slate-400">{unit}</span>
                  </span>
                </span>
                <span className="mt-1 block h-3.5 overflow-hidden rounded-full bg-slate-100 dark:bg-navy-800" aria-hidden>
                  {total > 0 && (
                    <span className="flex h-full gap-px transition-[width] duration-500" style={{ width: `max(${(total / max) * 100}%, ${parts.length * minSegmentPx}px)` }}>
                      {parts.map((s) => (
                        <span key={s.key} className="h-full first:rounded-l-full last:rounded-r-full" style={{ flexGrow: r.values[s.key], flexBasis: 0, minWidth: minSegmentPx, background: s.color }} />
                      ))}
                    </span>
                  )}
                </span>
                <span className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] tabular-nums text-slate-500 dark:text-slate-400" aria-hidden>
                  {parts.length === 0 ? (
                    <span>所属なし</span>
                  ) : (
                    parts.map((s) => (
                      <span key={s.key} className="inline-flex items-center gap-1">
                        <span className="size-2 rounded-sm" style={{ background: s.color }} />
                        {s.label}
                        {r.values[s.key]}
                      </span>
                    ))
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
