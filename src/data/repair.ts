/**
 * 任意の参照 (無くても業務が成り立つ関連付け) の参照切れを修復する (純粋関数)。
 * 例: 削除された社員・問い合わせ・プロジェクト・親タスク・品目を指したままのタスク・書類・発注候補。
 * 関連付けを外す (null にする) / 対象の無い発注候補を除く だけで、業務データ自体は消さない。
 * 社員の所属部署・発注書の品目のような必須の参照や、在庫数と履歴の不一致は修復しない (エラーのまま)。
 */
import type { DataSnapshot } from '../domain/types';

export interface RepairResult {
  data: DataSnapshot;
  /** 修復内容 (利用者に表示する) */
  repairs: string[];
}

export function repairOptionalReferences(input: DataSnapshot): RepairResult {
  const repairs: string[] = [];
  const has = <T extends { id: string }>(arr: T[]) => {
    const s = new Set(arr.map((x) => x.id));
    return (id: string | null | undefined) => !id || s.has(id);
  };
  const emp = has(input.employees);
  const inq = has(input.inquiries);
  const proj = has(input.projects ?? []);
  const task = has(input.tasks);
  const dept = has(input.departments);
  const item = has(input.items);
  const po = has(input.purchaseOrders);
  const count = (label: string, n: number) => n > 0 && repairs.push(`${label}：${n}件`);

  let c = { emp: 0, inq: 0, proj: 0, parent: 0, dept: 0, deps: 0 };
  const tasks = input.tasks.map((t) => {
    const next = { ...t };
    if (!emp(t.employeeId)) (next.employeeId = null), c.emp++;
    if (!inq(t.inquiryId)) (next.inquiryId = null), c.inq++;
    if (!proj(t.projectId)) (next.projectId = null), c.proj++;
    if (!task(t.parentTaskId)) (next.parentTaskId = null), c.parent++;
    if (!dept(t.assigneeDepartmentId)) (next.assigneeDepartmentId = null), c.dept++;
    if (t.dependsOn?.some((id) => !task(id))) (next.dependsOn = t.dependsOn.filter((id) => task(id))), c.deps++;
    return next;
  });
  count('削除済みの社員を指していたタスクの関連付けを解除', c.emp);
  count('削除済みの問い合わせを指していたタスクの関連付けを解除', c.inq);
  count('削除済みのプロジェクトを指していたタスクの所属を解除', c.proj);
  count('削除済みの親タスクを指していたサブタスクを独立したタスクに変更', c.parent);
  count('削除済みの部署を指していたタスクの担当部署を解除', c.dept);
  count('削除済みの前提タスクを依存関係から除外', c.deps);

  const docC = { emp: 0, inq: 0, po: 0, line: 0 };
  const documents = input.documents.map((d) => {
    const next = { ...d };
    if (!emp(d.employeeId)) (next.employeeId = null), docC.emp++;
    if (!inq(d.inquiryId)) (next.inquiryId = null), docC.inq++;
    if (!po(d.purchaseOrderId)) (next.purchaseOrderId = null), docC.po++;
    if (d.lines.some((l) => !item(l.itemId))) (next.lines = d.lines.map((l) => (item(l.itemId) ? l : { ...l, itemId: null }))), docC.line++;
    return next;
  });
  count('削除済みの社員・問い合わせ・発注書を指していた書類の関連付けを解除', docC.emp + docC.inq + docC.po);
  count('削除済みの品目を指していた書類の明細の品目を解除', docC.line);

  const suggestions = input.purchaseSuggestions.filter((s) => item(s.itemId));
  count('削除済みの品目の発注候補を除外', input.purchaseSuggestions.length - suggestions.length);

  return { data: { ...input, tasks, documents, purchaseSuggestions: suggestions }, repairs };
}
