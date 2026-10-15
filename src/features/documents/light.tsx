/**
 * 書類の軽量な表示部品 (バッジ・関連書類カード)。
 * 社員・問い合わせ・発注書の詳細画面からも使うため、OCR・PDF 関連のコードを含めない
 */
import { FileText, Plus } from 'lucide-react';
import { useAppData } from '../../app/AppData';
import { DOCUMENT_STATUS_LABEL, DOCUMENT_TYPE_LABEL, type DocumentRecord, type DocumentStatus } from '../../domain/documents/types';
import { Badge, Card, CardHeader, type Tone } from '../../ui/primitives';

export const yenText = (v: string | undefined) => (v && /^\d+$/.test(v) ? `¥${Number(v).toLocaleString()}` : '—');

const STATUS_TONE: Record<DocumentStatus, Tone> = { needs_review: 'amber', confirmed: 'green', archived: 'gray' };
export function DocStatusBadge({ doc }: { doc: Pick<DocumentRecord, 'status' | 'deletedAt'> }) {
  if (doc.deletedAt) return <Badge tone="red">ゴミ箱</Badge>;
  return <Badge tone={STATUS_TONE[doc.status]}>{DOCUMENT_STATUS_LABEL[doc.status]}</Badge>;
}
export function DocTypeBadge({ type }: { type: DocumentRecord['type'] }) {
  return <Badge tone="navy">{DOCUMENT_TYPE_LABEL[type]}</Badge>;
}
/** 社員・問い合わせ・発注書の詳細に表示する「関連書類」 */
export function RelatedDocumentsCard({ filter, newHref, title = '関連書類' }: { filter: (d: DocumentRecord) => boolean; newHref: string; title?: string }) {
  const { data } = useAppData();
  const docs = data.documents.filter((d) => !d.deletedAt && filter(d));
  return (
    <Card className="mt-4" data-testid="related-documents">
      <CardHeader
        title={title}
        icon={FileText}
        description={`${docs.length}件`}
        action={
          <a href={newHref} className="inline-flex min-h-9 items-center gap-1 py-1 text-xs font-semibold text-navy-600 dark:text-navy-300">
            <Plus className="size-3.5" aria-hidden />
            書類を追加
          </a>
        }
      />
      {docs.length === 0 ? (
        <p className="px-5 pb-4 pt-1 text-sm text-slate-500">関連付けられた書類はありません。</p>
      ) : (
        <ul className="divide-y divide-slate-100 px-4 pb-2 sm:px-5 dark:divide-navy-800">
          {docs.map((d) => (
            <li key={d.id}>
              <a href={`#/documents/${d.id}`} className="flex min-h-12 items-center gap-2 py-2">
                <DocTypeBadge type={d.type} />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {d.fields.issuer || d.fields.title || d.number}
                  <span className="ml-1 text-xs text-slate-500">{d.fields.issueDate ?? ''}</span>
                </span>
                <span className="text-sm tabular-nums">{yenText(d.fields.total)}</span>
                <DocStatusBadge doc={d} />
              </a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

