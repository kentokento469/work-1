import { describe, expect, it } from 'vitest';
import { buildOnboardingPlan, calculateDueDate, materializePlan } from './onboardingEngine';
import { createDefaultDepartments, createDefaultRules, DEPT } from '../demo/demoData';
import type { Employee, Task } from '../domain/types';

const TODAY = '2026-10-15'; // 木曜日
const departments = createDefaultDepartments();
const rules = createDefaultRules('2026-01-01T00:00:00.000Z');

function employee(over: Partial<Employee> = {}): Employee {
  return {
    id: 'emp_x',
    employeeNumber: 'X001',
    name: 'テスト 太郎',
    departmentId: DEPT.kaihatsu,
    position: '',
    employmentType: '正社員',
    hireDate: '2026-11-02', // 月曜日
    retireDate: null,
    status: 'pending',
    notes: '',
    createdAt: '',
    updatedAt: '',
    ...over,
  };
}

describe('calculateDueDate', () => {
  it('入社日 + offset で期限を算出する', () => {
    expect(calculateDueDate('2026-11-02', -3, TODAY)).toEqual({ dueDate: '2026-10-30', notes: [] });
  });
  it('土日は直前の金曜日に前倒しする', () => {
    // 11/2(月) - 2日 = 10/31(土) → 10/30(金)
    const r = calculateDueDate('2026-11-02', -2, TODAY);
    expect(r.dueDate).toBe('2026-10-30');
    expect(r.notes[0]).toContain('前倒し');
  });
  it('過去日になる場合は本日に調整する', () => {
    const r = calculateDueDate('2026-10-16', -7, TODAY);
    expect(r.dueDate).toBe(TODAY);
    expect(r.notes.some((n) => n.includes('本日'))).toBe(true);
  });
});

describe('buildOnboardingPlan', () => {
  it('共通タスク + 所属部署のタスクのみを生成対象にする', () => {
    const plan = buildOnboardingPlan({ employee: employee(), rules, existingTasks: [], departments, today: TODAY });
    const titles = plan.items.filter((i) => i.status === 'new').map((i) => i.title);
    expect(titles).toEqual(
      expect.arrayContaining(['PC準備', 'Microsoftアカウント準備', 'Googleアカウント準備', '社内システム利用準備', '入社書類確認', '備品準備', 'GitHubアカウント招待', '開発環境・VPN設定']),
    );
    expect(titles).not.toContain('名刺発注'); // 営業部向け
    expect(plan.items.every((i) => i.scope === 'common' || i.title !== '名刺発注')).toBe(true);
    // 共通ルールが先頭に並ぶ
    expect(plan.items[0]?.scope).toBe('common');
  });

  it('雇用区分で対象外のルールは excluded になる', () => {
    const plan = buildOnboardingPlan({ employee: employee({ employmentType: '業務委託' }), rules, existingTasks: [], departments, today: TODAY });
    const item = plan.items.find((i) => i.title === '社会保険・雇用保険手続き');
    expect(item?.status).toBe('excluded');
    expect(item?.reason).toContain('業務委託');
  });

  it('無効化されたルールは excluded になる', () => {
    const disabled = rules.map((r) => (r.title === 'PC準備' ? { ...r, enabled: false } : r));
    const plan = buildOnboardingPlan({ employee: employee(), rules: disabled, existingTasks: [], departments, today: TODAY });
    expect(plan.items.find((i) => i.title === 'PC準備')?.status).toBe('excluded');
  });

  it('同一ルール・同名タスクが既にあれば duplicate になり、二重生成されない', () => {
    const first = buildOnboardingPlan({ employee: employee(), rules, existingTasks: [], departments, today: TODAY });
    const created = materializePlan(first, {}, 'now');
    expect(created.length).toBe(first.summary.newCount);

    const manual: Task = { ...created[0]!, id: 'manual', ruleId: null, title: '備品 準備', source: 'manual' };
    const existing = [...created.filter((t) => t.title !== '備品準備'), manual];
    const second = buildOnboardingPlan({ employee: employee(), rules, existingTasks: existing, departments, today: TODAY });
    expect(second.summary.newCount).toBe(0);
    expect(second.items.find((i) => i.title === '備品準備')?.reason).toContain('同名');
    expect(materializePlan(second, {}, 'now')).toHaveLength(0);
  });

  it('他の社員のタスクは重複判定に影響しない', () => {
    const other = materializePlan(buildOnboardingPlan({ employee: employee({ id: 'emp_other' }), rules, existingTasks: [], departments, today: TODAY }), {}, 'now');
    const plan = buildOnboardingPlan({ employee: employee(), rules, existingTasks: other, departments, today: TODAY });
    expect(plan.summary.duplicateCount).toBe(0);
  });

  it('退職者には生成できない', () => {
    expect(() => buildOnboardingPlan({ employee: employee({ status: 'retired' }), rules, existingTasks: [], departments, today: TODAY })).toThrow();
  });
});

describe('materializePlan', () => {
  it('選択解除・上書き内容を反映してタスク化する', () => {
    const plan = buildOnboardingPlan({ employee: employee(), rules, existingTasks: [], departments, today: TODAY });
    const pc = plan.items.find((i) => i.title === 'PC準備')!;
    const bihin = plan.items.find((i) => i.title === '備品準備')!;
    const tasks = materializePlan(plan, { [pc.key]: { selected: true, assignee: '代理 担当', priority: 'low', dueDate: '2026-10-20' }, [bihin.key]: { selected: false } }, 'now');
    expect(tasks.find((t) => t.title === '備品準備')).toBeUndefined();
    const pcTask = tasks.find((t) => t.title === 'PC準備')!;
    expect(pcTask).toMatchObject({ assignee: '代理 担当', priority: 'low', dueDate: '2026-10-20', status: 'todo', source: 'onboarding', employeeId: 'emp_x', ruleId: pc.ruleId });
  });
});
