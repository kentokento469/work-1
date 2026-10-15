/**
 * ヘルプデスク (問い合わせ・FAQ・カテゴリ) のアプリケーションサービス。
 *
 * 設計上のポイント:
 * - 二重送信防止: 問い合わせ登録は requestId (フォームごとに1つ) で冪等にする。
 *   同じ requestId で再送されても新しい問い合わせは作られず、最初の結果を返す (決済APIの冪等キーと同じ考え方)
 * - タスク完了 ≠ 問い合わせ完了: 完了 (closed) には解決内容・関連タスク完了・申請者確認を必須にする
 * - 秘密情報: 本文・コメント・解決内容・FAQ に秘密情報らしき文字列があれば保存しない
 * - 操作履歴 (activities) には番号と件名だけを書き、本文やコメントは書かない
 */
import type { WorkCoreDB } from '../data/db';
import { today as todayISO } from '../domain/date';
import { generateId, nowISO } from '../domain/id';
import { canTransition, checkClosable, nextInquiryNumber, validateInquiry, type InquiryInput } from '../domain/helpdesk/inquiry';
import { detectSecrets } from '../domain/helpdesk/secrets';
import { proposeInquiryTasks, type TaskProposal } from '../domain/helpdesk/taskSuggest';
import { normalizeTitle } from '../automation/onboardingEngine';
import {
  INQUIRY_STATUS_LABEL,
  PRIORITY_LABEL,
  type ClassificationSnapshot,
  type Faq,
  type Inquiry,
  type InquiryCategory,
  type InquiryStatus,
  type Priority,
  type Task,
} from '../domain/types';
import { AppError, abortWith, fieldError, inquiryEvent, logActivity } from './common';

export interface FaqInput {
  question: string;
  answer: string;
  categoryId: string;
  keywords: string[];
  enabled: boolean;
}

export type CategoryInput = Pick<InquiryCategory, 'name' | 'keywords' | 'defaultDepartmentId' | 'defaultAssignee' | 'slaBusinessDays' | 'enabled'>;

export interface TaskProposalOverride {
  selected: boolean;
  assignee?: string;
  dueDate?: string;
  priority?: Priority;
}

export interface DeletedInquiry {
  inquiry: Inquiry;
  unlinkedTaskIds: string[];
  unlinkedDocumentIds?: string[];
}

function secretError(field: string, text: string): AppError | null {
  const f = detectSecrets(text);
  return f.length ? new AppError(`${field}に${f[0]!.label}らしき文字列が含まれています。伏せ字にしてから保存してください`, { [field]: '秘密情報が含まれています' }) : null;
}

export class HelpdeskService {
  constructor(private readonly db: WorkCoreDB, private readonly clock: () => string = todayISO) {}

  // ---------- 問い合わせ ----------

