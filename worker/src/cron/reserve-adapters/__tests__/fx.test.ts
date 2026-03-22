import { describe, expect, it } from "vitest";
import { adaptFx } from "../fx";

describe("adaptFx", () => {
  it("extracts non-zero collateral balances from the official fx TVL payload", () => {
    const result = adaptFx({
      data: {
        poolInfo: {
          wstETH: { collateralBalance: "4420184046004807062590" },
          wbtc: { collateralBalance: "21713855211" },
        },
      },
    });

    expect(result).toEqual({
      balances: [
        { key: "wstETH", amount: 4420.184046004807 },
        { key: "wbtc", amount: 217.13855211 },
      ],
      unknownKeys: [],
    });
  });
});
