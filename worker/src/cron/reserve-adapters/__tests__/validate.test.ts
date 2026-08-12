import { describe, expect, it } from "vitest";
import type { ReserveAdapterDefinition } from "../types";
import { getReserveAdapter } from "../index";
import { validateAdapterOutput } from "../validate";

const slices = [{ name: "USDC", pct: 100, risk: "low" as const }];

describe("validateAdapterOutput redemption telemetry", () => {
  it("rejects slices above the public 100% per-slice schema limit", () => {
    const result = validateAdapterOutput({
      slices: [
        { name: "Oversized", pct: 101, risk: "low" },
        { name: "Remainder", pct: 1, risk: "medium" },
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.warnings[0]).toMatchObject({
      code: "invalid-pct",
      effect: "fatal",
    });
  });

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

  it("rejects stringified redemption capacity and impossible fees", () => {
    const adapter = getReserveAdapter("gho");
    const result = validateAdapterOutput(
      {
        slices,
        metadata: {
          redemptionFeeBps: 10,
          redemption: {
            capacityUsd: "1000000",
            feeBps: 20_000,
          },
        },
      },
      { adapter: adapter ?? undefined },
    );

    expect(result.valid).toBe(false);
    const codes = result.warnings.map((warning) => warning.code);
    expect(codes).toContain("invalid-redemption-capacity-usd");
    expect(codes).toContain("invalid-redemption-fee-bps");
  });

  it("rejects negative redemption constraint metadata", () => {
    const adapter = getReserveAdapter("falcon");
    const result = validateAdapterOutput(
      {
        slices,
        metadata: {
          redemption: {
            capacityUsd: 1_000_000,
            capacityKind: "live-queue",
            settlementDelaySec: -1,
            queueDepthUsd: -1,
            dailyLimitUsd: -1,
            minRedeemUsd: -1,
          },
        },
      },
      { adapter: adapter ?? undefined },
    );

    expect(result.valid).toBe(false);
    const codes = result.warnings.map((warning) => warning.code);
    expect(codes).toContain("invalid-redemption-settlement-delay");
    expect(codes).toContain("invalid-redemption-queue-depth");
    expect(codes).toContain("invalid-redemption-daily-limit");
    expect(codes).toContain("invalid-redemption-min-redeem");
  });

  it("rejects malformed redemption source URLs", () => {
    const adapter = getReserveAdapter("falcon");
    const result = validateAdapterOutput(
      {
        slices,
        metadata: {
          redemption: {
            capacityUsd: 1_000_000,
            capacityKind: "live-proxy-validated",
            sourceUrls: ["https://example.com/redemption.json", "not-a-url"],
          },
        },
      },
      { adapter: adapter ?? undefined },
    );

    expect(result.valid).toBe(false);
    expect(result.warnings[0]).toMatchObject({
      code: "invalid-redemption-source-urls",
      effect: "fatal",
    });
  });

  it("rejects invalid route-status review dates", () => {
    const adapter = getReserveAdapter("falcon");
    const result = validateAdapterOutput(
      {
        slices,
        metadata: {
          redemption: {
            capacityUsd: 1_000_000,
            capacityKind: "live-proxy-validated",
            routeStatusReviewedAt: "2026-02-31",
          },
        },
      },
      { adapter: adapter ?? undefined },
    );

    expect(result.valid).toBe(false);
    expect(result.warnings[0]).toMatchObject({
      code: "invalid-redemption-route-reviewed-at",
      effect: "fatal",
    });
  });

  it("rejects live route status without source attribution", () => {
    const adapter = getReserveAdapter("gho");
    const result = validateAdapterOutput(
      {
        slices,
        metadata: {
          redemption: {
            capacityUsd: 1_000_000,
            capacityKind: "live-direct-bounded",
            routeStatus: "open",
          },
        },
      },
      { adapter: adapter ?? undefined },
    );

    expect(result.valid).toBe(false);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "missing-redemption-route-status-source",
        effect: "fatal",
      }),
    );
  });

  it("rejects verified redemption freshness without a valid source timestamp", () => {
    const adapter = getReserveAdapter("gho");
    const missingTimestamp = validateAdapterOutput(
      {
        slices,
        metadata: {
          redemption: {
            capacityUsd: 1_000_000,
            capacityKind: "live-direct-bounded",
            freshnessKind: "verified-source-timestamp",
          },
        },
      },
      { adapter: adapter ?? undefined },
    );
    const malformedTimestamp = validateAdapterOutput(
      {
        slices,
        metadata: {
          redemption: {
            capacityUsd: 1_000_000,
            capacityKind: "live-direct-bounded",
            freshnessKind: "verified-source-timestamp",
            sourceTimestamp: "1700000000",
          },
        },
      },
      { adapter: adapter ?? undefined },
    );

    expect(missingTimestamp.valid).toBe(false);
    expect(missingTimestamp.warnings).toContainEqual(
      expect.objectContaining({
        code: "missing-redemption-source-timestamp",
        effect: "fatal",
      }),
    );
    expect(malformedTimestamp.valid).toBe(false);
    expect(malformedTimestamp.warnings).toContainEqual(
      expect.objectContaining({
        code: "invalid-redemption-source-timestamp",
        effect: "fatal",
      }),
    );
  });

  it("rejects non-string live route status source attribution", () => {
    const adapter = getReserveAdapter("gho");
    const result = validateAdapterOutput(
      {
        slices,
        metadata: {
          redemption: {
            capacityUsd: 1_000_000,
            capacityKind: "live-direct-bounded",
            routeStatus: "paused",
            routeStatusSource: 123,
          },
        },
      },
      { adapter: adapter ?? undefined },
    );

    expect(result.valid).toBe(false);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "invalid-redemption-route-status-source",
        effect: "fatal",
      }),
    );
  });

  it("rejects invalid holder, capacity, and freshness kinds", () => {
    const adapter = getReserveAdapter("ethena");
    const result = validateAdapterOutput(
      {
        slices,
        metadata: {
          redemption: {
            capacityUsd: 1_000_000,
            capacityKind: "instant",
            freshnessKind: "fresh",
            holderEligibility: "vip-only",
          },
        },
      },
      { adapter: adapter ?? undefined },
    );

    expect(result.valid).toBe(false);
    const codes = result.warnings.map((warning) => warning.code);
    expect(codes).toContain("invalid-redemption-capacity-kind");
    expect(codes).toContain("invalid-redemption-freshness-kind");
    expect(codes).toContain("invalid-redemption-holder-eligibility");
  });

  it("rejects proxy capacity kinds from direct-only adapters", () => {
    const adapter = getReserveAdapter("gho");
    const result = validateAdapterOutput(
      {
        slices,
        metadata: {
          redemption: {
            capacityUsd: 1_000_000,
            capacityKind: "live-proxy-validated",
          },
        },
      },
      { adapter: adapter ?? undefined },
    );

    expect(result.valid).toBe(false);
    expect(result.warnings[0]).toMatchObject({
      code: "redemption-capacity-kind-mismatch",
      effect: "fatal",
    });
  });

  it("rejects direct capacity kinds from proxy-only adapters", () => {
    const adapter = getReserveAdapter("falcon");
    const result = validateAdapterOutput(
      {
        slices,
        metadata: {
          redemption: {
            capacityUsd: 1_000_000,
            capacityKind: "live-direct-bounded",
          },
        },
      },
      { adapter: adapter ?? undefined },
    );

    expect(result.valid).toBe(false);
    expect(result.warnings[0]).toMatchObject({
      code: "redemption-capacity-kind-mismatch",
      effect: "fatal",
    });
  });

  it("degrades queue capacity that omits queue or delay semantics", () => {
    const adapter = getReserveAdapter("falcon");
    const result = validateAdapterOutput(
      {
        slices,
        metadata: {
          redemption: {
            capacityUsd: 1_000_000,
            capacityKind: "live-queue",
          },
        },
      },
      { adapter: adapter ?? undefined },
    );

    expect(result.valid).toBe(true);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "redemption-queue-semantics-missing",
        effect: "degraded",
      }),
    );
  });

  it("suppresses redemption-capacity-unverified when the adapter policy is unverified-only", () => {
    // No registry adapter is unverified-only anymore, so cover the suppression
    // branch with a synthetic unverified-only policy.
    const baseAdapter = getReserveAdapter("infinifi");
    expect(baseAdapter).not.toBeNull();
    const adapter: ReserveAdapterDefinition = {
      ...baseAdapter!,
      validation: { ...baseAdapter!.validation, allowedFreshnessModes: ["unverified"] },
    };
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

    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.code === "redemption-capacity-unverified")).toBe(false);
  });

  it("flags unverified redemption freshness under reservoir's timestamp-less API policy", () => {
    const adapter = getReserveAdapter("reservoir");
    const result = validateAdapterOutput(
      {
        slices,
        metadata: {
          immediateRedeemableUsd: 1_000_000,
          freshnessMode: "unverified",
          redemption: {
            capacityUsd: 1_000_000,
            freshnessKind: "unverified",
          },
        },
      },
      { adapter: adapter ?? undefined },
    );

    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.code === "redemption-capacity-unverified")).toBe(true);
    expect(result.warnings.some((w) => w.code === "freshness-mode-disallowed")).toBe(false);
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