  /**
   * 問い合わせを受け付ける。
   * @param requestId フォームを開いた時に発行する一意キー。連打・通信再試行での二重登録を防ぐ
   */
  async createInquiry(input: InquiryInput, opts: { requestId: string; classification: ClassificationSnapshot | null }): Promise<{ inquiry: Inquiry; duplicated: boolean }> {
    const tx = this.db.transaction(['inquiries', 'employees', 'inquiryCategories', 'meta', 'activities'], 'readwrite');
    const reqKey = `req:${opts.requestId}`;
    const prior = await tx.objectStore('meta').get(reqKey);
    if (prior) {
      const existing = await tx.objectStore('inquiries').get(String(prior.value));
      await tx.done;
      if (existing) return { inquiry: existing, duplicated: true };
      throw new AppError('この内容は既に処理済みです。一覧を確認してください');
    }
    // 注意: index.getAllKeys() は主キー(ID)を返すため、番号は値から取り出す
    const [employees, catIds, existing] = await Promise.all([
      tx.objectStore('employees').getAll(),
      tx.objectStore('inquiryCategories').getAllKeys(),
      tx.objectStore('inquiries').getAll(),
    ]);
    const numbers = existing.map((i) => i.number);
    const v = validateInquiry(input, { employeeIds: employees.map((e) => e.id), categoryIds: catIds });
    if (!v.ok) return abortWith(tx, fieldError(v.errors));
    const requester = employees.find((e) => e.id === input.requesterId)!;
    const now = nowISO();
    const number = nextInquiryNumber(numbers, Number(this.clock().slice(0, 4)));
    const history = [inquiryEvent('created', `${requester.name}さんから受付（${number}）`)];
    if (opts.classification) {
      const c = opts.classification;
      history.push(
        inquiryEvent(
          'classification',
          `自動分類：${c.needsReview ? '要確認' : '候補'}カテゴリ${c.categoryAccepted ? 'を採用' : 'を担当者が変更'}、優先度候補「${PRIORITY_LABEL[c.suggestedPriority]}」${c.priorityAccepted ? 'を採用' : 'を担当者が変更'}`,
        ),
      );
    }
    const inquiry: Inquiry = {
      id: generateId('inq'),
      number,
      receivedAt: now,
      requesterId: requester.id,
      requesterName: requester.name,
      requesterDepartmentId: requester.departmentId,
      title: input.title.trim(),
      body: input.body.trim(),
      categoryId: input.categoryId,
      priority: input.priority,
      assignee: input.assignee.trim(),
      dueDate: input.dueDate,
      status: 'new',
      resolution: '',
      resolvedAt: null,
      closedAt: null,
      classification: opts.classification,
      faqIds: [],
      history,
      createdAt: now,
      updatedAt: now,
    };
    await tx.objectStore('inquiries').add(inquiry);
    await tx.objectStore('meta').put({ key: reqKey, value: inquiry.id });
    await logActivity(tx, 'inquiry', 'create', `問い合わせ ${number}「${inquiry.title}」を受け付けました`, inquiry.id);
    await tx.done;
    return { inquiry, duplicated: false };
  }

  async updateInquiry(id: string, input: InquiryInput): Promise<Inquiry> {
    const tx = this.db.transaction(['inquiries', 'employees', 'inquiryCategories', 'activities'], 'readwrite');
    const current = await tx.objectStore('inquiries').get(id);
    if (!current) return abortWith(tx, '対象の問い合わせが見つかりません');
    if (current.status === 'closed') return abortWith(tx, '完了した問い合わせは編集できません');
    const [employees, cats] = await Promise.all([tx.objectStore('employees').getAll(), tx.objectStore('inquiryCategories').getAll()]);
    // 社員削除済みの申請者はそのまま維持できるようにする
    const employeeIds = employees.map((e) => e.id);
    if (input.requesterId && input.requesterId === current.requesterId && !employeeIds.includes(input.requesterId)) employeeIds.push(input.requesterId);
    const v = validateInquiry(input, { employeeIds, categoryIds: cats.map((c) => c.id) });
    if (!v.ok) return abortWith(tx, fieldError(v.errors));

    const changes: string[] = [];
    const catName = (cid: string) => cats.find((c) => c.id === cid)?.name ?? '不明';
    if (current.categoryId !== input.categoryId) changes.push(`カテゴリ：${catName(current.categoryId)} → ${catName(input.categoryId)}`);
    if (current.priority !== input.priority) changes.push(`優先度：${PRIORITY_LABEL[current.priority]} → ${PRIORITY_LABEL[input.priority]}`);
    if (current.assignee !== input.assignee.trim()) changes.push(`担当者：${current.assignee || '未割当'} → ${input.assignee.trim() || '未割当'}`);
    if (current.dueDate !== input.dueDate) changes.push(`期限：${current.dueDate} → ${input.dueDate}`);
    if (current.title !== input.title.trim() || current.body !== input.body.trim()) changes.push('件名・内容を編集');
    let requester = { id: current.requesterId, name: current.requesterName, dept: current.requesterDepartmentId };
    if (input.requesterId !== current.requesterId) {
      const e = employees.find((x) => x.id === input.requesterId)!;
      requester = { id: e.id, name: e.name, dept: e.departmentId };
      changes.push(`申請者：${current.requesterName} → ${e.name}`);
    }
    if (changes.length === 0) {
      await tx.done;
      return current;
    }
    const ev = inquiryEvent('update', changes.join('／'));
    const updated: Inquiry = {
      ...current,
      requesterId: requester.id,
      requesterName: requester.name,
      requesterDepartmentId: requester.dept,
      title: input.title.trim(),
      body: input.body.trim(),
      categoryId: input.categoryId,
      priority: input.priority,
      assignee: input.assignee.trim(),
      dueDate: input.dueDate,
      history: [...current.history, ev],
      updatedAt: ev.at,
    };
    await tx.objectStore('inquiries').put(updated);
    await logActivity(tx, 'inquiry', 'update', `問い合わせ ${updated.number} を更新しました`, id);
    await tx.done;
    return updated;
  }

