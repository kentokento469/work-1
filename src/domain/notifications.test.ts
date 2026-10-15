import { describe, expect, it } from 'vitest';
import { createService, TODAY } from '../test/helpers';
import { pendingProposals } from '../automation/engine';
import { ALL_AUTOMATIONS } from '../automation/registry';
import { readAutomationSettings, ruleSetting } from '../automation/settings';
import { computeAllStock } from './inventory/stock';
import { isTaskOverdue } from './analytics';
import { isInquiryOverdue } from './helpdesk/inquiry';
import { deriveNotices, markNoticesRead, navNoticeSummary, readNoticeState, syncNoticeLog, type NoticeState } from './notifications';
import type { DataSnapshot } from './types';

async function setup() {
  const { service } = await createService();
  await service.ensureInitialized();
  return service;
}
function notices(d: DataSnapshot) {
  const stock = computeAllStock(d.items, d);
  const settings = readAutomationSettings(d);
  const proposals = pendingProposals(ALL_AUTOMATIONS, { data: d, today: TODAY, stock }, (x) => ruleSetting(ALL_AUTOMATIONS.find((a) => a.id === x)!, settings).enabled);
  return { list: deriveNotices({ data: d, today: TODAY, stock, proposals }), proposals, stock };
}

describe('通知の導出（実データとの一致）', () => {
  it('各ナビの件数が、対象データの実際の件数と一致する', async () => {
    const s = await setup();
    const d = await s.loadSnapshot();
    const { list, proposals, stock } = notices(d);
    const overdueTasks = d.tasks.filter((t) => isTaskOverdue(t, TODAY));
    expect(navNoticeSummary(list, 'tasks').items.map((n) => n.target.id).sort()).toEqual(overdueTasks.map((t) => t.id).sort());
    // 問い合わせ: 期限超過 ∪ 新規 (重複なし)
    const inq = new Set(d.inquiries.filter((i) => isInquiryOverdue(i, TODAY) || i.status === 'new').map((i) => i.id));
    expect(navNoticeSummary(list, 'helpdesk').count).toBe(inq.size);
    const shortage = d.items.filter((i) => i.active && stock.get(i.id)!.shortage).length;
    const poPending = d.purchaseOrders.filter((p) => p.status === 'pending_approval').length;
    expect(navNoticeSummary(list, 'inventory').count).toBe(shortage + poPending);
    expect(navNoticeSummary(list, 'automation').count).toBe(proposals.length);
    // メニュー = 書類 + 自動化 + 入社準備
    const menu = navNoticeSummary(list, 'menu');
    expect(menu.count).toBe(navNoticeSummary(list, 'documents').count + navNoticeSummary(list, 'automation').count + navNoticeSummary(list, 'onboarding').count);
    // ID は一意 (同じ原因から重複しない)
    expect(new Set(list.map((n) => n.id)).size).toBe(list.length);
    // すべての通知に遷移先・理由・操作がある
    for (const n of list) {
      expect(n.href).toMatch(/^#\//);
      expect(n.reason.length).toBeGreaterThan(0);
      expect(n.action.length).toBeGreaterThan(0);
    }
  });

  it('新規かつ期限超過の問い合わせは1件だけ（期限超過として）数える', async () => {
    const s = await setup();
    const d = await s.loadSnapshot();
    const i = d.inquiries.find((x) => x.status === 'new')!;
    const data = { ...d, inquiries: d.inquiries.map((x) => (x.id === i.id ? { ...x, dueDate: '2026-01-01' } : x)) };
    const ids = notices(data).list.filter((n) => n.target.id === i.id).map((n) => n.type);
    expect(ids).toEqual(['inquiry_overdue']);
  });

  it('タスクを完了すると通知が消え、件数が1減る。削除しても参照切れの通知は残らない', async () => {
    const s = await setup();
    let d = await s.loadSnapshot();
    const before = navNoticeSummary(notices(d).list, 'tasks');
    expect(before.count).toBeGreaterThan(1);
    await s.setTaskStatus(before.items[0]!.target.id, 'done');
    d = await s.loadSnapshot();
    expect(navNoticeSummary(notices(d).list, 'tasks').count).toBe(before.count - 1);
    await s.deleteTask(before.items[1]!.target.id);
    d = await s.loadSnapshot();
    const after = notices(d).list;
    expect(navNoticeSummary(after, 'tasks').count).toBe(before.count - 2);
    expect(after.some((n) => n.target.id === before.items[1]!.target.id)).toBe(false);
  });

  it('確認待ちの書類・承認待ちの発注書が通知になり、承認・確認で消える', async () => {
    const s = await setup();
    const doc = (await s.documents.create({ type: 'receipt' })).value!;
    let d = await s.loadSnapshot();
    expect(d.documents.find((x) => x.id === doc.id)!.status).toBe('needs_review');
    const docNotice = notices(d).list.find((n) => n.id === `document_review:${doc.id}`)!;
    expect(docNotice.href).toBe(`#/documents/${doc.id}`);
    expect(navNoticeSummary(notices(d).list, 'menu').items).toContainEqual(docNotice);
    // 発注書: 下書き → 承認申請で通知、承認で消える
    let po = d.purchaseOrders.find((p) => p.status === 'pending_approval');
    if (!po) {
      const sug = d.purchaseSuggestions.find((x) => x.status === 'open')!;
      const draft = (await s.inventory.createOrdersFromSuggestions([sug.id], '申請 花子')).value![0]!;
      po = await s.inventory.transitionOrder(draft.id, 'submit', '申請 花子');
      d = await s.loadSnapshot();
    }
    expect(notices(d).list.find((n) => n.id === `po_approval:${po.id}`)?.kind).toBe('approval');
    await s.inventory.transitionOrder(po.id, 'approve', '承認 太郎');
    d = await s.loadSnapshot();
    expect(notices(d).list.some((n) => n.id === `po_approval:${po.id}`)).toBe(false);
  });
});

describe('既読と未処理の区別・記録の同期', () => {
  const base = (): NoticeState => ({ log: {} });
  const n = (id: string, actionable = true) => ({ id, type: 'task_overdue' as const, kind: 'overdue' as const, module: 'tasks' as const, target: { type: 'task' as const, id }, title: id, reason: 'r', action: 'a', at: '2026-10-01', priority: 2 as const, href: '#/tasks', actionable });

  it('新しい通知は未読で記録、消えたら解消済み、再発したら未読・未解消に戻る', () => {
    let st = syncNoticeLog(base(), [n('a'), n('b')], '2026-10-15T09:00:00Z');
    expect(st.changed).toBe(true);
    expect(Object.keys(st.state.log)).toEqual(['a', 'b']);
    // 変化がなければ書き込まない
    expect(syncNoticeLog(st.state, [n('a'), n('b')], '2026-10-15T09:05:00Z').changed).toBe(false);
    // 既読にしても通知 (未処理) は残る
    const read = markNoticesRead(st.state, ['a'], '2026-10-15T09:10:00Z');
    expect(read.state.log.a!.readAt).not.toBeNull();
    expect(read.state.log.a!.resolvedAt).toBeNull();
    // 原因が解消 → 解消済み (履歴)
    st = syncNoticeLog(read.state, [n('b')], '2026-10-15T10:00:00Z');
    expect(st.state.log.a!.resolvedAt).toBe('2026-10-15T10:00:00Z');
    // 再発 → 未解消・未読に戻る
    st = syncNoticeLog(st.state, [n('a'), n('b')], '2026-10-16T10:00:00Z');
    expect(st.state.log.a!.resolvedAt).toBeNull();
    expect(st.state.log.a!.readAt).toBeNull();
  });

  it('古い解消済みの記録は削除される', () => {
    let st = syncNoticeLog(base(), [n('a')], '2026-08-01T00:00:00Z').state;
    st = syncNoticeLog(st, [], '2026-08-02T00:00:00Z').state;
    st = syncNoticeLog(st, [], '2026-10-15T00:00:00Z').state;
    expect(st.log.a).toBeUndefined();
  });

  it('サービス経由で保存され、再読み込み後も既読・履歴が残る（データ初期化でも設定ストアは維持）', async () => {
    const s = await setup();
    let d = await s.loadSnapshot();
    const list = notices(d).list;
    expect(await s.syncNotices(list)).toBe(true);
    expect(await s.syncNotices(list)).toBe(false);
    await s.markNoticesRead([list[0]!.id]);
    d = await s.loadSnapshot();
    const st = readNoticeState(d);
    expect(st.log[list[0]!.id]!.readAt).not.toBeNull();
    expect(Object.keys(st.log)).toHaveLength(list.length);
  });
});
