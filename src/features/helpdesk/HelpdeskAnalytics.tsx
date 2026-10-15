/**
 * ヘルプデスク分析。
 * - 件数が少ない指標は数値を出さず「データ不足（n件 / 必要m件）」と表示する
 * - 指標の定義 (特に解決時間) を画面上で明示する
 */
import { BarChart3, Clock, Info, Repeat, Sparkles, Users } from 'lucide-react';
import { useEffect } from 'react';
import { useAppData } from '../../app/AppData';
import { markAnalyticsSeen } from '../DemoGuide';
import { navigate } from '../../app/router';
import { formatHours, type Metric } from '../../domain/helpdesk/analytics';
import { PRIORITY_LABEL } from '../../domain/types';
import { HorizontalBarChart, StackedBar } from '../../ui/charts';
import { Card, CardHeader, EmptyState, cx } from '../../ui/primitives';

export function MetricValue({ metric, format, testId }: { metric: Metric<number>; format: (v: number) => string; testId?: string }) {
  if (metric.status === 'insufficient')
    return (
      <span className="text-sm font-semibold text-slate-400" data-testid={testId}>
        データ不足
        <span className="block text-[11px] font-normal">
          {metric.sample}件 / 必要{metric.required}件
        </span>
      </span>
    );
  return (
    <span className="text-2xl font-bold tabular-nums text-slate-900 dark:text-white" data-testid={testId}>
      {format(metric.value)}
      <span className="ml-1 text-[11px] font-normal text-slate-400">n={metric.sample}</span>
    </span>
  );
}

