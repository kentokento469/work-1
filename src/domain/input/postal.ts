/**
 * 郵便番号 → 住所。データは日本郵便の郵便番号データ (KEN_ALL) を整形し、WorkCore 自身から配信する
 * (scripts/build-postal-data.mjs が public/vendor/postal/{先頭3桁}.json を生成)。外部サービスには送信しない。
 */
import { digitsOnly } from './normalize';

export const PREFECTURES = ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'] as const;

export interface AddressCandidate {
  prefecture: string;
  city: string;
  town: string;
}

/** 7桁なら数字だけの郵便番号を返す */
export function normalizePostal(raw: string): string | null {
  const d = digitsOnly(raw);
  return d.length === 7 ? d : null;
}
export const formatPostal = (d: string) => (d.length === 7 ? `${d.slice(0, 3)}-${d.slice(3)}` : d);

export type PostalFetcher = (prefix: string) => Promise<Record<string, [number, string, string][]> | null>;

export type LookupResult = { status: 'found'; candidates: AddressCandidate[] } | { status: 'not_found' } | { status: 'error'; message: string };

export async function lookupPostal(code: string, fetcher: PostalFetcher): Promise<LookupResult> {
  const d = normalizePostal(code);
  if (!d) return { status: 'not_found' };
  try {
    const group = await fetcher(d.slice(0, 3));
    const rows = group?.[d.slice(3)];
    if (!rows?.length) return { status: 'not_found' };
    return { status: 'found', candidates: rows.map(([p, city, town]) => ({ prefecture: PREFECTURES[p] ?? '', city, town })) };
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : '住所データを読み込めませんでした' };
  }
}

/** ブラウザ用: 先頭3桁ごとのファイルを取得 (同じファイルは再取得しない)。404 = 該当なし */
const cache = new Map<string, Promise<Record<string, [number, string, string][]> | null>>();
export const browserPostalFetcher: PostalFetcher = (prefix) => {
  if (!cache.has(prefix)) {
    const url = new URL(`vendor/postal/${prefix}.json`, document.baseURI).href;
    const p = fetch(url).then((r) => {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`住所データを読み込めませんでした（${r.status}）`);
      // ファイルが無い番号に、サーバーが代わりのページ (HTML) を返す場合も「該当なし」
      if (!(r.headers.get('content-type') ?? '').includes('json')) return null;
      return r.json();
    });
    p.catch(() => cache.delete(prefix)); // 通信失敗は次回やり直せるようにする
    cache.set(prefix, p);
  }
  return cache.get(prefix)!;
};
