import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  CalendarCheck,
  CheckCircle2,
  ChevronDown,
  CircleSlash,
  Copy,
  Filter,
  ListChecks,
  Settings2,
  ShieldCheck,
  UserPlus,
  UserRound,
  Zap,
} from 'lucide-react';
import { useAppData } from '../app/AppData';
import { navigate } from '../app/router';
import { daysUntilHire, type OnboardingPlan, type PlanItemOverride } from '../automation/onboardingEngine';
import { formatDateJa } from '../domain/date';
import { PRIORITIES, PRIORITY_LABEL, type Priority } from '../domain/types';
import { RulesPanel } from '../features/RulesPanel';
import { EmployeeStatusBadge, PriorityBadge } from '../ui/badges';
import { AppError } from '../services/workcoreService';
import { Badge, Button, Card, CardHeader, EmptyState, PageHeader, SelectField, cx } from '../ui/primitives';

export function OnboardingPage({ query }: { query: URLSearchParams }) {
  const tab = query.get('tab') === 'rules' ? 'rules' : 'generate';
  const employeeId = query.get('employee') ?? '';

  return (
    <>
      <PageHeader title="入社準備の自動化" description="社員の部署・雇用区分・入社日から、必要な準備タスクを自動判定して登録します" />
      <div className="mb-4 grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1 sm:inline-grid dark:bg-navy-900" role="tablist">
        {(
          [
            ['generate', 'タスク自動生成', Zap],
            ['rules', '準備ルール設定', Settings2],
          ] as const
        ).map(([key, label, Icon]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => navigate(key === 'rules' ? '/onboarding?tab=rules' : `/onboarding${employeeId ? `?employee=${employeeId}` : ''}`)}
            className={cx(
              'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition-colors',
              tab === key ? 'bg-white text-navy-900 shadow-sm dark:bg-navy-700 dark:text-white' : 'text-slate-500 dark:text-slate-400',
            )}
          >
            <Icon className="size-4" aria-hidden />
            {label}
          </button>
        ))}
      </div>
      {tab === 'rules' ? <RulesPanel /> : <GeneratePanel employeeId={employeeId} />}
    </>
  );
}

const FLOW = [
  { icon: UserRound, label: '社員情報' },
  { icon: Filter, label: 'ルール判定' },
  { icon: CalendarCheck, label: '期限計算' },
  { icon: ShieldCheck, label: '重複チェック' },
  { icon: ListChecks, label: 'タスク登録' },
];

