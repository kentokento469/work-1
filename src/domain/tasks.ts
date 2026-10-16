/**
 * タスクの共通処理 (並び順・表示用の判定)。期限・担当部署が未設定のタスク (Phase 7 から許容) を全画面で同じように扱う。
 */
import type { Task } from './types';

/** 期限の昇順。期限なしは最後 */
export function compareDue(a: Pick<Task, 'dueDate'>, b: Pick<Task, 'dueDate'>): number {
  if (a.dueDate === b.dueDate) return 0;
  if (!a.dueDate) return 1;
  if (!b.dueDate) return -1;
  return a.dueDate.localeCompare(b.dueDate);
}
