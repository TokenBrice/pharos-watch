const DATABASE = "pharos-public-evidence";
export const PUBLIC_EVIDENCE_STORE = "snapshots";

/** Optional browser evidence must never gate or reject the live read. */
export function openPublicEvidenceDatabase(): Promise<IDBDatabase | null> {
  const { promise, resolve } = Promise.withResolvers<IDBDatabase | null>();
  try {
    if (typeof indexedDB === "undefined") return Promise.resolve(null);
    const request = indexedDB.open(DATABASE, 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(PUBLIC_EVIDENCE_STORE)) request.result.createObjectStore(PUBLIC_EVIDENCE_STORE);
    };
    request.onblocked = () => { blocked = true; resolve(null); };
    request.onerror = () => resolve(null);
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else resolve(request.result);
    };
  } catch {
    resolve(null);
  }
  return promise;
}
