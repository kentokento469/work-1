import { forwardRef, useId, useState, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { SlidersHorizontal, type LucideIcon } from 'lucide-react';

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

// ---------- Button ----------

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const VARIANT: Record<Variant, string> = {
  primary: 'bg-navy-800 text-white hover:bg-navy-700 active:bg-navy-900 dark:bg-navy-500 dark:hover:bg-navy-400 shadow-sm',
  secondary:
    'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 active:bg-slate-100 dark:bg-navy-900 dark:text-slate-100 dark:border-navy-700 dark:hover:bg-navy-800',
  ghost: 'text-slate-600 hover:bg-slate-100 active:bg-slate-200 dark:text-slate-300 dark:hover:bg-navy-800',
  danger: 'bg-red-600 text-white hover:bg-red-500 active:bg-red-700 shadow-sm',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md';
  icon?: LucideIcon;
  loading?: boolean;
  block?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', icon: Icon, loading, block, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cx(
        'inline-flex select-none items-center justify-center gap-2 rounded-lg font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy-500 disabled:cursor-not-allowed disabled:opacity-50',
        size === 'md' ? 'min-h-11 px-4 text-sm' : 'min-h-9 px-3 text-[13px]',
        VARIANT[variant],
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? (
        <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
      ) : (
        Icon && <Icon className="size-4 shrink-0" aria-hidden />
      )}
      {children}
    </button>
  );
});

export function IconButton({ icon: Icon, label, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 active:bg-slate-200 dark:text-slate-400 dark:hover:bg-navy-800 dark:hover:text-slate-100',
        className,
      )}
      {...rest}
    >
      <Icon className="size-5" aria-hidden />
    </button>
  );
}

// ---------- Card ----------

export function Card({
  className,
  children,
  as: Tag = 'section',
  ...rest
}: { className?: string; children: ReactNode; as?: 'section' | 'div' | 'article' } & Omit<HTMLAttributes<HTMLElement>, 'className' | 'children'>) {
  return (
    <Tag className={cx('min-w-0 rounded-2xl border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(15,31,61,0.04)] dark:border-navy-800 dark:bg-navy-900', className)} {...rest}>
      {children}
    </Tag>
  );
}

export function CardHeader({ title, icon: Icon, action, description }: { title: string; icon?: LucideIcon; action?: ReactNode; description?: string }) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 pt-4 sm:px-5 sm:pt-5">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-[15px] font-bold text-slate-800 dark:text-slate-100">
          {Icon && <Icon className="size-4 text-navy-500 dark:text-navy-300" aria-hidden />}
          {title}
        </h2>
        {description && <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{description}</p>}
      </div>
      {action}
    </div>
  );
}

// ---------- Badge ----------

export type Tone = 'gray' | 'navy' | 'blue' | 'green' | 'amber' | 'red' | 'violet';
const TONE: Record<Tone, string> = {
  gray: 'bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700',
  navy: 'bg-navy-50 text-navy-800 ring-navy-200 dark:bg-navy-800 dark:text-navy-100 dark:ring-navy-700',
  blue: 'bg-blue-50 text-blue-800 ring-blue-200 dark:bg-blue-950 dark:text-blue-200 dark:ring-blue-900',
  green: 'bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-900',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-900',
  red: 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-950 dark:text-red-200 dark:ring-red-900',
  violet: 'bg-violet-50 text-violet-800 ring-violet-200 dark:bg-violet-950 dark:text-violet-200 dark:ring-violet-900',
};

export function Badge({ tone = 'gray', children, icon: Icon, className }: { tone?: Tone; children: ReactNode; icon?: LucideIcon; className?: string }) {
  return (
    <span className={cx('inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset', TONE[tone], className)}>
      {Icon && <Icon className="size-3" aria-hidden />}
      {children}
    </span>
  );
}

// ---------- Form fields ----------

const fieldBase =
  'block w-full rounded-lg border bg-white px-3 text-slate-900 shadow-sm transition-colors placeholder:text-slate-400 focus:outline-none focus:ring-2 dark:bg-navy-950 dark:text-slate-100';
const fieldOk = 'border-slate-300 focus:border-navy-500 focus:ring-navy-500/25 dark:border-navy-700';
const fieldErr = 'border-red-400 focus:border-red-500 focus:ring-red-500/25 dark:border-red-700';

