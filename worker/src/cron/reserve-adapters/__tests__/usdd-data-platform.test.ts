import { describe, expect, it } from "vitest";
import { adaptUsddLatestCollateral } from "../usdd-data-platform";

describe("adaptUsddLatestCollateral", () => {
  it("maps the USDD collateral feed into detail-page reserve slices", () => {
    const result = adaptUsddLatestCollateral(
      {
        code: 0,
        data: {
          items: [
            { vaultType: "TRX-A", lockedValue: 201_173_223.24 },
            { vaultType: "TRX-B", lockedValue: 100_178_816.93 },
            { vaultType: "TRX-C", lockedValue: 108_374_409.0 },
            { vaultType: "USDT-A", lockedValue: 672_966.59 },
            { vaultType: "STRX-A", lockedValue: 18_896_312.13 },
            { vaultType: "PSM-USDT-A", lockedValue: 82_309_862.43 },
            { vaultType: "SA001-A", lockedValue: 519_698_996.0 },
          ],
        },
      },
      {
        code: 0,
        data: {
          items: [
            { statisticTime: 1_774_281_600_000 },
          ],
        },
      },
    );

    expect(result.slices).toEqual([
      { name: "Smart Allocator (stablecoin DeFi via Aave/JustLend)", pct: 50.4, risk: "medium" },
      { name: "TRX", pct: 39.7, risk: "high" },
      { name: "USDT (PSM vaults)", pct: 8, risk: "low", coinId: "usdt-tether" },
      { name: "sTRX (direct vaults)", pct: 1.8, risk: "high" },
      { name: "USDT (direct vaults)", pct: 0.1, risk: "high", coinId: "usdt-tether" },
    ]);
    expect(result.metadata).toMatchObject({
      vaultCount: 7,
      trackedVaultCount: 5,
      sourceTimestamp: 1_774_281_600,
      freshnessMode: "verified",
    });
  });

  it("throws when the USDD feed reports a non-success code", () => {
    expect(() => adaptUsddLatestCollateral({ code: 500 })).toThrow("returned code");
  });
});
