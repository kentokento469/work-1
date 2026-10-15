import { describe, expect, it } from 'vitest';
import { computeDashboard, computeDepartmentBreakdown, staffSegment } from './analytics';
import { emptyInventory } from './inventory/defaults';
import { createDemoData } from '../demo/demoData';
import { suggestEmployeeStatus, normalizeEmployeeNumber } from './validation';
import { toPreviousBusinessDay, isValidISODate } from './date';

const TODAY = '2026-10-15';

describe('部署別の在籍状況', () => {
  const base = { id: 'e', employeeNumber: 'X', name: 'x', departmentId: 'd1', position: '', employmentType: '正社員' as const, hireDate: '2020-04-01', retireDate: null, status: 'active' as const, notes: '', createdAt: '', updatedAt: '' };
  it('ステータスと退職日から区分を決める', () => {
    expect(staffSegment(base, TODAY)).toBe('active');
    expect(staffSegment({ ...base, status: 'pending' }, TODAY)).toBe('joining_scheduled');
    expect(staffSegment({ ...base, retireDate: '2026-11-30' }, TODAY)).toBe('leaving_scheduled');
    expect(staffSegment({ ...base, retireDate: TODAY }, TODAY)).toBe('leaving_scheduled'); // 当日はまだ在籍
    expect(staffSegment({ ...base, status: 'leave' }, TODAY)).toBe('leave_absence');
    expect(staffSegment({ ...base, status: 'leave', retireDate: '2026-12-31' }, TODAY)).toBe('leaving_scheduled');
    expect(staffSegment({ ...base, status: 'retired', retireDate: '2026-01-31' }, TODAY)).toBe('retired');
  });
  it('部署ごとに集計し、在籍人数は 在籍中＋退職予定＋休職中', () => {
    const emps = [
      { ...base, id: '1' },
      { ...base, id: '2' },
      { ...base, id: '3', retireDate: '2026-11-30' },
      { ...base, id: '4', status: 'leave' as const },
      { ...base, id: '5', status: 'pending' as const },
      { ...base, id: '6', status: 'retired' as const },
      { ...base, id: '7', departmentId: 'd2' },
    ];
    const [d1, d2] = computeDepartmentBreakdown(emps, [{ id: 'd1', name: '総務部', order: 1 }, { id: 'd2', name: '営業部', order: 2 }], TODAY);
    expect(d1!.counts).toEqual({ active: 2, leaving_scheduled: 1, leave_absence: 1, joining_scheduled: 1, retired: 1 });
    expect(d1!.enrolled).toBe(4);
    expect(d1!.total).toBe(6);
    expect(d2!.enrolled).toBe(1);
  });
  it('デモデータの合計は社員数と一致する', () => {
    const data = createDemoData(TODAY);
    const s = computeDashboard(data, TODAY);
    expect(s.departmentBreakdown.reduce((a, d) => a + d.total, 0)).toBe(data.employees.length);
    expect(s.departmentBreakdown.some((d) => d.counts.leaving_scheduled > 0)).toBe(true); // デモ: 退職予定者あり
  });
});

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
    const s = computeDashboard({ ...emptyInventory(false), documents: [], settings: [], departments: [], employees: [], tasks: [], rules: [], activities: [], inquiries: [], faqs: [], inquiryCategories: [] }, TODAY);
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
