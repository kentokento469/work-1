import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Boxes, Database, Download, FileJson, FileSpreadsheet, Headset, History, Lock, RefreshCcw, RotateCcw, SearchCheck, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { useAppData } from '../app/AppData';
import { downloadText, timestampForFile } from '../app/download';
import { createBackup, decodeBackupFiles, parseBackupText, type BackupFile } from '../data/backup';
import { MIN_PASSWORD_LENGTH, decryptBackupText, encryptBackupText, isEncryptedBackupText, validatePassword } from '../data/backupCrypto';
import type { SafetySnapshotInfo } from '../data/safety';
import type { DocumentFile } from '../domain/documents/types';
import { formatBytes } from '../features/documents/engine/assets';
import { StorageMeter } from '../features/documents/parts';
import { assetsToCsv, documentsToCsv, filterDocumentsForExport, employeesToCsv, inquiriesToCsv, itemsToCsv, movementsToCsv, tasksToCsv } from '../data/csv';
import { DemoNotice } from '../app/Layout';
import { formatDateTimeJa } from '../domain/date';
import type { ActivityCategory, DataSnapshot } from '../domain/types';
import { DEMO_COMPANY_NAME } from '../demo/demoData';
import { ConfirmDialog } from '../ui/Modal';
import { useToast } from '../ui/Toast';
import { Button, Card, CardHeader, EmptyState, FilterSelect, PageHeader, TextField } from '../ui/primitives';
import { Modal, ModalCancelButton } from '../ui/Modal';

/** 書類の元ファイルを含むバックアップは大きくなるため上限を広げる (端末のメモリを考慮して 150MB まで) */
const MAX_RESTORE_BYTES = 150 * 1024 * 1024;

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
  inquiries: '問い合わせ',
  faqs: 'FAQ',
  inquiryCategories: '問い合わせカテゴリ',
  items: '品目',
  stockLevels: '保管場所別在庫',
  stockMovements: '入出庫履歴',
  reservations: '予約',
  assets: 'IT資産',
  assetEvents: '資産履歴',
  locations: '保管場所',
  suppliers: '仕入先',
  purchaseSuggestions: '発注候補',
  purchaseOrders: '発注書',
  equipmentRules: '必要機器ルール',
  automationRuns: '自動化の処理履歴',
  documents: '書類',
  settings: '設定',
  projects: 'プロジェクト',
};

