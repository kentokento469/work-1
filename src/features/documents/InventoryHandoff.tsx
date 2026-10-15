/**
 * 納品書 → 在庫への引き渡し。
 * OCR の結果だけで在庫は変えない: 確認済みの書類で、利用者が品目と数量を確認して「在庫に反映する」を押したときだけ実行する。
 */
import { useMemo, useState } from 'react';
import { ArrowRight, Boxes, PackageCheck } from 'lucide-react';
import { useAppData } from '../../app/AppData';
import type { DocumentRecord } from '../../domain/documents/types';
import { generateId } from '../../domain/id';
import type { Item } from '../../domain/inventory/types';
import { Modal, ModalCancelButton } from '../../ui/Modal';
import { Button, Card, CardHeader, SelectField } from '../../ui/primitives';

const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');

/** 明細の品名から在庫の品目を推定 (品名・型番の包含)。確信が持てなければ未選択のまま */
export function guessItem(lineName: string, items: Item[]): Item | null {
  const n = norm(lineName);
  if (!n) return null;
  const hits = items.filter((i) => {
    const name = norm(i.name.replace(/（.*?）|\(.*?\)/g, ''));
    const model = norm(i.model);
    return (name.length >= 2 && (n.includes(name) || name.includes(n))) || (model.length >= 3 && n.includes(model));
  });
  return hits.length === 1 ? hits[0]! : null;
}

