/**
 * デモデータ生成。
 * 架空企業「株式会社あおばテクノサービス」の社員・部署・業務データ。
 * 実在の人物・企業とは関係ありません。日付は生成日を基準に相対的に作るため、
 * いつ開いても「入社予定」「期限超過」などの状態が再現される。
 */
import { buildOnboardingPlan, materializePlan } from '../automation/onboardingEngine';
import { addDays, isWeekend } from '../domain/date';

function toNextBusinessDay(d: ISODate): ISODate {
  let v = d;
  while (isWeekend(v)) v = addDays(v, 1);
  return v;
}
import { generateId } from '../domain/id';
import type {
  ActivityLog,
  DataSnapshot,
  Department,
  Employee,
  EmployeeStatus,
  EmploymentType,
  ISODate,
  OnboardingRule,
  Priority,
  Task,
  TaskStatus,
} from '../domain/types';

export const DEMO_COMPANY_NAME = '株式会社あおばテクノサービス';

/** 固定IDにしておくとルールの scope 参照が安定する */
export const DEPT = {
  soumu: 'dept_soumu',
  jinji: 'dept_jinji',
  joshis: 'dept_joshis',
  eigyo: 'dept_eigyo',
  kaihatsu: 'dept_kaihatsu',
  keiri: 'dept_keiri',
} as const;

export function createDefaultDepartments(): Department[] {
  return [
    { id: DEPT.soumu, name: '総務部', order: 1 },
    { id: DEPT.jinji, name: '人事部', order: 2 },
    { id: DEPT.joshis, name: '情報システム部', order: 3 },
    { id: DEPT.eigyo, name: '営業部', order: 4 },
    { id: DEPT.kaihatsu, name: '開発部', order: 5 },
    { id: DEPT.keiri, name: '経理部', order: 6 },
  ];
}

type RuleSeed = [
  title: string,
  description: string,
  scope: 'common' | string,
  assigneeDept: string,
  assignee: string,
  priority: Priority,
  offsetDays: number,
  employmentTypes?: EmploymentType[],
];

export function createDefaultRules(createdAt: string): OnboardingRule[] {
  const seeds: RuleSeed[] = [
    // 共通タスク
    ['PC準備', '業務用PCのキッティング・資産番号登録・初期設定を行う', 'common', DEPT.joshis, '中村 拓也', 'high', -7],
    ['Microsoftアカウント準備', 'Microsoft 365 アカウント発行とライセンス割り当て（※本アプリから実際の発行は行いません）', 'common', DEPT.joshis, '中村 拓也', 'high', -5],
    ['Googleアカウント準備', 'Google Workspace アカウント発行と組織部門の設定（※本アプリから実際の発行は行いません）', 'common', DEPT.joshis, '中村 拓也', 'medium', -5],
    ['社内システム利用準備', '勤怠・経費精算・社内ポータルの利用者登録', 'common', DEPT.joshis, '小林 美咲', 'medium', -3],
    ['入社書類確認', '雇用契約書・身元保証書・口座情報など提出書類の確認', 'common', DEPT.jinji, '山本 恵', 'high', -3],
    ['備品準備', '名札・入館証・文房具・座席の準備', 'common', DEPT.soumu, '加藤 由美', 'low', -2],
    ['社会保険・雇用保険手続き', '資格取得届の作成と提出準備', 'common', DEPT.jinji, '山本 恵', 'medium', 5, ['正社員', '契約社員']],
    // 部署別タスク
    ['名刺発注', '名刺デザイン確認と発注', DEPT.eigyo, DEPT.soumu, '加藤 由美', 'medium', -5],
    ['CRMアカウント発行', '顧客管理システムの営業ロール付与', DEPT.eigyo, DEPT.joshis, '小林 美咲', 'medium', -2],
    ['GitHubアカウント招待', '組織への招待と所属チーム設定', DEPT.kaihatsu, DEPT.joshis, '中村 拓也', 'high', -3],
    ['開発環境・VPN設定', '開発用ソフトウェアとVPNクライアントのセットアップ', DEPT.kaihatsu, DEPT.joshis, '中村 拓也', 'medium', -1],
    ['会計システム権限付与', '会計システムの閲覧・起票権限の設定', DEPT.keiri, DEPT.joshis, '小林 美咲', 'medium', -2],
    ['経理規程の研修', '経費・支払規程の説明（入社後1週間以内）', DEPT.keiri, DEPT.keiri, '松本 直樹', 'low', 5],
    ['人事システム管理権限', '人事データベースの権限申請', DEPT.jinji, DEPT.joshis, '小林 美咲', 'medium', -2],
    ['管理者権限・監視ツール設定', '管理者アカウントと監視ツールの権限付与', DEPT.joshis, DEPT.joshis, '中村 拓也', 'medium', -2],
  ];
  return seeds.map(([title, description, scope, assigneeDepartmentId, defaultAssignee, priority, offsetDays, types], i) => ({
    id: `rule_default_${i + 1}`,
    title,
    description,
    scope,
    assigneeDepartmentId,
    defaultAssignee,
    priority,
    offsetDays,
    employmentTypes: types ?? [],
    enabled: true,
    order: i + 1,
    createdAt,
    updatedAt: createdAt,
  }));
}

