/**
 * 自動化ルールの設定 (有効/無効・実行方法)。settings ストアの id 'automation' に保存する。
 * 設定がない自動化は「有効・確認してから実行」で動く (既存の動作を変えない)。
 */
import type { DataSnapshot } from '../domain/types';
import type { AutomationDefinition } from './engine';

export type RuleMode = 'confirm' | 'auto';
export interface RuleSetting {
  enabled: boolean;
  mode: RuleMode;
}
export const AUTOMATION_SETTING_ID = 'automation';
export const DEFAULT_RULE_SETTING: RuleSetting = { enabled: true, mode: 'confirm' };

export function readAutomationSettings(data: Pick<DataSnapshot, 'settings'>): Record<string, RuleSetting> {
  const rec = data.settings.find((s) => s.id === AUTOMATION_SETTING_ID);
  const v = rec?.value;
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, RuleSetting> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (x && typeof x === 'object') {
      const o = x as Partial<RuleSetting>;
      out[k] = { enabled: o.enabled !== false, mode: o.mode === 'auto' ? 'auto' : 'confirm' };
    }
  }
  return out;
}

/** 設定値を取り出す。自動実行できない自動化は、設定が auto でも confirm として扱う */
export function ruleSetting(def: AutomationDefinition, settings: Record<string, RuleSetting>): RuleSetting {
  const s = settings[def.id] ?? DEFAULT_RULE_SETTING;
  return { enabled: s.enabled, mode: def.autoCapable ? s.mode : 'confirm' };
}
