/**
 * 在庫・資産・自動化の共通部品。
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, Cpu, Info, Minus, Plus, ShieldCheck, Sparkles, Zap } from 'lucide-react';
import { useAppData } from '../../app/AppData';
import type { AutomationProposal } from '../../automation/engine';
import { INVENTORY_AUTOMATIONS } from '../../automation/inventoryAutomations';
import { ASSET_STATUS_LABEL, type AssetStatus, type Item } from '../../domain/inventory/types';
import type { StockStatus } from '../../domain/inventory/stock';
import { Badge, Button, cx, type Tone } from '../../ui/primitives';

const ASSET_TONE: Record<AssetStatus, Tone> = { unused: 'green', reserved: 'violet', in_use: 'blue', repair: 'amber', broken: 'red', disposal_planned: 'gray', disposed: 'gray' };
export function AssetStatusBadge({ status }: { status: AssetStatus }) {
  return <Badge tone={ASSET_TONE[status]}>{ASSET_STATUS_LABEL[status]}</Badge>;
}

/** 在庫数の表示。最重要の「利用可能数」を大きく、内訳は小さく (段階的開示) */
export function StockFigures({ item, s, compact }: { item: Item; s: StockStatus; compact?: boolean }) {
  return (
    <div className={cx('flex items-end gap-3', compact && 'gap-2')}>
      <div>
        <p className="text-[10px] font-semibold text-slate-500">利用可能</p>
        <p className={cx('font-bold tabular-nums leading-none', compact ? 'text-xl' : 'text-3xl', s.available <= 0 ? 'text-red-600 dark:text-red-400' : s.shortage ? 'text-amber-700 dark:text-amber-400' : 'text-slate-900 dark:text-white')} data-testid="available">
          {s.available}
          <span className="ml-0.5 text-xs font-normal text-slate-400">{item.unit}</span>
        </p>
      </div>
      <p className="pb-0.5 text-[11px] leading-tight text-slate-500 tabular-nums">
        実在庫 {s.onHand}
        {s.reserved > 0 && `・予約 ${s.reserved}`}
        {s.backorder > 0 && <span className="text-violet-700 dark:text-violet-300">・入荷待ち需要 {s.backorder}</span>}
        {s.onOrder > 0 && <span className="text-blue-700 dark:text-blue-300">・発注残 {s.onOrder}</span>}
        {item.tracking === 'asset' && s.inUse > 0 && `・使用中 ${s.inUse}`}
      </p>
    </div>
  );
}

export function ShortageBadge({ s }: { s: StockStatus }) {
  if (!s.shortage) return null;
  return (
    <Badge tone="amber" icon={AlertTriangle}>
      在庫不足
    </Badge>
  );
}

/** 片手で押しやすい大きな ± ボタン付きの数量入力 */
export function Stepper({ value, onChange, min = 1, max, label }: { value: number; onChange: (v: number) => void; min?: number; max?: number; label: string }) {
  const clamp = (v: number) => Math.max(min, max !== undefined ? Math.min(max, v) : v);
  return (
    <div className="flex items-center justify-center gap-3" role="group" aria-label={label}>
      <button type="button" aria-label="1減らす" onClick={() => onChange(clamp(value - 1))} disabled={value <= min} className="flex size-14 items-center justify-center rounded-2xl border border-slate-300 text-slate-700 active:bg-slate-100 disabled:opacity-30 dark:border-navy-700 dark:text-slate-200">
        <Minus className="size-6" aria-hidden />
      </button>
      <input
        type="number"
        inputMode="numeric"
        aria-label={label}
        value={Number.isFinite(value) ? value : ''}
        min={min}
        max={max}
        onChange={(e) => onChange(Math.floor(Number(e.target.value)))}
        className="h-14 w-24 rounded-2xl border border-slate-300 bg-white text-center text-2xl font-bold tabular-nums dark:border-navy-700 dark:bg-navy-950"
      />
      <button type="button" aria-label="1増やす" onClick={() => onChange(clamp(value + 1))} disabled={max !== undefined && value >= max} className="flex size-14 items-center justify-center rounded-2xl border border-slate-300 text-slate-700 active:bg-slate-100 disabled:opacity-30 dark:border-navy-700 dark:text-slate-200">
        <Plus className="size-6" aria-hidden />
      </button>
    </div>
  );
}

