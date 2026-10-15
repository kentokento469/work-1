/** 書類管理の画面部品 (原本プレビュー・OCRの準備・保存容量・重複比較)。軽量な部品は light.tsx */
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, CloudDownload, Copy, HardDrive, ScanText, WifiOff } from 'lucide-react';
import { useAppData } from '../../app/AppData';
import { DUPLICATE_LEVEL_LABEL, type DuplicateMatch } from '../../domain/documents/duplicates';
import {
  CERTAINTY_LABEL,
  FIELD_LABEL,
  type Certainty,
  type DocumentFile,
  type DocumentRecord,
  type FieldKey,
} from '../../domain/documents/types';
import { formatDateTimeJa } from '../../domain/date';
import { Badge, Button, cx, type Tone } from '../../ui/primitives';
export { DocStatusBadge, DocTypeBadge, RelatedDocumentsCard, yenText } from './light';
import { Modal } from '../../ui/Modal';
import { downloadOcrAssets, formatBytes, isOcrCached, ocrAssets, storageEstimate } from './engine/assets';
import { fileKind, openPdf, releaseCanvas, type PdfHandle } from './engine/media';

const CERT_TONE: Record<Certainty, Tone> = { high: 'green', medium: 'blue', low: 'amber' };
export function CertaintyBadge({ c }: { c: Certainty }) {
  return <Badge tone={CERT_TONE[c]}>{CERTAINTY_LABEL[c]}</Badge>;
}


/** 元ファイルを読み込む (スナップショットには含めていないため、必要な画面でだけ) */
export function useDocumentFile(fileId: string | null | undefined) {
  const { service } = useAppData();
  const [state, setState] = useState<{ file: DocumentFile | null; loading: boolean }>({ file: null, loading: !!fileId });
  useEffect(() => {
    let alive = true;
    if (!fileId) {
      setState({ file: null, loading: false });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    service.documents
      .getFile(fileId)
      .then((f) => alive && setState({ file: f ?? null, loading: false }))
      .catch(() => alive && setState({ file: null, loading: false }));
    return () => {
      alive = false;
    };
  }, [fileId, service]);
  return state;
}

/** 原本のプレビュー。画像はそのまま、PDF は表示中の1ページだけを描画する */
export function DocumentPreview({ file, initialPage = 1, highlightPages }: { file: DocumentFile; initialPage?: number; highlightPages?: number[] }) {
  const kind = fileKind(file.name, file.mime);
  if (kind === 'pdf') return <PdfPreview file={file} initialPage={initialPage} highlightPages={highlightPages} />;
  return <ImagePreview file={file} />;
}

function ImagePreview({ file }: { file: DocumentFile }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const u = URL.createObjectURL(new Blob([file.data], { type: file.mime }));
    setUrl(u);
    return () => URL.revokeObjectURL(u); // 画面を離れたら解放
  }, [file]);
  if (failed)
    return (
      <p className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200" role="alert">
        このブラウザではこの形式（{file.mime || '不明'}）の画像を表示できません。項目は手入力で登録できます。
      </p>
    );
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" className="block" aria-label="原本を拡大表示（新しいタブ）">
      <img src={url} alt={`原本：${file.name}`} onError={() => setFailed(true)} className="mx-auto max-h-[70dvh] w-auto rounded-lg border border-slate-200 bg-white object-contain dark:border-navy-700" data-testid="doc-preview-image" />
    </a>
  ) : null;
}

function PdfPreview({ file, initialPage, highlightPages }: { file: DocumentFile; initialPage: number; highlightPages?: number[] }) {
  const holder = useRef<HTMLDivElement>(null);
  const pdfRef = useRef<PdfHandle | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(initialPage);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    openPdf(file.data)
      .then((p) => {
        if (!alive) return void p.destroy();
        pdfRef.current = p;
        setNumPages(p.numPages);
      })
      .catch(() => alive && setError('PDFを表示できませんでした（破損・パスワード付きの可能性があります）'));
    return () => {
      alive = false;
      void pdfRef.current?.destroy();
      pdfRef.current = null;
    };
  }, [file]);
  useEffect(() => {
    const p = pdfRef.current;
    const el = holder.current;
    if (!p || !el || !numPages) return;
    let alive = true;
    let canvas: HTMLCanvasElement | null = null;
    const width = Math.max(320, el.clientWidth) * Math.min(2, window.devicePixelRatio || 1);
    p.render(Math.min(page, numPages), Math.min(1800, width * 1.5))
      .then((c) => {
        if (!alive) return releaseCanvas(c);
        canvas = c;
        c.className = 'mx-auto h-auto w-full max-w-full rounded-lg border border-slate-200 bg-white dark:border-navy-700';
        c.setAttribute('role', 'img');
        c.setAttribute('aria-label', `原本 ${page}ページ目`);
        el.replaceChildren(c);
      })
      .catch(() => alive && setError('ページを描画できませんでした'));
    return () => {
      alive = false;
      releaseCanvas(canvas);
    };
  }, [page, numPages]);
  if (error) return <p className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">{error}</p>;
  return (
    <div>
      <div ref={holder} className="min-h-40" data-testid="doc-preview-pdf" />
      {numPages > 1 && (
        <div className="mt-2 flex items-center justify-center gap-3">
          <Button size="sm" variant="secondary" icon={ChevronLeft} disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="前のページ" />
          <span className="text-sm tabular-nums">
            {page} / {numPages}
            {highlightPages?.includes(page) && <span className="ml-1 text-xs text-navy-600 dark:text-navy-300">（解析済み）</span>}
          </span>
          <Button size="sm" variant="secondary" icon={ChevronRight} disabled={page >= numPages} onClick={() => setPage(page + 1)} aria-label="次のページ" />
        </div>
      )}
    </div>
  );
}

