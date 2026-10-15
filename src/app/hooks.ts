/**
 * 画面横断で使う状態保持フック。
 * - useQueryState: 検索条件を URL (#/path?q=...) に保存し、詳細から戻っても条件を保持する
 * - useDraft: 入力途中の内容を端末に一時保存し、誤って閉じても復元できるようにする
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { detectSecrets } from '../domain/helpdesk/secrets';

/**
 * 検索・フィルター条件を URL のクエリと同期する。
 * history.replaceState を使うため履歴は増えず、ブラウザの「戻る」で一覧に戻ると条件が復元される。
 */
export function useQueryState<T extends Record<string, string>>(defaults: T): [T, (patch: Partial<T>) => void, () => void] {
  const read = (): T => {
    const q = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
    const out = { ...defaults };
    for (const k of Object.keys(defaults) as (keyof T)[]) {
      const v = q.get(k as string);
      if (v !== null) out[k] = v as T[keyof T];
    }
    return out;
  };
  const [state, setState] = useState<T>(read);

  // 同じ画面内のリンク (例: 分析カード → 一覧の絞り込み) で URL が変わった場合も追従する
  useEffect(() => {
    const onHash = () => setState(read());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
    // read は defaults にのみ依存し、defaults は固定値
  }, []);

  // URL の書き換えは state の更新処理の外で即座に行う (同時に届いた hashchange が古い URL を読んで上書きしないように)
  const stateRef = useRef(state);
  stateRef.current = state;
  const update = useCallback(
    (patch: Partial<T>) => {
      const next = { ...stateRef.current, ...patch };
      stateRef.current = next;
      const [path = '#/', query = ''] = window.location.hash.split('?');
      const q = new URLSearchParams(query);
      for (const [k, v] of Object.entries(next)) {
        if (v === '' || v === defaults[k]) q.delete(k);
        else q.set(k, v);
      }
      const qs = q.toString();
      history.replaceState(history.state, '', `${window.location.pathname}${window.location.search}${path}${qs ? `?${qs}` : ''}`);
      setState(next);
    },
    // defaults はレンダーごとに新しいオブジェクトになるが値は固定なので依存に含めない
    [],
  );
  const reset = useCallback(() => update(defaults), [update]);
  return [state, update, reset];
}

const DRAFT_PREFIX = 'workcore-draft:';

function readDraft<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(DRAFT_PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function clearDraft(key: string): void {
  try {
    localStorage.removeItem(DRAFT_PREFIX + key);
  } catch {
    /* 保存できない環境では何もしない */
  }
}

/**
 * 入力途中の下書きを localStorage に保存する。
 * 秘密情報らしき文字列を含む場合は端末にも残さない。
 * @returns restored: 前回の下書きを復元したか
 */
export function useDraft<T extends object>(key: string | null, value: T, isEmpty: (v: T) => boolean, onRestore: (v: T) => void) {
  const [restored, setRestored] = useState(false);
  const loaded = useRef<string | null>(null);

  useEffect(() => {
    if (!key || loaded.current === key) return;
    loaded.current = key;
    const d = readDraft<T>(key);
    if (d && !isEmpty(d)) {
      onRestore(d);
      setRestored(true);
    } else setRestored(false);
    // key が変わった時だけ読み込む
  }, [key]);

  useEffect(() => {
    if (!key || loaded.current !== key) return;
    const t = setTimeout(() => {
      try {
        const json = JSON.stringify(value);
        if (isEmpty(value) || detectSecrets(json).length) localStorage.removeItem(DRAFT_PREFIX + key);
        else localStorage.setItem(DRAFT_PREFIX + key, json);
      } catch {
        /* 容量超過・プライベートモード等 */
      }
    }, 400);
    return () => clearTimeout(t);
  }, [key, value, isEmpty]);

  const discard = useCallback(() => {
    if (key) clearDraft(key);
    setRestored(false);
  }, [key]);

  return { restored, discard, dismissNotice: () => setRestored(false) };
}
