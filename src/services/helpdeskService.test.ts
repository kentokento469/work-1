import { describe, expect, it } from 'vitest';
import { openDB } from 'idb';
import { createService, TODAY } from '../test/helpers';
import { DB_VERSION, openWorkCoreDB } from '../data/db';
import { generateId } from '../domain/id';
import { createBackup, parseBackupText } from '../data/backup';
import { CAT } from '../domain/helpdesk/defaults';
import { classifyInquiry } from '../domain/helpdesk/classifier';
import { computeDashboard } from '../domain/analytics';
import { computeHelpdeskStats } from '../domain/helpdesk/analytics';
import { createDemoData } from '../demo/demoData';
import { WorkCoreService } from './workcoreService';
import type { InquiryInput } from '../domain/helpdesk/inquiry';

async function setup() {
  const { service, db } = await createService();
  await service.ensureInitialized();
  const snap = await service.loadSnapshot();
  const requester = snap.employees.find((e) => e.employeeNumber === 'A0033')!;
  const input = (over: Partial<InquiryInput> = {}): InquiryInput => ({
    requesterId: requester.id,
    title: '新入社員のPCが足りません',
    body: '来週入社する2名分のノートPCが不足しています',
    categoryId: CAT.pc,
    priority: 'medium',
    assignee: '小林 美咲',
    dueDate: '2026-10-20',
    ...over,
  });
  return { service, db, hd: service.helpdesk, requester, input };
}

