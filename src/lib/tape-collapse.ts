import type { TapeEvent } from "@shared/types/tape-event";

export function eventClassSlug(type: string): string {
  const dot = type.indexOf(".");
  return dot === -1 ? type : type.slice(0, dot);
}

export interface CollapsedTapeEntry {
  key: string;
  event: TapeEvent;
  count: number;
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
    const key = event.coinId ? `${event.coinId}:${cls}` : `event:${event.id}`;
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
