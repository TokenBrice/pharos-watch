export interface RedstoneResult {
  price: number;
  venues: Map<string, number>;    // venue name → price
  venueCount: number;
  venueAgreementPct: number;      // % of venues within 50bps of median
  timestamp: number;
}

/**
 * Fetch prices from RedStone API with per-venue breakdown.
 * Free API, no auth, undocumented rate limits.
 */
export async function fetchRedstonePrices(
  symbols: string[],
  signal?: AbortSignal,
): Promise<Map<string, RedstoneResult>> {
  const results = new Map<string, RedstoneResult>();
  if (symbols.length === 0) return results;

  try {
    const symbolsParam = symbols.join(",");
    const res = await fetch(
      `https://api.redstone.finance/prices?symbols=${symbolsParam}&provider=redstone-primary-prod`,
      { signal, headers: { Accept: "application/json" } },
    );
    if (!res.ok) {
      console.warn(`[redstone] API returned ${res.status}`);
      return results;
    }

    const data = (await res.json()) as Record<string, Array<{
      value: number;
      source?: Record<string, number>;
      timestamp?: number;
    }>>;

    for (const [symbol, entries] of Object.entries(data)) {
      if (!entries || entries.length === 0) continue;
      const entry = entries[0];
      if (!entry.value || entry.value <= 0) continue;

      const venues = new Map<string, number>();
      if (entry.source) {
        for (const [venue, price] of Object.entries(entry.source)) {
          if (typeof price === "number" && price > 0) {
            venues.set(venue, price);
          }
        }
      }

      // Compute venue agreement: % of venues within 50bps of the aggregated price
      let agreeCount = 0;
      for (const venuePrice of venues.values()) {
        const bps = Math.abs(((venuePrice / entry.value) - 1) * 10000);
        if (bps <= 50) agreeCount++;
      }
      const venueAgreementPct = venues.size > 0
        ? Math.round((agreeCount / venues.size) * 100)
        : 100;

      results.set(symbol, {
        price: entry.value,
        venues,
        venueCount: venues.size,
        venueAgreementPct,
        timestamp: entry.timestamp ? Math.floor(entry.timestamp / 1000) : Math.floor(Date.now() / 1000),
      });
    }
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn("[redstone] Fetch failed:", err);
  }

  return results;
}
