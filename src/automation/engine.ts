/**
 * 自動化エンジン (UI・DB から独立した純粋関数の枠組み)。
 *
 * 各自動化 (AutomationDefinition) は次の要素を持つ:
 * - 実行条件 (trigger)       : どんな状態になったら提案/実行するか
 * - 検出 (detect)            : 現在のデータから提案 (Proposal) を作る。副作用なし
 * - 実行内容 (actions)       : 提案に含まれる操作の一覧。各操作に「承認が必要か」を持つ
 * - 重複実行防止 (key)        : 対象 + 条件の指紋。同じキーの提案は一度だけ実行/見送りできる
 * - 実行結果・処理履歴        : サービス層が AutomationRun として記録する
 * - エラー処理               : サービス層が1トランザクションで実行し、失敗時は全体を取り消して履歴に失敗を残す
 *
 * 承認モード
 * - 'required': 在庫の引当・資産の状態変更などを含むため、担当者が内容を確認して承認するまで実行しない
 * - 'auto'    : 実行しても業務上の確定を伴わない (発注候補=下書きの作成など)。サービス層が自動実行し履歴を残す
 *
 * 利用者による設定 (Phase 5, automation/settings.ts)
 * - 各自動化を有効/無効にできる
 * - autoCapable (操作がタスク作成など取り消しやすいものだけ) の自動化は「確認してから実行 / 自動で実行」を選べる
 * - 外部への影響がある操作 (発注・請求・申請・送信・アカウント削除) を含む自動化は、常に確認が必要 (autoCapable にしない)
 */
import type { DataSnapshot, ISODate, Priority } from '../domain/types';
import type { AssetStatus } from '../domain/inventory/types';
import type { StockStatus } from '../domain/inventory/stock';

export type ActionPayload =
  | { kind: 'reserve_asset'; assetId: string; employeeId: string }
  | { kind: 'loan_asset'; assetId: string; employeeId: string; inquiryId: string | null }
  | { kind: 'reserve_item'; itemId: string; quantity: number; employeeId: string | null; inquiryId: string | null; key: string }
  | { kind: 'backorder_item'; itemId: string; quantity: number; employeeId: string | null; inquiryId: string | null; key: string }
  | { kind: 'release_reservation'; reservationId: string; quantity: number }
  | { kind: 'release_asset'; assetId: string }
  | { kind: 'set_asset_status'; assetId: string; status: AssetStatus; note: string; inquiryId: string | null }
  | {
      kind: 'create_task';
      ruleKey: string;
      title: string;
      description: string;
      departmentId: string;
      assignee: string;
      priority: Priority;
      dueDate: ISODate;
      employeeId: string | null;
      inquiryId: string | null;
      assetId: string | null;
    }
  | {
      /** 入社準備ルール (Phase 1) に基づくタスク。source: 'onboarding'・ruleId で入社準備画面の重複判定と共通 */
      kind: 'create_onboarding_task';
      employeeId: string;
      ruleId: string;
      title: string;
      description: string;
      departmentId: string;
      assignee: string;
      priority: Priority;
      dueDate: ISODate;
    };

export type AutomationAction = ActionPayload & {
  /** 提案内で安定したID (再検出しても同じ操作には同じIDが付く) */
  id: string;
  label: string;
  requiresApproval: boolean;
};

export interface AutomationProposal {
  automationId: string;
  key: string;
  title: string;
  /** 実行条件を満たした根拠 */
  conditions: string[];
  actions: AutomationAction[];
  warnings: string[];
  employeeId?: string;
  inquiryId?: string;
  assetId?: string;
}

export interface AutomationContext {
  data: DataSnapshot;
  today: ISODate;
  stock: Map<string, StockStatus>;
}

export interface AutomationDefinition {
  id: string;
  name: string;
  description: string;
  /** 実行条件 (画面表示用) */
  trigger: string;
  approval: 'required' | 'auto';
  detect: (ctx: AutomationContext) => AutomationProposal[];
  /** 分類 (画面表示用) */
  category?: string;
  /** 操作がタスク作成など取り消しやすいものだけで、利用者の設定で自動実行にできる */
  autoCapable?: boolean;
}

/** 処理済み (実行・見送り・自動実行) のキーを除いた提案一覧。isEnabled で無効にした自動化は判定しない */
export function pendingProposals(defs: AutomationDefinition[], ctx: AutomationContext, isEnabled: (id: string) => boolean = () => true): AutomationProposal[] {
  const done = new Set(ctx.data.automationRuns.filter((r) => r.status === 'applied' || r.status === 'dismissed' || r.status === 'auto').map((r) => `${r.automationId}|${r.key}`));
  return defs
    .filter((d) => isEnabled(d.id))
    .flatMap((d) => d.detect(ctx))
    .filter((p) => p.actions.length > 0 && !done.has(`${p.automationId}|${p.key}`));
}

/** 提案の実行内容の指紋 (どの資産・数量を使うかが変わったら別の提案として扱う) */
export function actionSignature(actions: AutomationAction[]): string[] {
  return actions.map((a) => [a.id, 'assetId' in a ? a.assetId : '', 'quantity' in a ? a.quantity : '', 'status' in a ? a.status : ''].join(':'));
}

/** 文字列の短い指紋 (重複防止キー用) */
export function fingerprint(parts: (string | number)[]): string {
  let h = 0;
  for (const ch of parts.join('|')) h = (Math.imul(31, h) + ch.charCodeAt(0)) | 0;
  return (h >>> 0).toString(36);
}
