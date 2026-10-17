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
  constructor(
    message: string,
    public readonly fieldErrors: Record<string, string> = {},
    /** 'conflict' = 編集を始めた後に、別のタブ・画面で同じデータが変更された */
    public readonly code?: 'conflict',
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** 更新時の競合検出の指定。フォームを開いた時点の更新日時を渡すと、その後に別の画面・タブで変更されていた場合は保存しない */
export interface UpdateOptions {
  expectedUpdatedAt?: string;
}

/**
 * 楽観的な競合検出。最終保存優先で他の変更を黙って上書きしないよう、フォームを開いた後に変更されていたら中止する
 * (トランザクション内で現在の値と比べるので、確認と保存の間に割り込まれることはない)
 */
export function conflictError(label: string, currentUpdatedAt: string): AppError {
  const at = currentUpdatedAt.slice(0, 16).replace('T', ' ');
  return new AppError(`この${label}は、編集を始めた後に別のタブ・画面で変更されています（${at} 更新）。入力内容はまだ保存していません。最新の内容を確認してから保存してください`, {}, 'conflict');
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

/** 保存の失敗の種類 (利用者向けの説明を選ぶため) */
export type StorageErrorKind = 'quota' | 'unavailable' | 'conflict' | 'aborted' | 'unknown';

/** IndexedDB の例外を種類に分ける。DOMException の名前は端末・ブラウザによって異なるため、メッセージも見る */
export function classifyStorageError(e: unknown): StorageErrorKind {
  const name = e instanceof Error || (typeof DOMException !== 'undefined' && e instanceof DOMException) ? (e as Error).name : '';
  const message = e instanceof Error ? e.message : String(e ?? '');
  if (name === 'QuotaExceededError' || /quota|storage.*full|disk.*full/i.test(message)) return 'quota';
  if (name === 'InvalidStateError' || name === 'SecurityError' || /database connection is closing|connection.*closed/i.test(message)) return 'unavailable';
  if (name === 'ConstraintError') return 'conflict';
  if (name === 'AbortError' || name === 'TransactionInactiveError') return 'aborted';
  return 'unknown';
}

/** 保存の失敗を、利用者が次に何をすればよいか分かる説明にする (「変更は取り消され、元のデータは残っている」ことを必ず伝える) */
export function storageErrorMessage(e: unknown): string {
  switch (classifyStorageError(e)) {
    case 'quota':
      return '端末の保存容量が不足しているため保存できませんでした（変更は取り消され、元のデータは残っています）。不要な書類をゴミ箱から完全削除するか、写真などを整理して空き容量を確保してから、もう一度お試しください';
    case 'unavailable':
      return '保存領域に接続できなかったため保存できませんでした（変更は取り消されています）。別のタブで新しい版を開いた場合などに起きます。画面を再読み込みしてからもう一度お試しください';
    case 'conflict':
      return '同じ番号・キーのデータが既にあるため保存できませんでした（変更は取り消されています）。画面を再読み込みして最新の内容を確認してください';
    case 'aborted':
      return '保存が中断されたため、変更をすべて取り消しました（元のデータは残っています）。もう一度お試しください';
    default:
      // 技術的な詳細 (例外のメッセージ) は利用者向けの表示に含めず、開発者向けにコンソールへ出す (Phase 11)
      return '保存に失敗したため、変更をすべて取り消しました（元のデータは残っています）。もう一度お試しください。繰り返す場合は画面を再読み込みしてください';
  }
}

/**
 * エラーの分類 (Phase 11)。利用者に見せる説明と、開発者向けの記録 (コンソール) を分けるために使う。
 * - input: 入力の誤り・業務ルール (例: 必須項目・重複・本人承認)。利用者が直せる
 * - conflict: 整合性 (別のタブの変更との競合・参照先の削除)
 * - storage: 端末の保存領域 (容量不足・接続切れ・中断)
 * - permission / network: 将来 (ログイン・サーバー導入後) の権限・通信のエラー。現在は発生しない
 * - system: プログラムの誤りなど想定外のもの。利用者には一般的な説明だけを見せる
 */
export type ErrorCategory = 'input' | 'conflict' | 'storage' | 'permission' | 'network' | 'system';

export function classifyError(e: unknown): ErrorCategory {
  if (e instanceof AppError) return e.code === 'conflict' ? 'conflict' : 'input';
  const kind = classifyStorageError(e);
  if (kind !== 'unknown') return 'storage';
  if (e instanceof TypeError && /fetch|network/i.test(e.message)) return 'network';
  return 'system';
}

/** 開発者向けの記録。利用者向けの表示には技術的な詳細を出さない */
export function reportError(context: string, e: unknown): ErrorCategory {
  const category = classifyError(e);
  if (category !== 'input') console.error(`[WorkCore] ${context}（分類: ${category}）`, e);
  return category;
}

/**
 * トランザクション内の処理で例外が起きたら、必ずトランザクションを取り消す。
 * IndexedDB は「書き込み要求の失敗」なら自動で取り消すが、put などが同期的に投げる例外 (キーの無いレコードなど) では
 * 取り消さず、それまでの書き込みが確定してしまう。複数のレコードを書き換える処理 (削除と関連の整理・復元・置き換えなど) で
 * 部分的な書き込みを残さないために使う
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
    throw e instanceof AppError ? e : new AppError(storageErrorMessage(e));
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
