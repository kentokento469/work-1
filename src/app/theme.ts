import { useCallback, useEffect, useSyncExternalStore } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';
const KEY = 'workcore-theme';

function readMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* プライベートモード等では localStorage が使えないことがある */
  }
  return 'system';
}

function apply(mode: ThemeMode) {
  const dark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0b1630' : '#0f1f3d');
}

// 画面のどこから変更しても同じ値になるよう、テーマはモジュール単位で1つだけ持つ
let current: ThemeMode = readMode();
const listeners = new Set<() => void>();
function setTheme(mode: ThemeMode) {
  current = mode;
  apply(mode);
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* 保存できなくても表示には影響しない */
  }
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useTheme() {
  const mode = useSyncExternalStore(subscribe, () => current);
  useEffect(() => {
    if (mode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [mode]);
  const cycle = useCallback(() => setTheme(current === 'light' ? 'dark' : current === 'dark' ? 'system' : 'light'), []);
  return { mode, setMode: setTheme, cycle };
}
