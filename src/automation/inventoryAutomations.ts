/**
 * Phase 3 の部門横断の自動化定義 (人事・ヘルプデスク・在庫・資産の連携)。
 * すべて副作用のない検出処理で、実行はサービス層 (InventoryService.applyProposal) が行う。
 */
import { addDays, diffDays, toPreviousBusinessDay } from '../domain/date';
import { normalizeText } from '../domain/text';
import type { DataSnapshot, Employee, ISODate } from '../domain/types';
import type { Asset, InventoryCategory, Item } from '../domain/inventory/types';
import { actionSignature, fingerprint, type AutomationAction, type AutomationDefinition, type AutomationProposal } from './engine';

const JOSHIS = 'dept_joshis';
const SOUMU = 'dept_soumu';

function dept(data: DataSnapshot, preferred: string): string {
  return data.departments.some((d) => d.id === preferred) ? preferred : (data.departments[0]?.id ?? preferred);
}

/** 期限: 基準日の前営業日。過去になる場合は今日 */
function dueBefore(date: ISODate, today: ISODate, daysBefore = 1): ISODate {
  const d = toPreviousBusinessDay(addDays(date, -daysBefore));
  return d < today ? today : d;
}

function hasTask(data: DataSnapshot, ruleKey: string): boolean {
  return data.tasks.some((t) => t.ruleId === ruleKey);
}

/** 社員ごとの機器の確保状況 (品目別) */
function coverage(data: DataSnapshot, employeeId: string) {
  const byItem = new Map<string, { assets: Asset[]; active: number; fulfilled: number; backorder: number; reservationIds: string[] }>();
  const get = (itemId: string) => {
    let v = byItem.get(itemId);
    if (!v) byItem.set(itemId, (v = { assets: [], active: 0, fulfilled: 0, backorder: 0, reservationIds: [] }));
    return v;
  };
  const assets = [...data.assets].sort((a, b) => a.assetNumber.localeCompare(b.assetNumber));
  for (const a of assets) if (a.assigneeId === employeeId && a.itemId && (a.status === 'reserved' || a.status === 'in_use')) get(a.itemId).assets.push(a);
  const assetTracked = new Set(data.items.filter((i) => i.tracking === 'asset').map((i) => i.id));
  for (const r of [...data.reservations].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
    if (r.employeeId !== employeeId) continue;
    if (r.status === 'active') get(r.itemId).active += r.quantity;
    // 個体管理品の「完了」予約は入荷した資産に引当済み (資産側で数える) なので重ねて数えない
    if (r.status === 'fulfilled' && !assetTracked.has(r.itemId)) get(r.itemId).fulfilled += r.quantity;
    if (r.status === 'backorder') get(r.itemId).backorder += r.quantity;
    if (r.status === 'active' || r.status === 'backorder') get(r.itemId).reservationIds.push(r.id);
  }
  return byItem;
}

/** 社員に必要な機器 (入社準備の機器ルールから) */
export function equipmentNeeds(data: DataSnapshot, employee: Employee): Map<string, number> {
  const needs = new Map<string, number>();
  for (const r of [...data.equipmentRules].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))) {
    if (!r.enabled || (r.scope !== 'common' && r.scope !== employee.departmentId)) continue;
    const item = data.items.find((i) => i.id === r.itemId && i.active);
    if (!item) continue;
    needs.set(r.itemId, (needs.get(r.itemId) ?? 0) + r.quantity);
  }
  return needs;
}

