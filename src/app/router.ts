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
  // モーダルを閉じたときの「履歴を1つ戻す」処理が終わる前に移動すると、戻る処理で移動が取り消されるため待つ
  if (selfBack) {
    afterSelfBack.push(() => navigate(to));
    return;
  }
  const target = to.startsWith('#') ? to : `#${to}`;
  if (window.location.hash === target) return;
  // モーダルを開いた履歴の上から画面移動する場合 (保存後に詳細へ移る等) は、その履歴を置き換える。
  // 「戻る」でモーダルの残骸に戻らず、1回で元の画面へ戻れるようにする
  if (isModalEntry(history.state)) {
    replacing = true;
    window.location.replace(`${window.location.pathname}${window.location.search}${target}`);
    return;
  }
  window.location.hash = target;
}

/* ------------------------------------------------------------------
 * 履歴の位置管理
 * ハッシュ遷移ごとにブラウザ履歴が1つ積まれる。各履歴に通し番号 (wcIdx) を記録し、
 * 番号 → 画面のパスを sessionStorage に残すことで、
 *  - 「アプリ内に戻れる画面があるか」(canGoBack) … アプリ外へ戻らないための判定
 *  - 「直前の画面はどこか」(previousPath) … 戻るリンクで history.back() を使えるかの判定
 * ができる。ブラウザの戻る/進む・Safari のスワイプ・独自スワイプはすべて同じ履歴を使うため、互いに矛盾しない。
 * ------------------------------------------------------------------ */
interface EntryState {
  wcIdx?: number;
  wcModal?: string;
}
const PATHS_KEY = 'workcore-history-paths';
let currentIdx = 0;
let replacing = false;
/** モーダルを閉じたためにアプリ自身が history.back() を呼び、まだ完了していない */
let selfBack = false;
/** その間に移動された先 (戻る処理がその移動を取り消すため、戻り終えてから移動し直す) */
let lostHash: string | null = null;
let afterSelfBack: (() => void)[] = [];
let paths: string[] = [];

