import { describe, expect, it } from 'vitest';
import { checkFields, extractDocument, findAmounts, findDates, findRegistrationNumber, normalizeText, parseAmountInput, parseDateInput, type SourcePage } from './extract';

const page = (text: string, confidence: number | null = null): SourcePage[] => [{ page: 1, lines: text.split('\n').map((t) => ({ text: t, confidence })) }];

const INVOICE = `請求書
株式会社あおばテクノサービス 御中
請求書番号: INV-2026-0042
発行日 2026年10月1日
架空PCサプライ株式会社
登録番号 T1234567890123
〒100-0000 東京都千代田区（架空）
TEL 000-0000-0001
品名 数量 単価 金額
ノートPC NB-14S 2 台 150,000 300,000
マウス MS-200 5 個 1,800 9,000
小計 309,000
消費税(10%) 30,900
ご請求金額 ¥339,900
お支払期限 2026年10月31日
備考 振込手数料はご負担ください`;

describe('値の解析', () => {
  it('日付（西暦・和暦・区切りの揺れ）を ISO に、存在しない日付は除外', () => {
    expect(findDates('発行日 2026年10月1日')).toEqual(['2026-10-01']);
    expect(findDates('2026/9/30 と 2026-02-30')).toEqual(['2026-09-30']);
    expect(findDates('令和8年4月1日')).toEqual(['2026-04-01']);
    expect(findDates('R8.10.15')).toEqual(['2026-10-15']);
    expect(parseDateInput('2026/10/5')).toBe('2026-10-05');
    expect(parseDateInput('明日')).toBeNull();
  });
  it('金額（¥・カンマ・円・全角）を整数に。税率・数量は金額にしない', () => {
    expect(findAmounts('ご請求金額 ¥339,900')).toEqual([339900]);
    expect(findAmounts('合計　１２，３４５円')).toEqual([12345]);
    expect(findAmounts('消費税(10%) 30,900')).toEqual([30900]);
    expect(parseAmountInput('¥12,345-')).toBe(12345);
    expect(parseAmountInput('12.5')).toBeNull();
  });
  it('OCR が入れる文字間の空白を除去し、登録番号の空白を詰める', () => {
    expect(normalizeText('領 収 書')).toBe('領収書');
    expect(findRegistrationNumber('登録番号 T 1234 5678 90123')).toBe('T1234567890123');
    expect(findRegistrationNumber('T123456789012')).toBeNull();
  });
});

describe('請求書の抽出', () => {
  const r = extractDocument(page(INVOICE));
  it('種類・番号・日付・当事者・登録番号', () => {
    expect(r.type).toBe('invoice');
    expect(r.fields.docNumber?.value).toBe('INV-2026-0042');
    expect(r.fields.issueDate?.value).toBe('2026-10-01');
    expect(r.fields.dueDate?.value).toBe('2026-10-31');
    expect(r.fields.recipient?.value).toBe('株式会社あおばテクノサービス');
    expect(r.fields.issuer?.value).toBe('架空PCサプライ株式会社');
    expect(r.fields.registrationNumber?.value).toBe('T1234567890123');
    expect(r.fields.notes?.value).toContain('振込手数料');
  });
  it('金額は検算が合うと確実性：高、抽出元の行を保持', () => {
    expect(r.fields.total?.value).toBe('339900');
    expect(r.fields.subtotal?.value).toBe('309000');
    expect(r.fields.tax?.value).toBe('30900');
    expect(r.fields.total?.certainty).toBe('high');
    expect(r.fields.total?.evidence).toBe('ご請求金額 ¥339,900');
    expect(r.fields.total?.reasons.join()).toContain('検算一致');
  });
  it('明細（品名・数量・単価・金額）', () => {
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0]).toMatchObject({ name: 'ノートPC NB-14S', quantity: 2, unitPrice: 150000, amount: 300000 });
    expect(r.lines[1]).toMatchObject({ name: 'マウス MS-200', quantity: 5, unitPrice: 1800, amount: 9000 });
    expect(r.taxLines[0]?.rate).toBe(10);
  });
});

