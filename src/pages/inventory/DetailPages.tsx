/**
 * 在庫の詳細画面: 品目詳細 / 資産詳細 / 発注書詳細 / 棚卸。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRightLeft,
  ArrowUpFromLine,
  Ban,
  CheckCircle2,
  ClipboardCheck,
  FileQuestion,
  History,
  Info,
  PackageCheck,
  Pencil,
  Printer,
  Send,
  SlidersHorizontal,
  Trash2,
  Undo2,
  UserCheck,
} from 'lucide-react';
import { useAppData } from '../../app/AppData';
import { clearDraft, useDraft } from '../../app/hooks';
import { navigate } from '../../app/router';
import { formatDateJa, formatDateTimeJa } from '../../domain/date';
import { generateId } from '../../domain/id';
import { yen } from '../../domain/inventory/analytics';
import { ASSET_EVENT_LABEL, ASSET_STATUS_LABEL, INVENTORY_CATEGORY_LABEL, MOVEMENT_TYPE_LABEL, RESERVATION_STATUS_LABEL, type AssetStatus, type Item } from '../../domain/inventory/types';
import { AssetStatusBadge, ShortageBadge, StockFigures, Stepper } from '../../features/inventory/parts';
import { AssetFormModal, AssignSheet, ItemFormModal, QuantitySheet, ReturnSheet, type QuantityMode } from '../../features/inventory/Sheets';
import { ConfirmDialog } from '../../ui/Modal';
import { Badge, Button, Card, CardHeader, EmptyState, PageHeader, SelectField, TextField, cx } from '../../ui/primitives';
import { PoStatusBadge } from './InventoryPage';

function Back({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} className="-ml-2 mb-3 inline-flex min-h-10 items-center gap-1 rounded-lg px-2 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
      <ArrowLeft className="size-4" aria-hidden />
      {label}
    </a>
  );
}

// ============================ 品目詳細 ============================

export function ItemDetailPage({ itemId }: { itemId: string }) {
  const { data, stock, run, empById } = useAppData();
  const item = data.items.find((i) => i.id === itemId);
  const [sheet, setSheet] = useState<QuantityMode | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [fulfillLoc, setFulfillLoc] = useState('');
  if (!item) return <EmptyState icon={FileQuestion} title="品目が見つかりません" action={<Button onClick={() => navigate('/inventory')}>在庫一覧へ</Button>} />;
  const s = stock.get(item.id)!;
  const movements = data.stockMovements.filter((m) => m.itemId === item.id).slice(0, 40);
  const reservations = data.reservations.filter((r) => r.itemId === item.id && (r.status === 'active' || r.status === 'backorder'));
  const suggestion = data.purchaseSuggestions.find((x) => x.itemId === item.id && x.status === 'open');
  const locName = (id: string | null) => data.locations.find((l) => l.id === id)?.name ?? '不明';
  const supplier = data.suppliers.find((x) => x.id === item.defaultSupplierId);
  const locWithStock = s.byLocation.filter((l) => l.quantity > 0);

  return (
    <>
      <Back href="#/inventory" label="在庫一覧" />
      <Card className="p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-xs text-slate-500">{item.code}</span>
          <Badge>{INVENTORY_CATEGORY_LABEL[item.category]}</Badge>
          {item.tracking === 'asset' && <Badge tone="navy">1台ずつ管理</Badge>}
          {!item.active && <Badge tone="gray">無効</Badge>}
          <ShortageBadge s={s} />
        </div>
        <h1 className="mt-1 text-xl font-bold sm:text-2xl">{item.name}</h1>
        <p className="text-sm text-slate-500">
          {[item.maker, item.model].filter(Boolean).join('・')}・参考単価 {yen(item.unitPrice)}／{item.unit}
        </p>
        <div className="mt-4">
          <StockFigures item={item} s={s} />
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          {[
            ['最低在庫数（発注点）', `${item.minStock}${item.unit}`],
            ['適正在庫数', `${item.targetStock}${item.unit}`],
            ['見込み在庫', `${s.projected}${item.unit}`],
            ['既定の仕入先', supplier?.name ?? '未設定'],
          ].map(([k, v]) => (
            <div key={k} className="rounded-lg bg-slate-50 px-3 py-2 dark:bg-navy-950">
              <dt className="text-[11px] text-slate-500">{k}</dt>
              <dd className="font-semibold">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 flex items-start gap-1 text-[11px] text-slate-500">
          <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
          見込み在庫 = 利用可能 {s.available} − 入荷待ち需要 {s.backorder} + 発注残 {s.onOrder}。これが最低在庫数を下回ると発注候補を自動作成します。
        </p>
        {item.active && (
          <div className="mt-4 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            {item.tracking === 'quantity' ? (
              <>
                <Button icon={ArrowDownToLine} onClick={() => setSheet('receive')}>
                  入庫
                </Button>
                <Button variant="secondary" icon={ArrowUpFromLine} onClick={() => setSheet('issue')} disabled={s.available <= 0}>
                  出庫
                </Button>
                <Button variant="secondary" icon={ArrowRightLeft} onClick={() => setSheet('transfer')} disabled={s.onHand <= 0}>
                  移動
                </Button>
                <Button variant="secondary" icon={SlidersHorizontal} onClick={() => setSheet('adjust')}>
                  在庫調整
                </Button>
              </>
            ) : (
              <Button className="col-span-2" onClick={() => navigate(`/inventory?tab=assets&item=${item.id}`)}>
                この機種の資産を見る
              </Button>
            )}
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3 dark:border-navy-800">
          <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(true)}>
            編集
          </Button>
          {item.active ? (
            <Button size="sm" variant="ghost" icon={Trash2} className="text-red-600 dark:text-red-400" onClick={() => setConfirmRemove(true)}>
              削除・無効化
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => run((sv) => sv.inventory.setItemActive(item.id, true), '品目を有効にしました').catch(() => undefined)}>
              有効に戻す
            </Button>
          )}
        </div>
      </Card>

      {suggestion && (
        <a href="#/inventory?tab=orders" className="mt-4 flex items-center gap-2 rounded-2xl border border-violet-200 bg-violet-50 p-4 text-sm dark:border-violet-900 dark:bg-violet-950/30">
          <PackageCheck className="size-5 shrink-0 text-violet-700" aria-hidden />
          <span className="flex-1">
            発注候補があります：推奨 <strong>{suggestion.quantity}{item.unit}</strong>（発注タブで発注書を作成）
          </span>
        </a>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="保管場所別の在庫" icon={PackageCheck} />
          <ul className="px-4 pb-4 pt-2 text-sm sm:px-5">
            {s.byLocation.length === 0 ? (
              <li className="text-slate-500">在庫はありません。</li>
            ) : (
              s.byLocation.map((l) => (
                <li key={l.locationId} className="flex justify-between border-b border-slate-100 py-2 last:border-0 dark:border-navy-800">
                  <span>{locName(l.locationId)}</span>
                  <span className="font-semibold tabular-nums">
                    {l.quantity}
                    {item.unit}
                  </span>
                </li>
              ))
            )}
          </ul>
        </Card>
        <Card>
          <CardHeader title="予約・入荷待ち" icon={UserCheck} description="社員・問い合わせに引き当てた数量" />
          <div className="px-4 pb-4 pt-2 sm:px-5">
            {reservations.length === 0 ? (
              <p className="text-sm text-slate-500">予約はありません。</p>
            ) : (
              <>
                {item.tracking === 'quantity' && reservations.some((r) => r.status === 'active') && (
                  <SelectField label="引き渡し元の保管場所" value={fulfillLoc || locWithStock[0]?.locationId || ''} onChange={(e) => setFulfillLoc(e.target.value)} options={locWithStock.map((l) => ({ value: l.locationId, label: `${locName(l.locationId)}（${l.quantity}）` }))} wrapClassName="mb-2" />
                )}
                <ul className="divide-y divide-slate-100 dark:divide-navy-800" data-testid="reservation-list">
                  {reservations.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                      <span className="min-w-0 flex-1">
                        {r.purpose}
                        <span className="ml-1 font-semibold tabular-nums">
                          {r.quantity}
                          {item.unit}
                        </span>
                        <Badge tone={r.status === 'backorder' ? 'violet' : 'blue'} className="ml-2">
                          {RESERVATION_STATUS_LABEL[r.status]}
                        </Badge>
                        {r.employeeId && empById.get(r.employeeId) && (
                          <a href={`#/employees/${r.employeeId}`} className="ml-2 text-xs text-navy-600 underline dark:text-navy-300">
                            社員
                          </a>
                        )}
                      </span>
                      {r.status === 'active' && item.tracking === 'quantity' && (
                        <Button size="sm" variant="secondary" onClick={() => run((sv) => sv.inventory.fulfillReservation(r.id, fulfillLoc || locWithStock[0]?.locationId || '', generateId('req')), '引き渡しを記録しました（出庫）').catch(() => undefined)}>
                          引き渡し
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => run((sv) => sv.inventory.releaseReservation(r.id), '予約を解除しました', { undo: (x) => (sv) => sv.inventory.restoreReservation(x) }).catch(() => undefined)}>
                        解除
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </Card>
      </div>

      {item.tracking === 'quantity' && (
        <Card className="mt-4">
          <CardHeader title="入出庫履歴" icon={History} description="数量の変更はすべてここに記録され、削除・変更できません" />
          <div className="px-2 pb-3 pt-2 sm:px-3">
            {movements.length === 0 ? (
              <p className="px-3 py-2 text-sm text-slate-500">履歴はありません。</p>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-navy-800" data-testid="movement-list">
                {movements.map((m) => (
                  <li key={m.id} className="grid grid-cols-[1fr_auto] gap-x-3 px-3 py-2 text-sm">
                    <span className="min-w-0">
                      <Badge tone={m.delta > 0 ? 'green' : m.delta < 0 ? 'blue' : 'gray'}>{MOVEMENT_TYPE_LABEL[m.type]}</Badge>
                      <span className="ml-2">{m.reason}</span>
                      <span className="block text-[11px] text-slate-400">
                        {formatDateTimeJa(m.at)}・{locName(m.locationId)}
                        {m.toLocationId && ` → ${locName(m.toLocationId)}`}
                        {m.employeeId && empById.get(m.employeeId) && `・${empById.get(m.employeeId)!.name}`}
                        {m.refType === 'purchase_order' && m.refId && (
                          <a href={`#/inventory/orders/${m.refId}`} className="ml-1 text-navy-600 underline dark:text-navy-300">
                            発注書
                          </a>
                        )}
                      </span>
                    </span>
                    <span className="text-right tabular-nums">
                      <span className={cx('font-semibold', m.delta > 0 ? 'text-emerald-700 dark:text-emerald-400' : m.delta < 0 ? 'text-blue-700 dark:text-blue-300' : '')}>
                        {m.type === 'transfer' ? `${m.quantity}移動` : `${m.delta > 0 ? '+' : ''}${m.delta}`}
                      </span>
                      <span className="block text-[11px] text-slate-400">残 {m.balanceAfter}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      )}

      <QuantitySheet item={sheet ? item : null} mode={sheet ?? 'receive'} onClose={() => setSheet(null)} />
      <ItemFormModal open={editing} onClose={() => setEditing(false)} item={item} />
      <ConfirmDialog
        open={confirmRemove}
        danger
        title="品目を削除・無効化しますか？"
        confirmLabel="実行する"
        message="入出庫・資産・発注の履歴がある品目は削除せず「無効」にし、履歴は残します。在庫が残っている品目は処理できません。"
        onConfirm={() => run((sv) => sv.inventory.removeItem(item.id), (r) => (r === 'deleted' ? '品目を削除しました' : '品目を無効にしました（履歴は保持）')).then((r) => r === 'deleted' && navigate('/inventory'))}
        onClose={() => setConfirmRemove(false)}
      />
    </>
  );
}

// ============================ 資産詳細 ============================

const NEXT_STATUS: Partial<Record<AssetStatus, AssetStatus[]>> = {
  unused: ['repair', 'broken', 'disposal_planned'],
  in_use: ['repair', 'broken'],
  repair: ['unused', 'broken', 'disposal_planned'],
  broken: ['repair', 'disposal_planned'],
  disposal_planned: ['disposed', 'unused'],
};

export function AssetDetailPage({ assetId }: { assetId: string }) {
  const { data, run, empById, deptById } = useAppData();
  const asset = data.assets.find((a) => a.id === assetId);
  const [assign, setAssign] = useState(false);
  const [ret, setRet] = useState(false);
  const [edit, setEdit] = useState(false);
  const [statusTo, setStatusTo] = useState('');
  const [note, setNote] = useState('');
  if (!asset) return <EmptyState icon={FileQuestion} title="資産が見つかりません" action={<Button onClick={() => navigate('/inventory?tab=assets')}>資産一覧へ</Button>} />;
  const events = data.assetEvents.filter((e) => e.assetId === asset.id);
  const tasks = data.tasks.filter((t) => t.assetId === asset.id);
  const inquiryIds = [...new Set(events.map((e) => e.inquiryId).filter((x): x is string => !!x))];
  const inquiries = data.inquiries.filter((i) => inquiryIds.includes(i.id));
  const po = data.purchaseOrders.find((p) => p.id === asset.purchaseOrderId);
  const rows: [string, ReactNode][] = [
    ['機種', asset.itemId ? <a href={`#/inventory/items/${asset.itemId}`} className="text-navy-600 underline dark:text-navy-300">{data.items.find((i) => i.id === asset.itemId)?.name}</a> : '（未設定）'],
    ['メーカー・型番', [asset.maker, asset.model].filter(Boolean).join('・') || '—'],
    ['シリアル番号', asset.serialNumber || '未登録'],
    ['購入日', formatDateJa(asset.purchaseDate)],
    ['購入金額（取得原価）', asset.purchaseCost !== null ? yen(asset.purchaseCost) : '—'],
    ['保証期限', formatDateJa(asset.warrantyUntil)],
    ['利用者', asset.assigneeId && empById.get(asset.assigneeId) ? <a href={`#/employees/${asset.assigneeId}`} className="text-navy-600 underline dark:text-navy-300">{asset.assigneeName}</a> : asset.assigneeName || '—'],
    ['所属部署', asset.departmentId ? (deptById.get(asset.departmentId)?.name ?? '—') : '—'],
    ['保管場所', data.locations.find((l) => l.id === asset.locationId)?.name ?? '—'],
    ['発注書', po ? <a href={`#/inventory/orders/${po.id}`} className="text-navy-600 underline dark:text-navy-300">{po.number}</a> : '—'],
  ];
  return (
    <>
      <Back href="#/inventory?tab=assets" label="資産一覧" />
      <Card className="p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-semibold" data-testid="asset-number">
            {asset.assetNumber}
          </span>
          <AssetStatusBadge status={asset.status} />
        </div>
        <h1 className="mt-1 text-xl font-bold sm:text-2xl">{asset.name}</h1>
        <dl className="mt-4 grid grid-cols-1 gap-x-6 sm:grid-cols-2">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 border-b border-slate-100 py-2 text-sm dark:border-navy-800">
              <dt className="shrink-0 text-slate-500">{k}</dt>
              <dd className="text-right font-medium">{v}</dd>
            </div>
          ))}
        </dl>
        {asset.notes && <p className="mt-3 rounded-lg bg-slate-50 p-3 text-sm dark:bg-navy-950">{asset.notes}</p>}
        <div className="mt-4 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          {(asset.status === 'unused' || asset.status === 'reserved') && (
            <Button icon={UserCheck} onClick={() => setAssign(true)}>
              {asset.status === 'reserved' ? '引き渡し（貸出）' : '貸出'}
            </Button>
          )}
          {(asset.status === 'in_use' || asset.status === 'reserved') && (
            <Button variant="secondary" icon={Undo2} onClick={() => setRet(true)}>
              {asset.status === 'reserved' ? '予約解除' : '返却'}
            </Button>
          )}
          <Button variant="secondary" icon={Pencil} onClick={() => setEdit(true)} disabled={asset.status === 'disposed'}>
            編集
          </Button>
        </div>
        {NEXT_STATUS[asset.status] && (
          <div className="mt-4 rounded-xl border border-slate-200 p-3 dark:border-navy-800">
            <p className="mb-2 text-xs font-semibold text-slate-500">状態の変更（履歴に記録されます）</p>
            <div className="grid gap-2 sm:grid-cols-[12rem_1fr_auto]">
              <select aria-label="変更後の状態" value={statusTo} onChange={(e) => setStatusTo(e.target.value)} className="h-11 rounded-lg border border-slate-300 bg-white px-3 dark:border-navy-700 dark:bg-navy-950">
                <option value="">状態を選択</option>
                {NEXT_STATUS[asset.status]!.map((s) => (
                  <option key={s} value={s}>
                    {ASSET_STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
              <input aria-label="変更理由" value={note} onChange={(e) => setNote(e.target.value)} placeholder="理由（例：画面割れのため修理へ）" className="h-11 rounded-lg border border-slate-300 bg-white px-3 dark:border-navy-700 dark:bg-navy-950" />
              <Button
                variant="secondary"
                disabled={!statusTo}
                onClick={() =>
                  run((s) => s.inventory.setAssetStatus(asset.id, statusTo as AssetStatus, note), `「${ASSET_STATUS_LABEL[statusTo as AssetStatus]}」にしました`)
                    .then(() => {
                      setStatusTo('');
                      setNote('');
                    })
                    .catch(() => undefined)
                }
              >
                変更
              </Button>
            </div>
            {asset.status === 'in_use' && <p className="mt-1 text-[11px] text-slate-500">使用中の機器を廃棄する場合は、先に返却してください。</p>}
          </div>
        )}
      </Card>

      {(inquiries.length > 0 || tasks.length > 0) && (
        <Card className="mt-4">
          <CardHeader title="関連する問い合わせ・タスク" icon={Info} />
          <ul className="px-4 pb-4 pt-2 text-sm sm:px-5">
            {inquiries.map((i) => (
              <li key={i.id} className="py-1.5">
                <a href={`#/helpdesk/${i.id}`} className="text-navy-600 underline dark:text-navy-300">
                  {i.number}　{i.title}
                </a>
              </li>
            ))}
            {tasks.map((t) => (
              <li key={t.id} className="flex items-center gap-2 py-1.5">
                <a href={`#/tasks?focus=${t.id}`} className="text-navy-600 underline dark:text-navy-300">
                  {t.title}
                </a>
                <Badge tone={t.status === 'done' ? 'green' : 'gray'}>{t.status === 'done' ? '完了' : '未完了'}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="mt-4">
        <CardHeader title="貸出・返却・状態の履歴" icon={History} description="追記のみ（削除・変更できません）" />
        <ol className="relative mx-4 mb-4 mt-3 space-y-3 border-l border-slate-200 pl-5 sm:mx-5 dark:border-navy-700" data-testid="asset-events">
          {events.map((e) => (
            <li key={e.id} className="relative">
              <span className="absolute -left-[26px] top-1 size-2.5 rounded-full bg-navy-400" aria-hidden />
              <p className="text-sm">
                <strong>{ASSET_EVENT_LABEL[e.type]}</strong>
                {e.fromStatus && e.fromStatus !== e.toStatus && (
                  <span className="text-slate-500">
                    （{ASSET_STATUS_LABEL[e.fromStatus]} → {ASSET_STATUS_LABEL[e.toStatus]}）
                  </span>
                )}
                {e.employeeName && `・${e.employeeName}`}
              </p>
              <p className="text-xs text-slate-500">{e.note}</p>
              <p className="text-[11px] text-slate-400">
                {formatDateTimeJa(e.at)}
                {e.inquiryId && (
                  <a href={`#/helpdesk/${e.inquiryId}`} className="ml-2 font-semibold text-navy-600 dark:text-navy-300">
                    問い合わせ
                  </a>
                )}
              </p>
            </li>
          ))}
        </ol>
      </Card>
      {assign && <AssignSheet asset={asset} onClose={() => setAssign(false)} />}
      {ret && <ReturnSheet asset={asset} onClose={() => setRet(false)} />}
      <AssetFormModal open={edit} onClose={() => setEdit(false)} asset={asset} />
    </>
  );
}

// ============================ 発注書詳細 ============================

export function OrderDetailPage({ orderId }: { orderId: string }) {
  const { data, run } = useAppData();
  const po = data.purchaseOrders.find((p) => p.id === orderId);
  const [actor, setActor] = useState('');
  const [receive, setReceive] = useState<Record<string, number>>({});
  const [loc, setLoc] = useState('');
  const [draftLines, setDraftLines] = useState<Record<string, { quantity: number; unitPrice: number }>>({});
  const [expected, setExpected] = useState('');
  const [requestId, setRequestId] = useState(() => generateId('req'));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!po) return;
    setReceive(Object.fromEntries(po.lines.map((l) => [l.id, l.quantity - l.receivedQuantity])));
    setDraftLines(Object.fromEntries(po.lines.map((l) => [l.id, { quantity: l.quantity, unitPrice: l.unitPrice }])));
    setExpected(po.expectedDate ?? '');
    setLoc((cur) => cur || data.items.find((i) => i.id === po.lines[0]?.itemId)?.defaultLocationId || data.locations[0]?.id || '');
  }, [po, data.items, data.locations]);
  if (!po) return <EmptyState icon={FileQuestion} title="発注書が見つかりません" action={<Button onClick={() => navigate('/inventory?tab=orders')}>発注一覧へ</Button>} />;
  const supplier = data.suppliers.find((s) => s.id === po.supplierId);
  const itemById = new Map(data.items.map((i) => [i.id, i]));
  const total = po.lines.reduce((a, l) => a + (draftLines[l.id]?.quantity ?? l.quantity) * (draftLines[l.id]?.unitPrice ?? l.unitPrice), 0);
  const act = async (action: 'submit' | 'approve' | 'reject' | 'cancel', label: string) => {
    setBusy(true);
    try {
      await run((s) => s.inventory.transitionOrder(po.id, action, actor), label);
    } catch {
      /* トースト表示済み */
    } finally {
      setBusy(false);
    }
  };
  const doReceive = async () => {
    setBusy(true);
    try {
      await run(
        (s) => s.inventory.receiveOrder(po.id, po.lines.map((l) => ({ lineId: l.id, quantity: receive[l.id] ?? 0, locationId: loc })), requestId),
        (r) => (r.duplicated ? '処理済みです（二重登録を防止しました）' : `入荷を登録しました${r.value.assets.length ? `（資産 ${r.value.assets.length}台を自動登録）` : ''}`),
      );
      setRequestId(generateId('req'));
    } catch {
      /* トースト表示済み */
    } finally {
      setBusy(false);
    }
  };
  const canReceive = po.status === 'approved' || po.status === 'partially_received';
  return (
    <>
      <Back href="#/inventory?tab=orders" label="発注一覧" />
      <div className="mb-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
        アプリ内の発注依頼書（下書き・承認・入荷の記録）です。外部への注文・メール送信・決済は行いません。実際の発注は社内の購買手続きで行ってください。
      </div>
      <Card className="p-4 sm:p-6" data-testid="order-detail">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-mono text-lg font-bold">{po.number}</h1>
          <PoStatusBadge status={po.status} />
        </div>
        <p className="mt-1 text-sm text-slate-500">
          仕入先：{supplier?.name}（標準納期 {supplier?.leadTimeDays}日）・依頼者：{po.requestedBy || '—'}
          {po.approvedBy && `・承認者：${po.approvedBy}`}
        </p>
        <ul className="mt-4 divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-navy-800 dark:border-navy-800">
          {po.lines.map((l) => {
            const item = itemById.get(l.itemId);
            const remaining = l.quantity - l.receivedQuantity;
            return (
              <li key={l.id} className="p-3">
                <p className="font-semibold">{item?.name}</p>
                {po.status === 'draft' ? (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <TextField label="数量" inputMode="numeric" value={String(draftLines[l.id]?.quantity ?? l.quantity)} onChange={(e) => setDraftLines({ ...draftLines, [l.id]: { ...draftLines[l.id]!, quantity: Number(e.target.value) } })} />
                    <TextField label="単価（円）" inputMode="numeric" value={String(draftLines[l.id]?.unitPrice ?? l.unitPrice)} onChange={(e) => setDraftLines({ ...draftLines, [l.id]: { ...draftLines[l.id]!, unitPrice: Number(e.target.value) } })} />
                  </div>
                ) : (
                  <p className="text-sm text-slate-600 tabular-nums dark:text-slate-300">
                    {l.quantity}
                    {item?.unit} × {yen(l.unitPrice)} = {yen(l.quantity * l.unitPrice)}・入荷済み {l.receivedQuantity}／未入荷 {remaining}
                  </p>
                )}
                {canReceive && remaining > 0 && (
                  <div className="mt-2">
                    <p className="mb-1 text-center text-xs text-slate-500">今回の入荷数（未入荷 {remaining}）</p>
                    <Stepper value={receive[l.id] ?? 0} onChange={(v) => setReceive({ ...receive, [l.id]: Math.min(remaining, Math.max(0, v)) })} min={0} max={remaining} label={`${item?.name}の入荷数`} />
                    {item?.tracking === 'asset' && <p className="mt-1 text-center text-[11px] text-slate-500">個体管理品のため、入荷数だけ資産を自動登録します（シリアル番号は後で入力）</p>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <p className="mt-2 text-right text-sm">
          合計（発注金額）<strong className="ml-2 text-lg tabular-nums">{yen(total)}</strong>
        </p>
        {po.status === 'draft' && (
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <TextField label="入荷予定日" type="date" value={expected} onChange={(e) => setExpected(e.target.value)} hint="未入力なら承認時に標準納期から自動設定" />
            <div className="self-end">
              <Button
                variant="secondary"
                block
                onClick={() => run((s) => s.inventory.updateOrderDraft(po.id, { lines: po.lines.map((l) => ({ id: l.id, ...draftLines[l.id]! })), expectedDate: expected || null, notes: po.notes }), '下書きを保存しました').catch(() => undefined)}
              >
                下書きを保存
              </Button>
            </div>
          </div>
        )}
        {(po.status === 'draft' || po.status === 'pending_approval') && (
          <TextField label={po.status === 'draft' ? '申請者' : '承認者'} value={actor} onChange={(e) => setActor(e.target.value)} placeholder={po.status === 'draft' ? po.requestedBy : '例：佐藤 健一'} wrapClassName="mt-3" />
        )}
        {canReceive && (
          <SelectField label="入荷先の保管場所" value={loc} onChange={(e) => setLoc(e.target.value)} options={data.locations.filter((l) => l.active).map((l) => ({ value: l.id, label: l.name }))} wrapClassName="mt-3" />
        )}
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {po.status === 'draft' && (
            <Button icon={Send} loading={busy} onClick={() => act('submit', '承認申請しました')} data-testid="po-submit">
              承認申請
            </Button>
          )}
          {po.status === 'pending_approval' && (
            <>
              <Button icon={CheckCircle2} loading={busy} disabled={!actor.trim()} onClick={() => act('approve', '承認しました（入荷待ち）')} data-testid="po-approve">
                承認する
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => act('reject', '差し戻しました')}>
                差し戻す
              </Button>
            </>
          )}
          {canReceive && (
            <Button icon={PackageCheck} loading={busy} disabled={!Object.values(receive).some((v) => v > 0)} onClick={doReceive} data-testid="po-receive">
              入荷を登録（{Object.values(receive).reduce((a, b) => a + b, 0)}）
            </Button>
          )}
          {['draft', 'pending_approval', 'approved'].includes(po.status) && !po.lines.some((l) => l.receivedQuantity > 0) && (
            <Button variant="ghost" icon={Ban} className="text-red-600 dark:text-red-400" disabled={busy} onClick={() => act('cancel', '発注書を取り消しました')}>
              取り消す
            </Button>
          )}
          <Button variant="ghost" icon={Printer} onClick={() => window.print()}>
            印刷（発注依頼書）
          </Button>
        </div>
      </Card>
      <Card className="mt-4">
        <CardHeader title="処理履歴" icon={History} />
        <ol className="space-y-2 px-4 pb-4 pt-2 text-sm sm:px-5">
          {[...po.history].reverse().map((h, i) => (
            <li key={i}>
              {h.message}
              <span className="block text-[11px] text-slate-400">{formatDateTimeJa(h.at)}</span>
            </li>
          ))}
        </ol>
      </Card>
    </>
  );
}

// ============================ 棚卸 ============================

type Counts = Record<string, number>;

export function StocktakePage() {
  const { data, run } = useAppData();
  const rows = useMemo(() => {
    const out: { key: string; item: Item; locationId: string; system: number }[] = [];
    for (const item of data.items.filter((i) => i.active && i.tracking === 'quantity')) {
      const levels = data.stockLevels.filter((l) => l.itemId === item.id);
      const locs = new Set([...levels.map((l) => l.locationId), ...(item.defaultLocationId ? [item.defaultLocationId] : [])]);
      for (const loc of locs) out.push({ key: `${item.id}@${loc}`, item, locationId: loc, system: levels.find((l) => l.locationId === loc)?.quantity ?? 0 });
    }
    return out;
  }, [data.items, data.stockLevels]);
  const [counts, setCounts] = useState<Counts>({});
  const [requestId] = useState(() => generateId('req'));
  const [confirm, setConfirm] = useState(false);
  const isEmpty = useCallback((c: Counts) => Object.keys(c).length === 0, []);
  // 数えている途中で画面を離れても続きから再開できる
  const draft = useDraft('stocktake', counts, isEmpty, setCounts);
  const value = (k: string, sys: number) => counts[k] ?? sys;
  const diffs = rows.filter((r) => counts[r.key] !== undefined && counts[r.key] !== r.system);
  const locName = (id: string) => data.locations.find((l) => l.id === id)?.name ?? '';
  return (
    <>
      <Back href="#/inventory" label="在庫一覧" />
      <PageHeader title="棚卸" description="実際に数えた数を入力します。差異のある行だけ「棚卸差異」として入出庫履歴に記録されます" />
      {draft.restored && (
        <p className="mb-3 rounded-xl border border-navy-200 bg-navy-50 p-3 text-sm dark:border-navy-700 dark:bg-navy-900" role="status">
          前回の途中から再開しています（入力済み {Object.keys(counts).length}行）
        </p>
      )}
      <Card className="overflow-hidden">
        <ul className="divide-y divide-slate-100 dark:divide-navy-800" data-testid="stocktake-list">
          {rows.map((r) => {
            const v = value(r.key, r.system);
            const diff = v - r.system;
            return (
              <li key={r.key} className={cx('flex items-center gap-3 px-4 py-3 sm:px-5', diff !== 0 && 'bg-amber-50/60 dark:bg-amber-950/20')}>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{r.item.name}</p>
                  <p className="text-xs text-slate-500">
                    {locName(r.locationId)}・帳簿 {r.system}
                    {r.item.unit}
                    {diff !== 0 && <span className="ml-1 font-semibold text-amber-700 dark:text-amber-400">（差異 {diff > 0 ? '+' : ''}{diff}）</span>}
                  </p>
                </div>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  aria-label={`${r.item.name}（${locName(r.locationId)}）の実数`}
                  value={v}
                  onChange={(e) => setCounts({ ...counts, [r.key]: Math.max(0, Math.floor(Number(e.target.value))) })}
                  className="h-11 w-20 rounded-lg border border-slate-300 bg-white text-center text-lg font-bold tabular-nums dark:border-navy-700 dark:bg-navy-950"
                />
              </li>
            );
          })}
        </ul>
      </Card>
      <div className="sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] z-20 -mx-4 mt-4 flex gap-2 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur lg:bottom-0 lg:mx-0 lg:rounded-xl lg:border dark:border-navy-800 dark:bg-navy-900/95">
        <Button variant="secondary" onClick={() => { setCounts({}); draft.discard(); }} disabled={!Object.keys(counts).length}>
          リセット
        </Button>
        <Button block icon={ClipboardCheck} onClick={() => setConfirm(true)} data-testid="stocktake-submit">
          棚卸を確定（差異 {diffs.length}件）
        </Button>
      </div>
      <ConfirmDialog
        open={confirm}
        title="棚卸を確定しますか？"
        confirmLabel="確定する"
        message={diffs.length ? <ul className="list-disc pl-5">{diffs.map((d) => <li key={d.key}>{d.item.name}（{locName(d.locationId)}）：{d.system} → {counts[d.key]}</li>)}</ul> : '差異はありません。確認した記録だけ残ります。'}
        onConfirm={() =>
          run((s) => s.inventory.applyStocktake(rows.map((r) => ({ itemId: r.item.id, locationId: r.locationId, counted: value(r.key, r.system) })), requestId), (r) => (r.duplicated ? '確定済みです' : `棚卸を確定しました（差異 ${r.value}件を記録）`)).then(() => {
            clearDraft('stocktake');
            navigate('/inventory');
          })
        }
        onClose={() => setConfirm(false)}
      />
    </>
  );
}
