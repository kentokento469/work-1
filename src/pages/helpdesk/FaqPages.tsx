/**
 * FAQ 一覧・詳細。
 * 一覧は検索語との関連度順に並べ、カテゴリ・公開状態で絞り込める。
 */
import { useMemo, useState } from 'react';
import { ArrowLeft, BookOpen, BookOpenCheck, ChevronRight, FileQuestion, Headset, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { useAppData } from '../../app/AppData';
import { useQueryState } from '../../app/hooks';
import { navigate } from '../../app/router';
import { filterFaqs } from '../../domain/helpdesk/search';
import { formatDateTimeJa } from '../../domain/date';
import { FaqFormModal } from '../../features/helpdesk/FaqFormModal';
import { CategoryBadge, InquiryStatusBadge } from '../../features/helpdesk/parts';
import { Badge, Button, Card, CardHeader, EmptyState, FilterSelect, PageHeader } from '../../ui/primitives';

export function FaqListPage() {
  const { data } = useAppData();
  const [f, setF] = useQueryState({ q: '', category: '', state: '' });
  const [creating, setCreating] = useState(false);
  const catById = useMemo(() => new Map(data.inquiryCategories.map((c) => [c.id, c])), [data.inquiryCategories]);
  const usage = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of data.inquiries) for (const id of i.faqIds) m.set(id, (m.get(id) ?? 0) + 1);
    return m;
  }, [data.inquiries]);

  const list = useMemo(() => {
    const base = data.faqs
      .filter((x) => !f.category || x.categoryId === f.category)
      .filter((x) => (f.state === 'enabled' ? x.enabled : f.state === 'disabled' ? !x.enabled : true));
    const searched = filterFaqs(base, f.q);
    return f.q ? searched : [...searched].sort((a, b) => (usage.get(b.id) ?? 0) - (usage.get(a.id) ?? 0) || a.question.localeCompare(b.question));
  }, [data.faqs, f, usage]);

  return (
    <>
      <PageHeader
        title="FAQ"
        description={`公開 ${data.faqs.filter((x) => x.enabled).length}件・下書き ${data.faqs.filter((x) => !x.enabled).length}件`}
        actions={
          <Button icon={Plus} onClick={() => setCreating(true)}>
            FAQを登録
          </Button>
        }
      />
      <Card className="p-3 sm:p-4">
        <div className="grid gap-2 sm:grid-cols-[1fr_10rem_9rem]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
            <input
              type="search"
              value={f.q}
              onChange={(e) => setF({ q: e.target.value })}
              placeholder="困っていること・キーワードで検索（例：wifi）"
              aria-label="FAQを検索"
              className="h-11 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 shadow-sm focus:border-navy-500 focus:outline-none focus:ring-2 focus:ring-navy-500/25 dark:border-navy-700 dark:bg-navy-950"
            />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:contents">
            <FilterSelect label="カテゴリ" value={f.category} onChange={(v) => setF({ category: v })} options={[{ value: '', label: '全カテゴリ' }, ...data.inquiryCategories.map((c) => ({ value: c.id, label: c.name }))]} />
            <FilterSelect
              label="公開状態"
              value={f.state}
              onChange={(v) => setF({ state: v })}
              options={[
                { value: '', label: 'すべて' },
                { value: 'enabled', label: '有効のみ' },
                { value: 'disabled', label: '下書き（無効）' },
              ]}
            />
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between px-1 text-xs text-slate-500">
          <span data-testid="faq-count">{list.length}件を表示{f.q && '（関連度順）'}</span>
          {(f.q || f.category || f.state) && (
            <button type="button" className="inline-flex min-h-9 items-center gap-1 font-semibold text-navy-600 dark:text-navy-300" onClick={() => setF({ q: '', category: '', state: '' })}>
              <X className="size-3.5" />
              条件をクリア
            </button>
          )}
        </div>
      </Card>
      <Card className="mt-3 overflow-hidden">
        {list.length === 0 ? (
          <EmptyState icon={BookOpen} title="該当するFAQはありません" description="解決済みの問い合わせから「FAQにする」で作成できます" />
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-navy-800" data-testid="faq-list">
            {list.map((x) => (
              <li key={x.id}>
                <a href={`#/faq/${x.id}`} className="flex items-center gap-3 px-4 py-3 active:bg-slate-50 sm:px-5 dark:active:bg-navy-800">
                  <BookOpenCheck className={`size-5 shrink-0 ${x.enabled ? 'text-emerald-600' : 'text-slate-300'}`} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-slate-800 dark:text-slate-100">{x.question}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                      <CategoryBadge category={catById.get(x.categoryId)} />
                      {!x.enabled && <Badge tone="amber">下書き</Badge>}
                      <span>利用 {usage.get(x.id) ?? 0}件</span>
                    </div>
                  </div>
                  <ChevronRight className="size-4 shrink-0 text-slate-300" aria-hidden />
                </a>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <FaqFormModal open={creating} onClose={() => setCreating(false)} onSaved={(faq) => navigate(`/faq/${faq.id}`)} />
    </>
  );
}

export function FaqDetailPage({ faqId }: { faqId: string }) {
  const { data, run } = useAppData();
  const faq = data.faqs.find((x) => x.id === faqId);
  const [editing, setEditing] = useState(false);
  if (!faq)
    return <EmptyState icon={FileQuestion} title="FAQが見つかりません" action={<Button onClick={() => navigate('/faq')}>FAQ一覧へ</Button>} />;
  const category = data.inquiryCategories.find((c) => c.id === faq.categoryId);
  const linked = data.inquiries.filter((i) => i.faqIds.includes(faq.id));
  const source = faq.sourceInquiryId ? data.inquiries.find((i) => i.id === faq.sourceInquiryId) : undefined;
  return (
    <>
      <a href="#/faq" className="-ml-2 mb-3 inline-flex min-h-10 items-center gap-1 rounded-lg px-2 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
        <ArrowLeft className="size-4" aria-hidden />
        FAQ一覧
      </a>
      <Card className="p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <CategoryBadge category={category} />
          {faq.enabled ? <Badge tone="green">有効（候補に表示）</Badge> : <Badge tone="amber">下書き（候補に表示しない）</Badge>}
        </div>
        <h1 className="mt-2 text-xl font-bold text-slate-900 sm:text-2xl dark:text-white">{faq.question}</h1>
        <div className="mt-4 rounded-xl bg-emerald-50/60 p-4 text-sm leading-relaxed whitespace-pre-wrap text-slate-800 dark:bg-emerald-950/20 dark:text-slate-100" data-testid="faq-answer">
          <p className="mb-1 text-xs font-bold text-emerald-800 dark:text-emerald-300">解決手順（確定）</p>
          {faq.answer}
        </div>
        {faq.keywords.length > 0 && (
          <p className="mt-3 flex flex-wrap gap-1.5">
            {faq.keywords.map((k) => (
              <Badge key={k}>{k}</Badge>
            ))}
          </p>
        )}
        <p className="mt-3 text-xs text-slate-500">最終更新 {formatDateTimeJa(faq.updatedAt)}</p>
        {source && (
          <a href={`#/helpdesk/${source.id}`} className="mt-1 inline-flex min-h-9 items-center gap-1 text-xs font-semibold text-navy-600 dark:text-navy-300">
            <Headset className="size-3.5" aria-hidden />
            作成元：{source.number}「{source.title}」
          </a>
        )}
        <div className="mt-4 grid grid-cols-2 gap-2 sm:flex">
          <Button variant="secondary" icon={Pencil} onClick={() => setEditing(true)}>
            編集
          </Button>
          <Button
            variant="secondary"
            onClick={() => run((s) => s.helpdesk.setFaqEnabled(faq.id, !faq.enabled), faq.enabled ? '下書き（無効）にしました' : '有効にしました', { undo: () => (s) => s.helpdesk.setFaqEnabled(faq.id, faq.enabled) }).catch(() => undefined)}
          >
            {faq.enabled ? '無効にする' : '有効にする'}
          </Button>
          <Button
            variant="ghost"
            icon={Trash2}
            className="col-span-2 text-red-600 dark:text-red-400"
            onClick={() =>
              run((s) => s.helpdesk.deleteFaq(faq.id), 'FAQを削除しました', { undo: (f) => (s) => s.helpdesk.restoreFaq(f) })
                .then(() => navigate('/faq'))
                .catch(() => undefined)
            }
          >
            削除
          </Button>
        </div>
      </Card>
      <Card className="mt-4">
        <CardHeader title="このFAQを使った問い合わせ" icon={Headset} description={`${linked.length}件`} />
        <div className="px-2 pb-3 pt-2">
          {linked.length === 0 ? (
            <p className="px-3 py-2 text-sm text-slate-500">まだ関連付けられた問い合わせはありません。</p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-navy-800">
              {linked.map((i) => (
                <li key={i.id}>
                  <a href={`#/helpdesk/${i.id}`} className="flex min-h-12 items-center gap-2 rounded-lg px-3 py-2 hover:bg-slate-50 dark:hover:bg-navy-800/60">
                    <span className="font-mono text-[11px] text-slate-400">{i.number}</span>
                    <span className="min-w-0 flex-1 truncate text-sm">{i.title}</span>
                    <InquiryStatusBadge status={i.status} />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
      <FaqFormModal open={editing} onClose={() => setEditing(false)} faq={faq} />
    </>
  );
}
