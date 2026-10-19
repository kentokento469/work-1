/**
 * 書き込みの記録 (Phase 13R)。保存のあとに全件を読み直さず、変わったデータだけを読み直すために使う。
 *
 * サービスに渡すデータベースの接続を Proxy で包み、書き込みのトランザクションで呼ばれた
 * put / add / delete / clear を「データの種類 → 変わった id」として記録する。
 * - 記録はトランザクションが**完了したときだけ**確定する (中断・失敗した書き込みは反映しない)
 * - 変わった id が分からない操作 (全削除・範囲の削除・カーソルでの変更) は、その種類を「すべて読み直す」にする
 * - 読み取り専用のトランザクションは包まない (余分な処理をしない)
 *
 * サービスのコードは変えずに済む (57か所の書き込みを1つずつ書き換えない)。代わりに、
 * 記録の漏れがないことを単体テストで「差分の反映 = 全件の読み直し」と比べて確認する (snapshotDelta.test.ts)
 */
import type { WorkCoreDB } from './db';
import { DATA_STORES, type DataStoreName } from './db';
import type { StoreChanges } from './snapshot';

type Changes = Map<string, Set<string> | 'all'>;

const DATA = new Set<string>(DATA_STORES);

function mark(changes: Changes, store: string, key: unknown) {
  if (!DATA.has(store)) return;
  const cur = changes.get(store);
  if (cur === 'all') return;
  if (typeof key !== 'string') return void changes.set(store, 'all');
  if (cur) cur.add(key);
  else changes.set(store, new Set([key]));
}

/** 関数は元のオブジェクトに結び付けて返す (idb のメソッドは this で元のオブジェクトを探すため) */
function passThrough(target: object, prop: string | symbol) {
  const v = Reflect.get(target, prop, target);
  return typeof v === 'function' ? v.bind(target) : v;
}

export class ChangeTracker {
  private committed: Changes = new Map();
  private pending = new Set<Promise<void>>();

  /** 書き込みを記録する接続を返す */
  wrap(db: WorkCoreDB): WorkCoreDB {
    return new Proxy(db, {
      get: (target, prop) => {
        if (prop === 'transaction')
          return (...args: Parameters<WorkCoreDB['transaction']>) => {
            const tx = target.transaction(...args);
            return args[1] === 'readwrite' ? this.trackTx(tx) : tx;
          };
        // db.put('tasks', value) などの省略形 (内部で1件だけのトランザクションになる)
        if (prop === 'put' || prop === 'add' || prop === 'delete' || prop === 'clear')
          return (store: string, ...rest: unknown[]) => {
            const local: Changes = new Map();
            const key = prop === 'clear' ? undefined : prop === 'delete' ? rest[0] : (rest[1] ?? (rest[0] as { id?: unknown } | undefined)?.id);
            mark(local, store, key);
            const result = (target[prop] as (...a: unknown[]) => Promise<unknown>)(store, ...rest);
            this.settle(result.then(() => undefined), local);
            return result;
          };
        return passThrough(target, prop);
      },
    });
  }

  private settle(done: Promise<void>, local: Changes) {
    const p = done.then(
      () => this.merge(local),
      () => undefined,
    );
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  private merge(local: Changes) {
    for (const [store, keys] of local) {
      if (keys === 'all') this.committed.set(store, 'all');
      else for (const k of keys) mark(this.committed, store, k);
    }
  }

  private trackTx<T extends { done: Promise<void>; objectStore(name: never): unknown; store?: unknown; objectStoreNames: DOMStringList }>(tx: T): T {
    const local: Changes = new Map();
    this.settle(tx.done, local);
    const trackStore = (store: object, name: string): object =>
      new Proxy(store, {
        get: (target, prop) => {
          if (prop === 'put' || prop === 'add')
            return (value: { id?: unknown }, key?: unknown) => {
              mark(local, name, key ?? value?.id);
              return Reflect.get(target, prop, target).call(target, value, key);
            };
          if (prop === 'delete')
            return (key: unknown) => {
              mark(local, name, key);
              return Reflect.get(target, prop, target).call(target, key);
            };
          if (prop === 'clear' || prop === 'openCursor' || prop === 'openKeyCursor')
            return (...args: unknown[]) => {
              mark(local, name, undefined);
              return Reflect.get(target, prop, target).apply(target, args);
            };
          if (prop === 'index')
            return (indexName: string) => {
              const index = Reflect.get(target, 'index', target).call(target, indexName) as object;
              // 索引のカーソルから削除・変更できるため、カーソルを開いたら「すべて読み直す」
              return new Proxy(index, {
                get: (t, p) => {
                  if (p === 'openCursor' || p === 'openKeyCursor')
                    return (...args: unknown[]) => {
                      mark(local, name, undefined);
                      return Reflect.get(t, p, t).apply(t, args);
                    };
                  return passThrough(t, p);
                },
              });
            };
          return passThrough(target, prop);
        },
      });
    return new Proxy(tx, {
      get: (target, prop) => {
        if (prop === 'objectStore') return (name: string) => trackStore(target.objectStore(name as never) as object, name);
        if (prop === 'store') return trackStore(target.store as object, target.objectStoreNames[0]!);
        return passThrough(target, prop);
      },
    });
  }

  /** 完了していない書き込みを待ってから、これまでの変更を取り出す (取り出した変更は消える) */
  async take(): Promise<StoreChanges> {
    while (this.pending.size) await Promise.all([...this.pending]);
    const out: StoreChanges = {};
    for (const [store, keys] of this.committed) out[store as DataStoreName] = keys === 'all' ? 'all' : [...keys];
    this.committed = new Map();
    return out;
  }

  /** 全件を読み直すときは、それまでの変更を捨てる */
  discard(): void {
    this.committed = new Map();
  }
}