export function HelpdeskAnalytics() {
  const { helpdeskStats: s } = useAppData();
  useEffect(markAnalyticsSeen, []);
  if (s.total === 0) return <EmptyState icon={BarChart3} title="問い合わせがまだありません" description="問い合わせを登録すると、ここに分析結果が表示されます" />;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          { label: '未対応（新規）', value: s.newCount, href: '#/helpdesk?status=new', tone: s.newCount ? 'text-violet-700 dark:text-violet-300' : '' },
          { label: '対応中', value: s.inProgressCount + s.waitingCount + s.onHoldCount, sub: `回答待ち${s.waitingCount}・保留${s.onHoldCount}を含む`, href: '#/helpdesk?status=working' },
          { label: '解決済み・完了', value: s.resolvedCount + s.closedCount, sub: `完了${s.closedCount}件`, href: '#/helpdesk?status=done' },
          { label: '対応期限超過', value: s.overdueCount, href: '#/helpdesk?status=overdue', tone: s.overdueCount ? 'text-red-600 dark:text-red-400' : '' },
        ].map((k) => (
          <a key={k.label} href={k.href} className="rounded-2xl border border-slate-200/80 bg-white p-4 transition-shadow hover:shadow-md dark:border-navy-800 dark:bg-navy-900" data-testid={`hd-stat-${k.label}`}>
            <p className="text-xs font-semibold text-slate-500">{k.label}</p>
            <p className={cx('mt-1 text-[28px] font-bold leading-none tabular-nums', k.tone || 'text-slate-900 dark:text-white')}>
              {k.value}
              <span className="ml-1 text-sm font-medium text-slate-400">件</span>
            </p>
            {k.sub && <p className="mt-1.5 text-[11px] text-slate-500">{k.sub}</p>}
          </a>
        ))}
      </div>

      <Card>
        <CardHeader title="解決時間" icon={Clock} />
        <div className="grid grid-cols-2 gap-4 p-4 sm:p-5">
          <div>
            <p className="text-xs text-slate-500">平均</p>
            <MetricValue metric={s.avgResolutionHours} format={formatHours} testId="avg-resolution" />
          </div>
          <div>
            <p className="text-xs text-slate-500">中央値</p>
            <MetricValue metric={s.medianResolutionHours} format={formatHours} />
          </div>
          <p className="col-span-2 flex items-start gap-1 text-[11px] text-slate-500">
            <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
            定義：受付日時から、最初に「解決済み」にした日時までの経過時間（休日・夜間を含む暦時間）。解決済み・完了の案件のみ対象。3件未満は表示しません。
          </p>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="カテゴリ別件数" icon={BarChart3} description="全期間（タップで一覧を絞り込み）" />
          <div className="px-3 pb-4 pt-3 sm:px-4">
            <HorizontalBarChart unit="件" onSelect={(k) => navigate(`/helpdesk?category=${k}&status=all`)} data={s.byCategory.map((c) => ({ key: c.categoryId, label: c.name, value: c.count }))} />
          </div>
        </Card>
        <Card>
          <CardHeader title="優先度別件数" icon={BarChart3} description="全期間" />
          <div className="p-4 sm:p-5">
            <StackedBar
              unit="件"
              onSelect={(k) => navigate(`/helpdesk?priority=${k}&status=all`)}
              data={s.byPriority.map((p) => ({
                key: p.priority,
                label: `${PRIORITY_LABEL[p.priority]}（未解決${p.open}）`,
                value: p.count,
                color: p.priority === 'high' ? 'var(--color-chart-high)' : p.priority === 'medium' ? 'var(--color-chart-progress)' : 'var(--color-chart-todo)',
              }))}
            />
          </div>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="頻出問い合わせ" icon={Repeat} description="件名が似ている問い合わせ（同カテゴリ・2件以上）" />
          <div className="px-4 pb-4 pt-2 sm:px-5">
            {s.frequent.length === 0 ? (
              <p className="py-3 text-sm text-slate-400">データ不足（類似した問い合わせが2件以上ありません）</p>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-navy-800" data-testid="frequent-list">
                {s.frequent.map((f) => (
                  <li key={f.title} className="flex items-center gap-3 py-2.5">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-navy-50 text-sm font-bold tabular-nums text-navy-700 dark:bg-navy-800 dark:text-navy-100">{f.count}</span>
                    <span className="min-w-0 flex-1 text-sm">
                      <a href={`#/helpdesk?q=${encodeURIComponent(f.title.slice(0, 8))}&status=all`} className="font-semibold text-slate-800 hover:underline dark:text-slate-100">
                        「{f.title}」など
                      </a>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-[11px] text-slate-500">頻出する内容はFAQ化すると、問い合わせ対応の時間を減らせます。</p>
          </div>
        </Card>
        <Card>
          <CardHeader title="担当者別の対応状況" icon={Users} />
          <div className="overflow-x-auto px-2 pb-3 pt-2 sm:px-3">
            <table className="w-full min-w-[20rem] text-sm" data-testid="assignee-table">
              <thead className="text-left text-[11px] text-slate-500">
                <tr>
                  <th className="px-2 py-1.5 font-medium">担当者</th>
                  <th className="px-2 py-1.5 text-right font-medium">未解決</th>
                  <th className="px-2 py-1.5 text-right font-medium">期限超過</th>
                  <th className="px-2 py-1.5 text-right font-medium">解決</th>
                  <th className="px-2 py-1.5 text-right font-medium">平均解決</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
                {s.byAssignee.map((a) => (
                  <tr key={a.assignee}>
                    <td className="px-2 py-2">{a.assignee}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{a.open}</td>
                    <td className={cx('px-2 py-2 text-right tabular-nums', a.overdue > 0 && 'font-semibold text-red-600 dark:text-red-400')}>{a.overdue}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{a.resolved}</td>
                    <td className="px-2 py-2 text-right text-xs tabular-nums">{a.avgResolutionHours.status === 'ok' ? formatHours(a.avgResolutionHours.value) : <span className="text-slate-400">データ不足</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="自動分類の採用率" icon={Sparkles} description="自動分類の候補を担当者がそのまま採用した割合（低い場合はカテゴリのキーワードを見直す）" />
        <div className="grid grid-cols-2 gap-4 p-4 sm:p-5">
          {s.classificationAcceptance.status === 'insufficient' ? (
            <p className="col-span-2 text-sm text-slate-400">
              データ不足（{s.classificationAcceptance.sample}件 / 必要{s.classificationAcceptance.required}件）
            </p>
          ) : (
            <>
              <div>
                <p className="text-xs text-slate-500">カテゴリ</p>
                <p className="text-2xl font-bold tabular-nums">{s.classificationAcceptance.value.category}%</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">優先度</p>
                <p className="text-2xl font-bold tabular-nums">{s.classificationAcceptance.value.priority}%</p>
              </div>
              <p className="col-span-2 text-[11px] text-slate-500">n={s.classificationAcceptance.sample}。採用率は「正解率」ではありません（担当者の判断が正しいとは限らないため）。</p>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
