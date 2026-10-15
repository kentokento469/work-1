/**
 * ヘルプデスクのデモデータ (架空)。
 * 受付・解決日時は「現在時刻」基準の相対時間で作り、いつ開いても分析指標が意味を持つようにする。
 * 自動分類の結果は実際の分類エンジンで計算して保存する。
 */
import { classifyInquiry } from '../domain/helpdesk/classifier';
import { CAT } from '../domain/helpdesk/defaults';
import { addBusinessDays, formatInquiryNumber } from '../domain/helpdesk/inquiry';
import { proposeInquiryTasks } from '../domain/helpdesk/taskSuggest';
import { addDays, toISODate } from '../domain/date';
import { generateId } from '../domain/id';
import type { Employee, Faq, Inquiry, InquiryCategory, InquiryEvent, InquiryStatus, ISODate, Priority, Task, TaskStatus } from '../domain/types';
import { INQUIRY_STATUS_LABEL } from '../domain/types';

interface InquirySeed {
  title: string;
  body: string;
  /** 受付: 何時間前か */
  hoursAgo: number;
  status: InquiryStatus;
  /** 受付から解決までの時間 (resolved/closed のみ) */
  resolveHours?: number;
  resolution?: string;
  /** 担当者が自動分類を変更した例 */
  overrideCategory?: string;
  overridePriority?: Priority;
  /** 期限を過去にして期限超過の例を作る */
  overdueDays?: number;
  /** 対応タスクを作成し、そのステータスを指定 */
  taskStatus?: TaskStatus;
  faqIndex?: number;
}

const SEEDS: InquirySeed[] = [
  { title: '社内全員がインターネットに接続できない', body: '9時過ぎから社内全員がインターネットに接続できません。業務が止まっています。', hoursAgo: 24 * 12, status: 'closed', resolveHours: 0.8, resolution: 'ルーターの再起動で復旧。回線事業者の障害ではなかった。', taskStatus: 'done' },
  { title: '会議室のWi-Fiにつながらない', body: '第2会議室でノートPCがWi-Fiにつながりません。', hoursAgo: 24 * 10, status: 'closed', resolveHours: 3, resolution: 'アクセスポイントの電源が抜けていたため差し直して復旧。', faqIndex: 0 },
  { title: '3階のWi-Fiにつながりにくい', body: '3階の窓側の席だけWi-Fiが頻繁に切れます。急ぎません。', hoursAgo: 24 * 8, status: 'resolved', resolveHours: 26, resolution: 'Wi-Fiの接続先を5GHz帯に変更してもらい改善。', faqIndex: 0 },
  { title: 'Wi-Fiにつながらない', body: '営業部の席でWi-Fiにつながらなくなりました。有線LANでは使えています。', hoursAgo: 5, status: 'in_progress', taskStatus: 'in_progress' },
  { title: 'Teamsにサインインできない', body: 'PCを再起動したらTeamsにサインインできなくなりました。午後に商談があります。', hoursAgo: 24 * 9, status: 'closed', resolveHours: 1.5, resolution: 'Teamsのキャッシュを削除して再サインインで解決。', faqIndex: 1 },
  { title: 'Outlookでメールが送信できない', body: 'Outlookで送信トレイにメールが残ったままになります。', hoursAgo: 24 * 6, status: 'resolved', resolveHours: 5, resolution: '添付ファイルが上限を超えていたため、共有リンクでの送付を案内。', faqIndex: 2 },
  { title: 'Gmailにログインできない', body: '取引先とのやり取りで使うGmailにログインできません。', hoursAgo: 30, status: 'waiting', taskStatus: 'done' },
  { title: 'パソコンが起動しない', body: '朝からノートPCの電源が入りません。充電ランプもつきません。', hoursAgo: 52, status: 'in_progress', overdueDays: 1, taskStatus: 'in_progress' },
  { title: 'プリンターで印刷できない', body: '2階の複合機で印刷するとエラーになります。', hoursAgo: 24 * 7, status: 'closed', resolveHours: 2, resolution: '用紙トレイの紙詰まりを解消して復旧。', faqIndex: 3 },
  { title: '共有フォルダにアクセスできない', body: '経理の共有フォルダが閲覧できません。異動に伴い権限が必要です。', hoursAgo: 24 * 3, status: 'on_hold', overrideCategory: CAT.access, taskStatus: 'todo' },
  { title: 'Adobe Acrobatをインストールしたい', body: 'PDFの編集が必要になったのでAcrobatを使いたいです。お手すきの際にお願いします。', hoursAgo: 20, status: 'new' },
  { title: '名刺の追加発注をお願いしたい', body: '名刺が残り少なくなりました。100枚追加でお願いします。', hoursAgo: 24 * 5, status: 'closed', resolveHours: 22, resolution: '総務で発注済み。3営業日後に納品。', faqIndex: 6 },
  { title: '業務用iPhoneのApple IDの設定方法を教えてください', body: '新しく支給されたiPhoneの初期設定でApple IDをどうすればよいか教えてください。', hoursAgo: 24 * 4, status: 'resolved', resolveHours: 4, resolution: '会社管理のApple IDを使う手順を案内。', faqIndex: 7 },
  { title: 'ログインできない', body: 'ログインできません。', hoursAgo: 2, status: 'new' },
  { title: 'Wi-Fiにつながらない（応接室）', body: '来客中に応接室のWi-Fiにつながらなくなりました。', hoursAgo: 24 * 2, status: 'resolved', resolveHours: 1, resolution: '来客用ネットワークのパスワード変更を周知し解決。', faqIndex: 0, overridePriority: 'high' },
];

