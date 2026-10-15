import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Save } from 'lucide-react';
import { useAppData } from '../app/AppData';
import { EMPLOYEE_STATUSES, EMPLOYEE_STATUS_LABEL, EMPLOYMENT_TYPES, type Employee, type EmployeeStatus, type EmploymentType } from '../domain/types';
import { normalizeEmployeeNumber, suggestEmployeeStatus, validateEmployee, type EmployeeInput, type FieldErrors } from '../domain/validation';
import { AppError } from '../services/workcoreService';
import { Modal, ModalCancelButton } from '../ui/Modal';
import { Button, SelectField, TextAreaField, TextField } from '../ui/primitives';
import { EmailField, PhoneField, PostalAddressFields, SuggestField, emptyAddress, finalizePhone } from '../ui/SmartInputs';
import type { EmployeeContact } from '../domain/types';

const emptyContact = (): EmployeeContact => ({ email: '', phone: '', ...emptyAddress() });

/** 既存の社員番号から次の番号を提案する (例: A0104 → A0105) */
function suggestNextNumber(employees: Employee[]): string {
  let best: { prefix: string; n: number; width: number } | null = null;
  for (const e of employees) {
    const m = /^([A-Z-]*)(\d+)$/.exec(e.employeeNumber);
    if (!m) continue;
    const n = Number(m[2]);
    if (!best || n > best.n) best = { prefix: m[1] ?? '', n, width: m[2]!.length };
  }
  if (!best) return 'A0001';
  return `${best.prefix}${String(best.n + 1).padStart(best.width, '0')}`;
}

