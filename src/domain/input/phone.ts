/**
 * 日本の電話番号の整形・検証。
 * 固定電話は市外局番によって桁の区切りが異なる (03-1234-5678 / 045-123-4567 / 0466-12-3456 / 04992-1-2345)。
 * 自前の規則では誤った位置にハイフンを入れる恐れがあるため、総務省の番号計画に基づく
 * libphonenumber-js のメタデータ (min) で判定する。判定できない番号は整形せず、そのまま残す。
 */
import { parsePhoneNumberFromString } from 'libphonenumber-js/min';
import { toHalfWidth } from './normalize';

export type PhoneKind = 'mobile' | 'fixed' | 'ip' | 'toll_free' | 'other';

export interface PhoneResult {
  /** 保存・表示する文字列 (整形できた場合は 090-1234-5678 形式、できなければ入力を半角にしたもの) */
  value: string;
  valid: boolean;
  kind: PhoneKind | null;
}

/** 入力中に許可する文字だけを残す (全角→半角。数字・ハイフン・括弧・+ ) */
export function cleanPhoneTyping(raw: string): string {
  // 電話番号の中の長音「ー」はハイフンの入力ミスとして扱う
  return toHalfWidth(raw).replace(/ー/g, '-').replace(/[^\d\-+()]/g, '');
}

/** 番号の種類は先頭の番号で判定する (総務省の番号計画) */
function kindOf(national: string): PhoneKind {
  // 0800 (フリーダイヤル) は 080 (携帯) より先に判定する
  if (/^(0120\d{6}|0800\d{7})$/.test(national)) return 'toll_free';
  if (/^0[789]0\d{8}$/.test(national)) return 'mobile';
  if (/^050\d{8}$/.test(national)) return 'ip';
  if (/^0(570|990|180|20|60)/.test(national)) return 'other';
  return 'fixed';
}

export function formatPhone(raw: string): PhoneResult {
  const t = toHalfWidth(raw).trim();
  if (!t) return { value: '', valid: true, kind: null };
  const digits = t.replace(/[^\d+]/g, '');
  const p = parsePhoneNumberFromString(digits, 'JP');
  if (!p || !p.isValid() || p.country !== 'JP') return { value: t.replace(/[^\d\-+()]/g, ''), valid: false, kind: null };
  return { value: p.formatNational(), valid: true, kind: kindOf(`0${p.nationalNumber}`) };
}

export const PHONE_KIND_LABEL: Record<PhoneKind, string> = { mobile: '携帯電話', fixed: '固定電話', ip: 'IP電話（050）', toll_free: 'フリーダイヤル', other: 'その他の番号' };