export function DataPage() {
  const { data, run, service } = useAppData();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [restoreCandidate, setRestoreCandidate] = useState<{ backup: BackupFile; counts: Record<keyof DataSnapshot, number>; fileName: string; files: DocumentFile[]; missingFiles: number; repairs: string[] } | null>(null);
  const [includeFiles, setIncludeFiles] = useState(true);
  const [fileBytes, setFileBytes] = useState<number | null>(null);
  useEffect(() => {
    service.documents.totalFileBytes().then(setFileBytes).catch(() => setFileBytes(null));
  }, [service, data.documents]);
  const [restoreErrors, setRestoreErrors] = useState<string[]>([]);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [category, setCategory] = useState('');
  const [logLimit, setLogLimit] = useState(30);
  // 暗号化 (Phase 9)
  const [encrypt, setEncrypt] = useState(false);
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [exporting, setExporting] = useState(false);
  const [encryptedFile, setEncryptedFile] = useState<{ text: string; fileName: string } | null>(null);
  const [decryptPassword, setDecryptPassword] = useState('');
  const [decryptError, setDecryptError] = useState('');
  const [decrypting, setDecrypting] = useState(false);
  // 上書き前の退避・点検・保存領域の保護 (Phase 9)
  const [safetyInfo, setSafetyInfo] = useState<SafetySnapshotInfo | null>(null);
  const [confirmSafety, setConfirmSafety] = useState(false);
  const [integrity, setIntegrity] = useState<{ errors: string[]; repairs: string[] } | null>(null);
  const [checking, setChecking] = useState(false);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  useEffect(() => {
    service.safety.info().then(setSafetyInfo).catch(() => setSafetyInfo(null));
  }, [service, data.activities]);
  useEffect(() => {
    navigator.storage?.persisted?.().then(setPersisted).catch(() => setPersisted(null));
  }, []);
  const requestPersist = async () => {
    try {
      const ok = (await navigator.storage?.persist?.()) ?? false;
      setPersisted(ok);
      if (ok) toast.success('この端末のデータを、ブラウザの自動削除から保護しました');
      else toast.info('ブラウザが保護を許可しませんでした。ホーム画面に追加する・ブックマークするなどで許可される場合があります');
    } catch {
      toast.error('このブラウザでは保護を設定できません');
    }
  };
  const runCheck = async () => {
    setChecking(true);
    try {
      setIntegrity(await service.checkIntegrity());
    } catch {
      toast.error('点検を実行できませんでした');
    } finally {
      setChecking(false);
    }
  };

  const exportFile = async (kind: 'employees' | 'tasks' | 'inquiries' | 'items' | 'movements' | 'assets' | 'documents' | 'json') => {
    const ts = timestampForFile();
    if (kind === 'items') downloadText(`workcore_inventory_${ts}.csv`, itemsToCsv(data), 'text/csv;charset=utf-8');
    else if (kind === 'movements') downloadText(`workcore_stock_movements_${ts}.csv`, movementsToCsv(data), 'text/csv;charset=utf-8');
    else if (kind === 'assets') downloadText(`workcore_assets_${ts}.csv`, assetsToCsv(data), 'text/csv;charset=utf-8');
    else if (kind === 'inquiries') downloadText(`workcore_inquiries_${ts}.csv`, inquiriesToCsv(data), 'text/csv;charset=utf-8');
    else if (kind === 'employees') downloadText(`workcore_employees_${ts}.csv`, employeesToCsv(data), 'text/csv;charset=utf-8');
    else if (kind === 'tasks') downloadText(`workcore_tasks_${ts}.csv`, tasksToCsv(data), 'text/csv;charset=utf-8');
    else if (kind === 'documents') downloadText(`workcore_documents_${ts}.csv`, documentsToCsv(filterDocumentsForExport(data.documents, {}), data), 'text/csv;charset=utf-8');
    else {
      // 元ファイルは Base64 で埋め込む (サイズが約1.33倍になる)。含めない場合は抽出結果だけを保存
      const pwError = encrypt ? validatePassword(password, password2) : null;
      if (pwError) {
        toast.error(pwError);
        return;
      }
      const files = includeFiles ? await service.loadAllDocumentFiles() : undefined;
      const backup = createBackup(data, new Date(), files);
      const text = JSON.stringify(backup, null, files?.length || encrypt ? 0 : 2);
      // 作成したバックアップを、復元時と同じ検査にかける (復元できないバックアップを気付かずに保存しない)
      const check = parseBackupText(text);
      if (encrypt) {
        setExporting(true);
        try {
          const enc = await encryptBackupText(text, password);
          // 暗号化したファイルを実際に復号して、元の内容と一致することを確かめてから保存する
          const back = await decryptBackupText(enc, password);
          if (!back.ok || back.text !== text) {
            toast.error('暗号化の検証に失敗したため、保存を中止しました');
            return;
          }
          downloadText(`workcore_backup_${ts}.encrypted.json`, enc, 'application/json');
        } finally {
          setExporting(false);
        }
      } else downloadText(`workcore_backup_${ts}.json`, text, 'application/json');
      if (!check.ok) toast.error(`このバックアップはそのままでは復元できない状態です：${check.errors[0] ?? ''}（データ管理の操作履歴とあわせて確認してください）`);
      else if (check.repairs.length) toast.info(`バックアップを作成しました。削除済みデータへの関連付けが残っていたため、復元時に解除されます（${check.repairs.length}種類）`);
    }
    const label =
      kind === 'employees'
        ? `社員一覧CSV（${data.employees.length}件）`
        : kind === 'tasks'
          ? `タスク一覧CSV（${data.tasks.length}件）`
          : kind === 'inquiries'
            ? `問い合わせ一覧CSV（${data.inquiries.length}件）`
            : kind === 'items'
              ? `在庫一覧CSV（${data.items.length}品目）`
              : kind === 'movements'
                ? `入出庫履歴CSV（${data.stockMovements.length}件）`
                : kind === 'assets'
                  ? `資産台帳CSV（${data.assets.length}台）`
                  : kind === 'documents'
                    ? `書類一覧CSV（${data.documents.filter((d) => !d.deletedAt).length}件）`
                    : `JSONバックアップ${encrypt ? '（暗号化）' : ''}${includeFiles && data.documents.some((d) => d.file) ? '（書類の元ファイルを含む）' : ''}`;
    await run((s) => s.recordExport(`${label}を出力しました`), `${label}を出力しました`).catch(() => undefined);
  };

  const onFile = async (file: File | undefined) => {
    setRestoreErrors([]);
    if (!file) return;
    if (file.size > MAX_RESTORE_BYTES) {
      setRestoreErrors([`ファイルサイズが大きすぎます（${formatBytes(MAX_RESTORE_BYTES)}まで）`]);
      return;
    }
    try {
      const text = await file.text();
      if (isEncryptedBackupText(text)) {
        // 暗号化されたバックアップは、パスワードを聞いて復号してから同じ検証にかける
        setDecryptPassword('');
        setDecryptError('');
        setEncryptedFile({ text, fileName: file.name });
        return;
      }
      await validateText(text, file.name);
    } catch {
      setRestoreErrors(['ファイルを読み込めませんでした']);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const validateText = async (text: string, fileName: string) => {
    const r = parseBackupText(text);
    if (!r.ok) {
      setRestoreErrors(r.errors);
      toast.error('バックアップファイルの検証に失敗しました');
      return;
    }
    // 元ファイルは復元前にハッシュを検証する (破損したファイルを書類に結び付けない)
    const decoded = await decodeBackupFiles(r.backup);
    if (!decoded.ok) {
      setRestoreErrors(decoded.errors);
      toast.error('バックアップ内の元ファイルの検証に失敗しました');
      return;
    }
    const included = new Set(decoded.files.map((f) => f.id));
    const missingFiles = r.backup.data.documents.filter((d) => d.file && !included.has(d.file.fileId)).length;
    setRestoreCandidate({ backup: r.backup, counts: r.counts, fileName, files: decoded.files, missingFiles, repairs: r.repairs });
  };

  const submitDecrypt = async () => {
    if (!encryptedFile) return;
    setDecrypting(true);
    setDecryptError('');
    try {
      const r = await decryptBackupText(encryptedFile.text, decryptPassword);
      if (!r.ok) {
        setDecryptError(r.error);
        return;
      }
      const fileName = encryptedFile.fileName;
      setEncryptedFile(null);
      await validateText(r.text, fileName);
    } finally {
      setDecrypting(false);
    }
  };

  const logs = useMemo(() => data.activities.filter((a) => !category || a.category === category), [data.activities, category]);

  return (
    <>
      <PageHeader title="データ管理" description="データはこの端末のブラウザ（IndexedDB）に保存され、外部には送信されません" />
      <Card className="mb-4 border-amber-200 bg-amber-50/60 p-4 dark:border-amber-900 dark:bg-amber-950/20">
        <p className="mb-1 text-sm font-bold text-amber-900 dark:text-amber-200">これはデモ環境です（本番システムではありません）</p>
        <DemoNotice />
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">ブラウザのデータ削除・プライベートブラウズ・端末変更でデータは失われます。必要に応じてJSONバックアップを保存してください。</p>
      </Card>

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
            <Button variant="secondary" icon={FileSpreadsheet} onClick={() => exportFile('inquiries')} className="justify-start" data-testid="export-inquiries">
              問い合わせ一覧をCSV出力（{data.inquiries.length}件）
            </Button>
            <Button variant="secondary" icon={FileSpreadsheet} onClick={() => exportFile('items')} className="justify-start" data-testid="export-items">
              在庫一覧をCSV出力（{data.items.length}品目）
            </Button>
            <Button variant="secondary" icon={FileSpreadsheet} onClick={() => exportFile('movements')} className="justify-start" data-testid="export-movements">
              入出庫履歴をCSV出力（{data.stockMovements.length}件）
            </Button>
            <Button variant="secondary" icon={FileSpreadsheet} onClick={() => exportFile('assets')} className="justify-start" data-testid="export-assets">
              資産台帳をCSV出力（{data.assets.length}台）
            </Button>
            <Button variant="secondary" icon={FileSpreadsheet} onClick={() => exportFile('documents')} className="justify-start" data-testid="export-documents">
              書類一覧をCSV出力（{data.documents.filter((d) => !d.deletedAt).length}件）
            </Button>
            <Button variant="secondary" icon={FileJson} onClick={() => exportFile('json')} className="justify-start" loading={exporting} data-testid="export-json">
              全データをJSONバックアップ{encrypt && '（暗号化）'}
            </Button>
            <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" className="size-5 accent-navy-700" checked={includeFiles} onChange={(e) => setIncludeFiles(e.target.checked)} data-testid="backup-include-files" />
              書類の元ファイル（画像・PDF）も含める{fileBytes !== null && `（約${formatBytes(Math.round(fileBytes * 1.34))}）`}
            </label>
            <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" className="size-5 accent-navy-700" checked={encrypt} onChange={(e) => setEncrypt(e.target.checked)} data-testid="backup-encrypt" />
              <Lock className="size-4 text-slate-500" aria-hidden />
              パスワードで暗号化する（住所・電話番号などを含むため、持ち出す場合に推奨）
            </label>
            {encrypt && (
              <div className="grid gap-2 rounded-lg border border-slate-200 p-3 dark:border-navy-700">
                <TextField
                  label="パスワード"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  hint={`${MIN_PASSWORD_LENGTH}文字以上`}
                  data-testid="backup-password"
                />
                <TextField label="パスワード（確認）" type="password" autoComplete="new-password" value={password2} onChange={(e) => setPassword2(e.target.value)} data-testid="backup-password2" />
                <p className="text-xs font-semibold text-red-700 dark:text-red-300">
                  パスワードを忘れると、このバックアップは誰にも（開発者にも）復元できません。パスワードはバックアップとは別の安全な場所に控えてください。
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">ブラウザ内で暗号化します（AES-GCM・256ビット）。パスワードやデータは外部に送信しません。ファイル名・作成日時・大きさは暗号化されません。</p>
              </div>
            )}
            <div className="rounded-lg bg-slate-50 p-2 dark:bg-navy-950">
              <p className="mb-1 text-xs font-semibold text-slate-600 dark:text-slate-300">この端末の保存容量</p>
              <StorageMeter />
            </div>
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
              不正な形式・壊れたファイルは読み込まれず、現在のデータは変更されません。暗号化したバックアップは、選択後にパスワードを入力します。
            </p>
          </div>
        </Card>

        <Card>
          <CardHeader title="デモ環境" icon={Database} description={`架空企業「${DEMO_COMPANY_NAME}」のサンプルデータ`} />
          <div className="grid gap-2 p-4 sm:p-5">
            {data.inquiries.length === 0 && (
              <Button
                variant="secondary"
                icon={Headset}
                className="justify-start"
                data-testid="add-helpdesk-demo"
                onClick={() => run((s) => s.addHelpdeskDemo(), (n) => `ヘルプデスクのデモデータ（問い合わせ${n}件）を追加しました`).catch(() => undefined)}
              >
                ヘルプデスクのデモデータだけ追加（既存データは残す）
              </Button>
            )}
            {data.items.length === 0 && (
              <Button
                variant="secondary"
                icon={Boxes}
                className="justify-start"
                data-testid="add-inventory-demo"
                onClick={() => run((s) => s.inventory.addInventoryDemo(), (n) => `在庫・資産のデモデータ（品目${n}件）を追加しました`).catch(() => undefined)}
              >
                在庫・資産のデモデータだけ追加（既存データは残す）
              </Button>
            )}
            <Button variant="secondary" icon={RefreshCcw} onClick={() => setConfirmReset(true)} className="justify-start" data-testid="reset-demo">
              デモデータを初期化・再生成
            </Button>
            <Button variant="secondary" icon={Trash2} onClick={() => setConfirmClear(true)} className="justify-start text-red-600 dark:text-red-400">
              社員・タスク・問い合わせ・在庫を全削除（空の状態で開始）
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

        <Card>
          <CardHeader title="直前のデータに戻す" icon={RotateCcw} description="復元・初期化・全削除の直前のデータを、この端末に1世代だけ自動で退避しています" />
          <div className="space-y-2 p-4 sm:p-5" data-testid="safety-card">
            {safetyInfo ? (
              <>
                <p className="text-sm">
                  {formatDateTimeJa(safetyInfo.at)}の「{safetyInfo.reason}」の直前のデータ
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  社員{safetyInfo.counts.employees}名・タスク{safetyInfo.counts.tasks}件・問い合わせ{safetyInfo.counts.inquiries}件・品目{safetyInfo.counts.items}件・書類{safetyInfo.counts.documents}件
                </p>
                <Button variant="secondary" icon={RotateCcw} onClick={() => setConfirmSafety(true)} data-testid="safety-restore">
                  このデータに戻す
                </Button>
              </>
            ) : (
              <p className="text-sm text-slate-500 dark:text-slate-400" data-testid="safety-empty">
                まだ退避したデータはありません。
              </p>
            )}
            <p className="text-xs text-slate-500 dark:text-slate-400">端末の故障・紛失・ブラウザのデータ削除では一緒に失われます。定期的に JSON バックアップも保存してください。</p>
          </div>
        </Card>

        <Card>
          <CardHeader title="データの点検と保護" icon={SearchCheck} description="保存されているデータの整合性の確認と、ブラウザによる自動削除からの保護" />
          <div className="space-y-3 p-4 sm:p-5">
            <Button variant="secondary" icon={SearchCheck} onClick={runCheck} loading={checking} data-testid="integrity-check">
              データを点検する
            </Button>
            {integrity && (
              <div className="rounded-lg bg-slate-50 p-3 text-sm dark:bg-navy-950" data-testid="integrity-result" role="status">
                {integrity.errors.length === 0 && integrity.repairs.length === 0 && <p className="font-semibold text-emerald-700 dark:text-emerald-300">問題は見つかりませんでした。バックアップから正しく復元できる状態です。</p>}
                {integrity.repairs.length > 0 && (
                  <>
                    <p className="font-semibold text-amber-800 dark:text-amber-200">削除済みのデータを指したままの関連付けがあります（業務データは消えていません）</p>
                    <ul className="mt-1 list-disc pl-5 text-xs">
                      {integrity.repairs.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                    <Button
                      size="sm"
                      className="mt-2"
                      data-testid="integrity-repair"
                      onClick={() =>
                        run((s) => s.repairIntegrity(), (r) => `関連付けを修復しました（${r.length}種類）`)
                          .then(runCheck)
                          .catch(() => undefined)
                      }
                    >
                      関連付けを解除して修復する
                    </Button>
                  </>
                )}
                {integrity.errors.length > 0 && (
                  <>
                    <p className="font-semibold text-red-700 dark:text-red-300">自動では直せない問題があります。JSON バックアップを保存したうえで、開発者に相談してください</p>
                    <ul className="mt-1 list-disc pl-5 text-xs">
                      {integrity.errors.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
            <div className="rounded-lg bg-slate-50 p-3 text-sm dark:bg-navy-950" data-testid="persist-status">
              <p>
                ブラウザによる自動削除からの保護：
                <strong>{persisted === null ? '確認できません' : persisted ? '有効' : '無効'}</strong>
              </p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">無効の場合、端末の空き容量が少なくなるとブラウザがデータを削除することがあります（特に iPhone の Safari は、長期間開かないサイトのデータを削除します）。</p>
              {persisted === false && (
                <Button variant="secondary" size="sm" className="mt-2" onClick={requestPersist} data-testid="persist-request">
                  保護を有効にする
                </Button>
              )}
            </div>
          </div>
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
              <p className="mt-2 text-xs">
                書類の元ファイル：{restoreCandidate.files.length}件（内容のハッシュを検証済み）
                {restoreCandidate.missingFiles > 0 && <span className="text-amber-700 dark:text-amber-400">。元ファイルを含まない書類 {restoreCandidate.missingFiles}件は、抽出結果だけが復元されます</span>}
              </p>
              {restoreCandidate.repairs.length > 0 && (
                <div className="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-100" data-testid="restore-repairs">
                  <p className="font-semibold">削除済みのデータを指していた関連付けを、次のとおり解除して復元します（業務データは消えません）</p>
                  <ul className="mt-1 list-disc pl-4">
                    {restoreCandidate.repairs.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="mt-2 text-xs">上書きの直前に、現在のデータをこの端末に自動で退避します。復元後に「直前のデータに戻す」で元に戻せます。</p>
            </>
          )
        }
        onConfirm={() => (restoreCandidate ? run((s) => s.restoreBackup(restoreCandidate.backup, restoreCandidate.files), 'バックアップから復元しました') : undefined)}
        onClose={() => setRestoreCandidate(null)}
      />
      <ConfirmDialog
        open={confirmSafety}
        danger
        title="直前のデータに戻しますか？"
        confirmLabel="このデータに戻す"
        message={
          safetyInfo && (
            <>
              <p>
                現在のデータを、{formatDateTimeJa(safetyInfo.at)}の「{safetyInfo.reason}」の直前の状態（社員{safetyInfo.counts.employees}名・タスク{safetyInfo.counts.tasks}件など）で置き換えます。
              </p>
              <p className="mt-2 text-xs">現在のデータは代わりに退避されるため、もう一度この操作をすると今の状態に戻せます。</p>
            </>
          )
        }
        onConfirm={() => run((s) => s.restoreSafetySnapshot(), '直前のデータに戻しました')}
        onClose={() => setConfirmSafety(false)}
      />
      <Modal
        open={!!encryptedFile}
        onClose={() => setEncryptedFile(null)}
        title="暗号化されたバックアップ"
        description={encryptedFile ? `「${encryptedFile.fileName}」を復号するパスワードを入力してください` : undefined}
        footer={
          <>
            <ModalCancelButton disabled={decrypting} />
            <Button type="submit" form="decrypt-form" icon={Lock} loading={decrypting} data-testid="decrypt-submit">
              復号して内容を確認
            </Button>
          </>
        }
      >
        <form
          id="decrypt-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submitDecrypt();
          }}
        >
          <TextField
            label="パスワード"
            type="password"
            autoComplete="current-password"
            value={decryptPassword}
            onChange={(e) => setDecryptPassword(e.target.value)}
            error={decryptError || undefined}
            hint="復号した内容を確認してから、上書きするかを選べます（まだデータは変更しません）"
            data-testid="decrypt-password"
            autoFocus
          />
        </form>
      </Modal>
      <ConfirmDialog
        open={confirmReset}
        danger
        title="デモデータを初期化しますか？"
        confirmLabel="初期化する"
        message="現在のデータ（社員・タスク・問い合わせ・FAQ・在庫・資産・発注・ルール・部署・操作履歴）をすべて削除し、デモデータを再生成します。直前のデータは自動で退避され、「直前のデータに戻す」で元に戻せます。"
        onConfirm={() => run((s) => s.resetDemoData(), 'デモデータを初期化しました')}
        onClose={() => setConfirmReset(false)}
      />
      <ConfirmDialog
        open={confirmClear}
        danger
        title="社員・タスクを全削除しますか？"
        confirmLabel="全削除する"
        message="社員・タスク・問い合わせ・FAQ・在庫・資産・発注・操作履歴をすべて削除します。部署・準備ルール・問い合わせカテゴリ・保管場所・仕入先は初期設定に戻ります。直前のデータは自動で退避され、「直前のデータに戻す」で元に戻せます。"
        onConfirm={() => run((s) => s.clearBusinessData(), '社員・タスクを全削除しました')}
        onClose={() => setConfirmClear(false)}
      />
    </>
  );
}
