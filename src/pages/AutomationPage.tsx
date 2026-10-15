/**
 * 自動化センター: 承認待ちの提案 / 自動化の一覧 (実行条件・承認要否) / 処理履歴。
 * 提案は「承認するまで何も変わらない」。自動実行されるのは下書き (発注候補) の作成だけ。
 */
import { Bot, CheckCircle2, CircleSlash, Cpu, History, ShieldCheck, Sparkles, XCircle } from 'lucide-react';
import { useAppData } from '../app/AppData';
import { useQueryState } from '../app/hooks';
import { ALL_AUTOMATIONS } from '../automation/registry';
import { readAutomationSettings, ruleSetting, type RuleMode } from '../automation/settings';
import { formatDateTimeJa } from '../domain/date';
import { ProposalCard } from '../features/inventory/parts';
import { Badge, Card, CardHeader, EmptyState, FilterSelect, PageHeader } from '../ui/primitives';
import { MissingTargetNotice, TargetNotices } from '../ui/notices';
import { useFocusHighlight } from '../app/focus';
import { proposalFocusId } from '../domain/notifications';

export function AutomationPage({ query }: { query: URLSearchParams }) {
  const { proposals, data, run } = useAppData();
  // 通知から特定の提案・処理履歴へ (#/automation?focus=自動化ID|キー または run:処理ID)
  const focusId = query.get('focus');
  const focusProposal = focusId ? proposals.find((p) => proposalFocusId(p) === focusId) : undefined;
  const focusRun = focusId?.startsWith('run:') ? data.automationRuns.slice(0, 40).find((r) => `run:${r.id}` === focusId) : undefined;
  const settings = readAutomationSettings(data);
  const [f, setF] = useQueryState({ type: '' });
  const list = proposals.filter((p) => !f.type || p.automationId === f.type || p === focusProposal);
  useFocusHighlight(focusProposal || focusRun ? focusId : null);
  const runs = data.automationRuns.slice(0, 40);
  return (
    <>
      <PageHeader title="自動化センター" description="部門をまたぐ作業を自動で判定し、提案します。在庫・資産を変える操作は承認するまで実行されません" />
      {focusId && !focusProposal && !focusRun && (
        <MissingTargetNotice what={focusId.startsWith('run:') ? '処理履歴' : '自動化の提案'}>
          {focusId.startsWith('run:') ? '' : '承認・見送り済みの提案は下の「処理履歴」で確認できます。'}
        </MissingTargetNotice>
      )}
      {focusProposal && <TargetNotices targetId={focusId!} />}
      <Card className="mb-4 p-3">
        <FilterSelect
          label="自動化の種類"
          value={f.type}
          onChange={(v) => setF({ type: v })}
          options={[{ value: '', label: `すべての提案（${proposals.length}件）` }, ...ALL_AUTOMATIONS.filter((d) => d.approval === 'required' && ruleSetting(d, settings).enabled).map((d) => ({ value: d.id, label: `${d.name}（${proposals.filter((p) => p.automationId === d.id).length}）` }))]}
        />
      </Card>
      <section aria-label="承認待ちの提案" className="space-y-3" data-testid="proposal-list">
        {list.length === 0 ? (
          <Card>
            <EmptyState icon={CheckCircle2} title="承認待ちの提案はありません" description="新入社員の登録・退職日の設定・故障の問い合わせ・在庫の変化に応じて自動で提案されます" />
          </Card>
        ) : (
          list.map((p) => <ProposalCard key={proposalFocusId(p)} proposal={p} compact={list.length > 2} forceOpen={p === focusProposal} />)
        )}
      </section>

      <Card className="mt-6">
        <CardHeader title="自動化ルールの設定" icon={Bot} description="実行条件と実行方法。新しいルールは登録すると自動でここに並びます" />
        <ul className="divide-y divide-slate-100 px-4 pb-3 sm:px-5 dark:divide-navy-800" data-testid="rule-settings">
          {ALL_AUTOMATIONS.map((d) => {
            const st = ruleSetting(d, settings);
            const save = (enabled: boolean, mode: RuleMode) =>
              run((s) => s.saveRuleSetting(d.id, { enabled, mode }), enabled ? (mode === 'auto' ? `「${d.name}」を自動で実行します` : `「${d.name}」は確認してから実行します`) : `「${d.name}」を無効にしました`).catch(() => undefined);
            return (
              <li key={d.id} className="py-3" data-rule={d.id}>
                <div className="flex flex-wrap items-center gap-2">
                  {d.category && <Badge>{d.category}</Badge>}
                  <p className="min-w-0 flex-1 font-semibold">{d.name}</p>
                  <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
                    <input type="checkbox" className="size-5 accent-navy-700" checked={st.enabled} onChange={(e) => save(e.target.checked, st.mode)} aria-label={`${d.name}を有効にする`} />
                    有効
                  </label>
                </div>
                <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-300">{d.description}</p>
                <p className="mt-0.5 text-[11px] text-slate-500">実行条件：{d.trigger}</p>
                {d.approval === 'auto' ? (
                  <p className="mt-1">
                    <Badge icon={Cpu}>自動実行（下書きのみ）</Badge>
                  </p>
                ) : d.autoCapable ? (
                  <div className="mt-1.5 flex flex-wrap gap-1.5" role="radiogroup" aria-label={`${d.name}の実行方法`}>
                    {(
                      [
                        ['confirm', '確認してから実行'],
                        ['auto', '自動で実行'],
                      ] as const
                    ).map(([m, label]) => (
                      <button
                        key={m}
                        type="button"
                        role="radio"
                        aria-checked={st.mode === m}
                        disabled={!st.enabled}
                        onClick={() => save(true, m)}
                        className={`min-h-10 rounded-full border px-3 text-xs font-semibold disabled:opacity-40 ${st.mode === m ? 'border-navy-700 bg-navy-700 text-white dark:border-navy-400 dark:bg-navy-500' : 'border-slate-300 bg-white text-slate-600 dark:border-navy-700 dark:bg-navy-900 dark:text-slate-300'}`}
                        data-testid={`mode-${d.id}-${m}`}
                      >
                        {label}
                      </button>
                    ))}
                    <span className="self-center text-[11px] text-slate-500">タスクの作成だけを行うため、自動実行を選べます</span>
                  </div>
                ) : (
                  <p className="mt-1">
                    <Badge tone="violet" icon={ShieldCheck}>
                      常に承認後に実行（在庫・資産を変えるため）
                    </Badge>
                  </p>
                )}
              </li>
            );
          })}
          <li className="py-3 text-xs text-slate-500">
            このほか、資産の貸出・返却では状態（未使用・使用中など）が自動で切り替わり、入荷した在庫は入荷待ちの予約へ自動で引き当てられます（いずれも履歴に記録）。発注・請求・申請・外部への送信・アカウントの削除は、自動化では実行しません。
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
              <li key={r.id} className="py-2.5 text-sm" data-focus-id={`run:${r.id}`}>
                <div className="flex items-center gap-2">
                  {r.status === 'applied' ? <CheckCircle2 className="size-4 text-emerald-600" aria-label="実行" /> : r.status === 'failed' ? <XCircle className="size-4 text-red-600" aria-label="失敗" /> : r.status === 'auto' ? <Sparkles className="size-4 text-navy-500" aria-label="自動実行" /> : <CircleSlash className="size-4 text-slate-400" aria-label="見送り" />}
                  <span className="min-w-0 flex-1 font-medium">{r.title}</span>
                  <Badge tone={r.status === 'applied' ? 'green' : r.status === 'failed' ? 'red' : r.status === 'auto' ? 'navy' : 'gray'}>{{ applied: '実行', failed: '失敗', auto: '自動', dismissed: '見送り' }[r.status]}</Badge>
                </div>
                {r.error && <p className="mt-0.5 pl-6 text-xs text-red-600 dark:text-red-400">{r.error}（変更はすべて取り消されました）</p>}
                {r.results.length > 0 && <p className="mt-0.5 pl-6 text-xs text-slate-500">{r.results.join('／')}</p>}
                <p className="pl-6 text-[11px] text-slate-400">{formatDateTimeJa(r.at)}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
