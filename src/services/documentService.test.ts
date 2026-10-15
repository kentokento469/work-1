import { describe, expect, it } from 'vitest';
import { createService, TODAY } from '../test/helpers';
import { DB_VERSION, openWorkCoreDB } from '../data/db';
import { generateId } from '../domain/id';
import { createBackup, decodeBackupFiles, parseBackupText } from '../data/backup';
import { extractDocument } from '../domain/documents/extract';
import { findDuplicates } from '../domain/documents/duplicates';
import { sha256Hex } from '../domain/documents/hash';
import { computeStockStatus } from '../domain/inventory/stock';
import { ITEM, LOC } from '../domain/inventory/defaults';
import { createDemoData } from '../demo/demoData';
import { WorkCoreService } from './workcoreService';
import { documentLinesToCsv, documentsToCsv, filterDocumentsForExport } from '../data/csv';
import type { DataSnapshot } from '../domain/types';

async function setup() {
  const { service } = await createService();
  await service.ensureInitialized();
  return { service, docs: service.documents };
}
const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
async function fileOf(content: string, name = 'receipt.png') {
  const data = bytes(content);
  return { name, mime: 'image/png', data, hash: await sha256Hex(data), pageCount: 1 };
}
const page = (text: string) => [{ page: 1, lines: text.split('\n').map((t) => ({ text: t, confidence: 90 })) }];
const DELIVERY = `納品書\n納品書番号 DN-881\n納品日 2026年10月14日\n株式会社あおばテクノサービス 御中\nみどり事務用品株式会社\n品名 数量 単価 金額\nコピー用紙 A4 10 冊 450 4,500\n名刺ケース 3 個 800 2,400\n合計 6,900`;
const stock = (d: DataSnapshot, itemId: string) => computeStockStatus(d.items.find((i) => i.id === itemId)!, d);

describe('書類の登録・抽出・確認', () => {
  it('元ファイルと書類を同時に保存し、同じ requestId では1件だけ登録する', async () => {
    const { service, docs } = await setup();
    const rid = generateId('req');
    const file = await fileOf('PNGDATA-1');
    const [a, b] = await Promise.all([docs.create({ type: 'receipt', file, requestId: rid }), docs.create({ type: 'receipt', file, requestId: rid })]);
    expect([a.duplicated, b.duplicated].sort()).toEqual([false, true]);
    const d = await service.loadSnapshot();
    expect(d.documents).toHaveLength(1);
    const doc = d.documents[0]!;
    expect(doc.number).toBe('DOC-2026-0001');
    expect(doc.status).toBe('needs_review');
    const stored = await docs.getFile(doc.file!.fileId);
    expect(stored?.hash).toBe(file.hash);
    expect(new TextDecoder().decode(stored!.data)).toBe('PNGDATA-1');
  });

  it('抽出結果を反映し、手で修正した項目は再抽出で上書きしない', async () => {
    const { docs } = await setup();
    const doc = (await docs.create({ type: 'other', file: await fileOf('x') })).value!;
    const r1 = extractDocument(page(DELIVERY));
    let d = await docs.applyExtraction(doc.id, { method: 'ocr', pages: [{ page: 1, method: 'ocr', text: DELIVERY, ocrConfidence: 90 }], selectedPages: [1], result: r1 });
    expect(d.type).toBe('delivery');
    expect(d.fields.total).toBe('6900');
    expect(d.lines).toHaveLength(2);
    // 発行元を手で修正 → 一時保存
    d = await docs.saveReview(doc.id, { type: d.type, fields: { ...d.fields, issuer: 'みどり事務用品株式会社 本店' }, lines: d.lines, reviewed: ['issuer'], employeeId: null, inquiryId: null, purchaseOrderId: null, confirm: false });
    expect(d.status).toBe('needs_review');
    expect(d.history.at(-1)?.message).toContain('一時保存');
    // 再抽出しても、修正済みの発行元は残り、修正前の値は extracted で参照できる
    d = await docs.applyExtraction(doc.id, { method: 'ocr', pages: d.pages, selectedPages: [1], result: extractDocument(page(DELIVERY)) });
    expect(d.fields.issuer).toBe('みどり事務用品株式会社 本店');
    expect(d.extracted.issuer?.value).toBe('みどり事務用品株式会社');
    expect(d.history.at(-1)?.message).toContain('手で修正済みの1項目はそのまま');
  });

  it('形式エラーは保存できず、重要項目を確認しないと確認完了にできない', async () => {
    const { docs } = await setup();
    const doc = (await docs.create({ type: 'receipt', fields: { issuer: 'テスト商店', total: '5500', issueDate: '2026-10-12' } })).value!;
    const base = { type: doc.type, lines: [], employeeId: null, inquiryId: null, purchaseOrderId: null };
    await expect(docs.saveReview(doc.id, { ...base, fields: { ...doc.fields, issueDate: '2026-02-30' }, reviewed: [], confirm: false })).rejects.toThrow('YYYY-MM-DD');
    await expect(docs.saveReview(doc.id, { ...base, fields: { ...doc.fields, total: '5,500円' }, reviewed: [], confirm: false })).rejects.toThrow('整数');
    await expect(docs.saveReview(doc.id, { ...base, fields: doc.fields, reviewed: ['issuer'], confirm: true })).rejects.toThrow('確認が必要な項目');
    const ok = await docs.saveReview(doc.id, { ...base, fields: doc.fields, reviewed: ['issuer', 'issueDate', 'total'], confirm: true });
    expect(ok.status).toBe('confirmed');
    await expect(docs.applyExtraction(doc.id, { method: 'ocr', pages: [], selectedPages: [], result: extractDocument(page('領収書')) })).rejects.toThrow('確認済み');
  });

  it('ゴミ箱 → 元に戻す → 完全削除（元ファイルも削除）', async () => {
    const { service, docs } = await setup();
    const doc = (await docs.create({ type: 'receipt', file: await fileOf('y') })).value!;
    await expect(docs.purge(doc.id)).rejects.toThrow('ゴミ箱');
    await docs.trash(doc.id);
    await docs.restoreFromTrash(doc.id);
    expect((await service.loadSnapshot()).documents[0]!.deletedAt).toBeNull();
    await docs.trash(doc.id);
    await docs.purge(doc.id);
    expect((await service.loadSnapshot()).documents).toHaveLength(0);
    expect(await docs.getFile(doc.file!.fileId)).toBeUndefined();
  });
});

