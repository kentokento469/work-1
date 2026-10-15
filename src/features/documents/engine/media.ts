/**
 * 取り込んだファイルの判定・画像の読み込み・PDF のページ処理。
 * iPhone のメモリを考慮し、PDF は1ページずつ必要な解像度でだけ描画し、使い終わったキャンバスは解放する。
 */
import { vendorUrl } from './assets';

export type FileKind = 'pdf' | 'image' | 'heic' | 'unsupported';

export function fileKind(name: string, mime: string): FileKind {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (/^image\/(heic|heif)/.test(mime) || ext === 'heic' || ext === 'heif') return 'heic';
  if (/^image\/(jpeg|png|webp|gif|bmp)$/.test(mime) || ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'].includes(ext)) return 'image';
  return 'unsupported';
}

/** OCR に渡す画像の長辺の上限 (これ以上は文字認識の精度がほぼ変わらず、メモリだけ増える) */
export const OCR_MAX_SIDE = 2400;

export function releaseCanvas(c: HTMLCanvasElement | null | undefined) {
  if (!c) return;
  // Safari はキャンバスのメモリを即時に解放しないことがあるため、サイズを0にする
  c.width = 0;
  c.height = 0;
}

/**
 * 画像を読み込み、長辺 maxSide 以下に縮小したキャンバスを返す。
 * HEIC はブラウザが表示できる場合 (iOS Safari など) だけ読み込める。読めなければ null
 */
export async function decodeImage(data: ArrayBuffer, mime: string, maxSide = OCR_MAX_SIDE): Promise<HTMLCanvasElement | null> {
  const blob = new Blob([data], { type: mime || 'image/jpeg' });
  let source: ImageBitmap | HTMLImageElement | null = null;
  let url: string | null = null;
  try {
    try {
      // EXIF の回転情報 (iPhone の縦撮影) を反映する
      source = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {
      url = URL.createObjectURL(blob);
      source = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('decode'));
        img.src = url!;
      });
    }
    const w = 'naturalWidth' in source ? source.naturalWidth : source.width;
    const h = 'naturalHeight' in source ? source.naturalHeight : source.height;
    if (!w || !h) return null;
    const scale = Math.min(1, maxSide / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#fff'; // 透過PNGの背景を白にする (黒背景だと文字が読めない)
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas;
  } catch {
    return null;
  } finally {
    if (source && 'close' in source) source.close();
    if (url) URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------------------
// PDF (PDF.js を必要なときだけ読み込む)
// ---------------------------------------------------------------------------

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjsPromise: Promise<PdfJs> | null = null;
function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((m) => {
    m.GlobalWorkerOptions.workerSrc = vendorUrl('pdfjs/pdf.worker.min.mjs');
    return m;
  });
  return pdfjsPromise;
}

export interface PdfHandle {
  numPages: number;
  /** 埋め込みテキストを行単位で取り出す (なければ空配列) */
  pageText(n: number): Promise<string[]>;
  /** ページを描画したキャンバス (長辺 maxSide 以下)。使い終わったら releaseCanvas() */
  render(n: number, maxSide: number): Promise<HTMLCanvasElement>;
  destroy(): Promise<void>;
}

export async function openPdf(data: ArrayBuffer): Promise<PdfHandle> {
  const pdfjs = await loadPdfJs();
  // PDF.js はバッファを Worker に転送して使えなくするため、コピーを渡す (元データは保存に使う)
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(data.slice(0)),
    cMapUrl: vendorUrl('pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: vendorUrl('pdfjs/standard_fonts/'),
    isEvalSupported: false,
  }).promise;
  return {
    numPages: doc.numPages,
    async pageText(n) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      // y 座標が近いテキストを1行にまとめ、上から順に並べる
      const rows: { y: number; items: { x: number; s: string; w: number }[] }[] = [];
      for (const it of content.items) {
        if (!('str' in it) || !it.str.trim()) continue;
        const x = it.transform[4] as number;
        const y = it.transform[5] as number;
        const h = Math.abs((it.transform[3] as number) || it.height || 10);
        let row = rows.find((r) => Math.abs(r.y - y) <= h * 0.5);
        if (!row) rows.push((row = { y, items: [] }));
        row.items.push({ x, s: it.str, w: it.width });
      }
      page.cleanup();
      return rows
        .sort((a, b) => b.y - a.y)
        .map((r) => {
          const items = r.items.sort((a, b) => a.x - b.x);
          let line = '';
          let end = -Infinity;
          for (const i of items) {
            line += line && i.x - end > 2 ? ` ${i.s}` : i.s;
            end = i.x + i.w;
          }
          return line.trim();
        })
        .filter(Boolean);
    },
    async render(n, maxSide) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(4, maxSide / Math.max(base.width, base.height));
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
      page.cleanup();
      return canvas;
    },
    destroy: () => doc.destroy(),
  };
}

/** 埋め込みテキストがあるページと判定する最低文字数 (スキャンPDFの透かし等の数文字では判定しない) */
export const MIN_TEXT_CHARS = 15;
export const hasEnoughText = (lines: string[]) => lines.join('').replace(/\s/g, '').length >= MIN_TEXT_CHARS;
