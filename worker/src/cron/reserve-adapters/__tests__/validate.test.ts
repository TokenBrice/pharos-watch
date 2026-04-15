import { describe, expect, it } from "vitest";
import { getReserveAdapter } from "../index";
import { validateAdapterOutput } from "../validate";

const slices = [{ name: "USDC", pct: 100, risk: "low" as const }];

describe("validateAdapterOutput redemption telemetry", () => {
  it("rejects invalid nested redemption capacity even when legacy capacity is valid", () => {
    const adapter = getReserveAdapter("gho");
    const result = validateAdapterOutput(
      {
        slices,
        metadata: {
          immediateRedeemableUsd: 1_000_000,
          immediateRedeemableRatio: 0.1,
          redemption: {
            capacityUsd: -1,
            capacityRatioOfSupply: 0.1,
          },
        },
      },
      { adapter: adapter ?? undefined },
    );

    expect(result.valid).toBe(false);
    expect(result.warnings[0]).toMatchObject({
      code: "invalid-redemption-capacity-usd",
      effect: "fatal",
    });
  });

  it("rejects invalid nested redemption capacity ratios even when legacy ratios are valid", () => {
    const adapter = getReserveAdapter("gho");
    const result = validateAdapterOutput(
      {
        slices,
        metadata: {
          immediateRedeemableUsd: 1_000_000,
          immediateRedeemableRatio: 0.1,
          redemption: {
            capacityUsd: 1_000_000,
            capacityRatioOfSupply: 1.5,
          },
        },
      },
      { adapter: adapter ?? undefined },
    );

    expect(result.valid).toBe(false);
    expect(result.warnings[0]).toMatchObject({
      code: "invalid-redemption-capacity-ratio",
      effect: "fatal",
    });
  });

  it("rejects invalid nested redemption fees even when legacy fees are valid", () => {
    const adapter = getReserveAdapter("gho");
    const result = validateAdapterOutput(
      {
        slices,
        metadata: {
          redemptionFeeBps: 10,
          redemption: {
            feeBps: -1,
          },
        },
      },
      { adapter: adapter ?? undefined },
    );

    expect(result.valid).toBe(false);
    expect(result.warnings[0]).toMatchObject({
      code: "invalid-redemption-fee-bps",
      effect: "fatal",
    });
  });
});
