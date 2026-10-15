/**
 * 書類一覧: 処理状態のタブ・検索 (本文の抽出テキストも対象)・種類の絞り込み・選択・CSV出力。
 * 確認待ちの書類には「未確認の重要項目」「要確認の項目」の数を表示し、次に何をすべきかを一覧で分かるようにする。
 */
import { useMemo, useState } from 'react';
import { AttentionSection } from '../../ui/notices';
import { CheckSquare, CircleAlert, FileDown, FilePlus2, FileText, Paperclip, Search, Share2, Square, X } from 'lucide-react';
import { useAppData } from '../../app/AppData';
import { canShareFiles, downloadText, shareTextFiles, timestampForFile } from '../../app/download';
import { useQueryState } from '../../app/hooks';
import { documentDate, documentLinesToCsv, documentsToCsv, filterDocumentsForExport } from '../../data/csv';
import { DOCUMENT_TYPES, DOCUMENT_TYPE_LABEL, type DocumentRecord, type DocumentType } from '../../domain/documents/types';
import { DocStatusBadge, DocTypeBadge, yenText } from '../../features/documents/parts';
import { IMPORTANT_FIELDS } from '../../services/documentService';
import { Modal, ModalCancelButton } from '../../ui/Modal';
import { useToast } from '../../ui/Toast';
import { Button, Card, cx, EmptyState, FilterDisclosure, FilterSelect, PageHeader, TextField } from '../../ui/primitives';

type Tab = 'active' | 'needs_review' | 'confirmed' | 'archived' | 'trash';
const TABS: { key: Tab; label: string }[] = [
  { key: 'active', label: 'すべて' },
  { key: 'needs_review', label: '確認待ち' },
  { key: 'confirmed', label: '確認済み' },
  { key: 'archived', label: '保管済み' },
  { key: 'trash', label: 'ゴミ箱' },
];

const inTab = (d: DocumentRecord, t: Tab) => (t === 'trash' ? !!d.deletedAt : !d.deletedAt && (t === 'active' || d.status === t));

