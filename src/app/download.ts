/** ブラウザでファイルを保存させる (iOS Safari 13+ でも動作) */
export function downloadText(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function timestampForFile(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Web Share API でファイルを共有できるか (iPhone の共有シート →「"ファイル"に保存」など) */
export function canShareFiles(): boolean {
  try {
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [new File(['x'], 'x.csv', { type: 'text/csv' })] });
  } catch {
    return false;
  }
}

/** 共有シートでファイルを渡す。利用者が閉じた場合は false (エラーにしない) */
export async function shareTextFiles(files: { name: string; content: string; mime: string }[], title: string): Promise<boolean> {
  try {
    await navigator.share({ files: files.map((f) => new File([f.content], f.name, { type: f.mime })), title });
    return true;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return false;
    throw e;
  }
}