describe('問い合わせの業務フロー', () => {
  it('受付 → タスク生成 → タスク完了 → 解決 → 完了 → 分析', async () => {
    const { service, hd, requester, input } = await setup();
    const before = computeHelpdeskStats((await service.loadSnapshot()).inquiries, [], TODAY);

    const { inquiry } = await hd.createInquiry(input(), { requestId: 'req-1', classification: null });
    expect(inquiry.number).toMatch(/^HD-2026-\d{4}$/);
    expect(inquiry.requesterName).toBe(requester.name); // 社員情報を再利用
    expect(inquiry.requesterDepartmentId).toBe(requester.departmentId);
    expect(inquiry.status).toBe('new');

    const proposals = await hd.previewTasks(inquiry.id);
    expect(proposals.map((p) => p.title)).toContain('PC在庫の確認');

    // 1件だけ選択を外して承認
    const tasks = await hd.applyTasks(inquiry.id, { inqrule_pc_order: { selected: false } });
    expect(tasks.map((t) => t.title)).toEqual(['PC在庫の確認', '入社準備タスクとの照合']);
    expect(tasks.every((t) => t.inquiryId === inquiry.id && t.source === 'inquiry')).toBe(true);

    // 重複防止: 同じ候補は再作成されない
    await expect(hd.applyTasks(inquiry.id, { inqrule_pc_order: { selected: false } })).rejects.toThrow('登録対象のタスクがありません');
    expect((await hd.previewTasks(inquiry.id)).filter((p) => p.status === 'new').map((p) => p.ruleId)).toEqual(['inqrule_pc_order']);

    let snap = await service.loadSnapshot();
    let cur = snap.inquiries.find((i) => i.id === inquiry.id)!;
    expect(cur.status).toBe('in_progress'); // タスク作成で自動的に対応中
    expect(cur.history.some((h) => h.type === 'task')).toBe(true);

    // 完了条件を満たさないと閉じられない
    await expect(hd.closeInquiry(inquiry.id, true)).rejects.toThrow('解決済み');
    await expect(hd.changeStatus(inquiry.id, 'resolved')).rejects.toThrow('解決内容');
    await hd.changeStatus(inquiry.id, 'resolved', { resolution: '予備機2台を貸与' });
    await expect(hd.closeInquiry(inquiry.id, true)).rejects.toThrow('未完了の関連タスクが2件');

    // タスクの完了は問い合わせの対応履歴に反映されるが、問い合わせ自体は自動で閉じない
    for (const t of tasks) await service.setTaskStatus(t.id, 'done');
    snap = await service.loadSnapshot();
    cur = snap.inquiries.find((i) => i.id === inquiry.id)!;
    expect(cur.status).toBe('resolved');
    expect(cur.history.filter((h) => h.message.includes('完了」になりました'))).toHaveLength(2);

    await expect(hd.closeInquiry(inquiry.id, false)).rejects.toThrow('申請者への解決確認');
    const closed = await hd.closeInquiry(inquiry.id, true);
    expect(closed.status).toBe('closed');
    expect(closed.closedAt).not.toBeNull();
    await expect(hd.changeStatus(inquiry.id, 'in_progress')).rejects.toThrow('完了した問い合わせ');

    const after = computeHelpdeskStats((await service.loadSnapshot()).inquiries, [], TODAY);
    expect(after.total).toBe(before.total + 1);
    expect(after.closedCount).toBe(before.closedCount + 1);
    // Phase 1 のダッシュボード集計にも問い合わせタスクが含まれる
    expect(computeDashboard(snap, TODAY).totalTaskCount).toBe(snap.tasks.length);
  });

  it('同じ requestId の再送（連打・再試行）では1件しか作られない', async () => {
    const { service, hd, input } = await setup();
    const n0 = (await service.loadSnapshot()).inquiries.length;
    const results = await Promise.allSettled([1, 2, 3].map(() => hd.createInquiry(input(), { requestId: 'same', classification: null })));
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok.length).toBeGreaterThan(0);
    expect((await service.loadSnapshot()).inquiries.length).toBe(n0 + 1);
  });

  it('秘密情報を含む本文・コメント・解決内容・FAQは保存しない', async () => {
    const { hd, input } = await setup();
    await expect(hd.createInquiry(input({ body: 'パスワード: abc12345 で入れません' }), { requestId: generateId(), classification: null })).rejects.toThrow('伏せ字');
    const { inquiry } = await hd.createInquiry(input(), { requestId: generateId(), classification: null });
    await expect(hd.addComment(inquiry.id, 'PW=Zxcv9876')).rejects.toThrow();
    await expect(hd.changeStatus(inquiry.id, 'resolved', { resolution: '仮パスワードは Temp1234' })).rejects.toThrow();
    await expect(hd.saveFaq({ question: 'VPN', answer: 'パスワード: Vpn!2026 を入力', categoryId: CAT.network, keywords: [], enabled: true })).rejects.toThrow('FAQには保存できません');
  });

  it('操作履歴には本文・コメントを書かない', async () => {
    const { service, hd, input } = await setup();
    const { inquiry } = await hd.createInquiry(input({ body: '社外秘の詳細内容XYZ' }), { requestId: generateId(), classification: null });
    await hd.addComment(inquiry.id, '内部メモABC');
    const acts = (await service.loadSnapshot()).activities.map((a) => a.message).join('\n');
    expect(acts).toContain(inquiry.number);
    expect(acts).not.toContain('社外秘の詳細内容XYZ');
    expect(acts).not.toContain('内部メモABC');
  });

  it('編集は差分を対応履歴に残す・削除は取り消せる（タスクの紐付けも復元）', async () => {
    const { service, hd, input } = await setup();
    const { inquiry } = await hd.createInquiry(input(), { requestId: generateId(), classification: null });
    const updated = await hd.updateInquiry(inquiry.id, input({ priority: 'high', categoryId: CAT.software }));
    expect(updated.history.at(-1)!.message).toContain('優先度：中 → 高');
    const [task] = await hd.applyTasks(inquiry.id, {});
    const deleted = await hd.deleteInquiry(inquiry.id);
    let snap = await service.loadSnapshot();
    expect(snap.inquiries.some((i) => i.id === inquiry.id)).toBe(false);
    expect(snap.tasks.find((t) => t.id === task!.id)?.inquiryId).toBeNull(); // タスクは残る
    await hd.restoreInquiry(deleted);
    snap = await service.loadSnapshot();
    expect(snap.inquiries.some((i) => i.id === inquiry.id)).toBe(true);
    expect(snap.tasks.find((t) => t.id === task!.id)?.inquiryId).toBe(inquiry.id);
  });

  it('自動分類の結果と担当者の修正を記録する', async () => {
    const { service, hd, input } = await setup();
    const snap = await service.loadSnapshot();
    const c = classifyInquiry('Googleにログインできない', '', snap.inquiryCategories);
    const { inquiry } = await hd.createInquiry(input({ title: 'Googleにログインできない', body: '', categoryId: CAT.access, priority: c.priority }), {
      requestId: generateId(),
      classification: { suggestedCategoryId: c.categoryId, suggestedPriority: c.priority, needsReview: c.needsReview, categoryAccepted: false, priorityAccepted: true, reasons: c.reasons },
    });
    expect(inquiry.classification?.suggestedCategoryId).toBe(CAT.google);
    expect(inquiry.history.some((h) => h.message.includes('担当者が変更'))).toBe(true);
  });

  it('FAQ化: 解決済み案件からFAQを作り、問い合わせに関連付ける', async () => {
    const { service, hd } = await setup();
    const snap = await service.loadSnapshot();
    const resolved = snap.inquiries.find((i) => i.status === 'resolved')!;
    const faq = await hd.saveFaq({ question: resolved.title, answer: resolved.resolution, categoryId: resolved.categoryId, keywords: ['テスト'], enabled: false }, undefined, { sourceInquiryId: resolved.id });
    const after = (await service.loadSnapshot()).inquiries.find((i) => i.id === resolved.id)!;
    expect(faq.sourceInquiryId).toBe(resolved.id);
    expect(faq.enabled).toBe(false); // 下書きとして保存可能
    expect(after.faqIds).toContain(faq.id);
  });

  it('使用中のカテゴリは削除できず、その他・要確認は無効にできない', async () => {
    const { hd } = await setup();
    await expect(hd.deleteCategory(CAT.network)).rejects.toThrow('使用中');
    await expect(hd.deleteCategory(CAT.other)).rejects.toThrow('削除できません');
    const c = await hd.saveCategory({ name: '電話・内線', keywords: ['内線', '電話機'], defaultDepartmentId: 'dept_soumu', defaultAssignee: '', slaBusinessDays: 2, enabled: true });
    await expect(hd.saveCategory({ ...c, name: '電話・内線' })).rejects.toThrow('既に存在');
    await hd.deleteCategory(c.id);
  });
});

