/**
 * 書類の詳細: 取り込み → 自動解析 → 確認・修正 → 保存 の流れを1画面で行う。
 * スマホでは「原本」「項目」を切り替え、PCでは左右に並べる。
 */
import { useEffect, useState } from 'react';
import { RelatedTasksCard } from '../../features/tasks/RelatedTasksCard';
import { TargetNotices } from '../../ui/notices';
import { BackLink } from '../../app/BackLink';
import { Archive, Download, FileQuestion, FileText, History, Pencil, RotateCcw, ScanText, Trash2, Undo2 } from 'lucide-react';
import { useAppData } from '../../app/AppData';
import { navigate } from '../../app/router';
import { formatDateTimeJa } from '../../domain/date';
import { EXTRACTION_METHOD_LABEL, type DocumentRecord } from '../../domain/documents/types';
import { formatBytes } from '../../features/documents/engine/assets';
import { InventoryHandoffCard } from '../../features/documents/InventoryHandoff';
import { DocStatusBadge, DocTypeBadge, DocumentPreview, useDocumentFile } from '../../features/documents/parts';
import { ProcessPanel } from '../../features/documents/ProcessPanel';
import { ReviewForm } from '../../features/documents/ReviewForm';
import { ConfirmDialog } from '../../ui/Modal';
import { Button, Card, CardHeader, cx, EmptyState } from '../../ui/primitives';

export function DocumentDetailPage({ id, query }: { id: string; query: URLSearchParams }) {
  const { data, run } = useAppData();
  const doc = data.documents.find((d) => d.id === id);
  if (!doc)
    return (
      <Card>
        <EmptyState icon={FileQuestion} title="書類が見つかりません" description="完全に削除されたか、URLが正しくない可能性があります" action={<Button onClick={() => navigate('/documents')}>書類一覧へ</Button>} />
      </Card>
    );
  return <Detail key={doc.id} doc={doc} autoProcess={query.get('process') === '1' && doc.pages.length === 0} keepType={query.get('keepType') === '1'} run={run} />;
}

