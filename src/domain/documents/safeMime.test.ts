import { describe, expect, it } from 'vitest';
import { mimeForImport, safeDocumentMime } from './safeMime';
import { createBackup, decodeBackupFiles } from '../../data/backup';
import { sha256Hex } from './hash';
import { createDemoData } from '../../demo/demoData';

describe('書類の元ファイルの種類 (Phase 11・XSS 対策)', () => {
  it('対応形式以外は表示しない種類 (octet-stream) にする', () => {
    expect(safeDocumentMime('image/png')).toBe('image/png');
    expect(safeDocumentMime('APPLICATION/PDF; charset=binary')).toBe('application/pdf');
    for (const bad of ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/xml', '', undefined]) expect(safeDocumentMime(bad)).toBe('application/octet-stream');
  });
  it('取り込み時は判定結果に合わせた安全な種類で保存する', () => {
    expect(mimeForImport('image', 'image/svg+xml')).toBe('image/jpeg');
    expect(mimeForImport('image', 'image/png')).toBe('image/png');
    expect(mimeForImport('image', '')).toBe('image/jpeg');
    expect(mimeForImport('pdf', 'text/html')).toBe('application/pdf');
    expect(mimeForImport('heic', 'image/heif')).toBe('image/heif');
  });
  it('バックアップに書かれた危険な種類は、復元時に表示しない種類へ置き換える', async () => {
    const buf = new TextEncoder().encode('<svg onload="alert(1)"/>').buffer as ArrayBuffer;
    const hash = await sha256Hex(buf);
    const backup = createBackup(createDemoData('2026-10-15'), new Date(), [{ id: 'f1', documentId: 'd1', name: 'x.png', mime: 'image/svg+xml', size: buf.byteLength, hash, data: buf, createdAt: '2026-10-01T00:00:00Z' }]);
    const decoded = await decodeBackupFiles(JSON.parse(JSON.stringify(backup)));
    expect(decoded.ok && decoded.files[0]!.mime).toBe('application/octet-stream');
  });
});
