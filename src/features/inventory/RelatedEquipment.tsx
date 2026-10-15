/**
 * 他モジュールの詳細画面に埋め込む「関連機器」(双方向の参照)。
 * - 社員詳細: 貸与中・予約中の資産、在庫の予約、この社員に関する自動化の提案
 * - 問い合わせ詳細: 申請者の機器、この問い合わせで動いた資産、代替機の提案
 */
import { Laptop, Sparkles } from 'lucide-react';
import { useAppData } from '../../app/AppData';
import { RESERVATION_STATUS_LABEL } from '../../domain/inventory/types';
import { Badge, Card, CardHeader } from '../../ui/primitives';
import { AssetStatusBadge, ProposalCard } from './parts';

export function EmployeeEquipmentCard({ employeeId }: { employeeId: string }) {
  const { data, proposals } = useAppData();
  const assets = data.assets.filter((a) => a.assigneeId === employeeId && (a.status === 'in_use' || a.status === 'reserved'));
  const reservations = data.reservations.filter((r) => r.employeeId === employeeId && (r.status === 'active' || r.status === 'backorder'));
  const mine = proposals.filter((p) => p.employeeId === employeeId && !p.inquiryId);
  const itemById = new Map(data.items.map((i) => [i.id, i]));
  if (!assets.length && !reservations.length && !mine.length && !data.items.length) return null;
  return (
    <Card className="mt-4" data-testid="employee-equipment">
      <CardHeader title="貸与機器・予約" icon={Laptop} description={`資産 ${assets.length}台・在庫の予約 ${reservations.length}件`} />
      <div className="space-y-3 p-4 sm:p-5">
        {mine.map((p) => (
          <ProposalCard key={p.key} proposal={p} compact />
        ))}
        {assets.length === 0 && reservations.length === 0 ? (
          <p className="text-sm text-slate-500">貸与中・予約中の機器はありません。</p>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-navy-800">
            {assets.map((a) => (
              <li key={a.id}>
                <a href={`#/inventory/assets/${a.id}`} className="flex min-h-12 items-center gap-2 py-2">
                  <span className="font-mono text-xs font-semibold">{a.assetNumber}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">{a.name}</span>
                  <AssetStatusBadge status={a.status} />
                </a>
              </li>
            ))}
            {reservations.map((r) => (
              <li key={r.id}>
                <a href={`#/inventory/items/${r.itemId}`} className="flex min-h-12 items-center gap-2 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {itemById.get(r.itemId)?.name} × {r.quantity}
                  </span>
                  <Badge tone={r.status === 'backorder' ? 'violet' : 'blue'}>{RESERVATION_STATUS_LABEL[r.status]}</Badge>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

export function InquiryEquipmentCard({ inquiryId, requesterId }: { inquiryId: string; requesterId: string | null }) {
  const { data, proposals } = useAppData();
  const related = new Set(data.assetEvents.filter((e) => e.inquiryId === inquiryId).map((e) => e.assetId));
  const assets = data.assets.filter((a) => related.has(a.id) || (requesterId && a.assigneeId === requesterId && (a.status === 'in_use' || a.status === 'reserved')));
  const mine = proposals.filter((p) => p.inquiryId === inquiryId);
  if (!assets.length && !mine.length) return null;
  return (
    <Card className="mt-4" data-testid="inquiry-equipment">
      <CardHeader title="関連機器" icon={Laptop} description="申請者の貸与機器と、この問い合わせで動いた資産" />
      <div className="space-y-3 p-4 sm:p-5">
        {mine.map((p) => (
          <div key={p.key}>
            <p className="mb-1 flex items-center gap-1 text-xs font-bold text-navy-700 dark:text-navy-200">
              <Sparkles className="size-3.5" aria-hidden />
              代替機の手配を提案しています
            </p>
            <ProposalCard proposal={p} />
          </div>
        ))}
        <ul className="divide-y divide-slate-100 dark:divide-navy-800">
          {assets.map((a) => (
            <li key={a.id}>
              <a href={`#/inventory/assets/${a.id}`} className="flex min-h-12 items-center gap-2 py-2">
                <span className="font-mono text-xs font-semibold">{a.assetNumber}</span>
                <span className="min-w-0 flex-1 truncate text-sm">
                  {a.name}
                  {a.assigneeName && <span className="text-xs text-slate-500">・{a.assigneeName}</span>}
                </span>
                {related.has(a.id) && <Badge tone="navy">この件で対応</Badge>}
                <AssetStatusBadge status={a.status} />
              </a>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
