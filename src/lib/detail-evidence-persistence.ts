import { z } from "zod";
import { ApiMetaSchema } from "@pharos/contracts/api-meta";
import { StablecoinLiveSummarySchema } from "@shared/types/stablecoin-live-summary";
import { isRetainableDetailEvidence, selectDetailEvidence, type DetailEvidence } from "@/lib/detail-evidence-selection";
import { openPublicEvidenceDatabase, PUBLIC_EVIDENCE_STORE } from "@/lib/public-evidence-database";

export const DETAIL_EVIDENCE_VERSION = 1;
export const DETAIL_EVIDENCE_MAX_COINS = 20;
export const DETAIL_EVIDENCE_MAX_CHARS = 65_536;
const KEY = "detail";
const CoinIdSchema = z.string().max(100).regex(/^[a-z0-9-]+$/);
const EvidenceSchema = z.object({ data: StablecoinLiveSummarySchema, meta: ApiMetaSchema });
const EnvelopeSchema = z.object({
  version: z.literal(DETAIL_EVIDENCE_VERSION),
  entries: z.array(z.object({ coinId: CoinIdSchema, evidence: EvidenceSchema })).max(DETAIL_EVIDENCE_MAX_COINS),
});
type Entry = { coinId: string; evidence: DetailEvidence };

/** Array order is LRU, not a receipt-time source clock or a browsing-history log. */
export function parseDetailEvidence(raw: unknown, nowMs = Date.now()): Entry[] {
  if (typeof raw !== "string" || raw.length > DETAIL_EVIDENCE_MAX_CHARS) return [];
  try {
    const parsed = EnvelopeSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || new Set(parsed.data.entries.map((entry) => entry.coinId)).size !== parsed.data.entries.length) return [];
    return parsed.data.entries.filter((entry) => isRetainableDetailEvidence(entry.evidence, nowMs));
  } catch {
    return [];
  }
}

function encode(entries: Entry[]): string {
  return JSON.stringify({ version: DETAIL_EVIDENCE_VERSION, entries });
}

/** Atomic read/merge/LRU-write fences concurrent tabs and never persists query caches. */
async function updateDetailEvidence(coinId: string, incoming?: DetailEvidence): Promise<DetailEvidence | null> {
  if (!CoinIdSchema.safeParse(coinId).success) return null;
  const db = await openPublicEvidenceDatabase();
  if (!db) return null;
  const { promise, resolve } = Promise.withResolvers<DetailEvidence | null>();
  try {
    const transaction = db.transaction(PUBLIC_EVIDENCE_STORE, "readwrite");
    const store = transaction.objectStore(PUBLIC_EVIDENCE_STORE);
    const request = store.get(KEY);
    let selected: DetailEvidence | null = null;
    request.onsuccess = () => {
      try {
        const nowMs = Date.now();
        const entries = parseDetailEvidence(request.result, nowMs);
        const previous = entries.find((entry) => entry.coinId === coinId)?.evidence ?? null;
        if (incoming && isRetainableDetailEvidence(incoming, nowMs)) {
          const selection = selectDetailEvidence(incoming, previous, nowMs);
          selected = selection.isRetained ? previous : incoming;
        } else selected = previous;
        const next = entries.filter((entry) => entry.coinId !== coinId);
        if (selected) next.push({ coinId, evidence: selected });
        while (next.length > DETAIL_EVIDENCE_MAX_COINS || encode(next).length > DETAIL_EVIDENCE_MAX_CHARS) next.shift();
        if (selected && !next.some((entry) => entry.coinId === coinId)) selected = null;
        store.put(encode(next), KEY);
      } catch {
        transaction.abort();
      }
    };
    transaction.oncomplete = () => { db.close(); resolve(selected); };
    transaction.onabort = transaction.onerror = () => { db.close(); resolve(null); };
  } catch {
    db.close();
    resolve(null);
  }
  return promise;
}

export function restoreDetailEvidence(coinId: string): Promise<DetailEvidence | null> {
  return updateDetailEvidence(coinId);
}

export async function persistDetailEvidence(coinId: string, evidence: unknown): Promise<void> {
  const parsed = EvidenceSchema.safeParse(evidence);
  if (!parsed.success || !isRetainableDetailEvidence(parsed.data, Date.now())) return;
  await updateDetailEvidence(coinId, parsed.data);
}