export function EmployeeFormModal({
  open,
  onClose,
  employee,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  employee?: Employee;
  onSaved?: (e: Employee, isNew: boolean) => void;
}) {
  const { data, run, today } = useAppData();
  const deptOptions = data.departments.map((d) => ({ value: d.id, label: d.name }));

  const initial = useMemo<EmployeeInput>(
    () =>
      employee
        ? {
            employeeNumber: employee.employeeNumber,
            name: employee.name,
            departmentId: employee.departmentId,
            position: employee.position,
            employmentType: employee.employmentType,
            hireDate: employee.hireDate,
            retireDate: employee.retireDate,
            status: employee.status,
            notes: employee.notes,
            contact: { ...emptyContact(), ...employee.contact },
          }
        : {
            employeeNumber: suggestNextNumber(data.employees),
            name: '',
            departmentId: '',
            position: '',
            employmentType: '正社員',
            hireDate: '',
            retireDate: null,
            status: 'pending',
            notes: '',
            contact: emptyContact(),
          },
    // モーダルを開くたびに初期化する (open を依存に含める)
    [employee, open, data.employees],
  );

  const [form, setForm] = useState<EmployeeInput>(initial);
  const [errors, setErrors] = useState<FieldErrors<EmployeeInput>>({});
  const [statusTouched, setStatusTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  // 連絡先欄の開閉は利用者の操作に任せる (入力を消しても勝手に閉じない)
  const [contactOpen, setContactOpen] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(initial);
      setErrors({});
      setStatusTouched(!!employee);
      setContactOpen(Object.values(initial.contact ?? {}).some(Boolean));
    }
  }, [open, initial, employee]);

  const set = <K extends keyof EmployeeInput>(key: K, value: EmployeeInput[K]) => {
    setForm((f) => {
      const next = { ...f, [key]: value };
      // ステータスを手動で選んでいなければ、入社日・退職日から自動判定する
      if (!statusTouched && (key === 'hireDate' || key === 'retireDate')) next.status = suggestEmployeeStatus(next.hireDate, next.retireDate, today);
      return next;
    });
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  // 社員番号の重複はその場で警告する
  const dupWarning = useMemo(() => {
    const n = normalizeEmployeeNumber(form.employeeNumber);
    if (!n) return undefined;
    const dup = data.employees.find((e) => e.id !== employee?.id && normalizeEmployeeNumber(e.employeeNumber) === n);
    return dup ? `社員番号「${n}」は ${dup.name} さんが使用中です` : undefined;
  }, [form.employeeNumber, data.employees, employee]);
  // 同姓同名は登録できるが、二重登録の可能性を知らせる (空白の有無は区別しない)
  const nameWarning = useMemo(() => {
    const n = form.name.replace(/[\s　]/g, '');
    if (!n || employee) return undefined;
    const dup = data.employees.find((e) => e.name.replace(/[\s　]/g, '') === n);
    return dup ? `同じ氏名の社員がいます（${dup.employeeNumber}・${data.departments.find((d) => d.id === dup.departmentId)?.name ?? ''}）。二重登録でないか確認してください` : undefined;
  }, [form.name, data.employees, data.departments, employee]);
  const contact = form.contact ?? emptyContact();
  // 住所検索は非同期で終わるため、その間に入力された他の項目を消さないよう常に最新の値に重ねる
  const setContact = (patch: Partial<EmployeeContact>) => setForm((f) => ({ ...f, contact: { ...emptyContact(), ...f.contact, ...patch } }));

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const phone = await finalizePhone(form.contact?.phone ?? '');
    const input: EmployeeInput = form.contact ? { ...form, contact: { ...form.contact, phone } } : form;
    if (form.contact && phone !== form.contact.phone) setContact({ phone });
    const v = validateEmployee(input, { existing: data.employees, departmentIds: data.departments.map((d) => d.id), selfId: employee?.id });
    if (!v.ok) {
      setErrors(v.errors);
      return;
    }
    setSaving(true);
    try {
      const saved = await run(
        (s) => (employee ? s.updateEmployee(employee.id, input) : s.createEmployee(input)),
        employee ? '社員情報を更新しました' : `${input.name.trim()}さんを登録しました`,
      );
      onClose();
      onSaved?.(saved, !employee);
    } catch (e) {
      if (e instanceof AppError) setErrors(e.fieldErrors as FieldErrors<EmployeeInput>);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      dirty={JSON.stringify(form) !== JSON.stringify(initial)}
      title={employee ? '社員情報の編集' : '社員の新規登録'}
      description={employee ? undefined : '入社予定者を登録すると、入社準備タスクを自動生成できます'}
      footer={
        <>
          <ModalCancelButton disabled={saving} />
          <Button type="submit" form="employee-form" icon={Save} loading={saving}>
            {employee ? '更新する' : '登録する'}
          </Button>
        </>
      }
    >
      <form id="employee-form" onSubmit={submit} noValidate className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField
          label="社員番号"
          required
          value={form.employeeNumber}
          onChange={(e) => set('employeeNumber', e.target.value)}
          error={errors.employeeNumber ?? dupWarning}
          hint="半角英数字・ハイフン（重複不可）"
          autoComplete="off"
          autoCapitalize="characters"
          inputMode="text"
        />
        <TextField label="氏名" required value={form.name} onChange={(e) => set('name', e.target.value)} error={errors.name} hint={nameWarning} placeholder="例：山田 太郎" autoComplete="off" />
        <SelectField
          label="所属部署"
          required
          value={form.departmentId}
          onChange={(e) => set('departmentId', e.target.value)}
          options={deptOptions}
          placeholder="選択してください"
          error={errors.departmentId}
        />
        <SuggestField label="役職" value={form.position} onChange={(v) => set('position', v)} error={errors.position} placeholder="例：主任（任意）" options={data.employees.map((e) => e.position)} />
        <SelectField
          label="雇用区分"
          required
          value={form.employmentType}
          onChange={(e) => set('employmentType', e.target.value as EmploymentType)}
          options={EMPLOYMENT_TYPES.map((t) => ({ value: t, label: t }))}
          error={errors.employmentType}
        />
        <SelectField
          label="在籍ステータス"
          required
          value={form.status}
          onChange={(e) => {
            setStatusTouched(true);
            set('status', e.target.value as EmployeeStatus);
          }}
          options={EMPLOYEE_STATUSES.map((s) => ({ value: s, label: EMPLOYEE_STATUS_LABEL[s] }))}
          error={errors.status}
          hint={statusTouched ? undefined : '入社日・退職日から自動判定します'}
        />
        <TextField label="入社日" required type="date" value={form.hireDate} onChange={(e) => set('hireDate', e.target.value)} error={errors.hireDate} />
        <TextField
          label="退職日"
          type="date"
          value={form.retireDate ?? ''}
          onChange={(e) => set('retireDate', e.target.value || null)}
          error={errors.retireDate}
          hint="在籍中は空欄"
        />
        <details open={contactOpen || !!errors.contact} onToggle={(e) => setContactOpen(e.currentTarget.open)} className="rounded-xl border border-slate-200 p-3 sm:col-span-2 dark:border-navy-700" data-testid="contact-section">
          <summary className="flex min-h-10 cursor-pointer items-center text-sm font-semibold">連絡先・住所（任意）</summary>
          {errors.contact && (
            <p className="mb-2 text-xs text-red-600 dark:text-red-400" role="alert">
              {errors.contact}
            </p>
          )}
          <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <PhoneField label="電話番号" value={contact.phone} onChange={(v) => setContact({ phone: v })} testId="employee-phone" />
            <EmailField label="メールアドレス" value={contact.email} onChange={(v) => setContact({ email: v })} testId="employee-email" />
            <div className="sm:col-span-2">
              <PostalAddressFields value={contact} onChange={(a) => setContact({ postalCode: a.postalCode, prefecture: a.prefecture, city: a.city, town: a.town, addressLine: a.addressLine })} idPrefix="employee-addr" />
            </div>
          </div>
        </details>
        <TextAreaField label="備考" value={form.notes} onChange={(e) => set('notes', e.target.value)} error={errors.notes} wrapClassName="sm:col-span-2" maxLength={1000} />
      </form>
    </Modal>
  );
}
