/** 一意ID生成。crypto.randomUUID は非セキュアコンテキストで使えないためフォールバックを持つ */
export function generateId(prefix = ''): string {
  const c = globalThis.crypto;
  const uuid =
    c && typeof c.randomUUID === 'function'
      ? c.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
  return prefix ? `${prefix}_${uuid}` : uuid;
}

export function nowISO(): string {
  return new Date().toISOString();
}
