/**
 * 自動化センター: 承認待ちの提案 / 自動化の一覧 (実行条件・承認要否) / 処理履歴。
 * 提案は「承認するまで何も変わらない」。自動実行されるのは下書き (発注候補) の作成だけ。
 */
import { Bot, CheckCircle2, CircleSlash, Cpu, History, ShieldCheck, Sparkles, XCircle } from 'lucide-react';
import { useAppData } from '../app/AppData';
import { useQueryState } from '../app/hooks';
import { INVENTORY_AUTOMATIONS } from '../automation/inventoryAutomations';
import { formatDateTimeJa } from '../domain/date';
import { ProposalCard } from '../features/inventory/parts';
import { Badge, Card, CardHeader, EmptyState, FilterSelect, PageHeader } from '../ui/primitives';

export function AutomationPage() {
  const { proposals, data } = useAppData();
  const [f, setF] = useQueryState({ type: '' });
  const list = proposals.filter((p) => !f.type || p.automationId === f.type);
  const runs = data.automationRuns.slice(0, 40);
  return (
    <>
      <PageHeader title="自動化センター" description="部門をまたぐ作業を自動で判定し、提案します。在庫・資産を変える操作は承認するまで実行されません" />
      <Card className="mb-4 p-3">
        <FilterSelect
          label="自動化の種類"
          value={f.type}
          onChange={(v) => setF({ type: v })}
          options={[{ value: '', label: `すべての提案（${proposals.length}件）` }, ...INVENTORY_AUTOMATIONS.filter((d) => d.approval === 'required').map((d) => ({ value: d.id, label: `${d.name}（${proposals.filter((p) => p.automationId === d.id).length}）` }))]}
        />
      </Card>
      <section aria-label="承認待ちの提案" className="space-y-3" data-testid="proposal-list">
        {list.length === 0 ? (
          <Card>
            <EmptyState icon={CheckCircle2} title="承認待ちの提案はありません" description="新入社員の登録・退職日の設定・故障の問い合わせ・在庫の変化に応じて自動で提案されます" />
          </Card>
        ) : (
          list.map((p) => <ProposalCard key={`${p.automationId}|${p.key}`} proposal={p} compact={list.length > 2} />)
        )}
      </section>

      <Card className="mt-6">
        <CardHeader title="自動化の一覧" icon={Bot} description="実行条件と、承認が必要かどうか" />
        <ul className="divide-y divide-slate-100 px-4 pb-3 sm:px-5 dark:divide-navy-800">
          {INVENTORY_AUTOMATIONS.map((d) => (
            <li key={d.id} className="py-3">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-semibold">{d.name}</p>
                {d.approval === 'required' ? (
                  <Badge tone="violet" icon={ShieldCheck}>
                    承認後に実行
                  </Badge>
                ) : (
                  <Badge icon={Cpu}>自動実行（下書きのみ）</Badge>
                )}
              </div>
              <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-300">{d.description}</p>
              <p className="mt-0.5 text-[11px] text-slate-500">実行条件：{d.trigger}</p>
            </li>
          ))}
          <li className="py-3 text-xs text-slate-500">
            このほか、資産の貸出・返却では状態（未使用・使用中など）が自動で切り替わり、入荷した在庫は入荷待ちの予約へ自動で引き当てられます（いずれも履歴に記録）。
          </li>
        </ul>
      </Card>

      <Card className="mt-4">
        <CardHeader title="処理履歴" icon={History} description="実行・見送り・失敗・自動実行の記録（直近40件）" />
        {runs.length === 0 ? (
          <p className="px-5 pb-5 pt-2 text-sm text-slate-500">まだ記録はありません。</p>
        ) : (
          <ul className="divide-y divide-slate-100 px-4 pb-3 sm:px-5 dark:divide-navy-800" data-testid="automation-runs">
            {runs.map((r) => (
              <li key={r.id} className="py-2.5 text-sm">
                <div className="flex items-center gap-2">
                  {r.status === 'applied' ? <CheckCircle2 className="size-4 text-emerald-600" aria-label="実行" /> : r.status === 'failed' ? <XCircle className="size-4 text-red-600" aria-label="失敗" /> : r.status === 'auto' ? <Sparkles className="size-4 text-navy-500" aria-label="自動実行" /> : <CircleSlash className="size-4 text-slate-400" aria-label="見送り" />}
                  <span className="min-w-0 flex-1 font-medium">{r.title}</span>
                  <Badge tone={r.status === 'applied' ? 'green' : r.status === 'failed' ? 'red' : r.status === 'auto' ? 'navy' : 'gray'}>{{ applied: '実行', failed: '失敗', auto: '自動', dismissed: '見送り' }[r.status]}</Badge>
                </div>
                {r.error && <p className="mt-0.5 pl-6 text-xs text-red-600 dark:text-red-400">{r.error}（変更はすべて取り消されました）</p>}
                {r.results.length > 0 && r.status !== 'auto' && <p className="mt-0.5 pl-6 text-xs text-slate-500">{r.results.join('／')}</p>}
                <p className="pl-6 text-[11px] text-slate-400">{formatDateTimeJa(r.at)}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
