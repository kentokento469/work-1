/**
 * 確認・修正フォーム (Phase 4 の中心の UX)。
 * - 確認が必要な項目 (重要項目・確実性が低い/中・形式や検算の注意) を先頭にまとめ、それ以外は折りたたむ
 * - 各項目に「抽出元の行」「修正前の値」「確実性」を表示。値を編集すると、その項目は確認済みになる
 * - 重要項目 (発行元・発行日・合計金額) は、確認しないと「確認完了」にできない
 * - 入力途中は端末に自動保存し (再開可能)、「一時保存」で書類にも保存できる
 */
import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, CircleAlert, Plus, Save, Trash2, Undo2 } from 'lucide-react';
import { useAppData } from '../../app/AppData';
import { useDraft, clearDraft } from '../../app/hooks';
import { checkFields, parseAmountInput, parseDateInput, type FieldIssue } from '../../domain/documents/extract';
import { findDuplicates } from '../../domain/documents/duplicates';
import {
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_LABEL,
  FIELD_DEFS,
  type DocumentLine,
  type DocumentRecord,
  type DocumentType,
  type FieldDef,
  type FieldKey,
} from '../../domain/documents/types';
import { generateId } from '../../domain/id';
import { IMPORTANT_FIELDS } from '../../services/documentService';
import { Badge, Button, cx, SelectField } from '../../ui/primitives';
import { CertaintyBadge, DuplicateWarning } from './parts';

interface FormState {
  base: string; // どの版の書類から編集を始めたか (古い下書きを誤って適用しない)
  type: DocumentType;
  fields: Partial<Record<FieldKey, string>>;
  lines: DocumentLine[];
  reviewed: FieldKey[];
  employeeId: string;
  inquiryId: string;
  purchaseOrderId: string;
}

const fromDoc = (d: DocumentRecord): FormState => ({
  base: d.updatedAt,
  type: d.type,
  fields: { ...d.fields },
  lines: d.lines.map((l) => ({ ...l })),
  reviewed: [...d.reviewed],
  employeeId: d.employeeId ?? '',
  inquiryId: d.inquiryId ?? '',
  purchaseOrderId: d.purchaseOrderId ?? '',
});

const sameForm = (a: FormState, b: FormState) => JSON.stringify({ ...a, base: '' }) === JSON.stringify({ ...b, base: '' });
const LINE_TYPES: DocumentType[] = ['invoice', 'receipt', 'delivery', 'quote'];