const FAQ_SEEDS: { question: string; answer: string; categoryId: string; keywords: string[] }[] = [
  { question: 'Wi-Fiにつながらないときの確認手順', answer: '1. 機内モードがオフか確認\n2. Wi-Fiをオフ→オンにする\n3. 接続先が社内ネットワークか確認\n4. 他の人もつながらない場合は情報システム部へ連絡（障害の可能性）', categoryId: CAT.network, keywords: ['wi-fi', 'wifi', '無線', 'つながらない', '接続できない'] },
  { question: 'Teamsにサインインできない', answer: '1. Teamsを完全に終了する\n2. キャッシュを削除する（手順書を参照）\n3. 再度サインインする\n4. 解決しない場合はアカウントのロック状態を情報システム部が確認します', categoryId: CAT.microsoft, keywords: ['teams', 'チームズ', 'サインイン'] },
  { question: 'Outlookでメールが送信できない', answer: '1. 送信トレイに残っているメールを確認\n2. 添付ファイルが20MBを超えていないか確認\n3. 大きなファイルは共有リンクで送付する', categoryId: CAT.microsoft, keywords: ['outlook', 'メール', '送信できない'] },
  { question: 'プリンター・複合機で印刷できない', answer: '1. 複合機の画面にエラーが出ていないか確認\n2. 紙詰まり・用紙切れを確認\n3. PCで正しいプリンターが選ばれているか確認', categoryId: CAT.pc, keywords: ['プリンター', '複合機', '印刷'] },
  { question: '共有フォルダの権限を申請したい', answer: '1. 所属長の承認を得る\n2. ヘルプデスクに「フォルダ名・必要な権限（閲覧/編集）」を連絡\n3. 承認確認後に情報システム部が設定します', categoryId: CAT.access, keywords: ['共有フォルダ', '権限', 'アクセス権'] },
  { question: 'ソフトウェアをインストールしたい', answer: '1. ヘルプデスクにソフト名と利用目的を連絡\n2. ライセンスの空きを確認\n3. 情報システム部がインストールします（自分でのインストールは禁止）', categoryId: CAT.software, keywords: ['インストール', 'ソフト', 'ライセンス'] },
  { question: '名刺を発注したい', answer: '1. 名刺の記載内容（役職・部署）を確認\n2. 総務部に必要枚数を連絡\n3. 通常3営業日で納品されます', categoryId: CAT.facility, keywords: ['名刺', '発注'] },
  { question: '業務用iPhoneの初期設定（Apple ID）', answer: '1. 会社が用意した管理用Apple IDを使用します\n2. 個人のApple IDでサインインしないでください\n3. 設定に必要な情報は対面で受け取ってください（チャット・メールで送りません）', categoryId: CAT.apple, keywords: ['iphone', 'apple id', 'appleid', '初期設定'] },
  { question: 'パスワードを忘れたときの依頼方法', answer: '1. ヘルプデスクに「パスワードを忘れた」とだけ連絡（パスワードそのものは書かない）\n2. 本人確認のうえ、情報システム部がリセットします\n3. 仮パスワードは対面または電話で伝えます', categoryId: CAT.access, keywords: ['パスワード', '忘れた', 'リセット'] },
];

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

export function createDemoFaqs(): Faq[] {
  const ts = isoHoursAgo(24 * 30);
  return FAQ_SEEDS.map((f, i) => ({ id: `faq_demo_${i + 1}`, ...f, enabled: true, sourceInquiryId: null, createdAt: ts, updatedAt: ts }));
}

