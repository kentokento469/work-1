import { useEffect, useState } from 'react';

/**
 * ハッシュベースの軽量ルーター。
 * GitHub Pages はサーバー側リライトができないため、#/path 形式で画面遷移する。
 * 画面ごとのスクロール位置を覚えておき、一覧へ戻ったときに元の位置へ復元する。
 */
export interface Route {
  path: string;
  segments: string[];
  query: URLSearchParams;
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/';
  const [pathPart = '/', queryPart = ''] = raw.split('?');
  const path = pathPart.startsWith('/') ? pathPart : `/${pathPart}`;
  return { path, segments: path.split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(queryPart) };
}

export function navigate(to: string): void {
  const target = to.startsWith('#') ? to : `#${to}`;
  if (window.location.hash !== target) window.location.hash = target;
}

const scrollPositions = new Map<string, number>();

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    let currentPath = parseHash(window.location.hash).path;
    const onScroll = () => scrollPositions.set(currentPath, window.scrollY);
    const onChange = () => {
      const next = parseHash(window.location.hash);
      const samePage = next.path === currentPath;
      currentPath = next.path;
      setRoute(next);
      if (samePage) return; // タブ切替などクエリだけの変更ではスクロールしない
      const saved = scrollPositions.get(next.path) ?? 0;
      // 描画後に復元する。遅延読み込みやデータ再取得で高さが足りない間は、最大2秒まで再試行する
      const started = performance.now();
      const restore = () => {
        if (currentPath !== next.path) return;
        window.scrollTo({ top: saved });
        if (Math.abs(window.scrollY - saved) > 1 && performance.now() - started < 2000) requestAnimationFrame(restore);
      };
      requestAnimationFrame(() => requestAnimationFrame(restore));
    };
    window.addEventListener('hashchange', onChange);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('hashchange', onChange);
      window.removeEventListener('scroll', onScroll);
    };
  }, []);
  return route;
}
