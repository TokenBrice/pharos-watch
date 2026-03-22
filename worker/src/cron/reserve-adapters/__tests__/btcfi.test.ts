import { describe, expect, it } from "vitest";
import { adaptBtcfi } from "../btcfi";

describe("adaptBtcfi", () => {
  it("collapses BTC-family collateral into a single reserve slice", () => {
    const slices = adaptBtcfi(
      [
        { token_handler_id: 0, deposit_value: "5000" },
        { token_handler_id: 1, deposit_value: "3000" },
        { token_handler_id: 2, deposit_value: "1000" },
      ],
      [
        { id: 0, symbol: "WBTC", isStable: false },
        { id: 1, symbol: "BTCB", isStable: false },
        { id: 2, symbol: "BtcUSD", isStable: true },
      ],
    );

    expect(slices).toEqual({
      slices: [{ name: "BTC / WBTC / BTCB / cbBTC", pct: 100, risk: "medium" }],
      metadata: { handlerCount: 3, freshnessMode: "unverified" },
    });
  });
});
