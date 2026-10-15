/**
 * 書類管理のサービス層 (Phase 4)。
 *
 * 流れ: 取り込み (元ファイルを即保存) → 抽出結果の反映 → 確認・修正 (一時保存可) → 確認完了
 * - 元ファイルは取り込んだ時点で保存する。OCR の途中でアプリが落ちても、原本と手入力の道は残る
 * - 抽出結果は「候補」。利用者が確認するまで「確認待ち」のまま
 * - 削除はまずゴミ箱へ (元に戻せる)。完全削除はゴミ箱からのみ
 * - 在庫への反映は確認済みの書類から、利用者の実行操作でのみ行う (InventoryService.receiveFromDocument)
 */
import type { WorkCoreDB } from '../data/db';
import { today as todayISO } from '../domain/date';
import { checkFields, type ExtractionResult } from '../domain/documents/extract';
import {
  DOCUMENT_STATUS_LABEL,
  DOCUMENT_TYPE_LABEL,
  FIELD_DEFS,
  FIELD_KEYS,
  FIELD_LABEL,
  type DocumentFile,
  type DocumentLine,
  type DocumentPage,
  type DocumentRecord,
  type DocumentStatus,
  type DocumentType,
  type ExtractionMethod,
  type FieldKey,
} from '../domain/documents/types';
import { generateId, nowISO } from '../domain/id';
import { AppError, abortWith, logActivity, type WriteTx } from './common';
import type { InventoryService, OpResult } from './inventoryService';

const STORES = ['documents', 'documentFiles', 'meta', 'activities', 'employees', 'inquiries', 'purchaseOrders', 'items'] as const;

/** 1ファイルの上限 (iPhone のメモリと保存容量を考慮) */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export interface NewDocumentInput {
  type: DocumentType;
  file?: { name: string; mime: string; data: ArrayBuffer; hash: string; pageCount: number } | null;
  /** 手入力で始める場合の初期値 */
  fields?: Partial<Record<FieldKey, string>>;
  employeeId?: string | null;
  inquiryId?: string | null;
  purchaseOrderId?: string | null;
  requestId?: string;
}

export interface ExtractionInput {
  method: ExtractionMethod;
  pages: DocumentPage[];
  selectedPages: number[];
  result: ExtractionResult;
  /** 利用者が種類を選んでいた場合は自動判定で上書きしない */
  keepType?: boolean;
}

export interface ReviewInput {
  type: DocumentType;
  fields: Partial<Record<FieldKey, string>>;
  lines: DocumentLine[];
  reviewed: FieldKey[];
  employeeId: string | null;
  inquiryId: string | null;
  purchaseOrderId: string | null;
  /** true = 確認完了 / false = 一時保存 */
  confirm: boolean;
}

export const IMPORTANT_FIELDS = FIELD_DEFS.filter((f) => f.important).map((f) => f.key);

const clean = (fields: Partial<Record<FieldKey, string>>) =>
  Object.fromEntries(Object.entries(fields).filter(([k, v]) => (FIELD_KEYS as readonly string[]).includes(k) && typeof v === 'string' && v.trim() !== '').map(([k, v]) => [k, v!.trim()])) as Partial<Record<FieldKey, string>>;

function isQuotaError(e: unknown) {
  return e instanceof DOMException && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED');
}

export class DocumentService {
  constructor(
    private readonly db: WorkCoreDB,
    private readonly clock: () => string = todayISO,
    private readonly inventory?: InventoryService,
  ) {}

  private async run<T>(fn: (tx: WriteTx) => Promise<T>): Promise<T> {
    const tx = this.db.transaction(STORES as never, 'readwrite') as unknown as WriteTx;
    try {
      const r = await fn(tx);
      await tx.done;
      return r;
    } catch (e) {
      if (isQuotaError(e) || (e instanceof Error && /quota/i.test(e.message)))
        return abortWith(tx, new AppError('端末の保存容量が不足しているため保存できませんでした。不要な書類をゴミ箱から完全削除するか、バックアップを取ってから古いデータを整理してください'));
      return abortWith(tx, e instanceof AppError ? e : new AppError(e instanceof Error ? e.message : '処理に失敗しました'));
    }
  }

  private async get(tx: WriteTx, id: string): Promise<DocumentRecord> {
    const d = await tx.objectStore('documents').get(id);
    if (!d) throw new AppError('書類が見つかりません');
    return d;
  }