/**
 * 自動化の提案カード。
 * 実行条件 (なぜ提案されたか) → 実行内容 (何が起きるか・承認が必要か) の順に示し、
 * 担当者が操作を選んでから「承認して実行」する。見送りも履歴に残る。
 */
export function ProposalCard({ proposal, compact }: { proposal: AutomationProposal; compact?: boolean }) {
  const { run } = useAppData();
  const def = INVENTORY_AUTOMATIONS.find((d) => d.id === proposal.automationId);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(proposal.actions.map((a) => a.id)));
  const [open, setOpen] = useState(!compact);
  const [busy, setBusy] = useState(false);
  useEffect(() => setSelected(new Set(proposal.actions.map((a) => a.id))), [proposal.key, proposal.actions]);

  const apply = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await run((s) => s.inventory.applyProposal(proposal.automationId, proposal.key, [...selected]), (r) => `承認して実行しました（${r.results.length}件）`);
    } catch {
      /* トースト表示済み */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-navy-200 bg-white dark:border-navy-700 dark:bg-navy-900" data-testid="proposal-card" data-automation={proposal.automationId} data-proposal-title={proposal.title}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-start gap-3 p-4 text-left">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-navy-50 text-navy-700 dark:bg-navy-800 dark:text-navy-100">
          <Sparkles className="size-4" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] font-semibold text-navy-600 dark:text-navy-300">{def?.name}</span>
          <span className="block font-semibold leading-snug text-slate-800 dark:text-slate-100">{proposal.title}</span>
          <span className="block text-xs text-slate-500">
            操作 {proposal.actions.length}件（承認が必要 {proposal.actions.filter((a) => a.requiresApproval).length}件）
          </span>
        </span>
        <ChevronDown className={cx('mt-1 size-4 shrink-0 text-slate-400 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <div className="space-y-3 border-t border-slate-100 p-4 dark:border-navy-800">
          <div>
            <p className="mb-1 flex items-center gap-1 text-xs font-bold text-slate-600 dark:text-slate-300">
              <Info className="size-3.5" aria-hidden />
              実行条件（提案の根拠）
            </p>
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-slate-600 dark:text-slate-300">
              {proposal.conditions.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </div>
          {proposal.warnings.map((w) => (
            <p key={w} className="flex items-start gap-1.5 rounded-lg bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {w}
            </p>
          ))}
          <div>
            <p className="mb-1 flex items-center gap-1 text-xs font-bold text-slate-600 dark:text-slate-300">
              <Zap className="size-3.5" aria-hidden />
              実行内容（チェックした操作だけ実行）
            </p>
            <ul className="space-y-1" data-testid="proposal-actions">
              {proposal.actions.map((a) => (
                <li key={a.id}>
                  <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-1">
                    <input
                      type="checkbox"
                      className="size-5 shrink-0 accent-navy-700"
                      checked={selected.has(a.id)}
                      onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(a.id); else n.delete(a.id); return n; })}
                    />
                    <span className="min-w-0 flex-1 text-sm text-slate-700 dark:text-slate-200">{a.label}</span>
                    {a.requiresApproval ? (
                      <Badge tone="violet" icon={ShieldCheck}>
                        要承認
                      </Badge>
                    ) : (
                      <Badge icon={Cpu}>自動可</Badge>
                    )}
                  </label>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[11px] text-slate-500">「要承認」＝在庫の引当・資産の状態を変える操作。「自動可」＝タスクの作成など、取り消しやすい操作。</p>
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => run((s) => s.inventory.dismissProposal(proposal.automationId, proposal.key, proposal.title), '提案を見送りました（処理履歴に記録）').catch(() => undefined)}
            >
              見送る
            </Button>
            <Button icon={CheckCircle2} onClick={apply} loading={busy} disabled={selected.size === 0} data-testid="apply-proposal">
              {selected.size}件を承認して実行
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
