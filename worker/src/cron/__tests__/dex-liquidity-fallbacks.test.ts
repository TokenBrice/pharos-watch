import { describe, expect, it } from "vitest";

import { getFallbackTargets } from "../dex-liquidity/fetch-fallbacks";
import { initMetrics } from "../dex-liquidity/pool-helpers";

describe("getFallbackTargets", () => {
  it("targets coins with zero pools, missing dex price observations, or weak partial coverage", () => {
    const metrics = new Map<string, ReturnType<typeof initMetrics>>();
    const zeroPools = initMetrics("usdt-tether", "USDT");
    zeroPools.poolCount = 0;
    metrics.set("usdt-tether", zeroPools);

    const missingPrice = initMetrics("usdc-circle", "USDC");
    missingPrice.poolCount = 3;
    metrics.set("usdc-circle", missingPrice);

    const covered = initMetrics("dai-makerdao", "DAI");
    covered.poolCount = 4;
    covered.totalTvlUsd = 500_000;
    covered.totalTvlForBalance = 200_000;
    metrics.set("dai-makerdao", covered);

    const priceObservations = new Map([
      ["usdt-tether", [{ price: 1, tvl: 100_000, chain: "ethereum", protocol: "curve" }]],
      [
        "dai-makerdao",
        [
          { price: 1, tvl: 150_000, chain: "ethereum", protocol: "curve" },
          { price: 1, tvl: 100_000, chain: "base", protocol: "uniswap-v3" },
        ],
      ],
    ]);

    const targetIds = new Set(
      getFallbackTargets(metrics, priceObservations, { requireTrackedContracts: true }).map((meta) => meta.id),
    );

    expect(targetIds.has("usdt-tether")).toBe(true);
    expect(targetIds.has("usdc-circle")).toBe(true);
    expect(targetIds.has("dai-makerdao")).toBe(false);
  });

  it("targets a coin whose only weakness is measured-balance coverage", () => {
    const metrics = new Map<string, ReturnType<typeof initMetrics>>();
    const weakBalance = initMetrics("dai-makerdao", "DAI");
    weakBalance.poolCount = 4;
    weakBalance.totalTvlUsd = 500_000;
    weakBalance.totalTvlForBalance = 0;
    metrics.set("dai-makerdao", weakBalance);

    const priceObservations = new Map([
      [
        "dai-makerdao",
        [
          { price: 1, tvl: 150_000, chain: "ethereum", protocol: "curve" },
          { price: 1, tvl: 100_000, chain: "base", protocol: "uniswap-v3" },
        ],
      ],
    ]);

    const targetIds = new Set(
      getFallbackTargets(metrics, priceObservations, { requireTrackedContracts: true }).map((meta) => meta.id),
    );

    expect(targetIds.has("dai-makerdao")).toBe(true);
  });

  it("can restrict orderbook fallback targets to coins with a geckoId", () => {
    const metrics = new Map<string, ReturnType<typeof initMetrics>>();
    const noGecko = initMetrics("rwausdi-multipli", "rwaUSDi");
    metrics.set("rwausdi-multipli", noGecko);

    const targetIds = new Set(getFallbackTargets(metrics, new Map(), { requireGeckoId: true }).map((meta) => meta.id));

    expect(targetIds.has("rwausdi-multipli")).toBe(false);
  });
});
