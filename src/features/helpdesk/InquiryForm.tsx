/**
 * 問い合わせの入力フォーム (新規登録ページ・編集モーダルで共通)。
 *
 * 入力負担を減らす工夫:
 * - 申請者は社員マスタから選ぶだけ (部署は自動表示・再入力不要)
 * - 件名・内容から自動分類し、カテゴリ・優先度を候補で自動入力
 * - カテゴリに応じて担当者・対応期限 (SLA) を自動入力
 * - 担当者が手で変えた項目は以後自動で上書きしない (利用者の判断を優先)
 */
import { useEffect, useMemo, useState } from 'react';
import { useAppData } from '../../app/AppData';
import { classifyInquiry, type ClassificationResult } from '../../domain/helpdesk/classifier';
import { addBusinessDays, type InquiryInput } from '../../domain/helpdesk/inquiry';
import { maskSecrets } from '../../domain/helpdesk/secrets';
import { PRIORITIES, PRIORITY_LABEL, type ClassificationSnapshot, type Priority } from '../../domain/types';
import type { FieldErrors } from '../../domain/validation';
import { SelectField, TextAreaField, TextField } from '../../ui/primitives';
import { ClassificationPanel, SecretWarning } from './parts';

export interface InquiryFormState {
  input: InquiryInput;
  touched: { categoryId: boolean; priority: boolean; assignee: boolean; dueDate: boolean };
}

export function emptyInquiryForm(today: string, requesterId: string | null = null): InquiryFormState {
  return {
    input: { requesterId, title: '', body: '', categoryId: '', priority: 'medium', assignee: '', dueDate: addBusinessDays(today, 3) },
    touched: { categoryId: false, priority: false, assignee: false, dueDate: false },
  };
}

/** 入力が分類に影響する変化をしたときだけ再分類する (入力中の過剰な計算を避ける) */
export function useClassification(title: string, body: string): ClassificationResult | null {
  const { data } = useAppData();
  const [result, setResult] = useState<ClassificationResult | null>(null);
  useEffect(() => {
    if (!title.trim() && !body.trim()) {
      setResult(null);
      return;
    }
    const t = setTimeout(() => setResult(classifyInquiry(title, body, data.inquiryCategories)), 250);
    return () => clearTimeout(t);
  }, [title, body, data.inquiryCategories]);
  return result;
}

export function toClassificationSnapshot(result: ClassificationResult | null, input: InquiryInput): ClassificationSnapshot | null {
  if (!result) return null;
  return {
    suggestedCategoryId: result.categoryId,
    suggestedPriority: result.priority,
    needsReview: result.needsReview,
    categoryAccepted: input.categoryId === result.categoryId,
    priorityAccepted: input.priority === result.priority,
    reasons: result.reasons,
  };
}

