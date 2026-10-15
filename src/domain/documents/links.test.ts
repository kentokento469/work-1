import { describe, expect, it } from 'vitest';
import { createDemoData } from '../../demo/demoData';
import { suggestDocumentLinks } from './links';

const data = createDemoData('2026-10-15');

describe('書類の紐付け候補', () => {
  it('発行元から仕入先、明細の品目から発注書の候補を出す（理由付き）', () => {
    const r = suggestDocumentLinks(
      { type: 'delivery', fields: { issuer: 'みどり事務用品(株)' }, lines: [{ id: 'l1', name: 'コピー用紙 A4', quantity: 10, unitPrice: 450, amount: 4500, itemId: null, evidence: '' }] },
      data,
    );
    expect(r.supplier?.supplier.name).toContain('みどり事務用品');
    expect(r.purchaseOrders[0]?.reason).toContain('品目が1件一致');
  });
  it('申請者の氏名から社員の候補を出す（空白の有無は区別しない）。一致しなければ出さない', () => {
    const emp = data.employees[0]!;
    const r = suggestDocumentLinks({ type: 'application', fields: { applicant: emp.name.replace(' ', '') }, lines: [] }, data);
    expect(r.employees.map((e) => e.employee.id)).toEqual([emp.id]);
    expect(suggestDocumentLinks({ type: 'application', fields: { applicant: '存在しない 人' }, lines: [] }, data).employees).toEqual([]);
  });
  it('発行元が仕入先にない場合は発注書の候補を出さない（推測で結び付けない）', () => {
    const r = suggestDocumentLinks({ type: 'delivery', fields: { issuer: '未登録商事株式会社' }, lines: [{ id: 'l1', name: 'コピー用紙 A4', quantity: 1, unitPrice: 1, amount: 1, itemId: null, evidence: '' }] }, data);
    expect(r.supplier).toBeNull();
    expect(r.purchaseOrders).toEqual([]);
  });
});