export function createHelpdeskDemoData(
  today: ISODate,
  employees: Employee[],
  categories: InquiryCategory[],
  departmentIds: string[],
): { inquiries: Inquiry[]; faqs: Faq[]; tasks: Task[] } {
  const faqs = createDemoFaqs();
  const requesters = employees.filter((e) => e.status === 'active');
  const pool = requesters.length ? requesters : employees;
  const year = Number(today.slice(0, 4));
  const inquiries: Inquiry[] = [];
  const tasks: Task[] = [];
  const catIds = new Set(categories.map((c) => c.id));
  const fallback = categories.find((c) => c.isFallback)?.id ?? CAT.other;

  // 古い順に採番する
  const ordered = [...SEEDS].sort((a, b) => b.hoursAgo - a.hoursAgo);
  ordered.forEach((s, idx) => {
    const requester = pool[(idx * 3) % pool.length]!;
    const c = classifyInquiry(s.title, s.body, categories);
    const categoryId = s.overrideCategory && catIds.has(s.overrideCategory) ? s.overrideCategory : catIds.has(c.categoryId) ? c.categoryId : fallback;
    const priority = s.overridePriority ?? c.priority;
    const cat = categories.find((x) => x.id === categoryId);
    const receivedAt = isoHoursAgo(s.hoursAgo);
    const receivedDate = toISODate(new Date(receivedAt));
    const dueDate = s.overdueDays ? addDays(today, -s.overdueDays) : addBusinessDays(receivedDate, cat?.slaBusinessDays ?? 3);
    const resolvedAt = s.resolveHours !== undefined ? new Date(new Date(receivedAt).getTime() + s.resolveHours * 3_600_000).toISOString() : null;
    const id = `inq_demo_${idx + 1}`;
    const ev = (type: InquiryEvent['type'], message: string, at: string): InquiryEvent => ({ id: generateId('ev'), at, type, message });
    const history: InquiryEvent[] = [
      ev('created', `${requester.name}さんから受付（${formatInquiryNumber(year, idx + 1)}）`, receivedAt),
      ev('classification', `自動分類：${c.needsReview ? '要確認' : '候補'}カテゴリ${categoryId === c.categoryId ? 'を採用' : 'を担当者が変更'}`, receivedAt),
    ];
    if (s.status !== 'new') history.push(ev('status', 'ステータス：新規 → 対応中', receivedAt));
    if (resolvedAt) history.push(ev('status', `ステータス：対応中 → 解決済み`, resolvedAt));
    if (s.status === 'closed' && resolvedAt) history.push(ev('status', 'ステータス：解決済み → 完了（申請者の確認済み）', resolvedAt));
    else if (!resolvedAt && s.status !== 'new' && s.status !== 'in_progress') history.push(ev('status', `ステータス：対応中 → ${INQUIRY_STATUS_LABEL[s.status]}`, receivedAt));

    const inquiry: Inquiry = {
      id,
      number: formatInquiryNumber(year, idx + 1),
      receivedAt,
      requesterId: requester.id,
      requesterName: requester.name,
      requesterDepartmentId: requester.departmentId,
      title: s.title,
      body: s.body,
      categoryId,
      priority,
      assignee: cat?.defaultAssignee ?? '',
      dueDate,
      status: s.status,
      resolution: s.resolution ?? '',
      resolvedAt,
      closedAt: s.status === 'closed' ? resolvedAt : null,
      classification: {
        suggestedCategoryId: c.categoryId,
        suggestedPriority: c.priority,
        needsReview: c.needsReview,
        categoryAccepted: categoryId === c.categoryId,
        priorityAccepted: priority === c.priority,
        reasons: c.reasons,
      },
      faqIds: s.faqIndex !== undefined ? [faqs[s.faqIndex]!.id] : [],
      history,
      createdAt: receivedAt,
      updatedAt: resolvedAt ?? receivedAt,
    };
    inquiries.push(inquiry);

    if (s.taskStatus) {
      const proposal = proposeInquiryTasks({ inquiry, category: cat, existingTasks: [], departmentIds, today: receivedDate })[0];
      if (proposal) {
        tasks.push({
          id: `task_inq_demo_${idx + 1}`,
          employeeId: null,
          title: proposal.title,
          description: `${proposal.description}\n（問い合わせ ${inquiry.number}「${inquiry.title}」より作成）`,
          assigneeDepartmentId: proposal.assigneeDepartmentId,
          assignee: proposal.assignee || (cat?.defaultAssignee ?? ''),
          priority: proposal.priority,
          dueDate: s.overdueDays ? addDays(today, -s.overdueDays) : proposal.dueDate,
          status: s.taskStatus,
          source: 'inquiry',
          ruleId: proposal.ruleId,
          inquiryId: id,
          createdAt: receivedAt,
          updatedAt: resolvedAt ?? receivedAt,
          completedAt: s.taskStatus === 'done' ? (resolvedAt ?? receivedAt) : null,
        });
        inquiry.history.push(ev('task', `対応タスクを1件作成：${proposal.title}`, receivedAt));
      }
    }
  });
  return { inquiries, faqs, tasks };
}
