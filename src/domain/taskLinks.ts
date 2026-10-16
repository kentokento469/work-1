/**
 * タスクの関連データ (品目・発注書・書類など) へのリンク。発生元の画面へ戻るために使う。
 */
import { DOCUMENT_TYPE_LABEL } from './documents/types';
import type { DataSnapshot, TaskLink } from './types';

export function linkHref(l: TaskLink): string {
  switch (l.kind) {
    case 'item':
      return `#/inventory/items/${encodeURIComponent(l.id)}`;
    case 'purchaseOrder':
      return `#/inventory/orders/${encodeURIComponent(l.id)}`;
    case 'asset':
      return `#/inventory/assets/${encodeURIComponent(l.id)}`;
    case 'document':
      return `#/documents/${encodeURIComponent(l.id)}`;
    case 'inquiry':
      return `#/helpdesk/${encodeURIComponent(l.id)}`;
    case 'employee':
      return `#/employees/${encodeURIComponent(l.id)}`;
  }
}

/** 表示名 (対象が削除されていれば「削除済み」と表示) */
export function linkLabel(l: TaskLink, data: Pick<DataSnapshot, 'items' | 'purchaseOrders' | 'assets' | 'documents' | 'inquiries' | 'employees'>): string {
  switch (l.kind) {
    case 'item': {
      const x = data.items.find((i) => i.id === l.id);
      return x ? `品目 ${x.name}` : '品目（削除済み）';
    }
    case 'purchaseOrder': {
      const x = data.purchaseOrders.find((i) => i.id === l.id);
      return x ? `発注書 ${x.number}` : '発注書（削除済み）';
    }
    case 'asset': {
      const x = data.assets.find((i) => i.id === l.id);
      return x ? `資産 ${x.assetNumber}` : '資産（削除済み）';
    }
    case 'document': {
      const x = data.documents.find((i) => i.id === l.id);
      return x ? `${DOCUMENT_TYPE_LABEL[x.type]} ${x.number}` : '書類（削除済み）';
    }
    case 'inquiry': {
      const x = data.inquiries.find((i) => i.id === l.id);
      return x ? `問い合わせ ${x.number}` : '問い合わせ（削除済み）';
    }
    case 'employee': {
      const x = data.employees.find((i) => i.id === l.id);
      return x ? `社員 ${x.name}` : '社員（削除済み）';
    }
  }
}

/** その対象に紐付いたタスクか */
export const isLinkedTo = (t: { links?: TaskLink[] }, kind: TaskLink['kind'], id: string) => !!t.links?.some((l) => l.kind === kind && l.id === id);
