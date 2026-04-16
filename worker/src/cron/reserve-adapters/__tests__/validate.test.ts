import { describe, expect, it } from "vitest";
import type { ReserveAdapterDefinition } from "../types";
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

  it("suppresses redemption-capacity-unverified when the adapter policy is unverified-only (infinifi)", () => {
    const adapter = getReserveAdapter("infinifi");
    const result = validateAdapterOutput(
      {
        slices,
        metadata: {
          immediateRedeemableUsd: 1_000_000,
          redemption: {
            capacityUsd: 1_000_000,
            freshnessKind: "unverified",
          },
        },
      },
      { adapter: adapter ?? undefined },
    );

    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.code === "redemption-capacity-unverified")).toBe(false);
  });

  it("suppresses redemption-capacity-unverified when the adapter policy is unverified-only (reservoir)", () => {
    const adapter = getReserveAdapter("reservoir");
    const result = validateAdapterOutput(
      {
        slices,
        metadata: {
          immediateRedeemableUsd: 1_000_000,
          redemption: {
            capacityUsd: 1_000_000,
            freshnessKind: "unverified",
          },
        },
      },
      { adapter: adapter ?? undefined },
    );

    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.code === "redemption-capacity-unverified")).toBe(false);
  });

  it("still emits redemption-capacity-unverified when the adapter allows verified freshness (ethena)", () => {
    const baseAdapter = getReserveAdapter("ethena");
    expect(baseAdapter).not.toBeNull();
    const adapter: ReserveAdapterDefinition = baseAdapter!;
    const result = validateAdapterOutput(
      {
        slices,
        metadata: {
          immediateRedeemableUsd: 1_000_000,
          redemption: {
            capacityUsd: 1_000_000,
            freshnessKind: "unverified",
          },
        },
      },
      { adapter },
    );

    expect(result.warnings.some((w) => w.code === "redemption-capacity-unverified")).toBe(true);
  });
});
