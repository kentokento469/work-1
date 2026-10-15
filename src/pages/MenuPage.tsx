/** スマホ用メニュー (下部ナビに入りきらない画面への入口) */
import { BookOpen, ChevronRight, Database, Settings, UserPlus, type LucideIcon } from 'lucide-react';
import { useAppData } from '../app/AppData';
import { DemoNotice } from '../app/Layout';
import { DEMO_COMPANY_NAME } from '../demo/demoData';
import { Card, PageHeader } from '../ui/primitives';

export function MenuPage() {
  const { stats, data } = useAppData();
  const items: { href: string; label: string; desc: string; icon: LucideIcon }[] = [
    { href: '#/onboarding', label: '入社準備', desc: `入社予定 ${stats.pendingHireCount}名・タスク自動生成とルール設定`, icon: UserPlus },
    { href: '#/faq', label: 'FAQ', desc: `公開 ${data.faqs.filter((f) => f.enabled).length}件・解決手順の検索と管理`, icon: BookOpen },
    { href: '#/data', label: 'データ管理', desc: 'CSV出力・バックアップ・復元・操作履歴', icon: Database },
    { href: '#/settings', label: '設定', desc: '問い合わせカテゴリ・部署・表示テーマ', icon: Settings },
  ];
  return (
    <>
      <PageHeader title="メニュー" />
      <Card className="overflow-hidden">
        <ul className="divide-y divide-slate-100 dark:divide-navy-800">
          {items.map((it) => (
            <li key={it.href}>
              <a href={it.href} className="flex min-h-16 items-center gap-3 px-4 py-3 active:bg-slate-50 dark:active:bg-navy-800">
                <span className="flex size-10 items-center justify-center rounded-xl bg-navy-50 text-navy-700 dark:bg-navy-800 dark:text-navy-100">
                  <it.icon className="size-5" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">{it.label}</span>
                  <span className="block truncate text-xs text-slate-500">{it.desc}</span>
                </span>
                <ChevronRight className="size-4 text-slate-300" aria-hidden />
              </a>
            </li>
          ))}
        </ul>
      </Card>
      <Card className="mt-4 p-4">
        <p className="mb-1 text-sm font-semibold">{DEMO_COMPANY_NAME}（架空）</p>
        <DemoNotice />
        <p className="mt-2 text-xs text-slate-400">WorkCore Phase 2（ヘルプデスク）・今後：請求書処理／在庫・発注／ワークフロー自動化</p>
      </Card>
    </>
  );
}
