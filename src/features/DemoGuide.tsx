/**
 * 実演ガイド (ゲームの「操作しながら覚える」チュートリアルの考え方を応用)。
 * 説明文を読ませる代わりに、次にやる操作を1つずつ示し、実際に操作するとチェックが付く。
 * 進捗は操作履歴から判定するため、ガイド専用の状態管理を持たない。
 */
import { useState } from 'react';
import { CheckCircle2, ChevronDown, Circle, PlayCircle, X } from 'lucide-react';
import { useAppData } from '../app/AppData';
import type { ActivityLog } from '../domain/types';
import { Button, Card, cx } from '../ui/primitives';

const KEY = 'workcore-guide';

interface GuideState {
  startedAt: string | null;
  dismissed: boolean;
  analyticsSeen: boolean;
}

function load(): GuideState {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as GuideState | null;
    if (v) return v;
  } catch {
    /* 読めない場合は初期状態 */
  }
  return { startedAt: null, dismissed: false, analyticsSeen: false };
}
function save(s: GuideState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* 保存できなくても動作に影響しない */
  }
}

/** 分析画面を開いたことを記録する (HelpdeskAnalytics から呼ぶ) */
export function markAnalyticsSeen() {
  const s = load();
  if (s.startedAt && !s.analyticsSeen) save({ ...s, analyticsSeen: true });
}

const STEPS: { label: string; href: string; done: (a: ActivityLog) => boolean }[] = [
  { label: '問い合わせを登録する（自動分類・FAQ候補を確認）', href: '#/helpdesk/new', done: (a) => a.category === 'inquiry' && a.action === 'create' },
  { label: '問い合わせ詳細で「対応タスクを作成」し承認する', href: '#/helpdesk', done: (a) => a.category === 'inquiry' && a.action === 'tasks' },
  { label: 'タスク管理でタスクを「完了」にする', href: '#/tasks?source=inquiry', done: (a) => a.category === 'task' && a.message.includes('「完了」') },
  { label: '問い合わせを「解決済み」にする（解決内容を記録）', href: '#/helpdesk', done: (a) => a.category === 'inquiry' && a.action === 'status' && a.message.includes('解決済み') },
  { label: '申請者確認のうえ「完了」にする', href: '#/helpdesk?status=done', done: (a) => a.category === 'inquiry' && a.action === 'close' },
];

export function DemoGuide() {
  const { data } = useAppData();
  const [state, setState] = useState(load);
  const [open, setOpen] = useState(true);
  const update = (s: GuideState) => {
    save(s);
    setState(s);
  };
  if (state.dismissed) return null;

  if (!state.startedAt)
    return (
      <Card className="mb-4 flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
        <PlayCircle className="size-8 shrink-0 text-navy-600 dark:text-navy-300" aria-hidden />
        <div className="flex-1">
          <p className="font-semibold">はじめての方へ：ヘルプデスク業務を一通り体験する</p>
          <p className="text-xs text-slate-500">問い合わせ登録 → 自動分類 → タスク作成 → 完了 → 分析 の流れを、実際に操作しながら確認できます（約3分）。</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => update({ ...state, dismissed: true })}>
            表示しない
          </Button>
          <Button size="sm" onClick={() => update({ ...state, startedAt: new Date().toISOString() })} data-testid="start-guide">
            ガイドを始める
          </Button>
        </div>
      </Card>
    );

  const since = data.activities.filter((a) => a.at >= state.startedAt!);
  const done = STEPS.map((s) => since.some(s.done));
  const allSteps = [...done, state.analyticsSeen || load().analyticsSeen];
  const count = allSteps.filter(Boolean).length;
  const nextIndex = allSteps.findIndex((d) => !d);

  return (
    <Card className="mb-4 overflow-hidden" data-testid="demo-guide">
      <div className="flex items-center gap-2 px-4 py-3">
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex min-h-10 flex-1 items-center gap-2 text-left" aria-expanded={open}>
          <ChevronDown className={cx('size-4 transition-transform', !open && '-rotate-90')} aria-hidden />
          <span className="font-semibold">実演ガイド</span>
          <span className="text-xs text-slate-500">
            {count} / {allSteps.length} 完了
          </span>
        </button>
        <button type="button" className="flex size-10 items-center justify-center text-slate-400" aria-label="ガイドを閉じる" onClick={() => update({ ...state, dismissed: true })}>
          <X className="size-4" />
        </button>
      </div>
      <div className="h-1 bg-slate-100 dark:bg-navy-800">
        <div className="h-full bg-[var(--color-chart-done)] transition-[width] duration-500" style={{ width: `${(count / allSteps.length) * 100}%` }} />
      </div>
      {open && (
        <ol className="space-y-1 p-3">
          {[...STEPS, { label: 'ヘルプデスクの「分析」で結果を確認する', href: '#/helpdesk?view=analytics' }].map((s, i) => (
            <li key={s.label}>
              <a
                href={s.href}
                className={cx(
                  'flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm',
                  i === nextIndex ? 'bg-navy-50 font-semibold text-navy-900 dark:bg-navy-800 dark:text-white' : allSteps[i] ? 'text-slate-400 line-through' : 'text-slate-600 dark:text-slate-300',
                )}
              >
                {allSteps[i] ? <CheckCircle2 className="size-4 shrink-0 text-emerald-600" aria-hidden /> : <Circle className="size-4 shrink-0" aria-hidden />}
                {i + 1}. {s.label}
                {i === nextIndex && <span className="ml-auto text-xs text-navy-600 dark:text-navy-300">次はここ →</span>}
              </a>
            </li>
          ))}
        </ol>
      )}
      {count === allSteps.length && <p className="px-4 pb-3 text-sm font-semibold text-emerald-700 dark:text-emerald-300">すべて完了しました。お疲れさまでした。</p>}
    </Card>
  );
}
