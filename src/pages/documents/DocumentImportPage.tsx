/**
 * 書類の取り込み。カメラ・写真・ファイル(PDF/画像)・手入力の4つの入口を1画面に並べる。
 * 選んだファイルはその場で端末に保存し (OCR の途中で失敗しても原本は残る)、すぐに解析・確認画面へ進む。
 */
import { useRef, useState, type ChangeEvent } from 'react';
import { ArrowLeft, Camera, FileUp, Images, Keyboard, Loader2 } from 'lucide-react';
import { useAppData } from '../../app/AppData';
import { navigate } from '../../app/router';
import { sha256Hex } from '../../domain/documents/hash';
import { DOCUMENT_TYPES, DOCUMENT_TYPE_LABEL, type DocumentRecord, type DocumentType } from '../../domain/documents/types';
import { generateId } from '../../domain/id';
import { formatBytes, storageEstimate } from '../../features/documents/engine/assets';
import { decodeImage, fileKind, openPdf, releaseCanvas } from '../../features/documents/engine/media';
import { OcrSetupCard } from '../../features/documents/parts';
import { MAX_FILE_BYTES } from '../../services/documentService';
import { ConfirmDialog } from '../../ui/Modal';
import { Card, cx, PageHeader, SelectField } from '../../ui/primitives';

interface Pending {
  name: string;
  mime: string;
  data: ArrayBuffer;
  hash: string;
  pageCount: number;
  duplicate: DocumentRecord;
  notice: string | null;
}

