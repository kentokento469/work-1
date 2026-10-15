import type { ReactNode } from 'react';
import {
  BookOpen,
  Boxes,
  Sparkles,
  ClipboardList,
  Database,
  Headset,
  Info,
  LayoutDashboard,
  Menu,
  Monitor,
  Moon,
  Settings,
  Sun,
  UserPlus,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useAppData } from './AppData';
import { useTheme } from './theme';
import { cx } from '../ui/primitives';
import { DEMO_COMPANY_NAME } from '../demo/demoData';
import { formatDateJa } from '../domain/date';

interface NavItem {
  key: string;
  href: string;
  label: string;
  icon: LucideIcon;
}

/** PCサイドバー: 日常業務 → 管理 の順に並べる */
export const NAV_ITEMS: NavItem[] = [
  { key: 'dashboard', href: '#/', label: 'ダッシュボード', icon: LayoutDashboard },
  { key: 'helpdesk', href: '#/helpdesk', label: 'ヘルプデスク', icon: Headset },
  { key: 'inventory', href: '#/inventory', label: '在庫・資産・購買', icon: Boxes },
  { key: 'tasks', href: '#/tasks', label: 'タスク管理', icon: ClipboardList },
  { key: 'automation', href: '#/automation', label: '自動化センター', icon: Sparkles },
  { key: 'employees', href: '#/employees', label: '社員管理', icon: Users },
  { key: 'onboarding', href: '#/onboarding', label: '入社準備', icon: UserPlus },
  { key: 'faq', href: '#/faq', label: 'FAQ', icon: BookOpen },
  { key: 'data', href: '#/data', label: 'データ管理', icon: Database },
  { key: 'settings', href: '#/settings', label: '設定', icon: Settings },
];

/** スマホ下部ナビ: 頻度の高い4つ + メニュー (iOS の「その他」タブと同じ考え方) */
const BOTTOM_ITEMS: (NavItem & { short: string; covers?: string[] })[] = [
  { key: 'dashboard', href: '#/', label: 'ダッシュボード', short: 'ホーム', icon: LayoutDashboard },
  { key: 'helpdesk', href: '#/helpdesk', label: 'ヘルプデスク', short: '問い合わせ', icon: Headset },
  { key: 'inventory', href: '#/inventory', label: '在庫・資産・購買', short: '在庫', icon: Boxes },
  { key: 'tasks', href: '#/tasks', label: 'タスク管理', short: 'タスク', icon: ClipboardList },
  { key: 'menu', href: '#/menu', label: 'メニュー', short: 'メニュー', icon: Menu, covers: ['menu', 'employees', 'onboarding', 'faq', 'data', 'settings', 'automation'] },
];

const FUTURE_MODULES = ['請求書・領収書処理', 'ワークフロー（承認経路）'];

function ThemeButton({ className }: { className?: string }) {
  const { mode, cycle } = useTheme();
  const Icon = mode === 'light' ? Sun : mode === 'dark' ? Moon : Monitor;
  const label = mode === 'light' ? 'ライト' : mode === 'dark' ? 'ダーク' : '端末設定';
  return (
    <button
      type="button"
      onClick={cycle}
      className={cx(
        'inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm text-slate-600 transition-colors hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-navy-800',
        className,
      )}
      aria-label={`表示テーマ: ${label}（タップで切替）`}
    >
      <Icon className="size-4" aria-hidden />
      <span className="text-xs">{label}</span>
    </button>
  );
}

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <img src="./favicon.svg" alt="" className="size-8" />
      <div className="leading-tight">
        <p className="text-[15px] font-extrabold tracking-tight text-navy-900 dark:text-white">WorkCore</p>
        <p className="text-[10px] font-medium text-slate-500 dark:text-slate-400">業務管理・自動化</p>
      </div>
    </div>
  );
}

/** デモ環境であることの明示 (本番システムと誤解されないように) */
export function DemoNotice({ compact }: { compact?: boolean }) {
  return (
    <p className={cx('flex items-start gap-1.5 text-slate-500 dark:text-slate-400', compact ? 'text-[10px] leading-snug' : 'text-xs leading-relaxed')}>
      <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
      <span>
        デモ環境：データはこの端末のブラウザにのみ保存されます。複数端末・複数ユーザーでの共有や同時利用、ログイン認証・権限管理、サーバー側でのデータ保護はありません。発注・メール送信・決済は外部に送られません。架空の企業・社員データを使用しています。
      </span>
    </p>
  );
}

