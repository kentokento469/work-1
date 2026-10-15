/**
 * 在庫・資産の操作シート (スマホではボトムシート)。
 * - 一覧から直接開き、数量は大きな ± で入力、既定値 (保管場所・数量1) を自動入力
 * - 確定前に「変更後の在庫」を表示 (結果のプレビュー)
 * - シートを開くたびに requestId を発行し、連打・再送でも1回だけ処理する
 */
import { AmountField, EmailField, PhoneField, SuggestField, finalizePhone } from '../../ui/SmartInputs';
import { useEffect, useLayoutEffect, useMemo, useState, type FormEvent } from 'react';
import { ArrowDownToLine, ArrowRightLeft, ArrowUpFromLine, Save, SlidersHorizontal, UserCheck, Undo2 } from 'lucide-react';
import { useAppData } from '../../app/AppData';
import { generateId } from '../../domain/id';
import { INVENTORY_CATEGORIES, INVENTORY_CATEGORY_LABEL, type Asset, type Item, type Supplier } from '../../domain/inventory/types';
import type { ItemInput } from '../../domain/inventory/stock';
import type { AssetInput } from '../../services/inventoryService';
import { AppError } from '../../services/workcoreService';
import { Modal, ModalCancelButton } from '../../ui/Modal';
import { Button, SelectField, TextAreaField, TextField, cx } from '../../ui/primitives';
import { Stepper } from './parts';

export type QuantityMode = 'receive' | 'issue' | 'transfer' | 'adjust';
const MODE: Record<QuantityMode, { title: string; icon: typeof ArrowDownToLine; verb: string }> = {
  receive: { title: '入庫', icon: ArrowDownToLine, verb: '入庫する' },
  issue: { title: '出庫', icon: ArrowUpFromLine, verb: '出庫する' },
  transfer: { title: '保管場所の移動', icon: ArrowRightLeft, verb: '移動する' },
  adjust: { title: '在庫調整（実数に合わせる）', icon: SlidersHorizontal, verb: '調整する' },
};
const ISSUE_REASONS = ['社員への支給', '入社準備', '交換・補充', '破損・廃棄', 'その他'];
const ADJUST_REASONS = ['数え直しによる差異', '破損', '紛失', '登録ミスの訂正'];

