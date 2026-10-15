/**
 * ダッシュボード上部の「対応が必要なこと」。
 * 機能ごとの未処理件数 (ナビのバッジと同じ数字) と、最も急ぐ通知を表示し、押すと対象へ移動する。
 */
import { Bell, ChevronRight } from 'lucide-react';
import { useAppData } from '../app/AppData';
import { NOTICE_MODULE_HREF, NOTICE_MODULE_LABEL, navNoticeSummary, type NoticeModule } from '../domain/notifications';
import { NavCountBadge, NoticeRow } from '../ui/notices';
import { Card, CardHeader } from '../ui/primitives';

const MODULES: NoticeModule[] = ['tasks', 'helpdesk', 'inventory', 'documents', 'automation', 'onboarding'];

export function NoticeSummaryCard() {
  const { notices } = useAppData();
  const open = notices.filter((n) => n.actionable);
  const top = open.slice(0, 3);
  return (
    <Card className="mb-4" data-testid="notice-summary">
      <CardHeader
        title={open.length ? `対応が必要なこと ${open.length}件` : '対応が必要なことはありません'}
        icon={Bell}
        description="期限超過 → 承認待ち → 未処理 → 注意 の順に表示。押すと対象へ移動します"
        action={
          <a href="#/notifications" className="inline-flex min-h-9 items-center py-1 text-xs font-semibold text-navy-600 dark:text-navy-300">
            通知センター
          </a>
        }
      />
      {open.length > 0 && (
        <div className="px-2 pb-3 sm:px-3">
          <div className="mb-1 flex gap-1.5 overflow-x-auto px-2 pb-1" data-no-swipe>
            {MODULES.map((m) => {
              const sm = navNoticeSummary(notices, m);
              if (!sm.count) return null;
              return (
                <a key={m} href={NOTICE_MODULE_HREF[m]} className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 dark:border-navy-700 dark:bg-navy-900 dark:text-slate-200" data-testid={`summary-module-${m}`}>
                  {NOTICE_MODULE_LABEL[m]}
                  <NavCountBadge count={sm.count} worst={sm.worst} label={`${NOTICE_MODULE_LABEL[m]} 未処理 ${sm.count}件`} />
                  <ChevronRight className="size-3.5 text-slate-300" aria-hidden />
                </a>
              );
            })}
          </div>
          <ul className="divide-y divide-slate-100 dark:divide-navy-800">
            {top.map((n) => (
              <NoticeRow key={n.id} notice={n} compact />
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
