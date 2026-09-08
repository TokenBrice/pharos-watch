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

  it.each([
    {
      name: "nested capacity overrides valid legacy capacity", adapter: "gho",
      metadata: { immediateRedeemableUsd: 1_000_000, immediateRedeemableRatio: 0.1, redemption: { capacityUsd: -1, capacityRatioOfSupply: 0.1 } },
      codes: ["invalid-redemption-capacity-usd"],
    },
    {
      name: "nested ratio overrides valid legacy ratio", adapter: "gho",
      metadata: { immediateRedeemableUsd: 1_000_000, immediateRedeemableRatio: 0.1, redemption: { capacityUsd: 1_000_000, capacityRatioOfSupply: 1.5 } },
      codes: ["invalid-redemption-capacity-ratio"],
    },
    {
      name: "nested fees override valid legacy fees", adapter: "gho",
      metadata: { redemptionFeeBps: 10, redemption: { feeBps: -1 } },
      codes: ["invalid-redemption-fee-bps"],
    },
    {
      name: "stringified capacity and impossible fees", adapter: "gho",
      metadata: { redemptionFeeBps: 10, redemption: { capacityUsd: "1000000", feeBps: 20_000 } },
      codes: ["invalid-redemption-capacity-usd", "invalid-redemption-fee-bps"],
    },
    {
      name: "negative redemption constraints", adapter: "falcon",
      metadata: { redemption: { capacityUsd: 1_000_000, capacityKind: "live-queue", settlementDelaySec: -1, queueDepthUsd: -1, dailyLimitUsd: -1, minRedeemUsd: -1 } },
      codes: ["invalid-redemption-settlement-delay", "invalid-redemption-queue-depth", "invalid-redemption-daily-limit", "invalid-redemption-min-redeem"],
    },
    {
      name: "malformed source URLs", adapter: "falcon",
      metadata: { redemption: { capacityUsd: 1_000_000, capacityKind: "live-proxy-validated", sourceUrls: ["https://example.com/redemption.json", "not-a-url"] } },
      codes: ["invalid-redemption-source-urls"],
    },
    {
      name: "invalid review date", adapter: "falcon",
      metadata: { redemption: { capacityUsd: 1_000_000, capacityKind: "live-proxy-validated", routeStatusReviewedAt: "2026-02-31" } },
      codes: ["invalid-redemption-route-reviewed-at"],
    },
    {
      name: "missing live route source", adapter: "gho",
      metadata: { redemption: { capacityUsd: 1_000_000, capacityKind: "live-direct-bounded", routeStatus: "open" } },
      codes: ["missing-redemption-route-status-source"],
    },
  ])("rejects $name", ({ adapter, metadata, codes }) => {
    const result = validateAdapterOutput({ slices, metadata }, { adapter: getReserveAdapter(adapter)! });
    expect(result.valid).toBe(false);
    for (const code of codes) {
      expect(result.warnings).toContainEqual(expect.objectContaining({ code, effect: "fatal" }));
    }
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

  it.each([
    {
      name: "non-string route source", adapter: "gho",
      redemption: { capacityUsd: 1_000_000, capacityKind: "live-direct-bounded", routeStatus: "paused", routeStatusSource: 123 },
      codes: ["invalid-redemption-route-status-source"],
    },
    {
      name: "invalid holder, capacity and freshness kinds", adapter: "ethena",
      redemption: { capacityUsd: 1_000_000, capacityKind: "instant", freshnessKind: "fresh", holderEligibility: "vip-only" },
      codes: ["invalid-redemption-capacity-kind", "invalid-redemption-freshness-kind", "invalid-redemption-holder-eligibility"],
    },
    {
      name: "proxy capacity on direct-only adapter", adapter: "gho",
      redemption: { capacityUsd: 1_000_000, capacityKind: "live-proxy-validated" },
      codes: ["redemption-capacity-kind-mismatch"],
    },
    {
      name: "direct capacity on proxy-only adapter", adapter: "falcon",
      redemption: { capacityUsd: 1_000_000, capacityKind: "live-direct-bounded" },
      codes: ["redemption-capacity-kind-mismatch"],
    },
  ])("rejects $name", ({ adapter, redemption, codes }) => {
    const result = validateAdapterOutput({ slices, metadata: { redemption } }, { adapter: getReserveAdapter(adapter)! });
    expect(result.valid).toBe(false);
    for (const code of codes) {
      expect(result.warnings).toContainEqual(expect.objectContaining({ code, effect: "fatal" }));
    }
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
