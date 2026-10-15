import { describe, expect, it } from 'vitest';
import { classifyInquiry } from './classifier';
import { CAT, createDefaultInquiryCategories } from './defaults';
import { detectSecrets, maskSecrets } from './secrets';
import { filterFaqs, findSimilarCases, suggestFaqs } from './search';
import { proposeInquiryTasks } from './taskSuggest';
import { addBusinessDays, canTransition, checkClosable, nextInquiryNumber } from './inquiry';
import { computeHelpdeskStats, formatHours } from './analytics';
import { createDemoFaqs, createHelpdeskDemoData } from '../../demo/helpdeskDemo';
import { createDemoData } from '../../demo/demoData';
import type { Inquiry, Task } from '../types';

const cats = createDefaultInquiryCategories();
const classify = (title: string, body = '') => classifyInquiry(title, body, cats);
const TODAY = '2026-10-15';

describe('自動分類: カテゴリ', () => {
  it.each([
    ['パソコンが起動しない', CAT.pc],
    ['Googleにログインできない', CAT.google],
    ['Gmailが開けない', CAT.google],
    ['Teamsにサインインできない', CAT.microsoft],
    ['Outlookでメールが送信できない', CAT.microsoft],
    ['社内全員がネットワークに接続できない', CAT.network],
    ['Wi-Fiにつながらない', CAT.network],
    ['ＷｉＦｉにつながらない', CAT.network], // 全角も正規化
    ['iPhoneのApple IDを設定したい', CAT.apple],
    ['共有フォルダの権限がほしい', CAT.access],
    ['Acrobatをインストールしたい', CAT.software],
    ['名刺を追加で発注したい', CAT.facility],
  ])('「%s」→ %s', (title, expected) => {
    const r = classify(title);
    expect(r.categoryId).toBe(expected);
    expect(r.needsReview).toBe(false);
  });

  it('「ログインできない」だけではサービスを特定できず要確認になる', () => {
    const r = classify('ログインできない', 'ログインできません');
    expect(r.categoryId).toBe(CAT.other);
    expect(r.needsReview).toBe(true);
    expect(r.reasons.join()).toContain('判断できない');
  });

  it('手がかりがない文章は無理に分類しない', () => {
    const r = classify('相談があります', '来週少しお時間いただけますか');
    expect(r.categoryId).toBe(CAT.other);
    expect(r.needsReview).toBe(true);
    expect(r.confidence).toBe('low');
  });

  it('同点で拮抗する場合は要確認にする', () => {
    const r = classify('Teamsとgmailの両方', '');
    expect(r.needsReview).toBe(true);
    expect(r.reasons.join()).toContain('同点');
  });

  it('「パスワード」に含まれる「ワード」をWordと誤認しない（最長一致）', () => {
    const r = classify('パスワードを忘れました');
    expect(r.candidates.some((c) => c.categoryId === CAT.microsoft && c.matched.includes('ワード'))).toBe(false);
  });

  it('「マイクロソフト」の「ソフト」をソフトウェアとして二重計上しない', () => {
    const r = classify('マイクロソフトのアカウント');
    expect(r.categoryId).toBe(CAT.microsoft);
    expect(r.candidates.find((c) => c.categoryId === CAT.software)).toBeUndefined();
  });

  it('判定根拠（一致語・点数）を返す', () => {
    const r = classify('Googleにログインできない');
    expect(r.candidates[0]).toMatchObject({ categoryId: CAT.google });
    expect(r.candidates[0]!.matched).toContain('google');
    expect(r.reasons[0]).toContain('Googleアカウント');
  });

  it('無効化したカテゴリには分類しない・管理者が追加したキーワードを使う', () => {
    const custom = cats.map((c) => (c.id === CAT.google ? { ...c, enabled: false } : c.id === CAT.facility ? { ...c, keywords: [...c.keywords, '傘'] } : c));
    expect(classifyInquiry('Gmailが開けない', '', custom).categoryId).not.toBe(CAT.google);
    expect(classifyInquiry('置き傘を借りたい', '', custom).categoryId).toBe(CAT.facility);
  });
});