describe('重複検出', () => {
  it('同じファイルは完全一致、発行元＋書類番号は一致の可能性大、別と判断したら警告しない', async () => {
    const { service, docs } = await setup();
    const file = await fileOf('same-bytes');
    const a = (await docs.create({ type: 'invoice', file, fields: { issuer: '架空PCサプライ株式会社', docNumber: 'INV-42', total: '1000', issueDate: '2026-10-01' } })).value!;
    let d = await service.loadSnapshot();
    expect(findDuplicates({ hash: file.hash, fields: {} }, d.documents)[0]?.level).toBe('exact');
    expect(findDuplicates({ type: 'invoice', fields: { issuer: '架空PCサプライ(株)', docNumber: 'inv 42' } }, d.documents)[0]?.level).toBe('likely');
    expect(findDuplicates({ fields: { issuer: '架空PCサプライ株式会社', issueDate: '2026-10-01', total: '1000' } }, d.documents)[0]?.level).toBe('similar');
    // OCR で発行元が崩れても、登録番号・発行日・金額が同じなら類似として警告
    const b0 = (await docs.create({ type: 'receipt', fields: { issuer: 'テスト商店', registrationNumber: 'T9876543210987', issueDate: '2026-10-12', total: '5500' } })).value!;
    d = await service.loadSnapshot();
    expect(findDuplicates({ fields: { issuer: '品株式会社', registrationNumber: 'T9876543210987', issueDate: '2026-10-12', total: '5500' } }, d.documents)[0]?.document.id).toBe(b0.id);
    expect(findDuplicates({ fields: { issuer: 'テスト商占', issueDate: '2026-10-12', total: '5500' } }, d.documents)[0]?.reasons.join()).toContain('表記が近い');
    await docs.trash(b0.id);
    d = await service.loadSnapshot();
    // 金額と日付だけ同じ (発行元が違う) は重複扱いしない
    expect(findDuplicates({ fields: { issuer: '別会社', issueDate: '2026-10-01', total: '1000' } }, d.documents)).toHaveLength(0);
    const b = (await docs.create({ type: 'invoice', fields: { issuer: '架空PCサプライ株式会社', docNumber: 'INV-42' } })).value!;
    await docs.markNotDuplicate(b.id, a.id);
    d = await service.loadSnapshot();
    const nb = d.documents.find((x) => x.id === b.id)!;
    expect(findDuplicates({ id: nb.id, type: nb.type, fields: nb.fields, notDuplicateOf: nb.notDuplicateOf }, d.documents)).toHaveLength(0);
    // 自動では削除・統合しない
    expect(d.documents.filter((x) => !x.deletedAt)).toHaveLength(2);
  });
});

