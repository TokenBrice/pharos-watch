/** An empty display list still retains the independently persisted aggregate clock. */
export function getDexPriceSourceEntries(payload: unknown, purpose: "affirmative" | "display" = "affirmative"): unknown[] | null {
  if (Array.isArray(payload)) return payload as unknown[];
  if (payload == null || typeof payload !== "object" || !("aggregateObservedAt" in payload) ||
    !("sources" in payload) || !Array.isArray(payload.sources)) return null;
  return purpose === "display" && "displaySources" in payload && Array.isArray(payload.displaySources)
    ? payload.displaySources : payload.sources;
}
