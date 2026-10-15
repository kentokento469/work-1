/**
 * スマート入力の共通部品 (Phase 5)。社員・仕入先・品目・発注書・書類などで同じ入力体験にする。
 *
 * 共通の約束
 * - 入力中は値を勝手に書き換えない (カーソルが飛ばない)。整形は入力欄を離れたとき・貼り付けたとき
 * - 日本語入力 (IME) の変換中は何もしない
 * - エラー・注意は入力欄を離れた後だけ表示する (入力途中に赤字を出さない)
 * - 保存は文字列のまま (電話番号は 090-1234-5678、郵便番号は 7桁の数字)
 */
import { useEffect, useId, useRef, useState, type ClipboardEvent, type InputHTMLAttributes } from 'react';
import { Loader2, MapPin, RotateCcw } from 'lucide-react';
import { formatThousands, isEmail, normalizeEmail, parseInteger, toHalfWidth } from '../domain/input/normalize';
import { browserPostalFetcher, formatPostal, lookupPostal, normalizePostal, PREFECTURES, type AddressCandidate } from '../domain/input/postal';
import { FieldWrap, inputClass } from './primitives';

type BaseProps = {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  /** 保存時などに外から渡すエラー (入力欄を離れる前でも表示) */
  error?: string;
  hint?: string;
  wrapClassName?: string;
  testId?: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'id'>;

/** IME 変換中かどうか (変換中の onChange では整形しない) */
function useComposing() {
  const composing = useRef(false);
  return {
    composing,
    handlers: {
      onCompositionStart: () => (composing.current = true),
      onCompositionEnd: () => (composing.current = false),
    },
  };
}

// ---------------------------------------------------------------------------
// 電話番号
// ---------------------------------------------------------------------------

/**
 * 電話番号。iPhone では電話番号用キーボード (type=tel)。
 * 入力中は全角→半角だけ行い、入力欄を離れた時・貼り付けた時に市外局番に応じて整形する。
 */
export function PhoneField({ label, value, onChange, required, error, hint, wrapClassName, testId, ...rest }: BaseProps) {
  const [note, setNote] = useState<{ text: string; warn: boolean } | null>(null);
  const { composing, handlers } = useComposing();
  const apply = async (raw: string) => {
    const { formatPhone, PHONE_KIND_LABEL } = await import('../domain/input/phone');
    const r = formatPhone(raw);
    onChange(r.value);
    if (!r.value) setNote(null);
    else if (r.valid) setNote({ text: r.kind ? PHONE_KIND_LABEL[r.kind] : '', warn: false });
    else setNote({ text: '電話番号の桁数・形式を確認してください（例：090-1234-5678、03-1234-5678）。このままでも保存できます', warn: true });
  };
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (!text) return;
    e.preventDefault();
    void apply(text);
  };
  return (
    <FieldWrap label={label} required={required} error={error ?? (note?.warn ? note.text : undefined)} hint={hint ?? (note && !note.warn ? note.text : '数字だけで入力できます（ハイフンは自動）')} className={wrapClassName}>
      {(id, desc) => (
        <input
          id={id}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          aria-describedby={desc}
          aria-invalid={!!error || !!note?.warn}
          value={value}
          onChange={(e) => {
            const v = e.target.value;
            // 変換中・入力中は全角数字だけ半角にする (位置は変わらないので、カーソルは動かない)
            onChange(composing.current ? v : toHalfWidth(v));
            if (note) setNote(null);
          }}
          onBlur={() => value && void apply(value)}
          onPaste={onPaste}
          className={inputClass(!!error || !!note?.warn, 'tabular-nums')}
          data-testid={testId}
          {...handlers}
          {...rest}
        />
      )}
    </FieldWrap>
  );
}

/**
 * 保存直前の電話番号の整形。入力直後に保存ボタンを押すと、欄を離れた時の整形 (非同期) より先に保存が始まるため、
 * 保存処理の中でも同じ整形をかける (形式が正しくない番号は入力どおり残す)
 */
