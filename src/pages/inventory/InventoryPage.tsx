/**
 * 在庫・資産・購買のメイン画面。
 * スマホでは「PC用の在庫表を縮小する」のではなく、品目ごとのカードで最重要の数 (利用可能数) を大きく見せ、
 * 頻度の高い操作 (入庫・出庫・貸出・返却) をカードから直接実行できるようにする。
 */
import { MissingTargetNotice } from '../../ui/notices';
import { useFocusHighlight, useFocusParam } from '../../app/focus';
import { useMemo, useState } from 'react';
import { AttentionSection } from '../../ui/notices';
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  BarChart3,
  Boxes,
  ChevronRight,
  ClipboardCheck,
  FilePlus2,
  Laptop,
  Package,
  Pencil,
  Plus,
  Search,
  ShoppingCart,
  Truck,
  Undo2,
  UserCheck,
  X,
} from 'lucide-react';
import { useAppData } from '../../app/AppData';
import { useQueryState } from '../../app/hooks';
import { navigate } from '../../app/router';
import { generateId } from '../../domain/id';
import { normalizeText } from '../../domain/text';
import { yen } from '../../domain/inventory/analytics';
import { ASSET_STATUSES, ASSET_STATUS_LABEL, INVENTORY_CATEGORIES, INVENTORY_CATEGORY_LABEL, PO_STATUS_LABEL, type Asset, type Item, type PurchaseOrderStatus, type Supplier } from '../../domain/inventory/types';
import { AssetStatusBadge, ShortageBadge, StockFigures } from '../../features/inventory/parts';
import { AssetFormModal, AssignSheet, ItemFormModal, QuantitySheet, ReturnSheet, SupplierFormModal, type QuantityMode } from '../../features/inventory/Sheets';
import { InventoryAnalytics } from '../../features/inventory/InventoryAnalytics';
import { Badge, Button, Card, CardHeader, EmptyState, FilterDisclosure, FilterSelect, IconButton, PageHeader, cx, type Tone } from '../../ui/primitives';

const TABS = [
  ['stock', '在庫', Boxes],
  ['assets', 'IT資産', Laptop],
  ['orders', '発注', ShoppingCart],
  ['analytics', '分析', BarChart3],
] as const;

const DEFAULTS = { tab: 'stock', q: '', category: '', state: '', astatus: '', item: '', pstatus: '' };

export function InventoryPage() {
  const { inventoryStats: st } = useAppData();
  const [f, setF] = useQueryState(DEFAULTS);
  return (
    <>
      <PageHeader title="在庫・資産・購買" description="数量の変更はすべて入出庫履歴に記録されます。発注はアプリ内の下書き・記録のみです" />
      <AttentionSection modules={['inventory']} description="下部ナビ「在庫」の件数の内訳です（在庫不足・発注書の承認待ち）" testId="inventory-attention" />
      <div className="mb-3 grid grid-cols-4 gap-1.5 sm:gap-2" data-testid="inventory-summary">
        {[
          { label: '在庫不足', value: st.shortageItems, onClick: () => setF({ tab: 'stock', state: 'shortage' }), tone: st.shortageItems ? 'text-amber-700 dark:text-amber-400' : '' },
          { label: '発注候補', value: st.openSuggestions, onClick: () => setF({ tab: 'orders' }), tone: st.openSuggestions ? 'text-violet-700 dark:text-violet-300' : '' },
          { label: '承認待ち', value: st.pendingApproval, onClick: () => setF({ tab: 'orders', pstatus: 'pending_approval' }), tone: '' },
          { label: '入荷待ち', value: st.awaitingReceipt, onClick: () => setF({ tab: 'orders', pstatus: 'open' }), tone: '' },
        ].map((k) => (
          <button key={k.label} type="button" onClick={k.onClick} className="min-h-14 rounded-xl border border-slate-200 bg-white px-2 py-1.5 text-center sm:px-3 sm:py-2 sm:text-left dark:border-navy-800 dark:bg-navy-900" data-testid={`inv-sum-${k.label}`}>
            <p className="text-[10px] font-semibold text-slate-500 sm:text-[11px]">{k.label}</p>
            <p className={cx('text-lg font-bold leading-tight tabular-nums sm:text-xl', k.tone || 'text-slate-900 dark:text-white')}>{k.value}</p>
          </button>
        ))}
      </div>
      <div className="mb-4 grid grid-cols-4 gap-1 rounded-xl bg-slate-100 p-1 dark:bg-navy-900" role="tablist">
        {TABS.map(([key, label, Icon]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={f.tab === key}
            onClick={() => setF({ tab: key })}
            className={cx('inline-flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-lg text-xs font-semibold sm:flex-row sm:gap-2 sm:text-sm', f.tab === key ? 'bg-white text-navy-900 shadow-sm dark:bg-navy-700 dark:text-white' : 'text-slate-500 dark:text-slate-400')}
          >
            <Icon className="size-4" aria-hidden />
            {label}
          </button>
        ))}
      </div>
      {f.tab === 'stock' && <StockTab f={f} setF={setF} />}
      {f.tab === 'assets' && <AssetsTab f={f} setF={setF} />}
      {f.tab === 'orders' && <OrdersTab f={f} setF={setF} />}
      {f.tab === 'analytics' && <InventoryAnalytics />}
    </>
  );
}

