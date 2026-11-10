/** An empty display list still retains the independently persisted aggregate clock. */
export function getDexPriceSourceEntries(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload as unknown[];
  return payload != null && typeof payload === "object" && "aggregateObservedAt" in payload &&
    "sources" in payload && Array.isArray(payload.sources) ? payload.sources as unknown[] : null;
}
