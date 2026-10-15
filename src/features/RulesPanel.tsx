import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Building2, Pencil, Plus, Save, Settings2, Trash2 } from 'lucide-react';
import { useAppData } from '../app/AppData';
import { EMPLOYMENT_TYPES, PRIORITIES, PRIORITY_LABEL, type Department, type EmploymentType, type OnboardingRule, type Priority } from '../domain/types';
import { validateRule, type FieldErrors, type RuleInput } from '../domain/validation';
import { AppError } from '../services/workcoreService';
import { PriorityBadge } from '../ui/badges';
import { ConfirmDialog, Modal } from '../ui/Modal';
import { Badge, Button, Card, CardHeader, EmptyState, IconButton, SelectField, TextAreaField, TextField, cx } from '../ui/primitives';

export function offsetLabel(days: number): string {
  if (days === 0) return '入社日当日';
  return days < 0 ? `入社日の${-days}日前` : `入社日の${days}日後`;
}

export function RulesPanel() {
  const { data, deptById, run } = useAppData();
  const [editing, setEditing] = useState<OnboardingRule | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<OnboardingRule | null>(null);

  const groups = useMemo(() => {
    const scopes: { key: string; label: string }[] = [{ key: 'common', label: '全社共通' }, ...data.departments.map((d) => ({ key: d.id, label: d.name }))];
    return scopes.map((s) => ({ ...s, rules: data.rules.filter((r) => r.scope === s.key).sort((a, b) => a.order - b.order) }));
  }, [data.rules, data.departments]);

  return (
    <div className="space-y-4">
      <Card className="p-4 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
        <p>
          ここで設定したルールが、社員ごとの入社準備タスクの<strong className="text-slate-800 dark:text-slate-100">自動判定・期限計算</strong>に使われます。
          ルールを変更しても登録済みのタスクは変わらず、次回の生成から反映されます。
        </p>
        <div className="mt-3">
          <Button icon={Plus} onClick={() => setCreating(true)}>
            ルールを追加
          </Button>
        </div>
      </Card>

      {groups.map((g) => (
        <Card key={g.key} className="overflow-hidden">
          <CardHeader title={g.label} icon={g.key === 'common' ? Settings2 : Building2} description={`${g.rules.length}件のルール`} />
          {g.rules.length === 0 ? (
            <p className="px-5 pb-4 pt-2 text-sm text-slate-400">部署固有のルールはありません</p>
          ) : (
            <ul className="mt-2 divide-y divide-slate-100 border-t border-slate-100 dark:divide-navy-800 dark:border-navy-800">
              {g.rules.map((r) => (
                <li key={r.id} className={cx('flex items-start gap-2 px-4 py-3 sm:px-5', !r.enabled && 'opacity-60')}>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold text-slate-800 dark:text-slate-100">{r.title}</p>
                      {!r.enabled && <Badge>無効</Badge>}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                      <span>{offsetLabel(r.offsetDays)}</span>
                      <span>
                        担当：{deptById.get(r.assigneeDepartmentId)?.name ?? '（削除済み部署）'}
                        {r.defaultAssignee && `・${r.defaultAssignee}`}
                      </span>
                      <PriorityBadge priority={r.priority} />
                      {r.employmentTypes.length > 0 && <Badge tone="amber">{r.employmentTypes.join('・')}のみ</Badge>}
                    </div>
                  </div>
                  <label className="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-slate-500" title="有効/無効">
                    <input
                      type="checkbox"
                      role="switch"
                      checked={r.enabled}
                      onChange={(e) =>
                        run((s) => s.saveRule({ ...r, enabled: e.target.checked }, r.id), `「${r.title}」を${e.target.checked ? '有効' : '無効'}にしました`).catch(() => undefined)
                      }
                      className="size-5 accent-navy-700"
                      aria-label={`${r.title}を有効にする`}
                    />
                  </label>
                  <IconButton icon={Pencil} label={`${r.title}を編集`} onClick={() => setEditing(r)} />
                  <IconButton icon={Trash2} label={`${r.title}を削除`} onClick={() => setDeleting(r)} className="hover:text-red-600" />
                </li>
              ))}
            </ul>
          )}
        </Card>
      ))}

      <DepartmentsCard />

      <RuleFormModal open={creating} onClose={() => setCreating(false)} />
      <RuleFormModal open={!!editing} onClose={() => setEditing(null)} rule={editing ?? undefined} />
      <ConfirmDialog
        open={!!deleting}
        danger
        title="ルールを削除しますか？"
        confirmLabel="削除する"
        message={<>「{deleting?.title}」を削除します。生成済みのタスクは削除されません。</>}
        onConfirm={() => (deleting ? run((s) => s.deleteRule(deleting.id), 'ルールを削除しました') : undefined)}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}

function RuleFormModal({ open, onClose, rule }: { open: boolean; onClose: () => void; rule?: OnboardingRule }) {
  const { data, run } = useAppData();
  const initial: RuleInput = rule
    ? {
        title: rule.title,
        description: rule.description,
        scope: rule.scope,
        assigneeDepartmentId: rule.assigneeDepartmentId,
        defaultAssignee: rule.defaultAssignee,
        priority: rule.priority,
        offsetDays: rule.offsetDays,
        employmentTypes: rule.employmentTypes,
        enabled: rule.enabled,
      }
    : { title: '', description: '', scope: 'common', assigneeDepartmentId: '', defaultAssignee: '', priority: 'medium', offsetDays: -3, employmentTypes: [], enabled: true };
  const [form, setForm] = useState<RuleInput>(initial);
  const [offsetText, setOffsetText] = useState(String(initial.offsetDays));
  const [errors, setErrors] = useState<FieldErrors<RuleInput>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(initial);
      setOffsetText(String(initial.offsetDays));
      setErrors({});
    }
    // 開いた時点の rule で初期化する
  }, [open, rule]);

  const set = <K extends keyof RuleInput>(k: K, v: RuleInput[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const toggleType = (t: EmploymentType) =>
    set('employmentTypes', form.employmentTypes.includes(t) ? form.employmentTypes.filter((x) => x !== t) : [...form.employmentTypes, t]);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const offsetDays = /^-?\d+$/.test(offsetText.trim()) ? Number(offsetText.trim()) : NaN;
    const input = { ...form, offsetDays };
    const v = validateRule(input, { departmentIds: data.departments.map((d) => d.id) });
    if (!v.ok) {
      setErrors(v.errors);
      return;
    }
    setSaving(true);
    try {
      await run((s) => s.saveRule(input, rule?.id), rule ? 'ルールを更新しました' : 'ルールを追加しました');
      onClose();
    } catch (e) {
      if (e instanceof AppError) setErrors(e.fieldErrors as FieldErrors<RuleInput>);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={rule ? '準備ルールの編集' : '準備ルールの追加'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            キャンセル
          </Button>
          <Button type="submit" form="rule-form" icon={Save} loading={saving}>
            保存する
          </Button>
        </>
      }
    >
      <form id="rule-form" onSubmit={submit} noValidate className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField label="タスク名" required value={form.title} onChange={(e) => set('title', e.target.value)} error={errors.title} wrapClassName="sm:col-span-2" maxLength={100} />
        <SelectField
          label="適用範囲"
          required
          value={form.scope}
          onChange={(e) => set('scope', e.target.value)}
          options={[{ value: 'common', label: '全社共通' }, ...data.departments.map((d) => ({ value: d.id, label: `${d.name}のみ` }))]}
          error={errors.scope}
        />
        <SelectField
          label="担当部署"
          required
          value={form.assigneeDepartmentId}
          onChange={(e) => set('assigneeDepartmentId', e.target.value)}
          options={data.departments.map((d) => ({ value: d.id, label: d.name }))}
          placeholder="選択してください"
          error={errors.assigneeDepartmentId}
        />
        <TextField label="既定の担当者" value={form.defaultAssignee} onChange={(e) => set('defaultAssignee', e.target.value)} maxLength={50} />
        <SelectField
          label="優先度"
          required
          value={form.priority}
          onChange={(e) => set('priority', e.target.value as Priority)}
          options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))}
        />
        <TextField
          label="期限（入社日からの日数）"
          required
          inputMode="numeric"
          value={offsetText}
          onChange={(e) => setOffsetText(e.target.value)}
          error={errors.offsetDays}
          hint={/^-?\d+$/.test(offsetText.trim()) ? `${offsetLabel(Number(offsetText))}（土日は直前の平日）` : 'マイナスで入社日前（例：-5）'}
          wrapClassName="sm:col-span-2"
        />
        <fieldset className="sm:col-span-2">
          <legend className="mb-1.5 text-[13px] font-semibold text-slate-700 dark:text-slate-200">対象の雇用区分</legend>
          <div className="flex flex-wrap gap-2">
            {EMPLOYMENT_TYPES.map((t) => {
              const on = form.employmentTypes.includes(t);
              return (
                <button
                  key={t}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleType(t)}
                  className={cx(
                    'min-h-10 rounded-full border px-3 text-[13px] font-medium transition-colors',
                    on ? 'border-navy-700 bg-navy-700 text-white dark:border-navy-400 dark:bg-navy-500' : 'border-slate-300 text-slate-600 dark:border-navy-700 dark:text-slate-300',
                  )}
                >
                  {t}
                </button>
              );
            })}
          </div>
          <p className="mt-1 text-xs text-slate-500">{form.employmentTypes.length === 0 ? '未選択の場合はすべての雇用区分に適用' : `${form.employmentTypes.join('・')}のみに適用`}</p>
        </fieldset>
        <TextAreaField label="説明" value={form.description} onChange={(e) => set('description', e.target.value)} wrapClassName="sm:col-span-2" maxLength={500} />
        <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} className="size-5 accent-navy-700" />
          このルールを有効にする
        </label>
      </form>
    </Modal>
  );
}

