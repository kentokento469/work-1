/**
 * ヘルプデスク画面の共通部品 (バッジ・自動分類の根拠表示・FAQ/過去事例の候補・秘密情報の警告)。
 */
import { useState } from 'react';
import { AlertTriangle, BookOpenCheck, ChevronDown, CircleHelp, History, Link2, Link2Off, ShieldAlert, Sparkles, Wand2 } from 'lucide-react';
import type { ClassificationResult } from '../../domain/helpdesk/classifier';
import type { FaqMatch, PastCaseMatch } from '../../domain/helpdesk/search';
import { detectSecrets } from '../../domain/helpdesk/secrets';
import { INQUIRY_STATUS_LABEL, PRIORITY_LABEL, type InquiryCategory, type InquiryStatus } from '../../domain/types';
import { formatDateTimeJa } from '../../domain/date';
import { Badge, Button, cx, type Tone } from '../../ui/primitives';

const STATUS_TONE: Record<InquiryStatus, Tone> = { new: 'violet', in_progress: 'blue', waiting: 'amber', on_hold: 'gray', resolved: 'green', closed: 'navy' };

export function InquiryStatusBadge({ status }: { status: InquiryStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{INQUIRY_STATUS_LABEL[status]}</Badge>;
}

export function CategoryBadge({ category }: { category: InquiryCategory | undefined }) {
  if (!category) return <Badge>カテゴリ不明</Badge>;
  return <Badge tone={category.isFallback ? 'amber' : 'gray'}>{category.name}</Badge>;
}

/** 秘密情報の警告。保存前に伏せ字化を促す */
export function SecretWarning({ text, onMask }: { text: string; onMask: () => void }) {
  const findings = detectSecrets(text);
  if (!findings.length) return null;
  return (
    <div className="mt-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200" role="alert">
      <p className="flex items-center gap-1.5 font-semibold">
        <ShieldAlert className="size-4 shrink-0" aria-hidden />
        {[...new Set(findings.map((f) => f.label))].join('・')}らしき文字列があります
      </p>
      <p className="mt-1 text-xs">秘密情報は問い合わせ・FAQ・履歴に保存できません。パスワード等は対面や電話で伝えてください。</p>
      <Button size="sm" variant="secondary" icon={Wand2} className="mt-2" onClick={onMask}>
        自動で伏せ字にする
      </Button>
    </div>
  );
}

/** 自動分類の結果と判定根拠。根拠は折りたたみで段階的に表示する */
export function ClassificationPanel({
  result,
  categories,
  categoryOverridden,
  priorityOverridden,
  onApply,
}: {
  result: ClassificationResult | null;
  categories: InquiryCategory[];
  categoryOverridden: boolean;
  priorityOverridden: boolean;
  onApply?: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (!result) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 p-3 text-xs text-slate-500 dark:border-navy-700">
        <Sparkles className="mr-1 inline size-3.5" aria-hidden />
        件名・内容を入力すると、カテゴリと優先度の候補を自動で提示します
      </div>
    );
  }
  const cat = categories.find((c) => c.id === result.categoryId);
  const confidenceLabel = { high: '確度：高', medium: '確度：中', low: '要確認' }[result.confidence];
  return (
    <div
      className={cx(
        'rounded-xl border p-3',
        result.needsReview ? 'border-amber-300 bg-amber-50/70 dark:border-amber-800 dark:bg-amber-950/30' : 'border-navy-200 bg-navy-50/60 dark:border-navy-700 dark:bg-navy-900',
      )}
      data-testid="classification-panel"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 text-xs font-bold text-navy-800 dark:text-navy-100">
          {result.needsReview ? <CircleHelp className="size-4 text-amber-600" aria-hidden /> : <Sparkles className="size-4" aria-hidden />}
          自動分類の候補
        </span>
        <Badge tone={result.needsReview ? 'amber' : 'navy'}>{result.needsReview ? 'その他・要確認' : cat?.name}</Badge>
        <Badge tone={result.priority === 'high' ? 'red' : 'gray'}>優先度 {PRIORITY_LABEL[result.priority]}</Badge>
        <span className="text-[11px] text-slate-500">{confidenceLabel}</span>
      </div>
      {(categoryOverridden || priorityOverridden) && (
        <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-slate-600 dark:text-slate-300">
          担当者が{[categoryOverridden && 'カテゴリ', priorityOverridden && '優先度'].filter(Boolean).join('・')}を変更しています
          {onApply && (
            <button type="button" className="min-h-8 font-semibold text-navy-600 underline dark:text-navy-300" onClick={onApply}>
              候補に戻す
            </button>
          )}
        </p>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mt-1 inline-flex min-h-9 items-center gap-1 text-xs font-semibold text-slate-600 dark:text-slate-300"
        aria-expanded={open}
      >
        <ChevronDown className={cx('size-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
        判定の根拠を見る
      </button>
      {open && (
        <div className="mt-1 space-y-2 text-xs text-slate-600 dark:text-slate-300" data-testid="classification-reasons">
          <ul className="list-disc space-y-0.5 pl-4">
            {result.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
          {result.candidates.length > 0 && (
            <table className="w-full text-left">
              <thead className="text-[11px] text-slate-400">
                <tr>
                  <th className="py-1 font-medium">カテゴリ</th>
                  <th className="py-1 font-medium">点数</th>
                  <th className="py-1 font-medium">一致した語</th>
                </tr>
              </thead>
              <tbody>
                {result.candidates.map((c) => (
                  <tr key={c.categoryId} className="border-t border-slate-200/70 dark:border-navy-800">
                    <td className="py-1 pr-2">{c.name}</td>
                    <td className="py-1 pr-2 tabular-nums">{c.score}</td>
                    <td className="py-1">{c.matched.join('、')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {result.priorityReasons.length > 0 && (
            <ul className="space-y-0.5">
              {result.priorityReasons.map((r) => (
                <li key={r.label}>
                  優先度 {r.weight > 0 ? '+' : ''}
                  {r.weight}：{r.label}（{r.terms.join('、')}）
                </li>
              ))}
            </ul>
          )}
          <p className="text-[11px] text-slate-400">判定方式：キーワード一致（最長一致）＋加点方式のルールベース。最終的な分類は担当者が決定します。</p>
        </div>
      )}
    </div>
  );
}

/**
 * 解決策の候補。
 * FAQ (担当者が確認・公開した確定手順) と 過去の対応例 (未検証の参考情報) を視覚的に明確に分ける。
 */
export function SolutionSuggestions({
  faqs,
  cases,
  linkedFaqIds,
  onToggleLink,
}: {
  faqs: FaqMatch[];
  cases: PastCaseMatch[];
  linkedFaqIds?: string[];
  onToggleLink?: (faqId: string, link: boolean) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (faqs.length === 0 && cases.length === 0)
    return <p className="text-xs text-slate-500 dark:text-slate-400">関連するFAQ・過去の対応例は見つかりませんでした。</p>;
  return (
    <div className="space-y-3" data-testid="solution-suggestions">
      {faqs.length > 0 && (
        <div>
          <p className="mb-1.5 flex items-center gap-1 text-xs font-bold text-emerald-800 dark:text-emerald-300">
            <BookOpenCheck className="size-3.5" aria-hidden />
            FAQ（確認済みの手順）
          </p>
          <ul className="space-y-1.5">
            {faqs.map((m) => {
              const linked = linkedFaqIds?.includes(m.faq.id) ?? false;
              const expanded = openId === m.faq.id;
              return (
                <li key={m.faq.id} className="rounded-lg border border-emerald-200 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/20">
                  <div className="flex items-start gap-2 p-2.5">
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpenId(expanded ? null : m.faq.id)} aria-expanded={expanded}>
                      <span className="block text-sm font-semibold text-slate-800 dark:text-slate-100">{m.faq.question}</span>
                      <span className="block text-[11px] text-slate-500">{m.reasons.join('・')}</span>
                    </button>
                    {onToggleLink && (
                      <Button size="sm" variant={linked ? 'secondary' : 'ghost'} icon={linked ? Link2Off : Link2} onClick={() => onToggleLink(m.faq.id, !linked)}>
                        {linked ? '解除' : '関連付け'}
                      </Button>
                    )}
                  </div>
                  {expanded && (
                    <div className="border-t border-emerald-200 px-3 py-2 text-sm whitespace-pre-wrap text-slate-700 dark:border-emerald-900 dark:text-slate-200">
                      {m.faq.answer}
                      <a href={`#/faq/${m.faq.id}`} className="mt-1 block text-xs font-semibold text-navy-600 dark:text-navy-300">
                        FAQ詳細を開く
                      </a>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {cases.length > 0 && (
        <div>
          <p className="mb-1 flex items-center gap-1 text-xs font-bold text-slate-600 dark:text-slate-300">
            <History className="size-3.5" aria-hidden />
            参考：過去の対応例（未検証）
          </p>
          <p className="mb-1.5 flex items-start gap-1 text-[11px] text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
            過去の個別対応です。状況が異なる場合があるため、そのまま正解として扱わないでください。
          </p>
          <ul className="space-y-1.5">
            {cases.map((m) => (
              <li key={m.inquiry.id} className="rounded-lg border border-dashed border-slate-300 p-2.5 dark:border-navy-700">
                <a href={`#/helpdesk/${m.inquiry.id}`} className="block">
                  <span className="block text-sm font-semibold text-slate-700 dark:text-slate-200">
                    {m.inquiry.number}　{m.inquiry.title}
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-600 dark:text-slate-300">対応：{m.inquiry.resolution}</span>
                  <span className="block text-[11px] text-slate-400">
                    {formatDateTimeJa(m.inquiry.receivedAt)}受付・{m.reasons.join('・')}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
