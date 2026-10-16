import type { DocumentRecord } from './documents/types';
import type {
  Asset,
  AssetEvent,
  AutomationRun,
  EquipmentRule,
  Item,
  Location,
  PurchaseOrder,
  PurchaseSuggestion,
  Reservation,
  StockLevel,
  StockMovement,
  Supplier,
} from './inventory/types';

/**
 * WorkCore ドメインモデル定義。
 * UI・永続化層の双方から参照される唯一の型定義ソース。
 */

export type ISODate = string; // YYYY-MM-DD (ローカル日付)
export type ISODateTime = string; // ISO 8601

export interface Department {
  id: string;
  name: string;
  order: number;
}

export const EMPLOYMENT_TYPES = ['正社員', '契約社員', 'パート・アルバイト', '派遣社員', '業務委託'] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const EMPLOYEE_STATUSES = ['pending', 'active', 'leave', 'retired'] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

export const EMPLOYEE_STATUS_LABEL: Record<EmployeeStatus, string> = {
  pending: '入社予定',
  active: '在籍',
  leave: '休職',
  retired: '退職',
};

export interface Employee {
  id: string;
  employeeNumber: string;
  name: string;
  departmentId: string;
  position: string;
  employmentType: EmploymentType;
  hireDate: ISODate;
  retireDate: ISODate | null;
  status: EmployeeStatus;
  notes: string;
  /** 連絡先・住所 (Phase 5 で追加。任意・既存データには無い) */
  contact?: EmployeeContact;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface EmployeeContact {
  email: string;
  /** 整形済みの文字列 (例: 090-1234-5678) */
  phone: string;
  /** 例: 254-0822 */
  postalCode: string;
  prefecture: string;
  city: string;
  town: string;
  addressLine: string;
}

export const TASK_STATUSES = ['todo', 'in_progress', 'done', 'on_hold'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  todo: '未着手',
  in_progress: '進行中',
  done: '完了',
  on_hold: '保留',
};

export const PRIORITIES = ['high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_LABEL: Record<Priority, string> = {
  high: '高',
  medium: '中',
  low: '低',
};

export const PRIORITY_WEIGHT: Record<Priority, number> = { high: 3, medium: 2, low: 1 };

export type TaskSource = 'manual' | 'onboarding' | 'inquiry' | 'automation';

export interface Task {
  id: string;
  employeeId: string | null;
  title: string;
  description: string;
  /** 担当部署 (Department.id)。Phase 7 から任意 (一般のタスクは部署なしで登録できる)。自動生成タスクは従来どおり設定される */
  assigneeDepartmentId: string | null;
  assignee: string;
  priority: Priority;
  /** 期限。Phase 7 から任意 (null = 期限なし。期限超過には数えない) */
  dueDate: ISODate | null;
  status: TaskStatus;
  source: TaskSource;
  /** 自動生成元ルール。重複生成防止キーに使用 */
  ruleId: string | null;
  /** 生成元の問い合わせ (Phase 2)。Phase 1 のデータはマイグレーションで null になる */
  inquiryId: string | null;
  /** 関連するIT資産 (Phase 3)。それ以前のデータには存在しない */
  assetId?: string | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  completedAt: ISODateTime | null;
  // ---- Phase 7 (すべて任意。旧データには存在しない = 未設定として扱う) ----
  /** 開始日 */
  startDate?: ISODate | null;
  /** 所属プロジェクト (Project.id)。未所属の独立タスクも可 */
  projectId?: string | null;
  /** 親タスク (サブタスクの場合)。入れ子は1段まで */
  parentTaskId?: string | null;
  /** 自由なタグ */
  tags?: string[];
  /** 親タスク内の軽量なチェック項目 (担当・期限は持たない) */
  checklist?: ChecklistItem[];
  /** 繰り返し設定 (期限を基準に次回を作る) */
  recurrence?: Recurrence | null;
  /** 繰り返しの系列 ID (同じ繰り返しの過去・次回のタスクで共通) */
  seriesId?: string | null;
  /** 繰り返しの次回タスクを作成済みなら、その ID (二重生成の防止) */
  nextOccurrenceId?: string | null;
  /** 前提となるタスク (依存関係) */
  dependsOn?: string[];
  /** 関連データ (品目・発注書・書類など。元の画面へ戻るためのリンク) */
  links?: TaskLink[];
  // ---- Phase 9 ----
  /** 対象社員の削除後も業務履歴として残した完了済みタスクの、削除時点の社員 (氏名で表示する) */
  formerEmployee?: { id: string; name: string; employeeNumber: string } | null;
}

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export type RecurrenceFreq = 'daily' | 'weekly' | 'monthly' | 'yearly';
export interface Recurrence {
  freq: RecurrenceFreq;
  /** 間隔 (1 = 毎回、2 = 隔週など) */
  interval: number;
  /** 毎週の場合の曜日 (0=日〜6=土)。空なら期限と同じ曜日 */
  weekdays?: number[];
  /** 毎月の場合の日付。'last' = 月末。未指定なら期限と同じ日 (存在しない日は月末に寄せる) */
  monthDay?: number | 'last';
  /** 繰り返しを設定した時の期限 (月末・うるう年で寄せた日付が次回以降に影響しないよう、元の日を覚えておく) */
  anchor?: ISODate;
}

export type TaskLinkKind = 'item' | 'purchaseOrder' | 'document' | 'asset' | 'inquiry' | 'employee';
export interface TaskLink {
  kind: TaskLinkKind;
  id: string;
}

/** プロジェクト (タスクのまとまり)。削除してもタスクは消さず、所属だけ外す */
export interface Project {
  id: string;
  name: string;
  description: string;
  archived: boolean;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

/**
 * 入社準備ルール。
 * scope が 'common' のものは全社員、部署IDのものはその部署の社員にのみ適用。
 * 期限は「入社日 + offsetDays」(負数で入社日前) で算出する。
 */
export interface OnboardingRule {
  id: string;
  title: string;
  description: string;
  scope: 'common' | string;
  assigneeDepartmentId: string;
  defaultAssignee: string;
  priority: Priority;
  offsetDays: number;
  /** 適用対象の雇用区分。空配列なら全区分 */
  employmentTypes: EmploymentType[];
  enabled: boolean;
  order: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type ActivityCategory =
  | 'employee'
  | 'task'
  | 'project'
  | 'onboarding'
  | 'rule'
  | 'department'
  | 'data'
  | 'inquiry'
  | 'faq'
  | 'category'
  | 'inventory'
  | 'asset'
  | 'purchase'
  | 'automation'
  | 'document';

export interface ActivityLog {
  id: string;
  at: ISODateTime;
  category: ActivityCategory;
  action: string;
  message: string;
  entityId: string | null;
}

// ===================== Phase 2: ヘルプデスク =====================

export const INQUIRY_STATUSES = ['new', 'in_progress', 'waiting', 'on_hold', 'resolved', 'closed'] as const;
export type InquiryStatus = (typeof INQUIRY_STATUSES)[number];

export const INQUIRY_STATUS_LABEL: Record<InquiryStatus, string> = {
  new: '新規',
  in_progress: '対応中',
  waiting: '回答待ち',
  on_hold: '保留',
  resolved: '解決済み',
  closed: '完了',
};

/** 「未解決」= まだ担当側で作業が残っている状態 */
export const OPEN_INQUIRY_STATUSES: readonly InquiryStatus[] = ['new', 'in_progress', 'waiting', 'on_hold'];

export interface InquiryCategory {
  id: string;
  name: string;
  /** 自動分類に使うキーワード (管理者が編集可能) */
  keywords: string[];
  /** 既定の担当部署・担当者 (自動入力の初期値) */
  defaultDepartmentId: string | null;
  defaultAssignee: string;
  /** 既定の対応期限 (受付日からの営業日数) */
  slaBusinessDays: number;
  enabled: boolean;
  order: number;
  /** 「その他・要確認」の受け皿カテゴリ。削除不可 */
  isFallback: boolean;
}

export type InquiryEventType = 'created' | 'comment' | 'status' | 'update' | 'task' | 'faq' | 'classification';

export interface InquiryEvent {
  id: string;
  at: ISODateTime;
  type: InquiryEventType;
  message: string;
}

/** 受付時点の自動分類結果 (監査・精度検証のため保存する) */
export interface ClassificationSnapshot {
  suggestedCategoryId: string;
  suggestedPriority: Priority;
  needsReview: boolean;
  /** 担当者が候補をそのまま採用したか */
  categoryAccepted: boolean;
  priorityAccepted: boolean;
  reasons: string[];
}

export interface Inquiry {
  id: string;
  /** 問い合わせ番号 (例: HD-2026-0001) */
  number: string;
  receivedAt: ISODateTime;
  requesterId: string | null;
  /** 社員削除後も履歴が読めるよう受付時点の氏名・部署を保持する */
  requesterName: string;
  requesterDepartmentId: string | null;
  title: string;
  body: string;
  categoryId: string;
  priority: Priority;
  assignee: string;
  dueDate: ISODate;
  status: InquiryStatus;
  resolution: string;
  resolvedAt: ISODateTime | null;
  closedAt: ISODateTime | null;
  classification: ClassificationSnapshot | null;
  /** 関連付けたFAQ */
  faqIds: string[];
  history: InquiryEvent[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface Faq {
  id: string;
  question: string;
  /** 確定した解決手順 */
  answer: string;
  categoryId: string;
  keywords: string[];
  enabled: boolean;
  /** 解決済み問い合わせからFAQ化した場合の元案件 */
  sourceInquiryId: string | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

/** バックアップ・復元対象となるデータ全体 */
export interface DataSnapshot {
  departments: Department[];
  employees: Employee[];
  tasks: Task[];
  rules: OnboardingRule[];
  activities: ActivityLog[];
  inquiries: Inquiry[];
  faqs: Faq[];
  inquiryCategories: InquiryCategory[];
  // Phase 3: 在庫・IT資産・購買
  items: Item[];
  stockLevels: StockLevel[];
  stockMovements: StockMovement[];
  reservations: Reservation[];
  assets: Asset[];
  assetEvents: AssetEvent[];
  locations: Location[];
  suppliers: Supplier[];
  purchaseSuggestions: PurchaseSuggestion[];
  purchaseOrders: PurchaseOrder[];
  equipmentRules: EquipmentRule[];
  automationRuns: AutomationRun[];
  // Phase 4: 書類 (元ファイル本体は含まない)
  documents: DocumentRecord[];
  // Phase 5: 設定値 (自動化ルールの有効/無効・実行方法など)
  settings: SettingRecord[];
  /** Phase 7: タスクのプロジェクト */
  projects: Project[];
}

/** アプリの設定値。id ごとに1件 (例: 'automation') */
export interface SettingRecord {
  id: string;
  value: unknown;
  updatedAt: string;
}