export async function finalizePhone(raw: string): Promise<string> {
  if (!raw.trim()) return '';
  const { formatPhone } = await import('../domain/input/phone');
  return formatPhone(raw).value;
}

// ---------------------------------------------------------------------------
// メールアドレス
// ---------------------------------------------------------------------------

export function EmailField({ label, value, onChange, required, error, hint, wrapClassName, testId, ...rest }: BaseProps) {
  const [touched, setTouched] = useState(false);
  const invalid = touched && !!value.trim() && !isEmail(value);
  return (
    <FieldWrap label={label} required={required} error={error ?? (invalid ? 'メールアドレスの形式を確認してください（例：taro@example.co.jp）' : undefined)} hint={hint} className={wrapClassName}>
      {(id, desc) => (
        <input
          id={id}
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="off"
          spellCheck={false}
          aria-describedby={desc}
          aria-invalid={!!error || invalid}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => {
            setTouched(true);
            if (value) onChange(normalizeEmail(value));
          }}
          className={inputClass(!!error || invalid)}
          data-testid={testId}
          {...rest}
        />
      )}
    </FieldWrap>
  );
}

// ---------------------------------------------------------------------------
// 金額・数量
// ---------------------------------------------------------------------------

/**
 * 金額 (円) の入力。値は数字だけの文字列で受け渡す。
 * 入力欄を離れると 3桁区切りで表示し、編集中は入力したままの文字を表示する。全角・「¥」「円」「,」は自動で除き、
 * 数字として読めない文字が含まれる間は値を更新せず、入力欄を離れた時に注意を出す (直前の正しい値が残る)
 */
export function AmountField({ label, value, onChange, required, error, hint, wrapClassName, testId, unit = '円', ...rest }: BaseProps & { unit?: string }) {
  /** 入力中の文字 (編集中だけ持つ)。外へは、数字として解釈できた値だけを渡す */
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const { composing, handlers } = useComposing();
  const display = draft ?? (/^\d+$/.test(value) ? formatThousands(Number(value)) : value);
  return (
    <FieldWrap label={label} required={required} error={error ?? (invalid ? '数字で入力してください（例：12,345）' : undefined)} hint={hint} className={wrapClassName}>
      {(id, desc) => (
        <div className="relative">
          <input
            id={id}
            inputMode="numeric"
            autoComplete="off"
            aria-describedby={desc}
            aria-invalid={!!error || invalid}
            value={display}
            onFocus={() => setDraft(value)}
            onChange={(e) => {
              const v = composing.current ? e.target.value : toHalfWidth(e.target.value);
              setDraft(v);
              setInvalid(false);
              const r = parseInteger(v);
              if (!r.invalid) onChange(r.value === null ? '' : String(r.value));
            }}
            onBlur={() => {
              const r = parseInteger(draft ?? value);
              setInvalid(r.invalid);
              setDraft(null);
            }}
            className={inputClass(!!error || invalid, 'pr-9 text-right tabular-nums')}
            data-testid={testId}
            {...handlers}
            {...rest}
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400">{unit}</span>
        </div>
      )}
    </FieldWrap>
  );
}

// ---------------------------------------------------------------------------
// 既存データからの補完 (datalist: IME とぶつからない標準の候補表示)
// ---------------------------------------------------------------------------