// ---------------------------------------------------------------------------
// 1. 入社登録による備品需要の検出
// ---------------------------------------------------------------------------
export const onboardingEquipment: AutomationDefinition = {
  id: 'onboarding-equipment',
  name: '入社準備：必要機器の判定と確保',
  description: '入社予定者の部署から必要機器を判定し、利用可能な在庫・資産を予約する。不足分は入荷待ちとして記録し、発注候補につなげる',
  trigger: '在籍ステータスが「入社予定」で、必要機器の確保が完了していない社員がいる',
  approval: 'required',
  detect({ data, today, stock }) {
    const out: AutomationProposal[] = [];
    // 同じ実行内で複数の社員に同じ在庫を二重に提案しないよう、提案ごとに使用済みとして差し引く
    const takenAssets = new Set<string>();
    const takenQty = new Map<string, number>();
    // 入社日が早い順 (同日なら社員番号順) に在庫を割り当てる。入力の並び順に依存しない
    const pending = data.employees.filter((e) => e.status === 'pending').sort((a, b) => a.hireDate.localeCompare(b.hireDate) || a.employeeNumber.localeCompare(b.employeeNumber));
    for (const emp of pending) {
      const needs = equipmentNeeds(data, emp);
      const cov = coverage(data, emp.id);
      const actions: AutomationAction[] = [];
      const conditions: string[] = [`${emp.name}さん（${data.departments.find((d) => d.id === emp.departmentId)?.name ?? ''}・${emp.hireDate}入社予定）`];
      const sig: (string | number)[] = [emp.id, emp.departmentId];
      const shortages: string[] = [];

      for (const [itemId, need] of needs) {
        const item = data.items.find((i) => i.id === itemId)!;
        const c = cov.get(itemId);
        const covered = (c?.assets.length ?? 0) + (c?.active ?? 0) + (c?.fulfilled ?? 0) + (c?.backorder ?? 0);
        const missing = need - covered;
        if (missing <= 0) continue;
        sig.push(itemId, missing);
        conditions.push(`${item.name}：必要 ${need}${item.unit}・確保済み ${covered}${item.unit}`);
        let rest = missing;
        if (item.tracking === 'asset') {
          const candidates = data.assets
            .filter((a) => a.itemId === itemId && a.status === 'unused' && !takenAssets.has(a.id))
            .sort((a, b) => a.assetNumber.localeCompare(b.assetNumber));
          for (let i = 0; i < missing && candidates[i]; i++) {
            const a = candidates[i]!;
            takenAssets.add(a.id);
            actions.push({ id: `asset:${itemId}:${i}`, kind: 'reserve_asset', assetId: a.id, employeeId: emp.id, label: `${a.assetNumber}（${a.name}）を予約`, requiresApproval: true });
            rest--;
          }
        } else {
          const avail = Math.max(0, (stock.get(itemId)?.available ?? 0) - (takenQty.get(itemId) ?? 0));
          const q = Math.min(rest, avail);
          if (q > 0) {
            takenQty.set(itemId, (takenQty.get(itemId) ?? 0) + q);
            actions.push({ id: `item:${itemId}`, kind: 'reserve_item', itemId, quantity: q, employeeId: emp.id, inquiryId: null, key: `onboarding:${emp.id}:${itemId}`, label: `${item.name} を ${q}${item.unit} 予約（在庫から引当）`, requiresApproval: true });
            rest -= q;
          }
        }
        if (rest > 0) {
          shortages.push(`${item.name} ${rest}${item.unit}`);
          actions.push({ id: `backorder:${itemId}`, kind: 'backorder_item', itemId, quantity: rest, employeeId: emp.id, inquiryId: null, key: `onboarding:${emp.id}:${itemId}`, label: `${item.name} ${rest}${item.unit} が不足 → 入荷待ちとして記録（発注候補に反映）`, requiresApproval: true });
        }
      }

      // 異動・ルール変更で不要になった予約の解除
      for (const [itemId, c] of cov) {
        const need = needs.get(itemId) ?? 0;
        // 引き渡し済み (使用中・出庫済み) は解除できないので、解除できる分の範囲で多すぎる数を求める
        const total = c.assets.length + c.active + c.fulfilled + c.backorder;
        const releasable = c.assets.filter((a) => a.status === 'reserved').length + c.active + c.backorder;
        let excess = Math.min(releasable, total - need);
        if (excess <= 0) continue;
        const item = data.items.find((i) => i.id === itemId);
        sig.push('rel', itemId, excess);
        conditions.push(`${item?.name ?? '品目'}：必要数 ${need} に対して ${excess} 多く確保（部署変更などによる）`);
        for (const rid of c.reservationIds) {
          if (excess <= 0) break;
          const r = data.reservations.find((x) => x.id === rid)!;
          const q = Math.min(r.quantity, excess);
          actions.push({ id: `release:${rid}`, kind: 'release_reservation', reservationId: rid, quantity: q, label: `${item?.name ?? ''} の${r.status === 'backorder' ? '入荷待ち' : '予約'} ${q}${item?.unit ?? ''} を解除`, requiresApproval: true });
          excess -= q;
        }
        for (const a of c.assets.filter((x) => x.status === 'reserved')) {
          if (excess <= 0) break;
          actions.push({ id: `release-asset:${a.id}`, kind: 'release_asset', assetId: a.id, label: `${a.assetNumber} の予約を解除`, requiresApproval: true });
          excess--;
        }
      }
      if (actions.length === 0) continue;

      const handoverKey = `equip-handover:${emp.id}`;
      if (actions.some((a) => a.kind === 'reserve_asset' || a.kind === 'reserve_item') && !hasTask(data, handoverKey)) {
        actions.push({
          id: 'task:handover',
          kind: 'create_task',
          ruleKey: handoverKey,
          title: `貸与機器の準備・引き渡し（${emp.name}）`,
          description: '予約済みの機器をセットアップし、入社日に引き渡す。引き渡し時は在庫管理で「貸出／引き渡し」を登録する',
          departmentId: dept(data, JOSHIS),
          assignee: '中村 拓也',
          priority: 'high',
          dueDate: dueBefore(emp.hireDate, today),
          employeeId: emp.id,
          inquiryId: null,
          assetId: null,
          label: 'タスク「貸与機器の準備・引き渡し」を作成',
          requiresApproval: false,
        });
      }
      const shortageKey = `equip-shortage:${emp.id}`;
      if (shortages.length && !hasTask(data, shortageKey)) {
        actions.push({
          id: 'task:shortage',
          kind: 'create_task',
          ruleKey: shortageKey,
          title: `不足機器の発注確認（${emp.name}）`,
          description: `入社日までに不足：${shortages.join('、')}。発注候補を確認し、発注書を作成・承認する`,
          departmentId: dept(data, SOUMU),
          assignee: '加藤 由美',
          priority: diffDays(today, emp.hireDate) <= 10 ? 'high' : 'medium',
          dueDate: dueBefore(emp.hireDate, today, 7),
          employeeId: emp.id,
          inquiryId: null,
          assetId: null,
          label: 'タスク「不足機器の発注確認」を作成',
          requiresApproval: false,
        });
      }
      out.push({
        automationId: 'onboarding-equipment',
        key: fingerprint([...sig, ...actionSignature(actions)]),
        title: `${emp.name}さんの入社準備機器${shortages.length ? `（不足 ${shortages.length}品目）` : ''}`,
        conditions,
        actions,
        warnings: shortages.length ? [`在庫不足：${shortages.join('、')}。入荷待ちとして記録し、発注候補が自動作成されます`] : [],
        employeeId: emp.id,
      });
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// 2. 入社取り消し・退職者・削除済み社員の予約解除
// ---------------------------------------------------------------------------
export const releaseCancelledHire: AutomationDefinition = {
  id: 'release-cancelled-hire',
  name: '入社取り消し：予約の解除',
  description: '退職（入社取り消し）扱いになった社員や削除された社員の予約・予約済み資産を解除し、在庫を利用可能に戻す',
  trigger: '在籍ステータスが「退職」または社員が削除されているのに、予約中の機器・在庫がある',
  approval: 'required',
  detect({ data }) {
    const empById = new Map(data.employees.map((e) => [e.id, e]));
    const targets = new Map<string, { name: string; actions: AutomationAction[] }>();
    const add = (empId: string, name: string, a: AutomationAction) => {
      const t = targets.get(empId) ?? { name, actions: [] };
      t.actions.push(a);
      targets.set(empId, t);
    };
    for (const r of [...data.reservations].sort((a, b) => a.id.localeCompare(b.id))) {
      if (!r.employeeId || (r.status !== 'active' && r.status !== 'backorder')) continue;
      const e = empById.get(r.employeeId);
      if (e && e.status !== 'retired') continue;
      const item = data.items.find((i) => i.id === r.itemId);
      add(r.employeeId, e?.name ?? '（削除済みの社員）', { id: `release:${r.id}`, kind: 'release_reservation', reservationId: r.id, quantity: r.quantity, label: `${item?.name ?? '品目'} の${r.status === 'backorder' ? '入荷待ち' : '予約'} ${r.quantity} を解除`, requiresApproval: true });
    }
    for (const a of [...data.assets].sort((x, y) => x.assetNumber.localeCompare(y.assetNumber))) {
      if (a.status !== 'reserved' || !a.assigneeId) continue;
      const e = empById.get(a.assigneeId);
      if (e && e.status !== 'retired') continue;
      add(a.assigneeId, e?.name ?? a.assigneeName, { id: `release-asset:${a.id}`, kind: 'release_asset', assetId: a.id, label: `${a.assetNumber}（${a.name}）の予約を解除し未使用に戻す`, requiresApproval: true });
    }
    return [...targets].map(([empId, t]) => ({
      automationId: 'release-cancelled-hire',
      key: fingerprint([empId, ...t.actions.map((a) => a.id)]),
      title: `${t.name}さんの予約解除（入社取り消し・退職）`,
      conditions: [`${t.name}さんは在籍していないため、予約中の機器・在庫は不要です`],
      actions: t.actions,
      warnings: [],
      employeeId: empId,
    }));
  },
};

// ---------------------------------------------------------------------------
// 3. 退職予定による返却タスク生成
// ---------------------------------------------------------------------------
export const retirementReturn: AutomationDefinition = {
  id: 'retirement-return',
  name: '退職予定：貸与資産の返却確認',
  description: '退職日が30日以内（または経過済み）の社員に貸与中の資産ごとに返却確認タスクを作る',
  trigger: '退職日が30日以内に迫っている（または過ぎている）社員に、使用中・予約済みの資産がある',
  approval: 'required',
  detect({ data, today }) {
    const out: AutomationProposal[] = [];
    for (const e of data.employees) {
      if (!e.retireDate || diffDays(today, e.retireDate) > 30) continue;
      const assets = data.assets.filter((a) => a.assigneeId === e.id && (a.status === 'in_use' || a.status === 'reserved')).sort((x, y) => x.assetNumber.localeCompare(y.assetNumber));
      const actions: AutomationAction[] = assets
        .filter((a) => !hasTask(data, `return:${a.id}:${e.id}`))
        .map((a) => ({
          id: `task:return:${a.id}`,
          kind: 'create_task' as const,
          ruleKey: `return:${a.id}:${e.id}`,
          title: `貸与資産の返却確認：${a.assetNumber} ${a.name}（${e.name}）`,
          description: `退職日 ${e.retireDate} までに回収し、在庫管理で「返却」を登録する。データ消去・初期化を確認すること`,
          departmentId: dept(data, JOSHIS),
          assignee: '小林 美咲',
          priority: diffDays(today, e.retireDate!) <= 7 ? ('high' as const) : ('medium' as const),
          dueDate: dueBefore(e.retireDate!, today, 0),
          employeeId: e.id,
          inquiryId: null,
          assetId: a.id,
          label: `${a.assetNumber}（${a.name}）の返却確認タスクを作成`,
          requiresApproval: false,
        }));
      if (!actions.length) continue;
      out.push({
        automationId: 'retirement-return',
        key: fingerprint([e.id, e.retireDate, ...actions.map((a) => a.id)]),
        title: `${e.name}さんの貸与資産の返却（退職日 ${e.retireDate}）`,
        conditions: [`退職日 ${e.retireDate}（${diffDays(today, e.retireDate) >= 0 ? `あと${diffDays(today, e.retireDate)}日` : '経過済み'}）`, `貸与中の資産 ${assets.length}台`],
        actions,
        warnings: [],
        employeeId: e.id,
      });
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// 4. 故障受付による代替機候補の提示
// ---------------------------------------------------------------------------
const FAILURE_WORDS = ['故障', '壊れ', '起動しない', '電源が入らない', '割れ', '水をこぼ', '動かない', '映らない', '充電できない', 'ブルースクリーン'];
const SMARTPHONE_WORDS = ['スマホ', 'スマートフォン', 'iphone', '携帯'];

export function detectFailure(title: string, body: string): { failure: boolean; words: string[]; category: InventoryCategory } {
  const t = normalizeText(`${title} ${body}`);
  const words = FAILURE_WORDS.filter((w) => t.includes(normalizeText(w)));
  const category: InventoryCategory = SMARTPHONE_WORDS.some((w) => t.includes(normalizeText(w))) ? 'smartphone' : 'pc';
  return { failure: words.length > 0, words, category };
}

export function replacementCandidates(data: DataSnapshot, broken: Asset): Asset[] {
  return data.assets
    .filter((a) => a.status === 'unused' && a.id !== broken.id && (broken.itemId ? a.itemId === broken.itemId || a.category === broken.category : a.category === broken.category))
    .sort((a, b) => Number(b.itemId === broken.itemId) - Number(a.itemId === broken.itemId) || a.assetNumber.localeCompare(b.assetNumber));
}

export const failureReplacement: AutomationDefinition = {
  id: 'failure-replacement',
  name: '故障受付：代替機の手配',
  description: '故障の問い合わせから申請者の使用中機器を特定し、未使用の代替機を貸出候補にする。在庫がなければ入荷待ちとして記録する',
  trigger: '未解決の問い合わせに故障を示す語があり、申請者に使用中のPC・スマートフォンがある',
  approval: 'required',
  detect({ data, today }) {
    const out: AutomationProposal[] = [];
    const taken = new Set<string>();
    const handledInquiries = new Set(data.assetEvents.filter((e) => e.inquiryId).map((e) => e.inquiryId!));
    // 受付の古い順に代替機を割り当てる。入力の並び順に依存しない
    for (const inq of [...data.inquiries].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.number.localeCompare(b.number))) {
      if (inq.status === 'resolved' || inq.status === 'closed' || !inq.requesterId) continue;
      // この問い合わせで既に資産を動かした (修理中にした・代替機を貸した) / 入荷待ちを記録した → 対応済み。
      // 判定し直すと、貸し出した代替機を「故障機」と誤認して提案が繰り返されるため除外する
      if (handledInquiries.has(inq.id) || data.reservations.some((r) => r.key === `replacement:${inq.id}`)) continue;
      const f = detectFailure(inq.title, inq.body);
      if (!f.failure) continue;
      const broken = data.assets
        .filter((a) => a.assigneeId === inq.requesterId && a.status === 'in_use' && a.category === f.category)
        .sort((x, y) => x.assetNumber.localeCompare(y.assetNumber))[0];
      if (!broken) continue;
      const cand = replacementCandidates(data, broken).find((a) => !taken.has(a.id));
      const item: Item | undefined = data.items.find((i) => i.id === broken.itemId);
      const actions: AutomationAction[] = [
        { id: 'status', kind: 'set_asset_status', assetId: broken.id, status: 'repair', note: `問い合わせ ${inq.number} により修理中へ`, inquiryId: inq.id, label: `${broken.assetNumber}（${broken.name}）を「修理中」にする`, requiresApproval: true },
      ];
      if (cand) {
        taken.add(cand.id);
        actions.push({ id: 'loan', kind: 'loan_asset', assetId: cand.id, employeeId: inq.requesterId, inquiryId: inq.id, label: `代替機 ${cand.assetNumber}（${cand.name}）を ${inq.requesterName}さんに貸出`, requiresApproval: true });
      } else if (item) {
        actions.push({ id: 'backorder', kind: 'backorder_item', itemId: item.id, quantity: 1, employeeId: inq.requesterId, inquiryId: inq.id, key: `replacement:${inq.id}`, label: `代替機の在庫なし → ${item.name} 1台を入荷待ちとして記録（発注候補に反映）`, requiresApproval: true });
      }
      const repairKey = `repair:${inq.id}:${broken.id}`;
      if (!hasTask(data, repairKey))
        actions.push({
          id: 'task:repair',
          kind: 'create_task',
          ruleKey: repairKey,
          title: `故障機の修理手配：${broken.assetNumber} ${broken.name}`,
          description: `問い合わせ ${inq.number}「${inq.title}」。メーカー修理または交換を手配する（保証期限：${broken.warrantyUntil ?? '不明'}）`,
          departmentId: dept(data, JOSHIS),
          assignee: inq.assignee || '小林 美咲',
          priority: inq.priority,
          dueDate: toPreviousBusinessDay(addDays(today, 2)) < today ? today : toPreviousBusinessDay(addDays(today, 2)),
          employeeId: null,
          inquiryId: inq.id,
          assetId: broken.id,
          label: 'タスク「故障機の修理手配」を作成',
          requiresApproval: false,
        });
      const loanKey = `loan:${inq.id}`;
      if (cand && !hasTask(data, loanKey))
        actions.push({
          id: 'task:loan',
          kind: 'create_task',
          ruleKey: loanKey,
          title: `代替機の引き渡し：${cand.assetNumber}（${inq.requesterName}）`,
          description: `問い合わせ ${inq.number}。初期設定のうえ引き渡し、故障機を回収する`,
          departmentId: dept(data, JOSHIS),
          assignee: inq.assignee || '小林 美咲',
          priority: 'high',
          dueDate: today,
          employeeId: null,
          inquiryId: inq.id,
          assetId: cand.id,
          label: 'タスク「代替機の引き渡し」を作成',
          requiresApproval: false,
        });
      out.push({
        automationId: 'failure-replacement',
        key: fingerprint([inq.id, broken.id, ...actionSignature(actions)]),
        title: `${inq.number} 故障対応：${broken.assetNumber} の代替機${cand ? `候補 ${cand.assetNumber}` : 'なし（入荷待ち）'}`,
        conditions: [`故障を示す語：${f.words.join('、')}`, `${inq.requesterName}さんの使用中機器：${broken.assetNumber} ${broken.name}`, cand ? `未使用の代替機：${cand.assetNumber}` : '未使用の代替機がありません'],
        actions,
        warnings: cand ? [] : ['代替機の在庫がありません。入荷待ちとして記録し、発注候補が自動作成されます'],
        employeeId: inq.requesterId,
        inquiryId: inq.id,
        assetId: broken.id,
      });
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// 5. 在庫不足による発注候補生成 (自動実行・下書きのみ)
// ---------------------------------------------------------------------------
export const lowStockReorder: AutomationDefinition = {
  id: 'low-stock-reorder',
  name: '在庫不足：発注候補の自動作成',
  description: '見込み在庫（利用可能数 − 入荷待ち需要 + 発注残）が最低在庫数を下回った品目の発注候補を作成・更新する。発注候補は下書きで、発注書の作成・承認は担当者が行う',
  trigger: '在庫の入出庫・予約・発注のたびに自動判定（見込み在庫 < 最低在庫数）',
  approval: 'auto',
  detect: () => [], // 実行はサービス層の syncSuggestions が在庫変更と同じトランザクションで行う
};

export const INVENTORY_AUTOMATIONS: AutomationDefinition[] = [onboardingEquipment, releaseCancelledHire, retirementReturn, failureReplacement, lowStockReorder];