export function Layout({ active, children }: { active: string; children: ReactNode }) {
  const { stats, helpdeskStats, inventoryStats, proposals, today } = useAppData();
  const badge = (key: string) =>
    key === 'tasks'
      ? stats.overdueTaskCount
      : key === 'helpdesk'
        ? helpdeskStats.overdueCount + helpdeskStats.newCount
        : key === 'inventory'
          ? inventoryStats.shortageItems
          : key === 'automation' || key === 'menu'
            ? proposals.length
            : 0;
  const badgeLabel = (key: string) =>
    ({ tasks: '期限超過のタスク', helpdesk: '新規・期限超過の問い合わせ', inventory: '在庫不足の品目', automation: '承認待ちの自動化提案', menu: '承認待ちの自動化提案' })[key] ?? '';

  return (
    <div className="min-h-dvh">
      {/* PC: サイドバー */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-slate-200 bg-white lg:flex dark:border-navy-800 dark:bg-navy-900">
        <div className="px-5 py-5">
          <Logo />
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3" aria-label="メインメニュー">
          {NAV_ITEMS.map((item) => {
            const on = item.key === active;
            const n = badge(item.key);
            return (
              <a
                key={item.key}
                href={item.href}
                aria-current={on ? 'page' : undefined}
                className={cx(
                  'flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors',
                  on ? 'bg-navy-50 text-navy-900 dark:bg-navy-800 dark:text-white' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-navy-800/60',
                )}
              >
                <item.icon className={cx('size-[18px]', on ? 'text-navy-700 dark:text-navy-200' : 'text-slate-400')} aria-hidden />
                <span className="flex-1">{item.label}</span>
                {n > 0 && (
                  <span className="rounded-full bg-red-600 px-1.5 text-[11px] font-bold text-white" aria-label={`${badgeLabel(item.key)} ${n}件`}>
                    {n}
                  </span>
                )}
              </a>
            );
          })}
          <div className="pt-4">
            <p className="px-3 pb-1 text-[11px] font-semibold tracking-wider text-slate-400">今後追加予定</p>
            {FUTURE_MODULES.map((m) => (
              <p key={m} className="flex min-h-8 items-center gap-2 px-3 text-[13px] text-slate-400 dark:text-slate-500">
                <span className="size-1.5 rounded-full bg-slate-300 dark:bg-slate-600" aria-hidden />
                {m}
                <span className="ml-auto text-[10px]">準備中</span>
              </p>
            ))}
          </div>
        </nav>
        <div className="space-y-2 border-t border-slate-200 p-4 dark:border-navy-800">
          <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">{DEMO_COMPANY_NAME}（架空）</p>
          <DemoNotice compact />
          <ThemeButton className="-ml-3 w-full" />
        </div>
      </aside>

      {/* スマホ: ヘッダー */}
      <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/90 pt-safe backdrop-blur-md lg:hidden dark:border-navy-800 dark:bg-navy-900/90">
        <div className="flex h-14 items-center justify-between px-4">
          <Logo />
          <ThemeButton className="-mr-2" />
        </div>
      </header>

      <main className="lg:pl-60">
        <div className="mx-auto max-w-6xl px-4 pb-28 pt-5 sm:px-6 lg:px-8 lg:pb-12 lg:pt-8">
          <p className="mb-1 hidden text-xs text-slate-400 lg:block">{formatDateJa(today)}</p>
          {children}
        </div>
      </main>

      {/* スマホ: 下部ナビゲーション */}
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 pb-safe backdrop-blur-md lg:hidden dark:border-navy-800 dark:bg-navy-900/95" aria-label="メインメニュー">
        <div className="grid grid-cols-5">
          {BOTTOM_ITEMS.map((item) => {
            const on = item.key === active || (item.covers?.includes(active) ?? false);
            const n = badge(item.key);
            return (
              <a
                key={item.key}
                href={item.href}
                aria-current={on ? 'page' : undefined}
                className={cx('relative flex min-h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors', on ? 'text-navy-800 dark:text-white' : 'text-slate-500 dark:text-slate-400')}
              >
                {on && <span className="absolute top-0 h-0.5 w-10 rounded-full bg-navy-700 dark:bg-navy-300" aria-hidden />}
                <span className="relative">
                  <item.icon className="size-[22px]" strokeWidth={on ? 2.25 : 1.75} aria-hidden />
                  {n > 0 && (
                    <span className="absolute -right-2.5 -top-1.5 min-w-4 rounded-full bg-red-600 px-1 text-center text-[10px] font-bold leading-4 text-white" aria-label={`${badgeLabel(item.key)} ${n}件`}>
                      {n}
                    </span>
                  )}
                </span>
                {item.short}
              </a>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
