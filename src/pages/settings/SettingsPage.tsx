/**
 * 設定: 問い合わせカテゴリ (自動分類のキーワード) / 部署マスタ / 表示テーマ。
 * よく使う項目を上に、変更頻度の低いマスタを下に置く。
 */
import { Bot } from 'lucide-react';
import { currentProvider } from '../../ai/assist';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Monitor, Moon, Pencil, Plus, Save, Sun, Tags, Trash2 } from 'lucide-react';
import { useAppData } from '../../app/AppData';
import { useTheme, type ThemeMode } from '../../app/theme';
import type { InquiryCategory } from '../../domain/types';
import type { CategoryInput } from '../../services/helpdeskService';
import { AppError } from '../../services/workcoreService';
import { DepartmentsCard } from '../../features/RulesPanel';
import { CalendarSettingsCard } from '../../features/CalendarSettingsCard';
import { Modal, ModalCancelButton } from '../../ui/Modal';
import { Badge, Button, Card, CardHeader, IconButton, PageHeader, SelectField, TextAreaField, TextField, cx } from '../../ui/primitives';

export function SettingsPage() {
  const { data, run } = useAppData();
  const [editing, setEditing] = useState<InquiryCategory | null>(null);
  const [creating, setCreating] = useState(false);
  const usage = (id: string) => data.inquiries.filter((i) => i.categoryId === id).length;

  return (
    <>
      <PageHeader title="設定" description="変更内容はこの端末のブラウザに保存されます" />
      <ThemeCard />
      <AiCard />
      <CalendarSettingsCard />
      <Card className="mt-4 overflow-hidden">
        <CardHeader
          title="問い合わせカテゴリ"
          icon={Tags}
          description="キーワードは自動分類に使われます。使用中のカテゴリは削除できないため「無効」にしてください"
          action={
            <Button size="sm" variant="secondary" icon={Plus} onClick={() => setCreating(true)}>
              追加
            </Button>
          }
        />
        <ul className="mt-2 divide-y divide-slate-100 border-t border-slate-100 dark:divide-navy-800 dark:border-navy-800" data-testid="category-list">
          {data.inquiryCategories.map((c) => (
            <li key={c.id} className={cx('flex items-start gap-2 px-4 py-3 sm:px-5', !c.enabled && 'opacity-60')}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold text-slate-800 dark:text-slate-100">{c.name}</p>
                  {c.isFallback && <Badge tone="amber">分類不能時の受け皿</Badge>}
                  {!c.enabled && <Badge>無効</Badge>}
                </div>
                <p className="mt-0.5 text-xs text-slate-500">
                  キーワード {c.keywords.length}語・標準対応 {c.slaBusinessDays}営業日・{c.defaultAssignee || '担当未設定'}・{usage(c.id)}件
                </p>
                {c.keywords.length > 0 && <p className="mt-0.5 line-clamp-1 text-[11px] text-slate-400">{c.keywords.join('、')}</p>}
              </div>
              <IconButton icon={Pencil} label={`${c.name}を編集`} onClick={() => setEditing(c)} />
              {!c.isFallback && (
                <IconButton icon={Trash2} label={`${c.name}を削除`} className="hover:text-red-600" onClick={() => run((s) => s.helpdesk.deleteCategory(c.id), `カテゴリ「${c.name}」を削除しました`).catch(() => undefined)} />
              )}
            </li>
          ))}
        </ul>
      </Card>
      <div className="mt-4">
        <DepartmentsCard />
      </div>
      <CategoryFormModal open={creating} onClose={() => setCreating(false)} />
      <CategoryFormModal open={!!editing} onClose={() => setEditing(null)} category={editing ?? undefined} />
    </>
  );
}

function ThemeCard() {
  const { mode, setMode } = useTheme();
  const options: { v: ThemeMode; label: string; icon: typeof Sun }[] = [
    { v: 'light', label: 'ライト', icon: Sun },
    { v: 'dark', label: 'ダーク', icon: Moon },
    { v: 'system', label: '端末に合わせる', icon: Monitor },
  ];
  return (
    <Card className="p-4">
      <p className="mb-2 text-sm font-bold">表示テーマ</p>
      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="表示テーマ">
        {options.map((o) => (
          <button
            key={o.v}
            type="button"
            role="radio"
            aria-checked={mode === o.v}
            onClick={() => setMode(o.v)}
            className={cx(
              'flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg border text-xs font-semibold',
              mode === o.v ? 'border-navy-700 bg-navy-50 text-navy-900 dark:border-navy-400 dark:bg-navy-800 dark:text-white' : 'border-slate-200 text-slate-600 dark:border-navy-700 dark:text-slate-300',
            )}
          >
            <o.icon className="size-4" aria-hidden />
            {o.label}
          </button>
        ))}
      </div>
    </Card>
  );
}