function Detail({ doc, autoProcess, keepType, run }: { doc: DocumentRecord; autoProcess: boolean; keepType: boolean; run: ReturnType<typeof useAppData>['run'] }) {
  const { file, loading } = useDocumentFile(doc.file?.fileId);
  const [view, setView] = useState<'original' | 'fields'>(autoProcess ? 'original' : 'fields');
  const [processing, setProcessing] = useState(autoProcess && !!doc.file);
  const [editing, setEditing] = useState(false);
  const [confirmPurge, setConfirmPurge] = useState(false);
  // 保存・確認完了したら編集モードを終える
  useEffect(() => setEditing(false), [doc.updatedAt]);
  // この画面で確認完了にした直後は、次の作業 (次の書類の取り込み・一覧) を案内する (Phase 10)
  const [justConfirmed, setJustConfirmed] = useState(false);
  const [prevStatus, setPrevStatus] = useState(doc.status);
  if (prevStatus !== doc.status) {
    setPrevStatus(doc.status);
    setJustConfirmed(prevStatus === 'needs_review' && doc.status === 'confirmed');
  }
  const readOnly = !!doc.deletedAt || (doc.status !== 'needs_review' && !editing);

  const download = () => {
    if (!file) return;
    const url = URL.createObjectURL(new Blob([file.data], { type: file.mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const original = (
    <Card className="p-3 sm:p-4" data-testid="original-panel">
      {doc.file ? (
        loading ? (
          <p className="p-6 text-center text-sm text-slate-500">原本を読み込み中…</p>
        ) : file ? (
          <DocumentPreview file={file} initialPage={doc.file.selectedPages[0] ?? 1} highlightPages={doc.file.selectedPages} />
        ) : (
          <p className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200" role="alert">
            元ファイルがこの端末にありません（元ファイルを含まないバックアップから復元した場合など）。抽出結果は残っています。
          </p>
        )
      ) : (
        <p className="p-4 text-sm text-slate-500">手入力で登録した書類のため、原本はありません。</p>
      )}
      {doc.file && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span className="min-w-0 truncate">
            {doc.file.name}・{formatBytes(doc.file.size)}
            {doc.file.pageCount > 1 && `・${doc.file.pageCount}ページ`}
          </span>
          {file && (
            <button type="button" onClick={download} className="inline-flex min-h-9 items-center gap-1 font-semibold text-navy-600 dark:text-navy-300">
              <Download className="size-3.5" aria-hidden />
              原本を保存
            </button>
          )}
        </div>
      )}
      {doc.pages.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="flex min-h-10 cursor-pointer items-center font-semibold">抽出元のテキスト（{EXTRACTION_METHOD_LABEL[doc.method]}）</summary>
          {doc.pages.map((p) => (
            <div key={p.page} className="mt-2">
              <p className="text-xs text-slate-500">
                {p.page}ページ目・{p.method === 'ocr' ? `OCR（平均の文字認識 ${p.ocrConfidence}%）` : p.method === 'pdf_text' ? 'PDFのテキスト' : '読み取れず'}
              </p>
              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-50 p-2 text-xs dark:bg-navy-950" data-testid={`source-text-${p.page}`}>
                {p.text || '（文字なし）'}
              </pre>
            </div>
          ))}
        </details>
      )}
    </Card>
  );

  return (
    <>
      <BackLink href="#/documents">書類一覧</BackLink>
      <TargetNotices targetId={doc.id} />
      {justConfirmed && (
        <Card className="mb-4 border-emerald-200 bg-emerald-50/60 p-4 dark:border-emerald-900 dark:bg-emerald-950/30" data-testid="document-next-step">
          <p className="text-sm font-semibold text-emerald-900 dark:text-emerald-100" role="status">
            確認が完了しました（{doc.number}）
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => navigate('/documents/new')} data-testid="document-next-import">
              次の書類を取り込む
            </Button>
            <Button size="sm" variant="secondary" onClick={() => navigate('/documents')}>
              書類一覧へ
            </Button>
          </div>
        </Card>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="font-mono text-lg font-bold" data-testid="doc-number">
          {doc.number}
        </h1>
        <DocTypeBadge type={doc.type} />
        <DocStatusBadge doc={doc} />
        <span className="text-xs text-slate-500">{EXTRACTION_METHOD_LABEL[doc.method]}</span>
      </div>
      <p className="-mt-2 mb-3 truncate text-sm text-slate-600 dark:text-slate-300">
        {[doc.fields.issuer, doc.fields.issueDate, doc.fields.total && `¥${Number(doc.fields.total).toLocaleString()}`].filter(Boolean).join('・') || '項目は未入力です'}
      </p>

      {doc.deletedAt && (
        <Card className="mb-3 border-red-200 p-3 dark:border-red-900">
          <p className="text-sm">この書類はゴミ箱にあります（{formatDateTimeJa(doc.deletedAt)}）。</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" icon={Undo2} onClick={() => run((s) => s.documents.restoreFromTrash(doc.id), '元に戻しました').catch(() => undefined)} data-testid="restore-document">
              元に戻す
            </Button>
            <Button size="sm" variant="danger" icon={Trash2} onClick={() => setConfirmPurge(true)} disabled={!!doc.inventory}>
              完全に削除
            </Button>
          </div>
          {doc.inventory && <p className="mt-1 text-xs text-slate-500">在庫に反映した書類は、入出庫履歴の根拠のため完全削除できません。</p>}
        </Card>
      )}

      {processing && file && !doc.deletedAt && (
        <div className="mb-3">
          <ProcessPanel doc={doc} file={file} keepType={keepType} onClose={() => { setProcessing(false); setView('fields'); }} />
        </div>
      )}

      {/* スマホ: 原本 / 項目 の切り替え */}
      <div className="mb-3 grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1 lg:hidden dark:bg-navy-900" role="tablist" aria-label="表示の切り替え">
        {(['original', 'fields'] as const).map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            onClick={() => setView(v)}
            className={cx('min-h-11 rounded-lg text-sm font-semibold', view === v ? 'bg-white text-navy-900 shadow-sm dark:bg-navy-700 dark:text-white' : 'text-slate-500')}
            data-testid={`view-${v}`}
          >
            {v === 'original' ? '原本' : '項目'}
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        <div className={cx(view !== 'original' && 'hidden lg:block', 'lg:sticky lg:top-4')}>{original}</div>
        <div className={cx(view !== 'fields' && 'hidden lg:block', 'space-y-4')}>
          {!doc.deletedAt && (
            <div className="flex flex-wrap gap-2">
              {doc.status === 'needs_review' && doc.file && file && !processing && (
                <Button size="sm" variant="secondary" icon={ScanText} onClick={() => { setProcessing(true); setView('original'); window.scrollTo({ top: 0 }); }} data-testid="reprocess">
                  {doc.pages.length ? '再解析' : '解析する'}
                </Button>
              )}
              {doc.status !== 'needs_review' && !editing && (
                <Button size="sm" variant="secondary" icon={Pencil} onClick={() => setEditing(true)} data-testid="edit-document">
                  修正する
                </Button>
              )}
              {doc.status === 'confirmed' && (
                <Button size="sm" variant="ghost" icon={Archive} onClick={() => run((s) => s.documents.setStatus(doc.id, 'archived'), '保管済みにしました', { undo: (r) => (s) => s.documents.setStatus(doc.id, r.previousStatus) }).catch(() => undefined)}>
                  保管済みにする
                </Button>
              )}
              {doc.status === 'archived' && (
                <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => run((s) => s.documents.setStatus(doc.id, 'confirmed'), '確認済みに戻しました').catch(() => undefined)}>
                  保管を解除
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                icon={Trash2}
                className="text-red-600 dark:text-red-400"
                onClick={() => run((s) => s.documents.trash(doc.id), 'ゴミ箱へ移しました', { undo: () => (s) => s.documents.restoreFromTrash(doc.id), undoMessage: '元に戻しました' }).catch(() => undefined)}
                data-testid="trash-document"
              >
                ゴミ箱へ
              </Button>
            </div>
          )}
          {editing && doc.status !== 'needs_review' && (
            <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">修正内容を保存すると「確認待ち」に戻ります。「確認完了」で再び確認済みになります。</p>
          )}
          <Card className="p-3 sm:p-4">
            <ReviewForm key={`${doc.updatedAt}|${readOnly}`} doc={doc} readOnly={readOnly} />
          </Card>
          <InventoryHandoffCard key={doc.updatedAt} doc={doc} />
          <Card>
            <CardHeader title="処理履歴" icon={History} />
            <ol className="space-y-2 px-4 pb-4 pt-1 text-sm sm:px-5" data-testid="doc-history">
              {[...doc.history].reverse().map((h, i) => (
                <li key={i}>
                  {h.message}
                  <span className="block text-[11px] text-slate-400">{formatDateTimeJa(h.at)}</span>
                </li>
              ))}
            </ol>
          </Card>
          <p className="flex items-center gap-1 text-[11px] text-slate-400">
            <FileText className="size-3" aria-hidden />
            登録 {formatDateTimeJa(doc.createdAt)}・更新 {formatDateTimeJa(doc.updatedAt)}
          </p>
        </div>
      </div>
      <ConfirmDialog
        open={confirmPurge}
        title="書類を完全に削除しますか？"
        message={`${doc.number} と元ファイルを端末から削除します。この操作は元に戻せません。`}
        confirmLabel="完全に削除する"
        danger
        onConfirm={async () => {
          await run((s) => s.documents.purge(doc.id), '書類を完全に削除しました');
          navigate('/documents?status=trash');
        }}
        onClose={() => setConfirmPurge(false)}
      />
      {!doc.deletedAt && <RelatedTasksCard link={{ kind: 'document', id: doc.id }} suggestedTitle={`${doc.number} の対応`} defaults={{ employeeId: doc.employeeId ?? null }} description="確認・修正・提出準備・支払いなど、この書類に関する作業をタスクにできます" />}
    </>
  );
}