  /**
   * ステータス変更 (完了以外)。解決済みにするには解決内容が必要。
   * 戻り値の previous は Undo 用。
   */
  async changeStatus(id: string, to: InquiryStatus, opts: { resolution?: string } = {}): Promise<{ inquiry: Inquiry; previous: Inquiry }> {
    if (to === 'closed') throw new AppError('完了にするには「完了にする」から確認項目をチェックしてください');
    const tx = this.db.transaction(['inquiries', 'activities'], 'readwrite');
    const current = await tx.objectStore('inquiries').get(id);
    if (!current) return abortWith(tx, '対象の問い合わせが見つかりません');
    const t = canTransition(current.status, to);
    if (!t.ok) return abortWith(tx, t.reason ?? 'このステータスには変更できません');
    const resolution = (opts.resolution ?? current.resolution).trim();
    if (to === 'resolved') {
      if (!resolution) return abortWith(tx, new AppError('解決済みにするには解決内容を入力してください', { resolution: '解決内容を入力してください' }));
      const se = secretError('resolution', resolution);
      if (se) return abortWith(tx, se);
    }
    const now = nowISO();
    const events = [inquiryEvent('status', `ステータス：${INQUIRY_STATUS_LABEL[current.status]} → ${INQUIRY_STATUS_LABEL[to]}`)];
    if (to === 'resolved' && resolution !== current.resolution) events.push(inquiryEvent('update', '解決内容を記録'));
    const updated: Inquiry = {
      ...current,
      status: to,
      resolution,
      // 解決時間は「最初に解決済みになった時刻」で計測する (再オープン後も上書きしない)
      resolvedAt: to === 'resolved' ? (current.resolvedAt ?? now) : current.resolvedAt,
      history: [...current.history, ...events],
      updatedAt: now,
    };
    await tx.objectStore('inquiries').put(updated);
    await logActivity(tx, 'inquiry', 'status', `問い合わせ ${current.number} を「${INQUIRY_STATUS_LABEL[to]}」にしました`, id);
    await tx.done;
    return { inquiry: updated, previous: current };
  }

  async saveResolution(id: string, resolution: string): Promise<Inquiry> {
    const se = secretError('resolution', resolution);
    if (se) throw se;
    const tx = this.db.transaction(['inquiries'], 'readwrite');
    const current = await tx.objectStore('inquiries').get(id);
    if (!current) return abortWith(tx, '対象の問い合わせが見つかりません');
    if (current.status === 'closed') return abortWith(tx, '完了した問い合わせは編集できません');
    if (current.resolution === resolution.trim()) {
      await tx.done;
      return current;
    }
    const ev = inquiryEvent('update', '解決内容を更新');
    const updated = { ...current, resolution: resolution.trim(), history: [...current.history, ev], updatedAt: ev.at };
    await tx.objectStore('inquiries').put(updated);
    await tx.done;
    return updated;
  }

  /** 完了: 解決済み + 解決内容あり + 関連タスク全完了 + 申請者確認 */
  async closeInquiry(id: string, requesterConfirmed: boolean): Promise<Inquiry> {
    const tx = this.db.transaction(['inquiries', 'tasks', 'activities'], 'readwrite');
    const current = await tx.objectStore('inquiries').get(id);
    if (!current) return abortWith(tx, '対象の問い合わせが見つかりません');
    const tasks = await tx.objectStore('tasks').index('byInquiry').getAll(id);
    const check = checkClosable(current, tasks, requesterConfirmed);
    if (!check.ok) return abortWith(tx, `完了にできません：${check.blockers.join('／')}`);
    const now = nowISO();
    const updated: Inquiry = {
      ...current,
      status: 'closed',
      closedAt: now,
      history: [...current.history, inquiryEvent('status', 'ステータス：解決済み → 完了（申請者の確認済み）')],
      updatedAt: now,
    };
    await tx.objectStore('inquiries').put(updated);
    await logActivity(tx, 'inquiry', 'close', `問い合わせ ${current.number} を完了にしました`, id);
    await tx.done;
    return updated;
  }

