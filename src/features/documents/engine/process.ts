/**
 * 書類の解析手順:
 *  1. ファイル形式を判定
 *  2. PDF に埋め込みテキストがあれば、そのページは直接抽出 (OCR しない)
 *  3. テキストのないページ・画像だけを OCR (1ページずつ描画 → 認識 → 解放)
 *  4. 抽出したテキストから項目を構造化 (domain/documents/extract)
 * 途中でキャンセルでき、失敗しても元ファイルは保存済みなので手入力で続けられる。
 */
import type { SourcePage } from '../../../domain/documents/extract';
import type { DocumentPage, ExtractionMethod } from '../../../domain/documents/types';
import { decodeImage, fileKind, hasEnoughText, OCR_MAX_SIDE, openPdf, releaseCanvas } from './media';
import { createOcrEngine, type OcrEngine } from './ocr';

export interface StepProgress {
  page: number;
  pageIndex: number;
  pageCount: number;
  message: string;
  /** 全体の進み具合 0-1 */
  overall: number;
}

export interface ProcessOptions {
  data: ArrayBuffer;
  name: string;
  mime: string;
  /** 処理するページ (1始まり)。画像は [1] */
  pages: number[];
  /** OCR を使ってよいか (準備済み・利用者が許可) */
  allowOcr: boolean;
  onProgress: (p: StepProgress) => void;
  signal: AbortSignal;
}

export interface ProcessResult {
  method: ExtractionMethod;
  pages: DocumentPage[];
  source: SourcePage[];
  /** テキストがなく、OCR が使えなかったため読めなかったページ */
  unreadPages: number[];
}

export class CancelledError extends Error {
  constructor() {
    super('キャンセルしました');
  }
}

export async function processDocument(o: ProcessOptions): Promise<ProcessResult> {
  const kind = fileKind(o.name, o.mime);
  const pages: DocumentPage[] = [];
  const source: SourcePage[] = [];
  const unread: number[] = [];
  let engine: OcrEngine | null = null;
  let usedOcr = false;
  let usedText = false;
  const total = o.pages.length;
  const check = () => {
    if (o.signal.aborted) throw new CancelledError();
  };
  const abort = () => void engine?.terminate();
  o.signal.addEventListener('abort', abort);

  const ocr = async (canvas: HTMLCanvasElement, page: number, i: number) => {
    if (!engine) {
      o.onProgress({ page, pageIndex: i, pageCount: total, message: 'OCRエンジンを準備中', overall: i / total });
      engine = await createOcrEngine((p) => o.onProgress({ page, pageIndex: i, pageCount: total, message: p.status, overall: (i + (p.status === '文字を認識中' ? p.progress : 0)) / total }));
      check();
    }
    o.onProgress({ page, pageIndex: i, pageCount: total, message: '文字を認識中', overall: i / total });
    const r = await engine.recognize(canvas);
    usedOcr = true;
    pages.push({ page, method: 'ocr', text: r.text, ocrConfidence: Math.round(r.confidence) });
    source.push({ page, lines: r.lines });
  };

  try {
    if (kind === 'image' || kind === 'heic') {
      if (!o.allowOcr) throw new Error('画像の文字を読み取るには、OCRの準備（初回のみダウンロード）が必要です');
      o.onProgress({ page: 1, pageIndex: 0, pageCount: 1, message: '画像を読み込み中', overall: 0 });
      const canvas = await decodeImage(o.data, o.mime, OCR_MAX_SIDE);
      if (!canvas)
        throw new Error(kind === 'heic' ? 'このブラウザでは HEIC 形式の画像を読み込めません。iPhoneの「設定 > カメラ > フォーマット」で「互換性優先」にするか、JPEGで保存した画像・スクリーンショットを使ってください' : '画像を読み込めませんでした。ファイルが壊れていないか確認してください');
      try {
        check();
        await ocr(canvas, 1, 0);
      } finally {
        releaseCanvas(canvas);
      }
    } else if (kind === 'pdf') {
      o.onProgress({ page: o.pages[0] ?? 1, pageIndex: 0, pageCount: total, message: 'PDFを読み込み中', overall: 0 });
      const pdf = await openPdf(o.data);
      try {
        for (const [i, n] of o.pages.entries()) {
          check();
          o.onProgress({ page: n, pageIndex: i, pageCount: total, message: 'PDFのテキストを確認中', overall: i / total });
          const lines = await pdf.pageText(n);
          if (hasEnoughText(lines)) {
            usedText = true;
            pages.push({ page: n, method: 'pdf_text', text: lines.join('\n'), ocrConfidence: null });
            source.push({ page: n, lines: lines.map((t) => ({ text: t, confidence: null })) });
            continue;
          }
          if (!o.allowOcr) {
            unread.push(n);
            pages.push({ page: n, method: 'none', text: lines.join('\n'), ocrConfidence: null });
            continue;
          }
          o.onProgress({ page: n, pageIndex: i, pageCount: total, message: 'ページを画像化中', overall: i / total });
          const canvas = await pdf.render(n, OCR_MAX_SIDE);
          try {
            check();
            await ocr(canvas, n, i);
          } finally {
            releaseCanvas(canvas);
          }
        }
      } finally {
        await pdf.destroy();
      }
    } else {
      throw new Error('対応していない形式です（JPEG・PNG・PDF に対応）');
    }
  } catch (e) {
    if (o.signal.aborted) throw new CancelledError();
    throw e;
  } finally {
    o.signal.removeEventListener('abort', abort);
    await (engine as OcrEngine | null)?.terminate().catch(() => undefined);
  }
  o.onProgress({ page: o.pages.at(-1) ?? 1, pageIndex: total, pageCount: total, message: '項目を抽出中', overall: 1 });
  return { method: usedOcr && usedText ? 'mixed' : usedOcr ? 'ocr' : usedText ? 'pdf_text' : 'manual', pages, source, unreadPages: unread };
}
