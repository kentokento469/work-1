import { useMemo, useRef, useState } from 'react';
import { AlertTriangle, Database, Download, FileJson, FileSpreadsheet, History, RefreshCcw, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { useAppData } from '../app/AppData';
import { downloadText, timestampForFile } from '../app/download';
import { createBackup, parseBackupText, type BackupFile } from '../data/backup';
import { employeesToCsv, tasksToCsv } from '../data/csv';
import { formatDateTimeJa } from '../domain/date';
import type { ActivityCategory, DataSnapshot } from '../domain/types';
import { DEMO_COMPANY_NAME } from '../demo/demoData';
import { ConfirmDialog } from '../ui/Modal';
import { useToast } from '../ui/Toast';
import { Button, Card, CardHeader, EmptyState, FilterSelect, PageHeader } from '../ui/primitives';

const MAX_RESTORE_BYTES = 10 * 1024 * 1024;

const CATEGORY_OPTIONS: { value: '' | ActivityCategory; label: string }[] = [
  { value: '', label: 'すべての操作' },
  { value: 'employee', label: '社員' },
  { value: 'task', label: 'タスク' },
  { value: 'onboarding', label: '入社準備（自動化）' },
  { value: 'rule', label: 'ルール' },
  { value: 'department', label: '部署' },
  { value: 'data', label: 'データ管理' },
];

const COUNT_LABEL: Record<keyof DataSnapshot, string> = {
  departments: '部署',
  employees: '社員',
  tasks: 'タスク',
  rules: '準備ルール',
  activities: '操作履歴',
};

export function DataPage() {
  const { data, run, service } = useAppData();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [restoreCandidate, setRestoreCandidate] = useState<{ backup: BackupFile; counts: Record<keyof DataSnapshot, number>; fileName: string } | null>(null);
  const [restoreErrors, setRestoreErrors] = useState<string[]>([]);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [category, setCategory] = useState('');
  const [logLimit, setLogLimit] = useState(30);

  const exportFile = async (kind: 'employees' | 'tasks' | 'json') => {
    const ts = timestampForFile();
    if (kind === 'employees') downloadText(`workcore_employees_${ts}.csv`, employeesToCsv(data), 'text/csv;charset=utf-8');
    else if (kind === 'tasks') downloadText(`workcore_tasks_${ts}.csv`, tasksToCsv(data), 'text/csv;charset=utf-8');
    else downloadText(`workcore_backup_${ts}.json`, JSON.stringify(createBackup(data), null, 2), 'application/json');
    const label = kind === 'employees' ? `社員一覧CSV（${data.employees.length}件）` : kind === 'tasks' ? `タスク一覧CSV（${data.tasks.length}件）` : 'JSONバックアップ';
    await run((s) => s.recordExport(`${label}を出力しました`), `${label}を出力しました`).catch(() => undefined);
  };

  const onFile = async (file: File | undefined) => {
    setRestoreErrors([]);
    if (!file) return;
    if (file.size > MAX_RESTORE_BYTES) {
      setRestoreErrors(['ファイルサイズが大きすぎます（10MBまで）']);
      return;
    }
    try {
      const text = await file.text();
      const r = parseBackupText(text);
      if (!r.ok) {
        setRestoreErrors(r.errors);
        toast.error('バックアップファイルの検証に失敗しました');
        return;
      }
      setRestoreCandidate({ backup: r.backup, counts: r.counts, fileName: file.name });
    } catch {
      setRestoreErrors(['ファイルを読み込めませんでした']);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const logs = useMemo(() => data.activities.filter((a) => !category || a.category === category), [data.activities, category]);

  return (
    <>
      <PageHeader title="データ管理" description="データはこの端末のブラウザ（IndexedDB）に保存され、外部には送信されません" />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="エクスポート" icon={Download} description="CSVはExcelで文字化けしないUTF-8（BOM付き）形式です" />
          <div className="grid gap-2 p-4 sm:p-5">
            <Button variant="secondary" icon={FileSpreadsheet} onClick={() => exportFile('employees')} className="justify-start" data-testid="export-employees">
              社員一覧をCSV出力（{data.employees.length}件）
            </Button>
            <Button variant="secondary" icon={FileSpreadsheet} onClick={() => exportFile('tasks')} className="justify-start" data-testid="export-tasks">
              タスク一覧をCSV出力（{data.tasks.length}件）
            </Button>
            <Button variant="secondary" icon={FileJson} onClick={() => exportFile('json')} className="justify-start" data-testid="export-json">
              全データをJSONバックアップ
            </Button>
            <p className="text-xs text-slate-500 dark:text-slate-400">iPhoneの場合、保存先は「ファイル」アプリのダウンロードフォルダです。</p>
          </div>
        </Card>

        <Card>
          <CardHeader title="バックアップから復元" icon={Upload} description="形式・参照整合性を検証してから、確認の上で上書きします" />
          <div className="space-y-3 p-4 sm:p-5">
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="sr-only"
              onChange={(e) => onFile(e.target.files?.[0])}
              data-testid="restore-input"
              aria-label="バックアップファイルを選択"
            />
            <Button variant="secondary" icon={Upload} block onClick={() => fileRef.current?.click()}>
              JSONファイルを選択
            </Button>
            {restoreErrors.length > 0 && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200" role="alert">
                <p className="flex items-center gap-1.5 font-semibold">
                  <AlertTriangle className="size-4" aria-hidden />
                  復元できません
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
                  {restoreErrors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            )}
            <p className="flex items-start gap-1.5 text-xs text-slate-500 dark:text-slate-400">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              不正な形式・壊れたファイルは読み込まれず、現在のデータは変更されません。
            </p>
          </div>
        </Card>

        <Card>
          <CardHeader title="デモ環境" icon={Database} description={`架空企業「${DEMO_COMPANY_NAME}」のサンプルデータ`} />
          <div className="grid gap-2 p-4 sm:p-5">
            <Button variant="secondary" icon={RefreshCcw} onClick={() => setConfirmReset(true)} className="justify-start" data-testid="reset-demo">
              デモデータを初期化・再生成
            </Button>
            <Button variant="secondary" icon={Trash2} onClick={() => setConfirmClear(true)} className="justify-start text-red-600 dark:text-red-400">
              社員・タスクを全削除（空の状態で開始）
            </Button>
            <p className="text-xs text-slate-500 dark:text-slate-400">デモデータの日付は「今日」を基準に生成されるため、いつでも入社予定・期限超過などの状態を確認できます。</p>
          </div>
        </Card>

        <Card>
          <CardHeader title="保存状況" icon={ShieldCheck} />
          <dl className="grid grid-cols-2 gap-2 p-4 sm:p-5">
            {(Object.keys(COUNT_LABEL) as (keyof DataSnapshot)[]).map((k) => (
              <div key={k} className="rounded-lg bg-slate-50 px-3 py-2 dark:bg-navy-950">
                <dt className="text-[11px] text-slate-500">{COUNT_LABEL[k]}</dt>
                <dd className="text-lg font-bold tabular-nums text-slate-800 dark:text-slate-100">{data[k].length}</dd>
              </div>
            ))}
            <div className="rounded-lg bg-slate-50 px-3 py-2 dark:bg-navy-950">
              <dt className="text-[11px] text-slate-500">基準日</dt>
              <dd className="text-lg font-bold tabular-nums text-slate-800 dark:text-slate-100">{service.today()}</dd>
            </div>
          </dl>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader
          title="操作履歴"
          icon={History}
          description={`直近${data.activities.length}件（最大300件まで保存）`}
          action={<FilterSelect label="操作の種類" value={category} onChange={setCategory} options={CATEGORY_OPTIONS} className="w-40" />}
        />
        <div className="px-4 pb-4 pt-3 sm:px-5">
          {logs.length === 0 ? (
            <EmptyState icon={History} title="該当する操作履歴はありません" />
          ) : (
            <>
              <ul className="divide-y divide-slate-100 dark:divide-navy-800" data-testid="activity-log">
                {logs.slice(0, logLimit).map((a) => (
                  <li key={a.id} className="flex gap-3 py-2.5 text-sm">
                    <span className="w-20 shrink-0 text-xs tabular-nums text-slate-400">{formatDateTimeJa(a.at)}</span>
                    <span className="text-slate-700 dark:text-slate-200">{a.message}</span>
                  </li>
                ))}
              </ul>
              {logs.length > logLimit && (
                <Button variant="ghost" block className="mt-2" onClick={() => setLogLimit((n) => n + 50)}>
                  さらに表示（残り{logs.length - logLimit}件）
                </Button>
              )}
            </>
          )}
        </div>
      </Card>

      <ConfirmDialog
        open={!!restoreCandidate}
        danger
        title="バックアップから復元しますか？"
        confirmLabel="上書きして復元"
        message={
          restoreCandidate && (
            <>
              <p>
                「{restoreCandidate.fileName}」
                {restoreCandidate.backup.exportedAt && `（${formatDateTimeJa(restoreCandidate.backup.exportedAt)} 作成）`}の内容で、
                <strong className="text-red-600 dark:text-red-400">現在のデータをすべて上書き</strong>します。
              </p>
              <ul className="mt-3 grid grid-cols-2 gap-1 rounded-lg bg-slate-50 p-3 text-xs dark:bg-navy-950">
                {(Object.keys(COUNT_LABEL) as (keyof DataSnapshot)[]).map((k) => (
                  <li key={k}>
                    {COUNT_LABEL[k]}：
                    <span className="font-semibold">
                      {data[k].length} → {restoreCandidate.counts[k]}件
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs">必要に応じて、先に現在のデータをバックアップしてください。</p>
            </>
          )
        }
        onConfirm={() => (restoreCandidate ? run((s) => s.restoreBackup(restoreCandidate.backup), 'バックアップから復元しました') : undefined)}
        onClose={() => setRestoreCandidate(null)}
      />
      <ConfirmDialog
        open={confirmReset}
        danger
        title="デモデータを初期化しますか？"
        confirmLabel="初期化する"
        message="現在のデータ（社員・タスク・ルール・部署・操作履歴）をすべて削除し、デモデータを再生成します。"
        onConfirm={() => run((s) => s.resetDemoData(), 'デモデータを初期化しました')}
        onClose={() => setConfirmReset(false)}
      />
      <ConfirmDialog
        open={confirmClear}
        danger
        title="社員・タスクを全削除しますか？"
        confirmLabel="全削除する"
        message="社員・タスク・操作履歴をすべて削除します。部署と準備ルールは初期設定に戻ります。この操作は取り消せません。"
        onConfirm={() => run((s) => s.clearBusinessData(), '社員・タスクを全削除しました')}
        onClose={() => setConfirmClear(false)}
      />
    </>
  );
}
