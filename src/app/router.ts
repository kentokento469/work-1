import { useEffect, useState } from 'react';

/**
 * ハッシュベースの軽量ルーター。
 * GitHub Pages はサーバー側リライトができないため、#/path 形式で画面遷移する。
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

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => {
      setRoute(parseHash(window.location.hash));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