  private async nextNumber(tx: WriteTx): Promise<string> {
    const year = this.clock().slice(0, 4);
    const prefix = `DOC-${year}-`;
    // index の getAllKeys は主キーを返すため、番号は値から読む
    const nums = (await tx.objectStore('documents').getAll()).map((d) => d.number).filter((n) => n.startsWith(prefix));
    const max = nums.reduce((m, n) => Math.max(m, Number(n.slice(prefix.length)) || 0), 0);
    return `${prefix}${String(max + 1).padStart(4, '0')}`;
  }

  private async checkRelations(tx: WriteTx, r: { employeeId?: string | null; inquiryId?: string | null; purchaseOrderId?: string | null }) {
    if (r.employeeId && !(await tx.objectStore('employees').get(r.employeeId))) throw new AppError('関連付ける社員が見つかりません');
    if (r.inquiryId && !(await tx.objectStore('inquiries').get(r.inquiryId))) throw new AppError('関連付ける問い合わせが見つかりません');
    if (r.purchaseOrderId && !(await tx.objectStore('purchaseOrders').get(r.purchaseOrderId))) throw new AppError('関連付ける発注書が見つかりません');
  }

  /** 書類を登録する。元ファイルがあれば同じトランザクションで保存する */
  async create(p: NewDocumentInput): Promise<OpResult<DocumentRecord>> {
    if (p.file && p.file.data.byteLength > MAX_FILE_BYTES) throw new AppError(`ファイルが大きすぎます（上限 ${MAX_FILE_BYTES / 1024 / 1024}MB）`);
    return this.run(async (tx) => {
      if (p.requestId && (await tx.objectStore('meta').get(`req:${p.requestId}`))) return { duplicated: true } as const;
      await this.checkRelations(tx, p);
      const now = nowISO();
      const id = generateId('doc');
      const fileId = p.file ? generateId('dfile') : null;
      const doc: DocumentRecord = {
        id,
        number: await this.nextNumber(tx),
        type: p.type,
        status: 'needs_review',
        method: 'manual',
        fields: clean(p.fields ?? {}),
        extracted: {},
        reviewed: [],
        lines: [],
        taxLines: [],
        pages: [],
        file: p.file ? { fileId: fileId!, name: p.file.name, mime: p.file.mime, size: p.file.data.byteLength, hash: p.file.hash, pageCount: p.file.pageCount, selectedPages: [] } : null,
        employeeId: p.employeeId ?? null,
        inquiryId: p.inquiryId ?? null,
        purchaseOrderId: p.purchaseOrderId ?? null,
        supplierId: null,
        inventory: null,
        notDuplicateOf: [],
        history: [{ at: now, message: p.file ? `「${p.file.name}」を取り込み（${DOCUMENT_TYPE_LABEL[p.type]}）` : `手入力で登録（${DOCUMENT_TYPE_LABEL[p.type]}）` }],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      await tx.objectStore('documents').add(doc);
      if (p.file) {
        const f: DocumentFile = { id: fileId!, documentId: id, name: p.file.name, mime: p.file.mime, size: p.file.data.byteLength, hash: p.file.hash, data: p.file.data, createdAt: now };
        await tx.objectStore('documentFiles').add(f);
      }
      if (p.requestId) await tx.objectStore('meta').put({ key: `req:${p.requestId}`, value: now });
      await logActivity(tx, 'document', 'create', `書類 ${doc.number}（${DOCUMENT_TYPE_LABEL[doc.type]}）を登録しました`, id);
      return { duplicated: false, value: doc } as const;
    });
  }

  /**
   * 抽出結果を反映する。利用者が既に手で修正した項目は上書きしない
   * (現在値が前回の抽出値と同じ、または空の項目だけを新しい抽出値で置き換える)
   */
  async applyExtraction(id: string, x: ExtractionInput): Promise<DocumentRecord> {
    return this.run(async (tx) => {
      const d = await this.get(tx, id);
      if (d.deletedAt) throw new AppError('ゴミ箱の書類は処理できません');
      if (d.status === 'confirmed') throw new AppError('確認済みの書類は再抽出できません。「確認待ちに戻す」を行ってから実行してください');
      const fields = { ...d.fields };
      let kept = 0;
      for (const k of FIELD_KEYS) {
        const cur = d.fields[k];
        const prevAuto = d.extracted[k]?.value;
        const next = x.result.fields[k]?.value;
        if (cur === undefined || cur === '' || cur === prevAuto) {
          if (next !== undefined) fields[k] = next;
          else delete fields[k];
        } else if (next !== undefined && next !== cur) kept++;
      }
      const userLines = d.lines.some((l) => !l.id.startsWith('ln_'));
      const next: DocumentRecord = {
        ...d,
        type: x.keepType ? d.type : x.result.type,
        method: x.method,
        pages: x.pages,
        extracted: x.result.fields,
        fields,
        // 抽出し直した項目は確認をやり直す
        reviewed: d.reviewed.filter((k) => fields[k] === d.fields[k]),
        lines: userLines ? d.lines : x.result.lines,
        taxLines: x.result.taxLines,
        file: d.file ? { ...d.file, selectedPages: x.selectedPages } : null,
        updatedAt: nowISO(),
        history: [
          ...d.history,
          {
            at: nowISO(),
            message: `${x.method === 'ocr' ? '画像OCR' : x.method === 'pdf_text' ? 'PDFのテキスト' : x.method === 'mixed' ? 'PDFテキスト＋OCR' : '手入力'}で ${Object.keys(x.result.fields).length}項目・明細${x.result.lines.length}行を抽出（${x.selectedPages.length}ページ）${kept ? `。手で修正済みの${kept}項目はそのまま` : ''}`,
          },
        ],
      };
      await tx.objectStore('documents').put(next);
      await logActivity(tx, 'document', 'extract', `書類 ${d.number} の抽出結果を反映しました`, id);
      return next;
    });
  }

  /** 確認・修正の保存。confirm=true で確認完了、false で一時保存 */
  async saveReview(id: string, r: ReviewInput): Promise<DocumentRecord> {
    return this.run(async (tx) => {
      const d = await this.get(tx, id);
      if (d.deletedAt) throw new AppError('ゴミ箱の書類は編集できません。先に元に戻してください');
      const fields = clean(r.fields);
      const errors = checkFields(fields, r.lines).filter((i) => i.level === 'error');
      if (errors.length) throw new AppError(errors[0]!.message);
      await this.checkRelations(tx, r);
      if (r.purchaseOrderId !== d.purchaseOrderId && d.inventory) throw new AppError('在庫に反映済みの書類は、関連発注書を変更できません');
      const reviewed = [...new Set(r.reviewed)].filter((k) => (FIELD_KEYS as readonly string[]).includes(k));
      if (r.confirm) {
        const missing = IMPORTANT_FIELDS.filter((k) => !reviewed.includes(k));
        if (missing.length) throw new AppError(`確認が必要な項目があります：${missing.map((k) => FIELD_LABEL[k]).join('・')}`);
      }
      const changes = FIELD_KEYS.filter((k) => (d.fields[k] ?? '') !== (fields[k] ?? '')).map((k) => `${FIELD_LABEL[k]}「${d.fields[k] ?? '空欄'}」→「${fields[k] ?? '空欄'}」`);
      // 確認済みの書類も、変更を一時保存すると確認待ちに戻る (確認していない値を「確認済み」として残さない)
      const status: DocumentStatus = r.confirm ? 'confirmed' : 'needs_review';
      const msg = [r.confirm ? '確認完了' : '一時保存', changes.length ? `修正：${changes.slice(0, 5).join('、')}${changes.length > 5 ? ` ほか${changes.length - 5}件` : ''}` : ''].filter(Boolean).join('。');
      const next: DocumentRecord = {
        ...d,
        type: r.type,
        fields,
        lines: r.lines,
        reviewed,
        employeeId: r.employeeId,
        inquiryId: r.inquiryId,
        purchaseOrderId: r.purchaseOrderId,
        status,
        updatedAt: nowISO(),
        history: [...d.history, { at: nowISO(), message: msg }],
      };
      await tx.objectStore('documents').put(next);
      await logActivity(tx, 'document', r.confirm ? 'confirm' : 'save', `書類 ${d.number} を${r.confirm ? '確認済みにしました' : '一時保存しました'}`, id);
      return next;
    });
  }

  async setStatus(id: string, status: DocumentStatus): Promise<DocumentRecord & { previousStatus: DocumentStatus }> {
    return this.run(async (tx) => {
      const d = await this.get(tx, id);
      if (status === 'confirmed' && IMPORTANT_FIELDS.some((k) => !d.reviewed.includes(k))) throw new AppError('重要項目の確認が終わっていないため、確認済みにできません');
      const next = { ...d, status, updatedAt: nowISO(), history: [...d.history, { at: nowISO(), message: `処理状態を「${DOCUMENT_STATUS_LABEL[status]}」に変更` }] };
      await tx.objectStore('documents').put(next);
      await logActivity(tx, 'document', 'status', `書類 ${d.number} を「${DOCUMENT_STATUS_LABEL[status]}」にしました`, id);
      return { ...next, previousStatus: d.status };
    });
  }

  /** ゴミ箱へ移す (元ファイル・抽出結果は残る。元に戻せる) */
  async trash(id: string): Promise<DocumentRecord> {
    return this.run(async (tx) => {
      const d = await this.get(tx, id);
      if (d.deletedAt) return d;
      const next = { ...d, deletedAt: nowISO(), updatedAt: nowISO(), history: [...d.history, { at: nowISO(), message: 'ゴミ箱へ移動' }] };
      await tx.objectStore('documents').put(next);
      await logActivity(tx, 'document', 'trash', `書類 ${d.number} をゴミ箱へ移しました`, id);
      return next;
    });
  }

  async restoreFromTrash(id: string): Promise<DocumentRecord> {
    return this.run(async (tx) => {
      const d = await this.get(tx, id);
      const next = { ...d, deletedAt: null, updatedAt: nowISO(), history: [...d.history, { at: nowISO(), message: 'ゴミ箱から元に戻す' }] };
      await tx.objectStore('documents').put(next);
      await logActivity(tx, 'document', 'restore', `書類 ${d.number} をゴミ箱から戻しました`, id);
      return next;
    });
  }

  /** 完全削除 (ゴミ箱の書類のみ)。在庫に反映済みの書類は、在庫の履歴の根拠になるため削除しない */
  async purge(id: string): Promise<void> {
    return this.run(async (tx) => {
      const d = await this.get(tx, id);
      if (!d.deletedAt) throw new AppError('完全に削除できるのはゴミ箱の書類だけです');
      if (d.inventory) throw new AppError('在庫に反映した書類は、入出庫履歴の根拠のため完全削除できません（ゴミ箱に残せます）');
      const files = await tx.objectStore('documentFiles').index('byDocument').getAll(id);
      for (const f of files) await tx.objectStore('documentFiles').delete(f.id);
      await tx.objectStore('documents').delete(id);
      await logActivity(tx, 'document', 'purge', `書類 ${d.number} を完全に削除しました`, null);
    });
  }

  /** 重複の可能性を確認した結果「別の書類」と判断した記録 (以後その組み合わせでは警告しない) */
  async markNotDuplicate(id: string, otherId: string): Promise<DocumentRecord> {
    return this.run(async (tx) => {
      const d = await this.get(tx, id);
      const other = await this.get(tx, otherId);
      if (d.notDuplicateOf.includes(otherId)) return d;
      const next = { ...d, notDuplicateOf: [...d.notDuplicateOf, otherId], updatedAt: nowISO(), history: [...d.history, { at: nowISO(), message: `${other.number} と比較し、別の書類と判断` }] };
      await tx.objectStore('documents').put(next);
      await logActivity(tx, 'document', 'not_duplicate', `書類 ${d.number} と ${other.number} を別の書類として確認しました`, id);
      return next;
    });
  }

  async getFile(fileId: string): Promise<DocumentFile | undefined> {
    return this.db.get('documentFiles', fileId);
  }

  async findFilesByHash(hash: string): Promise<DocumentFile[]> {
    return this.db.getAllFromIndex('documentFiles', 'byHash', hash);
  }

  /** 納品書の明細を在庫へ引き渡す (確認済みの書類のみ・利用者の実行操作でのみ呼ぶ) */
  async handoffToInventory(...args: Parameters<InventoryService['receiveFromDocument']>) {
    if (!this.inventory) throw new AppError('在庫サービスが利用できません');
    return this.inventory.receiveFromDocument(...args);
  }

  /** 元ファイルの合計サイズ (保存容量の表示用) */
  async totalFileBytes(): Promise<number> {
    let total = 0;
    let cursor = await this.db.transaction('documentFiles').store.openCursor();
    while (cursor) {
      total += cursor.value.size;
      cursor = await cursor.continue();
    }
    return total;
  }
}

