/**
 * 問い合わせ → 対応タスクの提案ルール。
 *
 * 問い合わせのカテゴリと本文のキーワードから、必要な対応タスクを候補として提示する。
 * 登録は担当者の承認後 (プレビューで選択 → 登録) で、ここでは候補を作るだけ。
 * 入社準備ルールと同様に「ルールID」を重複防止キーとして Task.ruleId に保存する。
 */
import { addDays } from '../date';
import { toPreviousBusinessDayCal as toPreviousBusinessDay } from '../calendar';
import { normalizeText } from '../text';
import type { ISODate, Inquiry, InquiryCategory, Priority, Task } from '../types';
import { normalizeTitle } from '../../automation/onboardingEngine';
import { CAT } from './defaults';

export interface InquiryTaskRule {
  id: string;
  title: string;
  description: string;
  /** いずれかのカテゴリに一致 (空なら全カテゴリ) */
  categoryIds: string[];
  /** すべてのグループで、いずれかの語が本文に含まれること (空なら条件なし) */
  keywordGroups: string[][];
  departmentId: string | null; // null = 問い合わせカテゴリの既定部署
  priority: Priority | 'inherit';
  dueOffsetDays: number;
}

const JOSHIS = 'dept_joshis';
const SOUMU = 'dept_soumu';
const JINJI = 'dept_jinji';

export const INQUIRY_TASK_RULES: InquiryTaskRule[] = [
  {
    id: 'inqrule_pc_stock',
    title: 'PC在庫の確認',
    description: '貸出・予備PCの在庫と空き状況を確認する',
    categoryIds: [CAT.pc],
    keywordGroups: [['足りない', '不足', '在庫', '追加', '増員', '新入社員', '入社', '台数', '予備']],
    departmentId: JOSHIS,
    priority: 'inherit',
    dueOffsetDays: 1,
  },
  {
    id: 'inqrule_pc_order',
    title: 'PCの発注・購入申請',
    description: '在庫が不足する場合に発注・購入申請を行う（在庫確認の結果を踏まえて実施）',
    categoryIds: [CAT.pc],
    keywordGroups: [['足りない', '不足', '新入社員', '増員', '台数']],
    departmentId: SOUMU,
    priority: 'medium',
    dueOffsetDays: 3,
  },
  {
    id: 'inqrule_pc_repair',
    title: '端末の故障診断・代替機の手配',
    description: '症状を確認し、必要に応じて代替機を貸し出す',
    categoryIds: [CAT.pc],
    keywordGroups: [['起動しない', '電源が入らない', '壊れ', '故障', '割れ', 'ブルースクリーン', '映らない', '水をこぼ']],
    departmentId: JOSHIS,
    priority: 'inherit',
    dueOffsetDays: 1,
  },
  {
    id: 'inqrule_account_reset',
    title: 'アカウント状態の確認・ロック解除',
    description: '本人確認のうえ、管理画面でサインイン状態・ロックを確認する（パスワードはチャット等に記載しない）',
    categoryIds: [CAT.microsoft, CAT.google, CAT.apple, CAT.access],
    keywordGroups: [['ログイン', 'サインイン', 'パスワード', 'ロック', '認証']],
    departmentId: JOSHIS,
    priority: 'inherit',
    dueOffsetDays: 0,
  },
  {
    id: 'inqrule_access_grant',
    title: '権限付与の承認確認と設定',
    description: '所属長の承認を確認してから権限を設定する',
    categoryIds: [CAT.access],
    keywordGroups: [['権限', 'アクセス権', '共有フォルダ', '閲覧できない', 'アクセスできない']],
    departmentId: JOSHIS,
    priority: 'inherit',
    dueOffsetDays: 2,
  },
  {
    id: 'inqrule_network_check',
    title: 'ネットワーク機器の状態確認',
    description: 'ルーター・アクセスポイント・回線の状態を確認する',
    categoryIds: [CAT.network],
    keywordGroups: [],
    departmentId: JOSHIS,
    priority: 'inherit',
    dueOffsetDays: 0,
  },
  {
    id: 'inqrule_network_vendor',
    title: '回線事業者への障害問い合わせ',
    description: '社内機器に異常がない場合、回線事業者の障害情報を確認する',
    categoryIds: [CAT.network],
    keywordGroups: [['全員', '全社', '社内全体', 'フロア', 'みんな', '誰も', '複数']],
    departmentId: JOSHIS,
    priority: 'high',
    dueOffsetDays: 0,
  },
  {
    id: 'inqrule_software_install',
    title: 'ソフトウェアのライセンス確認・インストール',
    description: 'ライセンス残数と利用申請を確認してインストールする',
    categoryIds: [CAT.software],
    keywordGroups: [['インストール', '入れたい', '使いたい', 'ライセンス']],
    departmentId: JOSHIS,
    priority: 'inherit',
    dueOffsetDays: 3,
  },
  {
    id: 'inqrule_facility_order',
    title: '備品の在庫確認・手配',
    description: '在庫を確認し、不足していれば購入申請する',
    categoryIds: [CAT.facility],
    keywordGroups: [],
    departmentId: SOUMU,
    priority: 'inherit',
    dueOffsetDays: 3,
  },
  {
    id: 'inqrule_onboarding_link',
    title: '入社準備タスクとの照合',
    description: '入社予定者の準備タスク（PC準備・備品準備）と重複していないか確認する',
    categoryIds: [],
    keywordGroups: [['新入社員', '入社予定', '新しく入る', '中途入社']],
    departmentId: JINJI,
    priority: 'medium',
    dueOffsetDays: 1,
  },
  {
    id: 'inqrule_generic',
    title: '問い合わせ内容の確認・一次対応',
    description: '申請者に状況を確認し、対応方針を決める',
    categoryIds: [],
    keywordGroups: [],
    departmentId: null,
    priority: 'inherit',
    dueOffsetDays: 1,
  },
];

