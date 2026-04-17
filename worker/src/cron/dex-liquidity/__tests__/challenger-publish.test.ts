import { describe, expect, it } from "vitest";
import {
  buildDexPriceChallengerPublicationPlan,
  getDexPriceChallengerPublicationStatements,
  selectDexPriceChallengerRowsFromPools,
} from "../challenger-publish";

describe("challenger publish", () => {
  it("builds payload statements before snapshot metadata and suppresses incomplete coverage snapshots", () => {
    const completePlan = buildDexPriceChallengerPublicationPlan({
      stablecoinId: "USDT-TETHER",
      snapshotAt: 1_700_000_000.9,
      publishedAt: 1_700_000_111.2,
      sourceCoverageComplete: true,
      rows: [
        {
          stablecoinId: "usdt-tether",
          poolId: "pool-a",
          chain: "Ethereum",
          protocol: "curve",
          sourceFamily: "gecko-terminal",
          priceUsd: 0.999,
          tvlUsd: 10_000,
        },
        {
          stablecoinId: "USDT-TETHER",
          poolId: "pool-b",
          chain: "Base",
          protocol: "aerodrome",
          sourceFamily: "gecko-terminal",
          priceUsd: 1.001,
          tvlUsd: 15_000,
        },
      ],
    });

    expect(completePlan.skipReason).toBeNull();
    expect(completePlan.shouldPublishSnapshot).toBe(true);
    expect(completePlan.payloadStatements).toHaveLength(2);
    expect(completePlan.snapshotStatement).not.toBeNull();

    const ordered = getDexPriceChallengerPublicationStatements(completePlan);
    expect(ordered.map((stmt) => stmt.sql)).toEqual([
      completePlan.payloadStatements[0]!.sql,
      completePlan.payloadStatements[1]!.sql,
      completePlan.snapshotStatement!.sql,
    ]);

    const incompletePlan = buildDexPriceChallengerPublicationPlan({
      stablecoinId: "usdt-tether",
      snapshotAt: 1_700_000_000,
      sourceCoverageComplete: false,
      rows: [
        {
          stablecoinId: "usdt-tether",
          poolId: "pool-a",
          chain: "Ethereum",
          protocol: "curve",
          sourceFamily: "gecko-terminal",
          priceUsd: 0.999,
          tvlUsd: 10_000,
        },
      ],
    });

    expect(incompletePlan.skipReason).toBe("incomplete-coverage");
    expect(incompletePlan.shouldPublishSnapshot).toBe(false);
    expect(incompletePlan.snapshotStatement).toBeNull();
    expect(incompletePlan.payloadStatements).toHaveLength(1);
  });

  it("excludes blocked dead DEX pools from challenger selection", () => {
    const rows = selectDexPriceChallengerRowsFromPools(
      "usr-resolv",
      [
        {
          poolId: "ethereum:bunni-1",
          project: "bunni-ethereum",
          chain: "Ethereum",
          tvlUsd: 1_451_774,
          symbol: "USR-USDC",
          volumeUsd1d: 12_000,
          volumeUsd7d: 84_000,
          poolType: "generic",
          source: "gecko_terminal",
          price: 0.9993,
        },
        {
          poolId: "ethereum:curve-1",
          project: "curve",
          chain: "Ethereum",
          tvlUsd: 64_711,
          symbol: "USR-USDC",
          volumeUsd1d: 8_000,
          volumeUsd7d: 56_000,
          poolType: "curve-stableswap",
          source: "dl",
          price: 0.1152,
        },
      ],
      20_000,
    );

    expect(rows).toEqual([
      expect.objectContaining({
        poolId: "ethereum:curve-1",
        protocol: "curve",
        priceUsd: 0.1152,
        tvlUsd: 64_711,
      }),
    ]);
  });
});
