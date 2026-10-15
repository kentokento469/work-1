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

// スクロール位置はアプリ側で画面ごとに復元する。ブラウザの自動復元と二重に動くと、
// 戻る操作の直後に位置が上書きされることがあるため無効にする
if (typeof history !== 'undefined' && 'scrollRestoration' in history) history.scrollRestoration = 'manual';

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    let currentPath = parseHash(window.location.hash).path;
    const onScroll = () => scrollPositions.set(currentPath, window.scrollY);
    const onChange = () => {
      const next = parseHash(window.location.hash);
      const samePage = next.path === currentPath;
      // 画面を離れる時点の位置も記録する (scroll イベントの発火が遅れても位置を失わない)
      if (!samePage) scrollPositions.set(currentPath, window.scrollY);
      currentPath = next.path;
      setRoute(next);
      if (samePage) return; // タブ切替などクエリだけの変更ではスクロールしない
      const saved = scrollPositions.get(next.path) ?? 0;
      // 先頭に戻すだけなら描画を待たずにその場で行う (待つ間に始まった操作を後から上書きしない)
      if (saved <= 0) {
        window.scrollTo({ top: 0 });
        return;
      }
      // 描画後に復元する。遅延読み込みやデータ再取得で高さが足りない間だけ待ち (最大2秒)、
      // 届く高さになったら1回だけスクロールして終える。利用者が先に操作したら復元しない (操作を奪わない)
      const started = performance.now();
      let cancelled = false;
      const cancel = () => (cancelled = true);
      const opts = { once: true, passive: true } as const;
      window.addEventListener('wheel', cancel, opts);
      window.addEventListener('touchstart', cancel, opts);
      window.addEventListener('keydown', cancel, opts);
      const done = () => {
        window.removeEventListener('wheel', cancel);
        window.removeEventListener('touchstart', cancel);
        window.removeEventListener('keydown', cancel);
      };
      const restore = () => {
        if (cancelled || currentPath !== next.path) return done();
        const reachable = document.documentElement.scrollHeight - window.innerHeight >= saved - 1;
        if (reachable || performance.now() - started > 2000) {
          window.scrollTo({ top: saved });
          return done();
        }
        requestAnimationFrame(restore);
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
