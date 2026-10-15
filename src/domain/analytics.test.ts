import { describe, expect, it } from 'vitest';
import { computeDashboard } from './analytics';
import { createDemoData } from '../demo/demoData';
import { suggestEmployeeStatus, normalizeEmployeeNumber } from './validation';
import { toPreviousBusinessDay, isValidISODate } from './date';

const TODAY = '2026-10-15';

describe('computeDashboard', () => {
  it('デモデータから各指標を集計する', () => {
    const data = createDemoData(TODAY);
    const s = computeDashboard(data, TODAY);
    expect(s.employeeCount).toBe(data.employees.filter((e) => e.status !== 'retired').length);
    expect(s.pendingHireCount).toBe(4);
    expect(s.totalTaskCount).toBe(data.tasks.length);
    expect(s.openTaskCount + s.doneTaskCount).toBe(s.totalTaskCount);
    expect(s.overdueTaskCount).toBeGreaterThan(0);
    expect(s.completionRate).toBe(Math.round((s.doneTaskCount / s.totalTaskCount) * 100));
    expect(s.departmentCounts.reduce((a, d) => a + d.count, 0)).toBe(s.employeeCount);
    // 期限超過が優先対応の先頭に来る
    expect(s.attention[0]?.kind).toBe('overdue');
    // 入社30日以内でタスク未生成の社員が警告される
    expect(s.attention.some((a) => a.kind === 'unprepared_hire' && a.title.includes('橋本'))).toBe(true);
    expect(s.attention.some((a) => a.kind === 'unprepared_hire' && a.title.includes('阿部'))).toBe(false);
  });

  it('タスク0件でも完了率は0%', () => {
    const s = computeDashboard({ departments: [], employees: [], tasks: [], rules: [], activities: [] }, TODAY);
    expect(s.completionRate).toBe(0);
  });
});

describe('validation / date helpers', () => {
  it('ステータス推奨', () => {
    expect(suggestEmployeeStatus('2026-11-01', null, TODAY)).toBe('pending');
    expect(suggestEmployeeStatus('2020-01-01', null, TODAY)).toBe('active');
    expect(suggestEmployeeStatus('2020-01-01', '2026-10-01', TODAY)).toBe('retired');
  });
  it('社員番号正規化', () => {
    expect(normalizeEmployeeNumber(' ａ０１ ')).toBe('A01');
  });
  it('日付', () => {
    expect(isValidISODate('2026-02-29')).toBe(false);
    expect(isValidISODate('2028-02-29')).toBe(true);
    expect(toPreviousBusinessDay('2026-10-18')).toBe('2026-10-16');
  });
});
