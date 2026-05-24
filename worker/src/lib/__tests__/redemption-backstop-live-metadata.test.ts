import { describe, expect, it } from "vitest";
import { readRedemptionBackstopLiveMetadata } from "../redemption-backstop-live-metadata";
import type { ReserveSnapshotMetadataRecord } from "../live-reserves-store";
import { parseReserveCompositionRow } from "../live-reserves-store-row-decoding";

const now = 1_780_000_000;

function snapshot(
  stablecoinId: string,
  metadata: Record<string, unknown>,
): ReserveSnapshotMetadataRecord {
  return {
    stablecoinId,
    fetchedAt: now - 60,
    source: "unit-test",
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    syncStatus: "ok",
    warningCount: 0,
    warnings: [],
    metadata,
  };
}

function decodedRowMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const decoded = parseReserveCompositionRow(
    {
      stablecoin_id: "lusd-liquity",
      slices: JSON.stringify([{ name: "ETH", pct: 100, risk: "very-low" }]),
      fetched_at: now - 60,
      source: "liquity-v1",
      metadata: JSON.stringify(metadata),
      warning_count: 0,
      warnings: null,
      adapter_source_model: "single-bucket",
      adapter_evidence_class: "independent",
    },
    null,
  );

  expect(decoded.issue).toBeNull();
  expect(decoded.record).not.toBeNull();
  return decoded.record!.metadata;
}

