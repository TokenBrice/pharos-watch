import { describe, expect, it } from "vitest";
import { readRedemptionBackstopLiveMetadata } from "../redemption-backstop/live-metadata";
import type { ReserveSyncStateRecord } from "../live-reserves/store";
import { parseReserveCompositionRow } from "../live-reserves/store-row-decoding";
import { dusdOpenQueueMetadata, liveSnapshot } from "./redemption-backstop-sources.test-support";

const now = 1_780_000_000;

const snapshot = (
  stablecoinId: string,
  metadata: Record<string, unknown>,
  evidenceClass: "independent" | "static-validated" | "weak-live-probe" = "independent",
) => liveSnapshot(stablecoinId, metadata, {
  fetchedAt: now - 60,
  source: "unit-test",
  sourceModel: "single-bucket",
  evidenceClass,
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
    const metadata = readRedemptionBackstopLiveMetadata(
      "cusd-cap",
      snapshot("cusd-cap", {
        freshnessMode: "not-applicable",
        redemption: {
          capacityUsd: 30_000_000,
          capacityKind: "live-direct-bounded",
          freshnessKind: "same-run-onchain",
          routeStatus: "open",
          routeStatusSource: "onchain",
          outputValuation,
        },
      }),
      now,
    );

    expect(metadata.canUseCapacity).toBe(true);
    expect(metadata.v9OutputValuation).toEqual(outputValuation);
  });

  it("preserves DUSD's unproven settlement bound without scoring the minimum finalization delay", () => {
    const metadata = readRedemptionBackstopLiveMetadata(
      "dusd-dialectic",
      snapshot("dusd-dialectic", dusdOpenQueueMetadata(now + 60)),
      now,
    );

    expect(metadata.canUseCapacity).toBe(true);
    expect(metadata.capacityConfidence).toBe("live-proxy");
    expect(metadata.immediateRedeemableUsd).toBe(0);
    expect(metadata.settlementBoundUnproven).toBe(true);
    expect(metadata.capacityKind).toBe("live-queue");
    expect(metadata.queueDepthUsd).toBe(3_104.889979);
    expect(metadata.settlementDelaySec).toBeNull();
    expect(metadata.liveHolderEligibility).toBe("any-holder");
    expect(metadata.routeStatus).toBe("open");
    expect(metadata.routeStatusSource).toBe("onchain");
  });

  it("preserves an unproven settlement bound alongside the observed zero", () => {
    const metadata = readRedemptionBackstopLiveMetadata(
      "eearn-ember",
      snapshot("eearn-ember", decodedRowMetadata({
        freshnessMode: "not-applicable",
        redemption: {
          capacityUsd: 0,
          capacityKind: "live-direct-bounded",
          freshnessKind: "same-run-onchain",
          settlementBoundUnproven: true,
          routeStatus: "open",
          routeStatusSource: "onchain",
        },
      })),
      now,
    );

    expect(metadata.settlementBoundUnproven).toBe(true);
    expect(metadata.immediateRedeemableUsd).toBe(0);
    expect(metadata.canUseCapacity).toBe(true);
  });

  it("drops malformed Cap output weights without discarding valid capacity", () => {
    const metadata = readRedemptionBackstopLiveMetadata(
      "cusd-cap",
      snapshot("cusd-cap", {
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
      }),
      now,
    );

    expect(metadata.canUseCapacity).toBe(true);
    expect(metadata.v9OutputValuation).toBeNull();
    expect(metadata.capacityNotes).toContain("Live redemption output valuation is malformed and was ignored");
  });

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
    ["object-shaped null numeric fields", { capacityUsd: null, feeBps: null }],
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

  it.each([
    [
      "missing",
      undefined,
      "Live redemption freshness is verified-source-timestamp without sourceTimestamp",
      "Live redemption capacity claims verified source freshness without a source timestamp",
    ],
    [
      "malformed",
      "1700000000",
      "Live redemption source timestamp is malformed and was ignored",
      "Live redemption capacity claims verified source freshness without a source timestamp",
    ],
    [
      "future-dated",
      now + 601,
      "Live redemption source timestamp is 601s in the future and was ignored",
      "Live redemption capacity claims verified source freshness with a future source timestamp",
    ],
  ])(
    "fails closed when verified redemption freshness has a %s source timestamp",
    (_label, redemptionSourceTimestamp, expectedWarning, expectedReason) => {
      const redemption: Record<string, unknown> = {
        capacityUsd: 1_000_000,
        capacityKind: "live-direct-bounded",
        freshnessKind: "verified-source-timestamp",
      };
      if (redemptionSourceTimestamp !== undefined) {
        redemption.sourceTimestamp = redemptionSourceTimestamp;
      }

      const metadata = readRedemptionBackstopLiveMetadata(
        "lusd-liquity",
        snapshot("lusd-liquity", {
          freshnessMode: "verified",
          sourceTimestamp: now - 120,
          redemption,
        }),
        now,
      );

      expect(metadata.hasScoringEligibleFreshness).toBe(true);
      expect(metadata.freshnessKind).toBe("verified-source-timestamp");
      expect(metadata.sourceTimestamp).toBeNull();
      expect(metadata.canUseCapacity).toBe(false);
      expect(metadata.capacityReason).toBe(expectedReason);
      expect(metadata.capacityNotes).toContain(expectedWarning);
    },
  );

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
    const state = {
      kind: "fpi-controller-v1",
      chain: "ethereum",
      controllerAddress: "0x2397321b301b80a1c0911d6f9ed4b6033d43cf51",
      controllerCodeHash: "0x8f8968ffbb928926343d4217667f094cc938f359e253ef25ff33ee7b85ec1132",
      blockNumber: 25_600_682,
      blockTimestamp: now - 30,
      inputTokenAddress: "0x5ca135cb8527d76e932f34b5145575f9d8cbe08e",
      outputTokenAddress: "0x853d955acef822db058eb8505911ed77f175b99e",
      outputTrackedAssetId: "frax-frax",
      fraxPriceFeedAddress: "0xb9e1e3a9feff48998e45fa90847ed4d467e8bcfd",
      fraxPriceFeedCodeHash: "0xbd6f524cdc4268b6bd1bb6f77a8821faeea9c52ee9e0afa0b6d948ce82c966c2",
      fraxPriceFeedRoundId: "36893488147419121260",
      fraxPriceFeedUpdatedAt: now - 120,
      fraxPriceFeedAgeSec: 90,
      fpiPriceFeedAddress: "0x59985d79e1e69f659f4ab97db07a35ce73d9174b",
      fpiPriceFeedCodeHash: "0x2b165ff401e6d9ee29c0ef100b238ecb2fb7c89715104dde46b95547cea302fb",
      fpiPriceFeedRoundId: "0",
      fpiPriceFeedUpdatedAt: now - 30,
      fpiPriceFeedAgeSec: 0,
      maxPriceFeedAgeSec: 7_200,
      cpiTrackerAddress: "0x66b7dff2ac66dc4d6fbb3db1cb627bbb01ff3146",
      cpiTrackerCodeHash: "0xb989d68e59e9df4ef6d1782d56efe24f44bbb1d9e015c523c6e30adde9a7821d",
      cpiTrackerUpdatedAt: now - 90 * 86_400,
      cpiTrackerAgeSec: 90 * 86_400 - 30,
      fullConfidenceCpiTrackerAgeSec: 62 * 86_400,
      maxCpiTrackerAgeSec: 366 * 86_400,
      cpiTrackerFreshness: "stale-bounded",
      modelConfidence: "medium",
      feeBps: 30,
      pegPriceUsd: 1.157936,
      fpiPriceUsd: 1.153952,
      pegDifferenceBps: 34.52,
      pegBandBps: 500,
      quoteInputFpi: 1,
      quoteOutputFrax: 1.154462,
      outputPriceUsd: 0.98839875,
      allInCostBps: (1 - (1.154462 * 0.98839875) / 1.157936) * 10_000,
      controllerOutputBalance: 621_116.75,
      maxRedeemableFpi: 537_994.25,
      capacityUsd: 537_994.25 * 1.157936,
      sourceUrls: ["https://docs.frax.finance/frax-price-index/fpi-controller-pool"],
    };
    const accepted = readRedemptionBackstopLiveMetadata(
      "fpi-frax",
      snapshot("fpi-frax", {
        freshnessMode: "verified",
        sourceTimestamp: now - 60,
        redemption: {
          ...legacyRedemption,
          v9RouteAttempt: { status: "accepted", attemptedAtSec: now, state },
        },
      }),
      now,
    );
    const rejected = readRedemptionBackstopLiveMetadata(
      "fpi-frax",
      snapshot("fpi-frax", {
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
      }),
      now,
    );

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
    const metadata = readRedemptionBackstopLiveMetadata(
      "usdz-anzen",
      snapshot(
        "usdz-anzen",
        {
          freshnessMode: "not-applicable",
          redemption: {
            capacityUsd: 0.006695,
            capacityKind: "live-direct",
            freshnessKind: "same-run-onchain",
          },
        },
        "weak-live-probe",
      ),
      now,
    );

    expect(metadata.canUseCapacity).toBe(true);
    expect(metadata.immediateRedeemableUsd).toBe(0.006695);
    expect(metadata.capacityKind).toBe("live-direct");
    expect(metadata.freshnessKind).toBe("same-run-onchain");
  });

  it("still rejects weak-probe snapshots that only carry legacy capacity fields", () => {
    const metadata = readRedemptionBackstopLiveMetadata(
      "satusd-river",
      snapshot(
        "satusd-river",
        {
          freshnessMode: "not-applicable",
          immediateRedeemableUsd: 9_100_000,
        },
        "weak-live-probe",
      ),
      now,
    );

    expect(metadata.canUseCapacity).toBe(false);
    expect(metadata.capacityReason).toBe(
      "Live reserve metadata uses weak or non-scoring evidence for redemption capacity",
    );
  });
});
