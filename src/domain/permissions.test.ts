import { describe, expect, it } from 'vitest';
import { can, canApprovePurchase, canChangeRole, PERMISSION_MATRIX, PERMISSIONS, ROLES, scopeOf, type Actor, type Role } from './permissions';

const actor = (role: Role, extra: Partial<Actor> = {}): Actor => ({ userId: `u-${role}`, role, departmentId: 'd-sales', active: true, ...extra });

describe('役割と権限の表 (Phase 13 の設計)', () => {
  it('すべての権限が表にあり、所有者はすべての操作を組織全体でできる', () => {
    expect(Object.keys(PERMISSION_MATRIX).sort()).toEqual([...PERMISSIONS].sort());
    for (const p of PERMISSIONS) expect(scopeOf(actor('owner'), p)).toBe('all');
  });

  it('上位の役割は下位の役割より狭くならない (owner ⊇ admin ⊇ manager ⊇ member ⊇ viewer)', () => {
    const rank = { all: 3, department: 2, own: 1 } as const;
    const width = (r: Role, p: (typeof PERMISSIONS)[number]) => {
      const s = PERMISSION_MATRIX[p][r];
      return s ? rank[s] : 0;
    };
    for (const p of PERMISSIONS)
      ROLES.slice(1).forEach((lower, i) => {
        const upper = ROLES[i] as Role;
        expect(width(upper, p), `${p}: ${upper} >= ${lower}`).toBeGreaterThanOrEqual(width(lower, p));
      });
  });

  it('範囲: 部署の責任者は自分の部署の社員だけ変更でき、一般の利用者は自分のタスクだけ変更できる', () => {
    const m = actor('manager');
    expect(can(m, 'employee.write', { departmentId: 'd-sales' })).toBe(true);
    expect(can(m, 'employee.write', { departmentId: 'd-it' })).toBe(false);
    const u = actor('member');
    expect(can(u, 'task.write', { ownerUserIds: ['u-member'] })).toBe(true);
    expect(can(u, 'task.write', { ownerUserIds: ['someone'] })).toBe(false);
    expect(can(actor('viewer'), 'task.write', { ownerUserIds: ['u-viewer'] })).toBe(false);
  });

  it('個人情報 (連絡先) は一般の利用者には本人の分だけ。消去は管理者だけ', () => {
    expect(can(actor('member'), 'employee.personal.read', { ownerUserIds: ['u-member'] })).toBe(true);
    expect(can(actor('member'), 'employee.personal.read', { departmentId: 'd-sales' })).toBe(false);
    expect(can(actor('manager'), 'employee.personal.erase')).toBe(false);
    expect(can(actor('admin'), 'employee.personal.erase')).toBe(true);
  });

  it('停止中の所属 (退職・招待の取り消し) は、所有者でも何もできない', () => {
    const off = actor('owner', { active: false });
    for (const p of PERMISSIONS) expect(can(off, p)).toBe(false);
  });

  it('発注の承認: 申請者本人は承認できない。部署の責任者は自分の部署の発注だけ', () => {
    const m = actor('manager');
    expect(canApprovePurchase(m, { requestedByUserId: 'u-manager', departmentId: 'd-sales' })).toBe(false);
    expect(canApprovePurchase(m, { requestedByUserId: 'u-x', departmentId: 'd-sales' })).toBe(true);
    expect(canApprovePurchase(m, { requestedByUserId: 'u-x', departmentId: 'd-it' })).toBe(false);
    expect(canApprovePurchase(actor('member'), { requestedByUserId: 'u-x' })).toBe(false);
    expect(canApprovePurchase(actor('admin'), { requestedByUserId: 'u-admin' })).toBe(false);
  });

  it('役割の変更: 管理者は所有者を作れない・変えられない。最後の所有者は外せない', () => {
    expect(canChangeRole(actor('admin'), 'member', 'manager', 1)).toBe(true);
    expect(canChangeRole(actor('admin'), 'member', 'owner', 1)).toBe(false);
    expect(canChangeRole(actor('admin'), 'owner', 'member', 2)).toBe(false);
    expect(canChangeRole(actor('owner'), 'owner', 'admin', 1)).toBe(false);
    expect(canChangeRole(actor('owner'), 'owner', 'admin', 2)).toBe(true);
    expect(canChangeRole(actor('manager'), 'viewer', 'member', 1)).toBe(false);
  });
});