export function DocumentsPage() {
  const { data, run } = useAppData();
  const toast = useToast();
  const [f, setF] = useQueryState({ status: 'active', q: '', type: '' });
  const tab = (TABS.some((t) => t.key === f.status) ? f.status : 'active') as Tab;
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);

  // 検索用の文字列は書類が変わったときだけ作る (一覧の再描画のたびに全文を連結しない)
  const hay = useMemo(
    () =>
      new Map(
        data.documents.map((d) => [
          d.id,
          [d.number, d.file?.name, ...Object.values(d.fields), ...d.lines.map((l) => l.name), ...d.pages.map((p) => p.text)].join(' ').normalize('NFKC').toLowerCase(),
        ]),
      ),
    [data.documents],
  );
  const counts = useMemo(() => Object.fromEntries(TABS.map((t) => [t.key, data.documents.filter((d) => inTab(d, t.key)).length])) as Record<Tab, number>, [data.documents]);
  const list = useMemo(() => {
    const kw = f.q.trim().normalize('NFKC').toLowerCase();
    return data.documents
      .filter((d) => inTab(d, tab))
      .filter((d) => !f.type || d.type === f.type)
      .filter((d) => !kw || kw.split(/\s+/).every((w) => hay.get(d.id)!.includes(w)))
      .sort((a, b) => (a.status === 'needs_review' ? 0 : 1) - (b.status === 'needs_review' ? 0 : 1) || b.createdAt.localeCompare(a.createdAt));
  }, [data.documents, tab, f.type, f.q, hay]);

  const toggle = (id: string) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  return (
    <>
      <PageHeader
        title="書類管理"
        description={`確認待ち ${counts.needs_review}件・確認済み ${counts.confirmed}件。請求書・領収書・納品書などを取り込み、読み取った内容を確認して保存します`}
        actions={
          <a href="#/documents/new" className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-navy-800 px-4 text-sm font-semibold text-white shadow-sm dark:bg-navy-500" data-testid="new-document">
            <FilePlus2 className="size-4" aria-hidden />
            取り込む
          </a>
        }
      />
      <AttentionSection modules={['documents']} description="確認待ちの書類です。原本と照合して「確認完了」にすると消えます" testId="documents-attention" />
      <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1" role="tablist" aria-label="処理状態で絞り込み">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setF({ status: t.key })}
            className={cx(
              'inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-semibold',
              tab === t.key ? 'border-navy-800 bg-navy-800 text-white dark:border-navy-400 dark:bg-navy-500' : 'border-slate-200 bg-white text-slate-600 dark:border-navy-700 dark:bg-navy-900 dark:text-slate-300',
            )}
          >
            {t.label}
            <span className={cx('rounded-full px-1.5 text-[11px] tabular-nums', tab === t.key ? 'bg-white/20' : 'bg-slate-100 dark:bg-navy-800')}>{counts[t.key]}</span>
          </button>
        ))}
      </div>
      <Card className="p-3 sm:p-4">
        <div className="grid grid-cols-[1fr_auto] gap-2 md:grid-cols-[1fr_12rem]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
            <input
              type="search"
              value={f.q}
              onChange={(e) => setF({ q: e.target.value })}
              placeholder="発行元・書類番号・品名・本文で検索"
              aria-label="書類を検索"
              className="h-11 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 shadow-sm dark:border-navy-700 dark:bg-navy-950"
            />
          </div>
          <FilterDisclosure activeCount={f.type ? 1 : 0} className="col-span-2 md:col-span-1">
            <FilterSelect label="書類の種類" value={f.type} onChange={(v) => setF({ type: v })} options={[{ value: '', label: 'すべての種類' }, ...DOCUMENT_TYPES.map((t) => ({ value: t, label: DOCUMENT_TYPE_LABEL[t] }))]} />
          </FilterDisclosure>
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-slate-500">
          <span data-testid="document-count">{list.length}件を表示</span>
          <div className="flex gap-1">
            <button type="button" className="inline-flex min-h-9 items-center gap-1 px-2 font-semibold text-navy-600 dark:text-navy-300" onClick={() => { setSelecting(!selecting); setSelected(new Set()); }} data-testid="toggle-select">
              {selecting ? <X className="size-3.5" aria-hidden /> : <CheckSquare className="size-3.5" aria-hidden />}
              {selecting ? '選択をやめる' : '選択'}
            </button>
            <button type="button" className="inline-flex min-h-9 items-center gap-1 px-2 font-semibold text-navy-600 dark:text-navy-300" onClick={() => setExporting(true)} data-testid="open-export">
              <FileDown className="size-3.5" aria-hidden />
              CSV出力
            </button>
          </div>
        </div>
      </Card>

      {list.length === 0 ? (
        <Card className="mt-3">
          <EmptyState
            icon={FileText}
            title={data.documents.length === 0 ? 'まだ書類がありません' : '該当する書類はありません'}
            description={data.documents.length === 0 ? '請求書や領収書を撮影・選択すると、日付・金額・発行元などを読み取って候補を表示します' : '条件を変更してください'}
            action={data.documents.length === 0 ? <Button icon={FilePlus2} onClick={() => (window.location.hash = '#/documents/new')}>書類を取り込む</Button> : undefined}
          />
        </Card>
      ) : (
        <ul className="mt-3 space-y-2" data-testid="document-list">
          {list.map((d) => {
            const unconfirmed = d.status === 'needs_review' ? IMPORTANT_FIELDS.filter((k) => !d.reviewed.includes(k)).length : 0;
            const low = Object.values(d.extracted).filter((x) => x && x.certainty === 'low').length;
            const on = selected.has(d.id);
            return (
              <li key={d.id} className={cx('flex items-stretch rounded-2xl border bg-white dark:bg-navy-900', on ? 'border-navy-500' : 'border-slate-200/80 dark:border-navy-800')} data-doc-number={d.number}>
                {selecting && (
                  <button type="button" onClick={() => toggle(d.id)} aria-pressed={on} aria-label={`${d.number}を選択`} className="flex w-12 shrink-0 items-center justify-center">
                    {on ? <CheckSquare className="size-5 text-navy-700 dark:text-navy-200" /> : <Square className="size-5 text-slate-400" />}
                  </button>
                )}
                <a href={`#/documents/${d.id}`} className="block min-w-0 flex-1 p-3.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[11px] text-slate-400">{d.number}</span>
                    <DocTypeBadge type={d.type} />
                    <DocStatusBadge doc={d} />
                    {d.file && <Paperclip className="size-3.5 text-slate-400" aria-label="原本あり" />}
                    {d.inventory && <span className="text-[11px] text-emerald-700 dark:text-emerald-400">在庫反映済み</span>}
                  </div>
                  <div className="mt-1 flex items-baseline justify-between gap-2">
                    <p className="min-w-0 truncate font-semibold">{d.fields.issuer || d.fields.title || d.fields.applicant || d.file?.name || '（未入力）'}</p>
                    <p className="shrink-0 font-bold tabular-nums">{yenText(d.fields.total)}</p>
                  </div>
                  <p className="text-xs text-slate-500">
                    {documentDate(d)}
                    {d.fields.docNumber && `・No.${d.fields.docNumber}`}
                    {d.lines.length > 0 && `・明細${d.lines.length}行`}
                  </p>
                  {(unconfirmed > 0 || low > 0) && (
                    <p className="mt-1 flex items-center gap-1 text-xs font-semibold text-amber-700 dark:text-amber-400">
                      <CircleAlert className="size-3.5" aria-hidden />
                      {[unconfirmed && `未確認の重要項目 ${unconfirmed}件`, low && `要確認 ${low}件`].filter(Boolean).join('・')}
                    </p>
                  )}
                </a>
              </li>
            );
          })}
        </ul>
      )}
      {selecting && (
        <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-20 mt-3 flex items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white/95 p-3 shadow-lg backdrop-blur lg:bottom-4 dark:border-navy-700 dark:bg-navy-900/95">
          <span className="text-sm">{selected.size}件を選択中</span>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setSelected(selected.size === list.length ? new Set() : new Set(list.map((d) => d.id)))}>
              {selected.size === list.length ? '選択解除' : 'すべて選択'}
            </Button>
            <Button size="sm" icon={FileDown} disabled={!selected.size} onClick={() => setExporting(true)} data-testid="export-selected">
              CSV出力
            </Button>
            {tab !== 'trash' && (
              <Button
                size="sm"
                variant="danger"
                disabled={!selected.size}
                onClick={async () => {
                  const ids = [...selected];
                  await run(async (s) => { for (const id of ids) await s.documents.trash(id); }, `${ids.length}件をゴミ箱へ移しました`, { undo: () => async (s) => { for (const id of ids) await s.documents.restoreFromTrash(id); } }).catch(() => undefined);
                  setSelected(new Set());
                }}
              >
                ゴミ箱へ
              </Button>
            )}
          </div>
        </div>
      )}
      <ExportModal
        open={exporting}
        onClose={() => setExporting(false)}
        visible={list}
        selectedIds={selecting && selected.size ? [...selected] : []}
        onDone={async (msg) => {
          await run((s) => s.recordExport(msg)).catch(() => undefined);
          toast.success(msg);
        }}
      />
    </>
  );
}

