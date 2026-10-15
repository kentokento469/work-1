/**
 * 問い合わせ詳細。1画面で「状況把握 → 次の一手 → 記録」まで完結させる。
 * - 状態に応じて次にやるべき操作を1つだけ強調表示 (チュートリアルなしで迷わないように)
 * - 関連する社員・タスク・FAQへ1タップで移動できる
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { BackLink } from '../../app/BackLink';
import {
  BookOpenCheck,
  CheckCircle2,
  ClipboardList,
  FileQuestion,
  History,
  ListPlus,
  MessageSquarePlus,
  Pencil,
  Save,
  SendHorizontal,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserRound,
  Zap,
} from 'lucide-react';
import { useAppData } from '../../app/AppData';
import { navigate } from '../../app/router';
import { checkClosable, isInquiryOverdue, type InquiryInput } from '../../domain/helpdesk/inquiry';
import { findSimilarCases, suggestFaqs } from '../../domain/helpdesk/search';
import { maskSecrets } from '../../domain/helpdesk/secrets';
import type { TaskProposal } from '../../domain/helpdesk/taskSuggest';
import { diffDays, formatDateJa, formatDateTimeJa } from '../../domain/date';
import { INQUIRY_STATUS_LABEL, PRIORITY_LABEL, PRIORITIES, type Inquiry, type InquiryStatus, type Priority, type Task } from '../../domain/types';
import type { FieldErrors } from '../../domain/validation';
import type { TaskProposalOverride } from '../../services/helpdeskService';
import { AppError } from '../../services/workcoreService';
import { FaqFormModal } from '../../features/helpdesk/FaqFormModal';
import { InquiryFormFields, type InquiryFormState } from '../../features/helpdesk/InquiryForm';
import { CategoryBadge, InquiryStatusBadge, SecretWarning, SolutionSuggestions } from '../../features/helpdesk/parts';
import { TaskFormModal } from '../../features/TaskFormModal';
import { InquiryEquipmentCard } from '../../features/inventory/RelatedEquipment';
import { RelatedDocumentsCard } from '../../features/documents/light';
import { TaskItem } from '../../features/TaskItem';
import { PriorityBadge } from '../../ui/badges';
import { Modal, ModalCancelButton } from '../../ui/Modal';
import { Badge, Button, Card, CardHeader, EmptyState, TextAreaField, cx } from '../../ui/primitives';

const WORK_STATUSES: InquiryStatus[] = ['new', 'in_progress', 'waiting', 'on_hold'];

export function InquiryDetailPage({ inquiryId, query }: { inquiryId: string; query: URLSearchParams }) {
  const { data, run, deptById, empById, today } = useAppData();
  const inquiry = data.inquiries.find((i) => i.id === inquiryId);
  const [editOpen, setEditOpen] = useState(false);
  const [proposalOpen, setProposalOpen] = useState(false);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [faqOpen, setFaqOpen] = useState(false);
  const [taskEditing, setTaskEditing] = useState<Task | null>(null);
  const justCreated = query.get('created') === '1';

  if (!inquiry)
    return (
      <EmptyState
        icon={FileQuestion}
        title="問い合わせが見つかりません"
        description="削除されたか、URLが正しくない可能性があります"
        action={<Button onClick={() => navigate('/helpdesk')}>問い合わせ一覧へ</Button>}
      />
    );

  const category = data.inquiryCategories.find((c) => c.id === inquiry.categoryId);
  const tasks = data.tasks.filter((t) => t.inquiryId === inquiry.id).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const openTasks = tasks.filter((t) => t.status !== 'done');
  const requester = inquiry.requesterId ? empById.get(inquiry.requesterId) : undefined;
  const overdue = isInquiryOverdue(inquiry, today);
  const closed = inquiry.status === 'closed';

  const setStatus = (to: InquiryStatus) =>
    run((s) => s.helpdesk.changeStatus(inquiry.id, to), `「${INQUIRY_STATUS_LABEL[to]}」にしました`, {
      undo: (r) => (s) => s.helpdesk.changeStatus(inquiry.id, r.previous.status),
    }).catch(() => undefined);

  // 状態に応じた「次にやること」
  const next: { label: string; hint: string; icon: typeof Zap; onClick: () => void } | null = closed
    ? inquiry.resolution && inquiry.faqIds.length === 0
      ? { label: 'この対応をFAQにする', hint: '同じ問い合わせが来たときに候補として提示できます', icon: BookOpenCheck, onClick: () => setFaqOpen(true) }
      : null
    : inquiry.status === 'resolved'
      ? { label: '完了にする', hint: openTasks.length ? `未完了のタスクが${openTasks.length}件あります。完了には全タスクの完了が必要です` : '申請者に解決を確認してから完了にします', icon: CheckCircle2, onClick: () => setCloseOpen(true) }
      : tasks.length === 0
        ? { label: '対応タスクを作成', hint: '内容から必要な作業を提案します。確認してから登録できます', icon: ListPlus, onClick: () => setProposalOpen(true) }
        : openTasks.length === 0
          ? { label: '解決済みにする', hint: '関連タスクがすべて完了しました。解決内容を記録しましょう', icon: CheckCircle2, onClick: () => setResolveOpen(true) }
          : null;

  return (
    <>
      <BackLink href="#/helpdesk">問い合わせ一覧</BackLink>

      {justCreated && (
        <div className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100" role="status">
          <p className="flex items-center gap-1.5 font-semibold">
            <CheckCircle2 className="size-4" aria-hidden />
            {inquiry.number} として受け付けました
          </p>
          <p className="mt-0.5 text-xs">次は「対応タスクを作成」で必要な作業を登録するか、関連FAQを案内してください。</p>
        </div>
      )}

      <Card className="p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span className="font-mono font-semibold text-slate-700 dark:text-slate-200" data-testid="inquiry-number">
            {inquiry.number}
          </span>
          <InquiryStatusBadge status={inquiry.status} />
          <PriorityBadge priority={inquiry.priority} />
          <CategoryBadge category={category} />
          {overdue && <Badge tone="red">期限超過</Badge>}
        </div>
        <h1 className="mt-2 text-xl font-bold text-slate-900 sm:text-2xl dark:text-white">{inquiry.title}</h1>
        {inquiry.body && <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap text-slate-700 dark:text-slate-300">{inquiry.body}</p>}

        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-slate-100 pt-4 text-sm sm:grid-cols-4 dark:border-navy-800">
          <div>
            <dt className="text-xs text-slate-500">申請者</dt>
            <dd className="font-medium">
              {requester ? (
                <a href={`#/employees/${requester.id}`} className="inline-flex items-center gap-1 text-navy-700 underline-offset-2 hover:underline dark:text-navy-200">
                  <UserRound className="size-3.5" aria-hidden />
                  {requester.name}
                </a>
              ) : (
                <span title="社員情報は削除されています">{inquiry.requesterName}</span>
              )}
              <span className="block text-xs font-normal text-slate-500">{inquiry.requesterDepartmentId ? deptById.get(inquiry.requesterDepartmentId)?.name : ''}</span>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">受付日時</dt>
            <dd className="font-medium tabular-nums">{formatDateTimeJa(inquiry.receivedAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">対応期限</dt>
            <dd className={cx('font-medium tabular-nums', overdue && 'text-red-600 dark:text-red-400')}>
              {formatDateJa(inquiry.dueDate)}
              {overdue && <span className="block text-xs">{diffDays(inquiry.dueDate, today)}日超過</span>}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">担当者</dt>
            <dd className="font-medium">{inquiry.assignee || '未割当'}</dd>
          </div>
          {inquiry.resolvedAt && (
            <div>
              <dt className="text-xs text-slate-500">解決日時</dt>
              <dd className="font-medium tabular-nums">{formatDateTimeJa(inquiry.resolvedAt)}</dd>
            </div>
          )}
          {inquiry.closedAt && (
            <div>
              <dt className="text-xs text-slate-500">完了日時</dt>
              <dd className="font-medium tabular-nums">{formatDateTimeJa(inquiry.closedAt)}</dd>
            </div>
          )}
        </dl>

        {!closed && (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" icon={Pencil} onClick={() => setEditOpen(true)}>
              編集
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={Trash2}
              className="text-red-600 dark:text-red-400"
              onClick={() =>
                run((s) => s.helpdesk.deleteInquiry(inquiry.id), `${inquiry.number} を削除しました`, { undo: (d) => (s) => s.helpdesk.restoreInquiry(d) })
                  .then(() => navigate('/helpdesk'))
                  .catch(() => undefined)
              }
            >
              削除
            </Button>
          </div>
        )}
      </Card>

      {/* 次にやること */}
      {next && (
        <div className="mt-4 flex flex-col gap-3 rounded-2xl border border-navy-200 bg-navy-50 p-4 sm:flex-row sm:items-center dark:border-navy-700 dark:bg-navy-900" data-testid="next-action">
          <div className="flex-1">
            <p className="text-xs font-bold text-navy-600 dark:text-navy-300">次にやること</p>
            <p className="text-sm text-slate-700 dark:text-slate-200">{next.hint}</p>
          </div>
          <Button icon={next.icon} onClick={next.onClick}>
            {next.label}
          </Button>
        </div>
      )}

      {/* ステータス */}
      {!closed && (
        <Card className="mt-4 p-4">
          <p className="mb-2 text-xs font-semibold text-slate-500">ステータス</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-6" role="group" aria-label="ステータスを変更">
            {WORK_STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={inquiry.status === s}
                disabled={inquiry.status === s}
                onClick={() => setStatus(s)}
                className={cx(
                  'min-h-11 rounded-lg border text-sm font-semibold transition-colors',
                  inquiry.status === s
                    ? 'border-navy-700 bg-navy-700 text-white dark:border-navy-400 dark:bg-navy-500'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-navy-700 dark:text-slate-300 dark:hover:bg-navy-800',
                )}
              >
                {INQUIRY_STATUS_LABEL[s]}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={inquiry.status === 'resolved'}
              disabled={inquiry.status === 'resolved'}
              onClick={() => setResolveOpen(true)}
              className={cx(
                'min-h-11 rounded-lg border text-sm font-semibold',
                inquiry.status === 'resolved' ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300',
              )}
            >
              解決済み
            </button>
            <button
              type="button"
              onClick={() => setCloseOpen(true)}
              disabled={inquiry.status !== 'resolved'}
              className="min-h-11 rounded-lg border border-slate-300 text-sm font-semibold text-slate-700 disabled:opacity-40 dark:border-navy-700 dark:text-slate-200"
              title={inquiry.status !== 'resolved' ? '「解決済み」にした後に完了にできます' : undefined}
            >
              完了にする
            </button>
          </div>
          <p className="mt-2 text-[11px] text-slate-500">「解決済み」＝対応が終わった状態、「完了」＝申請者の確認が取れて案件を閉じた状態です。</p>
        </Card>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {/* 対応タスク */}
        <Card className="overflow-hidden">
          <CardHeader
            title="対応タスク"
            icon={ClipboardList}
            description={tasks.length ? `完了 ${tasks.length - openTasks.length} / ${tasks.length}件` : 'タスク管理と連動します'}
            action={
              !closed && (
                <Button size="sm" variant="secondary" icon={Sparkles} onClick={() => setProposalOpen(true)}>
                  提案
                </Button>
              )
            }
          />
          {tasks.length === 0 ? (
            <p className="px-5 pb-4 pt-2 text-sm text-slate-500">まだタスクはありません。「提案」から必要な作業を登録できます。</p>
          ) : (
            <ul className="mt-2 divide-y divide-slate-100 border-t border-slate-100 dark:divide-navy-800 dark:border-navy-800" data-testid="inquiry-tasks">
              {tasks.map((t) => (
                <TaskItem key={t.id} task={t} onOpen={setTaskEditing} />
              ))}
            </ul>
          )}
        </Card>

        {/* 解決策 */}
        <SolutionsCard inquiry={inquiry} />
      </div>

      {/* 関連機器 (在庫・資産との連携) */}
      <InquiryEquipmentCard inquiryId={inquiry.id} requesterId={inquiry.requesterId} />
      <RelatedDocumentsCard filter={(d) => d.inquiryId === inquiry.id} newHref={`#/documents/new?inquiry=${inquiry.id}`} />
      <RequesterHistoryCard inquiry={inquiry} />

      {/* 解決内容 */}
      <ResolutionCard inquiry={inquiry} onFaq={() => setFaqOpen(true)} />

      {/* 対応履歴 */}
      <HistoryCard inquiry={inquiry} />

      <EditInquiryModal open={editOpen} onClose={() => setEditOpen(false)} inquiry={inquiry} />
      <TaskProposalModal open={proposalOpen} onClose={() => setProposalOpen(false)} inquiry={inquiry} />
      <ResolveModal open={resolveOpen} onClose={() => setResolveOpen(false)} inquiry={inquiry} />
      <CloseModal open={closeOpen} onClose={() => setCloseOpen(false)} inquiry={inquiry} tasks={tasks} />
      <FaqFormModal open={faqOpen} onClose={() => setFaqOpen(false)} source={inquiry} />
      <TaskFormModal open={!!taskEditing} onClose={() => setTaskEditing(null)} task={taskEditing ?? undefined} />
    </>
  );
}

function SolutionsCard({ inquiry }: { inquiry: Inquiry }) {
  const { data, run } = useAppData();
  const text = `${inquiry.title} ${inquiry.body}`;
  const linked = data.faqs.filter((f) => inquiry.faqIds.includes(f.id));
  const faqs = useMemo(() => {
    const suggested = suggestFaqs(text, data.faqs, { categoryId: inquiry.categoryId, limit: 4 });
    // 関連付け済みのFAQは常に先頭に表示する
    const linkedMatches = linked.filter((f) => !suggested.some((m) => m.faq.id === f.id)).map((faq) => ({ kind: 'faq' as const, faq, score: 1, reasons: ['関連付け済み'] }));
    return [...linkedMatches, ...suggested];
  }, [text, data.faqs, inquiry.categoryId, linked]);
  const cases = useMemo(() => findSimilarCases(text, data.inquiries, { excludeId: inquiry.id, categoryId: inquiry.categoryId, limit: 3 }), [text, data.inquiries, inquiry.id, inquiry.categoryId]);
  return (
    <Card>
      <CardHeader title="解決策の候補" icon={BookOpenCheck} description={linked.length ? `関連付け済みFAQ ${linked.length}件` : 'FAQと過去の対応例から提示'} />
      <div className="p-4 sm:p-5">
        <SolutionSuggestions
          faqs={faqs}
          cases={cases}
          linkedFaqIds={inquiry.faqIds}
          onToggleLink={
            inquiry.status === 'closed'
              ? undefined
              : (faqId, link) => run((s) => s.helpdesk.setFaqLink(inquiry.id, faqId, link), link ? 'FAQを関連付けました' : '関連付けを解除しました').catch(() => undefined)
          }
        />
      </div>
    </Card>
  );
}

function ResolutionCard({ inquiry, onFaq }: { inquiry: Inquiry; onFaq: () => void }) {
  const { run } = useAppData();
  const [text, setText] = useState(inquiry.resolution);
  const [saving, setSaving] = useState(false);
  useEffect(() => setText(inquiry.resolution), [inquiry.resolution]);
  const closed = inquiry.status === 'closed';
  const dirty = text.trim() !== inquiry.resolution;
  return (
    <Card className="mt-4">
      <CardHeader
        title="解決内容"
        icon={CheckCircle2}
        description="実施した対応・結果を記録します（FAQ化の元になります）"
        action={
          inquiry.resolution &&
          (inquiry.status === 'resolved' || closed) && (
            <Button size="sm" variant="secondary" icon={BookOpenCheck} onClick={onFaq}>
              FAQにする
            </Button>
          )
        }
      />
      <div className="p-4 sm:p-5">
        {closed ? (
          <p className="text-sm whitespace-pre-wrap text-slate-700 dark:text-slate-200">{inquiry.resolution || '（記録なし）'}</p>
        ) : (
          <>
            <TextAreaField label="解決内容" value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="例：ルーターを再起動して復旧" maxLength={2000} />
            <SecretWarning text={text} onMask={() => setText(maskSecrets(text))} />
            <div className="mt-2 flex items-center justify-end gap-2">
              {dirty && <span className="text-xs text-amber-700 dark:text-amber-400">未保存の変更があります</span>}
              <Button
                size="sm"
                icon={Save}
                variant="secondary"
                disabled={!dirty}
                loading={saving}
                onClick={async () => {
                  setSaving(true);
                  await run((s) => s.helpdesk.saveResolution(inquiry.id, text), '解決内容を保存しました').catch(() => undefined);
                  setSaving(false);
                }}
              >
                保存
              </Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

function HistoryCard({ inquiry }: { inquiry: Inquiry }) {
  const { run } = useAppData();
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!comment.trim() || sending) return;
    setSending(true);
    try {
      await run((s) => s.helpdesk.addComment(inquiry.id, comment), 'コメントを追加しました');
      setComment('');
    } catch {
      /* トースト表示済み */
    } finally {
      setSending(false);
    }
  };
  const icon = { created: '受', comment: '話', status: '状', update: '編', task: '作', faq: 'F', classification: '分' } as const;
  return (
    <Card className="mt-4">
      <CardHeader title="対応履歴" icon={History} description={`${inquiry.history.length}件`} />
      <div className="p-4 sm:p-5">
        {inquiry.status !== 'closed' && (
          <form onSubmit={submit} className="mb-4">
            <TextAreaField label="コメント・対応メモ" value={comment} onChange={(e) => setComment(e.target.value)} rows={2} placeholder="例：申請者に再起動を依頼済み" maxLength={2000} />
            <SecretWarning text={comment} onMask={() => setComment(maskSecrets(comment))} />
            <div className="mt-2 flex justify-end">
              <Button type="submit" size="sm" icon={SendHorizontal} loading={sending} disabled={!comment.trim()}>
                追加
              </Button>
            </div>
          </form>
        )}
        <ol className="relative space-y-3 border-l border-slate-200 pl-5 dark:border-navy-700" data-testid="inquiry-history">
          {[...inquiry.history].reverse().map((h) => (
            <li key={h.id} className="relative">
              <span
                className={cx(
                  'absolute -left-[31px] top-0 flex size-5 items-center justify-center rounded-full text-[10px] font-bold',
                  h.type === 'comment' ? 'bg-navy-700 text-white' : 'bg-slate-200 text-slate-600 dark:bg-navy-800 dark:text-slate-300',
                )}
                aria-hidden
              >
                {icon[h.type]}
              </span>
              <p className={cx('text-sm whitespace-pre-wrap', h.type === 'comment' ? 'rounded-lg bg-slate-50 p-2 text-slate-800 dark:bg-navy-950 dark:text-slate-100' : 'text-slate-600 dark:text-slate-300')}>
                {h.message}
              </p>
              <p className="mt-0.5 text-[11px] text-slate-400">{formatDateTimeJa(h.at)}</p>
            </li>
          ))}
        </ol>
      </div>
    </Card>
  );
}

function EditInquiryModal({ open, onClose, inquiry }: { open: boolean; onClose: () => void; inquiry: Inquiry }) {
  const { run } = useAppData();
  const initial: InquiryFormState = useMemo(
    () => ({
      input: {
        requesterId: inquiry.requesterId,
        title: inquiry.title,
        body: inquiry.body,
        categoryId: inquiry.categoryId,
        priority: inquiry.priority,
        assignee: inquiry.assignee,
        dueDate: inquiry.dueDate,
      },
      // 編集時は自動入力で既存の値を上書きしない
      touched: { categoryId: true, priority: true, assignee: true, dueDate: true },
    }),
    [inquiry, open],
  );
  const [state, setState] = useState(initial);
  const [errors, setErrors] = useState<FieldErrors<InquiryInput>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) {
      setState(initial);
      setErrors({});
    }
  }, [open, initial]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await run((s) => s.helpdesk.updateInquiry(inquiry.id, state.input), '問い合わせを更新しました');
      onClose();
    } catch (err) {
      if (err instanceof AppError) setErrors(err.fieldErrors as FieldErrors<InquiryInput>);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      dirty={JSON.stringify(state.input) !== JSON.stringify(initial.input)}
      title={`${inquiry.number} の編集`}
      size="lg"
      footer={
        <>
          <ModalCancelButton disabled={saving} />
          <Button type="submit" form="inquiry-edit-form" icon={Save} loading={saving}>
            更新する
          </Button>
        </>
      }
    >
      <form id="inquiry-edit-form" onSubmit={submit} noValidate>
        <InquiryFormFields state={state} setState={setState} errors={errors} classification={null} showClassification={false} />
        <p className="mt-3 text-xs text-slate-500">変更内容は対応履歴に記録されます。</p>
      </form>
    </Modal>
  );
}

