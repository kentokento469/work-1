import { useCallback, useEffect, useState } from 'react';

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

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(readMode);
  useEffect(() => {
    apply(mode);
    try {
      localStorage.setItem(KEY, mode);
    } catch {
      /* 保存できなくても表示には影響しない */
    }
    if (mode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [mode]);
  const cycle = useCallback(() => setMode((m) => (m === 'light' ? 'dark' : m === 'dark' ? 'system' : 'light')), []);
  return { mode, setMode, cycle };
}
