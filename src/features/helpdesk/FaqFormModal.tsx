/**
 * FAQ の登録・編集。
 * 解決済みの問い合わせから作る場合は、個別事情の一般化と秘密情報の除去を確認してから保存する
 * (過去の個別対応をそのまま「正解」として公開しないため)。
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Save, ShieldCheck } from 'lucide-react';
import { useAppData } from '../../app/AppData';
import { maskSecrets } from '../../domain/helpdesk/secrets';
import type { Faq, Inquiry } from '../../domain/types';
import type { FaqInput } from '../../services/helpdeskService';
import { AppError } from '../../services/workcoreService';
import { Modal, ModalCancelButton } from '../../ui/Modal';
import { Button, SelectField, TextAreaField, TextField } from '../../ui/primitives';
import { SecretWarning } from './parts';

export function FaqFormModal({ open, onClose, faq, source, onSaved }: { open: boolean; onClose: () => void; faq?: Faq; source?: Inquiry; onSaved?: (f: Faq) => void }) {
  const { data, run } = useAppData();
  const initial = useMemo<FaqInput>(
    () =>
      faq
        ? { question: faq.question, answer: faq.answer, categoryId: faq.categoryId, keywords: faq.keywords, enabled: faq.enabled }
        : source
          ? { question: source.title, answer: source.resolution, categoryId: source.categoryId, keywords: [], enabled: false }
          : { question: '', answer: '', categoryId: '', keywords: [], enabled: true },
    [faq, source, open],
  );
  const [form, setForm] = useState<FaqInput>(initial);
  const [keywordText, setKeywordText] = useState(initial.keywords.join('、'));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [checks, setChecks] = useState({ generalized: false, noSecrets: false });

  useEffect(() => {
    if (open) {
      setForm(initial);
      setKeywordText(initial.keywords.join('、'));
      setErrors({});
      setChecks({ generalized: false, noSecrets: false });
    }
  }, [open, initial]);

  const keywords = keywordText.split(/[、,，\s]+/).map((k) => k.trim()).filter(Boolean);
  const needsChecks = !!source && !faq;
  const canSave = !needsChecks || (checks.generalized && checks.noSecrets);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!canSave) return;
    setSaving(true);
    try {
      const saved = await run(
        (s) => s.helpdesk.saveFaq({ ...form, keywords }, faq?.id, { sourceInquiryId: source?.id }),
        (f) => (faq ? 'FAQを更新しました' : f.enabled ? 'FAQを公開しました' : 'FAQを下書き（無効）として保存しました'),
      );
      onClose();
      onSaved?.(saved);
    } catch (e) {
      if (e instanceof AppError) setErrors(e.fieldErrors);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      dirty={JSON.stringify({ ...form, keywords }) !== JSON.stringify(initial)}
      title={faq ? 'FAQの編集' : source ? '解決内容をFAQにする' : 'FAQの新規登録'}
      description={source ? `${source.number} の対応内容をもとに作成します。内容を一般化してから保存してください` : undefined}
      size="lg"
      footer={
        <>
          <ModalCancelButton disabled={saving} />
          <Button type="submit" form="faq-form" icon={Save} loading={saving} disabled={!canSave}>
            {faq ? '更新する' : '保存する'}
          </Button>
        </>
      }
    >
      <form id="faq-form" onSubmit={submit} noValidate className="grid gap-4">
        <TextField label="質問（よくある問い合わせ）" required value={form.question} onChange={(e) => setForm({ ...form, question: e.target.value })} error={errors.question} maxLength={120} />
        <div>
          <TextAreaField
            label="解決手順（確定した手順）"
            required
            rows={7}
            value={form.answer}
            onChange={(e) => setForm({ ...form, answer: e.target.value })}
            error={errors.answer}
            hint="番号付きの手順で書くと、利用者が自分で解決しやすくなります"
            maxLength={4000}
          />
          <SecretWarning text={`${form.question}\n${form.answer}`} onMask={() => setForm({ ...form, question: maskSecrets(form.question), answer: maskSecrets(form.answer) })} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label="カテゴリ"
            required
            value={form.categoryId}
            onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
            options={data.inquiryCategories.map((c) => ({ value: c.id, label: c.name }))}
            placeholder="選択してください"
            error={errors.categoryId}
          />
          <TextField label="検索キーワード" value={keywordText} onChange={(e) => setKeywordText(e.target.value)} error={errors.keywords} hint="読点・スペース区切り（例：wifi、無線、つながらない）" />
        </div>
        <fieldset className="rounded-xl border border-slate-200 p-3 dark:border-navy-800">
          <legend className="px-1 text-[13px] font-semibold text-slate-700 dark:text-slate-200">公開状態</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {[
              { v: true, label: '有効（候補に表示する）', hint: '確認済みの手順として問い合わせ画面に提示' },
              { v: false, label: '無効（下書き）', hint: '候補には表示しない。内容の確認後に有効化' },
            ].map((o) => (
              <label key={String(o.v)} className={`flex min-h-11 cursor-pointer items-start gap-2 rounded-lg border p-2.5 ${form.enabled === o.v ? 'border-navy-600 bg-navy-50 dark:border-navy-400 dark:bg-navy-800' : 'border-slate-200 dark:border-navy-800'}`}>
                <input type="radio" name="faq-enabled" checked={form.enabled === o.v} onChange={() => setForm({ ...form, enabled: o.v })} className="mt-0.5 size-4 accent-navy-700" />
                <span>
                  <span className="block text-sm font-semibold">{o.label}</span>
                  <span className="block text-xs text-slate-500">{o.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {needsChecks && (
          <fieldset className="rounded-xl border border-amber-300 bg-amber-50/60 p-3 dark:border-amber-800 dark:bg-amber-950/30" data-testid="faq-checks">
            <legend className="flex items-center gap-1 px-1 text-[13px] font-semibold text-amber-900 dark:text-amber-200">
              <ShieldCheck className="size-4" aria-hidden />
              FAQ化の前に確認してください
            </legend>
            {[
              ['generalized', '個人名・端末番号など、この案件だけの情報を取り除き、誰でも使える手順にした'] as const,
              ['noSecrets', 'パスワード・認証コードなどの秘密情報が含まれていない'] as const,
            ].map(([k, label]) => (
              <label key={k} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
                <input type="checkbox" checked={checks[k]} onChange={(e) => setChecks({ ...checks, [k]: e.target.checked })} className="size-5 shrink-0 accent-navy-700" />
                {label}
              </label>
            ))}
          </fieldset>
        )}
      </form>
    </Modal>
  );
}