  async addComment(id: string, text: string): Promise<Inquiry> {
    const body = text.trim();
    if (!body) throw new AppError('コメントを入力してください');
    if (body.length > 2000) throw new AppError('コメントは2000文字以内で入力してください');
    const se = secretError('comment', body);
    if (se) throw se;
    const tx = this.db.transaction(['inquiries'], 'readwrite');
    const current = await tx.objectStore('inquiries').get(id);
    if (!current) return abortWith(tx, '対象の問い合わせが見つかりません');
    const ev = inquiryEvent('comment', body);
    const updated = { ...current, history: [...current.history, ev], updatedAt: ev.at };
    await tx.objectStore('inquiries').put(updated);
    await tx.done;
    return updated;
  }

  /** 削除。関連タスクは残し、紐付けだけ外す (タスクは業務記録のため)。戻り値は Undo 用 */
  async deleteInquiry(id: string): Promise<DeletedInquiry> {
    const tx = this.db.transaction(['inquiries', 'tasks', 'activities', 'documents'], 'readwrite');
    const inquiry = await tx.objectStore('inquiries').get(id);
    if (!inquiry) return abortWith(tx, '対象の問い合わせが見つかりません');
    const tasks = await tx.objectStore('tasks').index('byInquiry').getAll(id);
    for (const t of tasks) await tx.objectStore('tasks').put({ ...t, inquiryId: null, updatedAt: nowISO() });
    // 関連書類は削除せず、関連付けだけを外す
    const docs = (await tx.objectStore('documents').getAll()).filter((d) => d.inquiryId === id);
    for (const d of docs) await tx.objectStore('documents').put({ ...d, inquiryId: null, updatedAt: nowISO() });
    await tx.objectStore('inquiries').delete(id);
    await logActivity(tx, 'inquiry', 'delete', `問い合わせ ${inquiry.number} を削除しました`, id);
    await tx.done;
    return { inquiry, unlinkedTaskIds: tasks.map((t) => t.id), unlinkedDocumentIds: docs.map((d) => d.id) };
  }

  async restoreInquiry(deleted: DeletedInquiry): Promise<void> {
    const tx = this.db.transaction(['inquiries', 'tasks', 'activities', 'documents'], 'readwrite');
    if (await tx.objectStore('inquiries').index('byNumber').get(deleted.inquiry.number)) return abortWith(tx, '同じ番号の問い合わせが既に存在します');
    await tx.objectStore('inquiries').put(deleted.inquiry);
    for (const did of deleted.unlinkedDocumentIds ?? []) {
      const d = await tx.objectStore('documents').get(did);
      if (d && d.inquiryId === null) await tx.objectStore('documents').put({ ...d, inquiryId: deleted.inquiry.id });
    }
    for (const tid of deleted.unlinkedTaskIds) {
      const t = await tx.objectStore('tasks').get(tid);
      if (t && t.inquiryId === null) await tx.objectStore('tasks').put({ ...t, inquiryId: deleted.inquiry.id });
    }
    await logActivity(tx, 'inquiry', 'restore', `問い合わせ ${deleted.inquiry.number} の削除を取り消しました`, deleted.inquiry.id);
    await tx.done;
  }

  // ---------- 問い合わせ → タスク ----------

  async previewTasks(id: string): Promise<TaskProposal[]> {
    const tx = this.db.transaction(['inquiries', 'inquiryCategories', 'tasks', 'departments'], 'readonly');
    const inquiry = await tx.objectStore('inquiries').get(id);
    if (!inquiry) throw new AppError('対象の問い合わせが見つかりません');
    const [category, existingTasks, departmentIds] = await Promise.all([
      tx.objectStore('inquiryCategories').get(inquiry.categoryId),
      tx.objectStore('tasks').index('byInquiry').getAll(id),
      tx.objectStore('departments').getAllKeys(),
    ]);
    await tx.done;
    return proposeInquiryTasks({ inquiry, category, existingTasks, departmentIds, today: this.clock() });
  }

