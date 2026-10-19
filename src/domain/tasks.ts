/**
 * タスクの共通処理 (並び順・表示用の判定)。期限・担当部署が未設定のタスク (Phase 7 から許容) を全画面で同じように扱う。
 */
import type { Task } from './types';

/** 期限の昇順。期限なしは最後 */
export function compareDue(a: Pick<Task, 'dueDate'>, b: Pick<Task, 'dueDate'>): number {
  if (a.dueDate === b.dueDate) return 0;
  if (!a.dueDate) return 1;
  if (!b.dueDate) return -1;
  // YYYY-MM-DD は文字の順 = 日付の順 (localeCompare より速い。一覧の並べ替えで件数 × log 件数回呼ばれる)
  return a.dueDate < b.dueDate ? -1 : 1;
}
