import type { TapeEvent } from "@shared/types/tape-event";

export function eventClassSlug(type: string): string {
  const dot = type.indexOf(".");
  return dot === -1 ? type : type.slice(0, dot);
}

export interface CollapsedTapeEntry {
  key: string;
  event: TapeEvent;
  count: number;
  // When set with length > 1, the entry represents the same event class +
  // transition observed across multiple coins (used by the homepage strip to
  // merge a sweep of DEWS band changes into one cell with a logo stack).
  coinIds?: string[];
}

// Collapse non-consecutive runs of the same (coinId, eventClass) into one
// entry positioned at the most recent occurrence. Used by the homepage strip
// and by /tape's day groups to keep flapping coins (e.g. USDXL with repeated
// peg cycles) from dominating the visible list.
export function collapseByCoinClass(events: ReadonlyArray<TapeEvent>): CollapsedTapeEntry[] {
  const result: CollapsedTapeEntry[] = [];
  const indexByKey = new Map<string, number>();
  for (const event of events) {
    const cls = eventClassSlug(event.type);
    // Events with no coin attribution (e.g., USDT freeze.blocked rows from the
    // blacklist projector) still share a chain — group repeated rows without
    // merging different freeze subtypes or stablecoin identities.
    const stablecoin = event.payload?.stablecoin;
    const nullCoinIdentity =
      typeof stablecoin === "string" && stablecoin.trim()
        ? `${event.type}:stablecoin:${stablecoin}`
        : event.type;
    const key = event.coinId
      ? `${event.coinId}:${cls}`
      : event.chain
        ? `chain:${event.chain}:${nullCoinIdentity}`
        : `event:${event.id}`;
    const existingIdx = indexByKey.get(key);
    if (existingIdx != null) {
      result[existingIdx]!.count += 1;
    } else {
      indexByKey.set(key, result.length);
      result.push({ key, event, count: 1 });
    }
  }
  return result;
}

// Homepage-strip variant: after the coin+class collapse, merge `dews.escalated`
// and `dews.deescalated` entries that share the same band transition
// (e.g. CALM → WATCH) across coins. A 15-min cycle that flips dozens of coins
// would otherwise dominate the strip with near-identical rows.
//
// /timeline keeps the per-coin granularity by using `collapseByCoinClass`
// directly.
export function collapseForHomepageStrip(events: ReadonlyArray<TapeEvent>): CollapsedTapeEntry[] {
  const base = collapseByCoinClass(events);
  const result: CollapsedTapeEntry[] = [];
  const indexByKey = new Map<string, number>();
  for (const entry of base) {
    const { type, coinId, payload } = entry.event;
    const isDewsBand = type === "dews.escalated" || type === "dews.deescalated";
    const prev = payload?.prevBand;
    const next = payload?.newBand;
    if (!isDewsBand || !coinId || typeof prev !== "string" || typeof next !== "string") {
      result.push(entry);
      continue;
    }
    const key = `${type}:${prev}->${next}`;
    const existingIdx = indexByKey.get(key);
    if (existingIdx == null) {
      indexByKey.set(key, result.length);
      result.push({ ...entry, key, coinIds: [coinId] });
    } else {
      const existing = result[existingIdx]!;
      existing.count += entry.count;
      existing.coinIds = [...(existing.coinIds ?? []), coinId];
    }
  }
  return result;
}
