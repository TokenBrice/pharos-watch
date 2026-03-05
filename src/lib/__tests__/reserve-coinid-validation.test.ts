import { describe, it, expect } from "vitest";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";

// Known stablecoin tickers that should be linked when referenced in reserves
const KNOWN_TICKERS = ["USDC", "USDT", "DAI", "FRAX", "USDe", "USDtb", "BUIDL", "USDS", "USYC", "OUSG", "DOLA", "GHO", "crvUSD", "FRXUSD", "USD0"];

describe("reserve coinId validation", () => {
  it("no coin has both dependencies and reserve-linked coinIds", () => {
    const conflicts: string[] = [];
    for (const meta of TRACKED_STABLECOINS) {
      const hasManualDeps = meta.dependencies && meta.dependencies.length > 0;
      const hasLinkedReserves = meta.reserves?.some((r) => r.coinId);
      if (hasManualDeps && hasLinkedReserves) {
        conflicts.push(`${meta.symbol} (${meta.id}): has both dependencies and reserve coinIds`);
      }
    }
    expect(conflicts).toEqual([]);
  });

  it("warns about reserve names that look like tracked stablecoins without coinId", () => {
    const warnings: string[] = [];
    for (const meta of TRACKED_STABLECOINS) {
      if (!meta.reserves) continue;
      for (const slice of meta.reserves) {
        if (slice.coinId) continue; // already linked
        const upperName = slice.name.toUpperCase();
        for (const ticker of KNOWN_TICKERS) {
          if (upperName.includes(ticker.toUpperCase()) && !upperName.includes("NON-" + ticker.toUpperCase())) {
            warnings.push(`${meta.symbol} (${meta.id}): reserve "${slice.name}" mentions ${ticker} but has no coinId`);
          }
        }
      }
    }
    // This test intentionally logs warnings rather than failing hard,
    // to catch newly added reserves that forgot coinId.
    // If you see warnings here, add coinId to the relevant reserve slice.
    if (warnings.length > 0) {
      console.warn("Reserve slices that may need coinId:\n" + warnings.join("\n"));
    }
    // Fail if more than a reasonable threshold of unlinked references exist
    // Adjust threshold as more reserves get linked
    expect(warnings.length).toBeLessThanOrEqual(10);
  });
});
