/**
 * 編集の競合 (フォームを開いた後に、別のタブ・画面で同じデータが変更された) の案内。
 * 黙って上書きせず、「最新の内容を読み込む」か「自分の入力で上書きする」かを利用者が選ぶ
 */
import { AlertTriangle } from 'lucide-react';
import { Button } from './primitives';

export function ConflictNotice({ label, onLoadLatest, onOverwrite, busy }: { label: string; onLoadLatest: () => void; onOverwrite: () => void; busy?: boolean }) {
  return (
    <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100" role="alert" data-testid="edit-conflict">
      <p className="flex items-center gap-1.5 font-semibold">
        <AlertTriangle className="size-4 shrink-0" aria-hidden />
        別のタブ・画面でこの{label}が変更されました
      </p>
      <p className="mt-1 text-xs">入力内容はまだ保存していません。最新の内容を読み込んで入力し直すか、この入力内容で上書きするかを選んでください。</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={onLoadLatest} disabled={busy} data-testid="conflict-load-latest">
          最新の内容を読み込む
        </Button>
        <Button variant="secondary" size="sm" onClick={onOverwrite} disabled={busy} data-testid="conflict-overwrite">
          この入力内容で上書き
        </Button>
      </div>
    </div>
  );
}
