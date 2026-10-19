/**
 * 画面が保持するデータ (DataSnapshot) の並び順と、差分の反映 (Phase 13R)。
 *
 * 保存のたびに全件を読み直す代わりに、変わったデータだけを読んでスナップショットに反映する。
 * 差分を反映した結果が、全件を読み直した結果と**同じ並び順**になるように、並び順を1か所で定義する
 * (主の条件が同じ場合は id の順。IndexedDB の getAll はキー (id) の順に返すため、全件の読み込みとも一致する)。
 */
import type { DataSnapshot } from '../domain/types';
import type { DataStoreName } from './db';

type Row = { id: string };
type Compare = (a: Row, b: Row) => number;

/** IndexedDB の文字列キーの順 (UTF-16 のコード単位の順) */
const byKey: Compare = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const then =
  <T extends Row>(primary: (a: T, b: T) => number): Compare =>
  (a, b) =>
    primary(a as T, b as T) || byKey(a, b);
const asc = <T extends Row>(f: (r: T) => number) => then<T>((a, b) => f(a) - f(b));
const ascText = <T extends Row>(f: (r: T) => string) => then<T>((a, b) => f(a).localeCompare(f(b)));
const descText = <T extends Row>(f: (r: T) => string) => then<T>((a, b) => f(b).localeCompare(f(a)));

type Rows<K extends DataStoreName> = DataSnapshot[K][number];
const ORDER: { [K in DataStoreName]?: Compare } = {
  departments: asc<Rows<'departments'>>((r) => r.order),
  activities: descText<Rows<'activities'>>((r) => r.at),
  inquiryCategories: asc<Rows<'inquiryCategories'>>((r) => r.order),
  inquiries: descText<Rows<'inquiries'>>((r) => r.receivedAt),
  items: ascText<Rows<'items'>>((r) => r.code),
  assets: ascText<Rows<'assets'>>((r) => r.assetNumber),
  stockMovements: descText<Rows<'stockMovements'>>((r) => r.at),
  assetEvents: descText<Rows<'assetEvents'>>((r) => r.at),
  purchaseOrders: descText<Rows<'purchaseOrders'>>((r) => r.number),
  locations: asc<Rows<'locations'>>((r) => r.order),
  equipmentRules: asc<Rows<'equipmentRules'>>((r) => r.order),
  automationRuns: descText<Rows<'automationRuns'>>((r) => r.at),
  documents: descText<Rows<'documents'>>((r) => r.createdAt),
};
const orderOf = (store: DataStoreName): Compare => ORDER[store] ?? byKey;

/** 全件を読み込んだ直後に、画面で使う並び順にする */
export function sortSnapshot(data: DataSnapshot): DataSnapshot {
  for (const store of Object.keys(ORDER) as DataStoreName[]) (data[store] as Row[]).sort(orderOf(store));
  return data;
}

/** 変わったデータ。'all' はそのデータの種類をすべて読み直す (全削除・カーソルでの変更など、変わった id が分からない場合) */
export type StoreChanges = Partial<Record<DataStoreName, string[] | 'all'>>;

/** 読み直した内容。id ごとの最新の行 (削除された id は null) */
export type FetchedChanges = Partial<Record<DataStoreName, { all: Row[] } | { rows: Map<string, Row | null> }>>;

/**
 * 差分をスナップショットに反映した新しいスナップショットを返す。
 * 変わらなかったデータの種類は**同じ配列のまま**にする (画面側で、配列が同じなら再計算を省ける)
 */
export function applyChanges(prev: DataSnapshot, fetched: FetchedChanges): DataSnapshot {
  const next = { ...prev };
  for (const store of Object.keys(fetched) as DataStoreName[]) {
    const f = fetched[store]!;
    const cmp = orderOf(store);
    if ('all' in f) {
      (next as Record<string, Row[]>)[store] = [...f.all].sort(cmp);
      continue;
    }
    if (!f.rows.size) continue;
    const kept = (prev[store] as Row[]).filter((r) => !f.rows.has(r.id));
    for (const row of f.rows.values()) if (row) insertSorted(kept, row, cmp);
    (next as Record<string, Row[]>)[store] = kept;
  }
  return next;
}

function insertSorted(rows: Row[], row: Row, cmp: Compare) {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cmp(rows[mid]!, row) <= 0) lo = mid + 1;
    else hi = mid;
  }
  rows.splice(lo, 0, row);
}