  /**
   * 承認したタスク候補を登録する。書き込みトランザクション内で候補を再計算し、
   * 同じ問い合わせからの重複 (同じルール / 同名タスク) は登録しない。
   * 新規の問い合わせは「対応中」に進める。
   */
  async applyTasks(id: string, overrides: Record<string, TaskProposalOverride>): Promise<Task[]> {
    const tx = this.db.transaction(['inquiries', 'inquiryCategories', 'tasks', 'departments', 'activities'], 'readwrite');
    const inquiry = await tx.objectStore('inquiries').get(id);
    if (!inquiry) return abortWith(tx, '対象の問い合わせが見つかりません');
    if (inquiry.status === 'closed') return abortWith(tx, '完了した問い合わせにはタスクを追加できません');
    const [category, existingTasks, departmentIds] = await Promise.all([
      tx.objectStore('inquiryCategories').get(inquiry.categoryId),
      tx.objectStore('tasks').index('byInquiry').getAll(id),
      tx.objectStore('departments').getAllKeys(),
    ]);
    const proposals = proposeInquiryTasks({ inquiry, category, existingTasks, departmentIds, today: this.clock() });
    const now = nowISO();
    const seen = new Set(existingTasks.map((t) => normalizeTitle(t.title)));
    const tasks: Task[] = [];
    for (const p of proposals) {
      const o = overrides[p.ruleId];
      if (p.status !== 'new' || (o && !o.selected) || seen.has(normalizeTitle(p.title))) continue;
      seen.add(normalizeTitle(p.title));
      tasks.push({
        id: generateId('task'),
        employeeId: null,
        title: p.title,
        description: `${p.description}\n（問い合わせ ${inquiry.number}「${inquiry.title}」より作成）`,
        assigneeDepartmentId: p.assigneeDepartmentId,
        assignee: (o?.assignee ?? p.assignee).trim(),
        priority: o?.priority ?? p.priority,
        dueDate: o?.dueDate || p.dueDate,
        status: 'todo',
        source: 'inquiry',
        ruleId: p.ruleId,
        inquiryId: inquiry.id,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      });
    }
    if (tasks.length === 0) return abortWith(tx, '登録対象のタスクがありません（すべて作成済みまたは未選択です）');
    for (const t of tasks) await tx.objectStore('tasks').add(t);
    const events = [inquiryEvent('task', `対応タスクを${tasks.length}件作成：${tasks.map((t) => t.title).join('、')}`)];
    let status = inquiry.status;
    if (inquiry.status === 'new') {
      status = 'in_progress';
      events.push(inquiryEvent('status', 'ステータス：新規 → 対応中（タスク作成により自動変更）'));
    }
    await tx.objectStore('inquiries').put({ ...inquiry, status, history: [...inquiry.history, ...events], updatedAt: now });
    await logActivity(tx, 'inquiry', 'tasks', `問い合わせ ${inquiry.number} から対応タスクを${tasks.length}件作成しました`, id);
    await tx.done;
    return tasks;
  }

  // ---------- FAQ ----------

  private validateFaq(input: FaqInput, categoryIds: string[]): AppError | null {
    const e: Record<string, string> = {};
    if (!input.question.trim()) e.question = '質問（タイトル）を入力してください';
    else if (input.question.trim().length > 120) e.question = '質問は120文字以内で入力してください';
    if (!input.answer.trim()) e.answer = '解決手順を入力してください';
    else if (input.answer.length > 4000) e.answer = '解決手順は4000文字以内で入力してください';
    if (!categoryIds.includes(input.categoryId)) e.categoryId = 'カテゴリを選択してください';
    if (input.keywords.length > 20) e.keywords = 'キーワードは20個までです';
    for (const [field, text] of [['question', input.question], ['answer', input.answer], ['keywords', input.keywords.join(' ')]] as const) {
      const f = detectSecrets(text);
      if (f.length) e[field] = `${f[0]!.label}らしき文字列が含まれています。FAQには保存できません`;
    }
    return Object.keys(e).length ? new AppError(Object.values(e)[0]!, e) : null;
  }

