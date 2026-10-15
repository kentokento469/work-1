/** スマホ用メニュー (下部ナビに入りきらない画面への入口) */
import { Bell, BookOpen, ChevronRight, Database, FileText, Settings, Sparkles, UserPlus, Users, type LucideIcon } from 'lucide-react';
import { useAppData } from '../app/AppData';
import { DemoNotice } from '../app/Layout';
import { DEMO_COMPANY_NAME } from '../demo/demoData';
import { Card, PageHeader } from '../ui/primitives';
import { NOTICE_KIND_LABEL, navNoticeSummary, type NoticeModule } from '../domain/notifications';
import { AttentionSection, NavCountBadge } from '../ui/notices';

const MENU_MODULES: NoticeModule[] = ['documents', 'automation', 'onboarding'];

export function MenuPage() {
  const { stats, data, proposals, notices, unreadCount } = useAppData();
  const toReview = data.documents.filter((d) => !d.deletedAt && d.status === 'needs_review').length;
  const items: { key: string; href: string; label: string; desc: string; icon: LucideIcon }[] = [
    { key: 'notifications', href: '#/notifications', label: '通知センター', desc: `未処理 ${notices.filter((n) => n.actionable).length}件・未読 ${unreadCount}件・すべての通知と履歴`, icon: Bell },
    { key: 'documents', href: '#/documents', label: '書類管理', desc: `確認待ち ${toReview}件・請求書/領収書/納品書の取り込み・OCR`, icon: FileText },
    { key: 'automation', href: '#/automation', label: '自動化センター', desc: `承認待ちの提案 ${proposals.length}件・実行条件と処理履歴`, icon: Sparkles },
    { key: 'employees', href: '#/employees', label: '社員管理', desc: `登録 ${data.employees.length}名・貸与機器・問い合わせ`, icon: Users },
    { key: 'onboarding', href: '#/onboarding', label: '入社準備', desc: `入社予定 ${stats.pendingHireCount}名・タスク自動生成とルール設定`, icon: UserPlus },
    { key: 'faq', href: '#/faq', label: 'FAQ', desc: `公開 ${data.faqs.filter((f) => f.enabled).length}件・解決手順の検索と管理`, icon: BookOpen },
    { key: 'data', href: '#/data', label: 'データ管理', desc: 'CSV出力・バックアップ・復元・操作履歴', icon: Database },
    { key: 'settings', href: '#/settings', label: '設定', desc: '問い合わせカテゴリ・部署・表示テーマ', icon: Settings },
  ];
  return (
    <>
      <PageHeader title="メニュー" />
      <AttentionSection modules={MENU_MODULES} title="対応が必要な項目" description="下部ナビ「メニュー」の件数の内訳です（書類・自動化・入社準備）。押すと対象へ移動します" limit={4} testId="menu-attention" />
      <Card className="overflow-hidden">
        <ul className="divide-y divide-slate-100 dark:divide-navy-800">
          {items.map((it) => (
            <li key={it.href} data-menu-item={it.key}>
              <a href={it.href} className="flex min-h-16 items-center gap-3 px-4 py-3 active:bg-slate-50 dark:active:bg-navy-800">
                <span className="flex size-10 items-center justify-center rounded-xl bg-navy-50 text-navy-700 dark:bg-navy-800 dark:text-navy-100">
                  <it.icon className="size-5" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">{it.label}</span>
                  <span className="block truncate text-xs text-slate-500">{it.desc}</span>
                </span>
                {it.key !== 'notifications' &&
                  (() => {
                    const sm = navNoticeSummary(notices, it.key);
                    const parts = (['overdue', 'approval', 'review', 'attention'] as const).map((k) => [k, sm.items.filter((n) => n.kind === k).length] as const).filter(([, c]) => c > 0);
                    return <NavCountBadge count={sm.count} worst={sm.worst} label={`未処理 ${sm.count}件（${parts.map(([k, c]) => `${NOTICE_KIND_LABEL[k]} ${c}`).join('・')}）`} />;
                  })()}
                <ChevronRight className="size-4 text-slate-300" aria-hidden />
              </a>
            </li>
          ))}
        </ul>
      </Card>
      <Card className="mt-4 p-4">
        <p className="mb-1 text-sm font-semibold">{DEMO_COMPANY_NAME}（架空）</p>
        <DemoNotice />
        <p className="mt-2 text-xs text-slate-400">WorkCore Phase 6（通知・ナビゲーション・情報到達性）・今後：承認ワークフロー</p>
      </Card>
    </>
  );
}
