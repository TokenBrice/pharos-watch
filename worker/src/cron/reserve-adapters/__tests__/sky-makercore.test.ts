import { describe, it, expect } from "vitest";
import {
  adaptSkyModules,
  listUnknownGroups,
  resolveSkyTimestampSummary,
  resolveSkyImmediateRedeemableUsd,
  type SkyGroupResult,
} from "../sky-makercore";

const SAMPLE_GROUPS: SkyGroupResult[] = [
  { group: "stablecoins", group_name: "Stablecoins", debt: "4848053264.74", collateral: "4848920495.92", datetime: "2026-04-05T17:33:24.053849" },
  { group: "spark", group_name: "Spark", debt: "3604127984.82", collateral: "3604127984.82", datetime: "2026-04-05T17:33:24.053849" },
  { group: "grove", group_name: "Grove", debt: "2942299611.45", collateral: "2942299611.45", datetime: "2026-04-05T17:33:24.053849" },
  { group: "obex", group_name: "Obex", debt: "605813016.00", collateral: "605813016.00", datetime: "2026-04-05T17:33:24.053849" },
  { group: "core", group_name: "Core", debt: "524177048.08", collateral: "1744997221.98", datetime: "2026-04-05T17:33:24.053849" },
  { group: "staked", group_name: "Staking Engine", debt: "153348644.44", collateral: "1213000185.95", datetime: "2026-04-05T17:33:24.053849" },
  { group: "legacy-rwa", group_name: "Legacy RWA", debt: "104787191.81", collateral: "104787191.81", datetime: "2026-04-05T17:33:24.053849" },
];

describe("adaptSkyModules", () => {
  it("produces 7 slices from all known modules", () => {
    const slices = adaptSkyModules(SAMPLE_GROUPS);
    expect(slices).toHaveLength(7);
    const total = slices.reduce((sum, s) => sum + s.pct, 0);
    expect(total).toBe(100);
  });

  it("assigns correct risk levels per module", () => {
    const slices = adaptSkyModules(SAMPLE_GROUPS);
    const byName = Object.fromEntries(slices.map((s) => [s.name, s]));

    expect(byName["Stablecoins (PSM)"].risk).toBe("very-low");
    expect(byName["Stablecoins (PSM)"].coinId).toBe("usdc-circle");
    expect(byName["Stablecoins (PSM)"].depType).toBe("mechanism");

    expect(byName["Spark (lending)"].risk).toBe("low");
    expect(byName["Grove (RWA)"].risk).toBe("low");
    expect(byName["Obex"].risk).toBe("medium");
    expect(byName["Core (crypto vaults)"].risk).toBe("medium");
    expect(byName["Staking Engine"].risk).toBe("high");
    expect(byName["Legacy RWA"].risk).toBe("low");
  });

  it("stablecoins slice is the largest by percentage", () => {
    const slices = adaptSkyModules(SAMPLE_GROUPS);
    const stableSlice = slices.find((s) => s.name === "Stablecoins (PSM)")!;
    const maxPct = Math.max(...slices.map((s) => s.pct));
    expect(stableSlice.pct).toBe(maxPct);
  });

  it("omits modules with zero debt", () => {
    const withZero: SkyGroupResult[] = [
      { group: "stablecoins", group_name: "Stablecoins", debt: "5000000000", collateral: "5000000000", datetime: "2026-04-05T17:33:24" },
      { group: "legacy-rwa", group_name: "Legacy RWA", debt: "0", collateral: "0", datetime: "2026-04-05T17:33:24" },
    ];
    const slices = adaptSkyModules(withZero);
    expect(slices).toHaveLength(1);
    expect(slices[0].pct).toBe(100);
  });

  it("returns empty when all debts are zero", () => {
    const allZero: SkyGroupResult[] = [
      { group: "stablecoins", group_name: "Stablecoins", debt: "0", collateral: "0", datetime: "2026-04-05T17:33:24" },
    ];
    expect(adaptSkyModules(allZero)).toEqual([]);
  });

  it("buckets unknown groups into Other modules with high risk", () => {
    const withUnknown: SkyGroupResult[] = [
      { group: "stablecoins", group_name: "Stablecoins", debt: "9000000000", collateral: "9000000000", datetime: "2026-04-05T17:33:24" },
      { group: "new-module", group_name: "New Module", debt: "1000000000", collateral: "1000000000", datetime: "2026-04-05T17:33:24" },
    ];
    const slices = adaptSkyModules(withUnknown);
    const otherSlice = slices.find((s) => s.name === "Other modules");
    expect(otherSlice).toBeDefined();
    expect(otherSlice!.risk).toBe("high");
    expect(otherSlice!.pct).toBe(10);
  });
});

describe("resolveSkyImmediateRedeemableUsd", () => {
  it("returns stablecoins module collateral as redeemable", () => {
    expect(resolveSkyImmediateRedeemableUsd(SAMPLE_GROUPS)).toBe(4848920495.92);
  });

  it("returns 0 when no stablecoins module exists", () => {
    const noStable: SkyGroupResult[] = [
      { group: "core", group_name: "Core", debt: "500000000", collateral: "1500000000", datetime: "2026-04-05T17:33:24" },
    ];
    expect(resolveSkyImmediateRedeemableUsd(noStable)).toBe(0);
  });
});

describe("listUnknownGroups", () => {
  it("identifies groups not in the known set", () => {
    const groups: SkyGroupResult[] = [
      { group: "stablecoins", group_name: "Stablecoins", debt: "100", collateral: "100", datetime: "2026-04-05T17:33:24" },
      { group: "mystery", group_name: "Mystery", debt: "50", collateral: "50", datetime: "2026-04-05T17:33:24" },
    ];
    const unknown = listUnknownGroups(groups);
    expect(unknown).toContain("mystery");
    expect(unknown).not.toContain("stablecoins");
  });
});

describe("resolveSkyTimestampSummary", () => {
  it("uses the oldest positive-debt group datetime as source timestamp", () => {
    const summary = resolveSkyTimestampSummary([
      { group: "stablecoins", group_name: "Stablecoins", debt: "100", collateral: "100", datetime: "2026-04-05T17:33:24" },
      { group: "spark", group_name: "Spark", debt: "50", collateral: "50", datetime: "2026-04-05T18:33:24" },
      { group: "legacy-rwa", group_name: "Legacy", debt: "0", collateral: "0", datetime: "2026-04-01T00:00:00" },
    ]);

    expect(summary).toMatchObject({
      sourceTimestamp: Date.parse("2026-04-05T17:33:24") / 1000,
      latestSourceTimestamp: Date.parse("2026-04-05T18:33:24") / 1000,
      sourceTimestampSpreadSec: 3600,
      timestampCount: 2,
    });
  });
});
