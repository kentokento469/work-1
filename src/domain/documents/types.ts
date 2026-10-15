/**
 * Phase 4: 書類管理（請求書・領収書・納品書・見積書・申請書）の型。
 *
 * 書類のメタデータ・抽出結果 (documents) と、元ファイル本体 (documentFiles) は別ストアに保存する。
 * - documents は一覧・検索・集計で毎回読むため軽く保つ (スナップショットに含める)
 * - documentFiles は数MBになり得るので、必要な画面でだけ読み込む
 *
 * 抽出値は「現在の値 (fields)」と「自動抽出した値 (extracted)」を分けて持ち、
 * 修正前の値・抽出元のテキスト・確実性を後から確認できるようにする。
 */

export const DOCUMENT_TYPES = ['invoice', 'receipt', 'delivery', 'quote', 'application', 'other'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export const DOCUMENT_TYPE_LABEL: Record<DocumentType, string> = {
  invoice: '請求書',
  receipt: '領収書',
  delivery: '納品書',
  quote: '見積書',
  application: '申請書',
  other: 'その他',
};

/** 処理状態: 確認待ち（一時保存を含む）→ 確認済み → 保管 */
export const DOCUMENT_STATUSES = ['needs_review', 'confirmed', 'archived'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];
export const DOCUMENT_STATUS_LABEL: Record<DocumentStatus, string> = {
  needs_review: '確認待ち',
  confirmed: '確認済み',
  archived: '保管済み',
};

/** 抽出元: PDFに埋め込まれたテキスト / 画像OCR / 両方 / 手入力のみ */
export const EXTRACTION_METHODS = ['pdf_text', 'ocr', 'mixed', 'manual'] as const;
export type ExtractionMethod = (typeof EXTRACTION_METHODS)[number];
export const EXTRACTION_METHOD_LABEL: Record<ExtractionMethod, string> = {
  pdf_text: 'PDFのテキスト',
  ocr: '画像OCR',
  mixed: 'PDFテキスト＋OCR',
  manual: '手入力',
};

export const FIELD_KEYS = [
  'title',
  'issuer',
  'recipient',
  'issueDate',
  'docNumber',
  'total',
  'tax',
  'subtotal',
  'registrationNumber',
  'dueDate',
  'deliveryDate',
  'applicant',
  'applicationContent',
  'notes',
] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];

export type FieldFormat = 'text' | 'date' | 'amount' | 'registration';
export interface FieldDef {
  key: FieldKey;
  label: string;
  format: FieldFormat;
  /** 保存前に必ず確認する重要項目 */
  important?: boolean;
  /** 表示する書類種別 (未指定ならすべて) */
  types?: DocumentType[];
}

export const FIELD_DEFS: FieldDef[] = [
  { key: 'title', label: '書類名', format: 'text' },
  { key: 'issuer', label: '発行元（請求元・支払先）', format: 'text', important: true },
  { key: 'recipient', label: '宛先', format: 'text' },
  { key: 'issueDate', label: '発行日', format: 'date', important: true },
  { key: 'docNumber', label: '管理番号（書類番号）', format: 'text' },
  { key: 'total', label: '合計金額（税込・円）', format: 'amount', important: true },
  { key: 'tax', label: '消費税額（円）', format: 'amount' },
  { key: 'subtotal', label: '小計・税抜金額（円）', format: 'amount', types: ['invoice', 'receipt', 'delivery', 'quote'] },
  { key: 'registrationNumber', label: '適格請求書発行事業者 登録番号', format: 'registration', types: ['invoice', 'receipt'] },
  { key: 'dueDate', label: '支払期限', format: 'date', types: ['invoice'] },
  { key: 'deliveryDate', label: '納品日', format: 'date', types: ['delivery'] },
  { key: 'applicant', label: '申請者', format: 'text', types: ['application'] },
  { key: 'applicationContent', label: '申請内容', format: 'text', types: ['application'] },
  { key: 'notes', label: '備考', format: 'text' },
];
export const FIELD_LABEL = Object.fromEntries(FIELD_DEFS.map((f) => [f.key, f.label])) as Record<FieldKey, string>;

