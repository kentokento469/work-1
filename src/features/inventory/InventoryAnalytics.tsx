/**
 * 購買・在庫分析。金額は「参考在庫額」「取得原価」「発注金額」を区別して表示し、
 * 会計上の在庫評価・資産評価ではないことを明示する。
 */
import { BarChart3, Info, Laptop, Truck, Wrench } from 'lucide-react';
import { useAppData } from '../../app/AppData';
import { formatDateTimeJa } from '../../domain/date';
import { yen } from '../../domain/inventory/analytics';
import { ASSET_STATUS_LABEL } from '../../domain/inventory/types';
import { HorizontalBarChart, StackedBar } from '../../ui/charts';
import { Card, CardHeader } from '../../ui/primitives';

const ASSET_COLORS: Record<string, string> = {
  unused: 'var(--color-chart-done)',
  reserved: '#6250d6',
  in_use: 'var(--color-chart-progress)',
  repair: 'var(--color-chart-hold)',
  broken: 'var(--color-chart-high)',
  disposal_planned: 'var(--color-chart-todo)',
  disposed: '#b5b3ad',
};

export function InventoryAnalytics() {
  const { inventoryStats: s } = useAppData();
  const maxMonthly = Math.max(1, ...s.monthly.map((m) => Math.max(m.receive, m.issue)));
  return (
    <div className="space-y-4" data-testid="inventory-analytics">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          ['総在庫数', s.totalOnHand, '全品目の実在庫の合計（個体管理品は未使用・予約済みの台数）'],
          ['利用可能在庫数', s.totalAvailable, '実在庫から予約分を除いた数'],
          ['貸出中の機器', s.assetsInUse, '使用中の資産の台数'],
          ['在庫不足の品目', s.shortageItems, '見込み在庫が最低在庫数を下回る品目'],
        ].map(([label, value, hint]) => (
          <div key={label as string} className="rounded-2xl border border-slate-200/80 bg-white p-4 dark:border-navy-800 dark:bg-navy-900" title={hint as string}>
            <p className="text-xs font-semibold text-slate-500">{label}</p>
            <p className="mt-1 text-[28px] font-bold leading-none tabular-nums">{value as number}</p>
            <p className="mt-1.5 text-[10px] leading-snug text-slate-400">{hint}</p>
          </div>
        ))}
      </div>
      <p className="text-xs text-slate-500">
        発注待ち：候補 {s.openSuggestions}件・承認待ち {s.pendingApproval}件・入荷待ち {s.awaitingReceipt}件
      </p>

      <Card>
        <CardHeader title="月別入出庫（直近6か月）" icon={BarChart3} description="数量の合計（保管場所の移動は含まない）" />
        <div className="p-4 sm:p-5">
          <ul className="space-y-2" data-testid="monthly-chart">
            {s.monthly.map((m) => (
              <li key={m.month} className="grid grid-cols-[3rem_1fr] items-center gap-2 text-xs">
                <span className="text-slate-500">{m.label}</span>
                <span className="space-y-1">
                  <span className="flex items-center gap-2">
                    <span className="h-3 rounded-r bg-[var(--color-chart-done)]" style={{ width: `${(m.receive / maxMonthly) * 100}%`, minWidth: m.receive ? 4 : 0 }} aria-hidden />
                    <span className="tabular-nums text-slate-600 dark:text-slate-300">入庫 {m.receive}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="h-3 rounded-r bg-[var(--color-chart-progress)]" style={{ width: `${(m.issue / maxMonthly) * 100}%`, minWidth: m.issue ? 4 : 0 }} aria-hidden />
                    <span className="tabular-nums text-slate-600 dark:text-slate-300">
                      出庫 {m.issue}
                      {m.adjust !== 0 && `・調整 ${m.adjust > 0 ? '+' : ''}${m.adjust}`}
                    </span>
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="カテゴリ別の参考在庫額" icon={BarChart3} description={`合計 ${yen(s.totalReferenceValue)}`} />
          <div className="px-3 pb-4 pt-3 sm:px-4">
            <HorizontalBarChart unit="千円" data={s.categoryValue.map((c) => ({ key: c.category, label: c.label, value: Math.round(c.value / 1000) }))} />
          </div>
        </Card>
        <Card>
          <CardHeader title="資産の利用状況" icon={Laptop} description={`取得原価の合計 ${yen(s.acquisitionCostTotal)}（廃棄済みを除く）`} />
          <div className="p-4 sm:p-5">
            <StackedBar unit="台" data={s.assetStatus.filter((x) => x.count > 0).map((x) => ({ key: x.status, label: ASSET_STATUS_LABEL[x.status], value: x.count, color: ASSET_COLORS[x.status]! }))} />
          </div>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="故障・交換の履歴" icon={Wrench} description="直近1年（最大10件）" />
          <div className="px-4 pb-4 pt-2 sm:px-5">
            {s.failureHistory.length === 0 ? (
              <p className="text-sm text-slate-500">記録はありません。</p>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-navy-800">
                {s.failureHistory.map((h, i) => (
                  <li key={i} className="py-2 text-sm">
                    <a href={`#/inventory/assets/${h.assetId}`} className="font-mono text-xs font-semibold text-navy-600 dark:text-navy-300">
                      {h.assetNumber}
                    </a>
                    <span className="ml-2">{h.text}</span>
                    <span className="block text-[11px] text-slate-400">
                      {formatDateTimeJa(h.at)}
                      {h.inquiryId && (
                        <a href={`#/helpdesk/${h.inquiryId}`} className="ml-2 font-semibold text-navy-600 dark:text-navy-300">
                          関連する問い合わせ
                        </a>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title="仕入先別の発注金額" icon={Truck} description="発注書の数量 × 発注時単価" />
          <div className="overflow-x-auto px-2 pb-3 pt-2 sm:px-3">
            {s.supplierAmounts.length === 0 ? (
              <p className="px-3 py-2 text-sm text-slate-500">発注書はまだありません。</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-[11px] text-slate-500">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">仕入先</th>
                    <th className="px-2 py-1.5 text-right font-medium">承認済み以降</th>
                    <th className="px-2 py-1.5 text-right font-medium">下書き・承認待ち</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
                  {s.supplierAmounts.map((x) => (
                    <tr key={x.supplierId}>
                      <td className="px-2 py-2">{x.name}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{yen(x.approved)}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-slate-500">{yen(x.pending)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>
      </div>
      <p className="flex items-start gap-1.5 rounded-xl bg-slate-50 p-3 text-xs text-slate-600 dark:bg-navy-950 dark:text-slate-300">
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        金額の区別：「参考在庫額」＝参考単価×実在庫（見積・概算用）、「取得原価」＝資産の購入金額、「発注金額」＝発注書の数量×発注時単価。いずれも会計上の在庫評価額・資産評価額（減価償却等）ではありません。
      </p>
    </div>
  );
}
