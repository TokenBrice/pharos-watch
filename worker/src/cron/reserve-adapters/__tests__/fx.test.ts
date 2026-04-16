import { describe, expect, it } from "vitest";
import { adaptFx } from "../fx";

describe("adaptFx", () => {
  it("extracts non-zero collateral balances from the official fx TVL payload", () => {
    const result = adaptFx({
      data: {
        poolInfo: {
          wstETH: { collateralBalance: "4420184046004807062590", debtBalance: "1000000000000000000000" },
          wbtc: { collateralBalance: "21713855211", debtBalance: "2000000000000000000000" },
        },
      },
    });

    expect(result).toEqual({
      balances: [
        { key: "wstETH", amountRaw: 4420184046004807062590n, debtRaw: 1000000000000000000000n },
        { key: "wbtc", amountRaw: 21713855211n, debtRaw: 2000000000000000000000n },
      ],
      unknownKeys: [],
    });
  });

  it("surfaces unknown positive collateral keys so the fetch path can fail closed", () => {
    const result = adaptFx({
      data: {
        poolInfo: {
          wstETH: { collateralBalance: "1000000000000000000" },
          unexpectedAsset: { collateralBalance: "250000000000000000" },
        },
      },
    });

    expect(result).toEqual({
      balances: [{ key: "wstETH", amountRaw: 1000000000000000000n, debtRaw: 0n }],
      unknownKeys: ["unexpectedAsset"],
    });
  });

  it("treats non-numeric collateralBalance strings as zero (parse-failure path)", () => {
    const result = adaptFx({
      data: {
        poolInfo: {
          wstETH: { collateralBalance: "not-a-number", debtBalance: "1000" },
          wbtc: { collateralBalance: "-250", debtBalance: "0" },
        },
      },
    });

    // Both wstETH and wbtc parse to 0 -> filtered out; neither counts as unknown.
    expect(result.balances).toEqual([]);
    expect(result.unknownKeys).toEqual([]);
  });

  it("returns an empty balance list and no unknowns when poolInfo is absent", () => {
    const result = adaptFx({});
    expect(result.balances).toEqual([]);
    expect(result.unknownKeys).toEqual([]);
  });

  it("skips unknown keys with zero collateralBalance (no false-positive unknown list)", () => {
    const result = adaptFx({
      data: {
        poolInfo: {
          wstETH: { collateralBalance: "1000000000000000000" },
          retiredAsset: { collateralBalance: "0" },
        },
      },
    });
    expect(result.unknownKeys).toEqual([]);
  });
});
