/**
 * OCR エンジン・言語データの取得とキャッシュ。
 *
 * - 配信元は WorkCore 自身 (public/vendor/)。外部CDN・外部APIには送受信しない
 * - 初回は利用者の操作で明示的にダウンロードし (約9MB)、Cache Storage に保存する
 * - 保存後はネットワークなしでも OCR を実行できる (同じブラウザ・同じ端末に限る。
 *   ブラウザの「サイトデータ削除」や iOS の容量不足時の自動削除で消えることがある)
 */

const CACHE_NAME = 'workcore-ocr-v1';

/** SIMD 対応の判定 (wasm-feature-detect と同じ最小モジュール) */
function supportsSimd(): boolean {
  try {
    return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
  } catch {
    return false;
  }
}

export const vendorUrl = (path: string) => new URL(`vendor/${path}`, document.baseURI).href;

export interface OcrAsset {
  key: 'worker' | 'core' | 'jpn' | 'eng';
  label: string;
  url: string;
  /** 目安のサイズ (表示用) */
  approxBytes: number;
}

export function ocrAssets(): OcrAsset[] {
  const core = supportsSimd() ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js';
  return [
    { key: 'worker', label: 'OCR処理プログラム', url: vendorUrl('ocr/worker.min.js'), approxBytes: 120_000 },
    { key: 'core', label: 'OCRエンジン本体', url: vendorUrl(`ocr/${core}`), approxBytes: 3_900_000 },
    { key: 'jpn', label: '日本語の認識データ', url: vendorUrl('ocr/lang/jpn.traineddata.gz'), approxBytes: 2_030_000 },
    { key: 'eng', label: '英語の認識データ', url: vendorUrl('ocr/lang/eng.traineddata.gz'), approxBytes: 2_950_000 },
  ];
}

export const OCR_DOWNLOAD_BYTES = ocrAssetsTotal();
function ocrAssetsTotal() {
  return 120_000 + 3_900_000 + 2_030_000 + 2_950_000;
}

const hasCacheStorage = () => typeof caches !== 'undefined';

/** OCR に必要なファイルがすべて端末に保存済みか */
export async function isOcrCached(): Promise<boolean> {
  if (!hasCacheStorage()) return false;
  try {
    const cache = await caches.open(CACHE_NAME);
    for (const a of ocrAssets()) if (!(await cache.match(a.url))) return false;
    return true;
  } catch {
    return false;
  }
}

export interface DownloadProgress {
  label: string;
  loaded: number;
  total: number;
}

async function fetchWithProgress(url: string, onBytes: (n: number) => void, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(url, { signal, cache: 'no-cache' });
  if (!res.ok) throw new Error(`ダウンロードに失敗しました（${res.status}）`);
  if (!res.body) {
    const buf = await res.arrayBuffer();
    onBytes(buf.byteLength);
    return new Response(buf, { headers: res.headers });
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    onBytes(value.byteLength);
  }
  return new Response(new Blob(chunks as BlobPart[]), { headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/octet-stream' } });
}

/**
 * 未取得のファイルをダウンロードして保存する。
 * Cache Storage が使えない環境では、毎回ネットワークから読む (オフライン不可) ことを呼び出し側で表示する
 */
export async function downloadOcrAssets(onProgress: (p: DownloadProgress) => void, signal?: AbortSignal): Promise<void> {
  const assets = ocrAssets();
  const total = assets.reduce((a, x) => a + x.approxBytes, 0);
  let loaded = 0;
  const cache = hasCacheStorage() ? await caches.open(CACHE_NAME) : null;
  for (const a of assets) {
    if (cache && (await cache.match(a.url))) {
      loaded += a.approxBytes;
      onProgress({ label: a.label, loaded, total });
      continue;
    }
    const res = await fetchWithProgress(a.url, (n) => {
      loaded += n;
      onProgress({ label: a.label, loaded: Math.min(loaded, total), total });
    }, signal);
    if (cache) await cache.put(a.url, res);
  }
}

/** 保存済みのファイルを取得 (なければネットワーク) */
async function load(url: string): Promise<Response> {
  if (hasCacheStorage()) {
    const hit = await (await caches.open(CACHE_NAME)).match(url);
    if (hit) return hit;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OCRのファイルを読み込めません（${res.status}）。ネットワークに接続して「OCRの準備」を行ってください`);
  return res;
}

export interface LoadedOcrAssets {
  workerUrl: string;
  coreUrl: string;
  langs: { code: string; data: Uint8Array }[];
  release(): void;
}

/** Worker・コアは Blob URL、言語データはメモリで Tesseract に渡す (キャッシュから読むため) */
export async function loadOcrAssets(): Promise<LoadedOcrAssets> {
  const [worker, core, jpn, eng] = ocrAssets();
  const workerUrl = URL.createObjectURL(new Blob([await (await load(worker!.url)).arrayBuffer()], { type: 'text/javascript' }));
  // tesseract.js は corePath の末尾が "js" のときにファイルとして扱うため、断片 (#) で拡張子を付ける
  const coreUrl = `${URL.createObjectURL(new Blob([await (await load(core!.url)).arrayBuffer()], { type: 'text/javascript' }))}#core.js`;
  const langs = [
    { code: 'jpn', data: new Uint8Array(await (await load(jpn!.url)).arrayBuffer()) },
    { code: 'eng', data: new Uint8Array(await (await load(eng!.url)).arrayBuffer()) },
  ];
  return {
    workerUrl,
    coreUrl,
    langs,
    release() {
      URL.revokeObjectURL(workerUrl);
      URL.revokeObjectURL(coreUrl.replace(/#.*$/, ''));
    },
  };
}

export async function clearOcrCache(): Promise<void> {
  if (hasCacheStorage()) await caches.delete(CACHE_NAME);
}

/** 端末の保存容量 (取得できない環境では null) */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    if (!navigator.storage?.estimate) return null;
    const e = await navigator.storage.estimate();
    if (!e.quota) return null;
    return { usage: e.usage ?? 0, quota: e.quota };
  } catch {
    return null;
  }
}

export const formatBytes = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : n >= 1024 ? `${Math.round(n / 1024)}KB` : `${n}B`);
