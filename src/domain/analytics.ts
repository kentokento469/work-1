/**
 * ダッシュボード集計ロジック (純粋関数)。
 * 画面側はこの結果を描画するだけにして、集計ルールを1か所に集約する。
 */
import { diffDays } from './date';
import { PRIORITY_WEIGHT, type DataSnapshot, type Employee, type ISODate, type Task, type TaskStatus } from './types';

export function isTaskOpen(t: Task): boolean {
  return t.status !== 'done';
}

export function isTaskOverdue(t: Task, todayISO: ISODate): boolean {
  return isTaskOpen(t) && t.dueDate < todayISO;
}

export function isTaskDueSoon(t: Task, todayISO: ISODate, days = 3): boolean {
  if (!isTaskOpen(t) || t.dueDate < todayISO) return false;
  return diffDays(todayISO, t.dueDate) <= days;
}

export type AttentionKind = 'overdue' | 'due_soon' | 'unprepared_hire' | 'inquiry_overdue' | 'inquiry_new_high';

export interface AttentionItem {
  kind: AttentionKind;
  id: string;
  title: string;
  detail: string;
  /** 小さいほど優先 */
  score: number;
  taskId?: string;
  employeeId?: string;
  inquiryId?: string;
}

export interface DashboardStats {
  employeeCount: number;
  activeCount: number;
  pendingHireCount: number;
  openTaskCount: number;
  overdueTaskCount: number;
  totalTaskCount: number;
  doneTaskCount: number;
  completionRate: number; // 0-100
  statusCounts: Record<TaskStatus, number>;
  departmentCounts: { departmentId: string; name: string; count: number }[];
  hireProgress: { employee: Employee; total: number; done: number; daysUntil: number }[];
  attention: AttentionItem[];
}

export function computeDashboard(data: DataSnapshot, todayISO: ISODate): DashboardStats {
  const { employees, tasks, departments } = data;
  const empById = new Map(employees.map((e) => [e.id, e]));
  const nonRetired = employees.filter((e) => e.status !== 'retired');

  const statusCounts: Record<TaskStatus, number> = { todo: 0, in_progress: 0, done: 0, on_hold: 0 };
  for (const t of tasks) statusCounts[t.status]++;

  const doneTaskCount = statusCounts.done;
  const totalTaskCount = tasks.length;
  const overdue = tasks.filter((t) => isTaskOverdue(t, todayISO));

  const departmentCounts = [...departments]
    .sort((a, b) => a.order - b.order)
    .map((d) => ({ departmentId: d.id, name: d.name, count: nonRetired.filter((e) => e.departmentId === d.id).length }));

  const pendingHires = employees.filter((e) => e.status === 'pending').sort((a, b) => a.hireDate.localeCompare(b.hireDate));
  const hireProgress = pendingHires.map((e) => {
    const own = tasks.filter((t) => t.employeeId === e.id);
    return { employee: e, total: own.length, done: own.filter((t) => t.status === 'done').length, daysUntil: diffDays(todayISO, e.hireDate) };
  });

  const attention: AttentionItem[] = [];
  const empName = (t: Task) => (t.employeeId ? empById.get(t.employeeId)?.name : undefined);
  for (const t of overdue) {
    const days = diffDays(t.dueDate, todayISO);
    attention.push({
      kind: 'overdue',
      id: `o_${t.id}`,
      title: t.title,
      detail: `${days}日超過${empName(t) ? `・${empName(t)}` : ''}${t.assignee ? `・担当 ${t.assignee}` : ''}`,
      score: -days * 10 - PRIORITY_WEIGHT[t.priority],
      taskId: t.id,
    });
  }
  for (const t of tasks.filter((x) => isTaskDueSoon(x, todayISO) && x.priority !== 'low')) {
    const days = diffDays(todayISO, t.dueDate);
    attention.push({
      kind: 'due_soon',
      id: `s_${t.id}`,
      title: t.title,
      detail: `${days === 0 ? '本日期限' : `あと${days}日`}${empName(t) ? `・${empName(t)}` : ''}`,
      score: 100 + days * 10 - PRIORITY_WEIGHT[t.priority],
      taskId: t.id,
    });
  }
  for (const h of hireProgress) {
    if (h.total === 0 && h.daysUntil <= 30) {
      attention.push({
        kind: 'unprepared_hire',
        id: `h_${h.employee.id}`,
        title: `${h.employee.name}さんの入社準備が未生成`,
        detail: `入社まであと${h.daysUntil}日`,
        score: 50 + h.daysUntil,
        employeeId: h.employee.id,
      });
    }
  }
  // ヘルプデスク: 期限超過の問い合わせ・高優先度で未着手の問い合わせ
  for (const i of data.inquiries ?? []) {
    const open = i.status !== 'resolved' && i.status !== 'closed';
    if (!open) continue;
    if (i.dueDate < todayISO) {
      const days = diffDays(i.dueDate, todayISO);
      attention.push({
        kind: 'inquiry_overdue',
        id: `iq_${i.id}`,
        title: `${i.number} ${i.title}`,
        detail: `問い合わせ・${days}日超過・${i.requesterName}`,
        score: -days * 10 - PRIORITY_WEIGHT[i.priority],
        inquiryId: i.id,
      });
    } else if (i.status === 'new' && i.priority === 'high') {
      attention.push({ kind: 'inquiry_new_high', id: `in_${i.id}`, title: `${i.number} ${i.title}`, detail: `高優先度の新規問い合わせ・${i.requesterName}`, score: 5, inquiryId: i.id });
    }
  }
  attention.sort((a, b) => a.score - b.score);

  return {
    employeeCount: nonRetired.length,
    activeCount: employees.filter((e) => e.status === 'active').length,
    pendingHireCount: pendingHires.length,
    openTaskCount: tasks.filter(isTaskOpen).length,
    overdueTaskCount: overdue.length,
    totalTaskCount,
    doneTaskCount,
    completionRate: totalTaskCount === 0 ? 0 : Math.round((doneTaskCount / totalTaskCount) * 100),
    statusCounts,
    departmentCounts,
    hireProgress,
    attention,
  };
}