export function SuggestField({ label, value, onChange, required, error, hint, wrapClassName, testId, options, ...rest }: BaseProps & { options: string[] }) {
  const listId = useId();
  const unique = [...new Set(options.map((o) => o.trim()).filter(Boolean))].slice(0, 200);
  return (
    <FieldWrap label={label} required={required} error={error} hint={hint} className={wrapClassName}>
      {(id, desc) => (
        <>
          <input id={id} list={listId} aria-describedby={desc} aria-invalid={!!error} value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" className={inputClass(!!error)} data-testid={testId} {...rest} />
          <datalist id={listId}>
            {unique.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        </>
      )}
    </FieldWrap>
  );
}

// ---------------------------------------------------------------------------
// 郵便番号 → 住所
// ---------------------------------------------------------------------------

export interface AddressValue {
  postalCode: string;
  prefecture: string;
  city: string;
  town: string;
  addressLine: string;
}
export const emptyAddress = (): AddressValue => ({ postalCode: '', prefecture: '', city: '', town: '', addressLine: '' });

type LookupState = { status: 'idle' } | { status: 'loading' } | { status: 'choose'; candidates: AddressCandidate[] } | { status: 'suggest'; candidate: AddressCandidate } | { status: 'not_found' } | { status: 'error'; message: string } | { status: 'filled'; candidate: AddressCandidate };

/**
 * 郵便番号を7桁入力すると住所を検索して補完する。
 * - 住所欄を手で入力・修正していた場合は上書きせず、「この住所を使う」で選べる候補として出す
 * - 候補が複数あれば選択肢を表示。見つからない・通信できない場合も手入力で続けられる
 */
export function PostalAddressFields({ value, onChange, idPrefix = 'addr' }: { value: AddressValue; onChange: (v: AddressValue) => void; idPrefix?: string }) {
  const [state, setState] = useState<LookupState>({ status: 'idle' });
  /** 利用者が手で入力した住所欄 (初期値がある欄も「入力済み」として扱い、上書きしない) */
  const edited = useRef<Set<keyof AddressValue>>(new Set((['prefecture', 'city', 'town'] as const).filter((k) => value[k])));
  const lastLooked = useRef<string | null>(normalizePostal(value.postalCode));
  const valueRef = useRef(value);
  valueRef.current = value;

  const fill = (c: AddressCandidate, force: boolean) => {
    const v = valueRef.current;
    const next = { ...v };
    for (const k of ['prefecture', 'city', 'town'] as const) if (force || !edited.current.has(k) || !v[k]) next[k] = c[k];
    if (force) for (const k of ['prefecture', 'city', 'town'] as const) edited.current.delete(k);
    onChange(next);
    setState({ status: 'filled', candidate: c });
  };

  const search = async (code: string) => {
    lastLooked.current = code;
    setState({ status: 'loading' });
    const r = await lookupPostal(code, browserPostalFetcher);
    if (lastLooked.current !== code) return; // 入力が変わった
    if (r.status === 'error') return setState({ status: 'error', message: r.message });
    if (r.status === 'not_found') return setState({ status: 'not_found' });
    if (r.candidates.length > 1) return setState({ status: 'choose', candidates: r.candidates });
    const c = r.candidates[0]!;
    const v = valueRef.current;
    const conflicts = (['prefecture', 'city', 'town'] as const).some((k) => edited.current.has(k) && v[k] && v[k] !== c[k]);
    if (conflicts) setState({ status: 'suggest', candidate: c });
    else fill(c, false);
  };

  useEffect(() => {
    const code = normalizePostal(value.postalCode);
    if (code && code !== lastLooked.current) void search(code);
    if (!code) {
      lastLooked.current = null;
      if (state.status !== 'idle') setState({ status: 'idle' });
    }
  }, [value.postalCode]);

  const set = (k: keyof AddressValue, v: string) => {
    if (k !== 'postalCode' && k !== 'addressLine') edited.current.add(k);
    onChange({ ...valueRef.current, [k]: v });
  };
  const label = (c: AddressCandidate) => `${c.prefecture}${c.city}${c.town}`;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid={`${idPrefix}-fields`}>
      <FieldWrap label="郵便番号" hint="7桁を入力すると住所を補完します（ハイフンなしで可）">
        {(id, desc) => (
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">〒</span>
            <input
              id={id}
              inputMode="numeric"
              autoComplete="postal-code"
              aria-describedby={desc}
              value={value.postalCode}
              onChange={(e) => set('postalCode', toHalfWidth(e.target.value).replace(/[^\d-]/g, '').slice(0, 8))}
              onBlur={() => {
                const d = normalizePostal(value.postalCode);
                if (d) set('postalCode', formatPostal(d));
              }}
              placeholder="例：2540822"
              className={inputClass(false, 'pl-8 tabular-nums')}
              data-testid={`${idPrefix}-postal`}
            />
          </div>
        )}
      </FieldWrap>
      <div className="sm:self-end" aria-live="polite" data-testid={`${idPrefix}-lookup`}>
        {state.status === 'loading' && (
          <p className="flex min-h-11 items-center gap-1.5 text-sm text-slate-500">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            住所を検索中…
          </p>
        )}
        {state.status === 'filled' && (
          <p className="flex min-h-11 items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400">
            <MapPin className="size-4" aria-hidden />
            住所を補完しました。番地・建物名を入力してください
          </p>
        )}
        {state.status === 'not_found' && <p className="flex min-h-11 items-center text-sm text-amber-700 dark:text-amber-400">該当する住所が見つかりません。住所を手入力してください</p>}
        {state.status === 'error' && (
          <p className="flex min-h-11 flex-wrap items-center gap-2 text-sm text-amber-700 dark:text-amber-400" role="alert">
            住所データを取得できませんでした（通信状況を確認してください）。手入力で続けられます
            <button type="button" className="inline-flex min-h-9 items-center gap-1 font-semibold underline" onClick={() => void search(normalizePostal(value.postalCode)!)}>
              <RotateCcw className="size-3.5" aria-hidden />
              再検索
            </button>
          </p>
        )}
      </div>
      {state.status === 'choose' && (
        <fieldset className="rounded-xl border border-navy-200 bg-navy-50/50 p-3 sm:col-span-2 dark:border-navy-700 dark:bg-navy-900" data-testid={`${idPrefix}-candidates`}>
          <legend className="px-1 text-xs font-semibold">この郵便番号には複数の住所があります。選んでください</legend>
          {state.candidates.map((c) => (
            <button key={label(c)} type="button" onClick={() => fill(c, true)} className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-white dark:hover:bg-navy-800">
              <MapPin className="size-4 text-navy-600" aria-hidden />
              {label(c) || '（町域なし）'}
            </button>
          ))}
        </fieldset>
      )}
      {state.status === 'suggest' && (
        <p className="flex flex-wrap items-center gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900 sm:col-span-2 dark:bg-amber-950/40 dark:text-amber-100" data-testid={`${idPrefix}-suggest`}>
          入力済みの住所と異なります。郵便番号の住所：<strong>{label(state.candidate)}</strong>
          <button type="button" className="min-h-9 rounded-lg bg-white px-3 font-semibold text-navy-700 dark:bg-navy-900 dark:text-navy-100" onClick={() => fill(state.candidate, true)}>
            この住所を使う
          </button>
        </p>
      )}
      <FieldWrap label="都道府県">
        {(id) => (
          <select id={id} value={value.prefecture} onChange={(e) => set('prefecture', e.target.value)} className={inputClass(false, 'pr-8')} autoComplete="address-level1" data-testid={`${idPrefix}-prefecture`}>
            <option value="">選択してください</option>
            {PREFECTURES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        )}
      </FieldWrap>
      <FieldWrap label="市区町村">
        {(id) => <input id={id} value={value.city} onChange={(e) => set('city', e.target.value)} autoComplete="address-level2" className={inputClass(false)} data-testid={`${idPrefix}-city`} />}
      </FieldWrap>
      <FieldWrap label="町域">
        {(id) => <input id={id} value={value.town} onChange={(e) => set('town', e.target.value)} autoComplete="address-level3" className={inputClass(false)} data-testid={`${idPrefix}-town`} />}
      </FieldWrap>
      <FieldWrap label="番地・建物名" hint="例：1-2-3 ○○ビル 4階">
        {(id, desc) => <input id={id} aria-describedby={desc} value={value.addressLine} onChange={(e) => set('addressLine', e.target.value)} autoComplete="address-line2" className={inputClass(false)} data-testid={`${idPrefix}-line`} />}
      </FieldWrap>
    </div>
  );
}

/** 住所を1行の表示用文字列に */
export const formatAddress = (a: Partial<AddressValue>) => [a.postalCode ? `〒${a.postalCode}` : '', `${a.prefecture ?? ''}${a.city ?? ''}${a.town ?? ''}${a.addressLine ? ` ${a.addressLine}` : ''}`.trim()].filter(Boolean).join(' ');