export interface TaskProposal {
  ruleId: string;
  title: string;
  description: string;
  assigneeDepartmentId: string;
  assignee: string;
  priority: Priority;
  dueDate: ISODate;
  status: 'new' | 'duplicate';
  reason: string;
}

export function proposeInquiryTasks(ctx: {
  inquiry: Inquiry;
  category: InquiryCategory | undefined;
  existingTasks: Task[];
  departmentIds: string[];
  today: ISODate;
}): TaskProposal[] {
  const { inquiry, category, existingTasks, departmentIds, today } = ctx;
  const text = normalizeText(`${inquiry.title} ${inquiry.body}`);
  const own = existingTasks.filter((t) => t.inquiryId === inquiry.id);
  const ruleIds = new Set(own.map((t) => t.ruleId));
  const titles = new Set(own.map((t) => normalizeTitle(t.title)));

  const matched = INQUIRY_TASK_RULES.filter((r) => {
    if (r.categoryIds.length && !r.categoryIds.includes(inquiry.categoryId)) return false;
    return r.keywordGroups.every((g) => g.some((k) => text.includes(normalizeText(k))));
  });
  // 具体的なルールが1件以上あれば汎用ルールは出さない
  const specific = matched.filter((r) => r.id !== 'inqrule_generic');
  const rules = specific.length ? specific : matched;

  const fallbackDept = category?.defaultDepartmentId && departmentIds.includes(category.defaultDepartmentId) ? category.defaultDepartmentId : departmentIds[0] ?? '';
  return rules.map((r) => {
    const dept = r.departmentId && departmentIds.includes(r.departmentId) ? r.departmentId : fallbackDept;
    let due = toPreviousBusinessDay(addDays(today, r.dueOffsetDays));
    if (due < today) due = today;
    // 問い合わせの期限より後にならないようにする
    if (inquiry.dueDate && due > inquiry.dueDate && inquiry.dueDate >= today) due = inquiry.dueDate;
    const dup = ruleIds.has(r.id) || titles.has(normalizeTitle(r.title));
    const why = r.keywordGroups.length
      ? `キーワード「${r.keywordGroups.map((g) => g.filter((k) => text.includes(normalizeText(k))).join('/')).join('・')}」に一致`
      : r.categoryIds.length
        ? `カテゴリ「${category?.name ?? ''}」の標準対応`
        : '一次対応の標準タスク';
    return {
      ruleId: r.id,
      title: r.title,
      description: r.description,
      assigneeDepartmentId: dept,
      assignee: dept === category?.defaultDepartmentId ? (inquiry.assignee || category?.defaultAssignee || '') : '',
      priority: r.priority === 'inherit' ? inquiry.priority : r.priority,
      dueDate: due,
      status: dup ? 'duplicate' : 'new',
      reason: dup ? 'この問い合わせから作成済み' : why,
    };
  });
}