type TabProps = { f: typeof DEFAULTS; setF: (p: Partial<typeof DEFAULTS>) => void };

function SearchBox({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder: string; label: string }) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="h-11 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 shadow-sm focus:border-navy-500 focus:outline-none focus:ring-2 focus:ring-navy-500/25 dark:border-navy-700 dark:bg-navy-950"
      />
    </div>
  );
}

function StockTab({ f, setF }: TabProps) {
  const { data, stock } = useAppData();
  const [sheet, setSheet] = useState<{ item: Item; mode: QuantityMode } | null>(null);
  const [creating, setCreating] = useState(false);
  const list = useMemo(() => {
    const kw = normalizeText(f.q);
    return data.items
      .filter((i) => (f.state === 'inactive' ? !i.active : i.active))
      .filter((i) => !f.category || i.category === f.category)
      .filter((i) => f.state !== 'shortage' || stock.get(i.id)?.shortage)
      .filter((i) => !kw || normalizeText(`${i.code} ${i.name} ${i.maker} ${i.model}`).includes(kw))
      .sort((a, b) => Number(stock.get(b.id)?.shortage) - Number(stock.get(a.id)?.shortage) || a.code.localeCompare(b.code));
  }, [data.items, stock, f]);
  if (data.items.length === 0)
    return (
      <EmptyState
        icon={Package}
        title="品目が登録されていません"
        description="データ管理画面から在庫・資産のデモデータを追加するか、品目を登録してください"
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={() => navigate('/data')}>データ管理へ</Button>
            <Button variant="secondary" icon={Plus} onClick={() => setCreating(true)}>
              品目を登録
            </Button>
            <ItemFormModal open={creating} onClose={() => setCreating(false)} />
          </div>
        }
      />
    );
  return (
    <>
      <Card className="p-3 sm:p-4">
        <div className="grid grid-cols-[1fr_auto] gap-2 md:grid-cols-[1fr_10rem_10rem]">
          <SearchBox value={f.q} onChange={(q) => setF({ q })} placeholder="品目名・品目ID・型番で検索" label="品目を検索" />
          <FilterDisclosure activeCount={[f.category, f.state].filter(Boolean).length} className="col-span-2">
            <FilterSelect label="カテゴリ" value={f.category} onChange={(v) => setF({ category: v })} options={[{ value: '', label: '全カテゴリ' }, ...INVENTORY_CATEGORIES.map((c) => ({ value: c, label: INVENTORY_CATEGORY_LABEL[c] }))]} />
            <FilterSelect
              label="状態"
              value={f.state}
              onChange={(v) => setF({ state: v })}
              options={[
                { value: '', label: '有効な品目' },
                { value: 'shortage', label: '在庫不足のみ' },
                { value: 'inactive', label: '無効な品目' },
              ]}
            />
          </FilterDisclosure>
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-slate-500">
          <span data-testid="item-count">{list.length}品目</span>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" icon={ClipboardCheck} onClick={() => navigate('/inventory/stocktake')}>
              棚卸
            </Button>
            <Button size="sm" variant="secondary" icon={Plus} onClick={() => setCreating(true)}>
              品目を登録
            </Button>
          </div>
        </div>
      </Card>
      {list.length === 0 ? (
        <Card className="mt-3">
          <EmptyState icon={Package} title="該当する品目はありません" action={<Button variant="secondary" onClick={() => setF({ q: '', category: '', state: '' })}>条件をクリア</Button>} />
        </Card>
      ) : (
        <ul className="mt-3 grid gap-3 md:grid-cols-2" data-testid="item-list">
          {list.map((i) => {
            const s = stock.get(i.id)!;
            return (
              <li key={i.id} className={cx('rounded-2xl border bg-white p-4 dark:bg-navy-900', s.shortage ? 'border-amber-300 dark:border-amber-800' : 'border-slate-200/80 dark:border-navy-800')} data-item-name={i.name}>
                <a href={`#/inventory/items/${i.id}`} className="block">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[11px] text-slate-400">{i.code}</span>
                    <Badge>{INVENTORY_CATEGORY_LABEL[i.category]}</Badge>
                    {i.tracking === 'asset' && <Badge tone="navy">1台ずつ管理</Badge>}
                    <ShortageBadge s={s} />
                  </div>
                  <p className="mt-1 font-semibold text-slate-800 dark:text-slate-100">{i.name}</p>
                  <div className="mt-2">
                    <StockFigures item={i} s={s} compact />
                  </div>
                </a>
                {i.active && (
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    {i.tracking === 'quantity' ? (
                      <>
                        <Button size="sm" variant="secondary" icon={ArrowDownToLine} onClick={() => setSheet({ item: i, mode: 'receive' })} aria-label={`${i.name}を入庫`}>
                          入庫
                        </Button>
                        <Button size="sm" variant="secondary" icon={ArrowUpFromLine} onClick={() => setSheet({ item: i, mode: 'issue' })} disabled={s.available <= 0} aria-label={`${i.name}を出庫`}>
                          出庫
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" variant="secondary" icon={Laptop} className="col-span-2" onClick={() => setF({ tab: 'assets', item: i.id, astatus: 'unused' })}>
                        未使用の{i.name}を見る（{s.available}台）
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <QuantitySheet item={sheet?.item ?? null} mode={sheet?.mode ?? 'receive'} onClose={() => setSheet(null)} />
      <ItemFormModal open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function AssetsTab({ f, setF }: TabProps) {
  const { data } = useAppData();
  const [assign, setAssign] = useState<Asset | null>(null);
  const [ret, setRet] = useState<Asset | null>(null);
  const [creating, setCreating] = useState(false);
  const list = useMemo(() => {
    const kw = normalizeText(f.q);
    return data.assets
      .filter((a) => (f.astatus ? a.status === f.astatus : a.status !== 'disposed'))
      .filter((a) => !f.item || a.itemId === f.item)
      .filter((a) => !f.category || a.category === f.category)
      .filter((a) => !kw || normalizeText(`${a.assetNumber} ${a.name} ${a.serialNumber} ${a.assigneeName} ${a.model}`).includes(kw));
  }, [data.assets, f]);
  const itemName = f.item ? data.items.find((i) => i.id === f.item)?.name : undefined;
  return (
    <>
      <Card className="p-3 sm:p-4">
        <div className="grid grid-cols-[1fr_auto] gap-2 md:grid-cols-[1fr_10rem_10rem]">
          <SearchBox value={f.q} onChange={(q) => setF({ q })} placeholder="資産番号・利用者・シリアルで検索" label="資産を検索" />
          <FilterDisclosure activeCount={[f.astatus, f.category].filter(Boolean).length} className="col-span-2">
            <FilterSelect label="使用状況" value={f.astatus} onChange={(v) => setF({ astatus: v })} options={[{ value: '', label: '廃棄済み以外' }, ...ASSET_STATUSES.map((s) => ({ value: s, label: ASSET_STATUS_LABEL[s] }))]} />
            <FilterSelect label="カテゴリ" value={f.category} onChange={(v) => setF({ category: v })} options={[{ value: '', label: '全カテゴリ' }, ...INVENTORY_CATEGORIES.map((c) => ({ value: c, label: INVENTORY_CATEGORY_LABEL[c] }))]} />
          </FilterDisclosure>
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-slate-500">
          <span data-testid="asset-count">
            {itemName && (
              <button type="button" className="mr-2 inline-flex min-h-8 items-center gap-1 rounded-full bg-navy-50 px-2 font-semibold text-navy-700 dark:bg-navy-800 dark:text-navy-100" onClick={() => setF({ item: '' })}>
                {itemName}
                <X className="size-3" aria-label="絞り込みを解除" />
              </button>
            )}
            {list.length}台
          </span>
          <Button size="sm" variant="secondary" icon={Plus} onClick={() => setCreating(true)}>
            資産を登録
          </Button>
        </div>
      </Card>
      <Card className="mt-3 overflow-hidden">
        {list.length === 0 ? (
          <EmptyState icon={Laptop} title="該当する資産はありません" />
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-navy-800" data-testid="asset-list">
            {list.map((a) => (
              <li key={a.id} className="flex items-center gap-2 px-4 py-3 sm:px-5" data-asset-number={a.assetNumber}>
                <a href={`#/inventory/assets/${a.id}`} className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-xs font-semibold text-slate-600 dark:text-slate-300">{a.assetNumber}</span>
                    <AssetStatusBadge status={a.status} />
                  </div>
                  <p className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{a.name}</p>
                  <p className="truncate text-xs text-slate-500">
                    {a.assigneeName ? `${a.assigneeName}${a.status === 'reserved' ? '（予約）' : ''}` : (data.locations.find((l) => l.id === a.locationId)?.name ?? '保管場所未設定')}
                    {a.serialNumber && `・S/N ${a.serialNumber}`}
                  </p>
                </a>
                {(a.status === 'unused' || a.status === 'reserved') && (
                  <Button size="sm" variant="secondary" icon={UserCheck} onClick={() => setAssign(a)} aria-label={`${a.assetNumber}を貸出`}>
                    貸出
                  </Button>
                )}
                {a.status === 'in_use' && (
                  <Button size="sm" variant="secondary" icon={Undo2} onClick={() => setRet(a)} aria-label={`${a.assetNumber}を返却`}>
                    返却
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <AssignSheet asset={assign} onClose={() => setAssign(null)} />
      <ReturnSheet asset={ret} onClose={() => setRet(null)} />
      <AssetFormModal open={creating} onClose={() => setCreating(false)} defaultItemId={f.item || undefined} />
    </>
  );
}

const PO_TONE: Record<PurchaseOrderStatus, Tone> = { draft: 'gray', pending_approval: 'amber', approved: 'blue', partially_received: 'violet', received: 'green', cancelled: 'gray' };
export function PoStatusBadge({ status }: { status: PurchaseOrderStatus }) {
  return <Badge tone={PO_TONE[status]}>{PO_STATUS_LABEL[status]}</Badge>;
}

function OrdersTab({ f, setF }: TabProps) {
  const { data, run } = useAppData();
  const open = data.purchaseSuggestions.filter((s) => s.status === 'open');
  // 在庫不足の通知から来た場合 (focus=sug:ID) は、その発注候補だけを選んだ状態で強調表示する
  const focusId = useFocusParam();
  const focusSug = focusId?.startsWith('sug:') ? open.find((s) => `sug:${s.id}` === focusId) : undefined;
  const [selected, setSelected] = useState<Set<string>>(() => new Set(focusSug ? [focusSug.id] : open.map((s) => s.id)));
  const sugFocus = useFocusHighlight(focusId?.startsWith('sug:') ? focusId : null);
  const [busy, setBusy] = useState(false);
  const [requestedBy, setRequestedBy] = useState('加藤 由美');
  const [supplierEdit, setSupplierEdit] = useState<Supplier | 'new' | null>(null);
  const [requestId, setRequestId] = useState(() => generateId('req'));
  const itemById = new Map(data.items.map((i) => [i.id, i]));
  const supById = new Map(data.suppliers.map((s) => [s.id, s]));
  const orders = data.purchaseOrders.filter((p) => (f.pstatus === 'open' ? p.status === 'approved' || p.status === 'partially_received' : f.pstatus ? p.status === f.pstatus : true));

  const createOrders = async () => {
    setBusy(true);
    try {
      const r = await run((s) => s.inventory.createOrdersFromSuggestions([...selected].filter((id) => open.some((o) => o.id === id)), requestedBy, requestId), (r) => (r.duplicated ? '作成済みです（二重作成を防止しました）' : `発注書（下書き）を${r.value.length}件作成しました`));
      setRequestId(generateId('req'));
      if (!r.duplicated && r.value.length === 1) navigate(`/inventory/orders/${r.value[0]!.id}`);
    } catch {
      /* トースト表示済み */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {sugFocus === 'missing' && <MissingTargetNotice what="発注候補">発注書の作成済み・在庫の回復で候補がなくなった可能性があります。</MissingTargetNotice>}
      <Card>
        <CardHeader title="発注候補（自動作成・下書き）" icon={FilePlus2} description="在庫不足から自動で作成された候補です。発注書を作るまで確定ではありません" />
        <div className="p-4 sm:p-5">
          {open.length === 0 ? (
            <p className="text-sm text-slate-500">発注候補はありません。在庫が最低在庫数を下回ると自動で作成されます。</p>
          ) : (
            <>
              <ul className="space-y-2" data-testid="suggestion-list">
                {open.map((s) => {
                  const item = itemById.get(s.itemId);
                  return (
                    <li key={s.id} className="rounded-xl border border-violet-200 bg-violet-50/40 p-3 dark:border-violet-900 dark:bg-violet-950/20" data-suggestion-item={item?.name} data-focus-id={`sug:${s.id}`}>
                      <label className="flex cursor-pointer items-start gap-3">
                        <input type="checkbox" className="mt-1 size-5 shrink-0 accent-navy-700" checked={selected.has(s.id)} onChange={(e) => setSelected((x) => { const n = new Set(x); if (e.target.checked) n.add(s.id); else n.delete(s.id); return n; })} aria-label={`${item?.name}を発注書に含める`} />
                        <span className="min-w-0 flex-1">
                          <span className="block font-semibold">
                            {item?.name}
                            <span className="ml-2 text-sm font-bold tabular-nums text-violet-800 dark:text-violet-300">
                              推奨 {s.quantity}
                              {item?.unit}
                            </span>
                          </span>
                          <span className="block text-xs text-slate-500">
                            概算 {yen((item?.unitPrice ?? 0) * s.quantity)}（参考単価 × 数量）・仕入先 {supById.get(item?.defaultSupplierId ?? '')?.name ?? '未設定'}
                          </span>
                          <details className="mt-1 text-xs text-slate-600 dark:text-slate-300">
                            <summary className="min-h-8 cursor-pointer font-semibold">判定の根拠</summary>
                            <ul className="list-disc pl-5">
                              {s.reasons.map((r, i) => (
                                <li key={i}>{r}</li>
                              ))}
                            </ul>
                          </details>
                        </span>
                      </label>
                      <div className="mt-1 text-right">
                        <button type="button" className="min-h-9 px-2 text-xs font-semibold text-slate-500 underline" onClick={() => run((sv) => sv.inventory.dismissSuggestion(s.id), '発注候補を見送りました').catch(() => undefined)}>
                          今回は見送る
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
                <label className="flex-1 text-xs text-slate-500">
                  依頼者
                  <input value={requestedBy} onChange={(e) => setRequestedBy(e.target.value)} className="mt-0.5 block h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-slate-800 dark:border-navy-700 dark:bg-navy-950 dark:text-slate-100" />
                </label>
                <Button icon={FilePlus2} onClick={createOrders} loading={busy} disabled={selected.size === 0} data-testid="create-orders">
                  選択した{[...selected].filter((id) => open.some((o) => o.id === id)).length}件で発注書（下書き）を作成
                </Button>
              </div>
              <p className="mt-2 text-[11px] text-slate-500">仕入先ごとに1通の発注依頼書にまとめます。外部への発注・送信は行いません。</p>
            </>
          )}
        </div>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader
          title="発注書"
          icon={Truck}
          action={
            <FilterSelect
              label="発注書の状態"
              value={f.pstatus}
              onChange={(v) => setF({ pstatus: v })}
              className="w-36"
              options={[
                { value: '', label: 'すべて' },
                { value: 'draft', label: '下書き' },
                { value: 'pending_approval', label: '承認待ち' },
                { value: 'open', label: '入荷待ち' },
                { value: 'received', label: '入荷完了' },
                { value: 'cancelled', label: '取消' },
              ]}
            />
          }
        />
        {orders.length === 0 ? (
          <p className="px-5 pb-5 pt-2 text-sm text-slate-500">該当する発注書はありません。</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-100 border-t border-slate-100 dark:divide-navy-800 dark:border-navy-800" data-testid="order-list">
            {orders.map((po) => (
              <li key={po.id}>
                <a href={`#/inventory/orders/${po.id}`} className="flex items-center gap-3 px-4 py-3 active:bg-slate-50 sm:px-5 dark:active:bg-navy-800">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-xs font-semibold">{po.number}</span>
                      <PoStatusBadge status={po.status} />
                    </div>
                    <p className="truncate text-sm">{po.lines.map((l) => `${itemById.get(l.itemId)?.name ?? ''} ×${l.quantity}`).join('、')}</p>
                    <p className="text-xs text-slate-500">
                      {supById.get(po.supplierId)?.name}・{yen(po.lines.reduce((a, l) => a + l.quantity * l.unitPrice, 0))}
                      {po.expectedDate && po.status !== 'received' && po.status !== 'cancelled' && `・入荷予定 ${po.expectedDate}`}
                    </p>
                  </div>
                  <ChevronRight className="size-4 text-slate-300" aria-hidden />
                </a>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="overflow-hidden">
        <CardHeader
          title="仕入先マスタ"
          icon={Truck}
          description="架空の仕入先です。連絡・発注はアプリ外で行います"
          action={
            <Button size="sm" variant="secondary" icon={Plus} onClick={() => setSupplierEdit('new')}>
              追加
            </Button>
          }
        />
        <ul className="mt-2 divide-y divide-slate-100 border-t border-slate-100 dark:divide-navy-800 dark:border-navy-800">
          {data.suppliers.map((s) => (
            <li key={s.id} className={cx('flex items-center gap-2 px-4 py-2 sm:px-5', !s.active && 'opacity-60')}>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{s.name}</p>
                <p className="text-xs text-slate-500">標準納期 {s.leadTimeDays}日{!s.active && '・取引停止'}</p>
              </div>
              <IconButton icon={Pencil} label={`${s.name}を編集`} onClick={() => setSupplierEdit(s)} />
            </li>
          ))}
        </ul>
      </Card>
      <SupplierFormModal open={!!supplierEdit} onClose={() => setSupplierEdit(null)} supplier={supplierEdit && supplierEdit !== 'new' ? supplierEdit : undefined} />
      {open.length > 0 && data.items.some((i) => i.active && !i.defaultSupplierId) && (
        <p className="flex items-center gap-1 text-xs text-amber-700">
          <AlertTriangle className="size-3.5" />
          既定の仕入先が未設定の品目があります（最初の取引中の仕入先にまとめられます）
        </p>
      )}
    </div>
  );
}
