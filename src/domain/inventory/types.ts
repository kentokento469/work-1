/**
 * Phase 3: 在庫・IT資産・購買の型定義。
 *
 * 設計の要点
 * - 数量管理品 (Item.tracking = 'quantity') と 個体管理の資産 (Asset) を分ける
 *   個体管理の品目 (tracking = 'asset') は「品目マスタ = 機種」、Asset = 1台ごとの台帳
 * - 在庫数量は StockLevel (保管場所ごとの現在庫) と StockMovement (入出庫台帳) を同じトランザクションで更新する。
 *   数量を直接書き換える操作は存在せず、必ず台帳 (根拠) が残る
 * - 「実在庫・予約・発注残」を区別する (Reservation / PurchaseOrder)
 * - 発注候補 (PurchaseSuggestion) と 確定発注 (PurchaseOrder) は別の型
 * - 金額は「参考単価 (品目マスタ)」「取得原価 (資産・発注明細)」を区別し、会計上の評価額は扱わない
 */
import type { ISODate, ISODateTime } from '../types';

export const INVENTORY_CATEGORIES = ['pc', 'monitor', 'keyboard', 'mouse', 'smartphone', 'cable', 'office', 'consumable', 'other'] as const;
export type InventoryCategory = (typeof INVENTORY_CATEGORIES)[number];
export const INVENTORY_CATEGORY_LABEL: Record<InventoryCategory, string> = {
  pc: 'PC',
  monitor: 'モニター',
  keyboard: 'キーボード',
  mouse: 'マウス',
  smartphone: 'スマートフォン',
  cable: 'ケーブル',
  office: '事務用品',
  consumable: '消耗品',
  other: 'その他',
};

export type TrackingMode = 'quantity' | 'asset';

/** 品目マスタ (商品・備品) */
export interface Item {
  id: string;
  /** 品目ID (例: ITM-0001) */
  code: string;
  name: string;
  category: InventoryCategory;
  maker: string;
  model: string;
  /** 管理単位 (個・台・箱 など) */
  unit: string;
  tracking: TrackingMode;
  /** 最低在庫数 (= 発注点。見込み在庫がこれを下回ると発注候補を作る) */
  minStock: number;
  /** 適正在庫数 (発注候補の推奨数量はここまで補充する量) */
  targetStock: number;
  /** 参考単価 (見積・概算用。会計上の評価額ではない) */
  unitPrice: number;
  defaultLocationId: string | null;
  defaultSupplierId: string | null;
  notes: string;
  /** 履歴のある品目は削除せず無効化する */
  active: boolean;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

/** 保管場所ごとの現在庫 (数量管理品のみ)。id = `${itemId}@${locationId}` */
export interface StockLevel {
  id: string;
  itemId: string;
  locationId: string;
  quantity: number;
}

export const MOVEMENT_TYPES = ['receive', 'issue', 'transfer', 'adjust', 'stocktake'] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];
export const MOVEMENT_TYPE_LABEL: Record<MovementType, string> = {
  receive: '入庫',
  issue: '出庫',
  transfer: '移動',
  adjust: '在庫調整',
  stocktake: '棚卸差異',
};

export type MovementRefType = 'manual' | 'purchase_order' | 'reservation' | 'inquiry' | 'employee' | 'stocktake' | 'reversal';

/** 入出庫台帳 (追記のみ・変更不可) */
export interface StockMovement {
  id: string;
  itemId: string;
  type: MovementType;
  /** 在庫総数への影響 (入庫 +, 出庫 -, 移動 0) */
  delta: number;
  /** 動かした数量 (正の数) */
  quantity: number;
  locationId: string;
  toLocationId: string | null;
  /** 処理後の在庫総数 (全保管場所の合計) */
  balanceAfter: number;
  reason: string;
  refType: MovementRefType;
  refId: string | null;
  employeeId: string | null;
  at: ISODateTime;
}

export type ReservationStatus = 'active' | 'backorder' | 'fulfilled' | 'released';
export const RESERVATION_STATUS_LABEL: Record<ReservationStatus, string> = {
  active: '引当済み',
  backorder: '入荷待ち',
  fulfilled: '引き渡し済み',
  released: '解除',
};

/**
 * 予約。active = 在庫を引当済み、backorder = 在庫が足りず入荷待ち (未充足の需要)。
 * 個体管理品の引当は Asset の status=reserved で表し、backorder だけをここに記録する。
 */
