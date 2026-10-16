/**
 * 通知・リンクから移動した先で、対象の項目を見つけやすくする共通の仕組み。
 *
 * 遷移先の URL に `focus=<対象ID>` を付け、画面側は対象の要素に `data-focus-id` を付けておく。
 * - 描画を待って対象までスクロールし (画面外でも見える位置に)、控えめに強調表示する
 * - 強調表示を終えたら URL から focus を外す (戻る操作で再びスクロール・強調されないように)
 * - 一定時間見つからなければ 'missing' を返し、画面側で「削除済み・対象外」の案内を出す
 */
import { useEffect, useRef, useState } from 'react';

export type FocusStatus = 'none' | 'pending' | 'found' | 'missing';

export function focusSelector(id: string): string {
  return `[data-focus-id="${CSS.escape(id)}"]`;
}

/** URL のハッシュから focus パラメータだけを取り除く (履歴は増やさない) */
export function clearFocusParam(): void {
  const [path = '#/', query = ''] = window.location.hash.split('?');
  const q = new URLSearchParams(query);
  if (!q.has('focus')) return;
  q.delete('focus');
  const qs = q.toString();
  history.replaceState(history.state, '', `${window.location.pathname}${window.location.search}${path}${qs ? `?${qs}` : ''}`);
}

/**
 * focusId の要素が現れたらスクロールして強調表示する。
 * ready が false の間は待つ (フィルターの調整・データの読み込み中など)
 */
export function useFocusHighlight(focusId: string | null, ready = true, timeoutMs = 2000): FocusStatus {
  const [status, setStatus] = useState<FocusStatus>(focusId ? 'pending' : 'none');
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!focusId) {
      setStatus('none');
      return;
    }
    if (!ready || handled.current === focusId) return;
    setStatus('pending');
    let cancelled = false;
    const started = performance.now();
    const tick = () => {
      if (cancelled) return;
      const el = document.querySelector<HTMLElement>(focusSelector(focusId));
      if (el) {
        handled.current = focusId;
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
        el.classList.remove('wc-focus');
        void el.offsetWidth; // 同じ要素への連続した強調でもアニメーションをやり直す
        el.classList.add('wc-focus');
        window.setTimeout(() => el.classList.remove('wc-focus'), 2600);
        setStatus('found');
        clearFocusParam();
        return;
      }
      if (performance.now() - started > timeoutMs) {
        handled.current = focusId;
        setStatus('missing');
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return () => {
      cancelled = true;
    };
  }, [focusId, ready, timeoutMs]);
  return status;
}

/** 現在の URL の focus パラメータ (画面内のハッシュ変更にも追従) */
export function useFocusParam(): string | null {
  const read = () => new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('focus');
  const [v, setV] = useState(read);
  useEffect(() => {
    const on = () => {
      const next = read();
      // focus を外した (強調表示の後始末) だけの変更では値を保つ
      if (next) setV(next);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return v;
}
