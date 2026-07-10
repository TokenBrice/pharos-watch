import { describe, expect, it } from "vitest";
import {
  buildDexDeploymentCoverage,
  normalizeTopPools,
  selectTrendBaseline,
} from "../dex-liquidity-response";

describe("normalizeTopPools", () => {
  it("strips dead per-pool fields and preserves allowed keys", () => {
    const json = JSON.stringify([
      {
        project: "uniswap-v3",
        chain: "Ethereum",
        symbol: "USDC / USDT",
        poolType: "generic",
        tvlUsd: 100_000,
        volumeUsd1d: 50_000,
        volumeUsd7d: 300_000,
        poolId: "0xabc",
        price: 1.0001,
        source: "dl",
        extra: {
          balanceRatio: 0.5,
          feeTier: 100,
          qualityAdjustedTvl: 80_000,
          hasMeasuredOrganicFraction: true,
          organicFraction: 0.9,
        },
      },
    ]);
    const result = normalizeTopPools(json);
    expect(result).toHaveLength(1);
    const pool = result[0] as Record<string, unknown>;
    // Allowed top-level keys present
    expect(pool.project).toBe("uniswap-v3");
    expect(pool.tvlUsd).toBe(100_000);
    expect(pool.volumeUsd1d).toBe(50_000);
    expect(pool.price).toBe(1.0001);
    expect(pool.source).toBe("dl");
    // Dead top-level keys stripped
    expect(pool).not.toHaveProperty("poolId");
    expect(pool).not.toHaveProperty("volumeUsd7d");
    // Allowed extra keys present
    const extra = pool.extra as Record<string, unknown>;
    expect(extra.balanceRatio).toBe(0.5);
    expect(extra.feeTier).toBe(100);
    expect(extra.organicFraction).toBe(0.9);
    // Dead extra keys stripped
    expect(extra).not.toHaveProperty("qualityAdjustedTvl");
    expect(extra).not.toHaveProperty("hasMeasuredOrganicFraction");
  });

  it("omits extra when pool has no extra object", () => {
    const json = JSON.stringify([
      { project: "curve", chain: "Ethereum", tvlUsd: 200_000, source: "dl" },
    ]);
    const result = normalizeTopPools(json);
    expect(result[0]).not.toHaveProperty("extra");
  });

  it("returns an empty array for non-array JSON payloads", () => {
    expect(normalizeTopPools("{}")).toEqual([]);
    expect(normalizeTopPools("null")).toEqual([]);
  });

  it("skips primitive, null, and array entries without throwing", () => {
    const result = normalizeTopPools(JSON.stringify([
      null,
      1,
      "bad",
      ["not-a-pool"],
      { project: "curve", chain: "Ethereum", tvlUsd: 200_000, source: "dl" },
    ]));

    expect(result).toEqual([{
      project: "curve",
      chain: "Ethereum",
      tvlUsd: 200_000,
      source: "dl",
    }]);
  });

  it("omits malformed extra values", () => {
    const json = JSON.stringify([
      { project: "curve", chain: "Ethereum", tvlUsd: 200_000, source: "dl", extra: ["bad"] },
    ]);
    const result = normalizeTopPools(json);
    expect(result[0]).not.toHaveProperty("extra");
  });
});

describe("selectTrendBaseline", () => {
  it("uses the nearest eligible row and ignores low-confidence history", () => {
    const targetSec = 1_700_000_000;
    const history = [
      {
        stablecoin_id: "usdt-tether",
        total_tvl_usd: 200,
        snapshot_date: targetSec - 60,
        coverage_class: "primary",
        coverage_confidence: 0.4,
      },
      {
        stablecoin_id: "usdt-tether",
        total_tvl_usd: 100,
        snapshot_date: targetSec - 120,
        coverage_class: "primary",
        coverage_confidence: 0.9,
      },
    ];

    expect(selectTrendBaseline(history, targetSec, 12 * 3600)).toEqual(history[1]);
  });

  it("rejects rows outside the trend tolerance window", () => {
    const targetSec = 1_700_000_000;
    const history = [
      {
        stablecoin_id: "usdt-tether",
        total_tvl_usd: 100,
        snapshot_date: targetSec - 13 * 3600,
        coverage_class: "primary",
        coverage_confidence: 0.9,
      },
    ];

    expect(selectTrendBaseline(history, targetSec, 12 * 3600)).toBeNull();
  });
});

describe("buildDexDeploymentCoverage", () => {
  it("keeps verified empty separate from inaccessible and expires waivers", () => {
    const rows = [
      {
        stablecoin_id: "coin",
        chain: "ethereum",
        contract_address: "0x1",
        outcome: "verified_no_pools" as const,
        provider_set_json: JSON.stringify(["coingecko"]),
        reason: "verified empty",
        observed_pool_count: 0,
        observed_at: 100,
        waiver_owner: null,
        waiver_reason: null,
        waiver_expires_at: null,
      },
      {
        stablecoin_id: "coin",
        chain: "cardano",
        contract_address: "asset1",
        outcome: "provider_inaccessible" as const,
        provider_set_json: "[]",
        reason: "unsupported",
        observed_pool_count: 0,
        observed_at: 100,
        waiver_owner: "data-platform",
        waiver_reason: "adapter pending",
        waiver_expires_at: 200,
      },
    ];

    const active = buildDexDeploymentCoverage(rows, 150).get("coin");
    expect(active).toMatchObject({ verifiedNoPools: 1, providerInaccessible: 1 });
    expect(active?.deployments[1]?.waiver).toMatchObject({ owner: "data-platform", expiresAt: 200 });

    const expired = buildDexDeploymentCoverage(rows, 200).get("coin");
    expect(expired?.deployments[1]?.waiver).toBeNull();
  });
});
