/**
 * 入社準備自動化エンジン。
 *
 * UI・DB に依存しない純粋関数の集まりで、以下のパイプラインを表現する:
 *   社員情報 → 適用ルール判定 → 期限計算 → 重複検出 → 生成計画(プレビュー) → タスク化
 *
 * 入出力がプレーンなデータのみなので、将来の承認フロー (計画を承認待ちとして保存) や
 * 外部API連携 (計画を外部システムへ送信) にもそのまま再利用できる。
 */
import { addDays, diffDays, isValidISODate, toPreviousBusinessDay } from '../domain/date';
import { generateId } from '../domain/id';
import type { Department, Employee, ISODate, OnboardingRule, Priority, Task } from '../domain/types';

export type PlanItemStatus = 'new' | 'duplicate' | 'excluded';

export interface PlanItem {
  /** プレビュー上の識別子 (= ruleId) */
  key: string;
  ruleId: string;
  title: string;
  description: string;
  scope: 'common' | 'department';
  assigneeDepartmentId: string;
  assignee: string;
  priority: Priority;
  dueDate: ISODate;
  /** 期限調整などの補足 */
  notes: string[];
  status: PlanItemStatus;
  /** duplicate / excluded の理由 */
  reason: string | null;
}

export interface OnboardingPlan {
  employeeId: string;
  generatedAt: ISODate;
  items: PlanItem[];
  summary: { newCount: number; duplicateCount: number; excludedCount: number };
}

export interface PlanContext {
  employee: Employee;
  rules: OnboardingRule[];
  existingTasks: Task[];
  departments: Department[];
  today: ISODate;
}

export class OnboardingPlanError extends Error {}

export function normalizeTitle(title: string): string {
  return title.replace(/[\s　]+/g, '').toLowerCase();
}

/** ルールがこの社員に適用されるかを判定し、対象外ならその理由を返す */
export function ruleApplicability(rule: OnboardingRule, employee: Employee): string | null {
  if (!rule.enabled) return 'ルールが無効化されています';
  if (rule.scope !== 'common' && rule.scope !== employee.departmentId) return '他部署向けのルールです';
  if (rule.employmentTypes.length > 0 && !rule.employmentTypes.includes(employee.employmentType))
    return `雇用区分「${employee.employmentType}」は対象外です`;
  return null;
}

/**
 * 期限計算: 入社日 + offsetDays → 土日なら直前の平日 → 過去日なら本日に調整
 */
export function calculateDueDate(hireDate: ISODate, offsetDays: number, todayISO: ISODate): { dueDate: ISODate; notes: string[] } {
  const notes: string[] = [];
  const raw = addDays(hireDate, offsetDays);
  let due = toPreviousBusinessDay(raw);
  if (due !== raw) notes.push('休日のため直前の平日に前倒し');
  if (due < todayISO) {
    due = todayISO;
    notes.push('本来の期限を過ぎているため本日に設定');
  }
  return { dueDate: due, notes };
}

export function buildOnboardingPlan(ctx: PlanContext): OnboardingPlan {
  const { employee, rules, existingTasks, departments, today } = ctx;
  if (employee.status === 'retired') throw new OnboardingPlanError('退職済みの社員には入社準備タスクを生成できません');
  if (!isValidISODate(employee.hireDate)) throw new OnboardingPlanError('入社日が正しく設定されていません');

  const deptIds = new Set(departments.map((d) => d.id));
  const ownTasks = existingTasks.filter((t) => t.employeeId === employee.id);
  const byRule = new Map(ownTasks.filter((t) => t.ruleId).map((t) => [t.ruleId as string, t]));
  const byTitle = new Map(ownTasks.map((t) => [normalizeTitle(t.title), t]));
  const seenTitles = new Set<string>();

  const sorted = [...rules].sort((a, b) => {
    // 共通ルール → 部署別ルール、その中で order 順
    const sa = a.scope === 'common' ? 0 : 1;
    const sb = b.scope === 'common' ? 0 : 1;
    return sa - sb || a.order - b.order;
  });

  const items: PlanItem[] = [];
  for (const rule of sorted) {
    // 他部署向けルールはプレビューに出すとノイズになるので除外
    if (rule.scope !== 'common' && rule.scope !== employee.departmentId) continue;

    const { dueDate, notes } = calculateDueDate(employee.hireDate, rule.offsetDays, today);
    const titleKey = normalizeTitle(rule.title);
    let status: PlanItemStatus = 'new';
    let reason: string | null = null;

    const excluded = ruleApplicability(rule, employee);
    if (excluded) {
      status = 'excluded';
      reason = excluded;
    } else if (!deptIds.has(rule.assigneeDepartmentId)) {
      status = 'excluded';
      reason = '担当部署が削除されています。ルールを修正してください';
    } else if (byRule.has(rule.id)) {
      status = 'duplicate';
      reason = '登録済み（同じルールから生成済み）';
    } else if (byTitle.has(titleKey)) {
      status = 'duplicate';
      reason = '登録済み（同名タスクが存在）';
    } else if (seenTitles.has(titleKey)) {
      status = 'duplicate';
      reason = '同名のルールが複数あります';
    }
    if (status === 'new') seenTitles.add(titleKey);

    items.push({
      key: rule.id,
      ruleId: rule.id,
      title: rule.title,
      description: rule.description,
      scope: rule.scope === 'common' ? 'common' : 'department',
      assigneeDepartmentId: rule.assigneeDepartmentId,
      assignee: rule.defaultAssignee,
      priority: rule.priority,
      dueDate,
      notes,
      status,
      reason,
    });
  }

  return {
    employeeId: employee.id,
    generatedAt: today,
    items,
    summary: {
      newCount: items.filter((i) => i.status === 'new').length,
      duplicateCount: items.filter((i) => i.status === 'duplicate').length,
      excludedCount: items.filter((i) => i.status === 'excluded').length,
    },
  };
}

/** プレビューで利用者が変更できる項目 */
export interface PlanItemOverride {
  selected: boolean;
  assignee?: string;
  dueDate?: ISODate;
  priority?: Priority;
}

/**
 * 計画をタスクへ変換する。duplicate / excluded は選択されていても生成しない。
 */
export function materializePlan(
  plan: OnboardingPlan,
  overrides: Record<string, PlanItemOverride>,
  nowISO: string,
): Task[] {
  const tasks: Task[] = [];
  for (const item of plan.items) {
    if (item.status !== 'new') continue;
    const o = overrides[item.key];
    if (o && !o.selected) continue;
    const dueDate = o?.dueDate && isValidISODate(o.dueDate) ? o.dueDate : item.dueDate;
    tasks.push({
      id: generateId('task'),
      employeeId: plan.employeeId,
      title: item.title,
      description: item.description,
      assigneeDepartmentId: item.assigneeDepartmentId,
      assignee: (o?.assignee ?? item.assignee).trim(),
      priority: o?.priority ?? item.priority,
      dueDate,
      status: 'todo',
      source: 'onboarding',
      ruleId: item.ruleId,
      createdAt: nowISO,
      updatedAt: nowISO,
      completedAt: null,
    });
  }
  return tasks;
}

/** 入社日までの残日数 (負数は入社済み) */
export function daysUntilHire(employee: Employee, todayISO: ISODate): number {
  return diffDays(todayISO, employee.hireDate);
}