function CategoryFormModal({ open, onClose, category }: { open: boolean; onClose: () => void; category?: InquiryCategory }) {
  const { data, run } = useAppData();
  const initial = useMemo<CategoryInput>(
    () =>
      category
        ? { name: category.name, keywords: category.keywords, defaultDepartmentId: category.defaultDepartmentId, defaultAssignee: category.defaultAssignee, slaBusinessDays: category.slaBusinessDays, enabled: category.enabled }
        : { name: '', keywords: [], defaultDepartmentId: null, defaultAssignee: '', slaBusinessDays: 3, enabled: true },
    [category, open],
  );
  const [form, setForm] = useState(initial);
  const [kwText, setKwText] = useState('');
  const [slaText, setSlaText] = useState('3');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) {
      setForm(initial);
      setKwText(initial.keywords.join('、'));
      setSlaText(String(initial.slaBusinessDays));
      setErrors({});
    }
  }, [open, initial]);
  const keywords = kwText.split(/[、,，\n]+/).map((k) => k.trim()).filter(Boolean);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await run((s) => s.helpdesk.saveCategory({ ...form, keywords, slaBusinessDays: Number(slaText) }, category?.id), category ? 'カテゴリを更新しました' : 'カテゴリを追加しました');
      onClose();
    } catch (err) {
      if (err instanceof AppError) setErrors(err.fieldErrors);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      dirty={JSON.stringify({ ...form, keywords }) !== JSON.stringify(initial) || slaText !== String(initial.slaBusinessDays)}
      title={category ? 'カテゴリの編集' : 'カテゴリの追加'}
      footer={
        <>
          <ModalCancelButton disabled={saving} />
          <Button type="submit" form="category-form" icon={Save} loading={saving}>
            保存する
          </Button>
        </>
      }
    >
      <form id="category-form" onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2">
        <TextField label="カテゴリ名" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} error={errors.name} maxLength={30} wrapClassName="sm:col-span-2" />
        <TextAreaField
          label="分類キーワード"
          value={kwText}
          onChange={(e) => setKwText(e.target.value)}
          error={errors.keywords}
          rows={3}
          hint="読点・改行区切り。1語一致で2点。長い語が優先されます（例：「パスワード」は「ワード」より優先）"
          wrapClassName="sm:col-span-2"
        />
        <SelectField
          label="既定の担当部署"
          value={form.defaultDepartmentId ?? ''}
          onChange={(e) => setForm({ ...form, defaultDepartmentId: e.target.value || null })}
          options={data.departments.map((d) => ({ value: d.id, label: d.name }))}
          placeholder="（なし）"
        />
        <TextField label="既定の担当者" value={form.defaultAssignee} onChange={(e) => setForm({ ...form, defaultAssignee: e.target.value })} maxLength={50} />
        <TextField label="標準対応期限（営業日）" inputMode="numeric" value={slaText} onChange={(e) => setSlaText(e.target.value)} error={errors.slaBusinessDays} hint="受付日から何営業日以内に対応するか（0〜30）" />
        <label className="flex min-h-11 items-center gap-2 self-end text-sm">
          <input type="checkbox" checked={form.enabled} disabled={category?.isFallback} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} className="size-5 accent-navy-700" />
          有効（選択肢・自動分類に使う）
        </label>
      </form>
    </Modal>
  );
}

/** AI連携の状態。AI モデルは接続していないことを明示する (動いているように見せない) */
function AiCard() {
  const p = currentProvider();
  return (
    <Card className="mt-4 p-4" data-testid="ai-settings">
      <p className="flex items-center gap-1.5 font-semibold">
        <Bot className="size-4" aria-hidden />
        AI連携
      </p>
      <dl className="mt-2 grid grid-cols-[7rem_1fr] gap-y-1 text-sm">
        <dt className="text-slate-500">AIモデル</dt>
        <dd className="font-semibold">未接続</dd>
        <dt className="text-slate-500">現在の判定方式</dt>
        <dd>{p.label}</dd>
        <dt className="text-slate-500">外部への送信</dt>
        <dd>{p.sendsData ? 'あり' : 'なし（問い合わせ・書類の内容は端末の外に送りません）'}</dd>
      </dl>
      <p className="mt-2 text-xs text-slate-500">
        問い合わせの分類・対応の提案・書類の整理・タスクの提案・重複の検出・業務状況の要約は、現在すべてルールベース（キーワード・検算・一致判定）で行っています。AIモデルを接続する仕組み（差し替え口）は用意していますが、接続する場合は送信する内容の確認と、利用者の許可が必要です。
      </p>
    </Card>
  );
}