describe('領収書（OCR風の入力）', () => {
  const RECEIPT = `領 収 書
テスト 太郎 様
¥ 5,500 -
但し 文房具代として
上記正に領収いたしました
2026 年 10 月 12 日
内消費税 500
みどり事務用品 株式会社
登録番号 T9876543210987`;
  it('文字間の空白を詰めて抽出し、宛名は「様」の前', () => {
    const r = extractDocument(page(RECEIPT, 88));
    expect(r.type).toBe('receipt');
    expect(r.fields.total?.value).toBe('5500');
    expect(r.fields.recipient?.value).toBe('テスト 太郎');
    expect(r.fields.issueDate?.value).toBe('2026-10-12');
    expect(r.fields.tax?.value).toBe('500');
    expect(r.fields.issuer?.value).toBe('みどり事務用品 株式会社');
    expect(r.fields.total?.ocrConfidence).toBe(88);
  });
  it('文字認識の信頼度が低い行の値は、ラベルが一致しても要確認', () => {
    const r = extractDocument(page(RECEIPT, 42));
    expect(r.fields.registrationNumber?.certainty).toBe('low');
    expect(r.fields.registrationNumber?.reasons.join()).toContain('信頼度が低い');
  });
});

describe('タイトルが読み取れない場合', () => {
  it('「上記正に領収いたしました」から領収書と判定し、¥金額- を合計にする', () => {
    const r = extractDocument(page('ANE\nテスト 太郎様\n¥5,500-\n上記正に領収いたしました\n発行日 2026年10月12日'));
    expect(r.type).toBe('receipt');
    expect(r.typeReason).toContain('タイトルは読み取れず');
    expect(r.fields.total?.value).toBe('5500');
    expect(r.fields.title).toBeUndefined(); // 書類名は推測で埋めない
  });
});

describe('補完しない・要確認にする', () => {
  it('読み取れない項目は空のまま（推測で埋めない）', () => {
    const r = extractDocument(page('メモ\nよろしくお願いします'));
    expect(r.type).toBe('other');
    expect(r.fields.total).toBeUndefined();
    expect(r.fields.issueDate).toBeUndefined();
    expect(r.fields.issuer).toBeUndefined();
  });
  it('検算が合わない合計は要確認', () => {
    const r = extractDocument(page('請求書\n小計 10,000\n消費税 1,000\n合計金額 12,000'));
    expect(r.fields.total?.certainty).toBe('low');
    expect(r.fields.total?.reasons.join()).toContain('検算不一致');
  });
  it('ラベルのない日付が複数あるときは要確認', () => {
    const r = extractDocument(page('見積書\n2026/10/01\n有効期限内にご連絡ください 2026/10/31'));
    expect(r.type).toBe('quote');
    expect(r.fields.issueDate?.certainty).toBe('low');
  });
});

describe('納品書・申請書', () => {
  it('納品書の納品日・明細', () => {
    const r = extractDocument(page(`納品書\n納品書番号 DN-881\n納品日 2026年10月14日\n株式会社あおばテクノサービス 御中\nみどり事務用品株式会社\n品名 数量 単価 金額\nコピー用紙 A4 10 冊 450 4,500\n名刺ケース 3 個 800 2,400\n合計 6,900`));
    expect(r.type).toBe('delivery');
    expect(r.fields.deliveryDate?.value).toBe('2026-10-14');
    expect(r.fields.docNumber?.value).toBe('DN-881');
    expect(r.lines.map((l) => [l.name, l.quantity])).toEqual([['コピー用紙 A4', 10], ['名刺ケース', 3]]);
    expect(r.fields.total?.value).toBe('6900');
  });
  it('申請書の申請者・内容', () => {
    const r = extractDocument(page(`備品購入申請書\n申請日 2026年10月2日\n申請者 佐藤 健一\n申請内容 モニターの追加購入\n金額 22,000円`));
    expect(r.type).toBe('application');
    expect(r.fields.applicant?.value).toBe('佐藤 健一');
    expect(r.fields.applicationContent?.value).toBe('モニターの追加購入');
    expect(r.fields.issueDate?.value).toBe('2026-10-02');
  });
});

describe('入力チェック', () => {
  it('形式エラーと整合性の注意を区別', () => {
    const issues = checkFields({ issueDate: '2026-13-01', total: '1,000', registrationNumber: 'T12', subtotal: '900', tax: '50' }, [{ id: 'a', name: 'x', quantity: 2, unitPrice: 100, amount: 300, itemId: null, evidence: '' }]);
    expect(issues.filter((i) => i.level === 'error').map((i) => i.key).sort()).toEqual(['issueDate', 'registrationNumber', 'total']);
    expect(issues.some((i) => i.key === 'lines' && i.level === 'warning')).toBe(true);
    const ok = checkFields({ issueDate: '2026-10-01', total: '1100', subtotal: '1000', tax: '100' }, []);
    expect(ok).toEqual([]);
  });
});