function isModalEntry(state: unknown): boolean {
  return !!state && typeof (state as EntryState).wcModal === 'string';
}
function readPaths(): string[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(PATHS_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
function savePaths() {
  try {
    sessionStorage.setItem(PATHS_KEY, JSON.stringify(paths.slice(-200)));
  } catch {
    // 保存できない環境では「戻れる画面なし」として扱うだけ
  }
}
function stamp(state: EntryState) {
  history.replaceState({ ...(history.state as object | null), ...state }, '');
}

/** モーダルが開いている間の履歴。閉じる順 (新しいものが末尾) */
interface ModalEntry {
  id: string;
  idx: number;
  /** ブラウザの戻る・スワイプで閉じようとしたとき。false を返すと閉じない (未保存の確認中) */
  onHistoryBack: () => boolean;
}
const modalStack: ModalEntry[] = [];

function syncHistory() {
  const state = history.state as EntryState | null;
  const prevIdx = currentIdx;
  if (typeof state?.wcIdx === 'number') {
    currentIdx = state.wcIdx;
    if (selfBack && currentIdx < prevIdx) {
      selfBack = false;
      if (lostHash) {
        const target = lostHash;
        lostHash = null;
        afterSelfBack = [];
        navigate(target);
        return;
      }
      const queued = afterSelfBack;
      afterSelfBack = [];
      queued.forEach((fn) => fn());
    }
  } else {
    if (selfBack) lostHash = window.location.hash;
    // 新しい履歴 (リンク・navigate)。置き換えのときは番号を引き継ぐ
    currentIdx = replacing ? currentIdx : currentIdx + 1;
    stamp({ wcIdx: currentIdx });
    paths = paths.slice(0, currentIdx);
    paths[currentIdx] = parseHash(window.location.hash).path;
    savePaths();
  }
  replacing = false;
  // 戻る操作でモーダルの履歴より前に戻った → 上のモーダルから閉じる
  for (let top = modalStack.at(-1); top && top.idx > currentIdx; top = modalStack.at(-1)) {
    if (!top.onHistoryBack()) {
      // 未保存の変更がある: 閉じずに履歴を積み直して確認を表示する
      history.pushState({ wcIdx: top.idx, wcModal: top.id } satisfies EntryState, '');
      currentIdx = top.idx;
      return;
    }
    modalStack.pop();
  }
  // 戻った先が、すでに閉じたモーダルの履歴 (モーダル内のリンクで移動した後など) なら1つ飛ばす
  const now = history.state as EntryState | null;
  if (isModalEntry(now) && !modalStack.some((m) => m.id === now?.wcModal) && currentIdx < prevIdx) history.back();
}

if (typeof window !== 'undefined' && typeof history !== 'undefined') {
  paths = readPaths();
  const state = history.state as EntryState | null;
  if (typeof state?.wcIdx === 'number') {
    currentIdx = state.wcIdx;
    // 再読み込み時にモーダルの履歴にいた場合、モーダルは閉じているので印だけ外す
    if (isModalEntry(state)) stamp({ wcModal: undefined });
  } else {
    currentIdx = 0;
    stamp({ wcIdx: 0 });
    paths = [];
  }
  paths[currentIdx] = parseHash(window.location.hash).path;
  savePaths();
  window.addEventListener('popstate', syncHistory);
  window.addEventListener('hashchange', syncHistory);
}

/** アプリ内に戻れる履歴があるか (false ならスワイプで戻らない = アプリ外へ出ない) */
export function canGoBack(): boolean {
  return currentIdx > 0;
}

/** 直前の履歴の画面パス (不明なら null) */
export function previousPath(): string | null {
  return currentIdx > 0 ? (paths[currentIdx - 1] ?? null) : null;
}

/**
 * 「一覧へ戻る」などのリンク用。直前の履歴が戻り先と同じ画面なら history.back() で戻り、
 * 絞り込み条件・スクロール位置をそのまま復元する。そうでなければ通常の画面移動にする。
 * 戻ったかどうかを返す。
 */
export function backTo(href: string): boolean {
  const target = parseHash(href.replace(/^[^#]*/, '')).path;
  if (previousPath() === target) {
    history.back();
    return true;
  }
  navigate(href);
  return false;
}

let modalSeq = 0;
/** 直前に閉じたモーダルの履歴。同じ処理の中で開き直された (StrictMode の再実行・モーダルの切替) 場合は再利用する */
let pendingRelease: { id: string; idx: number; cancelled: boolean } | null = null;

/**
 * モーダルを開いたときに履歴を1つ積む。ブラウザの戻る・スワイプでまずモーダルが閉じる。
 * 返り値の関数はモーダルを画面上の操作で閉じたときに呼び、積んだ履歴を取り除く。
 */
export function pushModalEntry(onHistoryBack: () => boolean): () => void {
  let id: string;
  let idx: number;
  const reuse = pendingRelease && (history.state as EntryState | null)?.wcModal === pendingRelease.id ? pendingRelease : null;
  if (reuse) {
    reuse.cancelled = true;
    pendingRelease = null;
    ({ id, idx } = reuse);
  } else {
    id = `m${++modalSeq}`;
    idx = currentIdx + 1;
    history.pushState({ wcIdx: idx, wcModal: id } satisfies EntryState, '');
    currentIdx = idx;
    paths = paths.slice(0, idx);
    paths[idx] = parseHash(window.location.hash).path;
  }
  modalStack.push({ id, idx, onHistoryBack });
  return () => {
    const i = modalStack.findIndex((m) => m.id === id);
    if (i < 0) return; // 戻る操作ですでに閉じた
    modalStack.splice(i, 1);
    // まだその履歴の上にいるなら1つ戻して取り除く (画面移動で置き換え済みなら何もしない)
    if ((history.state as EntryState | null)?.wcModal !== id) return;
    const release = { id, idx, cancelled: false };
    pendingRelease = release;
    queueMicrotask(() => {
      if (release.cancelled) return;
      if (pendingRelease === release) pendingRelease = null;
      if ((history.state as EntryState | null)?.wcModal !== id) return;
      selfBack = true;
      history.back();
      // popstate が届かない環境でも移動を止めたままにしない
      window.setTimeout(() => {
        if (!selfBack) return;
        selfBack = false;
        lostHash = null;
        const queued = afterSelfBack;
        afterSelfBack = [];
        queued.forEach((fn) => fn());
      }, 1000);
    });
  };
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
      // 対象を指定した遷移 (focus=) は、対象までのスクロールを画面側が行うので位置を復元しない
      const saved = next.query.has('focus') ? 0 : (scrollPositions.get(next.path) ?? 0);
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