describe('自動分類: 優先度（過剰判定の防止）', () => {
  it('「ログインできない」だけでは高優先度にしない', () => {
    expect(classify('Googleにログインできない').priority).toBe('medium');
    expect(classify('ログインできない').priority).toBe('medium');
  });
  it('影響範囲が広く業務停止なら高', () => {
    const r = classify('社内全員がネットワークに接続できない');
    expect(r.priority).toBe('high');
    expect(r.priorityReasons.map((x) => x.label)).toEqual(expect.arrayContaining(['影響範囲が広い', '業務が止まっている']));
  });
  it('セキュリティ事故の可能性は単独でも高', () => {
    expect(classify('不審なメールの添付ファイルを開いてしまった').priority).toBe('high');
    expect(classify('社用スマホを紛失しました').priority).toBe('high');
  });
  it('個人の端末故障は中（至急でも1要素のみ）', () => {
    expect(classify('パソコンが起動しない').priority).toBe('medium');
    expect(classify('至急 パソコンが起動しない').priority).toBe('medium');
  });
  it('「急ぎません」は「急ぎ」として加点しない（低）', () => {
    const r = classify('Wi-Fiが遅い', '急ぎませんので時間があるときにお願いします');
    expect(r.priority).toBe('low');
    expect(r.priorityReasons.some((x) => x.label === '時間的な緊急性')).toBe(false);
  });
  it('同じ種類の語を繰り返しても過剰に加点しない', () => {
    expect(classify('至急 緊急 今すぐ', '').priorityScore).toBe(1);
  });
});

describe('秘密情報の検出', () => {
  it.each(['パスワード: abc12345', 'PW=Secret#99', 'パスワードは Hunter22 です', '認証コード 482913', 'カード 4111 1111 1111 1111', 'token ghp_AbCdEf1234567890GhIjKlMnOp'])('検出: %s', (t) => {
    expect(detectSecrets(t).length).toBeGreaterThan(0);
  });
  it.each(['パスワードを忘れました', 'パスワードが違いますと表示される', 'password reset したい', 'パスワードリセットの方法', '電話 03-1234-5678'])('誤検出しない: %s', (t) => {
    expect(detectSecrets(t)).toEqual([]);
  });
  it('伏せ字化すると検出されなくなり、前後の文章は残る', () => {
    const masked = maskSecrets('ログインできません。パスワード: abc12345 で試しました');
    expect(masked).toContain('ログインできません');
    expect(masked).toContain('で試しました');
    expect(masked).not.toContain('abc12345');
    expect(detectSecrets(masked)).toEqual([]);
  });
});

describe('FAQ候補・過去事例', () => {
  const faqs = createDemoFaqs();
  it('問い合わせ文から関連FAQを根拠付きで提示', () => {
    const r = suggestFaqs('会議室でWi-Fiにつながらない', faqs, { categoryId: CAT.network });
    expect(r[0]?.faq.question).toContain('Wi-Fi');
    expect(r[0]?.reasons.join()).toContain('キーワード一致');
  });
  it('無効なFAQは候補に出さない', () => {
    const disabled = faqs.map((f) => ({ ...f, enabled: false }));
    expect(suggestFaqs('Wi-Fiにつながらない', disabled)).toEqual([]);
  });
  it('関係ない文章ではFAQを出さない', () => {
    expect(suggestFaqs('来週の健康診断の日程', faqs)).toEqual([]);
  });
  it('短い検索語でも一覧から絞り込める', () => {
    expect(filterFaqs(faqs, '印刷')[0]?.question).toContain('印刷');
    expect(filterFaqs(faqs, '名刺').length).toBe(1);
  });
  it('過去事例は解決内容がある解決済み・完了案件のみ', () => {
    const demo = createDemoData(TODAY);
    const r = findSimilarCases('Wi-Fiにつながらない', demo.inquiries);
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((m) => m.kind === 'past_case' && ['resolved', 'closed'].includes(m.inquiry.status) && m.inquiry.resolution)).toBe(true);
  });
});