function ExportModal({ open, onClose, visible, selectedIds, onDone }: { open: boolean; onClose: () => void; visible: DocumentRecord[]; selectedIds: string[]; onDone: (msg: string) => void }) {
  const { data } = useAppData();
  const [scope, setScope] = useState<'visible' | 'selected' | 'all' | 'range'>('visible');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [types, setTypes] = useState<DocumentType[]>([]);
  const [withLines, setWithLines] = useState(true);
  const effectiveScope = scope === 'selected' && !selectedIds.length ? 'visible' : scope;
  const docs = useMemo(() => {
    if (effectiveScope === 'visible') return filterDocumentsForExport(visible, { includeDeleted: true });
    if (effectiveScope === 'selected') return filterDocumentsForExport(data.documents, { ids: selectedIds, includeDeleted: true });
    if (effectiveScope === 'all') return filterDocumentsForExport(data.documents, {});
    return filterDocumentsForExport(data.documents, { from: from || undefined, to: to || undefined, types });
  }, [effectiveScope, visible, selectedIds, data.documents, from, to, types]);
  const lineCount = docs.reduce((a, d) => a + d.lines.length, 0);
  const files = () => {
    const ts = timestampForFile();
    const out = [{ name: `workcore_documents_${ts}.csv`, content: documentsToCsv(docs, data), mime: 'text/csv;charset=utf-8' }];
    if (withLines && lineCount) out.push({ name: `workcore_document_lines_${ts}.csv`, content: documentLinesToCsv(docs, data.items), mime: 'text/csv;charset=utf-8' });
    return out;
  };
  const msg = `書類CSV（${docs.length}件${withLines && lineCount ? `・明細${lineCount}行` : ''}）を出力しました`;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="書類をCSVで出力"
      description="Excelで開けるUTF-8（BOM付き）のCSVです"
      footer={
        <>
          <ModalCancelButton />
          {canShareFiles() && (
            <Button
              variant="secondary"
              icon={Share2}
              disabled={!docs.length}
              onClick={async () => {
                if (await shareTextFiles(files(), '書類CSV')) {
                  onDone(msg);
                  onClose();
                }
              }}
            >
              共有・ファイルに保存
            </Button>
          )}
          <Button icon={FileDown} disabled={!docs.length} onClick={() => { for (const f of files()) downloadText(f.name, f.content, f.mime); onDone(msg); onClose(); }} data-testid="export-download">
            ダウンロード
          </Button>
        </>
      }
    >
      <fieldset className="space-y-1">
        <legend className="mb-1 text-[13px] font-semibold">出力する書類</legend>
        {(
          [
            ['visible', `一覧に表示中の書類（${visible.length}件）`],
            ['selected', selectedIds.length ? `選択した書類（${selectedIds.length}件）` : '選択した書類（一覧で「選択」してください）'],
            ['all', 'すべての書類（ゴミ箱を除く）'],
            ['range', '期間・種類を指定'],
          ] as const
        ).map(([v, label]) => (
          <label key={v} className={cx('flex min-h-11 cursor-pointer items-center gap-2 text-sm', v === 'selected' && !selectedIds.length && 'opacity-50')}>
            <input type="radio" name="export-scope" className="size-5 accent-navy-700" checked={effectiveScope === v} disabled={v === 'selected' && !selectedIds.length} onChange={() => setScope(v)} data-testid={`export-scope-${v}`} />
            {label}
          </label>
        ))}
      </fieldset>
      {effectiveScope === 'range' && (
        <div className="mt-2 space-y-2 rounded-xl bg-slate-50 p-3 dark:bg-navy-950">
          <div className="grid grid-cols-2 gap-2">
            <TextField label="発行日（から）" type="date" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="export-from" />
            <TextField label="発行日（まで）" type="date" value={to} onChange={(e) => setTo(e.target.value)} data-testid="export-to" />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {DOCUMENT_TYPES.map((t) => {
              const on = types.includes(t);
              return (
                <button key={t} type="button" aria-pressed={on} onClick={() => setTypes((x) => (on ? x.filter((y) => y !== t) : [...x, t]))} className={cx('min-h-9 rounded-full border px-3 text-xs font-semibold', on ? 'border-navy-700 bg-navy-700 text-white' : 'border-slate-300 bg-white dark:border-navy-700 dark:bg-navy-900')}>
                  {DOCUMENT_TYPE_LABEL[t]}
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-slate-500">発行日がない書類は登録日で判定します。種類を選ばなければすべての種類。</p>
        </div>
      )}
      <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" className="size-5 accent-navy-700" checked={withLines} onChange={(e) => setWithLines(e.target.checked)} data-testid="export-with-lines" />
        明細行も別ファイルで出力（{lineCount}行）
      </label>
      <p className="mt-2 text-sm font-semibold" data-testid="export-count">
        出力件数：{docs.length}件
      </p>
      <p className="mt-1 text-[11px] text-slate-500">日付は YYYY-MM-DD、金額は円の整数で出力します。数式として解釈される文字で始まる値は先頭に「'」を付けて無害化します。</p>
    </Modal>
  );
}