export function QuantitySheet({ item, mode, onClose }: { item: Item | null; mode: QuantityMode; onClose: () => void }) {
  const { data, run, stock } = useAppData();
  const open = !!item;
  const s = item ? stock.get(item.id) : undefined;
  const locations = data.locations.filter((l) => l.active);
  const levelAt = (loc: string) => data.stockLevels.find((l) => l.itemId === item?.id && l.locationId === loc)?.quantity ?? 0;
  const defaultLoc = () => {
    if (!item) return '';
    if (mode !== 'receive') {
      // 在庫がある保管場所を優先 (既定の保管場所 → 在庫の多い順)
      const withStock = locations.filter((l) => levelAt(l.id) > 0).sort((a, b) => Number(b.id === item.defaultLocationId) - Number(a.id === item.defaultLocationId) || levelAt(b.id) - levelAt(a.id));
      if (withStock[0]) return withStock[0].id;
    }
    return item.defaultLocationId ?? locations[0]?.id ?? '';
  };
  const [qty, setQty] = useState(1);
  const [loc, setLoc] = useState('');
  const [toLoc, setToLoc] = useState('');
  const [reason, setReason] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState(() => generateId('req'));

  // 開いた直後の初期化は描画前に行う (表示された直後に入力した値が後から上書きされないように)
  useLayoutEffect(() => {
    if (!open) return;
    const l = defaultLoc();
    setLoc(l);
    setToLoc(locations.find((x) => x.id !== l)?.id ?? '');
    setQty(mode === 'adjust' ? levelAt(l) : 1);
    setReason(mode === 'issue' ? ISSUE_REASONS[0]! : mode === 'adjust' ? ADJUST_REASONS[0]! : '補充');
    setEmployeeId('');
    setError(null);
    setRequestId(generateId('req'));
    // シートを開いた時点の値で初期化する
  }, [open, item?.id, mode]);

  if (!item || !s) return null;
  const maxIssue = Math.min(Math.max(0, s.available), levelAt(loc));
  const preview =
    mode === 'receive'
      ? { onHand: s.onHand + qty, available: s.available + qty }
      : mode === 'issue'
        ? { onHand: s.onHand - qty, available: s.available - qty }
        : mode === 'adjust'
          ? { onHand: s.onHand + (qty - levelAt(loc)), available: s.available + (qty - levelAt(loc)) }
          : { onHand: s.onHand, available: s.available };
  const invalid =
    !Number.isInteger(qty) ||
    (mode === 'adjust' ? qty < 0 || qty === levelAt(loc) || !reason.trim() : qty < 1) ||
    (mode === 'issue' && qty > maxIssue) ||
    (mode === 'transfer' && (qty > levelAt(loc) || !toLoc || toLoc === loc));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (invalid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await run(
        (sv) =>
          mode === 'receive'
            ? sv.inventory.receive({ itemId: item.id, quantity: qty, locationId: loc, reason, requestId })
            : mode === 'issue'
              ? sv.inventory.issue({ itemId: item.id, quantity: qty, locationId: loc, reason, employeeId: employeeId || null, requestId })
              : mode === 'transfer'
                ? sv.inventory.transfer({ itemId: item.id, quantity: qty, fromLocationId: loc, toLocationId: toLoc, requestId })
                : sv.inventory.adjust({ itemId: item.id, locationId: loc, actualQuantity: qty, reason, requestId }),
        (r) => (r.duplicated ? 'この操作は処理済みです（二重処理を防止しました）' : `${item.name}：${MODE[mode].title}を記録しました（実在庫 ${preview.onHand}${item.unit}）`),
        {
          // 取り消しは履歴を消さず、逆向きの記録を追加する
          undo: (r) => (sv) => (!r.duplicated && r.value ? sv.inventory.reverseMovement(r.value.id) : Promise.resolve()),
          undoMessage: '取り消しました（取り消しの記録を履歴に追加）',
        },
      );
      onClose();
    } catch (err) {
      setError(err instanceof AppError ? err.message : '処理に失敗しました');
    } finally {
      setBusy(false);
    }
  };

  const M = MODE[mode];
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${M.title}：${item.name}`}
      description={`${item.code}・現在 実在庫 ${s.onHand}${item.unit}／利用可能 ${s.available}${item.unit}`}
      footer={
        <>
          <ModalCancelButton disabled={busy} />
          <Button type="submit" form="qty-form" icon={M.icon} loading={busy} disabled={invalid} data-testid="qty-submit">
            {mode === 'adjust' ? `${qty}${item.unit} に${M.verb}` : `${qty}${item.unit} ${M.verb}`}
          </Button>
        </>
      }
    >
      <form id="qty-form" onSubmit={submit} className="space-y-4">
        <SelectField
          label={mode === 'transfer' ? '移動元' : '保管場所'}
          value={loc}
          onChange={(e) => {
            setLoc(e.target.value);
            if (mode === 'adjust') setQty(levelAt(e.target.value));
          }}
          options={locations.map((l) => ({ value: l.id, label: `${l.name}（在庫 ${levelAt(l.id)}）` }))}
        />
        {mode === 'transfer' && (
          <SelectField label="移動先" value={toLoc} onChange={(e) => setToLoc(e.target.value)} options={locations.filter((l) => l.id !== loc).map((l) => ({ value: l.id, label: l.name }))} />
        )}
        <div>
          <p className="mb-2 text-center text-[13px] font-semibold text-slate-700 dark:text-slate-200">{mode === 'adjust' ? 'この保管場所の実際の数量' : '数量'}</p>
          <Stepper value={qty} onChange={setQty} min={mode === 'adjust' ? 0 : 1} max={mode === 'issue' ? Math.max(1, maxIssue) : mode === 'transfer' ? Math.max(1, levelAt(loc)) : undefined} label="数量" />
          {mode !== 'adjust' && mode !== 'transfer' && (
            <div className="mt-2 flex justify-center gap-2">
              {[1, 5, 10].map((n) => (
                <button key={n} type="button" onClick={() => setQty(n)} className={cx('min-h-9 rounded-full border px-3 text-xs font-semibold', qty === n ? 'border-navy-700 bg-navy-700 text-white' : 'border-slate-300 text-slate-600 dark:border-navy-700 dark:text-slate-300')}>
                  {n}
                </button>
              ))}
            </div>
          )}
          {mode === 'issue' && <p className="mt-2 text-center text-xs text-slate-500">出庫できる上限 {maxIssue}{item.unit}（予約済み {s.reserved}{item.unit} は除く）</p>}
        </div>
        {(mode === 'issue' || mode === 'adjust') && (
          <fieldset>
            <legend className="mb-1.5 text-[13px] font-semibold text-slate-700 dark:text-slate-200">理由{mode === 'adjust' && <span className="text-red-500">*</span>}</legend>
            <div className="flex flex-wrap gap-2">
              {(mode === 'issue' ? ISSUE_REASONS : ADJUST_REASONS).map((r) => (
                <button key={r} type="button" onClick={() => setReason(r)} aria-pressed={reason === r} className={cx('min-h-10 rounded-full border px-3 text-[13px]', reason === r ? 'border-navy-700 bg-navy-700 text-white dark:border-navy-400 dark:bg-navy-500' : 'border-slate-300 text-slate-600 dark:border-navy-700 dark:text-slate-300')}>
                  {r}
                </button>
              ))}
            </div>
          </fieldset>
        )}
        {mode === 'issue' && (
          <SelectField
            label="支給先の社員（任意）"
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
            options={data.employees.filter((e) => e.status !== 'retired').map((e) => ({ value: e.id, label: `${e.name}（${e.employeeNumber}）` }))}
            placeholder="（指定なし）"
          />
        )}
        {mode !== 'transfer' && (
          <div className="rounded-xl bg-slate-50 p-3 text-center text-sm dark:bg-navy-950" aria-live="polite" data-testid="qty-preview">
            変更後：実在庫 <strong className="tabular-nums">{s.onHand} → {preview.onHand}</strong>
            {item.unit}・利用可能 <strong className="tabular-nums">{s.available} → {preview.available}</strong>
            {item.unit}
            {preview.available - s.backorder + s.onOrder < item.minStock && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">最低在庫数（{item.minStock}）を下回るため、発注候補が自動で作成・更新されます</p>}
          </div>
        )}
        {error && (
          <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

/** 資産の貸出 (引き渡し)。予約済みなら予約者が既定 */
export function AssignSheet({ asset, onClose }: { asset: Asset | null; onClose: () => void }) {
  const { data, run, deptById } = useAppData();
  const [employeeId, setEmployeeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState(() => generateId('req'));
  useLayoutEffect(() => {
    if (asset) {
      setEmployeeId(asset.status === 'reserved' ? (asset.assigneeId ?? '') : '');
      setRequestId(generateId('req'));
    }
  }, [asset]);
  if (!asset) return null;
  const groups = data.departments.map((d) => ({ d, emps: data.employees.filter((e) => e.departmentId === d.id && e.status !== 'retired') }));
  const submit = async () => {
    setBusy(true);
    try {
      await run((s) => s.inventory.assignAsset(asset.id, employeeId, { requestId }), (r) => (r.duplicated ? '処理済みです（二重処理を防止しました）' : `${asset.assetNumber} を貸し出しました`));
      onClose();
    } catch {
      /* トースト表示済み */
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`貸出：${asset.assetNumber}`}
      description={asset.status === 'reserved' ? `${asset.assigneeName}さんに予約済みの機器を引き渡します` : `${asset.name}を社員に貸し出します`}
      footer={
        <>
          <ModalCancelButton disabled={busy} />
          <Button icon={UserCheck} onClick={submit} loading={busy} disabled={!employeeId} data-testid="assign-submit">
            貸し出す
          </Button>
        </>
      }
    >
      <label htmlFor="assign-emp" className="mb-1.5 block text-[13px] font-semibold">
        利用者
      </label>
      <select id="assign-emp" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} disabled={asset.status === 'reserved'} className="block h-11 w-full rounded-lg border border-slate-300 bg-white px-3 dark:border-navy-700 dark:bg-navy-950">
        <option value="">社員を選択してください</option>
        {groups
          .filter((g) => g.emps.length)
          .map((g) => (
            <optgroup key={g.d.id} label={g.d.name}>
              {g.emps.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}（{e.employeeNumber}）
                </option>
              ))}
            </optgroup>
          ))}
      </select>
      {employeeId && <p className="mt-1 text-xs text-slate-500">所属：{deptById.get(data.employees.find((e) => e.id === employeeId)?.departmentId ?? '')?.name}（社員情報から自動入力）</p>}
    </Modal>
  );
}

export function ReturnSheet({ asset, onClose }: { asset: Asset | null; onClose: () => void }) {
  const { run } = useAppData();
  const [condition, setCondition] = useState<'unused' | 'repair' | 'broken'>('unused');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState(() => generateId('req'));
  useLayoutEffect(() => {
    if (asset) {
      setCondition('unused');
      setNote('');
      setRequestId(generateId('req'));
    }
  }, [asset]);
  if (!asset) return null;
  const submit = async () => {
    setBusy(true);
    try {
      await run((s) => s.inventory.returnAsset(asset.id, condition, note, requestId), (r) => (r.duplicated ? '処理済みです（二重処理を防止しました）' : `${asset.assetNumber} の返却を記録しました`));
      onClose();
    } catch {
      /* トースト表示済み */
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`${asset.status === 'reserved' ? '予約解除' : '返却'}：${asset.assetNumber}`}
      description={`${asset.assigneeName}さん`}
      footer={
        <>
          <ModalCancelButton disabled={busy} />
          <Button icon={Undo2} onClick={submit} loading={busy} data-testid="return-submit">
            {asset.status === 'reserved' ? '予約を解除する' : '返却を記録する'}
          </Button>
        </>
      }
    >
      <fieldset>
        <legend className="mb-1.5 text-[13px] font-semibold">返却時の状態</legend>
        <div className="grid grid-cols-3 gap-2">
          {(
            [
              ['unused', '正常（未使用に戻す）'],
              ['repair', '修理が必要'],
              ['broken', '故障'],
            ] as const
          ).map(([v, l]) => (
            <button key={v} type="button" aria-pressed={condition === v} onClick={() => setCondition(v)} className={cx('min-h-14 rounded-xl border px-2 text-xs font-semibold', condition === v ? 'border-navy-700 bg-navy-50 text-navy-900 dark:border-navy-400 dark:bg-navy-800 dark:text-white' : 'border-slate-200 text-slate-600 dark:border-navy-700 dark:text-slate-300')}>
              {l}
            </button>
          ))}
        </div>
      </fieldset>
      <TextAreaField label="メモ（任意）" value={note} onChange={(e) => setNote(e.target.value)} rows={2} wrapClassName="mt-4" maxLength={500} placeholder="例：初期化済み・付属品あり" />
    </Modal>
  );
}

// ---------------- マスタのフォーム ----------------

export function ItemFormModal({ open, onClose, item }: { open: boolean; onClose: () => void; item?: Item }) {
  const { data, run } = useAppData();
  const nextCode = () => {
    const max = data.items.reduce((m, i) => Math.max(m, Number(/^ITM-(\d+)$/.exec(i.code)?.[1] ?? 0)), 0);
    return `ITM-${String(max + 1).padStart(4, '0')}`;
  };
  const initial = useMemo<ItemInput>(
    () =>
      item
        ? { code: item.code, name: item.name, category: item.category, maker: item.maker, model: item.model, unit: item.unit, tracking: item.tracking, minStock: item.minStock, targetStock: item.targetStock, unitPrice: item.unitPrice, defaultLocationId: item.defaultLocationId, defaultSupplierId: item.defaultSupplierId, notes: item.notes }
        : { code: nextCode(), name: '', category: 'other', maker: '', model: '', unit: '個', tracking: 'quantity', minStock: 1, targetStock: 3, unitPrice: 0, defaultLocationId: data.locations[0]?.id ?? null, defaultSupplierId: data.suppliers[0]?.id ?? null, notes: '' },
    // 入力中のデータ再読み込みで入力を消さないよう、対象は ID で判定する
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [item?.id, open],
  );
  const [f, setF] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setF(initial);
      setErrors({});
    }
  }, [open, initial]);
  const num = (k: 'minStock' | 'targetStock' | 'unitPrice') => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value === '' ? NaN : Number(e.target.value) });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await run((s) => s.inventory.saveItem(f, item?.id), item ? '品目を更新しました' : '品目を登録しました');
      onClose();
    } catch (err) {
      if (err instanceof AppError) setErrors(err.fieldErrors);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      dirty={JSON.stringify(f) !== JSON.stringify(initial)}
      title={item ? '品目の編集' : '品目の登録'}
      size="lg"
      footer={
        <>
          <ModalCancelButton disabled={busy} />
          <Button type="submit" form="item-form" icon={Save} loading={busy}>
            保存する
          </Button>
        </>
      }
    >
      <form id="item-form" onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2">
        <TextField label="品目ID" required value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} error={errors.code} hint="自動採番（変更可）" />
        <TextField label="名称" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} error={errors.name} maxLength={60} />
        <SelectField label="カテゴリ" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value as Item['category'] })} options={INVENTORY_CATEGORIES.map((c) => ({ value: c, label: INVENTORY_CATEGORY_LABEL[c] }))} />
        <SelectField
          label="管理方法"
          value={f.tracking}
          onChange={(e) => setF({ ...f, tracking: e.target.value as Item['tracking'] })}
          options={[
            { value: 'quantity', label: '数量で管理（消耗品・周辺機器）' },
            { value: 'asset', label: '1台ずつ管理（PC・スマートフォン）' },
          ]}
          error={errors.tracking}
        />
        <SuggestField label="メーカー" value={f.maker} onChange={(v) => setF({ ...f, maker: v })} options={data.items.map((i) => i.maker)} />
        <TextField label="型番" value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} />
        <SuggestField label="管理単位" required value={f.unit} onChange={(v) => setF({ ...f, unit: v })} error={errors.unit} placeholder="個・台・箱" options={['個', '台', '本', '冊', '枚', '箱', 'セット', ...data.items.map((i) => i.unit)]} />
        <AmountField label="参考単価" value={Number.isNaN(f.unitPrice) ? '' : String(f.unitPrice)} onChange={(v) => setF((x) => ({ ...x, unitPrice: v === '' ? NaN : Number(v) }))} error={errors.unitPrice} hint="概算・発注書の初期値に使用（会計上の評価額ではありません）" testId="item-price" />
        <TextField label="最低在庫数（発注点）" inputMode="numeric" value={Number.isNaN(f.minStock) ? '' : String(f.minStock)} onChange={num('minStock')} error={errors.minStock} hint="見込み在庫がこれを下回ると発注候補を作成" />
        <TextField label="適正在庫数" inputMode="numeric" value={Number.isNaN(f.targetStock) ? '' : String(f.targetStock)} onChange={num('targetStock')} error={errors.targetStock} hint="発注候補はこの数まで補充する量を推奨" />
        <SelectField label="既定の保管場所" value={f.defaultLocationId ?? ''} onChange={(e) => setF({ ...f, defaultLocationId: e.target.value || null })} options={data.locations.map((l) => ({ value: l.id, label: l.name }))} placeholder="（なし）" />
        <SelectField label="既定の仕入先" value={f.defaultSupplierId ?? ''} onChange={(e) => setF({ ...f, defaultSupplierId: e.target.value || null })} options={data.suppliers.filter((x) => x.active).map((x) => ({ value: x.id, label: x.name }))} placeholder="（なし）" />
        <TextAreaField label="備考" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} rows={2} wrapClassName="sm:col-span-2" maxLength={500} />
      </form>
    </Modal>
  );
}

export function AssetFormModal({ open, onClose, asset, defaultItemId }: { open: boolean; onClose: () => void; asset?: Asset; defaultItemId?: string }) {
  const { data, run } = useAppData();
  const assetItems = data.items.filter((i) => i.tracking === 'asset' && (i.active || i.id === asset?.itemId));
  const initial = useMemo<AssetInput>(() => {
    if (asset) return { itemId: asset.itemId, name: asset.name, category: asset.category, maker: asset.maker, model: asset.model, serialNumber: asset.serialNumber, purchaseDate: asset.purchaseDate, purchaseCost: asset.purchaseCost, warrantyUntil: asset.warrantyUntil, locationId: asset.locationId, notes: asset.notes };
    const it = data.items.find((i) => i.id === defaultItemId) ?? assetItems[0];
    return { itemId: it?.id ?? null, name: it?.name ?? '', category: it?.category ?? 'pc', maker: it?.maker ?? '', model: it?.model ?? '', serialNumber: '', purchaseDate: null, purchaseCost: it?.unitPrice ?? null, warrantyUntil: null, locationId: it?.defaultLocationId ?? data.locations[0]?.id ?? null, notes: '' };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset?.id, open, defaultItemId]);
  const [f, setF] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState(() => generateId('req'));
  useEffect(() => {
    if (open) {
      setF(initial);
      setErrors({});
      setRequestId(generateId('req'));
    }
  }, [open, initial]);
  // 機種を選ぶとメーカー・型番・単価を自動入力 (再入力を減らす)
  const pickItem = (id: string) => {
    const it = data.items.find((i) => i.id === id);
    setF({ ...f, itemId: id || null, ...(it ? { name: it.name, category: it.category, maker: it.maker, model: it.model, purchaseCost: f.purchaseCost ?? it.unitPrice } : {}) });
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (asset) await run((s) => s.inventory.updateAsset(asset.id, f), '資産を更新しました');
      else await run((s) => s.inventory.registerAsset(f, requestId), (r) => (r.duplicated ? '登録済みです（二重登録を防止しました）' : `資産 ${r.value.assetNumber} を登録しました`));
      onClose();
    } catch (err) {
      if (err instanceof AppError) setErrors(err.fieldErrors);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      dirty={JSON.stringify(f) !== JSON.stringify(initial)}
      title={asset ? `${asset.assetNumber} の編集` : '資産の登録'}
      description={asset ? '状態・利用者の変更は「貸出・返却・状態変更」から行います（履歴を残すため）' : '資産管理番号は自動採番されます'}
      size="lg"
      footer={
        <>
          <ModalCancelButton disabled={busy} />
          <Button type="submit" form="asset-form" icon={Save} loading={busy}>
            保存する
          </Button>
        </>
      }
    >
      <form id="asset-form" onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2">
        <SelectField label="機種（品目）" value={f.itemId ?? ''} onChange={(e) => pickItem(e.target.value)} options={assetItems.map((i) => ({ value: i.id, label: `${i.name}（${i.code}）` }))} placeholder="（品目に紐付けない）" wrapClassName="sm:col-span-2" />
        <TextField label="機器名" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} error={errors.name} />
        <SelectField label="カテゴリ" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value as Asset['category'] })} options={INVENTORY_CATEGORIES.map((c) => ({ value: c, label: INVENTORY_CATEGORY_LABEL[c] }))} />
        <TextField label="メーカー" value={f.maker} onChange={(e) => setF({ ...f, maker: e.target.value })} />
        <TextField label="型番" value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} />
        <TextField label="シリアル番号" value={f.serialNumber} onChange={(e) => setF({ ...f, serialNumber: e.target.value })} error={errors.serialNumber} hint="重複不可（架空の値を使用）" />
        <TextField label="購入金額（取得原価・円）" inputMode="numeric" value={f.purchaseCost === null ? '' : String(f.purchaseCost)} onChange={(e) => setF({ ...f, purchaseCost: e.target.value === '' ? null : Number(e.target.value) })} error={errors.purchaseCost} />
        <TextField label="購入日" type="date" value={f.purchaseDate ?? ''} onChange={(e) => setF({ ...f, purchaseDate: e.target.value || null })} />
        <TextField label="保証期限" type="date" value={f.warrantyUntil ?? ''} onChange={(e) => setF({ ...f, warrantyUntil: e.target.value || null })} error={errors.warrantyUntil} />
        <SelectField label="保管場所" value={f.locationId ?? ''} onChange={(e) => setF({ ...f, locationId: e.target.value || null })} options={data.locations.map((l) => ({ value: l.id, label: l.name }))} placeholder="（なし）" />
        <TextAreaField label="備考" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} rows={2} wrapClassName="sm:col-span-2" maxLength={500} />
      </form>
    </Modal>
  );
}

export function SupplierFormModal({ open, onClose, supplier }: { open: boolean; onClose: () => void; supplier?: Supplier }) {
  const { run } = useAppData();
  const initial = useMemo(
    () => supplier ?? { id: '', name: '', contactName: '', phone: '', email: '', leadTimeDays: 5, notes: '', active: true },
    [supplier, open],
  );
  const [f, setF] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (open) {
      setF(initial);
      setErrors({});
    }
  }, [open, initial]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const { id: _id, ...rest } = f;
      rest.phone = await finalizePhone(rest.phone);
      await run((s) => s.inventory.saveSupplier(rest, supplier?.id), '仕入先を保存しました');
      onClose();
    } catch (err) {
      if (err instanceof AppError) setErrors(err.fieldErrors);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      dirty={JSON.stringify(f) !== JSON.stringify(initial)}
      title={supplier ? '仕入先の編集' : '仕入先の登録'}
      description="連絡先は記録のみです。アプリから発注・メール送信は行いません"
      footer={
        <>
          <ModalCancelButton />
          <Button type="submit" form="supplier-form" icon={Save}>
            保存する
          </Button>
        </>
      }
    >
      <form id="supplier-form" onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2">
        <TextField label="仕入先名" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} error={errors.name} wrapClassName="sm:col-span-2" />
        <TextField label="担当者" value={f.contactName} onChange={(e) => setF({ ...f, contactName: e.target.value })} />
        <TextField label="標準納期（日）" inputMode="numeric" value={String(f.leadTimeDays)} onChange={(e) => setF({ ...f, leadTimeDays: Number(e.target.value) })} error={errors.leadTimeDays} />
        <PhoneField label="電話" value={f.phone} onChange={(v) => setF((x) => ({ ...x, phone: v }))} testId="supplier-phone" />
        <EmailField label="メール" value={f.email} onChange={(v) => setF((x) => ({ ...x, email: v }))} hint="架空の仕入先は .example ドメインを使用" />
        <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} className="size-5 accent-navy-700" />
          取引中（発注書の仕入先に選べる）
        </label>
      </form>
    </Modal>
  );
}
