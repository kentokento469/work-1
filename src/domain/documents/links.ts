/**
 * 書類 → 既存データの紐付け候補 (純粋関数)。
 * 読み取った発行元・宛先・申請者・明細から、社員・仕入先・発注書・品目の候補を、理由付きで返す。
 * 候補は提案であり、紐付けは利用者が選んだときだけ行う。
 */
import type { DataSnapshot, Employee } from '../types';
import type { Item, PurchaseOrder, Supplier } from '../inventory/types';
import type { DocumentLine, DocumentType, FieldKey } from './types';
import { normalizeParty, similarParty } from './duplicates';

const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s　]+/g, '');

/** 明細の品名から在庫の品目を推定 (品名・型番の包含)。候補が1つに絞れなければ null */
export function guessItem(lineName: string, items: Item[]): Item | null {
  const n = norm(lineName);
  if (!n) return null;
  const hits = items.filter((i) => {
    const name = norm(i.name.replace(/（.*?）|\(.*?\)/g, ''));
    const model = norm(i.model);
    return (name.length >= 2 && (n.includes(name) || name.includes(n))) || (model.length >= 3 && n.includes(model));
  });
  return hits.length === 1 ? hits[0]! : null;
}

export interface LinkCandidates {
  employees: { employee: Employee; reason: string }[];
  supplier: { supplier: Supplier; reason: string } | null;
  purchaseOrders: { order: PurchaseOrder; reason: string }[];
}

export function suggestDocumentLinks(
  doc: { type: DocumentType; fields: Partial<Record<FieldKey, string>>; lines: DocumentLine[] },
  data: Pick<DataSnapshot, 'employees' | 'suppliers' | 'purchaseOrders' | 'items'>,
): LinkCandidates {
  // 社員: 申請者・宛名 (「様」) と氏名の一致 (空白の有無は区別しない)
  const people = [doc.fields.applicant, doc.type !== 'invoice' && doc.type !== 'delivery' ? doc.fields.recipient : undefined].filter(Boolean) as string[];
  const employees = data.employees
    .filter((e) => people.some((p) => norm(p) === norm(e.name)))
    .map((e) => ({ employee: e, reason: `${doc.fields.applicant && norm(doc.fields.applicant) === norm(e.name) ? '申請者' : '宛名'}「${e.name}」と氏名が一致` }));

  // 仕入先: 発行元と仕入先名 (表記ゆれ・OCR の崩れを許容)
  const issuer = normalizeParty(doc.fields.issuer);
  let supplier: LinkCandidates['supplier'] = null;
  if (issuer) {
    const exact = data.suppliers.find((s) => normalizeParty(s.name) === issuer);
    const near = exact ?? data.suppliers.find((s) => similarParty(issuer, normalizeParty(s.name)));
    if (near) supplier = { supplier: near, reason: exact ? '発行元と仕入先名が一致' : '発行元と仕入先名が近い（表記ゆれ・読み取り誤りの可能性）' };
  }

  // 発注書: 同じ仕入先で、明細の品目が重なるもの (取消は除く)。入荷待ちを優先
  const lineItems = new Set(doc.lines.map((l) => guessItem(l.name, data.items)?.id).filter(Boolean) as string[]);
  const purchaseOrders = supplier
    ? data.purchaseOrders
        .filter((po) => po.supplierId === supplier.supplier.id && po.status !== 'cancelled')
        .map((po) => {
          const overlap = po.lines.filter((l) => lineItems.has(l.itemId)).length;
          const total = po.lines.reduce((a, l) => a + l.quantity * l.unitPrice, 0);
          const sameTotal = !!doc.fields.subtotal && Number(doc.fields.subtotal) === total;
          const open = po.status === 'approved' || po.status === 'partially_received';
          return { po, score: overlap * 2 + (sameTotal ? 3 : 0) + (open ? 1 : 0), overlap, sameTotal, open };
        })
        .filter((x) => x.overlap > 0 || x.sameTotal)
        .sort((a, b) => b.score - a.score || b.po.number.localeCompare(a.po.number))
        .slice(0, 3)
        .map((x) => ({ order: x.po, reason: [x.overlap ? `品目が${x.overlap}件一致` : '', x.sameTotal ? '小計が発注額と一致' : '', x.open ? '入荷待ち' : ''].filter(Boolean).join('・') }))
    : [];
  return { employees, supplier, purchaseOrders };
}
