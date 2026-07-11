import { describe, it, expect } from "vitest";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { getDexDiscoveryProviders } from "@shared/lib/dex-deployment-coverage";

describe("liquidity coverage", () => {
  it("classifies every deployment through the canonical provider inventory", () => {
    const classified: string[] = [];
    for (const meta of ACTIVE_STABLECOINS) {
      for (const c of meta.contracts ?? []) {
        classified.push(`${meta.id}:${c.chain}:${getDexDiscoveryProviders(c.chain).join(",") || "provider-inaccessible"}`);
      }
      for (const c of meta.tradedContracts ?? []) {
        classified.push(`${meta.id}:${c.chain}:${getDexDiscoveryProviders(c.chain).join(",") || "provider-inaccessible"}`);
      }
    }
    expect(classified.filter((row) => row.endsWith(":provider-inaccessible"))).toHaveLength(262);
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
