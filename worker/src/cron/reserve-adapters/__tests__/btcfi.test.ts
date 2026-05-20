import { describe, expect, it } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import { adaptBtcfi } from "../btcfi";

describe("adaptBtcfi", () => {
  it("declares latest-state API aggregation as not-applicable freshness", () => {
    expect(LIVE_RESERVE_ADAPTER_DEFINITIONS.btcfi.validation.allowedFreshnessModes).toEqual([
      "not-applicable",
    ]);
  });

  it("emits per-symbol BTC slices with canonical risk mapping", () => {
    const result = adaptBtcfi(
      [
        { token_handler_id: 0, deposit_value: "5000" },
        { token_handler_id: 1, deposit_value: "3000" },
        { token_handler_id: 2, deposit_value: "1000" },
        { token_handler_id: 3, deposit_value: "1000" },
      ],
      [
        { id: 0, symbol: "WBTC", isStable: false },
        { id: 1, symbol: "BTCB", isStable: false },
        { id: 2, symbol: "CBBTC", isStable: false },
        { id: 3, symbol: "BtcUSD", isStable: true },
      ],
    );

    const sliceNames = result.slices.map((s) => s.name).sort();
    expect(sliceNames).toEqual(["BTCB", "CBBTC", "WBTC"]);
    expect(result.slices.every((s) => s.risk === "medium")).toBe(true);
    expect(result.metadata).toMatchObject({
      handlerCount: 4,
      freshnessMode: "not-applicable",
      details: {
        freshnessSource: "protocol-market-and-handler-apis",
      },
    });
  });

  it("does not promote stable borrow value into redemption telemetry without route evidence", () => {
    const result = adaptBtcfi(
      [
        { token_handler_id: 0, deposit_value: "5000" },
        { token_handler_id: 1, deposit_value: "0", borrow_value: "7709211.347405107" },
      ],
      [
        { id: 0, symbol: "WBTC", isStable: false },
        { id: 1, symbol: "BtcUSD", isStable: true },
      ],
    );

    // Stable-row debt is not enough to prove current holder redemption capacity or route availability.
    expect(result.metadata).not.toHaveProperty("redemption");
    expect(LIVE_RESERVE_ADAPTER_DEFINITIONS.btcfi.redemptionTelemetry).toEqual({
      capacity: "none",
      fee: "none",
    });
  });

  it("emits distinct slices per BTC variant with per-symbol attribution", () => {
    const result = adaptBtcfi(
      [
        { token_handler_id: 0, deposit_value: "4000" },
        { token_handler_id: 1, deposit_value: "3000" },
        { token_handler_id: 2, deposit_value: "3000" },
      ],
      [
        { id: 0, symbol: "WBTC", isStable: false },
        { id: 1, symbol: "TBTC", isStable: false },
        { id: 2, symbol: "CBBTC", isStable: false },
      ],
    );
    const sliceNames = result.slices.map((s) => s.name).sort();
    expect(sliceNames).toContain("WBTC");
    expect(sliceNames).toContain("TBTC");
    expect(sliceNames).toContain("CBBTC");
    // Today all canonical BTC wrappers sit at medium; promotion to per-symbol
    // risk tiers is a separate methodology task.
    expect(result.slices.every((s) => s.risk === "medium")).toBe(true);
  });

  it("buckets unmapped BTC variants into a high-risk unmapped slice", () => {
    const result = adaptBtcfi(
      [
        { token_handler_id: 0, deposit_value: "4000" },
      ],
      [
        { id: 0, symbol: "FBTC", isStable: false },
      ],
    );

    expect(result.slices).toEqual([{
      name: "Unmapped BTC variants",
      pct: 100,
      risk: "high",
    }]);
    expect(result.metadata).toMatchObject({
      handlerCount: 1,
      unknownExposurePct: 100,
      freshnessMode: "not-applicable",
    });
    expect(result.warnings).toContainEqual({
      code: "unknown-btc-wrapper",
      message: "btcfi handler bucketed into unmapped BTC variants: FBTC",
      severity: "warning",
      effect: "degraded",
    });
  });
});
