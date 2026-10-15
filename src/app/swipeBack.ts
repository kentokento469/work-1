/**
 * 画面左端からのスワイプで「戻る」。
 *
 * Safari のタブで開いている場合は、iOS 標準のスワイプ戻り (ブラウザの履歴を戻る) がそのまま使えるため何もしない。
 * 二重に動くと2画面戻ってしまうので、標準のスワイプが無い「ホーム画面に追加」した単独起動のときだけ有効にする。
 *
 * - 左端 24px 以内から始まり、横方向に十分動いたときだけ戻る (縦スクロール・タップとは区別する)
 * - 入力欄・横スクロールする表・[data-no-swipe] の上では反応しない (グラフ・タブ・表の横スクロールと競合しない)
 * - 戻る先はブラウザ履歴そのもの (history.back) のため、絞り込み条件・スクロール位置・ブラウザの戻る/進むと一致する
 * - アプリ内に戻る画面が無いときは戻らない (アプリ外へ出ない)。モーダルが開いていれば先にモーダルが閉じる
 * - 戻る処理中は次のスワイプを受け付けない (二重遷移の防止)
 */
import { useEffect } from 'react';
import { canGoBack } from './router';

const EDGE = 24;
const LOCK_DISTANCE = 10;

declare global {
  interface Window {
    /** テスト用: 単独起動でなくても独自スワイプを有効にする */
    __wcForceSwipeBack?: boolean;
  }
  interface Navigator {
    standalone?: boolean;
  }
}

export function isStandalone(): boolean {
  return (
    window.__wcForceSwipeBack === true ||
    navigator.standalone === true ||
    (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches)
  );
}

/** 横スクロールできる要素・スワイプ除外指定の中から始まったか */
function blocked(target: EventTarget | null): boolean {
  for (let el = target instanceof Element ? target : null; el && el !== document.body; el = el.parentElement) {
    if (el.matches('input, textarea, select, [contenteditable="true"], [data-no-swipe], [role="slider"]')) return true;
    if (el.scrollWidth > el.clientWidth + 1) {
      const ox = getComputedStyle(el).overflowX;
      if ((ox === 'auto' || ox === 'scroll') && el.scrollLeft > 0) return true;
    }
  }
  return false;
}

export function useEdgeSwipeBack(): void {
  useEffect(() => {
    let start: { x: number; y: number; t: number } | null = null;
    let locked: 'h' | 'v' | null = null;
    let dx = 0;
    let navigating = false;
    let indicator: HTMLDivElement | null = null;

    const surface = () => document.querySelector<HTMLElement>('[data-swipe-surface]');
    const showIndicator = (progress: number) => {
      if (!indicator) {
        indicator = document.createElement('div');
        indicator.setAttribute('data-testid', 'swipe-back-indicator');
        indicator.setAttribute('aria-hidden', 'true');
        indicator.style.cssText =
          'position:fixed;left:6px;top:50%;z-index:60;width:36px;height:36px;margin-top:-18px;border-radius:9999px;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.75);color:#fff;font-size:20px;pointer-events:none;transition:opacity .15s';
        indicator.textContent = '‹';
        document.body.appendChild(indicator);
      }
      indicator.style.opacity = String(Math.min(1, progress * 1.5));
      indicator.style.transform = `translateX(${Math.min(progress, 1) * 24}px) scale(${progress >= 1 ? 1.15 : 1})`;
    };
    const reset = (animate: boolean) => {
      const el = surface();
      if (el) {
        el.style.transition = animate ? 'transform .2s ease-out' : '';
        el.style.transform = '';
        if (animate) window.setTimeout(() => (el.style.transition = ''), 220);
      }
      indicator?.remove();
      indicator = null;
    };

    const onStart = (e: TouchEvent) => {
      start = null;
      locked = null;
      dx = 0;
      if (navigating || !isStandalone() || e.touches.length !== 1) return;
      const t = e.touches[0]!;
      if (t.clientX > EDGE || blocked(e.target)) return;
      start = { x: t.clientX, y: t.clientY, t: performance.now() };
    };
    const onMove = (e: TouchEvent) => {
      if (!start || e.touches.length !== 1) return;
      const t = e.touches[0]!;
      const mx = t.clientX - start.x;
      const my = t.clientY - start.y;
      if (!locked) {
        if (Math.abs(mx) < LOCK_DISTANCE && Math.abs(my) < LOCK_DISTANCE) return;
        // 縦の動きが大きい・左向きならスクロールとして扱い、以後は関与しない
        locked = mx > 0 && Math.abs(mx) > Math.abs(my) * 1.2 ? 'h' : 'v';
        if (locked === 'v') {
          start = null;
          return;
        }
      }
      if (e.cancelable) e.preventDefault(); // 横スワイプ中は縦スクロールさせない
      dx = Math.max(0, mx);
      const width = window.innerWidth;
      const el = surface();
      if (el && canGoBack()) el.style.transform = `translateX(${Math.min(dx, width) * 0.35}px)`;
      showIndicator(canGoBack() ? dx / (width * 0.3) : Math.min(dx / (width * 0.3), 0.4));
    };
    const onEnd = () => {
      if (!start || locked !== 'h') {
        start = null;
        return;
      }
      const elapsed = Math.max(1, performance.now() - start.t);
      const width = window.innerWidth;
      const fast = dx > 60 && dx / elapsed > 0.5;
      const go = (dx > width * 0.3 || fast) && canGoBack();
      start = null;
      reset(true);
      if (!go) return;
      navigating = true;
      const done = () => {
        navigating = false;
        window.removeEventListener('popstate', done);
      };
      window.addEventListener('popstate', done);
      window.setTimeout(done, 800); // 念のため (popstate が来ない環境でも操作不能にしない)
      history.back();
    };
    const onCancel = () => {
      start = null;
      reset(true);
    };

    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd, { passive: true });
    document.addEventListener('touchcancel', onCancel, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onCancel);
      reset(false);
    };
  }, []);
}