export function InventoryHandoffCard({ doc }: { doc: DocumentRecord }) {
  const { data, run } = useAppData();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'edit' | 'confirm'>('edit');
  const po = doc.purchaseOrderId ? data.purchaseOrders.find((p) => p.id === doc.purchaseOrderId) : null;
  const poReceivable = !!po && (po.status === 'approved' || po.status === 'partially_received');
  const [mode, setMode] = useState<'receive' | 'purchase_order'>(poReceivable ? 'purchase_order' : 'receive');
  const activeItems = data.items.filter((i) => i.active);
  const [locationId, setLocationId] = useState(data.locations.find((l) => l.active)?.id ?? '');
  const [rows, setRows] = useState(() => doc.lines.map((l) => ({ lineId: l.id, name: l.name, itemId: l.itemId ?? guessItem(l.name, activeItems)?.id ?? '', quantity: l.quantity && Number.isInteger(l.quantity) && l.quantity > 0 ? l.quantity : 0 })));
  const [requestId, setRequestId] = useState(() => generateId('req'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const itemById = useMemo(() => new Map(data.items.map((i) => [i.id, i])), [data.items]);

  const itemOptions = (mode === 'purchase_order' && po ? po.lines.filter((l) => l.quantity - l.receivedQuantity > 0).map((l) => itemById.get(l.itemId)!).filter(Boolean) : activeItems.filter((i) => i.tracking === 'quantity')).map((i) => ({
    value: i.id,
    label: `${i.code} ${i.name}${mode === 'purchase_order' && po ? `（未入荷 ${po.lines.filter((l) => l.itemId === i.id).reduce((a, l) => a + l.quantity - l.receivedQuantity, 0)}）` : ''}`,
  }));
  const targets = rows.filter((r) => r.itemId && r.quantity > 0);

  if (doc.deletedAt || !doc.lines.length) return null;
  if (doc.inventory)
    return (
      <Card className="p-4" data-testid="inventory-handoff-done">
        <p className="flex items-center gap-1.5 font-semibold text-emerald-700 dark:text-emerald-400">
          <PackageCheck className="size-4" aria-hidden />
          在庫へ反映済み（{doc.inventory.at.slice(0, 10)}・{doc.inventory.mode === 'purchase_order' ? '発注書の入荷として' : '入庫として'}）
        </p>
        <ul className="mt-1 text-sm">
          {doc.inventory.lines.map((l, i) => (
            <li key={i}>
              <a className="underline" href={`#/inventory/items/${l.itemId}`}>
                {itemById.get(l.itemId)?.name ?? l.itemId}
              </a>{' '}
              ＋{l.quantity}
            </li>
          ))}
        </ul>
        <p className="mt-1 text-xs text-slate-500">訂正が必要な場合は、在庫画面の「在庫調整」で理由を付けて修正してください（書類からの入庫は二重反映を防ぐため再実行できません）。</p>
      </Card>
    );
  if (doc.type !== 'delivery') return null;

  const execute = async () => {
    setBusy(true);
    setError(null);
    try {
      await run(
        (s) => s.documents.handoffToInventory({ documentId: doc.id, mode, locationId, lines: targets.map((t) => ({ itemId: t.itemId, quantity: t.quantity })), requestId }),
        (r) => (r.duplicated ? '処理済みです（二重反映を防止しました）' : `在庫に反映しました（${targets.length}品目）`),
      );
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : '反映できませんでした');
      setRequestId(generateId('req'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card data-testid="inventory-handoff">
      <CardHeader title="在庫への反映" icon={Boxes} description="納品書の品目・数量を在庫に引き渡します（確認と実行の操作が必要）" />
      <div className="px-4 pb-4 sm:px-5">
        {doc.status !== 'confirmed' ? (
          <p className="text-sm text-slate-500">抽出内容を「確認完了」にすると、在庫に反映できます。OCRの結果だけでは在庫は変わりません。</p>
        ) : (
          <Button icon={ArrowRight} onClick={() => { setStep('edit'); setOpen(true); }} data-testid="handoff-open">
            明細を在庫に反映する
          </Button>
        )}
      </div>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={step === 'edit' ? '在庫に反映する品目と数量' : '在庫を更新します'}
        description={step === 'edit' ? '品目の対応付けと数量を確認してください' : '内容を確認して実行してください'}
        footer={
          step === 'edit' ? (
            <>
              <ModalCancelButton />
              <Button onClick={() => setStep('confirm')} disabled={!targets.length || !locationId} data-testid="handoff-next">
                確認へ（{targets.length}品目）
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={() => setStep('edit')} disabled={busy}>
                戻る
              </Button>
              <Button icon={PackageCheck} onClick={execute} loading={busy} data-testid="handoff-execute">
                在庫に反映する
              </Button>
            </>
          )
        }
      >
        {step === 'edit' ? (
          <div className="space-y-3">
            <SelectField
              label="反映方法"
              value={mode}
              onChange={(e) => setMode(e.target.value as typeof mode)}
              options={[
                { value: 'receive', label: '在庫に入庫する（数量管理の品目）' },
                ...(poReceivable ? [{ value: 'purchase_order', label: `発注書 ${po!.number} の入荷として登録` }] : []),
              ]}
              hint={po && !poReceivable ? `関連発注書 ${po.number} は入荷登録できない状態です` : mode === 'purchase_order' ? '発注残が減り、PCなど1台ずつ管理する品目は資産が自動登録されます' : undefined}
            />
            <SelectField label="入庫先の保管場所" value={locationId} onChange={(e) => setLocationId(e.target.value)} options={data.locations.filter((l) => l.active).map((l) => ({ value: l.id, label: l.name }))} />
            <ul className="space-y-2" data-testid="handoff-rows">
              {rows.map((r, i) => (
                <li key={r.lineId} className="rounded-xl border border-slate-200 p-3 dark:border-navy-700">
                  <p className="text-sm font-semibold">{r.name || '（品名なし）'}</p>
                  <div className="mt-2 grid grid-cols-[1fr_6rem] gap-2">
                    <SelectField label="在庫の品目" value={r.itemId} onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, itemId: e.target.value } : y)))} placeholder="（反映しない）" options={itemOptions} />
                    <label className="block text-[13px] font-semibold">
                      数量
                      <input
                        inputMode="numeric"
                        value={r.quantity || ''}
                        onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, quantity: Math.max(0, Math.floor(Number(e.target.value.replace(/\D/g, '')) || 0)) } : y)))}
                        className="mt-1.5 block h-11 w-full rounded-lg border border-slate-300 bg-white px-2 text-right tabular-nums dark:border-navy-700 dark:bg-navy-950"
                        aria-label={`${r.name}の数量`}
                      />
                    </label>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="space-y-2 text-sm">
            <p>
              {mode === 'purchase_order' ? `発注書 ${po?.number} の入荷として` : '入庫として'}、{data.locations.find((l) => l.id === locationId)?.name} に以下を反映します。この操作は在庫の入出庫履歴に記録されます。
            </p>
            <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-navy-800 dark:border-navy-700" data-testid="handoff-summary">
              {targets.map((t) => (
                <li key={t.lineId} className="flex justify-between px-3 py-2">
                  <span>{itemById.get(t.itemId)?.name}</span>
                  <span className="font-semibold tabular-nums">
                    ＋{t.quantity}
                    {itemById.get(t.itemId)?.unit}
                  </span>
                </li>
              ))}
            </ul>
            {error && (
              <p className="text-red-600 dark:text-red-400" role="alert">
                {error}
              </p>
            )}
          </div>
        )}
      </Modal>
    </Card>
  );
}
