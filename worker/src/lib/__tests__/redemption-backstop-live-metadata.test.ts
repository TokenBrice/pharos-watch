import { describe, expect, it } from "vitest";
import { readRedemptionBackstopLiveMetadata } from "../redemption-backstop/live-metadata";
import type { ReserveSyncStateRecord } from "../live-reserves/store";
import { parseReserveCompositionRow } from "../live-reserves/store-row-decoding";
import { dusdOpenQueueMetadata, fpiControllerState, liveSnapshot } from "./redemption-backstop-sources.test-support";

const now = 1_780_000_000;

const readMetadata = (
  stablecoinId: string,
  metadata: Record<string, unknown>,
  evidenceClass: "independent" | "static-validated" | "weak-live-probe" = "independent",
) => readRedemptionBackstopLiveMetadata(stablecoinId, liveSnapshot(stablecoinId, metadata, {
  fetchedAt: now - 60, source: "unit-test", sourceModel: "single-bucket", evidenceClass,
}), now);

describe("redemption evidence observation clock", () => {
  it.each([
    ["same-run-onchain", undefined, 9 * 3600, now - 9 * 3600],
    ["same-run-api", undefined, 40 * 3600, now - 40 * 3600],
    ["same-run-onchain", now - 120, 60, now - 120],
    ["same-run-api", undefined, 0, now],
    ["verified-source-timestamp", undefined, 60, null],
    ["verified-source-timestamp", now + 601, 60, null],
    ["unverified", undefined, 60, null],
  ] as const)("preserves %s evidence time", (freshnessKind, sourceTimestamp, age, expected) => {
    const result = readRedemptionBackstopLiveMetadata("lusd-liquity", liveSnapshot("lusd-liquity", {
      freshnessMode: "not-applicable",
      redemption: { capacityUsd: 1_000_000, capacityKind: "live-direct", freshnessKind, sourceTimestamp },
    }, { fetchedAt: now - Number(age), source: "liquity-v1", sourceModel: "single-bucket" }), now);
    expect(result.evidenceObservedAt).toBe(expected);
  });

  it("does not invent an observation for a missing snapshot", () => {
    expect(readRedemptionBackstopLiveMetadata("lusd-liquity", null, now).evidenceObservedAt).toBeNull();
  });
});

describe("redemption capacity payout identity", () => {
  it.each([
    { keys: ["wm-m0"], expected: ["wm-m0"] },
    { keys: ["m-m0"], expected: ["m-m0"] },
    { keys: ["wm-m0", "wm-m0"], expected: null },
    { keys: [], expected: null },
    { keys: "wm-m0", expected: null },
    { keys: undefined, expected: null },
  ])("retains only typed exact payout identities ($keys)", ({ keys, expected }) => {
    const result = readMetadata("usdr-rise", {
      redemption: { outputAssetKeys: keys },
    });
    expect(result.outputAssetKeys).toEqual(expected);
  });
});

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

function decodedLegacyRecoveredRowMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const decodedMetadata = decodedRowMetadata(metadata);
  const syncState: ReserveSyncStateRecord = {
    stablecoinId: "lusd-liquity",
    adapterKey: "liquity-v1",
    breakerKey: "live-reserves:liquity-v1",
    lastAttemptedAt: now - 60,
    lastSuccessAt: now - 60,
    lastStatus: "ok",
    warningCount: 0,
    warnings: [],
    lastError: null,
    metadata: decodedMetadata,
    lastAttemptId: null,
    pendingAttemptId: null,
    lastSuccessAttemptId: null,
  };
  const decoded = parseReserveCompositionRow(
    {
      stablecoin_id: "lusd-liquity",
      slices: JSON.stringify([{ name: "ETH", pct: 100, risk: "very-low" }]),
      fetched_at: now - 60,
      source: "liquity-v1",
      metadata: null,
      warning_count: 0,
      warnings: null,
      adapter_source_model: "single-bucket",
      adapter_evidence_class: "independent",
    },
    syncState,
  );

  expect(decoded.issue).toBeNull();
  expect(decoded.record).not.toBeNull();
  return decoded.record!.metadata;
}

