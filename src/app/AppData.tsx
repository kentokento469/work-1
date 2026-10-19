/**
 * アプリ全体のデータ状態。
 * 変更操作は必ず run() を通し、サービス層で永続化 → スナップショットに反映 → トースト表示 を行う。
 * これによりタスクのステータス変更などがダッシュボードへ即時反映される。
 * 反映は差分で行う (Phase 13R): 書き込まれたデータの種類と id を ChangeTracker が記録し、その分だけ読み直す
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { openWorkCoreDB } from '../data/db';
import { ChangeTracker } from '../data/changeTracker';
import type { StoreChanges } from '../data/snapshot';
import { computeDashboard, type DashboardStats } from '../domain/analytics';
import { computeHelpdeskStats, type HelpdeskStats } from '../domain/helpdesk/analytics';
import { computeAllStock, type StockStatus } from '../domain/inventory/stock';
import { computeInventoryStats, type InventoryStats } from '../domain/inventory/analytics';
import { ALL_AUTOMATIONS } from '../automation/registry';
import { readAutomationSettings, ruleSetting } from '../automation/settings';
import { pendingProposals, type AutomationProposal } from '../automation/engine';
import type { DataSnapshot, Department, Employee } from '../domain/types';
import { deriveNotices, isUnread, readNoticeState, type AppNotice, type NoticeState } from '../domain/notifications';
import { AppError, WorkCoreService } from '../services/workcoreService';
import { reportError, storageErrorMessage } from '../services/common';
import { readBusinessCalendar, setBusinessCalendar } from '../domain/calendar';
import { buildIndex, type DataIndex } from '../domain/dataIndex';
import { useToast } from '../ui/Toast';

interface AppDataValue {
  service: WorkCoreService;
  data: DataSnapshot;
  stats: DashboardStats;
  helpdeskStats: HelpdeskStats;
  /** 品目ごとの在庫状態 (実在庫・予約・利用可能・発注残・見込み) */
  stock: Map<string, StockStatus>;
  inventoryStats: InventoryStats;
  /** 承認待ちの自動化提案 */
  proposals: AutomationProposal[];
  /** 実データから導出した通知 (未処理・お知らせ)。バッジ・通知センター・各画面の「要対応」はすべてこれを使う */
  notices: AppNotice[];
  /** 通知の既読・解消の記録 */
  noticeState: NoticeState;
  unreadCount: number;
  /** 通知を既読にする (未処理件数は変わらない) */
  markNoticesRead: (ids: string[]) => void;
  today: string;
  deptById: Map<string, Department>;
  empById: Map<string, Employee>;
  /** ID で引くための索引 (一覧の各行で全件を探さない。Phase 12) */
  index: DataIndex;
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

/**
 * 性能の計測 (保存の内訳: 書き込み・読み込み・再計算)。性能のテスト (e2e/perf.spec.ts) が window.__WC_PERF__ を
 * 設定したときだけ記録する (通常の利用では記録を溜めない)
 */
const perfOn = () => (globalThis as { __WC_PERF__?: boolean }).__WC_PERF__ === true;
const perfMark = (name: string) => void (perfOn() && performance.mark(name));
const perfMeasure = (name: string, start: string, end?: string) => void (perfOn() && performance.measure(name, start, end));

const Ctx = createContext<AppDataValue | null>(null);

/** 同じ端末の別のタブへ「データが変わった」ことを知らせるチャンネル名 (データ本体は送らない) */
const SYNC_CHANNEL = 'workcore-data';
/** changes: 変わったデータの種類と id (受け取ったタブは差分だけを読み直す)。無い場合は全件を読み直す */
type SyncMessage = { type: 'changed'; at: number; changes?: StoreChanges };

// 起動処理は1回だけ実行する (React StrictMode で effect が二重実行されても初期データ投入が重複しないように)
let bootPromise: Promise<{ service: WorkCoreService; tracker: ChangeTracker; seeded: boolean; migrationProblems: number }> | null = null;
function boot() {
  bootPromise ??= (async () => {
    if (!window.indexedDB) throw new StorageUnavailableError();
    const db = await openWorkCoreDB();
    const tracker = new ChangeTracker();
    const service = new WorkCoreService(tracker.wrap(db));
    const seeded = await service.ensureInitialized();
    // 版の更新の直後は、移行したデータを点検する (失敗しても起動は続ける)
    const migration = await service.verifyMigration().catch((e) => {
      console.error('[WorkCore] 移行後の点検に失敗', e);
      return null;
    });
    return { service, tracker, seeded, migrationProblems: migration?.errors.length ?? 0 };
  })();
  return bootPromise;
}

