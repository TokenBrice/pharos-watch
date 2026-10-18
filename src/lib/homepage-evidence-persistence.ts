import { z } from "zod";
import { HomepageSnapshotSchema, type HomepageSnapshot } from "@shared/types/homepage";
import { DEPEG_DEWS_METHODOLOGY_VERSION, PSI_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/constants";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "@/lib/api-query-descriptors";
import { isRetainableHomepageLane } from "@/lib/homepage-evidence";
import { openPublicEvidenceDatabase, PUBLIC_EVIDENCE_STORE as STORE } from "@/lib/public-evidence-database";

export const HOMEPAGE_EVIDENCE_QUERY_KEY = FRONTEND_API_QUERY_DESCRIPTORS.homepageSnapshot.queryKey;
export const HOMEPAGE_EVIDENCE_VERSION = 1;
export const HOMEPAGE_EVIDENCE_METHODOLOGY = `psi:${PSI_METHODOLOGY_VERSION};peg:${DEPEG_DEWS_METHODOLOGY_VERSION}`;
export const HOMEPAGE_EVIDENCE_MAX_CHARS = 32_768;
const KEY = "homepage";
const LANES = ["market", "psi", "incidents"] as const;

const EvidenceEnvelopeSchema = z.object({
  version: z.literal(HOMEPAGE_EVIDENCE_VERSION),
  methodology: z.literal(HOMEPAGE_EVIDENCE_METHODOLOGY),
  snapshot: HomepageSnapshotSchema,
});

/** Treat disk as untrusted input; no producer clock is derived from storage/receipt time. */
export function parseHomepageEvidence(raw: unknown, nowMs = Date.now()): HomepageSnapshot | null {
  if (typeof raw !== "string" || raw.length > HOMEPAGE_EVIDENCE_MAX_CHARS) return null;
  try {
    const result = EvidenceEnvelopeSchema.safeParse(JSON.parse(raw));
    if (!result.success) return null;
    const snapshot = result.data.snapshot;
    const market = snapshot.market;
    if (market.data?.asOfISO != null
      && (!Number.isFinite(Date.parse(market.data.asOfISO))
        || market.meta.updatedAt === null || Date.parse(market.data.asOfISO) !== market.meta.updatedAt * 1000)) return null;
    return LANES.some((key) => snapshot[key].data !== null && isRetainableHomepageLane(snapshot[key].meta, nowMs))
      ? snapshot : null;
  } catch {
    return null;
  }
}

/** Merge per producer, never by an envelope's receipt/assessment clock. */
export function mergeHomepageEvidence(
  previous: HomepageSnapshot | null,
  incoming: HomepageSnapshot,
  nowMs = Date.now(),
): HomepageSnapshot {
  function lane<K extends typeof LANES[number]>(key: K): HomepageSnapshot[K] {
    const next = incoming[key];
    const saved = previous?.[key];
    if (saved && saved.data !== null && isRetainableHomepageLane(saved.meta, nowMs)
      && (next.data === null || !isRetainableHomepageLane(next.meta, nowMs) || next.meta.updatedAt! < saved.meta.updatedAt!)) return saved;
    return next;
  }
  return { market: lane("market"), psi: lane("psi"), incidents: lane("incidents") };
}


export async function restoreHomepageEvidence(): Promise<HomepageSnapshot | null> {
  const db = await openPublicEvidenceDatabase();
  if (!db) return null;
  const { promise, resolve } = Promise.withResolvers<HomepageSnapshot | null>();
  try {
    const transaction = db.transaction(STORE, "readonly");
    const request = transaction.objectStore(STORE).get(KEY);
    let snapshot: HomepageSnapshot | null = null;
    request.onsuccess = () => { snapshot = parseHomepageEvidence(request.result); };
    transaction.oncomplete = () => { db.close(); resolve(snapshot); };
    transaction.onabort = transaction.onerror = () => { db.close(); resolve(null); };
  } catch {
    db.close();
    resolve(null);
  }
  return promise;
}

/** Only a bounded public projection is admitted, not query caches or user preferences. */
export async function persistHomepageEvidence(data: unknown): Promise<void> {
  const parsed = HomepageSnapshotSchema.safeParse(data);
  if (!parsed.success) return;
  const db = await openPublicEvidenceDatabase();
  if (!db) return;
  const { promise, resolve } = Promise.withResolvers<void>();
  try {
    // Read/merge/write in one serialized transaction also fences concurrent tabs.
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const request = store.get(KEY);
    request.onsuccess = () => {
      try {
        const snapshot = mergeHomepageEvidence(parseHomepageEvidence(request.result), parsed.data);
        const encoded = JSON.stringify({ version: HOMEPAGE_EVIDENCE_VERSION, methodology: HOMEPAGE_EVIDENCE_METHODOLOGY, snapshot });
        if (encoded.length <= HOMEPAGE_EVIDENCE_MAX_CHARS) store.put(encoded, KEY);
      } catch {
        transaction.abort();
      }
    };
    transaction.oncomplete = transaction.onabort = transaction.onerror = () => { db.close(); resolve(); };
  } catch {
    db.close();
    resolve();
  }
  return promise;
}