export function DocumentImportPage({ query }: { query: URLSearchParams }) {
  const { data, run } = useAppData();
  const relations = { employeeId: query.get('employee'), inquiryId: query.get('inquiry'), purchaseOrderId: query.get('po') };
  const [type, setType] = useState<DocumentType | 'auto'>((query.get('type') as DocumentType) || 'auto');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const requestId = useRef(generateId('req'));
  const relEmployee = relations.employeeId ? data.employees.find((e) => e.id === relations.employeeId) : null;
  const relInquiry = relations.inquiryId ? data.inquiries.find((i) => i.id === relations.inquiryId) : null;
  const relPo = relations.purchaseOrderId ? data.purchaseOrders.find((p) => p.id === relations.purchaseOrderId) : null;

  const save = async (f: { name: string; mime: string; data: ArrayBuffer; hash: string; pageCount: number } | null, notice: string | null) => {
    setBusy('保存しています');
    try {
      const r = await run(
        (s) => s.documents.create({ type: type === 'auto' ? 'other' : type, file: f, ...relations, requestId: requestId.current }),
        // ファイルの場合は次の解析パネルが結果を示すので、通知は注意事項があるときだけ出す (通知の重なりを避ける)
        f ? (notice ? `「${f.name}」を取り込みました（${notice}）` : undefined) : '手入力で書類を作成しました',
      );
      requestId.current = generateId('req');
      if (r.duplicated) return;
      navigate(`/documents/${r.value.id}${f ? `?process=1${type === 'auto' ? '' : '&keepType=1'}` : ''}`);
    } catch {
      /* トースト表示済み */
    } finally {
      setBusy(null);
    }
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 同じファイルを選び直せるように
    if (!file) return;
    setError(null);
    setBusy('ファイルを確認しています');
    try {
      if (file.size > MAX_FILE_BYTES) throw new Error(`ファイルが大きすぎます（${formatBytes(file.size)}）。上限は ${formatBytes(MAX_FILE_BYTES)} です。PDFはページを分けるか、画像は縮小してください`);
      const kind = fileKind(file.name, file.type);
      if (kind === 'unsupported') throw new Error(`対応していない形式です（${file.type || file.name}）。JPEG・PNG・PDF を選んでください`);
      const est = await storageEstimate();
      if (est && est.quota - est.usage < file.size * 3) throw new Error(`端末の保存容量が不足しています（空き 約${formatBytes(Math.max(0, est.quota - est.usage))}）。不要な書類をゴミ箱から完全削除してください`);
      const buf = await file.arrayBuffer();
      let pageCount = 1;
      let notice: string | null = null;
      if (kind === 'pdf') {
        try {
          const pdf = await openPdf(buf);
          pageCount = pdf.numPages;
          await pdf.destroy();
        } catch {
          throw new Error('PDFを開けませんでした。破損しているか、パスワードで保護されている可能性があります');
        }
      } else {
        // HEIC などはブラウザが読めるか実際に確かめる (読めなくても原本は保存し、手入力で続けられる)
        const c = await decodeImage(buf, file.type, 64);
        if (!c) notice = kind === 'heic' ? 'このブラウザでは HEIC を読み取れないため、OCRは使えません。項目は手入力してください' : '画像を読み込めないため、OCRは使えません';
        releaseCanvas(c);
      }
      const hash = await sha256Hex(buf);
      const f = { name: file.name || `capture-${Date.now()}.jpg`, mime: file.type || (kind === 'pdf' ? 'application/pdf' : 'image/jpeg'), data: buf, hash, pageCount };
      const dup = data.documents.find((d) => !d.deletedAt && d.file?.hash === hash);
      if (dup) {
        setPending({ ...f, duplicate: dup, notice });
        return;
      }
      await save(f, notice);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ファイルを読み込めませんでした');
    } finally {
      setBusy(null);
    }
  };

  const entries = [
    { key: 'camera', label: 'カメラで撮影', desc: '紙の書類をその場で撮影', icon: Camera, accept: 'image/*', capture: 'environment' as const },
    { key: 'library', label: '写真から選ぶ', desc: '撮影済みの写真・スクリーンショット', icon: Images, accept: 'image/*' },
    { key: 'file', label: 'ファイルを選ぶ', desc: 'PDF・画像（ファイルAppなど）', icon: FileUp, accept: 'application/pdf,.pdf,image/jpeg,image/png,image/heic,image/heif,.heic,.heif' },
  ];

  return (
    <>
      <a href="#/documents" className="mb-2 inline-flex min-h-10 items-center gap-1 text-sm text-slate-500">
        <ArrowLeft className="size-4" aria-hidden />
        書類一覧
      </a>
      <PageHeader title="書類を取り込む" description="取り込んだ書類は端末内で解析し、確認・修正してから保存します" />
      {(relEmployee || relInquiry || relPo) && (
        <p className="mb-3 rounded-lg bg-navy-50 px-3 py-2 text-sm dark:bg-navy-900" data-testid="import-relation">
          関連付け：{[relEmployee && `社員 ${relEmployee.name}`, relInquiry && `問い合わせ ${relInquiry.number}`, relPo && `発注書 ${relPo.number}`].filter(Boolean).join('・')}
        </p>
      )}
      <Card className="p-4">
        <SelectField
          label="書類の種類"
          value={type}
          onChange={(e) => setType(e.target.value as DocumentType | 'auto')}
          options={[{ value: 'auto', label: '自動で判定する' }, ...DOCUMENT_TYPES.map((t) => ({ value: t, label: DOCUMENT_TYPE_LABEL[t] }))]}
          hint="自動判定は「請求書」「領収書」などの表記から行います。あとで変更できます"
        />
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {entries.map((en) => (
            <label
              key={en.key}
              className={cx(
                'relative flex min-h-28 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-2xl border border-slate-200 bg-white p-3 text-center active:bg-slate-50 dark:border-navy-700 dark:bg-navy-900 dark:active:bg-navy-800',
                en.key === 'camera' && 'border-navy-300 bg-navy-50/60 dark:border-navy-600',
                busy && 'pointer-events-none opacity-60',
              )}
            >
              <en.icon className="size-7 text-navy-700 dark:text-navy-200" aria-hidden />
              <span className="text-sm font-semibold">{en.label}</span>
              <span className="text-[11px] leading-tight text-slate-500">{en.desc}</span>
              <input type="file" accept={en.accept} capture={en.capture} onChange={onFile} className="sr-only" data-testid={`import-${en.key}`} disabled={!!busy} />
            </label>
          ))}
          <button
            type="button"
            onClick={() => save(null, null)}
            disabled={!!busy || type === 'auto'}
            className="flex min-h-28 flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed border-slate-300 p-3 text-center active:bg-slate-50 disabled:opacity-50 dark:border-navy-700"
            data-testid="import-manual"
          >
            <Keyboard className="size-7 text-slate-500" aria-hidden />
            <span className="text-sm font-semibold">手入力</span>
            <span className="text-[11px] leading-tight text-slate-500">{type === 'auto' ? '先に書類の種類を選んでください' : '原本なしで項目を入力'}</span>
          </button>
        </div>
        {busy && (
          <p className="mt-3 flex items-center gap-2 text-sm text-slate-600" role="status">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {busy}…
          </p>
        )}
        {error && (
          <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300" role="alert" data-testid="import-error">
            {error}
          </p>
        )}
        <ul className="mt-4 space-y-1 text-xs text-slate-500">
          <li>・対応形式：JPEG・PNG・PDF（複数ページ可）。iPhoneの HEIC は、ブラウザが対応している場合のみ読み取れます（読めない場合は手入力）。</li>
          <li>・1ファイル {formatBytes(MAX_FILE_BYTES)} まで。撮影は書類全体が明るく、まっすぐ写るようにすると読み取り精度が上がります。</li>
          <li>・ファイルは端末内（このブラウザ）にのみ保存されます。外部には送信しません。</li>
        </ul>
      </Card>
      <div className="mt-4">
        <OcrSetupCard />
      </div>
      <ConfirmDialog
        open={!!pending}
        title="同じファイルが既に登録されています"
        message={
          pending && (
            <span>
              {pending.duplicate.number}（{DOCUMENT_TYPE_LABEL[pending.duplicate.type]}・{pending.duplicate.fields.issuer || '発行元未入力'}）と内容が完全に一致します。二重登録の可能性があります。
              <a className="ml-1 font-semibold underline" href={`#/documents/${pending.duplicate.id}`}>
                既存の書類を開く
              </a>
            </span>
          )
        }
        confirmLabel="それでも登録する"
        onConfirm={() => {
          const p = pending!;
          setPending(null);
          void save(p, p.notice);
        }}
        onClose={() => setPending(null)}
      />
    </>
  );
}
