import { describe, it, expect } from "vitest";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { getLiquidityCoverageBadge } from "@/lib/liquidity-coverage";

describe("liquidity coverage", () => {
  it("distinguishes invalid evidence from genuinely unobserved coverage", () => {
    expect(getLiquidityCoverageBadge(null, "invalid-coverage-evidence").label).toBe("Unavailable");
    expect(getLiquidityCoverageBadge("unobserved").label).toBe("NR");
  });


  it("all colliding symbols have contracts for address-based disambiguation", () => {
    const symbolToIds = new Map<string, string[]>();
    for (const meta of ACTIVE_STABLECOINS) {
      const key = meta.symbol.toUpperCase();
      const ids = symbolToIds.get(key) ?? [];
      ids.push(meta.id);
      symbolToIds.set(key, ids);
    }

    const missing: string[] = [];
    for (const [symbol, ids] of symbolToIds) {
      if (ids.length <= 1) continue;
      for (const id of ids) {
        const meta = ACTIVE_STABLECOINS.find((m) => m.id === id);
        // Small symbols can rely on external IDs when there is no contract footprint.
        if (!meta?.contracts?.length && !meta?.tradedContracts?.length && (meta?.geckoId || meta?.cmcSlug)) continue;
        if (!meta?.contracts?.length && !meta?.tradedContracts?.length) {
          missing.push(`${symbol} (id=${id}) has no contracts for disambiguation`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