describe('DBマイグレーション（v1 → v2）', () => {
  it('Phase 1 のデータを保持したままヘルプデスク用ストアを追加する', async () => {
    const name = `mig_${generateId()}`;
    // v1 の DB を作り、Phase 1 形式のデータ (inquiryId なしのタスク) を入れる
    const v1 = await openWorkCoreDB(name, 1);
    const p1 = createDemoData(TODAY);
    const tx = v1.transaction(['departments', 'employees', 'tasks', 'meta'], 'readwrite');
    for (const d of p1.departments) await tx.objectStore('departments').put(d);
    for (const e of p1.employees) await tx.objectStore('employees').put(e);
    const legacyTasks = p1.tasks.filter((t) => t.source !== 'inquiry').map(({ inquiryId: _omit, ...t }) => t);
    for (const t of legacyTasks) await tx.objectStore('tasks').put(t as never);
    await tx.objectStore('meta').put({ key: 'initialized', value: 'x' });
    await tx.done;
    v1.close();

    const v2 = await openWorkCoreDB(name);
    expect(v2.version).toBe(DB_VERSION);
    const service = new WorkCoreService(v2, () => TODAY);
    expect(await service.ensureInitialized()).toBe(false); // 既存データは消さない
    const snap = await service.loadSnapshot();
    expect(snap.employees).toHaveLength(p1.employees.length);
    expect(snap.tasks).toHaveLength(legacyTasks.length);
    expect(snap.tasks.every((t) => t.inquiryId === null)).toBe(true);
    expect(snap.inquiryCategories.length).toBeGreaterThanOrEqual(9);
    expect(snap.inquiries).toEqual([]);

    // 移行ユーザー向け: ヘルプデスクのデモだけ追加 (二重投入はしない)
    const added = await service.addHelpdeskDemo();
    expect(added).toBeGreaterThan(5);
    await expect(service.addHelpdeskDemo()).rejects.toThrow('既に問い合わせ');
    const after = await service.loadSnapshot();
    expect(after.employees).toHaveLength(p1.employees.length);
    v2.close();
    // 素の idb で開いてもバージョンが維持されている
    const raw = await openDB(name);
    expect(raw.objectStoreNames.contains('inquiries')).toBe(true);
    raw.close();
  });
});

describe('バックアップ互換性', () => {
  it('v2 バックアップ → 復元で問い合わせ・FAQ・カテゴリまで一致', async () => {
    const a = await createService();
    await a.service.ensureInitialized();
    const snap = await a.service.loadSnapshot();
    const r = parseBackupText(JSON.stringify(createBackup(snap)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = await createService();
    await b.service.ensureInitialized();
    await b.service.restoreBackup(r.backup);
    const restored = await b.service.loadSnapshot();
    expect(restored.inquiries.map((i) => i.id).sort()).toEqual(snap.inquiries.map((i) => i.id).sort());
    expect(restored.faqs).toHaveLength(snap.faqs.length);
    expect(restored.tasks.filter((t) => t.inquiryId)).toHaveLength(snap.tasks.filter((t) => t.inquiryId).length);
  });

  it('Phase 1 (v1) のバックアップも復元できる', async () => {
    const p1 = createDemoData(TODAY);
    const v1 = {
      app: 'WorkCore',
      schemaVersion: 1,
      exportedAt: '2026-10-01T00:00:00.000Z',
      data: {
        departments: p1.departments,
        employees: p1.employees,
        tasks: p1.tasks.filter((t) => t.source !== 'inquiry').map(({ inquiryId: _omit, ...t }) => t),
        rules: p1.rules,
        activities: [],
      },
    };
    const r = parseBackupText(JSON.stringify(v1));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sourceVersion).toBe(1);
    expect(r.backup.data.inquiryCategories.length).toBeGreaterThan(0);
    expect(r.backup.data.tasks.every((t) => t.inquiryId === null)).toBe(true);
    const { service } = await createService();
    await service.restoreBackup(r.backup);
    expect((await service.loadSnapshot()).employees).toHaveLength(p1.employees.length);
  });

  it('存在しない問い合わせを参照するタスクは、関連付けを解除して取り込む（Phase 8: 任意の参照は修復）', () => {
    const p = createDemoData(TODAY);
    const broken = { ...p, inquiries: [], documents: [] };
    const r = parseBackupText(JSON.stringify(createBackup(broken)));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.repairs.join()).toContain('問い合わせを指していたタスクの関連付けを解除');
      expect(r.backup.data.tasks.every((t) => t.inquiryId === null)).toBe(true);
    }
  });
});
