import type { DataSnapshot } from '../domain/types';

/** 自動化で作成済みのタスクのキー。タスクの一覧ごとに1回だけ作る (判定のたびに全タスクを探さない。Phase 13R) */
const ruleIdsCache = new WeakMap<DataSnapshot['tasks'], Set<string>>();
export function hasTask(data: DataSnapshot, ruleKey: string): boolean {
  let ids = ruleIdsCache.get(data.tasks);
  if (!ids) ruleIdsCache.set(data.tasks, (ids = new Set(data.tasks.flatMap((t) => (t.ruleId ? [t.ruleId] : [])))));
  return ids.has(ruleKey);
}
