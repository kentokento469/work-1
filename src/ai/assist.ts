/**
 * 支援機能の提供者 (AI 連携のための差し替え口)。
 *
 * 画面は「支援の提供者 (AssistProvider)」を通して分類・提案・要約などを受け取る。
 * 現在はルールベースの提供者だけを実装している (外部 AI へは何も送信しない)。
 * 将来 AI モデルをつなぐ場合も、同じ形の提供者を追加して切り替えるだけで画面は変えずに済む。
 *
 * 守ること
 * - AI モデルが接続されていないときに、AI が動いているように見せない (提供者の種類を必ず表示する)
 * - 提案と、利用者が確定した情報を区別する (提案は保存しない／確定は利用者の操作で行う)
 * - 外部 AI への送信は、利用者の許可と設定がある場合だけ行う (送信内容を事前に表示する)
 * - AI が使えない・失敗した場合は、ルールベースの結果で業務を続けられる
 */
import { classifyInquiry, type ClassificationResult } from '../domain/helpdesk/classifier';
import type { DashboardStats } from '../domain/analytics';
import type { HelpdeskStats } from '../domain/helpdesk/analytics';
import type { InventoryStats } from '../domain/inventory/analytics';
import type { InquiryCategory } from '../domain/types';

export type AssistKind = 'rule' | 'model';

export interface AssistProvider {
  id: string;
  kind: AssistKind;
  /** 画面に表示する名前。AI でない場合はそのことが分かる名前にする */
  label: string;
  /** 外部へデータを送信するか (rule は常に false) */
  sendsData: boolean;
  classifyInquiry(title: string, body: string, categories: InquiryCategory[]): Promise<ClassificationResult>;
  summarizeStatus(input: { stats: DashboardStats; helpdesk: HelpdeskStats; inventory: InventoryStats; proposals: number; documentsToReview: number }): Promise<StatusSummary>;
}

export interface StatusSummary {
  /** 要点 (1行ずつ) */
  points: { text: string; href?: string; tone: 'alert' | 'info' | 'ok' }[];
  generatedBy: { kind: AssistKind; label: string };
}

/** ルールベースの提供者 (既存の分類器・集計値を使う。外部送信なし) */
export const ruleBasedProvider: AssistProvider = {
  id: 'rule',
  kind: 'rule',
  label: 'ルールベース（AIではありません）',
  sendsData: false,
  async classifyInquiry(title, body, categories) {
    return classifyInquiry(title, body, categories);
  },
  async summarizeStatus({ stats, helpdesk, inventory, proposals, documentsToReview }) {
    const points: StatusSummary['points'] = [];
    if (stats.overdueTaskCount) points.push({ text: `期限超過のタスクが ${stats.overdueTaskCount}件あります`, href: '#/tasks?status=overdue', tone: 'alert' });
    if (helpdesk.overdueCount) points.push({ text: `対応期限を過ぎた問い合わせが ${helpdesk.overdueCount}件あります`, href: '#/helpdesk?status=overdue', tone: 'alert' });
    if (helpdesk.newCount) points.push({ text: `未対応の問い合わせが ${helpdesk.newCount}件あります`, href: '#/helpdesk?status=new', tone: 'info' });
    if (inventory.shortageItems) points.push({ text: `在庫不足の品目が ${inventory.shortageItems}件あります（発注候補 ${inventory.openSuggestions}件）`, href: '#/inventory?tab=stock&state=shortage', tone: 'alert' });
    if (inventory.pendingApproval) points.push({ text: `承認待ちの発注書が ${inventory.pendingApproval}件あります`, href: '#/inventory?tab=orders&pstatus=pending_approval', tone: 'info' });
    if (proposals) points.push({ text: `承認待ちの自動化提案が ${proposals}件あります`, href: '#/automation', tone: 'info' });
    if (documentsToReview) points.push({ text: `確認待ちの書類が ${documentsToReview}件あります`, href: '#/documents?status=needs_review', tone: 'info' });
    const soon = stats.hireProgress.filter((h) => h.daysUntil >= 0 && h.daysUntil <= 14 && h.done < h.total);
    if (soon.length) points.push({ text: `2週間以内に入社する ${soon.length}名の準備タスクが未完了です`, href: '#/onboarding', tone: 'info' });
    if (!points.length) points.push({ text: '対応が必要な項目はありません', tone: 'ok' });
    return { points, generatedBy: { kind: 'rule', label: this.label } };
  },
};

/** 現在使われる提供者。AI モデルの接続は未実装 (Phase 6 以降。送信内容の確認と利用者の許可を前提に追加する) */
export function currentProvider(): AssistProvider {
  return ruleBasedProvider;
}