describe('タスク提案', () => {
  const base: Inquiry = createHelpdeskDemoData(TODAY, createDemoData(TODAY).employees, cats, ['dept_joshis', 'dept_soumu', 'dept_jinji']).inquiries[0]!;
  const inq = (title: string, categoryId: string): Inquiry => ({ ...base, id: 'inq_x', title, body: '', categoryId, status: 'new', dueDate: '2026-10-20' });
  const depts = ['dept_joshis', 'dept_soumu', 'dept_jinji'];

  it('「新入社員のPCが足りません」→ 在庫確認・発注・入社準備照合を提案', () => {
    const p = proposeInquiryTasks({ inquiry: inq('新入社員のPCが足りません', CAT.pc), category: cats[0], existingTasks: [], departmentIds: depts, today: TODAY });
    expect(p.map((x) => x.title)).toEqual(['PC在庫の確認', 'PCの発注・購入申請', '入社準備タスクとの照合']);
    expect(p.every((x) => x.status === 'new')).toBe(true);
  });
  it('該当ルールがなければ一次対応タスクのみ', () => {
    const p = proposeInquiryTasks({ inquiry: inq('その他の相談', CAT.other), category: cats.at(-1), existingTasks: [], departmentIds: depts, today: TODAY });
    expect(p.map((x) => x.title)).toEqual(['問い合わせ内容の確認・一次対応']);
  });
  it('作成済みのタスクは duplicate になる', () => {
    const existing = [{ inquiryId: 'inq_x', ruleId: 'inqrule_pc_stock', title: 'PC在庫の確認' } as Task];
    const p = proposeInquiryTasks({ inquiry: inq('新入社員のPCが足りません', CAT.pc), category: cats[0], existingTasks: existing, departmentIds: depts, today: TODAY });
    expect(p.find((x) => x.ruleId === 'inqrule_pc_stock')?.status).toBe('duplicate');
  });
  it('期限は問い合わせの期限を超えない', () => {
    const p = proposeInquiryTasks({ inquiry: { ...inq('新入社員のPCが足りません', CAT.pc), dueDate: '2026-10-16' }, category: cats[0], existingTasks: [], departmentIds: depts, today: TODAY });
    expect(p.every((x) => x.dueDate <= '2026-10-16')).toBe(true);
  });
});

describe('問い合わせルール', () => {
  it('採番は年ごとの連番', () => {
    expect(nextInquiryNumber([], 2026)).toBe('HD-2026-0001');
    expect(nextInquiryNumber(['HD-2026-0009', 'HD-2025-0100'], 2026)).toBe('HD-2026-0010');
  });
  it('営業日計算（土日を飛ばす）', () => {
    expect(addBusinessDays('2026-10-16', 1)).toBe('2026-10-19'); // 金→月
    expect(addBusinessDays('2026-10-17', 0)).toBe('2026-10-19'); // 土→月
  });
  it('完了は解決済みからのみ。完了後は変更不可', () => {
    expect(canTransition('in_progress', 'closed').ok).toBe(false);
    expect(canTransition('resolved', 'closed').ok).toBe(true);
    expect(canTransition('closed', 'in_progress').ok).toBe(false);
    expect(canTransition('resolved', 'in_progress').ok).toBe(true); // 再オープン
  });
  it('完了条件: 解決内容・タスク完了・申請者確認', () => {
    const inq = { status: 'resolved', resolution: '' } as Inquiry;
    const r = checkClosable(inq, [{ status: 'todo' } as Task], false);
    expect(r.blockers).toHaveLength(3);
    expect(checkClosable({ ...inq, resolution: '対応済み' }, [{ status: 'done' } as Task], true).ok).toBe(true);
  });
});

describe('ヘルプデスク分析', () => {
  it('データ不足を数値で偽らない', () => {
    const s = computeHelpdeskStats([], cats, TODAY);
    expect(s.avgResolutionHours.status).toBe('insufficient');
    expect(s.frequent).toEqual([]);
    expect(s.classificationAcceptance.status).toBe('insufficient');
  });
  it('デモデータで各指標を集計', () => {
    const demo = createDemoData(TODAY);
    const s = computeHelpdeskStats(demo.inquiries, demo.inquiryCategories, TODAY);
    expect(s.total).toBe(demo.inquiries.length);
    expect(s.newCount + s.inProgressCount + s.waitingCount + s.onHoldCount + s.resolvedCount + s.closedCount).toBe(s.total);
    expect(s.avgResolutionHours.status).toBe('ok');
    expect(s.overdueCount).toBeGreaterThanOrEqual(1);
    // Wi-Fi系の類似問い合わせがまとまる
    expect(s.frequent[0]?.title).toContain('Wi-Fi');
    expect(s.frequent[0]!.count).toBeGreaterThanOrEqual(3);
    expect(s.byPriority.reduce((a, p) => a + p.count, 0)).toBe(s.total);
  });
  it('解決時間の定義: 受付→最初の解決', () => {
    const demo = createDemoData(TODAY);
    const s = computeHelpdeskStats(demo.inquiries.filter((i) => i.title === '社内全員がインターネットに接続できない' || i.title.startsWith('Teams') || i.title.startsWith('プリンター')), cats, TODAY);
    // 0.8h, 1.5h, 2h → 平均 1.4h, 中央値 1.5h
    expect(s.avgResolutionHours).toMatchObject({ status: 'ok', value: 1.4 });
    expect(s.medianResolutionHours).toMatchObject({ status: 'ok', value: 1.5 });
    expect(formatHours(1.4)).toBe('1.4時間');
    expect(formatHours(50)).toBe('2.1日');
  });
});