/**
 * 抽出の確実性 (OCRの文字認識の確からしさとは別物)。
 * high: ラベル（「合計」「請求書番号」など）と値の形式が両方一致
 * medium: ラベルはあるが形式・位置に曖昧さがある、または位置からの推定
 * low: 候補が複数ある・検算が合わないなど、確認が必要
 */
export type Certainty = 'high' | 'medium' | 'low';
export const CERTAINTY_LABEL: Record<Certainty, string> = { high: '確実性：高', medium: '確実性：中', low: '要確認' };

export interface FieldExtraction {
  /** 自動抽出した値 (正規化済み。日付は YYYY-MM-DD、金額は整数の文字列) */
  value: string;
  /** 抽出元の行 (原文) */
  evidence: string;
  page: number | null;
  certainty: Certainty;
  /** 判定理由・注意 */
  reasons: string[];
  /** 抽出元の行の OCR 信頼度 (0-100)。PDFテキスト・手入力では null */
  ocrConfidence: number | null;
}

export interface DocumentLine {
  id: string;
  name: string;
  quantity: number | null;
  unitPrice: number | null;
  amount: number | null;
  /** 在庫の品目への対応付け (納品書 → 在庫) */
  itemId: string | null;
  evidence: string;
}

export interface TaxLine {
  rate: number | null; // 10, 8
  taxable: number | null; // 対象額
  tax: number | null;
}

export interface DocumentPage {
  page: number; // 1始まり
  method: 'pdf_text' | 'ocr' | 'none';
  text: string;
  ocrConfidence: number | null;
}

export interface DocumentFileRef {
  fileId: string;
  name: string;
  mime: string;
  size: number;
  /** SHA-256 (16進)。完全一致の重複検出と、バックアップ復元時の破損検出に使う */
  hash: string;
  pageCount: number;
  /** OCR・抽出の対象にしたページ (1始まり) */
  selectedPages: number[];
}

export interface DocumentHistoryEntry {
  at: string;
  message: string;
}

export interface InventoryHandoff {
  at: string;
  /** 'receive' = 在庫へ直接入庫 / 'purchase_order' = 発注書の入荷として登録 */
  mode: 'receive' | 'purchase_order';
  purchaseOrderId: string | null;
  lines: { itemId: string; quantity: number }[];
  movementIds: string[];
}

export interface DocumentRecord {
  id: string;
  /** DOC-2026-0001 */
  number: string;
  type: DocumentType;
  status: DocumentStatus;
  method: ExtractionMethod;
  fields: Partial<Record<FieldKey, string>>;
  extracted: Partial<Record<FieldKey, FieldExtraction>>;
  /** 確認済みの項目 */
  reviewed: FieldKey[];
  lines: DocumentLine[];
  taxLines: TaxLine[];
  /** 抽出元テキスト全文 (ページ別) */
  pages: DocumentPage[];
  file: DocumentFileRef | null;
  // 関連業務 (Phase 1〜3 の既存データへの参照)
  employeeId: string | null;
  inquiryId: string | null;
  purchaseOrderId: string | null;
  supplierId: string | null;
  inventory: InventoryHandoff | null;
  /** 重複の可能性を確認したうえで「別の書類」と判断した書類ID */
  notDuplicateOf: string[];
  history: DocumentHistoryEntry[];
  createdAt: string;
  updatedAt: string;
  /** ゴミ箱に移した日時 (null = 通常)。完全削除はゴミ箱からのみ */
  deletedAt: string | null;
}

/** 元ファイル本体。iOS Safari での安定性を優先し Blob ではなく ArrayBuffer で保存する */
export interface DocumentFile {
  id: string;
  documentId: string;
  name: string;
  mime: string;
  size: number;
  hash: string;
  data: ArrayBuffer;
  createdAt: string;
}
