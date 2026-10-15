/**
 * 秘密情報 (パスワード・認証コード・カード番号等) の検出と伏せ字化。
 * 問い合わせ・コメント・FAQ・操作履歴に秘密情報を保存しないため、保存前に必ず検査する。
 * 誤検出よりも見逃しのほうが損害が大きいため、やや広めに検出し、利用者に伏せ字化を促す。
 */

export interface SecretFinding {
  label: string;
  /** 画面表示用。値そのものは表示せず先頭だけ見せる */
  preview: string;
}

interface Pattern {
  label: string;
  re: RegExp;
  /** 伏せ字にする部分のキャプチャグループ番号 (0 = 全体) */
  group: number;
}

const PATTERNS: Pattern[] = [
  // 「パスワード: abc123」「PW=xxxx」「パスワードは abc123 です」
  // 値は半角の印字可能文字に限定し、区切り (: = は が) を必須にする (「パスワードを忘れた」等は対象外)
  { label: 'パスワード', re: /((?:パスワード|password|passwd|pw|ＰＷ|暗証番号|パスコード)\s*(?:(?:は|が)?\s*[:：=＝]|は|が)\s*[「『"']?)([!-~]{4,})/gi, group: 2 },
  // 認証コード・ワンタイムパスワード
  { label: '認証コード', re: /((?:認証コード|確認コード|ワンタイム(?:パスワード)?|otp|pin)\s*(?:は|が)?\s*[:：=＝]?\s*)(\d{4,8})(?!\d)/gi, group: 2 },
  // クレジットカード番号らしき16桁 (区切り含む)
  { label: 'カード番号', re: /(?<!\d)(\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4})(?!\d)/g, group: 1 },
  // APIキー・トークンらしき長いランダム文字列 (英字と数字を両方含む24文字以上)
  { label: 'APIキー・トークン', re: /(?<![A-Za-z0-9])((?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,})(?![A-Za-z0-9])/g, group: 1 },
];

export function detectSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    for (const m of text.matchAll(p.re)) {
      const v = m[p.group] ?? '';
      findings.push({ label: p.label, preview: `${v.slice(0, 1)}${'*'.repeat(Math.max(3, v.length - 1))}` });
    }
  }
  return findings;
}

/** 検出した秘密情報を「＊＊＊（削除済み）」に置き換える */
export function maskSecrets(text: string): string {
  let out = text;
  for (const p of PATTERNS) {
    out = out.replace(p.re, (...args) => {
      const groups = args.slice(1, -2) as (string | undefined)[];
      if (p.group === 0) return '＊＊＊（削除済み）';
      // group より前のキャプチャはそのまま残す
      const prefix = groups.slice(0, p.group - 1).join('');
      return `${prefix}＊＊＊（削除済み）`;
    });
  }
  return out;
}

export function hasSecrets(...texts: string[]): boolean {
  return texts.some((t) => detectSecrets(t).length > 0);
}
