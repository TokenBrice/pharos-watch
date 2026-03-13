import { describe, expect, it } from "vitest";
import { CANONICAL_ETH_RESERVE_RISK } from "../reserve-asset-risk";
import { TRACKED_META_BY_ID, TRACKED_STABLECOINS } from "@shared/lib/stablecoins";

describe("tracked stablecoin metadata", () => {
  it("does not attach a CoinGecko slug to M by M0 when the base token is not contract-resolved on CoinGecko", () => {
    const coin = TRACKED_META_BY_ID.get("m-m0");

    expect(coin).toBeDefined();
    expect(coin?.geckoId).toBeUndefined();
    expect(coin?.contracts?.some(
      (contract) => contract.chain === "ethereum" && contract.address.toLowerCase() === "0x866a2bf4e572cbcf37d5071a7a58503bfb36be1b",
    )).toBe(true);
  });

  it("uses explicit breaker scopes when a live-reserve adapter is reused across multiple coins", () => {
    const liveCoins = TRACKED_STABLECOINS.filter((coin) => coin.liveReservesConfig);
    const adapterUsage = new Map<string, string[]>();

    for (const coin of liveCoins) {
      const adapter = coin.liveReservesConfig!.adapter;
      const existing = adapterUsage.get(adapter);
      if (existing) {
        existing.push(coin.id);
      } else {
        adapterUsage.set(adapter, [coin.id]);
      }
    }

    const reusedAdapters = new Set(
      Array.from(adapterUsage.entries())
        .filter(([, ids]) => ids.length > 1)
        .map(([adapter]) => adapter),
    );

    const missingScopes = liveCoins
      .filter((coin) => reusedAdapters.has(coin.liveReservesConfig!.adapter))
      .filter((coin) => !coin.liveReservesConfig!.breakerScope)
      .map((coin) => `${coin.id}:${coin.liveReservesConfig!.adapter}`);

    expect(missingScopes).toEqual([]);
  });

  it("does not let one breaker scope cover multiple distinct live-reserve source configs", () => {
    const liveCoins = TRACKED_STABLECOINS.filter((coin) => coin.liveReservesConfig);
    const scopeSourceGroups = new Map<string, Set<string>>();

    for (const coin of liveCoins) {
      const config = coin.liveReservesConfig!;
      const scope = config.breakerScope ?? config.adapter;
      const sourceIdentity = JSON.stringify({
        adapter: config.adapter,
        version: config.version,
        semantics: config.semantics,
        inputs: config.inputs,
        params: config.params ?? null,
      });
      const existing = scopeSourceGroups.get(scope);
      if (existing) {
        existing.add(sourceIdentity);
      } else {
        scopeSourceGroups.set(scope, new Set([sourceIdentity]));
      }
    }

    const overlappingScopes = Array.from(scopeSourceGroups.entries())
      .filter(([, sourceIds]) => sourceIds.size > 1)
      .map(([scope]) => scope);

    expect(overlappingScopes).toEqual([]);
  });

  it("keeps direct ETH and WETH reserve mappings aligned with the canonical ETH risk tier", () => {
    const mismatches: string[] = [];

    for (const coin of TRACKED_STABLECOINS) {
      for (const slice of coin.reserves ?? []) {
        if (slice.name !== "ETH" && slice.name !== "WETH" && slice.name !== "WETH (wrapped Ether)") continue;
        if (slice.risk !== CANONICAL_ETH_RESERVE_RISK) {
          mismatches.push(`${coin.id}:reserve:${slice.name}:${slice.risk}`);
        }
      }

      const config = coin.liveReservesConfig;
      const params = config?.params;
      if (!params || typeof params !== "object" || Array.isArray(params)) continue;

      const maybeBranches = (params as { branches?: Array<{ name?: string; risk?: string }> }).branches;
      if (Array.isArray(maybeBranches)) {
        for (const branch of maybeBranches) {
          if (branch?.name !== "WETH") continue;
          if (branch.risk !== CANONICAL_ETH_RESERVE_RISK) {
            mismatches.push(`${coin.id}:branch:${branch.name}:${branch.risk ?? "missing"}`);
          }
        }
      }

      const maybeLabel = (params as { label?: string; risk?: string }).label;
      if (maybeLabel === "ETH" && (params as { risk?: string }).risk !== CANONICAL_ETH_RESERVE_RISK) {
        mismatches.push(`${coin.id}:single-asset:ETH:${(params as { risk?: string }).risk ?? "missing"}`);
      }

      const riskMap = (params as { riskMap?: Record<string, string> }).riskMap;
      if (riskMap?.ETH && riskMap.ETH !== CANONICAL_ETH_RESERVE_RISK) {
        mismatches.push(`${coin.id}:risk-map:ETH:${riskMap.ETH}`);
      }
    }

    expect(mismatches).toEqual([]);
  });
});