function DepartmentsCard() {
  const { data, run } = useAppData();
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<Department | null>(null);
  const [editName, setEditName] = useState('');
  const [deleting, setDeleting] = useState<Department | null>(null);

  const usage = (id: string) => data.employees.filter((e) => e.departmentId === id).length;

  return (
    <Card className="overflow-hidden">
      <CardHeader title="部署マスタ" icon={Building2} description="社員・タスク・ルールで使用中の部署は削除できません" />
      <form
        className="flex gap-2 px-4 pt-3 sm:px-5"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await run((s) => s.addDepartment(name), `部署「${name.trim()}」を追加しました`);
            setName('');
          } catch {
            /* トースト表示済み */
          }
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="新しい部署名"
          aria-label="新しい部署名"
          maxLength={30}
          className="h-11 min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 dark:border-navy-700 dark:bg-navy-950"
        />
        <Button type="submit" variant="secondary" icon={Plus} disabled={!name.trim()}>
          追加
        </Button>
      </form>
      {data.departments.length === 0 ? (
        <EmptyState icon={Building2} title="部署がありません" />
      ) : (
        <ul className="mt-3 divide-y divide-slate-100 border-t border-slate-100 dark:divide-navy-800 dark:border-navy-800">
          {data.departments.map((d) => (
            <li key={d.id} className="flex items-center gap-2 px-4 py-1.5 sm:px-5">
              <span className="flex-1 text-sm font-medium text-slate-800 dark:text-slate-100">{d.name}</span>
              <span className="text-xs text-slate-400">{usage(d.id)}名</span>
              <IconButton
                icon={Pencil}
                label={`${d.name}の名称変更`}
                onClick={() => {
                  setEditing(d);
                  setEditName(d.name);
                }}
              />
              <IconButton icon={Trash2} label={`${d.name}を削除`} onClick={() => setDeleting(d)} className="hover:text-red-600" />
            </li>
          ))}
        </ul>
      )}
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title="部署名の変更"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              キャンセル
            </Button>
            <Button type="submit" form="dept-form" icon={Save}>
              変更する
            </Button>
          </>
        }
      >
        <form
          id="dept-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!editing) return;
            try {
              await run((s) => s.renameDepartment(editing.id, editName), '部署名を変更しました');
              setEditing(null);
            } catch {
              /* トースト表示済み */
            }
          }}
        >
          <TextField label="部署名" required value={editName} onChange={(e) => setEditName(e.target.value)} maxLength={30} />
        </form>
      </Modal>
      <ConfirmDialog
        open={!!deleting}
        danger
        title="部署を削除しますか？"
        confirmLabel="削除する"
        message={<>「{deleting?.name}」を削除します。</>}
        onConfirm={() => (deleting ? run((s) => s.deleteDepartment(deleting.id), '部署を削除しました') : undefined)}
        onClose={() => setDeleting(null)}
      />
    </Card>
  );
}
