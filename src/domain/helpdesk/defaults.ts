/**
 * ヘルプデスクの初期マスタ (カテゴリ)。
 * DBマイグレーション・デモ初期化・旧バックアップの復元で共通に使う。
 * IDは固定にし、タスク提案ルールなどから安定して参照できるようにしている。
 */
import type { InquiryCategory } from '../types';

export const CAT = {
  pc: 'cat_pc',
  microsoft: 'cat_microsoft',
  google: 'cat_google',
  apple: 'cat_apple',
  network: 'cat_network',
  software: 'cat_software',
  access: 'cat_access',
  facility: 'cat_facility',
  other: 'cat_other',
} as const;

/** Phase 1 のデモ部署ID (情報システム部・総務部)。存在しない場合は担当部署なしで扱う */
const JOSHIS = 'dept_joshis';
const SOUMU = 'dept_soumu';

export function createDefaultInquiryCategories(): InquiryCategory[] {
  const c = (
    id: string,
    name: string,
    keywords: string[],
    dept: string | null,
    assignee: string,
    sla: number,
    order: number,
    isFallback = false,
  ): InquiryCategory => ({ id, name, keywords, defaultDepartmentId: dept, defaultAssignee: assignee, slaBusinessDays: sla, enabled: true, order, isFallback });
  return [
    c(CAT.pc, 'PC・周辺機器', ['パソコン', 'pc', 'ノートpc', 'ノートパソコン', 'pc本体', 'マウス', 'キーボード', 'モニター', 'ディスプレイ', 'プリンター', 'プリンタ', '複合機', '充電器', 'acアダプタ', '起動しない', '電源が入らない', 'ブルースクリーン', 'フリーズ', '画面が映らない', 'ヘッドセット', 'イヤホン', 'カメラが映らない'], JOSHIS, '小林 美咲', 2, 1),
    c(CAT.microsoft, 'Microsoftアカウント', ['microsoft', 'マイクロソフト', 'outlook', 'アウトルック', 'teams', 'チームズ', 'office', 'オフィス', 'excel', 'エクセル', 'word', 'ワード', 'powerpoint', 'パワーポイント', 'onedrive', 'sharepoint', 'm365', 'microsoft365', 'office365'], JOSHIS, '中村 拓也', 2, 2),
    c(CAT.google, 'Googleアカウント', ['google', 'グーグル', 'gmail', 'gメール', 'googleドライブ', 'グーグルドライブ', 'googleカレンダー', 'スプレッドシート', 'googleドキュメント', 'googlemeet', 'meet', 'workspace'], JOSHIS, '中村 拓也', 2, 3),
    c(CAT.apple, 'Appleアカウント', ['apple', 'アップル', 'appleid', 'apple id', 'icloud', 'アイクラウド', 'iphone', 'アイフォン', 'ipad', 'アイパッド', 'mac', 'マック', 'app store', 'appstore'], JOSHIS, '小林 美咲', 3, 4),
    c(CAT.network, 'ネットワーク', ['ネットワーク', 'インターネット', 'ネット', 'wi-fi', 'wifi', 'ワイファイ', '無線lan', '有線lan', 'lan', 'vpn', 'ルーター', '接続できない', 'つながらない', '繋がらない', '回線', '通信が遅い'], JOSHIS, '中村 拓也', 1, 5),
    c(CAT.software, 'ソフトウェア', ['ソフト', 'ソフトウェア', 'アプリ', 'インストール', 'アンインストール', 'アップデート', '更新プログラム', 'ライセンス', 'エラーメッセージ', 'adobe', 'acrobat', 'pdf', 'zoom', 'ブラウザ', 'chrome', 'クローム', 'edge', '会計システム', '勤怠システム'], JOSHIS, '小林 美咲', 3, 6),
    c(CAT.access, 'アカウント・権限', ['権限', 'アクセス権', '共有フォルダ', 'ファイルサーバ', 'アカウント発行', 'アカウント作成', 'アカウント削除', '多要素認証', '二段階認証', 'ロックされ', 'アカウントロック', '閲覧できない', 'アクセスできない', '入退室', '入館カード'], JOSHIS, '中村 拓也', 2, 7),
    c(CAT.facility, '備品・総務', ['備品', '文房具', '名刺', '座席', '席替え', '鍵', '入館証', '社員証', 'コピー用紙', 'トナー', '会議室', '机', '椅子', 'ロッカー', '郵便', '宅配', '社用車', '消耗品', '購入申請'], SOUMU, '加藤 由美', 3, 8),
    c(CAT.other, 'その他・要確認', [], JOSHIS, '', 3, 99, true),
  ];
}
