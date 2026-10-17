import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, X } from 'lucide-react';
import { Button, IconButton } from './primitives';
import { pushModalEntry } from '../app/router';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'md' | 'lg';
  /**
   * 未保存の変更があるか。true の間は背景タップ・Esc・×・キャンセルで即座に閉じず、
   * 「変更を破棄しますか？」を表示する (変更がなければ確認なしで閉じる = 過剰な確認を避ける)
   */
  dirty?: boolean;
}

const ModalCloseContext = createContext<() => void>(() => undefined);

/** フッターの「キャンセル」ボタン。未保存の変更があれば破棄確認を経由する */
export function ModalCancelButton({ children = 'キャンセル', disabled }: { children?: ReactNode; disabled?: boolean }) {
  const requestClose = useContext(ModalCloseContext);
  return (
    <Button variant="secondary" onClick={requestClose} disabled={disabled}>
      {children}
    </Button>
  );
}

/**
 * スマホでは下からのボトムシート、PCでは中央ダイアログとして表示する。
 */
/** 開いているダイアログ (後から開いたものが上) */
const openPanels: HTMLElement[] = [];
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** Tab・Shift+Tab のフォーカスをダイアログの中で循環させる (背面の画面へ移らない。WCAG 2.4.3) */
function trapTab(e: KeyboardEvent, panel: HTMLElement) {
  const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
  if (!items.length) {
    e.preventDefault();
    panel.focus();
    return;
  }
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const active = document.activeElement as HTMLElement | null;
  const inside = !!active && panel.contains(active);
  if (e.shiftKey && (!inside || active === first || active === panel)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (!inside || active === last)) {
    e.preventDefault();
    first.focus();
  }
}

export function Modal({ open, onClose, title, description, children, footer, size = 'md', dirty = false }: ModalProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const state = useRef({ onClose, dirty });
  state.current = { onClose, dirty };

  const requestClose = useCallback(() => {
    if (state.current.dirty) setConfirmDiscard(true);
    else state.current.onClose();
  }, []);

  useEffect(() => {
    if (!open) {
      setConfirmDiscard(false);
      return;
    }
    const prevFocus = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const panel = panelRef.current;
    if (panel) openPanels.push(panel);
    const onKey = (e: KeyboardEvent) => {
      // 重なったダイアログでは、いちばん上のものだけが操作に応える
      if (!panel || openPanels[openPanels.length - 1] !== panel) return;
      if (e.key === 'Escape') requestClose();
      else if (e.key === 'Tab') trapTab(e, panel);
    };
    window.addEventListener('keydown', onKey);
    // ブラウザの戻る・スワイプ戻りでは画面より先にモーダルを閉じる。未保存の変更があれば閉じずに破棄確認を出す
    const releaseHistory = pushModalEntry(() => {
      if (state.current.dirty) {
        setConfirmDiscard(true);
        return false;
      }
      state.current.onClose();
      return true;
    });
    // PCでは最初の入力欄へフォーカス。スマホではキーボードが勝手に開かないようパネル自体へ
    const isTouch = window.matchMedia('(pointer: coarse)').matches;
    const first = panelRef.current?.querySelector<HTMLElement>('input:not([type=checkbox]), select, textarea');
    if (first && !isTouch) first.focus();
    else panelRef.current?.focus();
    return () => {
      const i = panel ? openPanels.lastIndexOf(panel) : -1;
      if (i >= 0) openPanels.splice(i, 1);
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
      releaseHistory();
      prevFocus?.focus?.();
    };
  }, [open, requestClose]);

  if (!open) return null;
  return createPortal(
    <ModalCloseContext.Provider value={requestClose}>
      <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
        <div className="absolute inset-0 animate-fade-in bg-navy-950/50 backdrop-blur-[2px]" onClick={requestClose} aria-hidden data-testid="modal-backdrop" />
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className={`relative flex max-h-[92dvh] w-full animate-slide-up flex-col rounded-t-2xl bg-white shadow-2xl outline-none sm:rounded-2xl dark:bg-navy-900 ${
            size === 'lg' ? 'sm:max-w-3xl' : 'sm:max-w-lg'
          }`}
        >
          <div className="flex items-start gap-3 border-b border-slate-200 px-5 py-3.5 dark:border-navy-800">
            <div className="min-w-0 flex-1 pt-1.5">
              <h2 id={titleId} className="text-base font-bold text-slate-900 dark:text-white">
                {title}
              </h2>
              {description && <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{description}</p>}
            </div>
            <IconButton icon={X} label="閉じる" onClick={requestClose} className="-mr-2" />
          </div>
          <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-4">{children}</div>
          {confirmDiscard ? (
            <div
              className="flex flex-col gap-2 border-t border-amber-200 bg-amber-50 px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:flex-row sm:items-center dark:border-amber-900 dark:bg-amber-950/40"
              role="alert"
            >
              <p className="flex flex-1 items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-100">
                <AlertTriangle className="size-4 shrink-0" aria-hidden />
                入力した内容は保存されていません
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="secondary" onClick={() => setConfirmDiscard(false)}>
                  編集を続ける
                </Button>
                <Button variant="danger" onClick={() => onClose()}>
                  破棄して閉じる
                </Button>
              </div>
            </div>
          ) : (
            footer && (
              <div className="flex flex-col-reverse gap-2 border-t border-slate-200 px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:flex-row sm:justify-end dark:border-navy-800">
                {footer}
              </div>
            )
          )}
        </div>
      </div>
    </ModalCloseContext.Provider>,
    document.body,
  );
}

interface ConfirmProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => Promise<unknown> | void;
  onClose: () => void;
}

export function ConfirmDialog({ open, title, message, confirmLabel = '実行する', danger, confirmDisabled, onConfirm, onClose }: ConfirmProps) {
  const [busy, setBusy] = useState(false);
  const handle = async () => {
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } catch {
      // エラー内容はトーストで通知済み。ダイアログは開いたままにする
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            キャンセル
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={handle} loading={busy} disabled={confirmDisabled}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex gap-3">
        {danger && (
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-400">
            <AlertTriangle className="size-5" aria-hidden />
          </div>
        )}
        <div className="min-w-0 flex-1 text-sm leading-relaxed text-slate-600 dark:text-slate-300">{message}</div>
      </div>
    </Modal>
  );
}