describe('在庫への引き渡し（納品書）', () => {
  async function confirmedDelivery(service: WorkCoreService, purchaseOrderId: string | null = null) {
    const docs = service.documents;
    const doc = (await docs.create({ type: 'delivery', purchaseOrderId })).value!;
    const r = extractDocument(page(DELIVERY));
    const d = await docs.applyExtraction(doc.id, { method: 'pdf_text', pages: [], selectedPages: [1], result: r, keepType: true });
    return docs.saveReview(doc.id, { type: 'delivery', fields: d.fields, lines: d.lines, reviewed: ['issuer', 'issueDate', 'total'], employeeId: null, inquiryId: null, purchaseOrderId, confirm: true });
  }

  it('確認前は反映できず、確認後に1回だけ入庫（書類・在庫・履歴を同時に更新）', async () => {
    const { service, docs } = await setup();
    const draft = (await docs.create({ type: 'delivery' })).value!;
    await expect(docs.handoffToInventory({ documentId: draft.id, mode: 'receive', locationId: LOC.main, lines: [{ itemId: ITEM.paper, quantity: 10 }] })).rejects.toThrow('確認済み');
    const doc = await confirmedDelivery(service);
    const before = stock(await service.loadSnapshot(), ITEM.paper).onHand;
    const lines = [{ itemId: ITEM.paper, quantity: 10 }, { itemId: ITEM.nameCard, quantity: 3 }];
    const rid = generateId('req');
    const r = await docs.handoffToInventory({ documentId: doc.id, mode: 'receive', locationId: LOC.main, lines, requestId: rid });
    expect(r.duplicated).toBe(false);
    expect((await docs.handoffToInventory({ documentId: doc.id, mode: 'receive', locationId: LOC.main, lines, requestId: rid })).duplicated).toBe(true);
    await expect(docs.handoffToInventory({ documentId: doc.id, mode: 'receive', locationId: LOC.main, lines })).rejects.toThrow('既に在庫へ反映済み');
    const d = await service.loadSnapshot();
    expect(stock(d, ITEM.paper).onHand).toBe(before + 10);
    const mv = d.stockMovements.filter((m) => m.refType === 'document' && m.refId === doc.id);
    expect(mv).toHaveLength(2);
    expect(d.documents.find((x) => x.id === doc.id)!.inventory?.movementIds.sort()).toEqual(mv.map((m) => m.id).sort());
    // 書類からの入庫は取り消しではなく在庫調整で訂正する
    await expect(service.inventory.reverseMovement(mv[0]!.id)).rejects.toThrow('在庫調整');
    // 在庫に反映した書類は完全削除できない
    await docs.trash(doc.id);
    await expect(docs.purge(doc.id)).rejects.toThrow('完全削除できません');
  });

  it('個体管理品は直接入庫できず、関連発注書の入荷としてなら資産が登録される', async () => {
    const { service, docs } = await setup();
    const doc = await confirmedDelivery(service);
    await expect(docs.handoffToInventory({ documentId: doc.id, mode: 'receive', locationId: LOC.it, lines: [{ itemId: ITEM.laptop, quantity: 1 }] })).rejects.toThrow('1台ずつ管理');
    // 承認済み発注書 (デモ: マウス ×5) の入荷として登録
    const d0 = await service.loadSnapshot();
    const po = d0.purchaseOrders.find((p) => p.status === 'approved')!;
    const doc2 = await confirmedDelivery(service, po.id);
    await expect(docs.handoffToInventory({ documentId: doc2.id, mode: 'purchase_order', locationId: LOC.it, lines: [{ itemId: ITEM.paper, quantity: 1 }] })).rejects.toThrow('発注書にない品目');
    await docs.handoffToInventory({ documentId: doc2.id, mode: 'purchase_order', locationId: LOC.it, lines: [{ itemId: po.lines[0]!.itemId, quantity: 2 }] });
    const d = await service.loadSnapshot();
    const after = d.purchaseOrders.find((p) => p.id === po.id)!;
    expect(after.status).toBe('partially_received');
    expect(after.history.at(-1)?.message).toContain(doc2.number);
  });
});