type EmpSeed = [
  num: string,
  name: string,
  dept: string,
  position: string,
  type: EmploymentType,
  hireOffsetDays: number,
  status: EmployeeStatus,
  notes?: string,
  retireOffsetDays?: number,
];

export function createDemoData(today: ISODate): DataSnapshot {
  const ts = new Date().toISOString();
  const departments = createDefaultDepartments();
  const rules = createDefaultRules(ts);

  const empSeeds: EmpSeed[] = [
    ['A0001', '佐藤 健一', DEPT.soumu, '代表取締役', '正社員', -4800, 'active'],
    ['A0002', '加藤 由美', DEPT.soumu, '総務課長', '正社員', -3200, 'active'],
    ['A0003', '吉田 翔', DEPT.soumu, '', 'パート・アルバイト', -400, 'active'],
    ['A0011', '山本 恵', DEPT.jinji, '人事部長', '正社員', -3600, 'active'],
    ['A0012', '井上 彩', DEPT.jinji, '採用担当', '正社員', -900, 'active'],
    ['A0021', '中村 拓也', DEPT.joshis, '情報システム課長', '正社員', -2800, 'active'],
    ['A0022', '小林 美咲', DEPT.joshis, 'ヘルプデスク', '契約社員', -500, 'active'],
    ['A0031', '高橋 誠', DEPT.eigyo, '営業部長', '正社員', -4000, 'active'],
    ['A0032', '伊藤 大輔', DEPT.eigyo, '主任', '正社員', -1500, 'active'],
    ['A0033', '渡辺 さくら', DEPT.eigyo, '', '正社員', -700, 'active'],
    ['A0034', '山田 隆', DEPT.eigyo, '', '派遣社員', -200, 'active'],
    ['A0035', '石川 恭平', DEPT.eigyo, '', '正社員', -1200, 'leave', '育児休業中（復職予定あり）'],
    ['A0041', '田中 聡', DEPT.kaihatsu, '開発部長', '正社員', -3000, 'active'],
    ['A0042', '鈴木 陽子', DEPT.kaihatsu, 'リードエンジニア', '正社員', -1800, 'active'],
    ['A0043', '木村 亮', DEPT.kaihatsu, '', '正社員', -600, 'active'],
    ['A0044', '林 直人', DEPT.kaihatsu, '', '業務委託', -300, 'active', '契約更新は半年ごと'],
    ['A0051', '松本 直樹', DEPT.keiri, '経理課長', '正社員', -2500, 'active'],
    ['A0052', '清水 麻衣', DEPT.keiri, '', 'パート・アルバイト', -800, 'active'],
    ['A0036', '斎藤 学', DEPT.eigyo, '', '正社員', -2000, 'retired', '一身上の都合により退職', -60],
    // 入社予定者
    ['A0101', '森 結衣', DEPT.kaihatsu, 'エンジニア', '正社員', 4, 'pending', '中途採用・前職でWeb開発経験あり'],
    ['A0102', '池田 悠真', DEPT.eigyo, '', '正社員', 9, 'pending', '新卒採用'],
    ['A0103', '橋本 七海', DEPT.keiri, '', '契約社員', 18, 'pending'],
    ['A0104', '阿部 涼介', DEPT.joshis, 'インフラエンジニア', '正社員', 40, 'pending'],
  ];

  const employees: Employee[] = empSeeds.map(([num, name, dept, position, type, hireOff, status, notes, retireOff]) => ({
    id: `emp_${num}`,
    employeeNumber: num,
    name,
    departmentId: dept,
    position,
    employmentType: type,
    // 入社予定日は平日に揃える (土日なら翌月曜)
    hireDate: hireOff > 0 ? toNextBusinessDay(addDays(today, hireOff)) : addDays(today, hireOff),
    retireDate: retireOff !== undefined ? addDays(today, retireOff) : null,
    status,
    notes: notes ?? '',
    createdAt: ts,
    updatedAt: ts,
  }));
  const emp = (num: string) => employees.find((e) => e.employeeNumber === num)!;

  const tasks: Task[] = [];
  // 入社準備タスク: エンジンで生成した上で、進捗状況をデモ用に調整する
  const generate = (num: string, progress: (t: Task, i: number) => Partial<Task>) => {
    const e = emp(num);
    // 過去日調整を避けるため、十分前の日付を基準に計画を作る
    const plan = buildOnboardingPlan({ employee: e, rules, existingTasks: tasks, departments, today: addDays(today, -30) });
    materializePlan(plan, {}, ts).forEach((t, i) => tasks.push({ ...t, ...progress(t, i) }));
  };
  const done = (t: Task): Partial<Task> => ({ status: 'done', completedAt: new Date(`${addDays(t.dueDate, -1)}T10:00:00`).toISOString() });

  // 森さん(4日後入社): 大半完了、一部期限超過
  generate('A0101', (t) => {
    if (t.dueDate < today && ['PC準備', 'Microsoftアカウント準備', '入社書類確認'].includes(t.title)) return done(t);
    if (t.title === 'GitHubアカウント招待') return { status: 'in_progress' };
    return {};
  });
  // 池田さん(9日後入社): 一部進行中
  generate('A0102', (t) => {
    if (t.title === 'PC準備') return { status: 'in_progress' };
    if (t.title === '名刺発注') return { status: 'on_hold', description: `${t.description}\n※ 役職確定待ちのため保留` };
    return {};
  });
  // 橋本さん・阿部さんは未生成 (デモで自動生成を試せるように残す)

  const manual = (
    title: string,
    dept: string,
    assignee: string,
    priority: Priority,
    dueOffset: number,
    status: TaskStatus,
    employeeNum: string | null = null,
    description = '',
  ) => {
    const dueDate = addDays(today, dueOffset);
    tasks.push({
      id: generateId('task'),
      employeeId: employeeNum ? emp(employeeNum).id : null,
      title,
      description,
      assigneeDepartmentId: dept,
      assignee,
      priority,
      dueDate,
      status,
      source: 'manual',
      ruleId: null,
      createdAt: ts,
      updatedAt: ts,
      completedAt: status === 'done' ? new Date(`${dueDate}T15:00:00`).toISOString() : null,
    });
  };
  manual('退職者のアカウント停止確認', DEPT.joshis, '中村 拓也', 'high', -3, 'in_progress', 'A0036', '各SaaSのアカウント停止とPC回収の確認');
  manual('貸与PCの回収・初期化', DEPT.joshis, '小林 美咲', 'medium', -10, 'done', 'A0036');
  manual('育児休業中の社会保険料免除手続き', DEPT.jinji, '山本 恵', 'medium', 6, 'todo', 'A0035');
  manual('年末調整書類の配布準備', DEPT.jinji, '井上 彩', 'medium', 12, 'todo');
  manual('複合機リース契約の更新確認', DEPT.soumu, '加藤 由美', 'low', 20, 'todo');
  manual('ウイルス対策ソフトのライセンス更新', DEPT.joshis, '中村 拓也', 'high', 2, 'todo');
  manual('月次決算の締め処理', DEPT.keiri, '松本 直樹', 'high', -1, 'todo');
  manual('社内Wi-Fiアクセスポイント交換', DEPT.joshis, '小林 美咲', 'low', -15, 'done');
  manual('防災備蓄品の棚卸し', DEPT.soumu, '吉田 翔', 'low', -20, 'done');
  manual('採用面接の日程調整', DEPT.jinji, '井上 彩', 'medium', 1, 'in_progress');

  const act = (minutesAgo: number, category: ActivityLog['category'], action: string, message: string): ActivityLog => ({
    id: generateId('act'),
    at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    category,
    action,
    message,
    entityId: null,
  });
  const activities: ActivityLog[] = [
    act(60 * 50, 'employee', 'create', '社員「森 結衣」(A0101) を登録しました'),
    act(60 * 49, 'onboarding', 'generate', '森 結衣さんの入社準備タスクを自動生成しました'),
    act(60 * 30, 'employee', 'create', '社員「池田 悠真」(A0102) を登録しました'),
    act(60 * 29, 'onboarding', 'generate', '池田 悠真さんの入社準備タスクを自動生成しました'),
    act(60 * 5, 'employee', 'create', '社員「橋本 七海」(A0103) を登録しました'),
    act(60 * 3, 'employee', 'create', '社員「阿部 涼介」(A0104) を登録しました'),
    act(90, 'task', 'status', 'タスク「入社書類確認」を「完了」に変更しました'),
  ];

  return { departments, employees, tasks, rules, activities };
}