interface FieldWrapProps {
  label: string;
  required?: boolean;
  error?: string;
  hint?: string;
  children: (id: string, describedBy: string | undefined) => ReactNode;
  className?: string;
}

export function FieldWrap({ label, required, error, hint, children, className }: FieldWrapProps) {
  const id = useId();
  const descId = error || hint ? `${id}-desc` : undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 flex items-center gap-1 text-[13px] font-semibold text-slate-700 dark:text-slate-200">
        {label}
        {required && <span className="text-red-500" aria-hidden>*</span>}
        {required && <span className="sr-only">（必須）</span>}
      </label>
      {children(id, descId)}
      {(error || hint) && (
        <p id={descId} className={cx('mt-1 text-xs', error ? 'text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400')}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> & { label: string; error?: string; hint?: string; wrapClassName?: string };

export function TextField({ label, error, hint, required, wrapClassName, className, ...rest }: TextFieldProps) {
  return (
    <FieldWrap label={label} required={required} error={error} hint={hint} className={wrapClassName}>
      {(id, desc) => (
        <input
          id={id}
          aria-invalid={!!error}
          aria-describedby={desc}
          required={required}
          className={cx(fieldBase, 'h-11', error ? fieldErr : fieldOk, className)}
          {...rest}
        />
      )}
    </FieldWrap>
  );
}

type SelectFieldProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> & {
  label: string;
  error?: string;
  hint?: string;
  options: { value: string; label: string }[];
  placeholder?: string;
  wrapClassName?: string;
};

export function SelectField({ label, error, hint, required, options, placeholder, wrapClassName, className, ...rest }: SelectFieldProps) {
  return (
    <FieldWrap label={label} required={required} error={error} hint={hint} className={wrapClassName}>
      {(id, desc) => (
        <select id={id} aria-invalid={!!error} aria-describedby={desc} required={required} className={cx(fieldBase, 'h-11 pr-8', error ? fieldErr : fieldOk, className)} {...rest}>
          {placeholder !== undefined && <option value="">{placeholder}</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </FieldWrap>
  );
}

type TextAreaFieldProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> & { label: string; error?: string; hint?: string; wrapClassName?: string };

export function TextAreaField({ label, error, hint, required, wrapClassName, className, ...rest }: TextAreaFieldProps) {
  return (
    <FieldWrap label={label} required={required} error={error} hint={hint} className={wrapClassName}>
      {(id, desc) => (
        <textarea id={id} aria-invalid={!!error} aria-describedby={desc} rows={3} className={cx(fieldBase, 'py-2.5', error ? fieldErr : fieldOk, className)} {...rest} />
      )}
    </FieldWrap>
  );
}

/** フィルターバー用のコンパクトなセレクト */
export function FilterSelect({
  label,
  value,
  onChange,
  options,
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  className?: string;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cx(fieldBase, fieldOk, 'h-11 min-w-0 pr-8 text-sm', className)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// ---------- Misc ----------

export function EmptyState({ icon: Icon, title, description, action }: { icon: LucideIcon; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-slate-100 text-slate-400 dark:bg-navy-800 dark:text-slate-500">
        <Icon className="size-6" aria-hidden />
      </div>
      <p className="mt-3 font-semibold text-slate-700 dark:text-slate-200">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-slate-500 dark:text-slate-400">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl dark:text-white">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/**
 * 詳細フィルターの折りたたみ (段階的開示)。
 * スマホでは検索欄だけを常に表示し、条件は「絞り込み」から開く。PCでは常に展開する。
 * 条件が設定されている場合は件数を表示し、隠れた条件で結果が絞られていることに気づけるようにする。
 */
export function FilterDisclosure({ activeCount, children, className }: { activeCount: number; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(activeCount > 0);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-600 md:hidden dark:border-navy-700 dark:bg-navy-950 dark:text-slate-300"
      >
        <SlidersHorizontal className="size-4" aria-hidden />
        絞り込み
        {activeCount > 0 && <span className="rounded-full bg-navy-700 px-1.5 text-[11px] text-white">{activeCount}</span>}
      </button>
      <div className={cx(open ? 'grid' : 'hidden', 'grid-cols-2 gap-2 md:contents', className)}>{children}</div>
    </>
  );
}