export function ReviewForm({ doc, readOnly }: { doc: DocumentRecord; readOnly: boolean }) {
  const { data, run } = useAppData();
  const [form, setForm] = useState<FormState>(() => fromDoc(doc));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 書類が更新された (抽出・保存) ら、フォームを最新の内容に合わせる
  useEffect(() => setForm(fromDoc(doc)), [doc.updatedAt]);
  const original = useMemo(() => fromDoc(doc), [doc]);
  const dirty = !sameForm(form, original);
  const draft = useDraft<FormState>(readOnly ? null : `doc-review:${doc.id}`, form, (v) => v.base !== doc.updatedAt || sameForm(v, fromDoc(doc)), (v) => {
    if (v.base === doc.updatedAt) setForm(v);
  });

  const issues = useMemo(() => checkFields(form.fields, form.lines), [form.fields, form.lines]);
  const issueOf = (k: FieldKey) => issues.filter((i) => i.key === k);
  const errors = issues.filter((i) => i.level === 'error');
  const defs = FIELD_DEFS.filter((f) => !f.types || f.types.includes(form.type));
  const needsAttention = (f: FieldDef) => {
    const ex = doc.extracted[f.key];
    return (f.important && !form.reviewed.includes(f.key)) || issueOf(f.key).length > 0 || (!!ex && ex.certainty !== 'high' && !form.reviewed.includes(f.key));
  };
  const attention = defs.filter(needsAttention);
  const rest = defs.filter((f) => !needsAttention(f));
  const remainingImportant = IMPORTANT_FIELDS.filter((k) => !form.reviewed.includes(k));
  const duplicates = useMemo(
    () => findDuplicates({ id: doc.id, type: form.type, hash: doc.file?.hash, fields: form.fields, notDuplicateOf: doc.notDuplicateOf }, data.documents),
    [doc.id, doc.file?.hash, doc.notDuplicateOf, form.type, form.fields, data.documents],
  );

  const setField = (k: FieldKey, v: string) =>
    setForm((s) => ({ ...s, fields: { ...s.fields, [k]: v }, reviewed: s.reviewed.includes(k) ? s.reviewed : [...s.reviewed, k] }));
  const toggleReviewed = (k: FieldKey, on: boolean) => setForm((s) => ({ ...s, reviewed: on ? [...new Set([...s.reviewed, k])] : s.reviewed.filter((x) => x !== k) }));
  /** 入力欄から離れたときに表記ゆれを正規化 (「2026/10/5」→「2026-10-05」、「¥12,345」→「12345」) */
  const normalize = (f: FieldDef) => {
    const v = form.fields[f.key];
    if (!v) return;
    const n = f.format === 'date' ? parseDateInput(v) : f.format === 'amount' ? parseAmountInput(v)?.toString() : f.format === 'registration' ? v.normalize('NFKC').replace(/[\s-]/g, '').toUpperCase() : v;
    if (n && n !== v) setForm((s) => ({ ...s, fields: { ...s.fields, [f.key]: n } }));
  };

  const save = async (confirm: boolean) => {
    setError(null);
    setBusy(true);
    try {
      await run(
        (s) =>
          s.documents.saveReview(doc.id, {
            type: form.type,
            fields: form.fields,
            lines: form.lines,
            reviewed: form.reviewed,
            employeeId: form.employeeId || null,
            inquiryId: form.inquiryId || null,
            purchaseOrderId: form.purchaseOrderId || null,
            confirm,
          }),
        confirm ? '確認済みとして保存しました' : '一時保存しました（確認待ち）',
      );
      clearDraft(`doc-review:${doc.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存できませんでした');
    } finally {
      setBusy(false);
    }
  };

  const fieldRow = (f: FieldDef) => {
    const ex = doc.extracted[f.key];
    const v = form.fields[f.key] ?? '';
    const its = issueOf(f.key);
    const changed = ex && v !== ex.value;
    const checked = form.reviewed.includes(f.key);
    const id = `fld-${f.key}`;
    return (
      <li key={f.key} className={cx('rounded-xl border p-3', its.some((i) => i.level === 'error') ? 'border-red-300 dark:border-red-800' : 'border-slate-200 dark:border-navy-700')} data-field={f.key}>
        <div className="mb-1 flex flex-wrap items-center gap-1.5">
          <label htmlFor={id} className="text-[13px] font-semibold">
            {f.label}
          </label>
          {f.important && <Badge tone="violet">重要</Badge>}
          {ex && <CertaintyBadge c={ex.certainty} />}
          {!ex && !v && <span className="text-[11px] text-slate-400">読み取れず（空欄）</span>}
        </div>
        {f.key === 'notes' || f.key === 'applicationContent' ? (
          <textarea id={id} value={v} readOnly={readOnly} onChange={(e) => setField(f.key, e.target.value)} rows={2} className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 dark:border-navy-700 dark:bg-navy-950" />
        ) : (
          <input
            id={id}
            value={v}
            readOnly={readOnly}
            onChange={(e) => setField(f.key, e.target.value)}
            onBlur={() => normalize(f)}
            type={f.format === 'date' ? 'date' : 'text'}
            inputMode={f.format === 'amount' ? 'numeric' : undefined}
            autoComplete="off"
            placeholder={f.format === 'amount' ? '例：12345' : f.format === 'registration' ? 'T＋13桁' : ''}
            className={cx('block h-11 w-full rounded-lg border bg-white px-3 dark:bg-navy-950', its.some((i) => i.level === 'error') ? 'border-red-400' : 'border-slate-300 dark:border-navy-700', f.format === 'amount' && 'tabular-nums')}
            aria-invalid={its.some((i) => i.level === 'error') || undefined}
          />
        )}
        {f.format === 'amount' && /^\d+$/.test(v) && <p className="mt-0.5 text-right text-xs tabular-nums text-slate-500">¥{Number(v).toLocaleString()}</p>}
        {its.map((i) => (
          <p key={i.message} className={cx('mt-1 flex items-start gap-1 text-xs', i.level === 'error' ? 'text-red-600 dark:text-red-400' : 'text-amber-700 dark:text-amber-400')} role={i.level === 'error' ? 'alert' : undefined}>
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {i.message}
          </p>
        ))}
        {ex && (
          <div className="mt-1.5 space-y-0.5 text-[11px] text-slate-500">
            <p className="break-all" data-testid={`evidence-${f.key}`}>
              抽出元{ex.page ? `（p.${ex.page}${ex.ocrConfidence !== null ? `・文字認識 ${ex.ocrConfidence}%` : '・PDFのテキスト'}）` : ''}：『{ex.evidence}』
            </p>
            {ex.reasons.length > 0 && <p>{ex.reasons.join('／')}</p>}
            {changed && !readOnly && (
              <p className="flex items-center gap-2">
                修正前：<span className="font-mono">{ex.value}</span>
                <button type="button" className="inline-flex min-h-8 items-center gap-0.5 font-semibold text-navy-600 dark:text-navy-300" onClick={() => setField(f.key, ex.value)}>
                  <Undo2 className="size-3" aria-hidden />
                  戻す
                </button>
              </p>
            )}
          </div>
        )}
        {!readOnly && (
          <label className="mt-1.5 flex min-h-11 cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" className="size-5 accent-navy-700" checked={checked} onChange={(e) => toggleReviewed(f.key, e.target.checked)} data-testid={`review-${f.key}`} />
            {f.important ? '原本と照らして確認した' : '確認した'}
            {checked && <CheckCircle2 className="size-4 text-emerald-600" aria-hidden />}
          </label>
        )}
      </li>
    );
  };

  const setLine = (i: number, patch: Partial<DocumentLine>) => setForm((s) => ({ ...s, lines: s.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const numOrNull = (v: string) => (v.trim() === '' ? null : Number.isFinite(Number(v.replace(/,/g, ''))) ? Number(v.replace(/,/g, '')) : null);
  const lineIssues: FieldIssue[] = issues.filter((i) => i.key === 'lines');

  return (
    <div className="space-y-4" data-testid="review-form">
      {draft.restored && (
        <p className="flex flex-wrap items-center gap-2 rounded-lg bg-navy-50 px-3 py-2 text-sm dark:bg-navy-900" role="status">
          前回の入力途中の内容を復元しました。
          <button type="button" className="min-h-9 font-semibold underline" onClick={() => { draft.discard(); setForm(fromDoc(doc)); }}>
            破棄する
          </button>
        </p>
      )}
      <DuplicateWarning
        doc={{ ...doc, fields: form.fields }}
        matches={duplicates}
        onNotDuplicate={(other) => run((s) => s.documents.markNotDuplicate(doc.id, other), '別の書類として記録しました').catch(() => undefined)}
        onTrash={() => run((s) => s.documents.trash(doc.id), 'ゴミ箱へ移しました', { undo: () => (s) => s.documents.restoreFromTrash(doc.id) }).catch(() => undefined)}
      />
      <SelectField label="書類の種類" value={form.type} disabled={readOnly} onChange={(e) => setForm((s) => ({ ...s, type: e.target.value as DocumentType }))} options={DOCUMENT_TYPES.map((t) => ({ value: t, label: DOCUMENT_TYPE_LABEL[t] }))} />

      {attention.length > 0 && (
        <section aria-label="確認が必要な項目">
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-bold text-amber-800 dark:text-amber-300">
            <CircleAlert className="size-4" aria-hidden />
            確認が必要な項目（{attention.length}）
          </h3>
          <ul className="space-y-2" data-testid="attention-fields">
            {attention.map(fieldRow)}
          </ul>
        </section>
      )}
      {rest.length > 0 && (
        <details open={readOnly || attention.length === 0 || Object.keys(doc.extracted).length === 0} className="group">
          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-bold text-slate-600 dark:text-slate-300">その他の項目（{rest.length}）</summary>
          <ul className="mt-2 space-y-2" data-testid="other-fields">
            {rest.map(fieldRow)}
          </ul>
        </details>
      )}

      {(LINE_TYPES.includes(form.type) || form.lines.length > 0) && (
        <section aria-label="明細">
          <h3 className="mb-2 text-sm font-bold">明細（{form.lines.length}行）</h3>
          <ul className="space-y-2" data-testid="line-list">
            {form.lines.map((l, i) => (
              <li key={l.id} className="rounded-xl border border-slate-200 p-3 dark:border-navy-700">
                <div className="flex items-center gap-2">
                  <input aria-label={`${i + 1}行目の品名`} value={l.name} readOnly={readOnly} onChange={(e) => setLine(i, { name: e.target.value })} className="h-11 min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 dark:border-navy-700 dark:bg-navy-950" />
                  {!readOnly && (
                    <button type="button" aria-label={`${i + 1}行目を削除`} className="flex size-11 items-center justify-center rounded-lg text-slate-400" onClick={() => setForm((s) => ({ ...s, lines: s.lines.filter((_, j) => j !== i) }))}>
                      <Trash2 className="size-4" />
                    </button>
                  )}
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                  {(['quantity', 'unitPrice', 'amount'] as const).map((k) => (
                    <label key={k} className="block">
                      <span className="text-slate-500">{k === 'quantity' ? '数量' : k === 'unitPrice' ? '単価' : '金額'}</span>
                      <input
                        inputMode="decimal"
                        value={l[k] ?? ''}
                        readOnly={readOnly}
                        onChange={(e) => setLine(i, { [k]: numOrNull(e.target.value) })}
                        className="mt-0.5 block h-11 w-full rounded-lg border border-slate-300 bg-white px-2 text-right tabular-nums dark:border-navy-700 dark:bg-navy-950"
                      />
                    </label>
                  ))}
                </div>
                {l.evidence && <p className="mt-1 break-all text-[11px] text-slate-500">抽出元：『{l.evidence}』</p>}
              </li>
            ))}
          </ul>
          {lineIssues.map((i) => (
            <p key={i.message} className="mt-1 text-xs text-amber-700 dark:text-amber-400">
              {i.message}
            </p>
          ))}
          {!readOnly && (
            <Button className="mt-2" size="sm" variant="secondary" icon={Plus} onClick={() => setForm((s) => ({ ...s, lines: [...s.lines, { id: generateId('dl'), name: '', quantity: 1, unitPrice: null, amount: null, itemId: null, evidence: '' }] }))}>
              明細を追加
            </Button>
          )}
        </section>
      )}

      <section aria-label="関連業務" className="space-y-2">
        <h3 className="text-sm font-bold">関連業務</h3>
        <SelectField label="関連社員" value={form.employeeId} disabled={readOnly} onChange={(e) => setForm((s) => ({ ...s, employeeId: e.target.value }))} placeholder="（なし）" options={data.employees.map((e) => ({ value: e.id, label: `${e.name}（${e.employeeNumber}）` }))} />
        <SelectField label="関連する問い合わせ" value={form.inquiryId} disabled={readOnly} onChange={(e) => setForm((s) => ({ ...s, inquiryId: e.target.value }))} placeholder="（なし）" options={data.inquiries.map((i) => ({ value: i.id, label: `${i.number} ${i.title}` }))} />
        <SelectField
          label="関連する発注書"
          value={form.purchaseOrderId}
          disabled={readOnly || !!doc.inventory}
          onChange={(e) => setForm((s) => ({ ...s, purchaseOrderId: e.target.value }))}
          placeholder="（なし）"
          options={data.purchaseOrders.filter((p) => p.status !== 'cancelled').map((p) => ({ value: p.id, label: `${p.number}（${data.suppliers.find((x) => x.id === p.supplierId)?.name ?? ''}）` }))}
          hint={doc.inventory ? '在庫に反映済みのため変更できません' : '納品書を発注書に関連付けると、発注書の入荷として在庫に反映できます'}
        />
      </section>

      {!readOnly && (
        <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-20 -mx-1 rounded-2xl border border-slate-200 bg-white/95 p-3 shadow-lg backdrop-blur lg:bottom-4 dark:border-navy-700 dark:bg-navy-900/95" data-testid="review-actions">
          <p className="mb-2 text-xs text-slate-600 dark:text-slate-300" aria-live="polite">
            {errors.length ? <span className="text-red-600 dark:text-red-400">入力エラーが{errors.length}件あります</span> : remainingImportant.length ? `確認完了まで：重要項目 あと${remainingImportant.length}件（${remainingImportant.map((k) => FIELD_DEFS.find((f) => f.key === k)!.label.replace(/（.*$/, '')).join('・')}）` : '重要項目はすべて確認済みです'}
            {dirty && <span className="ml-1 text-amber-700 dark:text-amber-400">・未保存の変更あり</span>}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" icon={Save} onClick={() => save(false)} loading={busy} disabled={errors.length > 0} data-testid="review-save">
              一時保存
            </Button>
            <Button icon={CheckCircle2} onClick={() => save(true)} loading={busy} disabled={errors.length > 0 || remainingImportant.length > 0} data-testid="review-confirm">
              確認完了
            </Button>
          </div>
          {error && (
            <p className="mt-2 text-xs text-red-600 dark:text-red-400" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
