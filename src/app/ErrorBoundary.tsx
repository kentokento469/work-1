/**
 * 画面の表示中に例外が起きても、アプリ全体が真っ白にならないようにする。
 * - データは端末に保存済み (表示の失敗でデータは消えない) ことを伝え、再読み込み・ホームへ戻る操作を出す
 * - 新しい版の公開後に古い画面ファイルを読み込めない場合 (GitHub Pages の再デプロイ後) は、再読み込みを案内する
 * - 開発者向けの詳細 (エラー名・メッセージ) は折りたたんで表示し、利用者向けの説明と分ける
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

export function isChunkLoadError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError/i.test(msg);
}

interface Props {
  children: ReactNode;
  /** 画面単位の境界なら、ホームへ戻るボタンを出す */
  scope: 'page' | 'app';
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 開発者向けの記録 (外部には送信しない)
    console.error('[WorkCore] 画面の表示中にエラー', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const chunk = isChunkLoadError(error);
    return (
      <div className="mx-auto max-w-lg py-10" role="alert" data-testid="error-boundary">
        <div className="rounded-2xl border border-amber-200 bg-white p-6 shadow-sm dark:border-amber-900 dark:bg-navy-900">
          <h1 className="text-lg font-bold">{chunk ? '新しいバージョンが公開されています' : 'この画面を表示できませんでした'}</h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
            {chunk
              ? 'アプリが更新されたため、画面の一部を読み込めませんでした。再読み込みすると最新の版で開きます。'
              : '表示の途中で問題が発生しました。保存済みのデータはこの端末に残っています（この表示の失敗でデータは消えません）。'}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className="min-h-11 rounded-lg bg-navy-800 px-4 text-sm font-semibold text-white dark:bg-navy-500" onClick={() => window.location.reload()}>
              再読み込み
            </button>
            {this.props.scope === 'page' && !chunk && (
              <button
                type="button"
                className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-semibold dark:border-navy-700"
                onClick={() => {
                  this.setState({ error: null });
                  window.location.hash = '#/';
                }}
              >
                ダッシュボードへ戻る
              </button>
            )}
          </div>
          <details className="mt-4 text-xs text-slate-500">
            <summary className="cursor-pointer">開発者向けの情報</summary>
            <pre className="mt-1 whitespace-pre-wrap break-all">{`${error.name}: ${error.message}`}</pre>
          </details>
        </div>
      </div>
    );
  }
}
