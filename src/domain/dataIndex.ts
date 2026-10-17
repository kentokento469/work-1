/**
 * データの索引 (Phase 12・性能)。一覧の各行で全件を探す (件数 × 件数) と、数千件で表示が極端に遅くなるため、
 * データを読み込んだときに1回だけ作り、各画面は ID で引く。
 */
import type { Asset } from './inventory/types';
import type { DataSnapshot, Inquiry, Project, Task } from './types';

export interface DataIndex {
  taskById: Map<string, Task>;
  /** 親タスク ID → サブタスク */
  subtasksByParent: Map<string, Task[]>;
  inquiryById: Map<string, Inquiry>;
  assetById: Map<string, Asset>;
  projectById: Map<string, Project>;
  /** タスクの対象になっている社員 ID */
  employeesWithTasks: Set<string>;
}

export function buildIndex(data: Pick<DataSnapshot, 'tasks' | 'inquiries' | 'assets' | 'projects'>): DataIndex {
  const taskById = new Map<string, Task>();
  const subtasksByParent = new Map<string, Task[]>();
  const employeesWithTasks = new Set<string>();
  for (const t of data.tasks) {
    taskById.set(t.id, t);
    if (t.parentTaskId) {
      const list = subtasksByParent.get(t.parentTaskId);
      if (list) list.push(t);
      else subtasksByParent.set(t.parentTaskId, [t]);
    }
    if (t.employeeId) employeesWithTasks.add(t.employeeId);
  }
  return {
    taskById,
    subtasksByParent,
    inquiryById: new Map(data.inquiries.map((i) => [i.id, i])),
    assetById: new Map(data.assets.map((a) => [a.id, a])),
    projectById: new Map((data.projects ?? []).map((p) => [p.id, p])),
    employeesWithTasks,
  };
}
