import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { backTo } from './router';
import { cx } from '../ui/primitives';

/**
 * 「一覧へ戻る」リンク。直前の画面が戻り先なら履歴を戻る (= ブラウザの戻る・スワイプと同じ結果) ため、
 * 一覧の検索条件・絞り込み・スクロール位置がそのまま残る。直接開いた場合などは通常のリンクとして移動する。
 */
export function BackLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        backTo(href);
      }}
      className={cx('-ml-2 mb-3 inline-flex min-h-10 items-center gap-1 rounded-lg px-2 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200', className)}
      data-testid="back-link"
    >
      <ArrowLeft className="size-4" aria-hidden />
      {children}
    </a>
  );
}
