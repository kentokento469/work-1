import { describe, expect, it } from 'vitest';
import { createService, TODAY } from '../test/helpers';
import { pendingProposals } from '../automation/engine';
import { ALL_AUTOMATIONS } from '../automation/registry';
import { readAutomationSettings, ruleSetting } from '../automation/settings';
import { computeAllStock } from './inventory/stock';
import { isTaskOverdue } from './analytics';
import { isInquiryOverdue } from './helpdesk/inquiry';
import { NOTICE_SPECS, deriveNotices, hireTasksHref, markNoticesRead, navNoticeSummary, readNoticeState, syncNoticeLog, type NoticeState } from './notifications';
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
  const n = (id: string, actionable = true) => ({ id, type: 'task_overdue' as const, kind: 'overdue' as const, module: 'tasks' as const, target: { type: 'task' as const, id }, title: id, reason: 'r', action: 'a', at: '2026-10-01', priority: 2 as const, href: '#/tasks', actionLabel: '開く', actionable });

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

describe('通知の約束（生成と移動先の整合）', () => {
  /** App.tsx が扱う画面 (移動先として正しいか) */
  const ROUTES = [/^\/tasks$/, /^\/helpdesk\/[^/]+$/, /^\/inventory$/, /^\/inventory\/(items|orders|assets)\/[^/]+$/, /^\/documents\/[^/]+$/, /^\/automation$/, /^\/onboarding$/];
  const parse = (href: string) => {
    const [path = '', q = ''] = href.replace(/^#/, '').split('?');
    return { path, q: new URLSearchParams(q) };
  };

  it('すべての通知が定義どおりの移動先・操作・ボタン文言を持つ', async () => {
    const s = await setup();
    await s.documents.create({ type: 'receipt' });
    const d = await s.loadSnapshot();
    const { list } = notices(d);
    const types = new Set(list.map((n) => n.type));
    for (const t of ['task_overdue', 'inquiry_overdue', 'inquiry_new', 'stock_shortage', 'document_review', 'automation_proposal', 'hire_unprepared']) expect(types.has(t as never)).toBe(true);
    for (const n of list) {
      const spec = NOTICE_SPECS[n.type];
      expect(spec.targetType).toBe(n.target.type);
      const { path, q } = parse(n.href);
      expect(ROUTES.some((r) => r.test(path)), `${n.type} → ${n.href}`).toBe(true);
      if (spec.destination === 'detail') expect(path.endsWith(`/${encodeURIComponent(n.target.id)}`)).toBe(true);
      if (spec.destination === 'list-focus' && n.type !== 'stock_shortage') expect(q.get('focus')).toBeTruthy();
      expect(n.action.length).toBeGreaterThan(5);
      expect(n.actionLabel.length).toBeGreaterThan(1);
    }
  });

  it('入社準備の通知は、対象社員の未完了の入社準備タスクに絞り込んだタスク一覧へ移動する', async () => {
    const s = await setup();
    const d = await s.loadSnapshot();
    const n = notices(d).list.find((x) => x.type === 'hire_unprepared')!;
    const { path, q } = parse(n.href);
    expect(path).toBe('/tasks');
    expect(q.get('employee')).toBe(n.target.id);
    expect(q.get('source')).toBe('onboarding');
    expect(q.get('status')).toBe('open');
    expect(n.href).toBe(hireTasksHref(n.target.id));
    // 件数が理由に正しく書かれ、全件完了で消える
    const open = d.tasks.filter((t) => t.employeeId === n.target.id && t.source === 'onboarding' && t.status !== 'done');
    expect(n.reason).toContain(`${open.length}件`);
    for (const t of open) await s.setTaskStatus(t.id, 'done');
    expect(notices(await s.loadSnapshot()).list.some((x) => x.id === n.id)).toBe(false);
  });

  it('在庫不足の通知は段階に応じて次の操作の画面を指す（発注候補 → 下書きの発注書 → 承認待ちは発注書の通知に一本化 → 承認で解消）', async () => {
    const s = await setup();
    let d = await s.loadSnapshot();
    let n = notices(d).list.find((x) => x.type === 'stock_shortage' && d.purchaseSuggestions.some((g) => g.itemId === x.target.id && g.status === 'open'))!;
    const sug = d.purchaseSuggestions.find((g) => g.itemId === n.target.id && g.status === 'open')!;
    expect(n.href).toBe(`#/inventory?tab=orders&focus=${encodeURIComponent(`sug:${sug.id}`)}`);
    const po = (await s.inventory.createOrdersFromSuggestions([sug.id], '申請 花子')).value![0]!;
    d = await s.loadSnapshot();
    n = notices(d).list.find((x) => x.id === n.id)!;
    expect(n.href).toBe(`#/inventory/orders/${po.id}`);
    expect(n.action).toContain('承認申請');
    await s.inventory.transitionOrder(po.id, 'submit', '申請 花子');
    d = await s.loadSnapshot();
    expect(notices(d).list.some((x) => x.id === n.id)).toBe(false);
    expect(notices(d).list.find((x) => x.id === `po_approval:${po.id}`)?.reason).toContain('在庫不足の解消に必要');
    await s.inventory.transitionOrder(po.id, 'approve', '承認 太郎');
    d = await s.loadSnapshot();
    expect(notices(d).list.some((x) => x.id === n.id || x.id === `po_approval:${po.id}`)).toBe(false);
  });
});
