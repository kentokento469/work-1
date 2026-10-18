/**
 * 役割と権限 (Phase 13 の設計。docs/PHASE13_DESIGN.md §3)。
 *
 * 現在のアプリはログインがなく、端末を使える人がすべての操作をできる。この定義は Phase 14 で
 * サーバー側のアクセス制御 (データベースの行単位の制御・サーバーの処理) と画面の表示の両方から使う「正本の表」として、
 * 先に型と単体テストで固めておくもの。**画面の非表示だけで権限を守るものではない** (判定の最終責任はサーバー側)。
 */

/** 組織の中での役割。1人1つ (所属 Membership ごと) */
export const ROLES = ['owner', 'admin', 'manager', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  owner: '組織の所有者',
  admin: '管理者',
  manager: '部署の責任者',
  member: '一般の利用者',
  viewer: '閲覧のみ',
};

/**
 * 操作ごとの権限。「データの種類.操作」の形。
 * 個人情報 (社員の連絡先・備考) は社員の基本情報と分ける (閲覧できる人を絞る)
 */
export const PERMISSIONS = [
  'employee.read',
  'employee.write',
  'employee.delete',
  'employee.personal.read',
  'employee.personal.erase',
  'onboarding.apply',
  'task.read',
  'task.write',
  'task.delete',
  'inquiry.create',
  'inquiry.read',
  'inquiry.handle',
  'inventory.read',
  'inventory.move',
  'inventory.stocktake',
  'asset.write',
  'purchase.read',
  'purchase.draft',
  'purchase.approve',
  'purchase.receive',
  'document.read',
  'document.write',
  'document.delete',
  'automation.apply',
  'automation.configure',
  'settings.write',
  'member.manage',
  'data.export',
  'data.import',
  'audit.read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * 適用範囲。
 * - all: 組織のすべてのデータ
 * - department: 自分の所属部署のデータ (社員・担当部署のタスク・部署の問い合わせ)
 * - own: 自分が作成した・担当している・申請したデータ
 */
export type Scope = 'all' | 'department' | 'own';

type Grant = Partial<Record<Role, Scope>>;
const ALL: Grant = { owner: 'all', admin: 'all', manager: 'all', member: 'all', viewer: 'all' };
const STAFF: Grant = { owner: 'all', admin: 'all', manager: 'all', member: 'all' };
const ADMINS: Grant = { owner: 'all', admin: 'all' };
const OWNER: Grant = { owner: 'all' };

/** 権限の表 (docs/PHASE13_DESIGN.md §3.3 と同じ内容) */
export const PERMISSION_MATRIX: Record<Permission, Grant> = {
  'employee.read': ALL,
  'employee.write': { owner: 'all', admin: 'all', manager: 'department' },
  'employee.delete': ADMINS,
  'employee.personal.read': { owner: 'all', admin: 'all', manager: 'department', member: 'own', viewer: 'own' },
  'employee.personal.erase': ADMINS,
  'onboarding.apply': { owner: 'all', admin: 'all', manager: 'department' },
  'task.read': ALL,
  'task.write': { owner: 'all', admin: 'all', manager: 'all', member: 'own' },
  'task.delete': { owner: 'all', admin: 'all', manager: 'department', member: 'own' },
  'inquiry.create': ALL,
  'inquiry.read': { owner: 'all', admin: 'all', manager: 'department', member: 'own', viewer: 'own' },
  'inquiry.handle': { owner: 'all', admin: 'all', manager: 'department' },
  'inventory.read': ALL,
  'inventory.move': STAFF,
  'inventory.stocktake': { owner: 'all', admin: 'all', manager: 'all' },
  'asset.write': { owner: 'all', admin: 'all', manager: 'all' },
  'purchase.read': STAFF,
  'purchase.draft': STAFF,
  'purchase.approve': { owner: 'all', admin: 'all', manager: 'department' },
  'purchase.receive': STAFF,
  'document.read': { owner: 'all', admin: 'all', manager: 'all', member: 'own' },
  'document.write': STAFF,
  'document.delete': { owner: 'all', admin: 'all', manager: 'all', member: 'own' },
  'automation.apply': { owner: 'all', admin: 'all', manager: 'all' },
  'automation.configure': ADMINS,
  'settings.write': ADMINS,
  'member.manage': ADMINS,
  'data.export': ADMINS,
  'data.import': OWNER,
  'audit.read': ADMINS,
};

/** 判定の対象 (範囲の判定に使う属性だけ) */
export interface AccessTarget {
  departmentId?: string | null;
  /** 作成者・担当者・申請者・本人 (ログイン利用者の id) */
  ownerUserIds?: (string | null | undefined)[];
}

export interface Actor {
  userId: string;
  role: Role;
  /** 所属部署 (Membership.departmentId)。部署に属さない場合は null */
  departmentId: string | null;
  /** 停止中 (退職・招待の取り消し) の所属は、何もできない */
  active: boolean;
}

/** その操作の範囲 (できない場合は null)。対象を指定しない一覧の取得などで、どこまで見せるかに使う */
export function scopeOf(actor: Actor, permission: Permission): Scope | null {
  if (!actor.active) return null;
  return PERMISSION_MATRIX[permission][actor.role] ?? null;
}

/** その対象に対して操作できるか */
export function can(actor: Actor, permission: Permission, target: AccessTarget = {}): boolean {
  const scope = scopeOf(actor, permission);
  if (scope === null) return false;
  if (scope === 'all') return true;
  const isOwn = (target.ownerUserIds ?? []).includes(actor.userId);
  if (scope === 'own') return isOwn;
  return isOwn || (actor.departmentId !== null && target.departmentId === actor.departmentId);
}

/**
 * 発注の承認 (職務の分離)。権限に加えて、申請者本人は承認できない。
 * 現在 (Phase 10) は氏名の一致で判定している。Phase 14 からはログイン利用者の id で判定する
 */
export function canApprovePurchase(actor: Actor, order: { requestedByUserId: string | null; departmentId?: string | null }): boolean {
  if (order.requestedByUserId === actor.userId) return false;
  return can(actor, 'purchase.approve', { departmentId: order.departmentId ?? null });
}

/** 役割の変更の制約: 所有者を0人にしない。管理者は所有者を変更・付与できない */
export function canChangeRole(actor: Actor, from: Role, to: Role, ownerCount: number): boolean {
  if (!can(actor, 'member.manage')) return false;
  if ((from === 'owner' || to === 'owner') && actor.role !== 'owner') return false;
  if (from === 'owner' && to !== 'owner' && ownerCount <= 1) return false;
  return true;
}
