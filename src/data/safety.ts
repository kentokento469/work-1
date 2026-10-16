/**
 * 上書き前の退避 (Phase 9)。
 * バックアップからの復元・デモデータの初期化・全削除のように全データを置き換える操作の直前に、現在のデータを
 * 別のデータベース (`<DB名>-safety`) に1世代だけ保存する。操作を誤っても「直前のデータに戻す」で元に戻せる。
 *
 * - 同じ端末・同じブラウザの中だけの退避であり、端末の故障・紛失・ブラウザのデータ削除には対応しない (JSON バックアップが必要)
 * - 本体のデータベースとは別にしているため、本体の版の更新 (移行) の影響を受けない
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { DocumentFile } from '../domain/documents/types';
import type { DataSnapshot } from '../domain/types';

export interface SafetySnapshot {
  id: 'last';
  /** 退避した日時 */
  at: string;
  /** 退避の理由 (直後に行った操作) */
  reason: string;
  data: DataSnapshot;
  files: DocumentFile[];
}

export interface SafetySnapshotInfo {
  at: string;
  reason: string;
  counts: { employees: number; tasks: number; inquiries: number; items: number; documents: number };
}

interface SafetySchema extends DBSchema {
  snapshots: { key: string; value: SafetySnapshot };
}

export class SafetyStore {
  private dbp: Promise<IDBPDatabase<SafetySchema>> | null = null;
  constructor(private readonly name: string) {}

  private db() {
    this.dbp ??= openDB<SafetySchema>(this.name, 1, {
      upgrade(db) {
        db.createObjectStore('snapshots', { keyPath: 'id' });
      },
    });
    return this.dbp;
  }

  async save(reason: string, data: DataSnapshot, files: DocumentFile[], at: string): Promise<void> {
    await (await this.db()).put('snapshots', { id: 'last', at, reason, data, files });
  }

  async load(): Promise<SafetySnapshot | undefined> {
    return (await this.db()).get('snapshots', 'last');
  }

  async info(): Promise<SafetySnapshotInfo | null> {
    const s = await this.load();
    if (!s) return null;
    const d = s.data;
    return {
      at: s.at,
      reason: s.reason,
      counts: { employees: d.employees.length, tasks: d.tasks.length, inquiries: d.inquiries.length, items: d.items.length, documents: d.documents.length },
    };
  }

  async clear(): Promise<void> {
    await (await this.db()).delete('snapshots', 'last');
  }

  close() {
    void this.dbp?.then((db) => db.close());
    this.dbp = null;
  }
}