describe("readRedemptionBackstopLiveMetadata", () => {
  it.each(["2026-02-30", "2026-13-01", "20260512", "May 12, 2026"])(
    "drops invalid routeStatusReviewedAt value %s",
    (routeStatusReviewedAt) => {
      const metadata = readRedemptionBackstopLiveMetadata(
        "lusd-liquity",
        snapshot("lusd-liquity", {
          freshnessMode: "not-applicable",
          redemption: {
            capacityUsd: 1_000_000,
            capacityKind: "live-direct-bounded",
            freshnessKind: "same-run-onchain",
            routeStatus: "open",
            routeStatusSource: "onchain",
            routeStatusReviewedAt,
          },
        }),
        now,
      );

      expect(metadata.routeStatus).toBe("open");
      expect(metadata.routeStatusSource).toBe("onchain");
      expect(metadata.routeStatusReviewedAt).toBeNull();
    },
  );

  it("deduplicates valid sourceUrls and drops invalid or unsupported URLs", () => {
    const metadata = readRedemptionBackstopLiveMetadata(
      "lusd-liquity",
      snapshot("lusd-liquity", {
        freshnessMode: "not-applicable",
        redemption: {
          capacityUsd: 1_000_000,
          capacityKind: "live-direct-bounded",
          freshnessKind: "same-run-onchain",
          sourceUrls: [
            "https://example.com/redeem",
            "https://example.com/redeem",
            "not-a-url",
            "ftp://example.com/redeem",
            "http://example.com/status",
          ],
        },
      }),
      now,
    );

    expect(metadata.sourceUrls).toEqual([
      "https://example.com/redeem",
      "http://example.com/status",
    ]);
  });

  it("drops negative optional redemption constraints", () => {
    const metadata = readRedemptionBackstopLiveMetadata(
      "lusd-liquity",
      snapshot("lusd-liquity", {
        freshnessMode: "not-applicable",
        redemption: {
          capacityUsd: 1_000_000,
          capacityKind: "live-direct-bounded",
          freshnessKind: "same-run-onchain",
          dailyLimitUsd: -1,
          minRedeemUsd: "-2",
          settlementDelaySec: -3,
          queueDepthUsd: "-4",
        },
      }),
      now,
    );

    expect(metadata.dailyLimitUsd).toBeNull();
    expect(metadata.minRedeemUsd).toBeNull();
    expect(metadata.settlementDelaySec).toBeNull();
    expect(metadata.queueDepthUsd).toBeNull();
  });

  it("treats display-only capacityKind as unusable for scoring capacity", () => {
    const metadata = readRedemptionBackstopLiveMetadata(
      "lusd-liquity",
      snapshot("lusd-liquity", {
        freshnessMode: "not-applicable",
        redemption: {
          capacityUsd: 1_000_000,
          capacityKind: "documented-eventual",
          freshnessKind: "same-run-onchain",
        },
      }),
      now,
    );

    expect(metadata.capacityKind).toBe("documented-eventual");
    expect(metadata.immediateRedeemableUsd).toBe(1_000_000);
    expect(metadata.canUseCapacity).toBe(false);
    expect(metadata.capacityReason).toBe(
      "Live redemption capacity kind documented-eventual is display-only for scoring",
    );
  });

  it("rejects malformed numeric telemetry instead of coercing it", () => {
    const metadata = readRedemptionBackstopLiveMetadata(
      "lusd-liquity",
      snapshot("lusd-liquity", {
        freshnessMode: "not-applicable",
        immediateRedeemableUsd: 500_000,
        redemptionFeeBps: 50,
        redemption: {
          capacityUsd: "1000000",
          capacityRatioOfSupply: 1.2,
          feeBps: 20_000,
          capacityKind: "live-direct-bounded",
          freshnessKind: "same-run-onchain",
        },
      }),
      now,
    );

    expect(metadata.immediateRedeemableUsd).toBeNull();
    expect(metadata.immediateRedeemableRatio).toBeNull();
    expect(metadata.redemptionFeeBps).toBeNull();
    expect(metadata.canUseCapacity).toBe(false);
    expect(metadata.canUseFee).toBe(false);
    expect(metadata.capacityReason).toBe("Live redemption capacity telemetry is malformed; fresh valid metadata required");
    expect(metadata.feeReason).toBe("Live redemption fee telemetry is malformed; using reviewed fee model instead");
    expect(metadata.capacityNotes).toEqual(
      expect.arrayContaining([
        "Live redemption capacity USD is malformed and was ignored",
        "Live redemption capacity ratio is above 1 and was ignored",
        "Live redemption fee bps is above 10000 and was ignored",
      ]),
    );
  });

  it.each([
    ["string", "malformed"],
    ["null", null],
    ["array", []],
  ])("fails closed on malformed %s nested redemption telemetry instead of falling back to legacy fields", (_label, redemption) => {
    const metadata = readRedemptionBackstopLiveMetadata(
      "lusd-liquity",
      snapshot("lusd-liquity", {
        freshnessMode: "not-applicable",
        immediateRedeemableUsd: 500_000,
        redemptionFeeBps: 50,
        redemption,
      }),
      now,
    );

    expect(metadata.immediateRedeemableUsd).toBeNull();
    expect(metadata.redemptionFeeBps).toBeNull();
    expect(metadata.canUseCapacity).toBe(false);
    expect(metadata.canUseFee).toBe(false);
    expect(metadata.capacityReason).toBe("Live redemption capacity telemetry is malformed; fresh valid metadata required");
    expect(metadata.feeReason).toBe("Live redemption fee telemetry is malformed; using reviewed fee model instead");
    expect(metadata.capacityNotes).toContain("Live redemption telemetry is malformed and was ignored");
  });

  it.each([
    ["string", "malformed"],
    ["null", null],
    ["array", []],
    ["object-shaped numeric fields", { capacityUsd: "500000", feeBps: "50" }],
  ])("fails closed on malformed %s nested redemption telemetry after D1 row decoding", (_label, redemption) => {
    const decodedMetadata = decodedRowMetadata({
      freshnessMode: "not-applicable",
      immediateRedeemableUsd: 500_000,
      redemptionFeeBps: 50,
      redemption,
    });
    const metadata = readRedemptionBackstopLiveMetadata(
      "lusd-liquity",
      snapshot("lusd-liquity", decodedMetadata),
      now,
    );

    expect(metadata.immediateRedeemableUsd).toBeNull();
    expect(metadata.redemptionFeeBps).toBeNull();
    expect(metadata.canUseCapacity).toBe(false);
    expect(metadata.canUseFee).toBe(false);
    expect(metadata.capacityNotes).toContain("Live redemption telemetry is malformed and was ignored");
    expect(JSON.stringify(decodedMetadata)).not.toContain("malformedRedemptionTelemetry");
    expect(Object.keys((decodedMetadata.redemption ?? {}) as Record<string, unknown>)).not.toContain(
      "__malformedRedemptionTelemetry",
    );
  });

  it("keeps decoded missing nested redemption telemetry legacy-compatible", () => {
    const decodedMetadata = decodedRowMetadata({
      freshnessMode: "not-applicable",
      immediateRedeemableUsd: 500_000,
      redemptionFeeBps: 50,
    });
    const metadata = readRedemptionBackstopLiveMetadata(
      "lusd-liquity",
      snapshot("lusd-liquity", decodedMetadata),
      now,
    );

    expect(metadata.immediateRedeemableUsd).toBe(500_000);
    expect(metadata.redemptionFeeBps).toBe(50);
    expect(metadata.canUseCapacity).toBe(true);
    expect(metadata.canUseFee).toBe(true);
    expect(metadata.capacityNotes).not.toContain("Live redemption telemetry is malformed and was ignored");
  });

  it("lets valid nested redemption telemetry override malformed legacy fallback fields", () => {
    const metadata = readRedemptionBackstopLiveMetadata(
      "lusd-liquity",
      snapshot("lusd-liquity", {
        freshnessMode: "not-applicable",
        immediateRedeemableUsd: "legacy-bad",
        immediateRedeemableRatio: -0.5,
        redemptionFeeBps: "legacy-fee-bad",
        redemption: {
          capacityUsd: 750_000,
          capacityRatioOfSupply: 0.25,
          feeBps: 42,
          capacityKind: "live-direct-bounded",
          freshnessKind: "same-run-onchain",
        },
      }),
      now,
    );

    expect(metadata.immediateRedeemableUsd).toBe(750_000);
    expect(metadata.immediateRedeemableRatio).toBe(0.25);
    expect(metadata.redemptionFeeBps).toBe(42);
    expect(metadata.canUseCapacity).toBe(true);
    expect(metadata.canUseFee).toBe(true);
    expect(metadata.capacityNotes).not.toContain("Legacy redemption capacity USD is malformed and was ignored");
    expect(metadata.capacityNotes).not.toContain("Legacy redemption capacity ratio is below 0 and was ignored");
    expect(metadata.capacityNotes).not.toContain("Legacy redemption fee bps is malformed and was ignored");
  });

  it("still fails closed on malformed legacy telemetry when nested fields are absent", () => {
    const metadata = readRedemptionBackstopLiveMetadata(
      "lusd-liquity",
      snapshot("lusd-liquity", {
        freshnessMode: "not-applicable",
        immediateRedeemableUsd: Number.NaN,
        immediateRedeemableRatio: -0.1,
        redemptionFeeBps: -1,
      }),
      now,
    );

    expect(metadata.immediateRedeemableUsd).toBeNull();
    expect(metadata.immediateRedeemableRatio).toBeNull();
    expect(metadata.redemptionFeeBps).toBeNull();
    expect(metadata.canUseCapacity).toBe(false);
    expect(metadata.canUseFee).toBe(false);
    expect(metadata.capacityNotes).toEqual(
      expect.arrayContaining([
        "Legacy redemption capacity USD is malformed and was ignored",
        "Legacy redemption capacity ratio is below 0 and was ignored",
        "Legacy redemption fee bps is below 0 and was ignored",
      ]),
    );
  });

  it("ignores live route status that omits source attribution", () => {
    const metadata = readRedemptionBackstopLiveMetadata(
      "lusd-liquity",
      snapshot("lusd-liquity", {
        freshnessMode: "not-applicable",
        redemption: {
          capacityUsd: 1_000_000,
          capacityKind: "live-direct-bounded",
          freshnessKind: "same-run-onchain",
          routeStatus: "open",
        },
      }),
      now,
    );

    expect(metadata.routeStatus).toBeNull();
    expect(metadata.routeStatusSource).toBeNull();
    expect(metadata.capacityNotes).toContain("Live redemption route status omitted source attribution and was ignored");
  });

  it("preserves unknown live route status without source so downstream static open cannot win", () => {
    const metadata = readRedemptionBackstopLiveMetadata(
      "lusd-liquity",
      snapshot("lusd-liquity", {
        freshnessMode: "not-applicable",
        redemption: {
          capacityUsd: 1_000_000,
          capacityKind: "live-direct-bounded",
          freshnessKind: "same-run-onchain",
          routeStatus: "unknown",
        },
      }),
      now,
    );

    expect(metadata.routeStatus).toBe("unknown");
    expect(metadata.routeStatusSource).toBeNull();
    expect(metadata.routeStatusReason).toBeNull();
    expect(metadata.capacityNotes).toContain("Live redemption route status is unknown without source attribution");
  });

  it("drops orphaned route status source and details when the status is invalid", () => {
    const metadata = readRedemptionBackstopLiveMetadata(
      "lusd-liquity",
      snapshot("lusd-liquity", {
        freshnessMode: "not-applicable",
        redemption: {
          capacityUsd: 1_000_000,
          capacityKind: "live-direct-bounded",
          freshnessKind: "same-run-onchain",
          routeStatus: "closed",
          routeStatusSource: "onchain",
          routeStatusReason: "Adapter emitted a non-schema status.",
          routeStatusReviewedAt: "2026-05-17",
        },
      }),
      now,
    );

    expect(metadata.routeStatus).toBeNull();
    expect(metadata.routeStatusSource).toBeNull();
    expect(metadata.routeStatusReason).toBeNull();
    expect(metadata.routeStatusReviewedAt).toBeNull();
  });

  it("keeps sourced route status visible even when stale capacity cannot score", () => {
    const metadata = readRedemptionBackstopLiveMetadata(
      "lusd-liquity",
      {
        ...snapshot("lusd-liquity", {
          freshnessMode: "not-applicable",
          redemption: {
            capacityUsd: 1_000_000,
            capacityKind: "live-direct-bounded",
            freshnessKind: "same-run-onchain",
            routeStatus: "open",
            routeStatusSource: "onchain",
          },
        }),
        fetchedAt: now - 3 * 86_400,
      },
      now,
    );

    expect(metadata.canUseCapacity).toBe(false);
    expect(metadata.capacityReason).toBe("Live reserve metadata stale; fresh metadata required");
    expect(metadata.routeStatus).toBe("open");
    expect(metadata.routeStatusSource).toBe("onchain");
  });

  it("allows unverified freshness for route-approved stablecoins", () => {
    const metadata = readRedemptionBackstopLiveMetadata(
      "frxusd-frax",
      snapshot("frxusd-frax", {
        freshnessMode: "unverified",
        redemption: {
          capacityUsd: 1_000_000,
          capacityKind: "live-proxy-validated",
          freshnessKind: "unverified",
        },
      }),
      now,
    );

    expect(metadata.freshnessKind).toBe("unverified");
    expect(metadata.hasScoringEligibleFreshness).toBe(false);
    expect(metadata.capacityConfidence).toBe("live-proxy");
    expect(metadata.canUseCapacity).toBe(true);
    expect(metadata.capacityReason).toBeNull();
  });

  it("denies unverified freshness when the route lacks explicit approval", () => {
    const metadata = readRedemptionBackstopLiveMetadata(
      "lusd-liquity",
      snapshot("lusd-liquity", {
        freshnessMode: "unverified",
        redemption: {
          capacityUsd: 1_000_000,
          capacityKind: "live-direct-bounded",
          freshnessKind: "unverified",
        },
      }),
      now,
    );

    expect(metadata.freshnessKind).toBe("unverified");
    expect(metadata.hasScoringEligibleFreshness).toBe(false);
    expect(metadata.capacityConfidence).toBe("live-direct");
    expect(metadata.canUseCapacity).toBe(false);
    expect(metadata.capacityReason).toBe(
      "Live redemption capacity has unverified freshness; route-specific approval required",
    );
  });
});
