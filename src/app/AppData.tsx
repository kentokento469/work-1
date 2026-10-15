/**
 * アプリ全体のデータ状態。
 * 変更操作は必ず run() を通し、サービス層で永続化 → スナップショット再読込 → トースト表示 を行う。
 * これによりタスクのステータス変更などがダッシュボードへ即時反映される。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { openWorkCoreDB } from '../data/db';
import { computeDashboard, type DashboardStats } from '../domain/analytics';
import { computeHelpdeskStats, type HelpdeskStats } from '../domain/helpdesk/analytics';
import type { DataSnapshot, Department, Employee } from '../domain/types';
import { AppError, WorkCoreService } from '../services/workcoreService';
import { useToast } from '../ui/Toast';

interface AppDataValue {
  service: WorkCoreService;
  data: DataSnapshot;
  stats: DashboardStats;
  helpdeskStats: HelpdeskStats;
  today: string;
  deptById: Map<string, Department>;
  empById: Map<string, Employee>;
  /**
   * 変更処理を実行し、成功時はデータ再読込とトースト表示。失敗時は AppError を投げ直す。
   * undo を渡すと通知に「元に戻す」ボタンを付ける (確認ダイアログの代わりに取り消し可能にする)
   */
  run: <T>(action: (s: WorkCoreService) => Promise<T>, successMessage?: string | ((r: T) => string), opts?: RunOptions<T>) => Promise<T>;
  reload: () => Promise<void>;
}

export interface RunOptions<T> {
  undo?: (result: T) => (s: WorkCoreService) => Promise<unknown>;
  undoMessage?: string;
}

const Ctx = createContext<AppDataValue | null>(null);

// 起動処理は1回だけ実行する (React StrictMode で effect が二重実行されても初期データ投入が重複しないように)
let bootPromise: Promise<{ service: WorkCoreService; seeded: boolean }> | null = null;
function boot() {
  bootPromise ??= (async () => {
    if (!('indexedDB' in window)) throw new Error('このブラウザは IndexedDB に対応していません');
    const db = await openWorkCoreDB();
    const service = new WorkCoreService(db);
    const seeded = await service.ensureInitialized();
    return { service, seeded };
  })();
  return bootPromise;
}

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; service: WorkCoreService; data: DataSnapshot };

export function AppDataProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { service, seeded } = await boot();
        const data = await service.loadSnapshot();
        if (cancelled) return;
        setState({ status: 'ready', service, data });
        if (seeded) toast.info('デモデータを読み込みました。自由に操作してお試しください。');
      } catch (e) {
        if (!cancelled)
          setState({
            status: 'error',
            message:
              e instanceof Error
                ? `${e.message}（プライベートブラウズ等でデータ保存が制限されている可能性があります）`
                : 'データベースを開けませんでした',
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [toast]);

  const service = state.status === 'ready' ? state.service : null;

  const reload = useCallback(async () => {
    if (!service) return;
    const data = await service.loadSnapshot();
    setState({ status: 'ready', service, data });
  }, [service]);

  const run = useCallback(
    async <T,>(action: (s: WorkCoreService) => Promise<T>, successMessage?: string | ((r: T) => string), opts?: RunOptions<T>): Promise<T> => {
      if (!service) throw new AppError('データの読み込み中です');
      try {
        const result = await action(service);
        await reload();
        if (successMessage) {
          const msg = typeof successMessage === 'function' ? successMessage(result) : successMessage;
          const undo = opts?.undo;
          toast.success(
            msg,
            undo
              ? {
                  label: '元に戻す',
                  onClick: () => {
                    undo(result)(service)
                      .then(reload)
                      .then(() => toast.info(opts?.undoMessage ?? '元に戻しました'))
                      .catch((e) => toast.error(e instanceof AppError ? e.message : '元に戻せませんでした'));
                  },
                }
              : undefined,
          );
        }
        return result;
      } catch (e) {
        const message = e instanceof AppError ? e.message : '処理に失敗しました。時間をおいて再度お試しください';
        if (!(e instanceof AppError)) console.error(e);
        toast.error(message);
        throw e instanceof AppError ? e : new AppError(message);
      }
    },
    [service, reload, toast],
  );

  const value = useMemo<AppDataValue | null>(() => {
    if (state.status !== 'ready') return null;
    const today = state.service.today();
    return {
      service: state.service,
      data: state.data,
      stats: computeDashboard(state.data, today),
      helpdeskStats: computeHelpdeskStats(state.data.inquiries, state.data.inquiryCategories, today),
      today,
      deptById: new Map(state.data.departments.map((d) => [d.id, d])),
      empById: new Map(state.data.employees.map((e) => [e.id, e])),
      run,
      reload,
    };
  }, [state, run, reload]);

  if (state.status === 'loading')
    return (
      <div className="flex min-h-dvh items-center justify-center" role="status">
        <div className="flex flex-col items-center gap-3 text-slate-500">
          <div className="size-8 animate-spin rounded-full border-2 border-navy-200 border-t-navy-700" />
          <p className="text-sm">データを読み込んでいます…</p>
        </div>
      </div>
    );
  if (state.status === 'error')
    return (
      <div className="flex min-h-dvh items-center justify-center p-6">
        <div className="max-w-md rounded-2xl border border-red-200 bg-white p-6 text-center dark:border-red-900 dark:bg-navy-900" role="alert">
          <h1 className="text-lg font-bold">データベースを開けませんでした</h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{state.message}</p>
          <button className="mt-4 rounded-lg bg-navy-800 px-4 py-2.5 text-sm font-semibold text-white" onClick={() => window.location.reload()}>
            再読み込み
          </button>
        </div>
      </div>
    );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppData(): AppDataValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAppData は AppDataProvider 内で使用してください');
  return ctx;
}
