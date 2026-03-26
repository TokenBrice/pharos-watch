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
      metadata: {
        handlerCount: 3,
        freshnessMode: "unverified",
        details: {
          freshnessSource: "protocol-market-and-handler-apis",
          freshnessReason: "btcfi market and handler payloads do not expose a trustworthy source timestamp",
        },
      },
    });
  });

  it("drops zero-percent mapped slices when all collateral is unknown wrappers", () => {
    const result = adaptBtcfi(
      [
        { token_handler_id: 0, deposit_value: "4000" },
      ],
      [
        { id: 0, symbol: "FBTC", isStable: false },
      ],
    );

    expect(result).toEqual({
      slices: [{ name: "Other BTC wrappers / unmapped handlers", pct: 100, risk: "high" }],
      metadata: {
        handlerCount: 1,
        freshnessMode: "unverified",
        details: {
          freshnessSource: "protocol-market-and-handler-apis",
          freshnessReason: "btcfi market and handler payloads do not expose a trustworthy source timestamp",
        },
      },
      warnings: [{
        code: "unknown-btc-wrapper",
        message: "btcfi handler bucketed into other BTC wrappers: FBTC",
        severity: "warning",
        effect: "degraded",
      }],
    });
  });
});