  async saveFaq(input: FaqInput, id?: string, opts: { sourceInquiryId?: string } = {}): Promise<Faq> {
    const tx = this.db.transaction(['faqs', 'inquiryCategories', 'inquiries', 'activities'], 'readwrite');
    const err = this.validateFaq(input, await tx.objectStore('inquiryCategories').getAllKeys());
    if (err) return abortWith(tx, err);
    const now = nowISO();
    const clean = {
      question: input.question.trim(),
      answer: input.answer.trim(),
      categoryId: input.categoryId,
      keywords: [...new Set(input.keywords.map((k) => k.trim()).filter(Boolean))],
      enabled: input.enabled,
    };
    let faq: Faq;
    if (id) {
      const current = await tx.objectStore('faqs').get(id);
      if (!current) return abortWith(tx, '対象のFAQが見つかりません');
      faq = { ...current, ...clean, updatedAt: now };
    } else {
      faq = { id: generateId('faq'), ...clean, sourceInquiryId: opts.sourceInquiryId ?? null, createdAt: now, updatedAt: now };
    }
    await tx.objectStore('faqs').put(faq);
    if (!id && opts.sourceInquiryId) {
      const inq = await tx.objectStore('inquiries').get(opts.sourceInquiryId);
      if (inq)
        await tx.objectStore('inquiries').put({
          ...inq,
          faqIds: [...new Set([...inq.faqIds, faq.id])],
          history: [...inq.history, inquiryEvent('faq', `この対応をFAQ「${faq.question}」として${faq.enabled ? '公開' : '下書き保存'}`)],
          updatedAt: now,
        });
    }
    await logActivity(tx, 'faq', id ? 'update' : 'create', `FAQ「${faq.question}」を${id ? '更新' : '登録'}しました`, faq.id);
    await tx.done;
    return faq;
  }

  async setFaqEnabled(id: string, enabled: boolean): Promise<Faq> {
    const tx = this.db.transaction(['faqs', 'activities'], 'readwrite');
    const current = await tx.objectStore('faqs').get(id);
    if (!current) return abortWith(tx, '対象のFAQが見つかりません');
    const faq = { ...current, enabled, updatedAt: nowISO() };
    await tx.objectStore('faqs').put(faq);
    await logActivity(tx, 'faq', 'toggle', `FAQ「${faq.question}」を${enabled ? '有効' : '無効'}にしました`, id);
    await tx.done;
    return faq;
  }

  async deleteFaq(id: string): Promise<Faq> {
    const tx = this.db.transaction(['faqs', 'activities'], 'readwrite');
    const current = await tx.objectStore('faqs').get(id);
    if (!current) return abortWith(tx, '対象のFAQが見つかりません');
    await tx.objectStore('faqs').delete(id);
    // 問い合わせ側の faqIds は履歴として残し、表示時に存在しないFAQは除外する
    await logActivity(tx, 'faq', 'delete', `FAQ「${current.question}」を削除しました`, id);
    await tx.done;
    return current;
  }

  async restoreFaq(faq: Faq): Promise<void> {
    const tx = this.db.transaction(['faqs', 'activities'], 'readwrite');
    await tx.objectStore('faqs').put(faq);
    await logActivity(tx, 'faq', 'restore', `FAQ「${faq.question}」の削除を取り消しました`, faq.id);
    await tx.done;
  }

  /** 問い合わせにFAQを関連付ける / 外す */
  async setFaqLink(inquiryId: string, faqId: string, linked: boolean): Promise<Inquiry> {
    const tx = this.db.transaction(['inquiries', 'faqs'], 'readwrite');
    const inq = await tx.objectStore('inquiries').get(inquiryId);
    const faq = await tx.objectStore('faqs').get(faqId);
    if (!inq || !faq) return abortWith(tx, '問い合わせまたはFAQが見つかりません');
    const has = inq.faqIds.includes(faqId);
    if (has === linked) {
      await tx.done;
      return inq;
    }
    const ev = inquiryEvent('faq', `FAQ「${faq.question}」を${linked ? '関連付け' : '関連付け解除'}`);
    const updated = { ...inq, faqIds: linked ? [...inq.faqIds, faqId] : inq.faqIds.filter((x) => x !== faqId), history: [...inq.history, ev], updatedAt: ev.at };
    await tx.objectStore('inquiries').put(updated);
    await tx.done;
    return updated;
  }