export function InquiryFormFields({
  state,
  setState,
  errors,
  classification,
  showClassification = true,
}: {
  state: InquiryFormState;
  setState: (updater: (s: InquiryFormState) => InquiryFormState) => void;
  errors: FieldErrors<InquiryInput>;
  classification: ClassificationResult | null;
  showClassification?: boolean;
}) {
  const { data, deptById, empById, today } = useAppData();
  const { input, touched } = state;
  const categories = data.inquiryCategories;
  const enabledCats = categories.filter((c) => c.enabled || c.id === input.categoryId);

  // 自動分類の結果を、担当者が触っていない項目にだけ反映する
  useEffect(() => {
    if (!classification || !showClassification) return;
    setState((s) => {
      const next = { ...s.input };
      if (!s.touched.categoryId) next.categoryId = classification.categoryId;
      if (!s.touched.priority) next.priority = classification.priority;
      return next.categoryId === s.input.categoryId && next.priority === s.input.priority ? s : { ...s, input: next };
    });
  }, [classification, showClassification, setState]);

  // カテゴリが決まったら既定の担当者・期限を反映 (触っていない場合のみ)
  useEffect(() => {
    const cat = categories.find((c) => c.id === input.categoryId);
    if (!cat) return;
    setState((s) => {
      const next = { ...s.input };
      if (!s.touched.assignee && cat.defaultAssignee) next.assignee = cat.defaultAssignee;
      if (!s.touched.dueDate) next.dueDate = addBusinessDays(today, cat.slaBusinessDays);
      return next.assignee === s.input.assignee && next.dueDate === s.input.dueDate ? s : { ...s, input: next };
    });
  }, [input.categoryId, categories, today, setState]);

  const set = <K extends keyof InquiryInput>(key: K, value: InquiryInput[K], touch = false) =>
    setState((s) => ({ input: { ...s.input, [key]: value }, touched: touch ? { ...s.touched, [key]: true } : s.touched }));

  const groupedEmployees = useMemo(
    () =>
      data.departments.map((d) => ({
        dept: d,
        employees: data.employees
          .filter((e) => e.departmentId === d.id && (e.status !== 'retired' || e.id === input.requesterId))
          .sort((a, b) => a.employeeNumber.localeCompare(b.employeeNumber)),
      })),
    [data.departments, data.employees, input.requesterId],
  );
  const requester = input.requesterId ? empById.get(input.requesterId) : undefined;
  const assignees = useMemo(
    () => {
      // 候補 = カテゴリの既定担当者 + 担当部署 (カテゴリの既定部署) に所属する在籍社員
      const depts = new Set(categories.map((c) => c.defaultDepartmentId));
      const staff = data.employees.filter((e) => e.status === 'active' && depts.has(e.departmentId)).map((e) => e.name);
      return [...new Set([...categories.map((c) => c.defaultAssignee), ...staff])].filter(Boolean);
    },
    [categories, data.employees],
  );

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <label htmlFor="inq-requester" className="mb-1.5 flex items-center gap-1 text-[13px] font-semibold text-slate-700 dark:text-slate-200">
          申請者<span className="text-red-500" aria-hidden>*</span>
        </label>
        <select
          id="inq-requester"
          value={input.requesterId ?? ''}
          onChange={(e) => set('requesterId', e.target.value || null)}
          aria-invalid={!!errors.requesterId}
          className={`block h-11 w-full rounded-lg border bg-white px-3 pr-8 shadow-sm dark:bg-navy-950 ${errors.requesterId ? 'border-red-400' : 'border-slate-300 dark:border-navy-700'}`}
        >
          <option value="">社員を選択してください</option>
          {groupedEmployees
            .filter((g) => g.employees.length)
            .map((g) => (
              <optgroup key={g.dept.id} label={g.dept.name}>
                {g.employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}（{e.employeeNumber}）
                  </option>
                ))}
              </optgroup>
            ))}
        </select>
        <p className={`mt-1 text-xs ${errors.requesterId ? 'text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400'}`}>
          {errors.requesterId ?? (requester ? `所属：${deptById.get(requester.departmentId)?.name ?? '不明'}${requester.position ? `・${requester.position}` : ''}（社員情報から自動入力）` : '社員管理に登録された社員から選びます')}
        </p>
      </div>
      <TextField
        label="件名"
        required
        value={input.title}
        onChange={(e) => set('title', e.target.value)}
        error={errors.title}
        placeholder="例：Googleにログインできない"
        maxLength={100}
        wrapClassName="sm:col-span-2"
        autoComplete="off"
      />
      <div className="sm:col-span-2">
        <TextAreaField
          label="詳細内容"
          value={input.body}
          onChange={(e) => set('body', e.target.value)}
          error={errors.body}
          placeholder="いつから・どの端末で・何をすると・どうなるか（パスワードは書かないでください）"
          rows={4}
          maxLength={4000}
        />
        <SecretWarning text={`${input.title}\n${input.body}`} onMask={() => setState((s) => ({ ...s, input: { ...s.input, title: maskSecrets(s.input.title), body: maskSecrets(s.input.body) } }))} />
      </div>

      {showClassification && (
        <div className="sm:col-span-2">
          <ClassificationPanel
            result={classification}
            categories={categories}
            categoryOverridden={!!classification && touched.categoryId && input.categoryId !== classification.categoryId}
            priorityOverridden={!!classification && touched.priority && input.priority !== classification.priority}
            onApply={() =>
              classification &&
              setState((s) => ({
                input: { ...s.input, categoryId: classification.categoryId, priority: classification.priority },
                touched: { ...s.touched, categoryId: false, priority: false },
              }))
            }
          />
        </div>
      )}

      <SelectField
        label="カテゴリ"
        required
        value={input.categoryId}
        onChange={(e) => set('categoryId', e.target.value, true)}
        options={enabledCats.map((c) => ({ value: c.id, label: c.name }))}
        placeholder="選択してください"
        error={errors.categoryId}
      />
      <SelectField
        label="優先度"
        required
        value={input.priority}
        onChange={(e) => set('priority', e.target.value as Priority, true)}
        options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))}
        error={errors.priority}
      />
      <TextField
        label="対応担当者"
        value={input.assignee}
        onChange={(e) => set('assignee', e.target.value, true)}
        error={errors.assignee}
        list="inq-assignees"
        hint={touched.assignee ? undefined : 'カテゴリの既定担当者を自動入力'}
        maxLength={50}
      />
      <datalist id="inq-assignees">
        {assignees.map((a) => (
          <option key={a} value={a} />
        ))}
      </datalist>
      <TextField
        label="対応期限"
        required
        type="date"
        value={input.dueDate}
        onChange={(e) => set('dueDate', e.target.value, true)}
        error={errors.dueDate}
        hint={touched.dueDate ? undefined : 'カテゴリの標準対応日数（営業日）から自動計算'}
      />
    </div>
  );
}
