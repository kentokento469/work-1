/**
 * バックアップの暗号化 (Phase 9)。ブラウザ標準の Web Crypto API だけを使い、外部への送信はしない。
 *
 * 方式: パスワードから PBKDF2 (SHA-256・既定 600,000 回・ランダムな 16 バイトの salt) で 256 ビットの鍵を作り、
 *       AES-GCM (ランダムな 12 バイトの IV) でバックアップの JSON 全体を暗号化する。AES-GCM は改ざん・破損も検出する。
 * 鍵の管理: 鍵・パスワードはどこにも保存しない。**パスワードを忘れると、誰にも (開発者にも) 復元できない**。
 * 暗号化するのはファイルの中身だけで、ファイル名・作成日時・ファイルの大きさは隠れない。
 */
import { base64ToBuffer, bufferToBase64 } from './backup';

export const ENCRYPTED_BACKUP_FORMAT = 'WorkCore-encrypted-backup';
export const DEFAULT_KDF_ITERATIONS = 600_000;
export const MIN_PASSWORD_LENGTH = 8;

export interface EncryptedBackupFile {
  format: typeof ENCRYPTED_BACKUP_FORMAT;
  version: 1;
  createdAt: string;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  cipher: { name: 'AES-GCM'; iv: string };
  /** 暗号文 (Base64) */
  data: string;
}

export function validatePassword(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `パスワードは${MIN_PASSWORD_LENGTH}文字以上にしてください`;
  if (password !== confirm) return '確認用のパスワードが一致しません';
  return null;
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptBackupText(text: string, password: string, opts: { iterations?: number; now?: Date } = {}): Promise<string> {
  const iterations = opts.iterations ?? DEFAULT_KDF_ITERATIONS;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, iterations);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, new TextEncoder().encode(text));
  const file: EncryptedBackupFile = {
    format: ENCRYPTED_BACKUP_FORMAT,
    version: 1,
    createdAt: (opts.now ?? new Date()).toISOString(),
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: bufferToBase64(salt.buffer as ArrayBuffer) },
    cipher: { name: 'AES-GCM', iv: bufferToBase64(iv.buffer as ArrayBuffer) },
    data: bufferToBase64(cipher),
  };
  return JSON.stringify(file);
}

/** 暗号化されたバックアップか (ファイルの先頭部分だけで判定する。全体を解析しない) */
export function isEncryptedBackupText(text: string): boolean {
  return text.slice(0, 200).includes(`"format":"${ENCRYPTED_BACKUP_FORMAT}"`);
}

export async function decryptBackupText(text: string, password: string): Promise<{ ok: true; text: string; createdAt: string } | { ok: false; error: string }> {
  let file: EncryptedBackupFile;
  try {
    file = JSON.parse(text) as EncryptedBackupFile;
  } catch {
    return { ok: false, error: '暗号化されたバックアップを読み込めませんでした。ファイルが壊れていないか確認してください' };
  }
  if (file?.format !== ENCRYPTED_BACKUP_FORMAT || file.version !== 1 || file.kdf?.name !== 'PBKDF2' || file.cipher?.name !== 'AES-GCM')
    return { ok: false, error: '対応していない形式の暗号化バックアップです' };
  const iterations = file.kdf.iterations;
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10_000_000) return { ok: false, error: '暗号化の設定が正しくありません（ファイルが壊れている可能性があります）' };
  const salt = base64ToBuffer(file.kdf.salt);
  const iv = base64ToBuffer(file.cipher.iv);
  const data = typeof file.data === 'string' ? base64ToBuffer(file.data) : null;
  if (!salt || !iv || !data) return { ok: false, error: '暗号化されたバックアップが壊れています' };
  try {
    const key = await deriveKey(password, new Uint8Array(salt), iterations);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, key, data);
    return { ok: true, text: new TextDecoder().decode(plain), createdAt: String(file.createdAt ?? '') };
  } catch {
    // AES-GCM は、パスワードの誤りとファイルの改ざん・破損を区別できない
    return { ok: false, error: 'パスワードが違うか、ファイルが壊れている（改ざんされている）ため復号できませんでした' };
  }
}