class StorageUnavailableError extends Error {
  constructor() {
    super('IndexedDB is not available');
    this.name = 'StorageUnavailableError';
  }
}

/** 起動時のエラーを、利用者向けの説明と開発者向けの詳細に分ける */
export function describeStartupError(e: unknown): { title: string; message: string; detail: string } {
  const name = e instanceof Error ? e.name : '';
  const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  if (name === 'StorageUnavailableError' || name === 'InvalidStateError' || name === 'SecurityError')
    return { title: 'データベースを開けませんでした', message: 'このブラウザでは、データ（IndexedDB）を保存できない設定になっています。プライベートブラウズを終了するか、サイトデータの保存を許可してから再読み込みしてください。', detail };
  if (name === 'VersionError')
    return { title: 'データベースを開けませんでした', message: 'この端末には、より新しい版の WorkCore で保存したデータがあります。古い画面が残っている可能性があるため、再読み込みして最新の版で開いてください（データは消えていません）。', detail };
  if (name === 'QuotaExceededError')
    return { title: 'データベースを開けませんでした', message: '端末の保存容量が不足しています。不要なファイルやアプリを削除して空き容量を確保してから、再読み込みしてください。', detail };
  return { title: 'データベースを開けませんでした', message: 'データの読み込み中に問題が発生しました。再読み込みしても解決しない場合は、ブラウザを再起動してください（データの削除は行っていません）。', detail };
}

type LoadState = { status: 'loading' } | { status: 'error'; title: string; message: string; detail: string } | { status: 'ready'; service: WorkCoreService; data: DataSnapshot };