function GeneratePanel({ employeeId }: { employeeId: string }) {
  const { data, service, run, empById, deptById, today } = useAppData();
  const employee = employeeId ? empById.get(employeeId) : undefined;
  const [plan, setPlan] = useState<OnboardingPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, PlanItemOverride>>({});
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<{ count: number; name: string; id: string } | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);

  const candidates = useMemo(
    () =>
      data.employees
        .filter((e) => e.status !== 'retired')
        .sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || a.hireDate.localeCompare(b.hireDate)),
    [data.employees],
  );
  const pending = candidates.filter((e) => e.status === 'pending');
  const generatedCount = (id: string) => data.tasks.filter((t) => t.employeeId === id && t.source === 'onboarding').length;

  // 社員選択やデータ変更のたびにプレビューを再計算する
  useEffect(() => {
    let cancelled = false;
    setPlanError(null);
    if (!employee) {
      setPlan(null);
      return;
    }
    service
      .previewOnboarding(employee.id)
      .then((p) => {
        if (!cancelled) setPlan(p);
      })
      .catch((e) => {
        if (!cancelled) {
          setPlan(null);
          setPlanError(e instanceof AppError ? e.message : 'プレビューを作成できませんでした');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [employee, service, data]);

  useEffect(() => {
    setOverrides({});
    setResult(null);
    setShowSkipped(false);
  }, [employeeId]);

  const newItems = plan?.items.filter((i) => i.status === 'new') ?? [];
  const skipped = plan?.items.filter((i) => i.status !== 'new') ?? [];
  const selectedCount = newItems.filter((i) => overrides[i.key]?.selected !== false).length;
  const override = (key: string, patch: Partial<PlanItemOverride>) =>
    setOverrides((o) => ({ ...o, [key]: { selected: o[key]?.selected ?? true, ...o[key], ...patch } }));

  const apply = async () => {
    if (!employee) return;
    setApplying(true);
    try {
      const tasks = await run((s) => s.applyOnboarding(employee.id, overrides), (r) => `${r.length}件の入社準備タスクを登録しました`);
      setResult({ count: tasks.length, name: employee.name, id: employee.id });
      setOverrides({});
    } catch {
      /* トーストで通知済み */
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* 自動化フロー */}
      <Card className="p-4">
        <ol className="grid grid-cols-5 gap-1" aria-label="自動化の処理フロー">
          {FLOW.map((f, i) => (
            <li key={f.label} className="relative flex flex-col items-center gap-1.5 text-center">
              <span className="flex size-9 items-center justify-center rounded-full bg-navy-50 text-navy-700 dark:bg-navy-800 dark:text-navy-200">
                <f.icon className="size-4" aria-hidden />
              </span>
              <span className="text-[10px] font-medium leading-tight text-slate-600 sm:text-xs dark:text-slate-300">{f.label}</span>
              {i < FLOW.length - 1 && <ArrowRight className="absolute -right-2 top-2.5 size-3.5 text-slate-300 dark:text-slate-600" aria-hidden />}
            </li>
          ))}
        </ol>
      </Card>

      {/* Step 1: 社員選択 */}
      <Card>
        <CardHeader title="1. 対象社員を選択" icon={UserPlus} description="入社予定者が優先表示されます。在籍者にも追加生成できます" />
        <div className="space-y-3 p-4 sm:p-5">
          {pending.length > 0 && (
            <div className="grid gap-2 sm:grid-cols-2">
              {pending.map((e) => {
                const n = generatedCount(e.id);
                const d = daysUntilHire(e, today);
                const on = e.id === employeeId;
                return (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => navigate(`/onboarding?employee=${e.id}`)}
                    aria-pressed={on}
                    className={cx(
                      'flex min-h-16 w-full min-w-0 items-center gap-3 rounded-xl border p-3 text-left transition-all',
                      on
                        ? 'border-navy-600 bg-navy-50 ring-2 ring-navy-600/20 dark:border-navy-400 dark:bg-navy-800'
                        : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50 dark:border-navy-700 dark:hover:bg-navy-800/50',
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold text-slate-800 dark:text-slate-100">{e.name}</p>
                      <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                        {deptById.get(e.departmentId)?.name}・{e.employmentType}・{formatDateJa(e.hireDate)}（{d >= 0 ? `あと${d}日` : '入社済'}）
                      </p>
                    </div>
                    {n > 0 ? <Badge tone="green">生成済 {n}件</Badge> : <Badge tone="violet">未生成</Badge>}
                  </button>
                );
              })}
            </div>
          )}
          <SelectField
            label="すべての社員から選択"
            value={employeeId}
            onChange={(e) => navigate(e.target.value ? `/onboarding?employee=${e.target.value}` : '/onboarding')}
            options={candidates.map((e) => ({ value: e.id, label: `${e.name}（${e.employeeNumber}・${deptById.get(e.departmentId)?.name ?? ''}）` }))}
            placeholder="社員を選択してください"
          />
        </div>
      </Card>

      {/* 登録結果 */}
      {result && (
        <Card className="border-emerald-200 bg-emerald-50/60 p-4 dark:border-emerald-900 dark:bg-emerald-950/30">
          <div className="flex items-start gap-3" role="status">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" aria-hidden />
            <div className="flex-1">
              <p className="font-semibold text-emerald-900 dark:text-emerald-100">
                {result.name}さんの入社準備タスクを {result.count}件 登録しました
              </p>
              <p className="mt-0.5 text-sm text-emerald-800/80 dark:text-emerald-200/80">タスク管理とダッシュボードに反映済みです。</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => navigate(`/tasks?employee=${result.id}&status=all`)}>
                  タスクを確認
                </Button>
                <Button size="sm" variant="secondary" onClick={() => navigate('/')}>
                  ダッシュボードへ
                </Button>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Step 2: プレビュー */}
      {employee && (
        // sticky フッターを効かせるため overflow-hidden は付けない
        <Card>
          <CardHeader
            title="2. 生成内容をプレビュー"
            icon={ListChecks}
            description="チェックを外したタスクは登録されません。担当者・期限・優先度はここで変更できます"
          />
          <div className="mx-4 mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600 sm:mx-5 dark:bg-navy-950 dark:text-slate-300">
            <span className="font-semibold text-slate-800 dark:text-slate-100">{employee.name}</span>
            <EmployeeStatusBadge status={employee.status} />
            <span>
              {deptById.get(employee.departmentId)?.name}・{employee.employmentType}・入社日 {formatDateJa(employee.hireDate)}
            </span>
          </div>
          {planError ? (
            <EmptyState icon={CircleSlash} title="タスクを生成できません" description={planError} />
          ) : !plan ? (
            <p className="p-6 text-center text-sm text-slate-500">判定中…</p>
          ) : (
            <>
              <div className="mx-4 mt-3 grid grid-cols-3 gap-2 text-center sm:mx-5">
                <Summary label="新規生成" value={plan.summary.newCount} tone="text-navy-700 dark:text-navy-200" />
                <Summary label="登録済み" value={plan.summary.duplicateCount} tone="text-emerald-700 dark:text-emerald-300" />
                <Summary label="対象外" value={plan.summary.excludedCount} tone="text-slate-500" />
              </div>

              {newItems.length === 0 ? (
                <EmptyState icon={CheckCircle2} title="新たに生成するタスクはありません" description="適用されるルールのタスクはすべて登録済みです（重複生成は自動で防止されます）" />
              ) : (
                <ul className="mt-3 divide-y divide-slate-100 border-t border-slate-100 dark:divide-navy-800 dark:border-navy-800" data-testid="plan-items">
                  {newItems.map((item) => {
                    const o = overrides[item.key];
                    const selected = o?.selected !== false;
                    return (
                      <li key={item.key} className={cx('px-4 py-3 transition-opacity sm:px-5', !selected && 'opacity-50')}>
                        <label className="flex cursor-pointer items-start gap-3">
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={(e) => override(item.key, { selected: e.target.checked })}
                            className="mt-0.5 size-5 shrink-0 rounded accent-navy-700"
                            aria-label={`${item.title}を登録する`}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold text-slate-800 dark:text-slate-100">{item.title}</span>
                              <Badge tone={item.scope === 'common' ? 'gray' : 'blue'}>{item.scope === 'common' ? '共通' : '部署別'}</Badge>
                              <PriorityBadge priority={o?.priority ?? item.priority} />
                            </span>
                            {item.description && <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">{item.description}</span>}
                          </span>
                        </label>
                        {selected && (
                          <div className="mt-2 grid grid-cols-2 gap-2 pl-8 sm:grid-cols-[1fr_1fr_8rem]">
                            <label className="col-span-2 text-[11px] text-slate-500 sm:col-span-1">
                              担当（{deptById.get(item.assigneeDepartmentId)?.name}）
                              <input
                                value={o?.assignee ?? item.assignee}
                                onChange={(e) => override(item.key, { assignee: e.target.value })}
                                className="mt-0.5 block h-10 w-full rounded-lg border border-slate-300 bg-white px-2.5 text-slate-800 dark:border-navy-700 dark:bg-navy-950 dark:text-slate-100"
                                maxLength={50}
                              />
                            </label>
                            <label className="text-[11px] text-slate-500">
                              期限
                              <input
                                type="date"
                                value={o?.dueDate ?? item.dueDate}
                                onChange={(e) => override(item.key, { dueDate: e.target.value })}
                                className="mt-0.5 block h-10 w-full rounded-lg border border-slate-300 bg-white px-2 text-slate-800 dark:border-navy-700 dark:bg-navy-950 dark:text-slate-100"
                              />
                            </label>
                            <label className="text-[11px] text-slate-500">
                              優先度
                              <select
                                value={o?.priority ?? item.priority}
                                onChange={(e) => override(item.key, { priority: e.target.value as Priority })}
                                className="mt-0.5 block h-10 w-full rounded-lg border border-slate-300 bg-white px-2 text-slate-800 dark:border-navy-700 dark:bg-navy-950 dark:text-slate-100"
                              >
                                {PRIORITIES.map((p) => (
                                  <option key={p} value={p}>
                                    {PRIORITY_LABEL[p]}
                                  </option>
                                ))}
                              </select>
                            </label>
                            {item.notes.length > 0 && <p className="col-span-full text-[11px] text-amber-700 dark:text-amber-400">※ {item.notes.join('／')}</p>}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}

              {skipped.length > 0 && (
                <div className="border-t border-slate-100 dark:border-navy-800">
                  <button
                    type="button"
                    onClick={() => setShowSkipped((v) => !v)}
                    className="flex min-h-11 w-full items-center gap-2 px-4 text-left text-xs font-semibold text-slate-500 sm:px-5"
                    aria-expanded={showSkipped}
                  >
                    <ChevronDown className={cx('size-4 transition-transform', showSkipped && 'rotate-180')} aria-hidden />
                    登録済み・対象外のタスク（{skipped.length}件）
                  </button>
                  {showSkipped && (
                    <ul className="space-y-1.5 px-4 pb-3 sm:px-5" data-testid="skipped-items">
                      {skipped.map((i) => (
                        <li key={i.key} className="flex items-center gap-2 text-sm text-slate-500">
                          {i.status === 'duplicate' ? <Copy className="size-3.5 shrink-0 text-emerald-600" /> : <CircleSlash className="size-3.5 shrink-0" />}
                          <span className="min-w-0 flex-1 truncate">{i.title}</span>
                          <span className="shrink-0 text-[11px]">{i.reason}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {newItems.length > 0 && (
                <div className="sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] rounded-b-2xl border-t border-slate-200 bg-white/95 p-4 backdrop-blur lg:bottom-0 sm:px-5 dark:border-navy-800 dark:bg-navy-900/95">
                  <Button block icon={Zap} onClick={apply} loading={applying} disabled={selectedCount === 0} data-testid="apply-onboarding">
                    {selectedCount}件のタスクを登録する
                  </Button>
                </div>
              )}
            </>
          )}
        </Card>
      )}
    </div>
  );
}

function Summary({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-lg border border-slate-200 py-2 dark:border-navy-800">
      <p className={cx('text-xl font-bold tabular-nums', tone)}>{value}</p>
      <p className="text-[11px] text-slate-500">{label}</p>
    </div>
  );
}
