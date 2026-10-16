/**
 * サービス層の共通処理: エラー型・トランザクション型・操作履歴の記録。
 */
import type { IDBPTransaction, StoreNames } from 'idb';
import { generateId, nowISO } from '../domain/id';
import type { ActivityCategory, ActivityLog, Inquiry, InquiryEvent, InquiryEventType } from '../domain/types';
import type { FieldErrors } from '../domain/validation';
import type { WorkCoreSchema } from '../data/db';

/** 利用者に表示してよいメッセージを持つ業務エラー */
export class AppError extends Error {
  constructor(message: string, public readonly fieldErrors: Record<string, string> = {}) {
    super(message);
    this.name = 'AppError';
  }
}

export type WriteTx = IDBPTransaction<WorkCoreSchema, StoreNames<WorkCoreSchema>[], 'readwrite'>;

export const MAX_ACTIVITIES = 300;

/** トランザクションを取り消してから業務エラーを投げる (部分的な書き込みを残さない) */
export async function abortWith(tx: { abort(): void; done: Promise<void> }, error: AppError | string): Promise<never> {
  try {
    tx.abort();
  } catch {
    /* 既に終了している場合 */
  }
  await tx.done.catch(() => undefined);
  throw typeof error === 'string' ? new AppError(error) : error;
}

/**
 * トランザクション内の処理で例外が起きたら、必ずトランザクションを取り消す。
 * IndexedDB は「書き込み要求の失敗」なら自動で取り消すが、put などが同期的に投げる例外 (キーの無いレコードなど) では
 * 取り消さず、それまでの書き込みが確定してしまう。全件の置き換え (復元・初期化) などで部分的な書き込みを残さないために使う
 */
export async function guardTx<T>(tx: { abort(): void; done: Promise<void> }, fn: () => Promise<T>): Promise<T> {
  try {
    const r = await fn();
    await tx.done;
    return r;
  } catch (e) {
    try {
      tx.abort();
    } catch {
      /* 既に終了している */
    }
    await tx.done.catch(() => undefined);
    throw e instanceof AppError ? e : new AppError(`保存に失敗したため、変更をすべて取り消しました（${e instanceof Error ? e.message : '不明なエラー'}）`);
  }
}

export function fieldError<T>(errors: FieldErrors<T>): AppError {
  const fe = errors as Record<string, string>;
  return new AppError(Object.values(fe).find(Boolean) ?? '入力内容を確認してください', fe);
}

/**
 * 操作履歴を記録する。履歴には件名・番号などの識別情報のみを書き、
 * 本文・コメント等の自由記述 (秘密情報が含まれ得る) は書かない。
 */
export async function logActivity(tx: WriteTx, category: ActivityCategory, action: string, message: string, entityId: string | null = null) {
  const entry: ActivityLog = { id: generateId('act'), at: nowISO(), category, action, message, entityId };
  const store = tx.objectStore('activities');
  await store.put(entry);
  const count = await store.count();
  if (count > MAX_ACTIVITIES) {
    let cursor = await store.index('byAt').openCursor();
    let toDelete = count - MAX_ACTIVITIES;
    while (cursor && toDelete > 0) {
      await cursor.delete();
      toDelete--;
      cursor = await cursor.continue();
    }
  }
}

export function inquiryEvent(type: InquiryEventType, message: string): InquiryEvent {
  return { id: generateId('ev'), at: nowISO(), type, message };
}

/** 問い合わせに対応履歴を1件追加して保存する (同一トランザクション内で使用) */
export async function appendInquiryEvent(tx: WriteTx, inquiryId: string, event: InquiryEvent, patch: Partial<Inquiry> = {}) {
  const store = tx.objectStore('inquiries');
  const inq = await store.get(inquiryId);
  if (!inq) return;
  await store.put({ ...inq, ...patch, history: [...inq.history, event], updatedAt: event.at });
}