export interface Reservation {
  id: string;
  itemId: string;
  quantity: number;
  status: ReservationStatus;
  employeeId: string | null;
  inquiryId: string | null;
  purpose: string;
  /** 重複防止キー (例: onboarding:<社員ID>:<品目ID>) */
  key: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export const ASSET_STATUSES = ['unused', 'reserved', 'in_use', 'repair', 'broken', 'disposal_planned', 'disposed'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];
export const ASSET_STATUS_LABEL: Record<AssetStatus, string> = {
  unused: '未使用',
  reserved: '予約済み',
  in_use: '使用中',
  repair: '修理中',
  broken: '故障',
  disposal_planned: '廃棄予定',
  disposed: '廃棄済み',
};

/** IT資産台帳 (1台ごと) */
export interface Asset {
  id: string;
  /** 資産管理番号 (例: AST-0001) */
  assetNumber: string;
  /** 機種 (品目マスタ)。個体管理品の在庫数はこの紐付けで数える */
  itemId: string | null;
  name: string;
  category: InventoryCategory;
  maker: string;
  model: string;
  serialNumber: string;
  purchaseDate: ISODate | null;
  /** 取得原価 (購入金額) */
  purchaseCost: number | null;
  warrantyUntil: ISODate | null;
  status: AssetStatus;
  assigneeId: string | null;
  /** 割当時点の氏名・部署 (社員削除後も履歴が読めるように) */
  assigneeName: string;
  departmentId: string | null;
  locationId: string | null;
  purchaseOrderId: string | null;
  notes: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type AssetEventType = 'register' | 'reserve' | 'release' | 'assign' | 'return' | 'loan' | 'status' | 'edit';
export const ASSET_EVENT_LABEL: Record<AssetEventType, string> = {
  register: '登録',
  reserve: '予約',
  release: '予約解除',
  assign: '貸出',
  return: '返却',
  loan: '代替機の貸出',
  status: '状態変更',
  edit: '編集',
};

/** 資産の貸出・返却・状態変更の履歴 (追記のみ) */
export interface AssetEvent {
  id: string;
  assetId: string;
  type: AssetEventType;
  fromStatus: AssetStatus | null;
  toStatus: AssetStatus;
  employeeId: string | null;
  employeeName: string;
  inquiryId: string | null;
  note: string;
  at: ISODateTime;
}

export interface Location {
  id: string;
  name: string;
  order: number;
  active: boolean;
}

export interface Supplier {
  id: string;
  name: string;
  contactName: string;
  /** 架空の連絡先のみ。アプリから連絡・発注は行わない */
  phone: string;
  email: string;
  leadTimeDays: number;
  notes: string;
  active: boolean;
}

export type SuggestionStatus = 'open' | 'ordered' | 'dismissed' | 'resolved';
export const SUGGESTION_STATUS_LABEL: Record<SuggestionStatus, string> = {
  open: '候補',
  ordered: '発注書作成済み',
  dismissed: '見送り',
  resolved: '在庫回復',
};

/** 発注候補 (自動生成される下書き。確定発注ではない) */
export interface PurchaseSuggestion {
  id: string;
  itemId: string;
  quantity: number;
  /** 判定理由 (見込み在庫・最低在庫・入荷待ちの需要など) */
  reasons: string[];
  status: SuggestionStatus;
  purchaseOrderId: string | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export const PO_STATUSES = ['draft', 'pending_approval', 'approved', 'partially_received', 'received', 'cancelled'] as const;
export type PurchaseOrderStatus = (typeof PO_STATUSES)[number];
export const PO_STATUS_LABEL: Record<PurchaseOrderStatus, string> = {
  draft: '下書き',
  pending_approval: '承認待ち',
  approved: '承認済み（入荷待ち）',
  partially_received: '一部入荷',
  received: '入荷完了',
  cancelled: '取消',
};

export interface PurchaseOrderLine {
  id: string;
  itemId: string;
  quantity: number;
  /** 発注時の単価 (資産の取得原価になる) */
  unitPrice: number;
  receivedQuantity: number;
}

/** 発注依頼書 (アプリ内の記録のみ。外部への発注・送信・決済は行わない) */
export interface PurchaseOrder {
  id: string;
  /** 例: PO-2026-0001 */
  number: string;
  supplierId: string;
  status: PurchaseOrderStatus;
  lines: PurchaseOrderLine[];
  expectedDate: ISODate | null;
  requestedBy: string;
  approvedBy: string;
  notes: string;
  history: { at: ISODateTime; message: string }[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  approvedAt: ISODateTime | null;
}

/** 入社時に必要な機器のルール */
export interface EquipmentRule {
  id: string;
  /** 'common' または 部署ID */
  scope: string;
  itemId: string;
  quantity: number;
  enabled: boolean;
  order: number;
}

export type AutomationRunStatus = 'applied' | 'dismissed' | 'failed' | 'auto';

/** 自動化の処理履歴 */
export interface AutomationRun {
  id: string;
  automationId: string;
  /** 重複実行防止キー (対象 + 条件の指紋) */
  key: string;
  status: AutomationRunStatus;
  title: string;
  results: string[];
  error: string | null;
  at: ISODateTime;
}

