/**
 * 問い合わせ登録。
 * - 入力途中の内容は端末に自動保存し、誤って閉じたり再読み込みしても復元できる
 * - 送信ボタンの連打・通信再試行でも1件しか登録されない (requestId による冪等処理)
 * - 入力中に関連FAQを表示し、FAQで解決できる問い合わせに早く気づけるようにする
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { BackLink } from '../../app/BackLink';
import { BookOpenCheck, RotateCcw, Send } from 'lucide-react';
import { useAppData } from '../../app/AppData';
import { clearDraft, useDraft } from '../../app/hooks';
import { navigate } from '../../app/router';
import { validateInquiry, type InquiryInput } from '../../domain/helpdesk/inquiry';
import { findSimilarCases, suggestFaqs } from '../../domain/helpdesk/search';
import { generateId } from '../../domain/id';
import type { FieldErrors } from '../../domain/validation';
import { AppError } from '../../services/workcoreService';
import { emptyInquiryForm, InquiryFormFields, toClassificationSnapshot, useClassification, type InquiryFormState } from '../../features/helpdesk/InquiryForm';
import { SolutionSuggestions } from '../../features/helpdesk/parts';
import { Button, Card, CardHeader, PageHeader } from '../../ui/primitives';

const DRAFT_KEY = 'inquiry-new';

export function InquiryNewPage({ query }: { query: URLSearchParams }) {
  const { data, run, today } = useAppData();
  const [state, setStateRaw] = useState<InquiryFormState>(() => emptyInquiryForm(today, query.get('requester')));
  const setState = useCallback((u: (s: InquiryFormState) => InquiryFormState) => setStateRaw(u), []);
  const [errors, setErrors] = useState<FieldErrors<InquiryInput>>({});
  const [saving, setSaving] = useState(false);
  // 値が変わった項目のエラーは消す (自動分類でカテゴリが後から入った場合など、古いエラーを残さない)
  const prevInput = useRef(state.input);
  useEffect(() => {
    const prev = prevInput.current;
    prevInput.current = state.input;
    const changed = (Object.keys(state.input) as (keyof InquiryInput)[]).filter((k) => prev[k] !== state.input[k]);
    if (changed.length) setErrors((e) => (changed.some((k) => k in e) ? Object.fromEntries(Object.entries(e).filter(([k]) => !changed.includes(k as keyof InquiryInput))) : e));
  }, [state.input]);
  // フォームを開いた単位で1つの requestId を使う → 連打しても同じ問い合わせとして扱われる
  const [requestId, setRequestId] = useState(() => generateId('req'));
  const classification = useClassification(state.input.title, state.input.body);

  const isEmpty = useCallback((s: InquiryFormState) => !s.input.title.trim() && !s.input.body.trim(), []);
  const draft = useDraft(DRAFT_KEY, state, isEmpty, (d) => setStateRaw({ ...d, input: { ...d.input, requesterId: query.get('requester') ?? d.input.requesterId } }));

  const text = `${state.input.title} ${state.input.body}`.trim();
  const faqMatches = useMemo(() => (text.length >= 4 ? suggestFaqs(text, data.faqs, { categoryId: state.input.categoryId, limit: 3 }) : []), [text, data.faqs, state.input.categoryId]);
  const caseMatches = useMemo(() => (text.length >= 4 ? findSimilarCases(text, data.inquiries, { categoryId: state.input.categoryId, limit: 2 }) : []), [text, data.inquiries, state.input.categoryId]);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (saving) return;
    const v = validateInquiry(state.input, { employeeIds: data.employees.map((e) => e.id), categoryIds: data.inquiryCategories.map((c) => c.id) });
    if (!v.ok) {
      setErrors(v.errors);
      // 最初のエラー項目へスクロール
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    setSaving(true);
    try {
      const { inquiry } = await run(
        (s) => s.helpdesk.createInquiry(state.input, { requestId, classification: toClassificationSnapshot(classification, state.input) }),
        (r) => (r.duplicated ? `${r.inquiry.number} は登録済みです（二重送信を防止しました）` : `${r.inquiry.number} として受け付けました`),
      );
      clearDraft(DRAFT_KEY);
      setRequestId(generateId('req'));
      navigate(`/helpdesk/${inquiry.id}?created=1`);
    } catch (e) {
      if (e instanceof AppError) setErrors(e.fieldErrors as FieldErrors<InquiryInput>);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <BackLink href="#/helpdesk">問い合わせ一覧</BackLink>
      <PageHeader title="問い合わせの登録" description="内容を入力すると、カテゴリ・優先度・担当者・期限を自動で提案します" />

      {draft.restored && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-navy-200 bg-navy-50 px-4 py-2.5 text-sm text-navy-900 dark:border-navy-700 dark:bg-navy-900 dark:text-navy-100" role="status">
          <RotateCcw className="size-4 shrink-0" aria-hidden />
          <span className="flex-1">前回の入力途中の内容を復元しました</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              draft.discard();
              setStateRaw(emptyInquiryForm(today, query.get('requester')));
            }}
          >
            破棄して新規入力
          </Button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <Card className="p-4 sm:p-5">
          <form id="inquiry-form" onSubmit={submit} noValidate>
            <InquiryFormFields state={state} setState={setState} errors={errors} classification={classification} />
            <div className="mt-5 hidden lg:block">
              <Button type="submit" icon={Send} loading={saving} block data-testid="submit-inquiry">
                受け付ける
              </Button>
            </div>
          </form>
        </Card>
        <Card className="h-fit lg:sticky lg:top-6">
          <CardHeader title="解決策の候補" icon={BookOpenCheck} description="FAQで解決できる場合は、受付後に関連付けて案内できます" />
          <div className="p-4 sm:p-5">
            {text.length < 4 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">件名・内容を入力すると、関連するFAQと過去の対応例を表示します。</p>
            ) : (
              <SolutionSuggestions faqs={faqMatches} cases={caseMatches} />
            )}
          </div>
        </Card>
      </div>

      {/* スマホ: 親指で押しやすい位置に固定の送信ボタン */}
      <div className="sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] z-20 -mx-4 mt-4 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur lg:hidden dark:border-navy-800 dark:bg-navy-900/95">
        <Button type="submit" form="inquiry-form" icon={Send} loading={saving} block data-testid="submit-inquiry-mobile">
          受け付ける
        </Button>
      </div>
    </>
  );
}
