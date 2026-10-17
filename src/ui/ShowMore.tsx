/**
 * 長い一覧を少しずつ表示する (Phase 12・性能)。数千件を一度に描画すると表示・入力が遅くなるため、
 * 最初は pageSize 件だけ描画し、「さらに表示」で追加する。絞り込み・検索が変わったら先頭から表示し直す。
 * 通知などから特定の項目へ移動する場合 (mustInclude) は、その項目まで表示する。
 */
import { useEffect, useMemo, useState } from 'react';
import { Button } from './primitives';

export const PAGE_SIZE = 100;

export function usePaged<T>(list: T[], resetKey: string, opts: { pageSize?: number; mustInclude?: (item: T) => boolean } = {}) {
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const [limit, setLimit] = useState(pageSize);
  useEffect(() => setLimit(pageSize), [resetKey, pageSize]);
  const must = opts.mustInclude;
  const required = useMemo(() => (must ? list.findIndex(must) + 1 : 0), [list, must]);
  const shown = Math.max(limit, required);
  return {
    visible: list.length > shown ? list.slice(0, shown) : list,
    remaining: Math.max(0, list.length - shown),
    more: () => setLimit(shown + pageSize),
    all: () => setLimit(list.length),
  };
}

export function ShowMore({ remaining, onMore, onAll, testId = 'show-more' }: { remaining: number; onMore: () => void; onAll?: () => void; testId?: string }) {
  if (remaining <= 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 border-t border-slate-100 p-3 dark:border-navy-800">
      <Button variant="secondary" onClick={onMore} data-testid={testId}>
        さらに表示（残り{remaining.toLocaleString()}件）
      </Button>
      {onAll && remaining > PAGE_SIZE && (
        <Button variant="ghost" onClick={onAll}>
          すべて表示
        </Button>
      )}
    </div>
  );
}
