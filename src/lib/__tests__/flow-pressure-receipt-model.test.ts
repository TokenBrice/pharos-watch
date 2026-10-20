import { describe, expect, it } from "vitest";
import { buildFlowPressureReceiptModel } from "@/lib/flow-pressure-receipt-model";
import type { MintBurnCoinFlow, MintBurnHourlyBucket } from "@shared/types";
import {
  makeInactiveMintBurnFlowCoin as makeCoin,
  makeMintBurnCoinValuation as completeValuation,
} from "@/test-utils/mint-burn-fixtures";

function makeCoverage(
  overrides: Partial<NonNullable<MintBurnCoinFlow["coverage"]>> = {},
): NonNullable<MintBurnCoinFlow["coverage"]> {
  return {
    startBlock: 1, lastSyncedBlock: 10, lagBlocks: null, historyStartAt: 1_700_000_000,
    has24hWindow: true, has30dWindow: true, has90dWindow: true, isPartial: false, status: "full",
    ...overrides,
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
        coverage: makeCoverage(),
      }),
      makeCoin({
        symbol: "DAI",
        netFlow24hUsd: -22_000_000,
        mintVolume24hUsd: 3_000_000,
        burnVolume24hUsd: 25_000_000,
        netFlow7dUsd: -35_000_000,
        coverage: makeCoverage({
          lastSyncedBlock: 9, lagBlocks: 12, has30dWindow: false, has90dWindow: false,
          isPartial: true, status: "partial-history",
        }),
      }),
      makeCoin({
        symbol: "GHO",
        netFlow24hUsd: -12_000_000,
        mintVolume24hUsd: 0,
        burnVolume24hUsd: 12_000_000,
        netFlow7dUsd: -10_000_000,
        coverage: makeCoverage({
          lastSyncedBlock: 7, lagBlocks: 300, historyStartAt: null,
          has30dWindow: false, has90dWindow: false, isPartial: true, status: "lagging",
        }),
      }),
    ];
    const weeklyHourly: MintBurnHourlyBucket[] = [
      { hourTs: 1, mintVolumeUsd: 100, burnVolumeUsd: 30, netFlowUsd: 70 },
      { hourTs: 2, mintVolumeUsd: 50, burnVolumeUsd: 10, netFlowUsd: 40 },
    ];

    const model = buildFlowPressureReceiptModel({
      coins,
      weeklyHourly,
      scopeLabel: "Configured issuance chains",
    });

    expect(model).toMatchObject({
      scopeLabel: "Configured issuance chains",
      topMint: { symbol: "USDC", valueUsd: 120_000_000 },
      topBurn: { symbol: "DAI", valueUsd: -35_000_000 },
      coverageSummary: "1 lagging coin",
    });
    expect(model.coverageRows).toEqual([
      { status: "full", count: 1 },
      { status: "partial-history", count: 1 },
      { status: "lagging", count: 1 },
    ]);
    expect(model.rows.map((row) => row.label)).toEqual([
      "Printed 7d",
      "Shredded 7d",
      "Net 7d",
    ]);
    expect(model.rows.map((row) => row.valueUsd)).toEqual([150, 40, 75_000_000]);
  });

  it("prioritizes sync warnings and handles missing weekly hourly data", () => {
    const model = buildFlowPressureReceiptModel({
      coins: [makeCoin({ symbol: "USDT", netFlow24hUsd: 0 })],
      syncWarning: "Critical lane is delayed",
    });

    expect(model.coverageSummary).toBe("Lag warning active");
    expect(model.rows.find((row) => row.id === "mint-7d")?.valueUsd).toBeNull();
    expect(model.rows.find((row) => row.id === "burn-7d")?.valueUsd).toBeNull();
  });

  it("summarizes unknown coverage when chain-head metadata is unavailable", () => {
    const model = buildFlowPressureReceiptModel({
      coins: [makeCoin({
        coverage: makeCoverage({ isPartial: true, status: "unknown" }),
      })],
    });

    expect(model.coverageSummary).toBe("1 unknown coin");
    expect(model.coverageRows).toEqual([{ status: "unknown", count: 1 }]);
  });

  it.each(["upper", "lower"] as const)("never ranks a partial net and keeps its weekly %s bound", (kind) => {
    const model = buildFlowPressureReceiptModel({
      coins: [
        makeCoin({
          symbol: "USDC",
          has24hActivity: true,
          netFlow24hUsd: 50,
          mintVolume24hUsd: 50,
          netFlow7dUsd: 70,
          valuation: completeValuation(),
        }),
        makeCoin({
          symbol: "DAI",
          has24hActivity: true,
          netFlow24hUsd: 900,
          mintVolume24hUsd: 900,
          netFlow7dUsd: null,
          valuation: completeValuation({
            completeness: "partial",
            burnCompleteness: "partial",
            unpricedBurnEventCount: 4,
          }, { netFlow7d: "partial", netFlow7dBound: { kind, valueUsd: 900 } }),
        }),
      ],
      weeklyHourly: [
        { hourTs: 1, mintVolumeUsd: 10, burnVolumeUsd: 0, netFlowUsd: 10, valuation: "complete" },
        { hourTs: 2, mintVolumeUsd: 5, burnVolumeUsd: 3, netFlowUsd: null, valuation: "partial" },
      ],
    });

    // DAI's partial weekly net is only a bound, so it cannot lead.
    expect(model.topMint).toEqual({ symbol: "USDC", valueUsd: 70 });
    const byId = Object.fromEntries(model.rows.map((row) => [row.id, row]));
    expect(byId["net-7d"]).toMatchObject({ valueUsd: null, completeness: "partial" });
    expect(byId["net-7d"].bound).toEqual({ kind, valueUsd: 970 });
    expect(byId["net-7d"].note).toMatch(new RegExp(`${kind} bound`, "i"));
    expect(byId["burn-7d"]).toMatchObject({ valueUsd: 3, completeness: "partial" });
    expect(byId["burn-7d"].note).toMatch(/lower bound/i);
    expect(byId["mint-7d"]).toMatchObject({ valueUsd: 15, completeness: "partial" });
  });

  it("keeps unknown scan-window nets unavailable and out of weekly leaders", () => {
    const model = buildFlowPressureReceiptModel({
      coins: [makeCoin({
        has24hActivity: null,
        netFlow24hUsd: null,
        netFlow7dUsd: null,
        netFlow30dUsd: null,
        netFlow90dUsd: null,
        mintVolume24hUsd: 10,
        burnVolume24hUsd: 5,
        valuation: completeValuation(),
      })],
    });
    expect(model.rows.find((row) => row.id === "net-7d")?.valueUsd).toBeNull();
    expect(model.topMint).toBeNull();
    expect(model.topBurn).toBeNull();
    expect(model.rows.find((row) => row.id === "net-7d")?.bound).toBeNull();
  });
  it.each([0, 100])("keeps scan completeness independent for fully valued gross subtotals (%i)", (volume) => {
    const incomplete = { complete: false, unavailableReason: "scan-coverage-incomplete" as const };
    const model = buildFlowPressureReceiptModel({
      coins: [makeCoin({
        has24hActivity: null, observed24hActivity: volume > 0,
        mintVolume24hUsd: volume, burnVolume24hUsd: 0,
        netFlow24hUsd: null, netFlow7dUsd: null,
        totalsSemantics: "observed-subtotals",
        valuation: completeValuation(),
        coverage: makeCoverage({ has24hWindow: false, windows: {
          window24h: incomplete, window7d: incomplete, window30d: incomplete, window90d: incomplete,
        } }),
      })],
      weeklyHourly: [{ hourTs: 1, mintVolumeUsd: volume, burnVolumeUsd: 0, netFlowUsd: null,
        valuation: "complete", scanCoverage: incomplete }],
    });
    for (const row of model.rows.filter((row) => row.tone === "mint" || row.tone === "burn")) {
      expect(row).toMatchObject({ completeness: "complete", scanComplete: false,
        note: "Observed subtotal, lower bound: scan coverage incomplete" });
    }
  });
});