/** OCR の準備状態と、初回ダウンロード (明示的な操作でのみ実行) */
export function OcrSetupCard({ onReady, onBusyChange, compact }: { onReady?: () => void; onBusyChange?: (busy: boolean) => void; compact?: boolean }) {
  const [cached, setCached] = useState<boolean | null>(null);
  const [progress, setProgress] = useState<{ label: string; loaded: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const total = ocrAssets().reduce((a, x) => a + x.approxBytes, 0);
  useEffect(() => {
    isOcrCached().then(setCached);
  }, []);
  const start = async () => {
    setError(null);
    setProgress({ label: '開始', loaded: 0, total });
    onBusyChange?.(true);
    try {
      await downloadOcrAssets(setProgress);
      setCached(await isOcrCached());
      onReady?.();
    } catch (e) {
      setError(navigator.onLine === false ? 'オフラインのためダウンロードできません。ネットワークに接続してから再度お試しください' : e instanceof Error ? e.message : 'ダウンロードに失敗しました');
    } finally {
      setProgress(null);
      onBusyChange?.(false);
    }
  };
  if (cached === null) return null;
  if (cached)
    return compact ? null : (
      <p className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400" data-testid="ocr-ready">
        <HardDrive className="size-3.5" aria-hidden />
        OCRの準備済み（この端末に保存済み。オフラインでも画像の読み取りができます）
      </p>
    );
  return (
    <div className="rounded-xl border border-navy-200 bg-navy-50/60 p-3 text-sm dark:border-navy-700 dark:bg-navy-900" data-testid="ocr-setup">
      <p className="flex items-center gap-1.5 font-semibold">
        <ScanText className="size-4" aria-hidden />
        画像の文字読み取り（OCR）の準備
      </p>
      <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
        初回のみ、OCRエンジンと日本語・英語の認識データ（約{formatBytes(total)}）を WorkCore から端末にダウンロードして保存します。書類の画像は端末内で処理し、外部には送信しません。モバイル通信の場合は通信量にご注意ください。
      </p>
      <p className="mt-1 flex items-center gap-1 text-[11px] text-slate-500">
        <WifiOff className="size-3" aria-hidden />
        保存後はオフラインでも利用できます（ブラウザのデータ削除・容量不足時の自動削除で消えた場合は再取得が必要）。PDFに埋め込まれた文字の読み取りには準備は不要です。
      </p>
      {progress ? (
        <div className="mt-2" role="status" aria-live="polite">
          <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-navy-800">
            <div className="h-full rounded-full bg-navy-600 transition-all" style={{ width: `${Math.round((progress.loaded / progress.total) * 100)}%` }} />
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {progress.label}：{formatBytes(progress.loaded)} / 約{formatBytes(progress.total)}
          </p>
        </div>
      ) : (
        <Button className="mt-2" size="sm" icon={CloudDownload} onClick={start} data-testid="ocr-download">
          OCRを準備する（約{formatBytes(total)}）
        </Button>
      )}
      {error && (
        <p className="mt-2 text-xs text-red-700 dark:text-red-300" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** 端末の保存容量 (表示用) */
export function StorageMeter() {
  const [est, setEst] = useState<{ usage: number; quota: number } | null>(null);
  useEffect(() => {
    storageEstimate().then(setEst);
  }, []);
  if (!est) return <p className="text-xs text-slate-500">このブラウザでは保存容量を取得できません。</p>;
  const pct = Math.min(100, Math.round((est.usage / est.quota) * 100));
  return (
    <div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-navy-800">
        <div className={cx('h-full rounded-full', pct > 80 ? 'bg-red-600' : 'bg-navy-600')} style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
      <p className="mt-1 text-xs text-slate-500">
        使用中 {formatBytes(est.usage)} / 上限の目安 {formatBytes(est.quota)}（{pct}%）。上限はブラウザが端末の空き容量から決めます。
      </p>
    </div>
  );
}

const COMPARE_KEYS: FieldKey[] = ['issuer', 'docNumber', 'issueDate', 'total', 'tax', 'registrationNumber', 'recipient'];

/** 重複の可能性の警告と、既存書類との比較 */
export function DuplicateWarning({ doc, matches, onNotDuplicate, onTrash }: { doc: DocumentRecord; matches: DuplicateMatch[]; onNotDuplicate: (otherId: string) => void; onTrash: () => void }) {
  const [compare, setCompare] = useState<DuplicateMatch | null>(null);
  if (!matches.length) return null;
  const top = matches[0]!;
  return (
    <div className={cx('rounded-xl border p-3 text-sm', top.level === 'similar' ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100' : 'border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-100')} role="alert" data-testid="duplicate-warning">
      <p className="flex items-center gap-1.5 font-semibold">
        <Copy className="size-4" aria-hidden />
        {top.level === 'exact' ? '同じファイルが既に登録されています' : top.level === 'likely' ? '同じ書類が既に登録されている可能性があります' : '似ている書類があります'}
      </p>
      <ul className="mt-1 space-y-1">
        {matches.slice(0, 3).map((m) => (
          <li key={m.document.id} className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs">{m.document.number}</span>
            <span className="text-xs">{DUPLICATE_LEVEL_LABEL[m.level]}：{m.reasons.join('・')}</span>
            <Button size="sm" variant="secondary" onClick={() => setCompare(m)} data-testid="compare-duplicate">
              比較する
            </Button>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-[11px] opacity-80">自動では削除・統合しません。比較して判断してください。</p>
      <Modal
        open={!!compare}
        onClose={() => setCompare(null)}
        title="既存の書類と比較"
        size="lg"
        footer={
          compare && (
            <>
              <Button variant="secondary" onClick={() => { onNotDuplicate(compare.document.id); setCompare(null); }} data-testid="not-duplicate">
                別の書類として登録を続ける
              </Button>
              <Button variant="danger" onClick={() => { onTrash(); setCompare(null); }} data-testid="trash-duplicate">
                今回の書類をゴミ箱へ
              </Button>
            </>
          )
        }
      >
        {compare && (
          <div className="space-y-3">
            <p className="flex items-start gap-1.5 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
              {DUPLICATE_LEVEL_LABEL[compare.level]}（{compare.reasons.join('・')}）
            </p>
            <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-navy-700">
              <table className="w-full text-sm" data-testid="compare-table">
                <thead className="bg-slate-50 text-xs text-slate-500 dark:bg-navy-950">
                  <tr>
                    <th className="px-2 py-2 text-left font-semibold">項目</th>
                    <th className="px-2 py-2 text-left font-semibold">今回 {doc.number}</th>
                    <th className="px-2 py-2 text-left font-semibold">
                      既存 <a className="underline" href={`#/documents/${compare.document.id}`}>{compare.document.number}</a>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
                  {COMPARE_KEYS.map((k) => {
                    const a = doc.fields[k] ?? '';
                    const b = compare.document.fields[k] ?? '';
                    return (
                      <tr key={k} className={cx(a && a === b && 'bg-amber-50/70 dark:bg-amber-950/30')}>
                        <th className="px-2 py-1.5 text-left text-xs font-medium text-slate-500">{FIELD_LABEL[k]}</th>
                        <td className="break-all px-2 py-1.5">{a || '—'}</td>
                        <td className="break-all px-2 py-1.5">{b || '—'}</td>
                      </tr>
                    );
                  })}
                  <tr>
                    <th className="px-2 py-1.5 text-left text-xs font-medium text-slate-500">元ファイル</th>
                    <td className="break-all px-2 py-1.5 text-xs">{doc.file?.name ?? 'なし'}</td>
                    <td className="break-all px-2 py-1.5 text-xs">{compare.document.file?.name ?? 'なし'}</td>
                  </tr>
                  <tr>
                    <th className="px-2 py-1.5 text-left text-xs font-medium text-slate-500">登録日時</th>
                    <td className="px-2 py-1.5 text-xs">{formatDateTimeJa(doc.createdAt)}</td>
                    <td className="px-2 py-1.5 text-xs">{formatDateTimeJa(compare.document.createdAt)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-xs text-slate-500">黄色の行は値が一致している項目です。</p>
          </div>
        )}
      </Modal>
    </div>
  );
}
