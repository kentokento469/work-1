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

/** 送信などで下書きを消した直後のキー。次に入力が変わるまで、画面を離れるときの保存で下書きを戻さない */
const clearedKeys = new Set<string>();

export function clearDraft(key: string): void {
  clearedKeys.add(key);
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
    clearedKeys.delete(key);
    const d = readDraft<T>(key);
    if (d && !isEmpty(d)) {
      onRestore(d);
      setRestored(true);
    } else setRestored(false);
    // key が変わった時だけ読み込む
  }, [key]);

  // 入力のたびに保存すると重いので少し待ってから保存する。待つ間に画面を離れた・タブを閉じた場合も失わないよう、
  // 画面を離れるとき (アンマウント)・ページが隠れるとき (pagehide。Safari でタブを閉じる・アプリを切り替える) にすぐ保存する (Phase 10)
  const latest = useRef({ key, value, isEmpty });
  latest.current = { key, value, isEmpty };
  const save = useCallback(() => {
    const { key: k, value: v, isEmpty: empty } = latest.current;
    if (!k || loaded.current !== k || clearedKeys.has(k)) return;
    try {
      const json = JSON.stringify(v);
      if (empty(v) || detectSecrets(json).length) localStorage.removeItem(DRAFT_PREFIX + k);
      else localStorage.setItem(DRAFT_PREFIX + k, json);
    } catch {
      /* 容量超過・プライベートモード等 */
    }
  }, []);
  const pending = useRef(false);
  const lastValue = useRef<T | null>(null);
  useEffect(() => {
    if (!key || loaded.current !== key) return;
    // 消した後に入力が変わったら、また保存する (最初の実行・同じ値では解除しない)
    if (lastValue.current !== null && lastValue.current !== value) clearedKeys.delete(key);
    lastValue.current = value;
    pending.current = true;
    const t = setTimeout(() => {
      pending.current = false;
      save();
    }, 400);
    return () => clearTimeout(t);
  }, [key, value, isEmpty, save]);
  useEffect(() => {
    const flush = () => {
      if (!pending.current) return;
      pending.current = false;
      save();
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [save]);

  const discard = useCallback(() => {
    // 破棄した後に、待っていた保存で下書きが戻らないようにする (続けて入力した内容は保存する)
    pending.current = false;
    if (key) clearDraft(key);
    setRestored(false);
  }, [key]);

  return { restored, discard, dismissNotice: () => setRestored(false) };
}
