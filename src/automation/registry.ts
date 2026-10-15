/**
 * すべての自動化の登録簿。新しい自動化はここに追加するだけで、
 * 自動化センターの一覧・設定・提案・承認時の再判定・自動実行の対象になる。
 */
import type { AutomationDefinition } from './engine';
import { INVENTORY_AUTOMATIONS } from './inventoryAutomations';
import { WORKFLOW_AUTOMATIONS } from './workflowAutomations';

export const ALL_AUTOMATIONS: AutomationDefinition[] = [...WORKFLOW_AUTOMATIONS, ...INVENTORY_AUTOMATIONS];
