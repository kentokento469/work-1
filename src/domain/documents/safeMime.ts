/**
 * 書類の元ファイルの種類 (MIME) を、表示・保存してよい種類に限る (Phase 11・セキュリティ)。
 *
 * ブラウザから渡される種類やバックアップに書かれた種類をそのまま使うと、例えば拡張子だけ .png にした SVG・HTML を
 * 「原本を拡大表示」で開いたときに、アプリと同じオリジン (blob: URL) でスクリプトが動いてしまう (XSS)。
 * 対応形式 (JPEG・PNG・WebP・GIF・BMP・HEIC・PDF) 以外は application/octet-stream (表示せずダウンロードのみ) として扱う。
 */
export const SAFE_DOCUMENT_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/heic', 'image/heif', 'application/pdf'] as const;
export const OPAQUE_MIME = 'application/octet-stream';

export function safeDocumentMime(mime: string | null | undefined): string {
  const m = (mime ?? '').toLowerCase().split(';')[0]!.trim();
  return (SAFE_DOCUMENT_MIMES as readonly string[]).includes(m) ? m : OPAQUE_MIME;
}

/** 取り込み時: ファイルの判定結果 (画像・PDF) と、ブラウザが報告した種類から、保存する種類を決める */
export function mimeForImport(kind: 'pdf' | 'image' | 'heic', reported: string): string {
  const safe = safeDocumentMime(reported);
  if (kind === 'pdf') return 'application/pdf';
  if (kind === 'heic') return safe === 'image/heic' || safe === 'image/heif' ? safe : 'image/heic';
  // 画像: 報告された種類が安全な画像ならそれ、そうでなければ (空・SVG・HTML など) JPEG とみなす (表示できなければ「表示できない」と案内)
  return safe.startsWith('image/') && safe !== 'image/heic' && safe !== 'image/heif' ? safe : 'image/jpeg';
}
