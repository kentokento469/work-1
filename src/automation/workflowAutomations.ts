/**
 * 業務横断の自動化 (Phase 5): 人事 → タスク。
 * いずれもタスクの作成だけを行う (取り消しやすい操作) ため、利用者の設定で自動実行にできる (autoCapable)。
 * アカウントの削除・停止そのものや、外部への申請・送信は行わない (確認タスクを作るだけ)。
 */
import { buildOnboardingPlan } from './onboardingEngine';
import { actionSignature, fingerprint, type AutomationAction, type AutomationDefinition, type AutomationProposal } from './engine';
import { addDays, diffDays } from '../domain/date';
import { toPreviousBusinessDayCal } from '../domain/calendar';
import { hasTask } from './taskKeys';
import type { DataSnapshot, ISODate } from '../domain/types';

const JOSHIS = 'dept_joshis';
const SOUMU = 'dept_soumu';
const JINJI = 'dept_jinji';
function dept(data: DataSnapshot, preferred: string): string {
  return data.departments.some((d) => d.id === preferred) ? preferred : (data.departments[0]?.id ?? preferred);
}

// ---------------------------------------------------------------------------
// 1. 新入社員 → 入社準備タスク (Phase 1 の入社準備ルールをそのまま使う)
// ---------------------------------------------------------------------------
export const onboardingTasks: AutomationDefinition = {
  id: 'onboarding-tasks',
  name: '新入社員：入社準備タスクの生成',
  description: '入社予定者が登録されたら、入社準備ルール（全社共通＋部署別）に基づいてタスクを作成する。作成済みのタスク・対象外のルールは除く',
  trigger: '在籍ステータスが「入社予定」の社員に、まだ作成していない入社準備タスクがある',
  approval: 'required',
  category: '人事',
  autoCapable: true,
  detect({ data, today }) {
    const out: AutomationProposal[] = [];
    for (const emp of data.employees.filter((e) => e.status === 'pending').sort((a, b) => a.hireDate.localeCompare(b.hireDate) || a.employeeNumber.localeCompare(b.employeeNumber))) {
      let plan;
      try {
        plan = buildOnboardingPlan({ employee: emp, rules: data.rules, existingTasks: data.tasks.filter((t) => t.employeeId === emp.id), departments: data.departments, today });
      } catch {
        continue;
      }
      const items = plan.items.filter((i) => i.status === 'new');
      if (!items.length) continue;
      const actions: AutomationAction[] = items.map((i) => ({
        id: `onb:${i.ruleId}`,
        kind: 'create_onboarding_task',
        employeeId: emp.id,
        ruleId: i.ruleId,
        title: i.title,
        description: i.description,
        departmentId: i.assigneeDepartmentId,
        assignee: i.assignee,
        priority: i.priority,
        dueDate: i.dueDate,
        label: `タスク「${i.title}」（期限 ${i.dueDate}・${i.assignee || '担当未定'}）`,
        requiresApproval: false,
      }));
      out.push({
        automationId: 'onboarding-tasks',
        key: fingerprint([emp.id, ...actionSignature(actions)]),
        title: `${emp.name}さんの入社準備タスク（${items.length}件）`,
        conditions: [`入社予定日 ${emp.hireDate}（あと${Math.max(0, diffDays(today, emp.hireDate))}日）`, `未作成の入社準備タスク ${items.length}件（作成済み・対象外は除外）`],
        actions,
        warnings: plan.items.some((i) => i.notes.length) ? ['期限が入社日より前に設定できない項目は、今日以降に調整しています'] : [],
        employeeId: emp.id,
      });
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// 2. 退職予定者 → 退職手続きタスク (端末返却は既存の「貸与資産の返却」自動化が担当)
// ---------------------------------------------------------------------------
const RETIRE_TASKS: { kind: string; title: string; description: string; dept: string; assignee: string; daysBefore: number }[] = [
  { kind: 'account', title: 'アカウント停止の確認', description: '退職日に業務アカウント（メール・業務システム）の停止予定を確認する。停止・削除の操作は各管理画面で担当者が行う（WorkCore からは実行しない）', dept: JOSHIS, assignee: '小林 美咲', daysBefore: 3 },
  { kind: 'documents', title: '退職手続き書類の準備・回収', description: '退職届・誓約書の回収、離職票・源泉徴収票などの発行手続きを確認する', dept: JINJI, assignee: '', daysBefore: 5 },
  { kind: 'badge', title: '社員証・鍵の回収', description: '社員証・入館カード・鍵を退職日までに回収する', dept: SOUMU, assignee: '', daysBefore: 1 },
];
const dueBefore = (date: ISODate, today: ISODate, days: number) => {
  const d = toPreviousBusinessDayCal(addDays(date, -days));
  return d < today ? today : d;
};

export const retirementProcedures: AutomationDefinition = {
  id: 'retirement-procedures',
  name: '退職予定者：退職手続きタスクの生成',
  description: '退職日が設定されたら、アカウント停止の確認・書類・社員証の回収のタスクを作成する（貸与機器の返却は「貸与資産の返却」で提案）',
  trigger: '在籍・休職中の社員に、今日から45日以内の退職日が設定されている',
  approval: 'required',
  category: '人事',
  autoCapable: true,
  detect({ data, today }) {
    const out: AutomationProposal[] = [];
    for (const e of data.employees
      .filter((x) => (x.status === 'active' || x.status === 'leave') && x.retireDate && x.retireDate >= today && diffDays(today, x.retireDate) <= 45)
      .sort((a, b) => a.retireDate!.localeCompare(b.retireDate!) || a.employeeNumber.localeCompare(b.employeeNumber))) {
      const actions: AutomationAction[] = RETIRE_TASKS.filter((t) => !hasTask(data, `retire:${t.kind}:${e.id}`)).map((t) => ({
        id: `retire:${t.kind}`,
        kind: 'create_task',
        ruleKey: `retire:${t.kind}:${e.id}`,
        title: `${t.title}（${e.name}）`,
        description: t.description,
        departmentId: dept(data, t.dept),
        assignee: t.assignee,
        priority: 'high',
        dueDate: dueBefore(e.retireDate!, today, t.daysBefore),
        employeeId: e.id,
        inquiryId: null,
        assetId: null,
        label: `タスク「${t.title}」を作成（期限 ${dueBefore(e.retireDate!, today, t.daysBefore)}）`,
        requiresApproval: false,
      }));
      if (!actions.length) continue;
      out.push({
        automationId: 'retirement-procedures',
        key: fingerprint([e.id, e.retireDate!, ...actionSignature(actions)]),
        title: `${e.name}さんの退職手続き（退職日 ${e.retireDate}）`,
        conditions: [`退職日 ${e.retireDate}（あと${diffDays(today, e.retireDate!)}日）`],
        actions,
        warnings: ['アカウントの停止・削除は WorkCore からは実行しません（確認タスクのみ）'],
        employeeId: e.id,
      });
    }
    return out;
  },
};

export const WORKFLOW_AUTOMATIONS: AutomationDefinition[] = [onboardingTasks, retirementProcedures];