/** 対応タスクの提案 → 担当者が確認・調整 → 承認して登録 */
function TaskProposalModal({ open, onClose, inquiry }: { open: boolean; onClose: () => void; inquiry: Inquiry }) {
  const { service, run, deptById } = useAppData();
  const [proposals, setProposals] = useState<TaskProposal[] | null>(null);
  const [overrides, setOverrides] = useState<Record<string, TaskProposalOverride>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setProposals(null);
    setOverrides({});
    service.helpdesk.previewTasks(inquiry.id).then(setProposals).catch(() => setProposals([]));
  }, [open, inquiry.id, service]);

  const fresh = proposals?.filter((p) => p.status === 'new') ?? [];
  const dup = proposals?.filter((p) => p.status === 'duplicate') ?? [];
  const selectedCount = fresh.filter((p) => overrides[p.ruleId]?.selected !== false).length;
  const ov = (id: string, patch: Partial<TaskProposalOverride>) => setOverrides((o) => ({ ...o, [id]: { selected: o[id]?.selected ?? true, ...o[id], ...patch } }));

  const apply = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await run((s) => s.helpdesk.applyTasks(inquiry.id, overrides), (r) => `${r.length}件の対応タスクを登録しました${inquiry.status === 'new' ? '（ステータスを「対応中」に変更）' : ''}`);
      onClose();
    } catch {
      /* トースト表示済み */
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      dirty={Object.keys(overrides).length > 0}
      title="対応タスクの提案"
      description="内容とカテゴリから必要な作業を提案しています。確認・調整してから登録してください"
      size="lg"
      footer={
        <>
          <ModalCancelButton disabled={saving} />
          <Button icon={Zap} onClick={apply} loading={saving} disabled={selectedCount === 0} data-testid="apply-inquiry-tasks">
            {selectedCount}件を承認して登録
          </Button>
        </>
      }
    >
      {!proposals ? (
        <p className="py-6 text-center text-sm text-slate-500">判定中…</p>
      ) : (
        <>
          {fresh.length === 0 ? (
            <EmptyState icon={CheckCircle2} title="新たに作成するタスクはありません" description="提案できるタスクはすべて作成済みです（重複作成は自動で防止されます）" />
          ) : (
            <ul className="space-y-2" data-testid="task-proposals">
              {fresh.map((p) => {
                const o = overrides[p.ruleId];
                const selected = o?.selected !== false;
                return (
                  <li key={p.ruleId} className={cx('rounded-xl border p-3 transition-opacity dark:border-navy-700', !selected && 'opacity-50')}>
                    <label className="flex cursor-pointer items-start gap-3">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={(e) => ov(p.ruleId, { selected: e.target.checked })}
                        className="mt-0.5 size-5 shrink-0 accent-navy-700"
                        aria-label={`${p.title}を登録する`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block font-semibold text-slate-800 dark:text-slate-100">{p.title}</span>
                        <span className="block text-xs text-slate-500">{p.description}</span>
                        <span className="mt-0.5 block text-[11px] text-navy-600 dark:text-navy-300">提案理由：{p.reason}</span>
                      </span>
                    </label>
                    {selected && (
                      <div className="mt-2 grid grid-cols-2 gap-2 pl-8 sm:grid-cols-[1fr_9rem_6rem]">
                        <label className="col-span-2 text-[11px] text-slate-500 sm:col-span-1">
                          担当（{deptById.get(p.assigneeDepartmentId)?.name ?? '不明'}）
                          <input
                            value={o?.assignee ?? p.assignee}
                            onChange={(e) => ov(p.ruleId, { assignee: e.target.value })}
                            placeholder="未定"
                            maxLength={50}
                            className="mt-0.5 block h-10 w-full rounded-lg border border-slate-300 bg-white px-2.5 text-slate-800 dark:border-navy-700 dark:bg-navy-950 dark:text-slate-100"
                          />
                        </label>
                        <label className="text-[11px] text-slate-500">
                          期限
                          <input
                            type="date"
                            value={o?.dueDate ?? p.dueDate}
                            onChange={(e) => ov(p.ruleId, { dueDate: e.target.value })}
                            className="mt-0.5 block h-10 w-full rounded-lg border border-slate-300 bg-white px-2 text-slate-800 dark:border-navy-700 dark:bg-navy-950 dark:text-slate-100"
                          />
                        </label>
                        <label className="text-[11px] text-slate-500">
                          優先度
                          <select
                            value={o?.priority ?? p.priority}
                            onChange={(e) => ov(p.ruleId, { priority: e.target.value as Priority })}
                            className="mt-0.5 block h-10 w-full rounded-lg border border-slate-300 bg-white px-2 text-slate-800 dark:border-navy-700 dark:bg-navy-950 dark:text-slate-100"
                          >
                            {PRIORITIES.map((x) => (
                              <option key={x} value={x}>
                                {PRIORITY_LABEL[x]}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {dup.length > 0 && (
            <p className="mt-3 text-xs text-slate-500">作成済みのため除外：{dup.map((d) => d.title).join('、')}</p>
          )}
        </>
      )}
    </Modal>
  );
}

function ResolveModal({ open, onClose, inquiry }: { open: boolean; onClose: () => void; inquiry: Inquiry }) {
  const { run, data } = useAppData();
  const [text, setText] = useState(inquiry.resolution);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setText(inquiry.resolution);
  }, [open, inquiry.resolution]);
  const linkedFaq = data.faqs.find((f) => inquiry.faqIds.includes(f.id));
  const submit = async () => {
    setSaving(true);
    try {
      await run((s) => s.helpdesk.changeStatus(inquiry.id, 'resolved', { resolution: text }), '解決済みにしました', {
        undo: (r) => (s) => s.helpdesk.changeStatus(inquiry.id, r.previous.status),
      });
      onClose();
    } catch {
      /* トースト表示済み */
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      dirty={text !== inquiry.resolution}
      title="解決済みにする"
      description="実施した対応を記録します。受付から解決までの時間が分析に使われます"
      footer={
        <>
          <ModalCancelButton disabled={saving} />
          <Button icon={CheckCircle2} onClick={submit} loading={saving} disabled={!text.trim()} data-testid="confirm-resolve">
            解決済みにする
          </Button>
        </>
      }
    >
      <TextAreaField label="解決内容" required value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder="例：Teamsのキャッシュを削除して再サインインで解決" maxLength={2000} />
      <SecretWarning text={text} onMask={() => setText(maskSecrets(text))} />
      {linkedFaq && !text.trim() && (
        <Button size="sm" variant="ghost" className="mt-2" onClick={() => setText(`FAQ「${linkedFaq.question}」の手順で解決`)}>
          関連FAQの手順で解決した
        </Button>
      )}
      {data.tasks.some((t) => t.inquiryId === inquiry.id && t.status !== 'done') && (
        <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">未完了の関連タスクがあります。解決済みにはできますが、完了にするには全タスクの完了が必要です。</p>
      )}
    </Modal>
  );
}

function CloseModal({ open, onClose, inquiry, tasks }: { open: boolean; onClose: () => void; inquiry: Inquiry; tasks: Task[] }) {
  const { run } = useAppData();
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setConfirmed(false);
  }, [open]);
  const check = checkClosable(inquiry, tasks, confirmed);
  const items = [
    { ok: inquiry.status === 'resolved', label: '「解決済み」になっている' },
    { ok: !!inquiry.resolution.trim(), label: '解決内容が記録されている' },
    { ok: tasks.every((t) => t.status === 'done'), label: tasks.length ? `関連タスクがすべて完了（${tasks.filter((t) => t.status === 'done').length}/${tasks.length}）` : '関連タスクなし' },
  ];
  const submit = async () => {
    setSaving(true);
    try {
      await run((s) => s.helpdesk.closeInquiry(inquiry.id, confirmed), `${inquiry.number} を完了にしました`);
      onClose();
    } catch {
      /* トースト表示済み */
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="問い合わせを完了にする"
      description="完了にすると編集できなくなります。再発した場合は新しい問い合わせとして受け付けます"
      footer={
        <>
          <ModalCancelButton disabled={saving} />
          <Button icon={ShieldCheck} onClick={submit} loading={saving} disabled={!check.ok} data-testid="confirm-close">
            完了にする
          </Button>
        </>
      }
    >
      <ul className="space-y-2" data-testid="close-checklist">
        {items.map((it) => (
          <li key={it.label} className={cx('flex items-center gap-2 text-sm', it.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-600 dark:text-red-400')}>
            {it.ok ? <CheckCircle2 className="size-4 shrink-0" aria-hidden /> : <span className="flex size-4 shrink-0 items-center justify-center text-xs font-bold">×</span>}
            {it.label}
          </li>
        ))}
      </ul>
      <label className="mt-4 flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-slate-200 p-3 text-sm dark:border-navy-700">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="size-5 shrink-0 accent-navy-700" />
        申請者（{inquiry.requesterName}さん）に解決したことを確認した
      </label>
      {!check.ok && check.blockers.length > 0 && <p className="mt-2 text-xs text-slate-500">残りの条件：{check.blockers.join('／')}</p>}
      <p className="mt-3 flex items-center gap-1 text-xs text-slate-500">
        <MessageSquarePlus className="size-3.5" aria-hidden />
        確認の経緯はコメントに残しておくと後から追跡できます。
      </p>
    </Modal>
  );
}

/** 同じ申請者の他の問い合わせ (過去の経緯・同じ不具合の再発に気付けるように) */
function RequesterHistoryCard({ inquiry }: { inquiry: Inquiry }) {
  const { data } = useAppData();
  if (!inquiry.requesterId) return null;
  const others = data.inquiries.filter((i) => i.requesterId === inquiry.requesterId && i.id !== inquiry.id).slice(0, 5);
  if (!others.length) return null;
  return (
    <Card className="mt-4" data-testid="requester-history">
      <CardHeader title={`${inquiry.requesterName}さんの他の問い合わせ`} icon={History} description={`${others.length}件（新しい順）`} />
      <ul className="divide-y divide-slate-100 px-4 pb-2 sm:px-5 dark:divide-navy-800">
        {others.map((i) => (
          <li key={i.id}>
            <a href={`#/helpdesk/${i.id}`} className="flex min-h-12 items-center gap-2 py-2 text-sm">
              <span className="font-mono text-xs text-slate-500">{i.number}</span>
              <span className="min-w-0 flex-1 truncate">{i.title}</span>
              <span className="text-xs text-slate-500">{INQUIRY_STATUS_LABEL[i.status]}</span>
            </a>
          </li>
        ))}
      </ul>
    </Card>
  );
}
