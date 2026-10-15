/**
 * 解析パネル: ページ選択 → 解析 (PDFテキスト / OCR) → 抽出結果を書類に反映。
 * 進行状況を表示し、キャンセル・失敗時は手入力に切り替えられる。
 */
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckSquare, Keyboard, Play, RotateCcw, Square, X } from 'lucide-react';
import { useAppData } from '../../app/AppData';
import { extractDocument } from '../../domain/documents/extract';
import type { DocumentFile, DocumentRecord } from '../../domain/documents/types';
import { Button, cx } from '../../ui/primitives';
import { isOcrCached } from './engine/assets';
import { fileKind, openPdf, releaseCanvas } from './engine/media';
import { CancelledError, processDocument, type StepProgress } from './engine/process';
import { OcrSetupCard } from './parts';

/** ページのサムネイル (先頭から最大この枚数まで描画。メモリ節約のため小さく・順番に) */
const MAX_THUMBS = 12;

function PageThumbs({ file, count, selected, onToggle }: { file: DocumentFile; count: number; selected: Set<number>; onToggle: (n: number) => void }) {
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  useEffect(() => {
    let alive = true;
    (async () => {
      const pdf = await openPdf(file.data).catch(() => null);
      if (!pdf) return;
      try {
        for (let n = 1; n <= Math.min(count, MAX_THUMBS) && alive; n++) {
          const c = await pdf.render(n, 220);
          const url = c.toDataURL('image/jpeg', 0.6);
          releaseCanvas(c);
          if (alive) setThumbs((t) => ({ ...t, [n]: url }));
        }
      } finally {
        await pdf.destroy();
      }
    })();
    return () => {
      alive = false;
    };
  }, [file, count]);
  return (
    <ul className="grid grid-cols-3 gap-2 sm:grid-cols-6" data-testid="page-picker">
      {Array.from({ length: count }, (_, i) => i + 1).map((n) => {
        const on = selected.has(n);
        return (
          <li key={n}>
            <button
              type="button"
              onClick={() => onToggle(n)}
              aria-pressed={on}
              aria-label={`${n}ページ目を${on ? '対象から外す' : '対象にする'}`}
              className={cx('relative block w-full overflow-hidden rounded-lg border-2 bg-white text-left dark:bg-navy-950', on ? 'border-navy-600' : 'border-slate-200 opacity-70 dark:border-navy-700')}
            >
              {thumbs[n] ? <img src={thumbs[n]} alt="" className="aspect-[3/4] w-full object-cover object-top" /> : <div className="flex aspect-[3/4] items-center justify-center text-xs text-slate-400">{n <= MAX_THUMBS ? '…' : `p.${n}`}</div>}
              <span className="absolute left-1 top-1 flex items-center gap-0.5 rounded bg-white/90 px-1 text-[11px] font-semibold text-slate-700">
                {on ? <CheckSquare className="size-3.5 text-navy-700" aria-hidden /> : <Square className="size-3.5" aria-hidden />}
                {n}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function ProcessPanel({ doc, file, keepType, onClose }: { doc: DocumentRecord; file: DocumentFile; keepType: boolean; onClose: () => void }) {
  const { run } = useAppData();
  const kind = fileKind(file.name, file.mime);
  const pageCount = doc.file?.pageCount ?? 1;
  const [selected, setSelected] = useState<Set<number>>(() => {
    const prev = doc.file?.selectedPages ?? [];
    if (prev.length) return new Set(prev);
    return new Set(pageCount <= 3 ? Array.from({ length: pageCount }, (_, i) => i + 1) : [1]);
  });
  const [ocrReady, setOcrReady] = useState<boolean | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [progress, setProgress] = useState<StepProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    isOcrCached().then(setOcrReady);
    return () => abort.current?.abort(); // 画面を離れたら処理を止める
  }, []);

  const needsOcr = kind !== 'pdf';
  const start = async () => {
    setError(null);
    setResult(null);
    const ctrl = new AbortController();
    abort.current = ctrl;
    const pages = [...selected].sort((a, b) => a - b);
    try {
      const r = await processDocument({ data: file.data, name: file.name, mime: file.mime, pages, allowOcr: !!ocrReady, onProgress: setProgress, signal: ctrl.signal });
      const ex = extractDocument(r.source, keepType ? doc.type : undefined);
      await run(
        (s) => s.documents.applyExtraction(doc.id, { method: r.method, pages: r.pages, selectedPages: pages, result: ex, keepType }),
        `${Object.keys(ex.fields).length}項目を抽出しました。内容を確認してください`,
      );
      if (r.unreadPages.length) setResult(`${r.unreadPages.join('・')}ページ目は文字が埋め込まれていない（画像の）ページです。OCRを準備してから「再解析」すると読み取れます`);
      else onClose();
    } catch (e) {
      if (e instanceof CancelledError) setError('解析をキャンセルしました。元ファイルは保存されています');
      else setError(`${e instanceof Error ? e.message : '解析に失敗しました'}。元ファイルは保存されているので、手入力で続けるか、もう一度お試しください`);
    } finally {
      setProgress(null);
      abort.current = null;
    }
  };

  const toggle = (n: number) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(n)) next.delete(n);
    else next.add(n);
    return next;
  });

  return (
    <div className="space-y-3 rounded-2xl border border-navy-200 bg-white p-4 dark:border-navy-700 dark:bg-navy-900" data-testid="process-panel" data-ocr-ready={ocrReady === null ? 'checking' : ocrReady ? 'yes' : 'no'}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-semibold">書類を解析する</p>
          <p className="text-xs text-slate-500">
            {kind === 'pdf' ? `PDF ${pageCount}ページ。文字が埋め込まれたページはそのまま読み取り、画像のページだけOCRします` : '画像の文字をOCRで読み取ります（端末内で処理）'}
          </p>
        </div>
        {!progress && (
          <button type="button" onClick={onClose} className="-mr-1 -mt-1 flex size-10 items-center justify-center rounded-lg text-slate-400" aria-label="解析を閉じる">
            <X className="size-5" />
          </button>
        )}
      </div>
      {kind === 'pdf' && pageCount > 1 && !progress && (
        <div>
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="font-semibold">解析するページ（{selected.size} / {pageCount}）</span>
            <button type="button" className="min-h-9 px-2 font-semibold text-navy-600 dark:text-navy-300" onClick={() => setSelected(selected.size === pageCount ? new Set([1]) : new Set(Array.from({ length: pageCount }, (_, i) => i + 1)))}>
              {selected.size === pageCount ? '1ページ目だけ' : 'すべて選択'}
            </button>
          </div>
          <PageThumbs file={file} count={pageCount} selected={selected} onToggle={toggle} />
        </div>
      )}
      {ocrReady === false && (needsOcr || !progress) && <OcrSetupCard onReady={() => setOcrReady(true)} onBusyChange={setPreparing} />}
      {progress ? (
        <div role="status" aria-live="polite" data-testid="process-progress">
          <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-navy-800">
            <div className="h-full rounded-full bg-navy-600 transition-all" style={{ width: `${Math.max(4, Math.round(progress.overall * 100))}%` }} />
          </div>
          <div className="mt-1 flex items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-300">
            <span>
              {progress.pageCount > 1 && `${Math.min(progress.pageIndex + 1, progress.pageCount)}/${progress.pageCount}ページ：`}
              {progress.message}
            </span>
            <Button size="sm" variant="secondary" onClick={() => abort.current?.abort()} data-testid="process-cancel">
              キャンセル
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button icon={doc.pages.length ? RotateCcw : Play} onClick={start} disabled={selected.size === 0 || preparing || (needsOcr && !ocrReady)} data-testid="process-start">
            {doc.pages.length ? '再解析する' : '解析を開始'}
          </Button>
          <Button variant="ghost" icon={Keyboard} onClick={onClose}>
            手入力で続ける
          </Button>
        </div>
      )}
      {error && (
        <p className="flex items-start gap-1.5 rounded-lg bg-red-50 p-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300" role="alert" data-testid="process-error">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {error}
        </p>
      )}
      {result && (
        <p className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200" role="status">
          {result}
        </p>
      )}
    </div>
  );
}
