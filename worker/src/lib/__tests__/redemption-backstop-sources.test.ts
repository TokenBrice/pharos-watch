import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { getRedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  buildEntryFixture,
  route,
  severeMarketEvidence,
  snapshot,
} from "./redemption-backstop-sources.test-support";

const getReserveSyncStateMock = vi.fn();
const getLatestSuccessfulReserveSnapshotMetadataMock = vi.fn();

vi.mock("../live-reserves-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../live-reserves-store")>();
  return {
    ...actual,
    getReserveSyncState: getReserveSyncStateMock,
    getLatestSuccessfulReserveSnapshotMetadata: getLatestSuccessfulReserveSnapshotMetadataMock,
    LIVE_RESERVE_FRESHNESS_SEC: 3600,
  };
});

describe("buildRedemptionBackstopEntry", () => {
  let buildRedemptionBackstopEntry: typeof import("../redemption-backstop-sources").buildRedemptionBackstopEntry;
  let buildFailedRedemptionBackstopEntry: typeof import("../redemption-backstop-sources").buildFailedRedemptionBackstopEntry;
  const now = 1_700_000_000;
  const fixedFeeCases = [
    { feeBps: 0, expectedScore: 100 },
    { feeBps: 25, expectedScore: 80 },
    { feeBps: 75, expectedScore: 60 },
    { feeBps: 200, expectedScore: 40 },
  ] as const;

  type RedemptionConfig = Parameters<typeof buildRedemptionBackstopEntry>[2];
  type BuildOptions = Parameters<typeof buildRedemptionBackstopEntry>[6];

  const buildEntry = (
    stablecoinId: string,
    config: RedemptionConfig,
    supplyUsd: number | null,
    dexScore: number | null,
    options?: BuildOptions,
  ) => buildEntryFixture(buildRedemptionBackstopEntry, {
    db: mockD1(),
    stablecoinId,
    route: config,
    supplyUsd,
    dexScore,
    nowSec: now,
    options,
  });

  beforeAll(async () => {
    const mod = await import("../redemption-backstop-sources");
    buildRedemptionBackstopEntry = mod.buildRedemptionBackstopEntry;
    buildFailedRedemptionBackstopEntry = mod.buildFailedRedemptionBackstopEntry;
  });

  beforeEach(() => {
    getReserveSyncStateMock.mockReset();
    getLatestSuccessfulReserveSnapshotMetadataMock.mockReset();
    getReserveSyncStateMock.mockResolvedValue(null);
    getLatestSuccessfulReserveSnapshotMetadataMock.mockResolvedValue(null);
  });

  it("resolves supply-full capacity with valid supply", async () => {
    const entry = await buildEntry(
      "test-coin",
      route({
        routeFamily: "offchain-issuer",
        accessModel: "issuer-api",
        settlementModel: "same-day",
        executionModel: "rules-based-nav",
      }),
      100_000_000, // $100M supply
      50, // dex liquidity score
    );

    expect(entry.resolutionState).toBe("resolved");
    expect(entry.sourceMode).toBe("estimated");
    expect(entry.capacitySemantics).toBe("eventual-only");
    expect(entry.immediateCapacityUsd).toBeNull();
    expect(entry.immediateCapacityRatio).toBeNull();
    expect(entry.score).toBeNull();
    expect(entry.capacityScore).toBeNull();
    expect(entry.eventualRedeemabilityScore).toBeLessThanOrEqual(65); // offchain-issuer cap
    expect(entry.capacityProfile).toMatchObject({
      eventualUsd: 100_000_000,
      scoringUsd: null,
      scoringHorizon: "eventual",
    });
  });

  it("floors zero eventual supply at a zero eventual redemption score", async () => {
    const entry = await buildEntry(
      "test-coin",
      route({
        routeFamily: "offchain-issuer",
        accessModel: "issuer-api",
        settlementModel: "same-day",
        executionModel: "rules-based-nav",
      }),
      0,
      null,
    );

    expect(entry.eventualRedeemabilityScore).toBe(0);
    expect(entry.capacityProfile?.eventualUsd).toBe(0);
  });

  it("returns missing-cache when supply is null for supply-full model", async () => {
    const entry = await buildEntry("test-coin", route(), null, 50);

    expect(entry.resolutionState).toBe("missing-cache");
    expect(entry.score).toBeNull();
    expect(entry.immediateCapacityUsd).toBeNull();
  });

  it("resolves supply-ratio capacity correctly", async () => {
    const entry = await buildEntry(
      "test-coin",
      route({ routeFamily: "psm-swap", capacityModel: { kind: "supply-ratio", ratio: 0.33 } }),
      1_000_000_000,
      80,
    );

    expect(entry.resolutionState).toBe("resolved");
    expect(entry.immediateCapacityUsd).toBe(330_000_000);
    expect(entry.immediateCapacityRatio).toBe(0.33);
    expect(entry.score).not.toBeNull();
  });

  it("uses capacity profile scoring capacity to reduce effective exit score", async () => {
    const entry = await buildEntry(
      "test-coin",
      route({ capacityModel: { kind: "supply-ratio", ratio: 1, dailyLimitUsd: 100_000, confidence: "documented-bound" } }),
      100_000_000,
      null,
    );

    expect(entry.resolutionState).toBe("resolved");
    expect(entry.capacityProfile).toMatchObject({
      immediateUsd: 100_000_000,
      dailyLimitUsd: 100_000,
      scoringUsd: 100_000,
      modeledExitSizeUsd: 5_000_000,
      scoringHorizon: "daily",
    });
    expect(entry.score).not.toBeNull();
  });

  it("applies explicit total score caps after component scoring", async () => {
    const entry = await buildEntry(
      "test-coin",
      route({
        capacityModel: { kind: "supply-ratio", ratio: 1, confidence: "documented-bound" },
        totalScoreCap: 42,
      }),
      100_000_000,
      null,
    );

    expect(entry.resolutionState).toBe("resolved");
    expect(entry.score).toBe(42);
    expect(entry.capsApplied).toContain("config-cap");
  });

  it("keeps eventual-only queue routes out of current-exit scoring", async () => {
    const entry = await buildEntry(
      "test-coin",
      route({ routeFamily: "queue-redeem", settlementModel: "queued", executionModel: "rules-based-nav" }),
      500_000_000,
      null,
    );

    expect(entry.score).toBeNull();
    expect(entry.capacityScore).toBeNull();
    expect(entry.eventualRedeemabilityScore).toBeLessThanOrEqual(70);
    expect(entry.capacityProfile?.scoringHorizon).toBe("eventual");
  });

  it("scores fixed 0 bps fee as 100", async () => {
    const { feeBps, expectedScore } = fixedFeeCases[0];
    const entry = await buildEntry("test-coin", route({
      costModel: { kind: "fee-bps", feeBps },
    }), 100_000_000, null);

    expect(entry.costScore).toBe(expectedScore);
    expect(entry.feeBps).toBe(feeBps);
    expect(entry.feeConfidence).toBe("fixed");
  });

  it("scores fixed 25 bps fee as 80", async () => {
    const { feeBps, expectedScore } = fixedFeeCases[1];
    const entry = await buildEntry("test-coin", route({
      costModel: { kind: "fee-bps", feeBps },
    }), 100_000_000, null);

    expect(entry.costScore).toBe(expectedScore);
    expect(entry.feeBps).toBe(feeBps);
  });

  it("scores fixed 75 bps fee as 60", async () => {
    const { feeBps, expectedScore } = fixedFeeCases[2];
    const entry = await buildEntry("test-coin", route({
      costModel: { kind: "fee-bps", feeBps },
    }), 100_000_000, null);

    expect(entry.costScore).toBe(expectedScore);
  });

  it("scores fixed 200 bps fee as 40", async () => {
    const { feeBps, expectedScore } = fixedFeeCases[3];
    const entry = await buildEntry("test-coin", route({
      costModel: { kind: "fee-bps", feeBps },
    }), 100_000_000, null);

    expect(entry.costScore).toBe(expectedScore);
  });

  it("scores formula-confidence dynamic fees as 60", async () => {
    const entry = await buildEntry(
      "bold-liquity",
      route({
        routeFamily: "collateral-redeem",
        outputAssetType: "bluechip-collateral",
        costModel: {
          kind: "dynamic-or-unclear",
          feeDescription: "Minimum 50 bps + baseRate",
          confidence: "formula",
        },
      }),
      100_000_000,
      null,
    );

    expect(entry.costScore).toBe(60);
    expect(entry.feeConfidence).toBe("formula");
  });

  it("uses live fee metadata for formula routes when reserve sync exposes a current fee", async () => {
    const entry = await buildEntry(
      "test-coin",
      route({
        routeFamily: "collateral-redeem",
        outputAssetType: "bluechip-collateral",
        capacityModel: { kind: "supply-full", confidence: "documented-bound" },
        costModel: {
          kind: "dynamic-or-unclear",
          feeDescription: "Minimum 50 bps + baseRate",
          confidence: "formula",
        },
      }),
      100_000_000,
      null,
      {
        reserveSnapshotMetadata: snapshot("bold-liquity", {
          redemptionFeeBps: 50,
          freshnessMode: "not-applicable",
        }, {
          fetchedAt: now - 300,
          source: "single-asset",
          sourceModel: "single-bucket",
        }),
      },
    );

    expect(entry.costScore).toBe(80);
    expect(entry.feeBps).toBe(50);
    expect(entry.feeConfidence).toBe("formula");
    expect(entry.feeModelKind).toBe("formula");
  });

  it("scores undisclosed-reviewed dynamic fees as 40", async () => {
    const entry = await buildEntry(
      "test-coin",
      route({
        routeFamily: "offchain-issuer",
        accessModel: "issuer-api",
        settlementModel: "same-day",
        executionModel: "rules-based-nav",
        costModel: {
          kind: "dynamic-or-unclear",
          feeDescription: "Public docs reviewed do not publish a numeric redemption fee.",
          confidence: "undisclosed-reviewed",
        },
      }),
      100_000_000,
      null,
    );

    expect(entry.costScore).toBe(40);
    expect(entry.feeConfidence).toBe("undisclosed-reviewed");
  });

  it("resolves reserve-sync-metadata capacity with fresh data", async () => {
    const entry = await buildEntry(
      "lusd-liquity",
      route({
        routeFamily: "queue-redeem",
        settlementModel: "queued",
        executionModel: "rules-based-nav",
        capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.15 },
        costModel: { kind: "dynamic-or-unclear" },
      }),
      50_000_000,
      null,
      {
        reserveSnapshotMetadata: snapshot("lusd-liquity", {
          immediateRedeemableUsd: 7_500_000,
          immediateRedeemableRatio: 0.15,
          sourceTimestamp: now - 1800,
        }, { fetchedAt: now - 1800 }),
      },
    );

    expect(entry.sourceMode).toBe("dynamic");
    expect(entry.resolutionState).toBe("resolved");
    expect(entry.immediateCapacityUsd).toBe(7_500_000);
    expect(entry.immediateCapacityRatio).toBe(0.15);
    expect(entry.capacityConfidence).toBe("live-direct");
    expect(entry.capacitySemantics).toBe("immediate-bounded");
    expect(entry.eventualRedeemabilityScore).toBeNull();
    expect(entry.capacityProfile?.eventualUsd).toBeUndefined();
  });

  it("publishes reviewed queued settlement and a zero headline for eEARN-style measured incapacity", async () => {
    const entry = await buildEntry(
      "lusd-liquity",
      route({
        settlementModel: "atomic",
        executionModel: "rules-based-nav",
        capacityModel: { kind: "reserve-sync-metadata" },
        v9RouteReviewTerms: { settlementModel: "queued" },
      }),
      20_000_000,
      null,
      {
        reserveSnapshotMetadata: snapshot("lusd-liquity", {
          freshnessMode: "not-applicable",
          redemption: {
            capacityUsd: 0,
            capacityKind: "live-queue",
            freshnessKind: "same-run-onchain",
            settlementDelaySec: 2_592_000,
          },
        }, { fetchedAt: now - 120 }),
      },
    );

    expect(entry.resolutionState).toBe("resolved");
    expect(entry.score).toBe(0);
    expect(entry.capacityScore).toBe(0);
    expect(entry.capsApplied).toContain("zero-executable-capacity");
    expect(entry.settlementModel).toBe("queued");
    expect(entry.settlementScore).toBe(20);
    expect(entry.queueEnabled).toBe(true);
    expect(entry.eventualRedeemabilityScore).toBeNull();
    expect(entry.capacityProfile?.exitRouteObservations?.[0]?.settlementHorizonSec).toBe(2_592_000);
  });

  it("leaves eEARN-style unproven settlement capacity unrated while retaining the queued trace", async () => {
    const entry = await buildEntry(
      "lusd-liquity",
      route({
        settlementModel: "atomic",
        executionModel: "rules-based-nav",
        capacityModel: { kind: "reserve-sync-metadata" },
        v9RouteReviewTerms: { settlementModel: "queued" },
      }),
      20_000_000,
      null,
      {
        reserveSnapshotMetadata: snapshot("lusd-liquity", {
          freshnessMode: "not-applicable",
          redemption: {
            capacityUsd: 0,
            capacityKind: "live-queue",
            freshnessKind: "same-run-onchain",
            settlementBoundUnproven: true,
            settlementDelaySec: 2_592_000,
            routeStatus: "open",
            routeStatusSource: "onchain",
          },
        }, { fetchedAt: now - 120 }),
      },
    );

    expect(entry.resolutionState).toBe("missing-capacity");
    expect(entry.score).toBeNull();
    expect(entry.capacityScore).toBeNull();
    expect(entry.capsApplied).not.toContain("zero-executable-capacity");
    expect(entry.eventualRedeemabilityScore).toBeNull();
    expect(entry.capacityProfile).toMatchObject({
      scoringUsd: null,
      settlementBoundUnproven: true,
      exitRouteObservations: [
        {
          settlementBoundUnproven: true,
          scoreEligible: false,
          settlementHorizonSec: 2_592_000,
        },
      ],
    });
    expect(entry.capacityProfile?.exitRouteObservations?.[0]).not.toHaveProperty("capacityCurve");
  });

  it("keeps a paused flagged queue on the measured-zero path instead of the bounded gap", async () => {
    const entry = await buildEntry(
      "lusd-liquity",
      route({
        settlementModel: "atomic",
        executionModel: "rules-based-nav",
        capacityModel: { kind: "reserve-sync-metadata" },
        v9RouteReviewTerms: { settlementModel: "queued" },
      }),
      20_000_000,
      null,
      {
        reserveSnapshotMetadata: snapshot("lusd-liquity", {
          freshnessMode: "not-applicable",
          redemption: {
            capacityUsd: 0,
            capacityKind: "live-queue",
            freshnessKind: "same-run-onchain",
            settlementBoundUnproven: true,
            settlementDelaySec: 2_592_000,
            routeStatus: "paused",
            routeStatusSource: "onchain",
            routeStatusReason: "Withdrawals are paused onchain",
          },
        }, { fetchedAt: now - 120 }),
      },
    );

    // A paused route's zero is the measured pause, not an evidence gap: the
    // bounded-gap lane must not swallow a live impairment.
    expect(entry.routeStatus).toBe("paused");
    expect(entry.capacityProfile?.settlementBoundUnproven).not.toBe(true);
    expect(entry.score).toBeNull();
    expect(entry.capsApplied).toContain("live-route-status-impairment");
  });

  it("reuses pre-parsed live redemption metadata for capacity and fees", async () => {
    const entry = await buildEntry(
      "usdo-openeden",
      route({
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: {
          kind: "dynamic-or-unclear",
          confidence: "formula",
          feeDescription: "Live fee formula",
        },
      }),
      50_000_000,
      null,
      {
        reserveSnapshotMetadata: snapshot("usdo-openeden", {
          redemption: {
            capacityUsd: 1,
            feeBps: 99,
          },
        }, { fetchedAt: now - 120 }),
        redemptionLiveMetadata: {
          updatedAt: now - 120,
          isFresh: true,
          hasScoringEligibleFreshness: true,
          hasBlockingWarnings: false,
          capacityNotes: [],
          capacityConfidence: "live-direct",
          settlementBoundUnproven: false,
          canUseCapacity: true,
          canUseFee: true,
          capacityReason: null,
          feeReason: null,
          immediateRedeemableUsd: 12_500_000,
          immediateRedeemableRatio: null,
          capacityKind: "live-direct",
          freshnessKind: "verified-source-timestamp",
          sourceTimestamp: now - 120,
          sourceUrls: ["https://example.com/redemption.json"],
          settlementDelaySec: null,
          queueDepthUsd: null,
          dailyLimitUsd: null,
          minRedeemUsd: null,
          liveHolderEligibility: null,
          redemptionFeeBps: 4,
          buyFeeBpsMin: null,
          buyFeeBpsMax: null,
          routeStatus: "open",
          routeStatusSource: "protocol-api",
          routeStatusReason: null,
          routeStatusReviewedAt: null,
          v9FpiControllerRouteState: null,
          v9SfrxusdCrosschainRouteState: null,
        },
      },
    );

    expect(entry.provider).toBe("reserve-sync-metadata");
    expect(entry.immediateCapacityUsd).toBe(12_500_000);
    expect(entry.feeBps).toBe(4);
    expect(entry.sourceTimestamp).toBe(now - 120);
    expect(entry.sourceUrls).toEqual(["https://example.com/redemption.json"]);
  });

  it("derives reserve-sync ratio from supply when nested capacity omits ratio", async () => {
    const entry = await buildEntry(
      "usde-ethena",
      route({
        accessModel: "whitelisted-onchain",
        settlementModel: "immediate",
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: { kind: "dynamic-or-unclear", feeDescription: "Reviewed variable fee" },
        reviewedAt: "2026-04-15",
        docs: [{ label: "Ethena collateral API", url: "https://app.ethena.fi/api/positions/current/collateral" }],
      }),
      100_000_000,
      null,
      {
        reserveSnapshotMetadata: snapshot("usde-ethena", {
          immediateRedeemableRatio: 0.9,
          freshnessMode: "verified",
          sourceTimestamp: now - 120,
          redemption: {
            capacityUsd: 50_000_000,
            capacityKind: "live-proxy-validated",
            freshnessKind: "verified-source-timestamp",
            sourceTimestamp: now - 120,
            sourceUrls: ["https://example.com/redemption.json", "https://example.com/redemption.json"],
            settlementDelaySec: 3600,
            queueDepthUsd: 12_000_000,
            dailyLimitUsd: 5_000_000,
            minRedeemUsd: 100_000,
            holderEligibility: "whitelisted-primary",
            routeStatus: "open",
            routeStatusSource: "protocol-api",
          },
        }, { fetchedAt: now - 120, source: "ethena" }),
      },
    );

    expect(entry.immediateCapacityUsd).toBe(50_000_000);
    expect(entry.immediateCapacityRatio).toBe(0.5);
    expect(entry.capacityKind).toBe("live-proxy-validated");
    expect(entry.freshnessKind).toBe("verified-source-timestamp");
    expect(entry.sourceTimestamp).toBe(now - 120);
    expect(entry.sourceUrls).toEqual(["https://example.com/redemption.json"]);
    expect(entry.settlementDelaySec).toBe(3600);
    expect(entry.queueDepthUsd).toBe(12_000_000);
    expect(entry.dailyLimitUsd).toBe(5_000_000);
    expect(entry.minRedeemUsd).toBe(100_000);
    expect(entry.liveHolderEligibility).toBe("whitelisted-primary");
  });

  it("uses DUSD live queue capacity without treating whitelist access as route impairment", async () => {
    const config = getRedemptionBackstopConfig("dusd-dialectic");
    expect(config).not.toBeNull();

    const entry = await buildEntry(
      "dusd-dialectic",
      config!,
      5_800_000,
      null,
      {
        reserveSnapshotMetadata: snapshot("dusd-dialectic", {
          freshnessMode: "verified",
          sourceTimestamp: now - 120,
          redemption: {
            capacityUsd: 0,
            capacityKind: "live-queue",
            freshnessKind: "same-run-onchain",
            queueDepthUsd: 3_104.889979,
            holderEligibility: "issuer-discretionary",
            routeStatus: "open",
            routeStatusSource: "onchain",
          },
          redemptionQueue: {
            minimumFinalizationDelaySec: 43_200,
          },
        }, { fetchedAt: now - 120, source: "makina-strategy" }),
      },
    );

    expect(entry.provider).toBe("reserve-sync-metadata");
    expect(entry.sourceMode).toBe("dynamic");
    expect(entry.resolutionState).toBe("resolved");
    expect(entry.routeStatus).toBe("open");
    expect(entry.routeStatusSource).toBe("onchain");
    expect(entry.liveHolderEligibility).toBe("issuer-discretionary");
    expect(entry.capacityConfidence).toBe("documented-bound");
    expect(entry.capacityBasis).toBe("live-proxy-buffer");
    expect(entry.capacityKind).toBe("live-queue");
    expect(entry.immediateCapacityUsd).toBe(0);
    expect(entry.queueDepthUsd).toBe(3_104.889979);
    expect(entry.settlementDelaySec).toBeUndefined();
    expect(entry.capsApplied).not.toContain("live-route-status-impairment");
  });

  it("fails DUSD closed when the live queue proof omits usable capacity", async () => {
    const config = getRedemptionBackstopConfig("dusd-dialectic");
    expect(config).not.toBeNull();

    const entry = await buildEntry(
      "dusd-dialectic",
      config!,
      5_800_000,
      null,
      {
        reserveSnapshotMetadata: snapshot("dusd-dialectic", {
          freshnessMode: "verified",
          sourceTimestamp: now - 120,
          redemption: {
            capacityKind: "live-queue",
            freshnessKind: "same-run-onchain",
            routeStatus: "open",
            routeStatusSource: "onchain",
          },
        }, { fetchedAt: now - 120, source: "makina-strategy" }),
      },
    );

    expect(entry.resolutionState).toBe("missing-capacity");
    expect(entry.provider).toBe("reserve-sync-metadata");
    expect(entry.immediateCapacityUsd).toBeNull();
    expect(entry.score).toBeNull();
    expect(entry.notes).toContain("Live reserve metadata lacks redeemable-capacity amount");
  });

  it("propagates live route status from reserve metadata", async () => {
    const entry = await buildEntry(
      "cusd-cap",
      route({
        routeFamily: "basket-redeem",
        executionModel: "deterministic-basket",
        outputAssetType: "stable-basket",
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: { kind: "dynamic-or-unclear", feeDescription: "Reviewed variable fee" },
        reviewedAt: "2026-04-15",
        docs: [{ label: "Cap vault", url: "https://docs.cap.app/concepts/vault" }],
      }),
      100_000_000,
      null,
      {
        reserveSnapshotMetadata: snapshot("cusd-cap", {
          freshnessMode: "not-applicable",
          redemption: {
            capacityUsd: 10_000_000,
            capacityKind: "live-direct-bounded",
            freshnessKind: "same-run-onchain",
            routeStatus: "paused",
            routeStatusSource: "onchain",
            routeStatusReason: "All vault assets are paused",
            routeStatusReviewedAt: "2026-04-15",
          },
        }, { fetchedAt: now - 120, source: "cap-vault" }),
      },
    );

    expect(entry.routeStatus).toBe("paused");
    expect(entry.routeStatusSource).toBe("onchain");
    expect(entry.routeStatusReason).toBe("All vault assets are paused");
    expect(entry.routeStatusReviewedAt).toBe("2026-04-15");
    expect(entry.resolutionState).toBe("impaired");
    expect(entry.score).toBeNull();
    expect(entry.modelConfidence).toBe("low");
    expect(entry.capsApplied).toContain("live-route-status-impairment");
  });

  it("treats cohort-limited live route status as an impaired route", async () => {
    const entry = await buildEntry(
      "cusd-cap",
      route({
        routeFamily: "basket-redeem",
        executionModel: "deterministic-basket",
        outputAssetType: "stable-basket",
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: { kind: "fee-bps", feeBps: 0 },
      }),
      100_000_000,
      null,
      {
        reserveSnapshotMetadata: snapshot("cusd-cap", {
          freshnessMode: "not-applicable",
          redemption: {
            capacityUsd: 10_000_000,
            capacityKind: "live-direct-bounded",
            freshnessKind: "same-run-onchain",
            routeStatus: "cohort-limited",
            routeStatusSource: "protocol-api",
            routeStatusReason: "Redemptions are limited to a reviewed cohort",
          },
        }, { fetchedAt: now - 120, source: "cap-vault" }),
      },
    );

    expect(entry.routeStatus).toBe("cohort-limited");
    expect(entry.routeStatusSource).toBe("protocol-api");
    expect(entry.resolutionState).toBe("impaired");
    expect(entry.score).toBeNull();
    expect(entry.capsApplied).toContain("live-route-status-impairment");
  });

  it("ignores live route status without source attribution", async () => {
    const entry = await buildEntry(
      "cusd-cap",
      route({
        routeFamily: "basket-redeem",
        executionModel: "deterministic-basket",
        outputAssetType: "stable-basket",
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: { kind: "dynamic-or-unclear", feeDescription: "Reviewed variable fee" },
        reviewedAt: "2026-04-15",
        docs: [{ label: "Cap vault", url: "https://docs.cap.app/concepts/vault" }],
      }),
      100_000_000,
      null,
      {
        reserveSnapshotMetadata: snapshot("cusd-cap", {
          freshnessMode: "not-applicable",
          redemption: {
            capacityUsd: 10_000_000,
            capacityKind: "live-direct-bounded",
            freshnessKind: "same-run-onchain",
            routeStatus: "paused",
            routeStatusReason: "All vault assets are paused",
          },
        }, { fetchedAt: now - 120, source: "cap-vault" }),
      },
    );

    expect(entry.resolutionState).toBe("resolved");
    expect(entry.routeStatus).toBe("open");
    expect(entry.routeStatusSource).toBe("static-config");
    expect(entry.notes).toContain("Live redemption route status omitted source attribution and was ignored");
    expect(entry.capsApplied).not.toContain("live-route-status-impairment");
  });

  it("uses unsourced unknown live route status to suppress optimistic static open status", async () => {
    const entry = await buildEntry(
      "test-coin",
      route({
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: { kind: "dynamic-or-unclear", feeDescription: "Reviewed variable fee" },
        reviewedAt: "2026-04-15",
        docs: [{ label: "Fixture route", url: "https://example.com/redemption" }],
      }),
      100_000_000,
      null,
      {
        reserveSnapshotMetadata: snapshot("test-coin", {
          freshnessMode: "not-applicable",
          redemption: {
            capacityUsd: 10_000_000,
            capacityKind: "live-proxy-validated",
            freshnessKind: "same-run-api",
            routeStatus: "unknown",
          },
        }, { fetchedAt: now - 120, source: "fixture" }),
      },
    );

    expect(entry.resolutionState).toBe("resolved");
    expect(entry.routeStatus).toBe("unknown");
    expect(entry.routeStatusSource).toBe("static-config");
    expect(entry.modelConfidence).toBe("low");
    expect(entry.confidenceDetails?.reasons).toContain(
      "Route status is unknown without direct live telemetry or a documented capacity bound",
    );
    expect(entry.notes).toContain("Live redemption route status is unknown without source attribution");
  });

  it("uses LUSD Liquity v1 system debt as live direct redemption capacity", async () => {
    const config = getRedemptionBackstopConfig("lusd-liquity");
    expect(config).not.toBeNull();

    const entry = await buildEntry("lusd-liquity", config!, 100_000_000, null, {
      reserveSnapshotMetadata: snapshot("lusd-liquity", {
        freshnessMode: "not-applicable",
        redemptionFeeBps: 50,
        redemption: {
          capacityUsd: 84_000_000,
          capacityKind: "live-direct-bounded",
          freshnessKind: "same-run-onchain",
          feeBps: 50,
        },
      }, { fetchedAt: now - 120, source: "liquity-v1", sourceModel: "single-bucket" }),
    });

    expect(entry.provider).toBe("reserve-sync-metadata");
    expect(entry.sourceMode).toBe("dynamic");
    expect(entry.resolutionState).toBe("resolved");
    expect(entry.capacityConfidence).toBe("live-direct");
    expect(entry.capacitySemantics).toBe("immediate-bounded");
    expect(entry.immediateCapacityUsd).toBe(84_000_000);
    expect(entry.immediateCapacityRatio).toBe(0.84);
    expect(entry.capacityBasis).toBe("live-direct-telemetry");
    expect(entry.feeBps).toBe(50);
    expect(entry.modelConfidence).toBe("high");
  });

  it("uses fxSAVE ERC-4626 idle fxSP as Safety-eligible live direct redemption capacity", async () => {
    const config = getRedemptionBackstopConfig("fxsave-f-x-protocol");
    expect(config).not.toBeNull();

    const entry = await buildEntry(
      "fxsave-f-x-protocol",
      config!,
      10_000_000,
      20,
      {
        reserveSnapshotMetadata: snapshot("fxsave-f-x-protocol", {
          freshnessMode: "not-applicable",
          assetAddress: "0x65c9a641afceb9c0e6034e558a319488fa0fa3be",
          redemption: {
            capacityUsd: 2_000_000,
            capacityRatioOfSupply: 0.2,
            capacityKind: "live-direct",
            freshnessKind: "same-run-onchain",
            routeStatus: "unknown",
            routeStatusSource: "onchain",
          },
        }, { fetchedAt: now - 120, source: "erc4626-single-asset", sourceModel: "single-bucket" }),
      },
    );

    expect(entry.provider).toBe("reserve-sync-metadata");
    expect(entry.sourceMode).toBe("dynamic");
    expect(entry.resolutionState).toBe("resolved");
    expect(entry.capacityConfidence).toBe("live-direct");
    expect(entry.capacityBasis).toBe("live-direct-telemetry");
    expect(entry.capacitySemantics).toBe("immediate-bounded");
    expect(entry.immediateCapacityUsd).toBe(2_000_000);
    expect(entry.immediateCapacityRatio).toBe(0.2);
    expect(entry.modelConfidence).toBe("high");
  });

  it("uses BOLD Liquity v2 branch debt as live direct redemption capacity", async () => {
    const config = getRedemptionBackstopConfig("bold-liquity");
    expect(config).not.toBeNull();

    const entry = await buildEntry("bold-liquity", config!, 40_000_000, null, {
      reserveSnapshotMetadata: snapshot("bold-liquity", {
        freshnessMode: "not-applicable",
        redemptionFeeBps: 52,
        redemption: {
          capacityUsd: 32_000_000,
          capacityKind: "live-direct-bounded",
          freshnessKind: "same-run-onchain",
          routeStatus: "open",
          routeStatusSource: "onchain",
          feeBps: 52,
        },
      }, { fetchedAt: now - 120, source: "liquity-v2-branches" }),
    });

    expect(entry.provider).toBe("reserve-sync-metadata");
    expect(entry.sourceMode).toBe("dynamic");
    expect(entry.resolutionState).toBe("resolved");
    expect(entry.capacityConfidence).toBe("live-direct");
    expect(entry.capacitySemantics).toBe("immediate-bounded");
    expect(entry.immediateCapacityUsd).toBe(32_000_000);
    expect(entry.immediateCapacityRatio).toBe(0.8);
    expect(entry.capacityBasis).toBe("live-direct-telemetry");
    expect(entry.feeBps).toBe(52);
    expect(entry.modelConfidence).toBe("high");
  });

  it("models the ZCHF CHFAU StablecoinBridge route with live bridge capacity and zero fee", async () => {
    const config = getRedemptionBackstopConfig("zchf-frankencoin");
    expect(config).not.toBeNull();

    const entry = await buildEntry(
      "zchf-frankencoin",
      config!,
      27_682_881.200551473,
      35,
      {
        reserveSnapshotMetadata: snapshot("zchf-frankencoin", {
          immediateRedeemableUsd: 362_655.25,
          freshnessMode: "unverified",
        }, { fetchedAt: now - 300, source: "collateral-positions-api" }),
      },
    );

    expect(entry.routeFamily).toBe("stablecoin-redeem");
    expect(entry.resolutionState).toBe("resolved");
    expect(entry.provider).toBe("reserve-sync-metadata");
    expect(entry.capacityConfidence).toBe("live-direct");
    expect(entry.immediateCapacityUsd).toBe(362_655.25);
    expect(entry.feeBps).toBe(0);
    expect(entry.feeConfidence).toBe("fixed");
    expect(entry.modelConfidence).toBe("high");
  });

  it("falls back to ratio when reserve-sync has no immediate capacity data", async () => {
    const entry = await buildEntry(
      "test-coin",
      route({
        routeFamily: "queue-redeem",
        settlementModel: "queued",
        executionModel: "rules-based-nav",
        capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.15 },
        costModel: { kind: "dynamic-or-unclear" },
      }),
      50_000_000,
      null,
      { reserveSnapshotMetadata: null },
    );

    expect(entry.sourceMode).toBe("estimated");
    expect(entry.resolutionState).toBe("resolved");
    expect(entry.immediateCapacityUsd).toBe(7_500_000); // 50M * 0.15
    expect(entry.provider).toBe("reserve-sync-fallback");
    expect(entry.capacityConfidence).toBe("heuristic");
    expect(entry.capacityBasis).toBe("strategy-buffer");
  });

  it("uses reviewed fallback confidence and basis for reserve-sync fallback ratios", async () => {
    const entry = await buildEntry(
      "test-coin",
      route({
        capacityModel: {
          kind: "reserve-sync-metadata",
          fallbackRatio: 0.0025,
          confidence: "documented-bound",
          basis: "hot-buffer",
        },
        costModel: { kind: "dynamic-or-unclear", feeDescription: "Reviewed route" },
        reviewedAt: "2026-04-04",
        docs: [{ label: "Reviewed source", url: "https://example.com" }],
      }),
      100_000_000,
      null,
      { reserveSnapshotMetadata: null },
    );

    expect(entry.provider).toBe("reserve-sync-fallback");
    expect(entry.sourceMode).toBe("estimated");
    expect(entry.capacityConfidence).toBe("documented-bound");
    expect(entry.capacityBasis).toBe("hot-buffer");
    expect(entry.immediateCapacityUsd).toBe(250_000);
  });

  it("returns missing-capacity when reserve-sync has no data and no fallback", async () => {
    const entry = await buildEntry(
      "test-coin",
      route({
        routeFamily: "queue-redeem",
        settlementModel: "queued",
        executionModel: "rules-based-nav",
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: { kind: "dynamic-or-unclear" },
      }),
      50_000_000,
      null,
      { reserveSnapshotMetadata: null },
    );

    expect(entry.resolutionState).toBe("missing-capacity");
    expect(entry.score).toBeNull();
  });

  it("explains missing capacity when a capable live adapter omits capacity amounts", async () => {
    const entry = await buildEntry(
      "zchf-frankencoin",
      route({
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: { kind: "fee-bps", feeBps: 0 },
      }),
      50_000_000,
      null,
      {
        reserveSnapshotMetadata: snapshot("zchf-frankencoin", {
          freshnessMode: "unverified",
          details: {
            freshnessSource: "position-and-price-apis",
            freshnessReason: "Collateral positions and price payloads do not expose a trustworthy source timestamp",
          },
        }, {
          fetchedAt: now - 120,
          source: "collateral-positions-api",
        }),
      },
    );

    expect(entry.resolutionState).toBe("missing-capacity");
    expect(entry.notes).toContain("Live reserve metadata lacks redeemable-capacity amount");
  });

  it("does not emit an effective-exit score when the redemption route is unresolved", async () => {
    const entry = await buildEntry(
      "test-coin",
      route({
        routeFamily: "queue-redeem",
        settlementModel: "queued",
        executionModel: "rules-based-nav",
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: { kind: "dynamic-or-unclear" },
      }),
      50_000_000,
      55,
      { reserveSnapshotMetadata: null },
    );

    expect(entry.resolutionState).toBe("missing-capacity");
  });

  it("preserves reviewed fee and docs metadata on failed reserve-sync routes", () => {
    const entry = buildFailedRedemptionBackstopEntry(
      "test-coin",
      route({
        routeFamily: "queue-redeem",
        settlementModel: "queued",
        executionModel: "rules-based-nav",
        capacityModel: { kind: "reserve-sync-metadata", confidence: "documented-bound" },
        costModel: {
          kind: "fee-bps",
          feeBps: 25,
          feeDescription: "Reviewed fallback fee is 25 bps",
        },
        docs: [{ label: "Reviewed route docs", url: "https://example.com/route", supports: ["route", "fees"] }],
      }),
      now,
    );

    expect(entry.resolutionState).toBe("failed");
    expect(entry.score).toBeNull();
    expect(entry.capacityConfidence).toBe("dynamic");
    expect(entry.feeConfidence).toBe("fixed");
    expect(entry.feeBps).toBe(25);
    expect(entry.feeDescription).toBe("Reviewed fallback fee is 25 bps");
    expect(entry.docs).toMatchObject({
      label: "Reviewed route docs",
      url: "https://example.com/route",
      provenance: "config-reviewed",
    });
    expect(entry.docs?.sources?.[0]?.supports).toEqual(["route", "fees"]);
  });

  it("does not add current-exit uplift for eventual-only redemption", async () => {
    const entry = await buildEntry("test-coin", route({
      capacityModel: { kind: "supply-full" },
      costModel: { kind: "fee-bps", feeBps: 0 },
    }), 500_000_000, 40);
    expect(entry.score).toBeNull();
    expect(entry.eventualRedeemabilityScore).not.toBeNull();
  });

  it("marks static redemption routes impaired during severe active depegs", async () => {
    const entry = await buildEntry(
      "test-coin",
      route({
        capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "documented-bound" },
        costModel: { kind: "dynamic-or-unclear", feeDescription: "Reviewed route" },
      }),
      100_000_000,
      33,
      {
        routeAvailability: severeMarketEvidence({
          routeStatusReason:
            "Active severe depeg of 8332 bps started 2026-03-22; static redemption route requires current live-open evidence before it can score.",
          routeStatusReviewedAt: "2026-04-14",
          activeDepegBps: 8332,
          activeDepegStartedAt: 1_774_145_097,
        }),
      },
    );

    expect(entry.resolutionState).toBe("impaired");
    expect(entry.score).toBeNull();
    expect(entry.routeStatus).toBe("degraded");
    expect(entry.routeStatusSource).toBe("market-implied");
    expect(entry.routeStatusReviewedAt).toBe("2026-04-14");
    expect(entry.modelConfidence).toBe("low");
    expect(entry.capsApplied).toContain("market-implied-depeg-impairment");
    expect(entry.notes).toContain(
      "Active severe depeg of 8332 bps started 2026-03-22; static redemption route requires current live-open evidence before it can score.",
    );
  });

  it("keeps strong live-direct routes scoreable during severe active depegs", async () => {
    const entry = await buildEntry(
      "zchf-frankencoin",
      route({
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: { kind: "fee-bps", feeBps: 0 },
      }),
      50_000_000,
      33,
      {
        reserveSnapshotMetadata: snapshot("zchf-frankencoin", {
          immediateRedeemableUsd: 5_000_000,
          immediateRedeemableRatio: 0.1,
          sourceTimestamp: now - 120,
          redemption: {
            capacityUsd: 5_000_000,
            capacityRatioOfSupply: 0.1,
            capacityKind: "live-direct",
            freshnessKind: "same-run-onchain",
            sourceTimestamp: now - 120,
            routeStatus: "open",
            routeStatusSource: "onchain",
          },
        }, { fetchedAt: now - 120 }),
        routeAvailability: severeMarketEvidence({
          routeStatusReason:
            "Active severe depeg of 3000 bps started 2026-04-14; static redemption route requires current live-open evidence before it can score.",
          routeStatusReviewedAt: "2026-04-14",
          activeDepegStartedAt: now,
        }),
      },
    );

    expect(entry.resolutionState).toBe("resolved");
    expect(entry.score).not.toBeNull();
    expect(entry.routeStatus).toBe("open");
    expect(entry.routeStatusSource).toBe("onchain");
    expect(entry.modelConfidence).toBe("high");
    expect(entry.capsApplied).not.toContain("market-implied-depeg-impairment");
  });

  it("evaluates the severe-depeg exemption against the final downgraded capacity state", async () => {
    // Same direct-telemetry adapter and severe depeg as the strong live-direct
    // exemption test above, but the live snapshot is stale, so capacity
    // resolution downgrades the route to the configured heuristic fallback.
    // The exemption must be asserted against that FINAL state and not the
    // optimistic live-direct configuration, so the route is impaired.
    const entry = await buildEntry(
      "zchf-frankencoin",
      route({
        capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.1 },
        costModel: { kind: "fee-bps", feeBps: 0 },
      }),
      50_000_000,
      33,
      {
        reserveSnapshotMetadata: snapshot("zchf-frankencoin", {
          immediateRedeemableUsd: 5_000_000,
          immediateRedeemableRatio: 0.1,
          sourceTimestamp: now - 7_200,
          redemption: {
            capacityUsd: 5_000_000,
            capacityRatioOfSupply: 0.1,
            capacityKind: "live-direct",
            freshnessKind: "same-run-onchain",
            sourceTimestamp: now - 7_200,
          },
        }, { fetchedAt: now - 7_200 }),
        routeAvailability: severeMarketEvidence({
          routeStatusReason:
            "Active severe depeg of 3000 bps started 2026-04-14; static redemption route requires current live-open evidence before it can score.",
          routeStatusReviewedAt: "2026-04-14",
          activeDepegStartedAt: now,
        }),
      },
    );

    // Capacity resolution downgraded the live-direct route to the fallback
    expect(entry.provider).toBe("reserve-sync-fallback");
    expect(entry.sourceMode).toBe("estimated");
    expect(entry.capacityConfidence).toBe("heuristic");
    // ...so the strong live-direct severe-depeg exemption does not apply
    expect(entry.resolutionState).toBe("impaired");
    expect(entry.score).toBeNull();
    expect(entry.routeStatus).toBe("degraded");
    expect(entry.routeStatusSource).toBe("market-implied");
    expect(entry.modelConfidence).toBe("low");
    expect(entry.capsApplied).toContain("market-implied-depeg-impairment");
  });

  it("derives modelConfidence correctly for resolved entries", async () => {
    // Dynamic capacity + fixed fee → high
    const highEntry = await buildEntry(
      "lusd-liquity",
      route({
        routeFamily: "queue-redeem",
        settlementModel: "queued",
        executionModel: "rules-based-nav",
        capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.15 },
        costModel: { kind: "fee-bps", feeBps: 0 },
      }),
      50_000_000,
      null,
      {
        reserveSnapshotMetadata: snapshot("lusd-liquity", {
          immediateRedeemableUsd: 5_000_000,
          immediateRedeemableRatio: 0.1,
          sourceTimestamp: now - 100,
        }, { fetchedAt: now - 100 }),
      },
    );
    expect(highEntry.modelConfidence).toBe("high");

    // Documented eventual redeemability + reviewed formula fee -> medium
    const mediumEntry = await buildEntry("test-coin", route({
      routeFamily: "collateral-redeem",
      outputAssetType: "bluechip-collateral",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: {
        kind: "dynamic-or-unclear",
        feeDescription: "Minimum 50 bps + baseRate",
        confidence: "formula",
      },
    }), 100_000_000, null);
    expect(mediumEntry.modelConfidence).toBe("medium");
    expect(mediumEntry.capacitySemantics).toBe("eventual-only");

    // Supply-full (heuristic capacity) → low
    const lowEntry = await buildEntry("test-coin", route({
      routeFamily: "offchain-issuer",
      accessModel: "issuer-api",
      settlementModel: "same-day",
      executionModel: "rules-based-nav",
      capacityModel: { kind: "supply-full" },
      costModel: { kind: "dynamic-or-unclear" },
    }), 100_000_000, null);
    expect(lowEntry.modelConfidence).toBe("low");
  });

  it("stops using stale reserve capacity metadata when no safe fallback exists", async () => {
    const entry = await buildEntry(
      "gho-aave",
      route({
        routeFamily: "psm-swap",
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: { kind: "fee-bps", feeBps: 10 },
      }),
      50_000_000,
      null,
      {
        reserveSnapshotMetadata: snapshot("test-coin", {
          immediateRedeemableUsd: 10_000_000,
          immediateRedeemableRatio: 0.2,
        }, { fetchedAt: now - 7_200 }),
      },
    );

    expect(entry.resolutionState).toBe("missing-capacity");
    expect(entry.score).toBeNull();
    expect(entry.notes).toContain("Live reserve metadata stale; fresh metadata required");
  });

  it("keeps GHO resolved when the only live warning is aggregated residual issuance", async () => {
    const entry = await buildEntry(
      "gho-aave",
      route({
        routeFamily: "psm-swap",
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: { kind: "fee-bps", feeBps: 10 },
      }),
      584_000_000,
      null,
      {
        reserveSnapshotMetadata: snapshot("gho-aave", {
          immediateRedeemableUsd: 212_370_000,
          immediateRedeemableRatio: 212_370_000 / 584_000_000,
          redemptionFeeBps: 10,
          freshnessMode: "not-applicable",
        }, {
          fetchedAt: now - 120,
          source: "gho",
          warningCount: 1,
          warnings: [
            {
              code: "aggregated-residual-issuance",
              message: "Residual GHO issuance outside tracked GSM backing remains aggregated (63.63%)",
              severity: "warning",
              effect: "degraded",
            },
          ],
          syncStatus: "degraded",
        }),
      },
    );

    expect(entry.resolutionState).toBe("resolved");
    expect(entry.provider).toBe("reserve-sync-metadata");
    expect(entry.capacityConfidence).toBe("live-direct");
    expect(entry.immediateCapacityUsd).toBe(212_370_000);
    expect(entry.notes).toContain(
      "Using tracked live GSM backing as a lower-bound redemption capacity despite aggregated residual issuance outside configured GSM modules",
    );
  });

  it("still blocks GHO when degraded live metadata includes non-allowlisted warnings", async () => {
    const entry = await buildEntry(
      "gho-aave",
      route({
        routeFamily: "psm-swap",
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: { kind: "fee-bps", feeBps: 10 },
      }),
      584_000_000,
      null,
      {
        reserveSnapshotMetadata: snapshot("gho-aave", {
          immediateRedeemableUsd: 212_370_000,
          immediateRedeemableRatio: 212_370_000 / 584_000_000,
          freshnessMode: "not-applicable",
        }, {
          fetchedAt: now - 120,
          source: "gho",
          warningCount: 2,
          warnings: [
            {
              code: "aggregated-residual-issuance",
              message: "Residual GHO issuance outside tracked GSM backing remains aggregated (63.63%)",
              severity: "warning",
              effect: "degraded",
            },
            {
              code: "tracked-gsm-read-failed",
              message: "Tracked GSM module could not be read",
              severity: "warning",
              effect: "degraded",
            },
          ],
          syncStatus: "degraded",
        }),
      },
    );

    expect(entry.resolutionState).toBe("missing-capacity");
    expect(entry.notes).toContain("Live reserve metadata degraded; latest snapshot not in ok state");
  });

  it("uses fresh live redemption fee telemetry for fixed-fee routes", async () => {
    const entry = await buildEntry(
      "test-coin",
      route({
        routeFamily: "psm-swap",
        capacityModel: { kind: "supply-full", confidence: "documented-bound" },
        costModel: {
          kind: "fee-bps",
          feeBps: 10,
          feeDescription: "Reviewed fallback bound is 10 bps",
        },
      }),
      50_000_000,
      null,
      {
        reserveSnapshotMetadata: snapshot("gho-aave", {
          redemptionFeeBps: 7,
          sourceTimestamp: now - 120,
        }, { fetchedAt: now - 120 }),
      },
    );

    expect(entry.feeBps).toBe(7);
    expect(entry.costScore).toBe(100);
    expect(entry.feeDescription).toBe("Fresh live redemption fee telemetry: 7 bps.");
    expect(entry.notes).toContain("Using fresh live redemption fee telemetry in place of the reviewed fallback bound");
  });

  it("populates docs from proofOfReserves when available", async () => {
    const meta = TRACKED_META_BY_ID.get("usdt-tether");
    expect(meta?.proofOfReserves?.url).toBeTruthy();

    const entry = await buildEntry("usdt-tether", route({
      accessModel: "issuer-api",
      settlementModel: "same-day",
      executionModel: "rules-based-nav",
      capacityModel: { kind: "supply-full" },
      costModel: { kind: "fee-bps", feeBps: 0 },
    }), 100_000_000, null);

    expect(entry.docs).toBeDefined();
    expect(entry.docs!.url).toBe(meta!.proofOfReserves!.url);
    expect(entry.docs!.label).toContain("feed");
    expect(entry.docs!.provenance).toBe("proof-of-reserves");
  });

  it("falls back to preferred link labels when no proofOfReserves", async () => {
    const meta = TRACKED_META_BY_ID.get("usds-sky");
    expect(meta?.proofOfReserves?.url).toBeFalsy();
    const preferredLabels = ["Docs", "Proof of Reserve", "Transparency", "Website"];
    const hasPreferred = meta?.links?.some((l) => preferredLabels.includes(l.label));
    expect(hasPreferred).toBe(true);

    const entry = await buildEntry("usds-sky", route({
      routeFamily: "psm-swap",
      capacityModel: { kind: "supply-full" },
      costModel: { kind: "fee-bps", feeBps: 0 },
    }), 1_000_000_000, null);

    expect(entry.docs).toBeDefined();
    expect(preferredLabels).toContain(entry.docs!.label);
    expect(entry.docs!.provenance).toBe("preferred-link");
  });

  it("returns no docs for unknown coins", async () => {
    const entry = await buildEntry("test-coin", route({
      capacityModel: { kind: "supply-full" },
      costModel: { kind: "fee-bps", feeBps: 0 },
    }), 100_000_000, null);

    expect(entry.docs).toBeUndefined();
  });

  it("deduplicates notes both within config and across config + runtime sources", async () => {
    const runtimeNote = "Live reserve metadata unavailable; using configured fallback ratio";
    const entry = await buildEntry(
      "test-coin",
      route({
        capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.1 },
        costModel: { kind: "fee-bps", feeBps: 0 },
        notes: ["Shared note", "Shared note", runtimeNote],
      }),
      1_000_000,
      50,
      { reserveSnapshotMetadata: null },
    );
    const notes = entry.notes ?? [];
    expect(notes.filter((n) => n === "Shared note").length).toBe(1);
    expect(notes.filter((n) => n === runtimeNote).length).toBe(1);
  });

  it("adds the accepted FPI controller route without changing legacy entry fields", async () => {
    const config = getRedemptionBackstopConfig("fpi-frax");
    expect(config).toBeDefined();
    const state = {
      kind: "fpi-controller-v1",
      chain: "ethereum",
      controllerAddress: "0x2397321b301b80a1c0911d6f9ed4b6033d43cf51",
      controllerCodeHash: "0x8f8968ffbb928926343d4217667f094cc938f359e253ef25ff33ee7b85ec1132",
      blockNumber: 25_600_682,
      blockTimestamp: now - 20,
      inputTokenAddress: "0x5ca135cb8527d76e932f34b5145575f9d8cbe08e",
      outputTokenAddress: "0x853d955acef822db058eb8505911ed77f175b99e",
      outputTrackedAssetId: "frax-frax",
      fraxPriceFeedAddress: "0xb9e1e3a9feff48998e45fa90847ed4d467e8bcfd",
      fraxPriceFeedCodeHash: "0xbd6f524cdc4268b6bd1bb6f77a8821faeea9c52ee9e0afa0b6d948ce82c966c2",
      fraxPriceFeedRoundId: "36893488147419121260",
      fraxPriceFeedUpdatedAt: now - 120,
      fraxPriceFeedAgeSec: 100,
      fpiPriceFeedAddress: "0x59985d79e1e69f659f4ab97db07a35ce73d9174b",
      fpiPriceFeedCodeHash: "0x2b165ff401e6d9ee29c0ef100b238ecb2fb7c89715104dde46b95547cea302fb",
      fpiPriceFeedRoundId: "0",
      fpiPriceFeedUpdatedAt: now - 20,
      fpiPriceFeedAgeSec: 0,
      maxPriceFeedAgeSec: 7_200,
      cpiTrackerAddress: "0x66b7dff2ac66dc4d6fbb3db1cb627bbb01ff3146",
      cpiTrackerCodeHash: "0xb989d68e59e9df4ef6d1782d56efe24f44bbb1d9e015c523c6e30adde9a7821d",
      cpiTrackerUpdatedAt: now - 90 * 86_400,
      cpiTrackerAgeSec: 90 * 86_400 - 20,
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
    const reserveSnapshot = (v9RouteAttempt?: Record<string, unknown>) => ({
      stablecoinId: "fpi-frax",
      fetchedAt: now - 30,
      source: "frax-fpi-collateral",
      metadata: {
        freshnessMode: "verified" as const,
        sourceTimestamp: now - 30,
        redemption: {
          capacityUsd: 2_000_000,
          capacityKind: "live-proxy-validated" as const,
          freshnessKind: "verified-source-timestamp" as const,
          sourceTimestamp: now - 30,
          routeStatus: "open" as const,
          routeStatusSource: "protocol-api" as const,
          sourceUrls: ["https://frax.com/transparency"],
          ...(v9RouteAttempt ? { v9RouteAttempt } : {}),
        },
      },
      warningCount: 0,
      warnings: [],
      sourceModel: "dynamic-mix" as const,
      evidenceClass: "independent" as const,
      syncStatus: "ok" as const,
    });
    const baseline = await buildEntry(
      "fpi-frax",
      config!,
      10_000_000,
      null,
      { reserveSnapshotMetadata: reserveSnapshot() },
    );
    const accepted = await buildEntry(
      "fpi-frax",
      config!,
      10_000_000,
      null,
      {
        reserveSnapshotMetadata: reserveSnapshot({
          status: "accepted",
          attemptedAtSec: now,
          state,
        }),
      },
    );
    const rejected = await buildEntry(
      "fpi-frax",
      config!,
      10_000_000,
      null,
      {
        reserveSnapshotMetadata: reserveSnapshot({
          status: "rejected",
          attemptedAtSec: now,
          rejectionCode: "calculation-mismatch",
          blockNumber: 25_600_682,
        }),
      },
    );

    const acceptedRoute = accepted.capacityProfile?.exitRouteObservations?.[0];
    expect(acceptedRoute).toMatchObject({
      routeId: "redemption:fpi-frax:fpi-controller:ethereum",
      scope: { kind: "chain-contract", contractOrPoolId: state.controllerAddress },
      output: { kind: "tracked-stablecoin", trackedAssetIds: ["frax-frax"] },
      evidenceKind: "onchain-contract-state",
      scoreEligible: true,
      executableUsd: 500_000,
      completionRatio: 1,
    });
    expect(rejected.capacityProfile?.exitRouteObservations?.[0]).toMatchObject({
      routeId: "redemption:fpi-frax:collateral-redeem",
      scoreEligible: false,
    });

    const acceptedLegacy = structuredClone(accepted);
    const baselineLegacy = structuredClone(baseline);
    delete acceptedLegacy.capacityProfile?.exitRouteObservations;
    delete baselineLegacy.capacityProfile?.exitRouteObservations;
    expect(acceptedLegacy).toEqual(baselineLegacy);
  });
});