describe('関連付け・データ保護', () => {
  it('社員を削除しても書類は残り、関連付けだけ外れる（取り消すと戻る）', async () => {
    const { service, docs } = await setup();
    const d0 = await service.loadSnapshot();
    const emp = d0.employees.find((e) => !d0.assets.some((a) => a.assigneeId === e.id) && !d0.reservations.some((r) => r.employeeId === e.id))!;
    const doc = (await docs.create({ type: 'application', employeeId: emp.id })).value!;
    const deleted = await service.deleteEmployee(emp.id);
    let d = await service.loadSnapshot();
    expect(d.documents.find((x) => x.id === doc.id)!.employeeId).toBeNull();
    await service.restoreEmployee(deleted);
    d = await service.loadSnapshot();
    expect(d.documents.find((x) => x.id === doc.id)!.employeeId).toBe(emp.id);
  });

  it('v4 バックアップ（元ファイル込み）の往復で、元ファイルのハッシュまで一致する。破損は検出する', async () => {
    const a = await setup();
    const file = await fileOf('original-file-content');
    const doc = (await a.docs.create({ type: 'receipt', file, fields: { total: '5500' } })).value!;
    const snap = await a.service.loadSnapshot();
    const files = await a.service.loadAllDocumentFiles();
    const text = JSON.stringify(createBackup(snap, new Date(), files));
    const r = parseBackupText(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.counts.documents).toBe(1);
    const decoded = await decodeBackupFiles(r.backup);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const b = await setup();
    await b.service.restoreBackup(r.backup, decoded.files);
    const restored = await b.docs.getFile(doc.file!.fileId);
    expect(await sha256Hex(restored!.data)).toBe(file.hash);
    expect((await b.service.loadSnapshot()).documents[0]!.fields.total).toBe('5500');

    // ファイル本体の改ざん → 復元しない
    const tampered = JSON.parse(text);
    tampered.files[0].base64 = btoa('tampered-content!!!!!');
    tampered.files[0].size = 21;
    const t = parseBackupText(JSON.stringify(tampered));
    expect(t.ok).toBe(true);
    if (t.ok) {
      const dec = await decodeBackupFiles(t.backup);
      expect(dec.ok).toBe(false);
      if (!dec.ok) expect(dec.errors.join()).toContain('一致しません');
    }
    // 元ファイルなしのバックアップも復元でき、書類の抽出結果は残る
    const noFiles = parseBackupText(JSON.stringify(createBackup(snap)));
    expect(noFiles.ok && noFiles.backup.files).toBeUndefined();
  });

  it('v3（Phase 3）のバックアップは書類を空として復元できる', async () => {
    const p = createDemoData(TODAY);
    const { documents: _omit, ...v3data } = p;
    void _omit;
    const r = parseBackupText(JSON.stringify({ app: 'WorkCore', schemaVersion: 3, exportedAt: '', data: v3data }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.backup.data.documents).toEqual([]);
  });

  it('Phase 3 (v3) の DB を v4 に移行しても既存データは残る', async () => {
    const name = `mig4_${generateId()}`;
    const v3 = await openWorkCoreDB(name, 3);
    const p = createDemoData(TODAY);
    const tx = v3.transaction(['employees', 'items', 'meta'], 'readwrite');
    for (const e of p.employees) await tx.objectStore('employees').put(e);
    for (const i of p.items) await tx.objectStore('items').put(i);
    await tx.objectStore('meta').put({ key: 'initialized', value: 'x' });
    await tx.done;
    v3.close();
    const v4 = await openWorkCoreDB(name);
    expect(v4.version).toBe(DB_VERSION);
    const service = new WorkCoreService(v4, () => TODAY);
    expect(await service.ensureInitialized()).toBe(false);
    const d = await service.loadSnapshot();
    expect(d.employees).toHaveLength(p.employees.length);
    expect(d.items).toHaveLength(p.items.length);
    expect(d.documents).toEqual([]);
    expect((await service.documents.create({ type: 'receipt' })).duplicated).toBe(false);
    v4.close();
  });
});

describe('CSV', () => {
  it('期間・種類・選択で絞り込み、明細行も出力する（BOM・インジェクション対策）', async () => {
    const { service, docs } = await setup();
    await docs.create({ type: 'receipt', fields: { issuer: '=HYPERLINK("x")', issueDate: '2026-09-01', total: '1000', notes: '改行\nあり, "引用"' } });
    const del = (await docs.create({ type: 'delivery' })).value!;
    await docs.applyExtraction(del.id, { method: 'ocr', pages: [], selectedPages: [1], result: extractDocument(page(DELIVERY)), keepType: true });
    const d = await service.loadSnapshot();
    expect(filterDocumentsForExport(d.documents, { from: '2026-10-01' }).map((x) => x.type)).toEqual(['delivery']);
    expect(filterDocumentsForExport(d.documents, { types: ['receipt'] })).toHaveLength(1);
    expect(filterDocumentsForExport(d.documents, { ids: [del.id] })).toHaveLength(1);
    const csv = documentsToCsv(d.documents, d);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('"改行\nあり, ""引用"""');
    const lines = documentLinesToCsv(d.documents, d.items);
    expect(lines.trim().split('\r\n')).toHaveLength(3); // ヘッダー + 明細2行
  });
});
