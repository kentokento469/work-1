/**
 * 問い合わせの業務ルール (純粋関数)。
 * - 状態遷移: 解決済み(resolved) と 完了(closed) を区別し、完了には確認条件を課す
 * - 入力検証 (秘密情報の混入チェックを含む)
 * - 採番・期限計算
 */
import { isValidISODate } from '../date';
import { addBusinessDays as addBusinessDaysCal, toNextBusinessDay } from '../calendar';
import { PRIORITIES, type ISODate, type Inquiry, type InquiryStatus, type Priority, type Task } from '../types';
import type { FieldErrors, ValidationResult } from '../validation';
import { detectSecrets } from './secrets';

/** 受付日 (休みの日なら次の営業日) から n 営業日後。土日・祝日・会社の休業日を除く (Phase 12) */
export function addBusinessDays(from: ISODate, days: number): ISODate {
  return addBusinessDaysCal(toNextBusinessDay(from), days);
}

/** 問い合わせ番号: HD-<年>-<4桁連番> */
export function formatInquiryNumber(year: number, seq: number): string {
  return `HD-${year}-${String(seq).padStart(4, '0')}`;
}

export function parseInquiryNumber(num: string): { year: number; seq: number } | null {
  const m = /^HD-(\d{4})-(\d{4,})$/.exec(num);
  return m ? { year: Number(m[1]), seq: Number(m[2]) } : null;
}

export function nextInquiryNumber(existing: string[], year: number): string {
  let max = 0;
  for (const n of existing) {
    const p = parseInquiryNumber(n);
    if (p && p.year === year) max = Math.max(max, p.seq);
  }
  return formatInquiryNumber(year, max + 1);
}

export interface InquiryInput {
  requesterId: string | null;
  title: string;
  body: string;
  categoryId: string;
  priority: Priority;
  assignee: string;
  dueDate: ISODate;
}

export function validateInquiry(input: InquiryInput, ctx: { employeeIds: string[]; categoryIds: string[] }): ValidationResult<InquiryInput> {
  const e: FieldErrors<InquiryInput> = {};
  if (!input.requesterId) e.requesterId = '申請者を選択してください';
  else if (!ctx.employeeIds.includes(input.requesterId)) e.requesterId = '申請者が社員一覧に存在しません';
  if (!input.title.trim()) e.title = '件名を入力してください';
  else if (input.title.trim().length > 100) e.title = '件名は100文字以内で入力してください';
  if (input.body.length > 4000) e.body = '詳細は4000文字以内で入力してください';
  if (!ctx.categoryIds.includes(input.categoryId)) e.categoryId = 'カテゴリを選択してください';
  if (!PRIORITIES.includes(input.priority)) e.priority = '優先度を選択してください';
  if (input.assignee.length > 50) e.assignee = '担当者は50文字以内で入力してください';
  if (!isValidISODate(input.dueDate)) e.dueDate = '対応期限を正しく入力してください';
  const secretTitle = detectSecrets(input.title);
  const secretBody = detectSecrets(input.body);
  if (secretTitle.length) e.title = `${secretTitle[0]!.label}らしき文字列が含まれています。保存できません`;
  if (secretBody.length) e.body = `${secretBody[0]!.label}らしき文字列が含まれています。伏せ字にしてから保存してください`;
  return { ok: Object.keys(e).length === 0, errors: e };
}

export interface CloseCheck {
  ok: boolean;
  blockers: string[];
}

/** 完了(closed)にできるか。タスク完了 ≠ 問い合わせ完了 なので条件を明示的に確認する */
export function checkClosable(inquiry: Inquiry, linkedTasks: Task[], requesterConfirmed: boolean): CloseCheck {
  const blockers: string[] = [];
  if (inquiry.status !== 'resolved') blockers.push('先に「解決済み」にしてください');
  if (!inquiry.resolution.trim()) blockers.push('解決内容が未記入です');
  const open = linkedTasks.filter((t) => t.status !== 'done');
  if (open.length) blockers.push(`未完了の関連タスクが${open.length}件あります`);
  if (!requesterConfirmed) blockers.push('申請者への解決確認が未チェックです');
  return { ok: blockers.length === 0, blockers };
}

/** 状態遷移の可否。完了は最終状態 (再対応は新しい問い合わせとして受け付ける) */
export function canTransition(from: InquiryStatus, to: InquiryStatus): { ok: boolean; reason?: string } {
  if (from === to) return { ok: false, reason: '同じステータスです' };
  if (from === 'closed') return { ok: false, reason: '完了した問い合わせは変更できません。再発時は新規で受け付けてください' };
  if (to === 'closed') return from === 'resolved' ? { ok: true } : { ok: false, reason: '完了にする前に「解決済み」にしてください' };
  return { ok: true };
}

export function isInquiryOpen(i: Pick<Inquiry, 'status'>): boolean {
  return i.status !== 'resolved' && i.status !== 'closed';
}

export function isInquiryOverdue(i: Pick<Inquiry, 'status' | 'dueDate'>, today: ISODate): boolean {
  return isInquiryOpen(i) && i.dueDate < today;
}