  // ---------- カテゴリ ----------

  async saveCategory(input: CategoryInput, id?: string): Promise<InquiryCategory> {
    const name = input.name.trim();
    const e: Record<string, string> = {};
    if (!name) e.name = 'カテゴリ名を入力してください';
    else if (name.length > 30) e.name = 'カテゴリ名は30文字以内で入力してください';
    if (!Number.isInteger(input.slaBusinessDays) || input.slaBusinessDays < 0 || input.slaBusinessDays > 30) e.slaBusinessDays = '対応期限は0〜30営業日で指定してください';
    if (input.keywords.length > 60) e.keywords = 'キーワードは60個までです';
    if (Object.keys(e).length) throw new AppError(Object.values(e)[0]!, e);
    const tx = this.db.transaction(['inquiryCategories', 'departments', 'activities'], 'readwrite');
    const [all, deptIds] = await Promise.all([tx.objectStore('inquiryCategories').getAll(), tx.objectStore('departments').getAllKeys()]);
    if (all.some((c) => c.id !== id && c.name === name)) return abortWith(tx, new AppError(`カテゴリ「${name}」は既に存在します`, { name: '同名のカテゴリがあります' }));
    const dept = input.defaultDepartmentId && deptIds.includes(input.defaultDepartmentId) ? input.defaultDepartmentId : null;
    const clean = {
      name,
      keywords: [...new Set(input.keywords.map((k) => k.trim()).filter(Boolean))],
      defaultDepartmentId: dept,
      defaultAssignee: input.defaultAssignee.trim(),
      slaBusinessDays: input.slaBusinessDays,
      enabled: input.enabled,
    };
    let cat: InquiryCategory;
    if (id) {
      const current = all.find((c) => c.id === id);
      if (!current) return abortWith(tx, '対象のカテゴリが見つかりません');
      if (current.isFallback && !input.enabled) return abortWith(tx, '「その他・要確認」は無効にできません');
      cat = { ...current, ...clean };
    } else {
      const maxOrder = all.filter((c) => !c.isFallback).reduce((m, c) => Math.max(m, c.order), 0);
      cat = { id: generateId('cat'), ...clean, order: maxOrder + 1, isFallback: false };
    }
    await tx.objectStore('inquiryCategories').put(cat);
    await logActivity(tx, 'category', id ? 'update' : 'create', `問い合わせカテゴリ「${cat.name}」を${id ? '更新' : '追加'}しました`, cat.id);
    await tx.done;
    return cat;
  }

  /** 使用中のカテゴリは削除せず「無効化」を案内する (過去データの意味が変わらないように) */
  async deleteCategory(id: string): Promise<void> {
    const tx = this.db.transaction(['inquiryCategories', 'inquiries', 'faqs', 'activities'], 'readwrite');
    const current = await tx.objectStore('inquiryCategories').get(id);
    if (!current) return abortWith(tx, '対象のカテゴリが見つかりません');
    if (current.isFallback) return abortWith(tx, '「その他・要確認」は削除できません');
    const [inqs, faqs] = await Promise.all([tx.objectStore('inquiries').getAll(), tx.objectStore('faqs').getAll()]);
    const used = inqs.filter((i) => i.categoryId === id).length + faqs.filter((f) => f.categoryId === id).length;
    if (used > 0) return abortWith(tx, `このカテゴリは問い合わせ・FAQで${used}件使用中のため削除できません。代わりに「無効」にしてください`);
    await tx.objectStore('inquiryCategories').delete(id);
    await logActivity(tx, 'category', 'delete', `問い合わせカテゴリ「${current.name}」を削除しました`, id);
    await tx.done;
  }
}
