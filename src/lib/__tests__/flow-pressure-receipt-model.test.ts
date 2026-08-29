import { describe, expect, it } from "vitest";
import { buildFlowPressureReceiptModel } from "@/lib/flow-pressure-receipt-model";
import type { MintBurnCoinFlow, MintBurnGauge, MintBurnHourlyBucket } from "@shared/types";

const gauge: MintBurnGauge = {
  score: 18,
  band: "normal",
  intensitySemantics: "signed-v2",
  flightToQuality: false,
  flightIntensity: 0,
  trackedCoins: 3,
  trackedMcapUsd: 120_000_000_000,
};

function makeCoin(overrides: Partial<MintBurnCoinFlow>): MintBurnCoinFlow {
  return {
    stablecoinId: overrides.stablecoinId ?? "usdc-circle",
    symbol: overrides.symbol ?? "USDC",
    flowIntensity: overrides.flowIntensity ?? 0,
    pressureShiftScore: overrides.pressureShiftScore ?? null,
    pressureShiftState: overrides.pressureShiftState ?? "nr",
    netFlowDirection24h: overrides.netFlowDirection24h ?? "inactive",
    has24hActivity: overrides.has24hActivity ?? false,
    baselineDailyNetUsd: overrides.baselineDailyNetUsd ?? null,
    baselineDailyAbsUsd: overrides.baselineDailyAbsUsd ?? null,
    baselineDataDays: overrides.baselineDataDays ?? null,
    netFlow24hUsd: overrides.netFlow24hUsd ?? 0,
    mintVolume24hUsd: overrides.mintVolume24hUsd ?? 0,
    burnVolume24hUsd: overrides.burnVolume24hUsd ?? 0,
    mintCount24h: overrides.mintCount24h ?? 0,
    burnCount24h: overrides.burnCount24h ?? 0,
    netFlow7dUsd: overrides.netFlow7dUsd ?? 0,
    netFlow30dUsd: overrides.netFlow30dUsd ?? 0,
    netFlow90dUsd: overrides.netFlow90dUsd ?? 0,
    largestEvent24h: overrides.largestEvent24h ?? null,
    coverage: overrides.coverage,
  };
}

describe("buildFlowPressureReceiptModel", () => {
  it("summarizes tracked mint, burn, net, leaders, and coverage without changing scope semantics", () => {
    const coins = [
      makeCoin({
        symbol: "USDC",
        netFlow24hUsd: 75_000_000,
        mintVolume24hUsd: 90_000_000,
        burnVolume24hUsd: 15_000_000,
        netFlow7dUsd: 120_000_000,
        coverage: {
          startBlock: 1,
          lastSyncedBlock: 10,
          lagBlocks: null,
          historyStartAt: 1_700_000_000,
          has24hWindow: true,
          has30dWindow: true,
          has90dWindow: true,
          isPartial: false,
          status: "full",
        },
      }),
      makeCoin({
        symbol: "DAI",
        netFlow24hUsd: -22_000_000,
        mintVolume24hUsd: 3_000_000,
        burnVolume24hUsd: 25_000_000,
        netFlow7dUsd: -35_000_000,
        coverage: {
          startBlock: 1,
          lastSyncedBlock: 9,
          lagBlocks: 12,
          historyStartAt: 1_700_000_000,
          has24hWindow: true,
          has30dWindow: false,
          has90dWindow: false,
          isPartial: true,
          status: "partial-history",
        },
      }),
      makeCoin({
        symbol: "GHO",
        netFlow24hUsd: -12_000_000,
        mintVolume24hUsd: 0,
        burnVolume24hUsd: 12_000_000,
        netFlow7dUsd: -10_000_000,
        coverage: {
          startBlock: 1,
          lastSyncedBlock: 7,
          lagBlocks: 300,
          historyStartAt: null,
          has24hWindow: true,
          has30dWindow: false,
          has90dWindow: false,
          isPartial: true,
          status: "lagging",
        },
      }),
    ];
    const weeklyHourly: MintBurnHourlyBucket[] = [
      { hourTs: 1, mintVolumeUsd: 100, burnVolumeUsd: 30, netFlowUsd: 70 },
      { hourTs: 2, mintVolumeUsd: 50, burnVolumeUsd: 10, netFlowUsd: 40 },
    ];

    const model = buildFlowPressureReceiptModel({
      gauge,
      coins,
      weeklyHourly,
      scopeLabel: "Configured issuance chains",
    });

    expect(model).toMatchObject({
      trackedCoins: 3,
      mint24hUsd: 93_000_000,
      burn24hUsd: 52_000_000,
      net24hUsd: 41_000_000,
      mint7dUsd: 150,
      burn7dUsd: 40,
      net7dUsd: 75_000_000,
      topMint: { symbol: "USDC", valueUsd: 75_000_000 },
      topBurn: { symbol: "DAI", valueUsd: -22_000_000 },
      coverageSummary: "1 lagging coin",
    });
    expect(model.coverageRows).toEqual([
      { status: "full", count: 1 },
      { status: "partial-history", count: 1 },
      { status: "lagging", count: 1 },
    ]);
    expect(model.rows.map((row) => row.label)).toEqual([
      "Printed 24h",
      "Shredded 24h",
      "Net 24h",
      "Printed 7d",
      "Shredded 7d",
      "Net 7d",
    ]);
  });

  it("prioritizes sync warnings and handles missing weekly hourly data", () => {
    const model = buildFlowPressureReceiptModel({
      gauge: null,
      coins: [makeCoin({ symbol: "USDT", netFlow24hUsd: 0 })],
      syncWarning: "Critical lane is delayed",
    });

    expect(model.trackedCoins).toBe(1);
    expect(model.mint7dUsd).toBeNull();
    expect(model.burn7dUsd).toBeNull();
    expect(model.coverageSummary).toBe("Lag warning active");
    expect(model.rows.find((row) => row.id === "mint-7d")?.valueUsd).toBeNull();
  });

  it("summarizes unknown coverage when chain-head metadata is unavailable", () => {
    const model = buildFlowPressureReceiptModel({
      gauge,
      coins: [makeCoin({
        coverage: {
          startBlock: 1,
          lastSyncedBlock: 10,
          lagBlocks: null,
          historyStartAt: 1_700_000_000,
          has24hWindow: true,
          has30dWindow: true,
          has90dWindow: true,
          isPartial: true,
          status: "unknown",
        },
      })],
    });

    expect(model.coverageSummary).toBe("1 unknown coin");
    expect(model.coverageRows).toEqual([{ status: "unknown", count: 1 }]);
  });
});