export function AppDataProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  /**
   * 「自動で実行」に設定された自動化を実行する。データが変わるたびに呼ぶ。
   * 実行中に再度呼ばれた場合は、終わってからもう一度だけ実行する (同時実行しない)。二重実行は処理履歴のキーで防ぐ
   */
  const autoState = useRef({ running: false, again: false });
  // 差分の反映は同時に1つだけ (2つが同じ古いデータから計算すると、片方の変更が消えるため)
  const trackerRef = useRef<ChangeTracker | null>(null);
  const dataRef = useRef<DataSnapshot | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  /**
   * データを読み直してスナップショットに反映する。
   * - 既定: この画面で書き込んだ分 (ChangeTracker の記録) だけを読み直す
   * - changes: 別のタブから届いた変更の分だけ / full: 全件を読み直す (起動・日付の変更・競合の確認)
   * 戻り値は反映した変更 (別のタブへ知らせる)
   */
  const refresh = useCallback((svc: WorkCoreService, opts: { full?: boolean; changes?: StoreChanges } = {}) => {
    const job = queue.current.then(async (): Promise<StoreChanges> => {
      const tracker = trackerRef.current!;
      const prev = dataRef.current;
      if (opts.full || !prev) {
        tracker.discard();
        const data = await svc.loadSnapshot();
        dataRef.current = data;
        setState({ status: 'ready', service: svc, data });
        return {};
      }
      const changes = opts.changes ?? (await tracker.take());
      if (!Object.keys(changes).length) return changes;
      const data = await svc.loadChanges(prev, changes).catch((e) => {
        console.error('[WorkCore] 差分の読み込みに失敗。全件を読み直します', e);
        return svc.loadSnapshot();
      });
      dataRef.current = data;
      setState({ status: 'ready', service: svc, data });
      return changes;
    });
    queue.current = job.catch(() => undefined);
    return job;
  }, []);
  const runAuto = useCallback(async (svc: WorkCoreService) => {
    if (autoState.current.running) {
      autoState.current.again = true;
      return;
    }
    autoState.current.running = true;
    try {
      do {
        autoState.current.again = false;
        const done = await svc.runAutoAutomations(dataRef.current ?? undefined).catch(() => []);
        if (done.length) {
          notifyRef.current(await refresh(svc));
          toast.info(`自動化を実行しました：${done.map((d) => d.title).join('、')}（処理履歴は自動化センター）`);
        }
      } while (autoState.current.again);
    } finally {
      autoState.current.running = false;
    }
  }, [toast, refresh]);
  const notifyRef = useRef<(changes: StoreChanges) => void>(() => undefined);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { service, tracker, seeded, migrationProblems } = await boot();
        trackerRef.current = tracker;
        tracker.discard();
        const data = await service.loadSnapshot();
        if (cancelled) return;
        dataRef.current = data;
        setState({ status: 'ready', service, data });
        if (seeded) toast.info('デモデータを読み込みました。自由に操作してお試しください。');
        if (migrationProblems) toast.error(`データの版を更新しましたが、自動で直せない問題が${migrationProblems}件あります。データ管理の「データを点検する」で確認してください`);
        void runAuto(service);
      } catch (e) {
        if (!cancelled) {
          console.error('[WorkCore] 起動に失敗', e);
          setState({ status: 'error', ...describeStartupError(e) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [toast, runAuto]);

  const service = state.status === 'ready' ? state.service : null;

  /** 全件を読み直す (日付の変更・競合の確認など、まれな場合だけ) */
  const reload = useCallback(async () => {
    if (!service) return;
    await refresh(service, { full: true });
    void runAuto(service);
  }, [service, runAuto, refresh]);

  /**
   * 複数タブ: 変更を保存したら別のタブへ知らせ、受け取ったタブは最新のデータを読み直す。
   * 編集中のフォームの入力は消えない (フォームは ID で初期化する)。同じデータを同時に編集した場合は保存時に競合として検出する
   */
  const channel = useRef<BroadcastChannel | null>(null);
  const lastSyncToast = useRef(0);
  useEffect(() => {
    if (!service || typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(SYNC_CHANNEL);
    channel.current = ch;
    ch.onmessage = (ev: MessageEvent<SyncMessage>) => {
      if (ev.data?.type !== 'changed') return;
      const changes = ev.data.changes;
      void (changes ? refresh(service, { changes }).then(() => void runAuto(service)) : reload()).then(() => {
        // 続けて届いた場合は1回だけ知らせる
        if (Date.now() - lastSyncToast.current > 5000) toast.info('別のタブでの変更を反映しました');
        lastSyncToast.current = Date.now();
      });
    };
    return () => {
      ch.close();
      channel.current = null;
    };
  }, [service, reload, refresh, runAuto, toast]);
  const notifyOtherTabs = useCallback((changes: StoreChanges) => {
    if (!Object.keys(changes).length) return;
    try {
      channel.current?.postMessage({ type: 'changed', at: Date.now(), changes } satisfies SyncMessage);
    } catch {
      /* 閉じたチャンネル */
    }
  }, []);
  notifyRef.current = notifyOtherTabs;

  /** 通知の記録を実データに合わせる。変化があったときだけ保存して設定を読み直す (同時に1つだけ実行) */
  const noticeSync = useRef({ running: false, again: null as AppNotice[] | null, lastSig: '' });
  const syncNotices = useCallback(
    async (notices: AppNotice[]) => {
      if (!service) return;
      // 通知の内容 (id・件名・種類) が前回の記録から変わっていなければ、記録を読まない (保存のたびに大きな記録を読み書きしない。Phase 13R)
      const sig = notices.map((n) => `${n.id}\u0001${n.title}\u0001${n.kind}`).join('\n');
      if (sig === noticeSync.current.lastSig) return;
      if (noticeSync.current.running) {
        noticeSync.current.again = notices;
        return;
      }
      noticeSync.current.running = true;
      try {
        let next: AppNotice[] | null = notices;
        let changed = false;
        while (next) {
          noticeSync.current.again = null;
          const n: AppNotice[] = next;
          const ok = await service.syncNotices(n).then(
            (c) => {
              changed = c || changed;
              return true;
            },
            () => false,
          );
          if (ok) noticeSync.current.lastSig = n.map((x) => `${x.id}\u0001${x.title}\u0001${x.kind}`).join('\n');
          next = noticeSync.current.again;
        }
        if (changed) notifyOtherTabs(await refresh(service));
      } finally {
        noticeSync.current.running = false;
      }
    },
    [service, refresh, notifyOtherTabs],
  );
  const markNoticesReadCb = useCallback(
    (ids: string[]) => {
      if (!service || !ids.length) return;
      void service.markNoticesRead(ids).then(async (changed) => {
        if (changed) notifyOtherTabs(await refresh(service));
      });
    },
    [service, refresh, notifyOtherTabs],
  );

  const run = useCallback(
    async <T,>(action: (s: WorkCoreService) => Promise<T>, successMessage?: string | ((r: T) => string), opts?: RunOptions<T>): Promise<T> => {
      if (!service) throw new AppError('データの読み込み中です');
      try {
        perfMark('wc:run:start');
        const result = await action(service);
        perfMark('wc:run:written');
        notifyOtherTabs(await refresh(service));
        void runAuto(service);
        perfMark('wc:run:loaded');
        perfMeasure('wc:write', 'wc:run:start', 'wc:run:written');
        perfMeasure('wc:load', 'wc:run:written', 'wc:run:loaded');
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
                      .then(() => refresh(service))
                      .then((changes) => {
                        notifyOtherTabs(changes);
                        void runAuto(service);
                      })
                      .then(() => toast.info(opts?.undoMessage ?? '元に戻しました'))
                      .catch((e) => toast.error(e instanceof AppError ? e.message : '元に戻せませんでした'));
                  },
                }
              : undefined,
          );
        }
        return result;
      } catch (e) {
        // 業務エラー以外 (保存領域の容量不足・接続切れなど) は、原因と次の操作が分かる説明にする
        const message = e instanceof AppError ? e.message : storageErrorMessage(e);
        reportError('操作の実行', e);
        toast.error(message);
        throw e instanceof AppError ? e : new AppError(message);
      }
    },
    [service, refresh, runAuto, toast, notifyOtherTabs],
  );

  const value = useMemo<AppDataValue | null>(() => {
    if (state.status !== 'ready') return null;
    perfMark('wc:derive:start');
    // 営業日の設定 (会社の休業日など) を、期限・営業日の計算より先に反映する (Phase 12)
    setBusinessCalendar(readBusinessCalendar(state.data.settings));
    const today = state.service.today();
    const stock = computeAllStock(state.data.items, state.data);
    const settings = readAutomationSettings(state.data);
    // 無効にした自動化は判定しない。自動実行の自動化は、承認が必要な操作を含む提案だけを一覧に残す
    const proposals = pendingProposals(ALL_AUTOMATIONS, { data: state.data, today, stock }, (id) => ruleSetting(ALL_AUTOMATIONS.find((d) => d.id === id)!, settings).enabled);
    const notices = deriveNotices({ data: state.data, today, stock, proposals });
    const noticeState = readNoticeState(state.data);
    const value = {
      service: state.service,
      data: state.data,
      stats: computeDashboard(state.data, today),
      helpdeskStats: computeHelpdeskStats(state.data.inquiries, state.data.inquiryCategories, today),
      stock,
      inventoryStats: computeInventoryStats(state.data, today),
      proposals,
      notices,
      noticeState,
      unreadCount: notices.filter((n) => isUnread(noticeState, n.id)).length,
      markNoticesRead: markNoticesReadCb,
      today,
      deptById: new Map(state.data.departments.map((d) => [d.id, d])),
      empById: new Map(state.data.employees.map((e) => [e.id, e])),
      index: buildIndex(state.data),
      run,
      reload,
    };
    perfMeasure('wc:derive', 'wc:derive:start');
    return value;
  }, [state, run, reload, markNoticesReadCb]);

  // 日付をまたいだら「今日」(期限超過・今日のタスク・通知) を計算し直す。開いたままの端末でも翌朝に正しく表示する
  useEffect(() => {
    if (!service) return;
    let day = service.today();
    const t = window.setInterval(() => {
      const now = service.today();
      if (now !== day) {
        day = now;
        void reload();
      }
    }, 60_000);
    return () => window.clearInterval(t);
  }, [service, reload]);

  const currentNotices = value?.notices;
  useEffect(() => {
    if (currentNotices) void syncNotices(currentNotices);
  }, [currentNotices, syncNotices]);

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
          <h1 className="text-lg font-bold">{state.title}</h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{state.message}</p>
          <details className="mt-3 text-left text-xs text-slate-500">
            <summary className="cursor-pointer">開発者向けの情報</summary>
            <pre className="mt-1 whitespace-pre-wrap break-all">{state.detail}</pre>
          </details>
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
