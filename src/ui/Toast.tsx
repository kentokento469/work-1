/**
 * 操作結果の通知。
 * - スマホでは親指が届く下部 (ナビの上) に、PCでは右上に表示
 * - 「元に戻す」などのアクションを1つ付けられる (確認ダイアログの代わりに取り消し可能にする)
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';

type ToastKind = 'success' | 'error' | 'info';
export interface ToastAction {
  label: string;
  onClick: () => void;
}
interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  action?: ToastAction;
}

interface ToastApi {
  success: (message: string, action?: ToastAction) => void;
  error: (message: string) => void;
  info: (message: string, action?: ToastAction) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (kind: ToastKind, message: string, action?: ToastAction) => {
      const id = ++seq.current;
      setItems((xs) => [...xs.slice(-2), { id, kind, message, action }]);
      // 取り消し操作がある通知は読んで判断する時間を長めに取る
      setTimeout(() => dismiss(id), action ? 8000 : kind === 'error' ? 6000 : 3500);
    },
    [dismiss],
  );
  const api = useMemo<ToastApi>(
    () => ({ success: (m, a) => push('success', m, a), error: (m) => push('error', m), info: (m, a) => push('info', m, a) }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-[60] flex flex-col items-center gap-2 px-4 lg:bottom-auto lg:top-4 lg:items-end lg:pr-6"
        aria-live="polite"
      >
        {items.map((t) => (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            className={`pointer-events-auto flex w-full max-w-md animate-toast-in items-center gap-3 rounded-xl border py-2.5 pl-4 pr-2 text-sm shadow-lg backdrop-blur ${
              t.kind === 'success'
                ? 'border-emerald-200 bg-emerald-50/95 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/95 dark:text-emerald-100'
                : t.kind === 'error'
                  ? 'border-red-200 bg-red-50/95 text-red-900 dark:border-red-800 dark:bg-red-950/95 dark:text-red-100'
                  : 'border-slate-200 bg-white/95 text-slate-800 dark:border-navy-700 dark:bg-navy-900/95 dark:text-slate-100'
            }`}
          >
            {t.kind === 'success' ? (
              <CheckCircle2 className="size-4 shrink-0" aria-hidden />
            ) : t.kind === 'error' ? (
              <AlertCircle className="size-4 shrink-0" aria-hidden />
            ) : (
              <Info className="size-4 shrink-0" aria-hidden />
            )}
            <p className="flex-1 py-1 leading-relaxed">{t.message}</p>
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  dismiss(t.id);
                  t.action!.onClick();
                }}
                className="min-h-10 shrink-0 rounded-lg px-3 font-bold underline-offset-2 hover:underline"
              >
                {t.action.label}
              </button>
            )}
            <button type="button" onClick={() => dismiss(t.id)} className="flex size-10 shrink-0 items-center justify-center opacity-60 hover:opacity-100" aria-label="閉じる">
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast は ToastProvider 内で使用してください');
  return ctx;
}
