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

function collapseAttributionKey(event: TapeEvent, cls: string): string {
  // Events with no coin attribution (e.g., USDT freeze.blocked rows from the
  // blacklist projector) still share a chain — group those so a single busy
  // chain doesn't flood the strip with one row per blacklist tx.
  if (event.coinId) return `coin:${event.coinId}:${cls}`;
  if (event.chain) return `chain:${event.chain}:${cls}`;
  return `event:${event.id}`;
}

function collapseTransitionKey(event: TapeEvent): string {
  return typeof event.transition === "string" && event.transition.length > 0
    ? event.transition
    : "none";
}

// Collapse non-consecutive runs of the same attribution, full event type,
// severity, and lifecycle transition into one
// entry positioned at the most recent occurrence. Used by the homepage strip
// and by /tape's day groups to keep flapping coins (e.g. USDXL with repeated
// peak updates) from dominating the visible list while keeping opposite
// lifecycle transitions and severity changes visible.
export function collapseByCoinClass(events: ReadonlyArray<TapeEvent>): CollapsedTapeEntry[] {
  const result: CollapsedTapeEntry[] = [];
  const indexByKey = new Map<string, number>();
  for (const event of events) {
    const cls = eventClassSlug(event.type);
    const key = [
      collapseAttributionKey(event, cls),
      `type:${event.type}`,
      `severity:${event.severity}`,
      `transition:${collapseTransitionKey(event)}`,
    ].join("|");
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
