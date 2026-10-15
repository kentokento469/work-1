/**
 * 画像 OCR (Tesseract.js)。ライブラリは必要なときだけ読み込み、処理は Web Worker 内で行う (画面を止めない)。
 * 日本語＋英語のモデルを使う。認識できなかった文字を推測で補うことはしない。
 */
import { loadOcrAssets, type LoadedOcrAssets } from './assets';
import type { SourceLine } from '../../../domain/documents/extract';

export interface OcrProgress {
  status: string;
  progress: number; // 0-1
}

export interface OcrEngine {
  recognize(canvas: HTMLCanvasElement): Promise<{ lines: SourceLine[]; confidence: number; text: string }>;
  terminate(): Promise<void>;
}

const STATUS_JA: Record<string, string> = {
  'loading tesseract core': 'OCRエンジンを準備中',
  'initializing tesseract': 'OCRエンジンを初期化中',
  'loading language traineddata': '言語データを読み込み中',
  'initializing api': '認識の準備中',
  'recognizing text': '文字を認識中',
};

export async function createOcrEngine(onProgress: (p: OcrProgress) => void): Promise<OcrEngine> {
  const [{ createWorker, OEM, PSM }, assets] = await Promise.all([import('tesseract.js'), loadOcrAssets()]);
  let a: LoadedOcrAssets | null = assets;
  const worker = await createWorker(assets.langs, OEM.LSTM_ONLY, {
    workerPath: assets.workerUrl,
    corePath: assets.coreUrl,
    workerBlobURL: true,
    cacheMethod: 'none', // 言語データは WorkCore 側の Cache Storage で管理する
    gzip: true,
    logger: (m: { status: string; progress: number }) => onProgress({ status: STATUS_JA[m.status] ?? m.status, progress: m.progress ?? 0 }),
  } as never);
  // 帳票は段組みが混在するため、自動ページ分割 (PSM AUTO) を使う
  await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO, preserve_interword_spaces: '1' });
  return {
    async recognize(canvas) {
      const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
      const lines: SourceLine[] = [];
      for (const b of data.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) if (l.text.trim()) lines.push({ text: l.text.replace(/\n$/, ''), confidence: l.confidence });
      if (!lines.length && data.text.trim()) for (const t of data.text.split('\n')) if (t.trim()) lines.push({ text: t, confidence: data.confidence });
      return { lines, confidence: data.confidence, text: lines.map((l) => l.text).join('\n') };
    },
    async terminate() {
      await worker.terminate();
      a?.release();
      a = null;
    },
  };
}