describe("readRedemptionBackstopLiveMetadata", () => {
  const payload = (redemption: Record<string, unknown>, metadata: Record<string, unknown> = {}) => ({
    freshnessMode: "not-applicable", ...metadata,
    redemption: {
      capacityUsd: 1_000_000, capacityKind: "live-direct-bounded",
      freshnessKind: "same-run-onchain", ...redemption,
    },
  });
  const payloadCases = [
    ["quarantines invalid source URLs rather than dropping constraints from a positive claim",
      payload({ sourceUrls: [
        "https://example.com/redeem", "https://example.com/redeem", "not-a-url",
        "ftp://example.com/redeem", "http://example.com/status",
      ] }),
      { sourceUrls: [], canUseCapacity: false, immediateRedeemableUsd: null }],
    ["quarantines negative optional redemption constraints",
      payload({ dailyLimitUsd: -1, minRedeemUsd: "-2", settlementDelaySec: -3, queueDepthUsd: "-4" }),
      { dailyLimitUsd: null, minRedeemUsd: null, settlementDelaySec: null, queueDepthUsd: null,
        canUseCapacity: false, immediateRedeemableUsd: null }],
    ["treats display-only capacityKind as unusable for scoring capacity",
      payload({ capacityKind: "documented-eventual" }),
      { capacityKind: "documented-eventual", immediateRedeemableUsd: 1_000_000,
        canUseCapacity: false,
        capacityReason: "Live redemption capacity kind documented-eventual is display-only for scoring" }],
    ["rejects malformed numeric telemetry instead of coercing it",
      payload(
        { capacityUsd: "1000000", capacityRatioOfSupply: 1.2, feeBps: 20_000 },
        { immediateRedeemableUsd: 500_000, redemptionFeeBps: 50 },
      ),
      { immediateRedeemableUsd: null, immediateRedeemableRatio: null,
        redemptionFeeBps: null, canUseCapacity: false, canUseFee: false,
        capacityRejectionReason: "malformed-telemetry",
        capacityConfidence: null }],
  ] as const;

  it("accepts a complete source-bound Cap output basket with current direct capacity", () => {
    const outputValuation = {
      sourceId: "cap-vault:chainlink-nav:0xd13cb763c43b5c058e7ec40176962c5030f4eb49",
      observedAt: now - 120,
      unitValueUsd: 0.999983,
      basketWeights: [
        { assetId: "usdc-circle", weight: 0.93 },
        { assetId: "wtgxx-wisdomtree", weight: 0.07 },
      ],
    };
    const metadata = readMetadata("cusd-cap", {
      freshnessMode: "not-applicable",
      redemption: {
        capacityUsd: 30_000_000,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
        routeStatusSource: "onchain",
        outputValuation,
      },
    });

    expect(metadata.canUseCapacity).toBe(true);
    expect(metadata.v9OutputValuation).toEqual(outputValuation);
  });

  it("accepts dEURO's complete reviewed basket including untracked output identities", () => {
    const outputValuation = {
      sourceId: "collateral-positions-api:deuro-bridge-basket:test",
      observedAt: now - 120,
      unitValueUsd: 1.15,
      expectedUnitValueUsd: 1.15,
      basketWeights: [
        { assetId: "asset:eurt", weight: 0 },
        { assetId: "eurs-stasis", weight: 0.01 },
        { assetId: "asset:veur", weight: 0 },
        { assetId: "eurc-circle", weight: 0.97 },
        { assetId: "eurr-stablr", weight: 0 },
        { assetId: "europ-schuman", weight: 0 },
        { assetId: "euri-banking-circle", weight: 0.01 },
        { assetId: "asset:eure-legacy-ethereum", weight: 0.01 },
        { assetId: "asset:eura", weight: 0 },
      ],
    };
    const metadata = readMetadata("deuro-deuro", {
      freshnessMode: "not-applicable",
      redemption: {
        capacityUsd: 500_000,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
        routeStatusSource: "onchain",
        outputValuation,
      },
    });

    expect(metadata.v9OutputValuation).toEqual(outputValuation);
  });

  it("preserves DUSD's unproven settlement bound without scoring the minimum finalization delay", () => {
    const metadata = readMetadata("dusd-dialectic", dusdOpenQueueMetadata(now + 60));

    expect(metadata.canUseCapacity).toBe(false);
    expect(metadata.capacityConfidence).toBe("live-proxy");
    expect(metadata.immediateRedeemableUsd).toBeNull();
    expect(metadata.settlementBoundUnproven).toBe(true);
    expect(metadata.capacityKind).toBe("live-queue");
    expect(metadata.queueDepthUsd).toBe(3_104.889979);
    expect(metadata.settlementDelaySec).toBeNull();
    expect(metadata.liveHolderEligibility).toBe("any-holder");
    expect(metadata.routeStatus).toBe("open");
    expect(metadata.routeStatusSource).toBe("onchain");
  });

  it("preserves an unproven settlement bound alongside the observed zero", () => {
    const metadata = readMetadata("eearn-ember", decodedRowMetadata({
      freshnessMode: "not-applicable",
      redemption: {
        capacityUsd: 0,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        settlementBoundUnproven: true,
        routeStatus: "open",
        routeStatusSource: "onchain",
      },
    }));

    expect(metadata.settlementBoundUnproven).toBe(true);
    expect(metadata.immediateRedeemableUsd).toBeNull();
    expect(metadata.canUseCapacity).toBe(false);
  });

  it("quarantines malformed Cap output weights together with capacity", () => {
    const metadata = readMetadata("cusd-cap", {
      freshnessMode: "not-applicable",
      redemption: {
        capacityUsd: 30_000_000,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        outputValuation: {
          sourceId: "cap-vault:chainlink-nav:test",
          observedAt: now - 120,
          unitValueUsd: 1,
          basketWeights: [
            { assetId: "usdc-circle", weight: 0.9 },
            { assetId: "wtgxx-wisdomtree", weight: 0.2 },
          ],
        },
      },
    });

    expect(metadata.canUseCapacity).toBe(false);
    expect(metadata.immediateRedeemableUsd).toBeNull();
    expect(metadata.v9OutputValuation).toBeNull();
  });

  it.each(["2026-02-30", "2026-13-01", "20260512", "May 12, 2026"])(
    "quarantines invalid routeStatusReviewedAt value %s",
    (routeStatusReviewedAt) => {
      const metadata = readMetadata("lusd-liquity", {
        freshnessMode: "not-applicable",
        redemption: {
          capacityUsd: 1_000_000,
          capacityKind: "live-direct-bounded",
          freshnessKind: "same-run-onchain",
          routeStatus: "open",
          routeStatusSource: "onchain",
          routeStatusReviewedAt,
        },
      });

      expect(metadata.routeStatus).toBeNull();
      expect(metadata.routeStatusSource).toBeNull();
      expect(metadata.routeStatusReviewedAt).toBeNull();
      expect(metadata.canUseCapacity).toBe(false);
      expect(metadata.immediateRedeemableUsd).toBeNull();
    },
  );

  it.each(payloadCases)("%s", (_description, input, expected) => {
    expect(readMetadata("lusd-liquity", input)).toMatchObject(expected);
  });

  it.each([
    ["string", "malformed"],
    ["null", null],
    ["array", []],
  ])("fails closed on malformed %s nested redemption telemetry instead of falling back to legacy fields", (_label, redemption) => {
    const metadata = readMetadata("lusd-liquity", {
      freshnessMode: "not-applicable",
      immediateRedeemableUsd: 500_000,
      redemptionFeeBps: 50,
      redemption,
    });

    expect(metadata.immediateRedeemableUsd).toBeNull();
    expect(metadata.redemptionFeeBps).toBeNull();
    expect(metadata.canUseCapacity).toBe(false);
    expect(metadata.canUseFee).toBe(false);
    expect(metadata.capacityRejectionReason).toBe("malformed-telemetry");
  });

  it.each([
    ["string", "malformed"],
    ["null", null],
    ["array", []],
    ["object-shaped numeric fields", { capacityUsd: "500000", feeBps: "50" }],
    ["object-shaped null numeric fields", { capacityUsd: null, feeBps: null }],
  ])("fails closed on malformed %s nested redemption telemetry after D1 row decoding", (_label, redemption) => {
    const decodedMetadata = decodedRowMetadata({
      freshnessMode: "not-applicable",
      immediateRedeemableUsd: 500_000,
      redemptionFeeBps: 50,
      redemption,
    });
    const metadata = readMetadata("lusd-liquity", decodedMetadata);

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

  it("preserves malformed decoded redemption telemetry through legacy snapshot recovery", () => {
    const decodedMetadata = decodedLegacyRecoveredRowMetadata({
      freshnessMode: "not-applicable",
      immediateRedeemableUsd: 500_000,
      redemptionFeeBps: 50,
      redemption: {
        capacityUsd: "500000",
        feeBps: null,
      },
    });
    const metadata = readMetadata("lusd-liquity", decodedMetadata);

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
    const metadata = readMetadata("lusd-liquity", decodedMetadata);

    expect(metadata.immediateRedeemableUsd).toBe(500_000);
    expect(metadata.redemptionFeeBps).toBe(50);
    expect(metadata.canUseCapacity).toBe(true);
    expect(metadata.canUseFee).toBe(true);
    expect(metadata.capacityNotes).not.toContain("Live redemption telemetry is malformed and was ignored");
  });

  it("lets valid nested redemption telemetry override malformed legacy fallback fields", () => {
    const metadata = readMetadata("lusd-liquity", {
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
    });

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
    const metadata = readMetadata("lusd-liquity", {
      freshnessMode: "not-applicable",
      redemption: {
        capacityUsd: Number.NaN,
        capacityRatioOfSupply: -0.1,
        feeBps: -1,
      },
    });

    expect(metadata.immediateRedeemableUsd).toBeNull();
    expect(metadata.immediateRedeemableRatio).toBeNull();
    expect(metadata.redemptionFeeBps).toBeNull();
    expect(metadata.canUseCapacity).toBe(false);
    expect(metadata.canUseFee).toBe(false);
    expect(metadata.capacityConfidence).toBeNull();
  });

  it("ignores live route status that omits source attribution", () => {
    const metadata = readMetadata("lusd-liquity", {
      freshnessMode: "not-applicable",
      redemption: {
        capacityUsd: 1_000_000,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
      },
    });

    expect(metadata.routeStatus).toBeNull();
    expect(metadata.routeStatusSource).toBeNull();
    expect(metadata.capacityNotes).toContain("Live redemption route status omitted source attribution and was ignored");
  });

  it("preserves unknown live route status without source so downstream static open cannot win", () => {
    const metadata = readMetadata("lusd-liquity", {
      freshnessMode: "not-applicable",
      redemption: {
        capacityUsd: 1_000_000,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        routeStatus: "unknown",
      },
    });

    expect(metadata.routeStatus).toBe("unknown");
    expect(metadata.routeStatusSource).toBeNull();
    expect(metadata.routeStatusReason).toBeNull();
    expect(metadata.capacityNotes).toContain("Live redemption route status is unknown without source attribution");
  });

  it("drops orphaned route status source and details when the status is invalid", () => {
    const metadata = readMetadata("lusd-liquity", {
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
    });

    expect(metadata.routeStatus).toBeNull();
    expect(metadata.routeStatusSource).toBeNull();
    expect(metadata.routeStatusReason).toBeNull();
    expect(metadata.routeStatusReviewedAt).toBeNull();
  });


  it.each([
    { dailyLimitUsd: -1 }, { queueDepthUsd: null }, { settlementDelaySec: "1" },
    { holderEligibility: "unsupported" }, { outputAssetKeys: [] },
  ])("cannot admit a positive capacity or fee with malformed constraint %j", (constraint) => {
    const raw = payload({ capacityUsd: 1_000_000, feeBps: 0, ...constraint });
    for (const input of [raw, decodedRowMetadata(raw)]) {
      const result = readMetadata("lusd-liquity", input);
      expect(result.canUseCapacity).toBe(false);
      expect(result.canUseFee).toBe(false);
      expect(result.immediateRedeemableUsd).toBeNull();
      expect(result.redemptionFeeBps).toBeNull();
      expect(result.capacityConfidence).toBeNull();
    }
  });
  it("does not promote stale sourced route status as currently admitted evidence", () => {
    const metadata = readRedemptionBackstopLiveMetadata(
      "lusd-liquity",
      liveSnapshot("lusd-liquity", {
        freshnessMode: "not-applicable",
        redemption: {
          capacityUsd: 1_000_000, capacityKind: "live-direct-bounded",
          freshnessKind: "same-run-onchain", routeStatus: "open", routeStatusSource: "onchain",
        },
      }, {
        fetchedAt: now - 3 * 86_400, source: "unit-test", sourceModel: "single-bucket",
        evidenceClass: "independent",
      }),
      now,
    );

    expect(metadata.canUseCapacity).toBe(false);
    expect(metadata.capacityRejectionReason).toBe("stale");
    expect(metadata.routeStatus).toBeNull();
    expect(metadata.routeStatusSource).toBeNull();
  });

  it.each([
    [
      "missing",
      undefined,
      "missing-source-timestamp",
    ],
    [
      "malformed",
      "1700000000",
      "malformed-telemetry",
    ],
    [
      "future-dated",
      now + 601,
      "future-source-timestamp",
    ],
  ])(
    "fails closed when verified redemption freshness has a %s source timestamp",
    (_label, redemptionSourceTimestamp, expectedReason) => {
      const redemption: Record<string, unknown> = {
        capacityUsd: 1_000_000,
        capacityKind: "live-direct-bounded",
        freshnessKind: "verified-source-timestamp",
      };
      if (redemptionSourceTimestamp !== undefined) {
        redemption.sourceTimestamp = redemptionSourceTimestamp;
      }

      const metadata = readMetadata("lusd-liquity", {
        freshnessMode: "verified",
        sourceTimestamp: now - 120,
        redemption,
      });

      expect(metadata.hasScoringEligibleFreshness).toBe(true);
      expect(metadata.freshnessKind).toBe(_label === "malformed" ? null : "verified-source-timestamp");
      expect(metadata.sourceTimestamp).toBeNull();
      expect(metadata.canUseCapacity).toBe(false);
      expect(metadata.capacityRejectionReason).toBe(expectedReason);
    },
  );

  it.each([
    ["allows unverified freshness for route-approved stablecoins",
      "frxusd-frax", "live-proxy-validated", "live-proxy", true, null],
    ["denies unverified freshness when the route lacks explicit approval",
      "lusd-liquity", "live-direct-bounded", "live-direct", false,
      "Live redemption capacity has unverified freshness; route-specific approval required"],
  ] as const)("%s", (
    _description, stablecoinId, capacityKind, capacityConfidence, canUseCapacity, capacityReason,
  ) => {
    const metadata = readMetadata(stablecoinId, {
      freshnessMode: "unverified",
      redemption: { capacityUsd: 1_000_000, capacityKind, freshnessKind: "unverified" },
    });
    expect(metadata).toMatchObject({
      freshnessKind: "unverified", hasScoringEligibleFreshness: false,
      capacityConfidence, canUseCapacity, capacityReason,
    });
  });

  it("parses only accepted FPI controller attempts without changing legacy telemetry", () => {
    const legacyRedemption = {
      capacityUsd: 2_000_000,
      capacityKind: "live-proxy-validated",
      freshnessKind: "verified-source-timestamp",
      sourceTimestamp: now - 60,
      routeStatus: "open",
      routeStatusSource: "protocol-api",
      feeBps: 17,
    };
    const state = fpiControllerState(now, 30);
    const accepted = readMetadata("fpi-frax", {
      freshnessMode: "verified",
      sourceTimestamp: now - 60,
      redemption: {
        ...legacyRedemption,
        v9RouteAttempt: { status: "accepted", attemptedAtSec: now, state },
      },
    });
    const rejected = readMetadata("fpi-frax", {
      freshnessMode: "verified",
      sourceTimestamp: now - 60,
      redemption: {
        ...legacyRedemption,
        v9RouteAttempt: {
          status: "rejected",
          attemptedAtSec: now,
          rejectionCode: "calculation-mismatch",
          blockNumber: 25_600_682,
        },
      },
    });

    expect(accepted.v9FpiControllerRouteState).toEqual(state);
    expect(rejected.v9FpiControllerRouteState).toBeNull();
    expect({
      canUseCapacity: accepted.canUseCapacity,
      canUseFee: accepted.canUseFee,
      immediateRedeemableUsd: accepted.immediateRedeemableUsd,
      redemptionFeeBps: accepted.redemptionFeeBps,
      routeStatus: accepted.routeStatus,
    }).toEqual({
      canUseCapacity: rejected.canUseCapacity,
      canUseFee: rejected.canUseFee,
      immediateRedeemableUsd: rejected.immediateRedeemableUsd,
      redemptionFeeBps: rejected.redemptionFeeBps,
      routeStatus: rejected.routeStatus,
    });
  });

  it("uses scoreable nested redemption telemetry even when the snapshot evidence class is weak", () => {
    const metadata = readMetadata("usdz-anzen", {
      freshnessMode: "not-applicable",
      redemption: {
        capacityUsd: 0.006695,
        capacityKind: "live-direct",
        freshnessKind: "same-run-onchain",
      },
    }, "weak-live-probe");

    expect(metadata.canUseCapacity).toBe(true);
    expect(metadata.immediateRedeemableUsd).toBe(0.006695);
    expect(metadata.capacityKind).toBe("live-direct");
    expect(metadata.freshnessKind).toBe("same-run-onchain");
  });

  it("still rejects weak-probe snapshots that only carry legacy capacity fields", () => {
    const metadata = readMetadata("satusd-river", {
      freshnessMode: "not-applicable",
      immediateRedeemableUsd: 9_100_000,
    }, "weak-live-probe");

    expect(metadata.canUseCapacity).toBe(false);
    expect(metadata.capacityReason).toBe(
      "Live reserve metadata uses weak or non-scoring evidence for redemption capacity",
    );
  });
});

describe("Theo curated carrier with independent redemption probe", () => {
  const metadata = {
    freshnessMode: "not-applicable",
    redemption: {
      capacityUsd: 220400, capacityKind: "live-direct-bounded", freshnessKind: "same-run-onchain",
      sourceTimestamp: now - 120, blockNumber: 26088429, feeBps: 5,
      routeStatus: "open", routeStatusSource: "onchain", settlementDelaySec: 0,
    },
  };

  it("accepts nested current capacity and fee without promoting the curated composition", () => {
    const result = readMetadata("thusd-theo", metadata, "static-validated");
    expect(result).toMatchObject({
      canUseCapacity: true, canUseFee: true, immediateRedeemableUsd: 220400,
      redemptionFeeBps: 5, evidenceObservedAt: now - 120, settlementDelaySec: 0,
      routeStatus: "open", routeStatusSource: "onchain",
    });
    expect(readMetadata("thusd-theo", {
      freshnessMode: "not-applicable", immediateRedeemableUsd: 220400,
    }, "static-validated").canUseCapacity).toBe(false);
  });

  it.each([
    ["theo-redemption-rail-closed", true],
    ["theo-redemption-buffer-empty", true],
    ["source-total-gap", false],
  ] as const)("allows only the reviewed zero-state warning %s", (code, accepted) => {
    const snapshot = liveSnapshot("thusd-theo", {
      ...metadata, redemption: { ...metadata.redemption, capacityUsd: 0, routeStatus: "paused" },
    }, {
      fetchedAt: now - 60, source: "theo-thusd-redemption", sourceModel: "validated-static",
      evidenceClass: "static-validated", syncStatus: "degraded",
      warningCount: 1, warnings: [{ code, severity: "warning", effect: "degraded", message: "adverse state" }],
    });
    const result = readRedemptionBackstopLiveMetadata("thusd-theo", snapshot, now);
    expect(result.canUseCapacity).toBe(accepted);
    expect(result.immediateRedeemableUsd).toBe(accepted ? 0 : null);
    expect(result.canUseFee).toBe(false);
    expect(readRedemptionBackstopLiveMetadata("usde-ethena", snapshot, now).canUseCapacity).toBe(false);
    snapshot.fetchedAt = now - 3 * 86400;
    expect(readRedemptionBackstopLiveMetadata("thusd-theo", snapshot, now).canUseCapacity).toBe(false);
  });
});

describe("capacity-specific reserve evidence admission", () => {
  const nested = {
    capacityUsd: 81_342.270181, capacityKind: "live-direct", freshnessKind: "same-run-onchain",
    sourceTimestamp: now - 12, blockNumber: 26_142_993, outputAssetKeys: ["usdc-circle"],
    routeStatus: "open", routeStatusSource: "onchain", holderEligibility: "any-holder", feeBps: 1.34,
  };
  const snapshot = (redemption: Record<string, unknown> = nested) => liveSnapshot("srusd-reservoir",
    { freshnessMode: "unverified", redemption }, {
      fetchedAt: now - 10, admission: { eligible: false, reasons: ["invalid-freshness"], freshness: null },
    });

  it("admits a complete nested pinned scope without promoting composition", () => {
    const input = snapshot();
    const result = readRedemptionBackstopLiveMetadata("srusd-reservoir", input, now);
    expect(result.canUseCapacity).toBe(true);
    expect(result.hasScoringEligibleFreshness).toBe(false);
    expect(input.admission?.eligible).toBe(false);
    expect(input.admission?.reasons).toEqual(["invalid-freshness"]);
    expect(result.immediateRedeemableUsd).toBe(nested.capacityUsd);
    expect(result.canUseFee).toBe(true);
  });

  it.each([
    [{ sourceTimestamp: undefined }, "missing-source-timestamp"],
    [{ sourceTimestamp: now + 601 }, "future-source-timestamp"],
    [{ sourceTimestamp: now - 172_801 }, "stale-source-timestamp"],
    [{ sourceTimestamp: "yesterday" }, "malformed-telemetry"],
    [{ blockNumber: undefined }, "missing-block-number"],
    [{ blockNumber: -1 }, "missing-block-number"],
    [{ blockNumber: 1.5 }, "missing-block-number"],
    [{ outputAssetKeys: undefined }, "route-output-identity-unobserved"],
    [{ outputAssetKeys: ["usdt-tether"] }, "route-output-identity-unobserved"],
    [{ capacityUsd: undefined }, "redeemable-capacity-unobserved"],
  ] as const)("rejects incomplete nested evidence %j with typed cause %s", (changes, cause) => {
    const result = readRedemptionBackstopLiveMetadata("srusd-reservoir", snapshot({ ...nested, ...changes }), now);
    expect(result.canUseCapacity).toBe(false);
    expect(result.capacityRejectionReason).toBe(cause);
  });

  it.each(["config-mismatch", "inconsistent-snapshot", "stale", "suspended"] as const)(
    "never overrides immutable snapshot defect %s", (reason) => {
      const input = snapshot();
      input.admission = { eligible: false, reasons: ["invalid-freshness", reason], freshness: null };
      const result = readRedemptionBackstopLiveMetadata("srusd-reservoir", input, now);
      expect(result.canUseCapacity).toBe(false);
      expect(result.canUseFee).toBe(false);
      expect(result.routeStatus).toBeNull();
      expect(result.capacityRejectionReason).toBe(reason);
    },
  );

  it("does not excuse a stale timestamped composition with a newer PSM read", () => {
    const input = snapshot();
    input.metadata.freshnessMode = "verified";
    input.metadata.sourceTimestamp = now - 90 * 86_400;
    input.admission = undefined;
    expect(readRedemptionBackstopLiveMetadata("srusd-reservoir", input, now).capacityRejectionReason).toBe("stale");
  });

  it("rejects insolvency instead of laundering it through the independent PSM scope", () => {
    const input = snapshot();
    input.warningCount = 1;
    input.warnings = [{ code: "reservoir-insolvent", severity: "warning", effect: "degraded", message: "fixture" }];
    const result = readRedemptionBackstopLiveMetadata("srusd-reservoir", input, now);
    expect(result.canUseCapacity).toBe(false);
    expect(result.capacityRejectionReason).toBe("degraded-snapshot");
  });

  it("retains fee evidence when only the capacity amount is absent", () => {
    const input = liveSnapshot("srusd-reservoir", {
      freshnessMode: "not-applicable", redemption: { ...nested, capacityUsd: undefined },
    }, { fetchedAt: now - 10 });
    const result = readRedemptionBackstopLiveMetadata("srusd-reservoir", input, now);
    expect(result.capacityRejectionReason).toBe("redeemable-capacity-unobserved");
    expect(result.canUseCapacity).toBe(false);
    expect(result.canUseFee).toBe(true);
    expect(result.redemptionFeeBps).toBe(1.34);
  });
});

describe("async cash is not holder completion capacity", () => {
  it.each(["open", "paused", "unknown", undefined])("withholds idle cash with unproved settlement and status %s", (routeStatus) => {
    const result = readMetadata("susdx-axis", {
      freshnessMode: "not-applicable", immediateRedeemableUsd: 41_995_519.33990015,
      redemption: { capacityUsd: 41_995_519.33990015, capacityKind: "documented-bound",
        freshnessKind: "same-run-onchain", settlementBoundUnproven: true,
        routeStatus, routeStatusSource: routeStatus ? "onchain" : undefined },
    });
    expect(result.canUseCapacity).toBe(false);
    expect(result.immediateRedeemableUsd).toBeNull();
    expect(result.immediateRedeemableRatio).toBeNull();
    expect(result.settlementBoundUnproven).toBe(true);
    expect(result.capacityRejectionReason).toBe("settlement-bound-unproven");
  });
});

describe("adverse evidence cannot be erased by rejected capacity", () => {
  it.each(["paused", "degraded", "cohort-limited", "unknown"])("preserves non-allowlisted degraded %s and limiting evidence", (routeStatus) => {
    const result = readRedemptionBackstopLiveMetadata("lusd-liquity", liveSnapshot("lusd-liquity", {
      freshnessMode: "not-applicable",
      redemption: { capacityUsd: 100, capacityKind: "live-direct", freshnessKind: "same-run-onchain",
        routeStatus, routeStatusSource: "onchain", routeStatusReason: "Observed impairment",
        routeStatusReviewedAt: "2026-05-01", dailyLimitUsd: 5, settlementBoundUnproven: true },
    }, { fetchedAt: now - 60, syncStatus: "degraded" }), now);
    expect(result.canUseCapacity).toBe(false);
    expect(result.immediateRedeemableUsd).toBeNull();
    expect(result.routeStatus).toBe(routeStatus);
    expect(result.routeStatusSource).toBe("onchain");
    expect(result.routeStatusReason).toBe("Observed impairment");
    expect(result.routeStatusReviewedAt).toBe("2026-05-01");
    expect(result.dailyLimitUsd).toBe(5);
    expect(result.settlementBoundUnproven).toBe(true);
    expect(result.evidenceObservedAt).toBeNull();
  });

  it("does not honour producer-authored suspended without authored routeSuspension", () => {
    const result = readMetadata("lusd-liquity", { freshnessMode: "not-applicable",
      redemption: { capacityUsd: 100, capacityKind: "live-direct", freshnessKind: "same-run-onchain",
        routeStatus: "suspended", routeStatusSource: "onchain" } });
    expect(result.routeStatus).toBeNull();
    expect(result.routeStatusSource).toBeNull();
    expect(result.capacityNotes.some((note) => note.includes("routeSuspension"))).toBe(true);
  });
});
