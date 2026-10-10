import "../../test-helpers/reviewed-deployment-catalog.test-support";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  SUPPLY_ATTRIBUTION_CAPTURE_BUDGET,
  SUPPLY_ATTRIBUTION_GENERATION_MAX_BYTES,
  SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_ASSETS,
  createSupplyAttributionJournalV1,
  type SupplyAttributionJournalV1Payload,
} from "@shared/lib/safety-score-v9-supply-attribution-journal";
import {
  normalizeFixedInput,
  type ReportCardsFixedInput,
} from "../report-cards-fixed-input";
import {
  deriveReviewedDeploymentUnitPartition,
  type ReviewedDeploymentSupplyObservation,
} from "../safety-score-v9/supply-attribution-contract";
import {
  deriveXautRepresentationGroupSupplyAttribution,
  XAUT_SUPPLY_ATTRIBUTION_MAX_AGE_SEC,
  type XautLockMintObservation,
} from "../safety-score-v9/xaut-supply-attribution-contract";
import {
  applySafetyScoreV9SupplyAttributionGeneration,
  computeSafetyScoreV9SupplyAttributionGenerationId,
  createSafetyScoreV9SupplyAttributionGeneration,
  diagnoseSafetyScoreV9SupplyAttributionGenerationCompatibility,
  isSafetyScoreV9SupplyAttributionGenerationCompatible,
  nextSafetyScoreV9SupplyAttributionDueAtSec,
  parseSafetyScoreV9SupplyAttributionGeneration,
  serializeSafetyScoreV9SupplyAttributionGeneration,
} from "../safety-score-v9/supply-attribution-generation";
import {
  makeV9FixedInput,
  v9TestClockSec,
  makeWmDeploymentObservations,
  makeXautObservation,
  patchXautObservation,
} from "../../test-helpers/v9-fixed-input";
import { captureSafetyScoreV9SupplyAttribution } from "../safety-score-v9/supply-attribution-capture";
import { safetyScoreV9SupplyAttributionExpectedAssetIds } from "../safety-score-v9/supply-attribution";
import { runBudgetedSupplyAttributionAssets } from "../safety-score-v9/supply-attribution-capture-budget";
import { sleepWithSignal } from "../abort";
import { SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_REFRESH_INTERVAL_SEC } from "@shared/lib/cron-jobs";
import * as wmObserver from "../safety-score-v9/wm-supply-observer";
import * as xautObserver from "../safety-score-v9/xaut-supply-observer";
import * as economicObserver from "../safety-score-v9/economic-supply-observer";
import type { SupplyAttributionAttemptDiagnostic } from "@shared/types/safety-score-v9-supply-attribution";

const SOURCE_CLOCK_SEC = v9TestClockSec();
const SOURCE_AGGREGATE_USD = 2_480_000_000;
const TARGET_AGGREGATE_USD = 3_000_000_000;

function withClockAndAggregate(
  input: ReportCardsFixedInput,
  clockSec: number,
  aggregateSupplyUsd: number,
): ReportCardsFixedInput {
  const {
    baseInputGenerationId: _baseInputGenerationId,
    ...withoutBaseIdentity
  } = input;
  return normalizeFixedInput({
    ...withoutBaseIdentity,
    capturedAt: new Date(clockSec * 1_000).toISOString(),
    sourceGeneration: `report-cards:v8:fixture:${clockSec}`,
    clockSec,
    updatedAt: clockSec,
    inputFreshness: {
      dexLiquidity: {
        ...input.inputFreshness.dexLiquidity,
        ageSeconds:
          clockSec - input.inputFreshness.dexLiquidity.updatedAt!,
      },
      redemptionBackstops: input.inputFreshness.redemptionBackstops,
    },
    aggregateCirculatingById: {
      ...input.aggregateCirculatingById,
      "xaut-tether": {
        circulating: { peggedGOLD: aggregateSupplyUsd },
        observedAtSec: clockSec,
      },
    },
  });
}

function xautObservation(): XautLockMintObservation {
  return makeXautObservation({ clockSec: SOURCE_CLOCK_SEC });
}

function acceptedGenerationFixture(fixedInput: ReportCardsFixedInput) {
  const attribution =
    deriveXautRepresentationGroupSupplyAttribution({
      aggregateSupplyUsd: SOURCE_AGGREGATE_USD,
      registryFingerprint: fixedInput.registryFingerprint,
      scoringClockSec: fixedInput.clockSec,
      observation: xautObservation(),
    })!;
  const completedAtSec = SOURCE_CLOCK_SEC + 10;
  const contentSha256 = sha256Hex(
    stableJsonStringifyV1(attribution),
  );
  const journalPayload: SupplyAttributionJournalV1Payload = {
    schemaVersion: 1,
    lane: "supply-attribution",
    assetId: "xaut-tether",
    attemptId: "supply-attribution:generation-fixture",
    sourceId: "xaut.canonical-lock-mint-group-partition.v2",
    sourceOriginClass: "issuer-disclosure-plus-onchain",
    baseInputGenerationId: fixedInput.baseInputGenerationId,
    sourceGeneration: fixedInput.sourceGeneration,
    registryFingerprint: fixedInput.registryFingerprint,
    routeInventoryDigest: attribution.routeInventoryDigest,
    attemptCode: "supply-attribution.collector.attempted",
    admissionCode: "supply-attribution.admission.accepted",
    fallbackCode: "supply-attribution.fallback.not-used",
    attemptedAtSec: completedAtSec - 1,
    completedAtSec,
    scoringClockSec: fixedInput.clockSec,
    sourceObservedAtSec: attribution.observedAtSec,
    failedRouteId: null,
    contentSha256,
  };
  return { fixedInput, attribution, completedAtSec, journalPayload };
}

function createAcceptedGenerationFromFixture(
  fixture: ReturnType<typeof acceptedGenerationFixture>,
  journalOverrides: Partial<SupplyAttributionJournalV1Payload> = {},
) {
  const journal = createSupplyAttributionJournalV1({
    ...fixture.journalPayload,
    ...journalOverrides,
  });
  return createSafetyScoreV9SupplyAttributionGeneration({
    fixedInput: fixture.fixedInput,
    capturedAtSec: fixture.completedAtSec,
    capture: {
      captureClockSec: fixture.fixedInput.clockSec,
      expectedAssetIds: ["xaut-tether"],
      attributionById: { "xaut-tether": fixture.attribution },
      journalRecords: [journal],
    },
  });
}

// Production XAUT observations are pinned to a finalized Ethereum block and are
// already 780-1150s old when the generation is published, while wM/Centrifuge
// route reads land within ~30s of capture.
const XAUT_OBSERVATION_LAG_SEC = 1_000;
// Beyond anything production emits: the only lag that can still age past XAUT's
// 3600s override while the generation itself stays inside its 1800s window.
const XAUT_STALE_OBSERVATION_LAG_SEC = 3_000;
const WM_SOURCE_AGGREGATE_USD = 87_020_618.58982982;
const WM_TARGET_AGGREGATE_USD = 91_400_000.25;

const WM_RAW_SUPPLY_BY_ROUTE: Record<string, string> = {
  "ethereum:0x437cc33344a0b27a429f795ff6b469c72698b291": "86712798085682",
  "arbitrum:0x437cc33344a0b27a429f795ff6b469c72698b291": "88459935972",
  "base:0x437cc33344a0b27a429f795ff6b469c72698b291": "70802728527",
  "plume:0x437cc33344a0b27a429f795ff6b469c72698b291": "0",
  "solana:mzeroXDoBpRVhnEXBra27qzAMdxgpWVY3DzQW7xMVJp": "247794997129",
};

const WM_BLOCK_TIME_OFFSET_BY_CHAIN: Record<string, number> = {
  ethereum: -25,
  arbitrum: -18,
  base: -17,
  plume: -16,
  solana: -29,
};

/** Every deployment must remain current; the oldest block owns admission age. */
const WM_FRESHNESS_OFFSET_SEC = Math.min(
  ...Object.values(WM_BLOCK_TIME_OFFSET_BY_CHAIN),
);
const REVIEWED_DEPLOYMENT_MAX_AGE_SEC = 1_800;

function wmObservations(): ReviewedDeploymentSupplyObservation[] {
  return makeWmDeploymentObservations({
    clockSec: SOURCE_CLOCK_SEC,
    rawSupplyByRoute: WM_RAW_SUPPLY_BY_ROUTE,
    blockTimeByChain: Object.fromEntries(
      Object.entries(WM_BLOCK_TIME_OFFSET_BY_CHAIN).map(([chainId, offset]) => [chainId, SOURCE_CLOCK_SEC + offset]),
    ),
  });
}

/** Adds wM to the expected inventory by removing its upstream chain supply. */
function withWmAggregate(
  input: ReportCardsFixedInput,
  wmAggregateSupplyUsd: number,
): ReportCardsFixedInput {
  const {
    baseInputGenerationId: _baseInputGenerationId,
    ...withoutBaseIdentity
  } = input;
  const { "wm-m0": _wmChainSupply, ...chainCirculatingById } =
    input.chainCirculatingById;
  return normalizeFixedInput({
    ...withoutBaseIdentity,
    chainCirculatingById,
    aggregateCirculatingById: {
      ...input.aggregateCirculatingById,
      "wm-m0": {
        circulating: { peggedUSD: wmAggregateSupplyUsd },
        observedAtSec: input.clockSec,
      },
    },
  });
}

function laggedXautObservation(lagSec: number): XautLockMintObservation {
  const observation = xautObservation();
  return patchXautObservation(observation, {
    blockTimeSec: SOURCE_CLOCK_SEC - lagSec,
    disclosure: {
      sourceTimestampSec: SOURCE_CLOCK_SEC - lagSec - 100,
    },
  });
}

function createCoTenantGeneration(
  fixedInput: ReportCardsFixedInput,
  xautObservationLagSec = XAUT_OBSERVATION_LAG_SEC,
) {
  const xautAttribution =
    deriveXautRepresentationGroupSupplyAttribution({
      aggregateSupplyUsd: SOURCE_AGGREGATE_USD,
      registryFingerprint: fixedInput.registryFingerprint,
      scoringClockSec: fixedInput.clockSec,
      observation: laggedXautObservation(xautObservationLagSec),
    })!;
  const wmAttribution = deriveReviewedDeploymentUnitPartition({
    assetId: "wm-m0",
    aggregateSupplyUsd: WM_SOURCE_AGGREGATE_USD,
    registryFingerprint: fixedInput.registryFingerprint,
    scoringClockSec: fixedInput.clockSec,
    observations: wmObservations(),
  })!;
  const completedAtSec = SOURCE_CLOCK_SEC + 10;
  const journalFor = (
    assetId: string,
    sourceId: SupplyAttributionJournalV1Payload["sourceId"],
    sourceOriginClass: SupplyAttributionJournalV1Payload["sourceOriginClass"],
    attribution: { routeInventoryDigest: string; observedAtSec: number },
  ) =>
    createSupplyAttributionJournalV1({
      schemaVersion: 1,
      lane: "supply-attribution",
      assetId,
      attemptId: `supply-attribution:co-tenant-${assetId}`,
      sourceId,
      sourceOriginClass,
      baseInputGenerationId: fixedInput.baseInputGenerationId,
      sourceGeneration: fixedInput.sourceGeneration,
      registryFingerprint: fixedInput.registryFingerprint,
      routeInventoryDigest: attribution.routeInventoryDigest,
      attemptCode: "supply-attribution.collector.attempted",
      admissionCode: "supply-attribution.admission.accepted",
      fallbackCode: "supply-attribution.fallback.not-used",
      attemptedAtSec: completedAtSec - 1,
      completedAtSec,
      scoringClockSec: fixedInput.clockSec,
      sourceObservedAtSec: attribution.observedAtSec,
      failedRouteId: null,
      contentSha256: sha256Hex(stableJsonStringifyV1(attribution)),
    });

  return createSafetyScoreV9SupplyAttributionGeneration({
    fixedInput,
    capturedAtSec: completedAtSec,
    capture: {
      captureClockSec: fixedInput.clockSec,
      expectedAssetIds: ["wm-m0", "xaut-tether"],
      attributionById: {
        "wm-m0": wmAttribution,
        "xaut-tether": xautAttribution,
      },
      journalRecords: [
        journalFor(
          "wm-m0",
          "wm.reviewed-deployment-unit-partition.v1",
          "onchain-observation",
          wmAttribution,
        ),
        journalFor(
          "xaut-tether",
          "xaut.canonical-lock-mint-group-partition.v2",
          "issuer-disclosure-plus-onchain",
          xautAttribution,
        ),
      ],
    },
  });
}

type FixtureCache = {
  acceptedFixture: ReturnType<typeof acceptedGenerationFixture>;
  acceptedGeneration: ReturnType<
    typeof createSafetyScoreV9SupplyAttributionGeneration
  >;
  target: ReportCardsFixedInput;
  staleTarget: ReportCardsFixedInput;
  coTenantStaleGeneration: ReturnType<typeof createCoTenantGeneration>;
  coTenantGeneration: ReturnType<typeof createCoTenantGeneration>;
  coTenantAtXautBoundary: ReportCardsFixedInput;
  coTenantPastXautBoundary: ReportCardsFixedInput;
  coTenantAtWmBoundary: ReportCardsFixedInput;
  coTenantPastWmBoundary: ReportCardsFixedInput;
};

let fixtures: FixtureCache;

function buildFixtureCache(): FixtureCache {
  const { baseInputGenerationId: _baseInputGenerationId, ...wmInput } =
    makeV9FixedInput({ assetId: "wm-m0", clockSec: SOURCE_CLOCK_SEC });
  const input = normalizeFixedInput({
    ...wmInput,
    // XAUT-only generation fixtures need a complete wM provider inventory;
    // one positive Ethereum subtotal no longer suppresses its census.
    chainCirculatingById: {
      ...wmInput.chainCirculatingById,
      "wm-m0": {
        ...wmInput.chainCirculatingById["wm-m0"],
        Arbitrum: { current: 0, circulatingPrevDay: 0, circulatingPrevWeek: 0, circulatingPrevMonth: 0 },
        Base: { current: 0, circulatingPrevDay: 0, circulatingPrevWeek: 0, circulatingPrevMonth: 0 },
        Plume: { current: 0, circulatingPrevDay: 0, circulatingPrevWeek: 0, circulatingPrevMonth: 0 },
        Solana: { current: 0, circulatingPrevDay: 0, circulatingPrevWeek: 0, circulatingPrevMonth: 0 },
      },
    },
    activeAssetIds: ["wm-m0", "xaut-tether"],
    resolvedBlacklistStatuses: { "wm-m0": false, "xaut-tether": false },
    dexLiqMap: {
      ...wmInput.dexLiqMap,
      "xaut-tether": makeV9FixedInput({ assetId: "xaut-tether", clockSec: SOURCE_CLOCK_SEC }).dexLiqMap["xaut-tether"]!,
    },
  });
  const source = withClockAndAggregate(
    input,
    SOURCE_CLOCK_SEC,
    SOURCE_AGGREGATE_USD,
  );
  const acceptedFixture = acceptedGenerationFixture(source);
  const coTenantSource = withWmAggregate(
    source,
    WM_SOURCE_AGGREGATE_USD,
  );
  const xautBoundaryClockSec =
    SOURCE_CLOCK_SEC +
    XAUT_SUPPLY_ATTRIBUTION_MAX_AGE_SEC -
    XAUT_STALE_OBSERVATION_LAG_SEC;
  const wmBoundaryClockSec =
    SOURCE_CLOCK_SEC +
    REVIEWED_DEPLOYMENT_MAX_AGE_SEC +
    WM_FRESHNESS_OFFSET_SEC;
  const coTenantTarget = (
    clockSec: number,
  ): ReportCardsFixedInput =>
    withWmAggregate(
      withClockAndAggregate(source, clockSec, TARGET_AGGREGATE_USD),
      WM_TARGET_AGGREGATE_USD,
    );

  return {
    acceptedFixture,
    acceptedGeneration: createAcceptedGenerationFromFixture(acceptedFixture),
    target: withClockAndAggregate(
      source,
      SOURCE_CLOCK_SEC + 15 * 60,
      TARGET_AGGREGATE_USD,
    ),
    staleTarget: withClockAndAggregate(
      source,
      SOURCE_CLOCK_SEC + 10 + 45 * 60 + 1,
      TARGET_AGGREGATE_USD,
    ),
    coTenantStaleGeneration: createCoTenantGeneration(
      coTenantSource,
      XAUT_STALE_OBSERVATION_LAG_SEC,
    ),
    coTenantGeneration: createCoTenantGeneration(coTenantSource),
    coTenantAtXautBoundary: coTenantTarget(xautBoundaryClockSec),
    coTenantPastXautBoundary: coTenantTarget(xautBoundaryClockSec + 1),
    coTenantAtWmBoundary: coTenantTarget(wmBoundaryClockSec),
    coTenantPastWmBoundary: coTenantTarget(wmBoundaryClockSec + 1),
  };
}

describe("isolated Safety Score V9 supply attribution generation", () => {
  beforeAll(() => {
    fixtures = buildFixtureCache();
  });

  it("round-trips a complete content-addressed generation", () => {
    const generation = fixtures.acceptedGeneration;
    const serialized = serializeSafetyScoreV9SupplyAttributionGeneration(generation);
    expect(
      parseSafetyScoreV9SupplyAttributionGeneration(
        serialized,
      ),
    ).toEqual(generation);
    expect(generation.expectedAssetIds).toEqual(["xaut-tether"]);
    expect(generation.observedAssetIds).toEqual(["xaut-tether"]);
  });

  it("rejects malformed serialized generation cache values", () => {
    expect(() =>
      parseSafetyScoreV9SupplyAttributionGeneration("{"),
    ).toThrow("Malformed supply attribution generation cache");
    expect(() => parseSafetyScoreV9SupplyAttributionGeneration(" ".repeat(SUPPLY_ATTRIBUTION_GENERATION_MAX_BYTES + 1))).toThrow("Supply attribution generation cache value is oversized");
  });

  function rejectedCohort(count: number) {
    const ids = Array.from({ length: count }, (_, index) => `asset-${String(index).padStart(3, "0")}`);
    const payload = {
      ...fixtures.acceptedGeneration,
      expectedAssetIds: ids, observedAssetIds: ids, acceptedAssetIds: [],
      rejectedAssetIds: ids, attributionById: {},
      outcomesById: Object.fromEntries(ids.map(id => [id, {
        status: "rejected" as const,
        rejectionCode: "deployment-state-unavailable" as const,
        failedRouteId: null,
        journalId: fixtures.acceptedGeneration.outcomesById["xaut-tether"].journalId,
      }])),
    };
    const { generationId: _id, ...content } = payload;
    return { ...content, generationId: computeSafetyScoreV9SupplyAttributionGenerationId(content) };
  }

  it("round-trips every asset at the shared cohort bound and rejects bound plus one", () => {
    const generation = rejectedCohort(SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_ASSETS);
    const parsed = parseSafetyScoreV9SupplyAttributionGeneration(
      serializeSafetyScoreV9SupplyAttributionGeneration(generation),
    );
    expect(parsed.observedAssetIds).toHaveLength(SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_ASSETS);
    expect(parsed.rejectedAssetIds).toEqual(parsed.expectedAssetIds);
    expect(() => parseSafetyScoreV9SupplyAttributionGeneration(
      rejectedCohort(SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_ASSETS + 1),
    )).toThrow();
  });

  it("admits an expanded payload but rejects object and wire byte overflow", () => {
    const { generationId: _id, ...payload } = fixtures.acceptedGeneration;
    const content = { ...payload, sourceGeneration: "s".repeat(200 * 1_024) };
    const generation = { ...content, generationId: computeSafetyScoreV9SupplyAttributionGenerationId(content) };
    expect(parseSafetyScoreV9SupplyAttributionGeneration(
      serializeSafetyScoreV9SupplyAttributionGeneration(generation),
    ).sourceGeneration).toBe(content.sourceGeneration);
    const oversized = { ...content, sourceGeneration: "s".repeat(SUPPLY_ATTRIBUTION_GENERATION_MAX_BYTES) };
    expect(() => parseSafetyScoreV9SupplyAttributionGeneration({
      ...oversized, generationId: computeSafetyScoreV9SupplyAttributionGenerationId(oversized),
    })).toThrow(`exceeds ${SUPPLY_ATTRIBUTION_GENERATION_MAX_BYTES} bytes`);
  });

  it("runs assets serially and isolates a slow asset without dropping its peers", async () => {
    vi.useFakeTimers();
    try {
      let active = 0, maximum = 0;
      const assets = Array.from({ length: SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_ASSETS }, (_, index) => index);
      const pending = runBudgetedSupplyAttributionAssets(assets, async (index, signal) => {
        active++; maximum = Math.max(maximum, active);
        try {
          await sleepWithSignal(index === 0 ? SUPPLY_ATTRIBUTION_CAPTURE_BUDGET.assetTimeoutMs * 2 : 10, signal);
          return index;
        } finally { active--; }
      });
      await vi.runAllTimersAsync();
      const results = await pending;
      expect(maximum).toBe(1);
      expect(active).toBe(0);
      expect(results).toHaveLength(assets.length);
      expect(results[0]).toEqual({ status: "rejected", reason: "asset-timeout" });
      expect(results.slice(1).every(result => result.status === "completed")).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("rotates execution deterministically while preserving original result order", async () => {
    const assets = ["a", "b", "c", "d"];
    const orders: string[][] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const order: string[] = [];
      const results = await runBudgetedSupplyAttributionAssets(assets, async asset => {
        order.push(asset);
        return asset;
      }, { startIndex: 6 });
      orders.push(order);
      expect(results).toEqual(assets.map(value => ({ status: "completed", value })));
    }
    expect(orders).toEqual([["c", "d", "a", "b"], ["c", "d", "a", "b"]]);
  });

  it("gives all ten cold assets first opportunity over consecutive buckets within the same deadline", async () => {
    vi.useFakeTimers();
    try {
      const assets = Array.from({ length: 10 }, (_, index) => index);
      const admitted = new Set<number>();
      let active = 0, maximum = 0;
      for (let bucket = 100; bucket < 110; bucket++) {
        const startedAtMs = Date.now();
        const observed: number[] = [];
        const pending = runBudgetedSupplyAttributionAssets(assets, async (asset, signal, deadlineMs) => {
          active++; maximum = Math.max(maximum, active);
          observed.push(asset);
          expect(deadlineMs).toBe(startedAtMs + 100);
          try {
            // Cold observers all fit when first; a second observer consumes
            // the remainder, recreating a capture that admits only one asset.
            await sleepWithSignal(60, signal);
            return asset;
          } finally { active--; }
        }, {
          startIndex: bucket,
          executionWindow: {
            slotStartedAtSec: Math.floor(startedAtMs / 1_000),
            deadlineMs: startedAtMs + SUPPLY_ATTRIBUTION_CAPTURE_BUDGET.publicationReserveMs + 100,
            minimumRemainingMs: 0,
          },
        });
        await vi.runAllTimersAsync();
        const results = await pending;
        expect(observed).toEqual([bucket % 10, (bucket + 1) % 10]);
        expect(results[bucket % 10]).toEqual({ status: "completed", value: bucket % 10 });
        expect(results[(bucket + 1) % 10]).toEqual({ status: "rejected", reason: "asset-timeout" });
        expect(results.filter(result => result.status === "completed")).toHaveLength(1);
        expect(results.filter(result => result.status === "rejected" && result.reason === "capture-window-exhausted")).toHaveLength(8);
        admitted.add(bucket % 10);
        expect(Date.now() - startedAtMs).toBe(100);
        expect(active).toBe(0);
      }
      expect(maximum).toBe(1);
      expect([...admitted].sort((a, b) => a - b)).toEqual(assets);
    } finally { vi.useRealTimers(); }
  });

  it("rejects invalid rotation indexes and handles an empty cohort", async () => {
    const observe = vi.fn();
    for (const startIndex of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(runBudgetedSupplyAttributionAssets([0], observe, { startIndex }))
        .rejects.toThrow("nonnegative safe integer");
    }
    expect(await runBudgetedSupplyAttributionAssets([], observe, { startIndex: Number.MAX_SAFE_INTEGER })).toEqual([]);
    expect(observe).not.toHaveBeenCalled();
  });

  it("admits a wM maturity wait beyond the default asset timeout and exposes the clipped child deadline", async () => {
    vi.useFakeTimers();
    const startedAtMs = Date.now();
    try {
      const deadlines: number[] = [];
      const pending = runBudgetedSupplyAttributionAssets(["ordinary", "wm-m0"], async (asset, signal, deadlineMs) => {
        deadlines.push(deadlineMs);
        await sleepWithSignal(asset === "wm-m0" ? 46_000 : 1_000, signal);
        return asset;
      }, {
        assetTimeoutMs: asset => asset === "wm-m0"
          ? SUPPLY_ATTRIBUTION_CAPTURE_BUDGET.wmAssetTimeoutMs
          : SUPPLY_ATTRIBUTION_CAPTURE_BUDGET.assetTimeoutMs,
        executionWindow: { slotStartedAtSec: Math.floor(startedAtMs / 1_000), deadlineMs: startedAtMs + 80_000, minimumRemainingMs: 0 },
      });
      await vi.runAllTimersAsync();
      expect(await pending).toEqual([
        { status: "completed", value: "ordinary" },
        { status: "completed", value: "wm-m0" },
      ]);
      expect(deadlines).toEqual([startedAtMs + 30_000, startedAtMs + 65_000]);
      expect(Date.now() - startedAtMs).toBe(47_000);
    } finally { vi.useRealTimers(); }
  });

  it("names window exhaustion for every unattemptable asset", async () => {
    vi.useFakeTimers();
    try {
      const pending = runBudgetedSupplyAttributionAssets([0, 1, 2, 3], async (_asset, signal) => {
        await sleepWithSignal(SUPPLY_ATTRIBUTION_CAPTURE_BUDGET.assetTimeoutMs, signal);
        return 1;
      }, { executionWindow: {
        slotStartedAtSec: Math.floor(Date.now() / 1_000),
        deadlineMs: Date.now() + SUPPLY_ATTRIBUTION_CAPTURE_BUDGET.publicationReserveMs + 100,
        minimumRemainingMs: 0,
      } });
      await vi.runAllTimersAsync();
      expect(await pending).toEqual([
        { status: "rejected", reason: "asset-timeout" },
        { status: "rejected", reason: "capture-window-exhausted" },
        { status: "rejected", reason: "capture-window-exhausted" },
        { status: "rejected", reason: "capture-window-exhausted" },
      ]);
    } finally { vi.useRealTimers(); }
  });

  it("does not turn parent cancellation into a published per-asset rejection", async () => {
    const controller = new AbortController();
    const error = new Error("lease-lost");
    await expect(runBudgetedSupplyAttributionAssets([0, 1], async () => {
      controller.abort(error);
      throw error;
    }, { signal: controller.signal })).rejects.toBe(error);
    await expect(runBudgetedSupplyAttributionAssets(
      Array.from({ length: SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_ASSETS + 1 }),
      async () => 0,
    )).rejects.toThrow("exceeds the bounded cohort");
  });

  it("publishes an accepted co-tenant with an exact rejection for the timed-out asset", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SOURCE_CLOCK_SEC * 1_000);
    try {
      const input = withWmAggregate(fixtures.acceptedFixture.fixedInput, WM_SOURCE_AGGREGATE_USD);
      const accepted = fixtures.acceptedGeneration.attributionById["xaut-tether"];
      if (accepted.model !== "canonical-lock-mint-group-partition-v2") throw new Error("Expected XAUT fixture");
      vi.spyOn(xautObserver, "observeXautRepresentationGroupSupplyAttributionAttempt")
        .mockResolvedValue({ status: "accepted", attribution: accepted });
      vi.spyOn(wmObserver, "observeWmReviewedDeploymentUnitPartitionAttempt")
        .mockImplementation(async ({ signal }) => {
          await sleepWithSignal(SUPPLY_ATTRIBUTION_CAPTURE_BUDGET.wmAssetTimeoutMs * 2, signal);
          return { status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId: null };
        });
      const pending = captureSafetyScoreV9SupplyAttribution(input, new Map([["ethereum", {
        chainId: "ethereum", chainName: "Ethereum", type: "evm", endpoints: [], explorerUrl: "",
      }]]));
      await vi.runAllTimersAsync();
      const capture = await pending;
      const generation = createSafetyScoreV9SupplyAttributionGeneration({
        fixedInput: input, capture, capturedAtSec: Math.floor(Date.now() / 1_000),
      });
      expect(generation.expectedAssetIds).toEqual(["wm-m0", "xaut-tether"]);
      expect(generation.observedAssetIds).toEqual(generation.expectedAssetIds);
      expect(generation.acceptedAssetIds).toEqual(["xaut-tether"]);
      expect(generation.outcomesById["wm-m0"]).toMatchObject({
        status: "rejected", rejectionCode: "deployment-observation-window-insufficient",
      });
    } finally { vi.restoreAllMocks(); vi.useRealTimers(); }
  });

  it.each([false, true])("retains timed-out prefix diagnostics with bounded hard failure=%s", async hardFailure => {
    vi.useFakeTimers();
    vi.setSystemTime(SOURCE_CLOCK_SEC * 1_000);
    try {
      const input = {
        ...makeV9FixedInput({ assetId: "srusd-reservoir", clockSec: SOURCE_CLOCK_SEC }),
        chainCirculatingById: {},
      };
      const diagnostic: SupplyAttributionAttemptDiagnostic = {
        observer: "layerzero-oft", sourceId: "srusd-ethereum-oft-escrow",
        laneId: "ethereum:berachain", chainId: "ethereum", providerOrigin: "https://rpc.example",
        method: "eth_getLogs", phase: "bootstrap-prefix",
        beforeCursor: "100", afterCursor: "101", targetCursor: "200",
        pinObservedAtSec: SOURCE_CLOCK_SEC, finalizedLagBlocks: 0,
        persisted: true, authenticatedCursorAdvanced: true, incompleteBootstrap: true,
        hardEvidenceFailure: false, failurePredicate: "history-incomplete",
      };
      const onBodyRead = vi.fn();
      vi.spyOn(economicObserver, "observeReviewedEconomicDeploymentPartitionAttempt")
        .mockImplementation(async ({ onDiagnostic, onBodyRead: observeBody, signal }) => {
          onDiagnostic?.(diagnostic);
          observeBody?.({ intakeBytes: 32, declaredBytes: null, outcome: "accepted" });
          if (hardFailure) {
            for (let index = 0; index < 128; index++) {
              onDiagnostic?.({ ...diagnostic, persisted: false, authenticatedCursorAdvanced: false });
            }
            onDiagnostic?.({ ...diagnostic, hardEvidenceFailure: true, failurePredicate: "packet-reconciliation-failed" });
            onDiagnostic?.({ ...diagnostic, persisted: false, authenticatedCursorAdvanced: false });
          }
          await sleepWithSignal(SUPPLY_ATTRIBUTION_CAPTURE_BUDGET.assetTimeoutMs * 2, signal);
          return { status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId: null };
        });
      const pending = captureSafetyScoreV9SupplyAttribution(input, new Map([["ethereum", {
        chainId: "ethereum", chainName: "Ethereum", type: "evm", endpoints: [], explorerUrl: "",
      }]]), undefined, { clockMode: "source", onBodyRead });
      await vi.runAllTimersAsync();
      const capture = await pending;
      expect(onBodyRead).toHaveBeenCalledExactlyOnceWith({
        intakeBytes: 32, declaredBytes: null, outcome: "accepted",
      });
      expect(capture.journalRecords.find(record => record.assetId === "srusd-reservoir")?.diagnosticLeaf)
        .toMatchObject({ predicate: hardFailure ? "packet-reconciliation-failed" : "history-incomplete" });
      const diagnostics = capture.diagnosticsById?.["srusd-reservoir"] ?? [];
      expect(diagnostics).toContainEqual(diagnostic);
      expect(diagnostics.length).toBeLessThanOrEqual(128);
      expect(diagnostics.some(row => row.hardEvidenceFailure)).toBe(hardFailure);
      expect(capture.failureReasonById?.["srusd-reservoir"]).toBe("asset-timeout");
      const generation = createSafetyScoreV9SupplyAttributionGeneration({
        fixedInput: input, capture, capturedAtSec: Math.floor(Date.now() / 1_000),
      });
      expect(generation.outcomesById["srusd-reservoir"]).toMatchObject({
        status: "rejected", captureFailureReason: "asset-timeout", diagnostics,
      });
      expect(parseSafetyScoreV9SupplyAttributionGeneration(
        serializeSafetyScoreV9SupplyAttributionGeneration(generation),
      )).toEqual(generation);
    } finally { vi.restoreAllMocks(); vi.useRealTimers(); }
  });

  it("derives capture rotation from the exact source bucket and keeps retry journal order", async () => {
    vi.useFakeTimers();
    try {
      let order: string[] = [];
      vi.spyOn(wmObserver, "observeWmReviewedDeploymentUnitPartitionAttempt").mockImplementation(async () => {
        order.push("wm-m0");
        return { status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId: null };
      });
      vi.spyOn(xautObserver, "observeXautRepresentationGroupSupplyAttributionAttempt").mockImplementation(async () => {
        order.push("xaut-tether");
        return { status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId: null, rejectedSourceObservedAtSec: null };
      });
      const interval = SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_REFRESH_INTERVAL_SEC;
      const baseBucket = Math.floor(SOURCE_CLOCK_SEC / interval);
      for (let bucket = baseBucket; bucket < baseBucket + 2; bucket++) {
        const input = { ...withWmAggregate(fixtures.acceptedFixture.fixedInput, WM_SOURCE_AGGREGATE_USD), clockSec: bucket * interval };
        for (let retry = 0; retry < 2; retry++) {
          order = [];
          vi.setSystemTime((input.clockSec + 60 + retry) * 1_000);
          const capture = await captureSafetyScoreV9SupplyAttribution(input, new Map([["ethereum", {
            chainId: "ethereum", chainName: "Ethereum", type: "evm", endpoints: [], explorerUrl: "",
          }]]));
          expect(order).toEqual(bucket % 2 === 0 ? ["xaut-tether", "wm-m0"] : ["wm-m0", "xaut-tether"]);
          expect(capture.journalRecords.map(record => record.assetId)).toEqual(["xaut-tether", "wm-m0"]);
        }
      }
    } finally { vi.restoreAllMocks(); vi.useRealTimers(); }
  });

  it("re-derives accepted raw observations against the current aggregate", () => {
    const applied = applySafetyScoreV9SupplyAttributionGeneration(
      fixtures.target,
      fixtures.acceptedGeneration,
    );

    expect(applied.status).toBe("applied");
    if (applied.status !== "applied") throw new Error(applied.reason);
    const attribution =
      applied.fixedInput.safetyScoreV9SupplyAttributionById[
        "xaut-tether"
      ]!;
    expect(attribution.model).toBe(
      "canonical-lock-mint-group-partition-v2",
    );
    if (
      attribution.model !==
      "canonical-lock-mint-group-partition-v2"
    ) {
      throw new Error("Unexpected attribution model");
    }
    expect(
      attribution.canonical.currentSupplyUsd +
        attribution.representationGroup.currentSupplyUsd,
    ).toBeCloseTo(TARGET_AGGREGATE_USD, 6);
  });

  it("drops only the asset whose observation aged out of its own window", () => {
    const generation = fixtures.coTenantStaleGeneration;
    expect(generation.acceptedAssetIds).toEqual([
      "wm-m0",
      "xaut-tether",
    ]);

    const bothFresh = applySafetyScoreV9SupplyAttributionGeneration(
      fixtures.coTenantAtXautBoundary,
      generation,
    );
    expect(bothFresh).toMatchObject({
      status: "applied",
      acceptedAssetIds: ["wm-m0", "xaut-tether"],
      invalidAssetIds: [],
    });

    // The generation is still inside its own freshness window, but XAUT's
    // finalized-block observation is one second past its own bound. wM must
    // keep its attribution.
    const xautAgedOut = applySafetyScoreV9SupplyAttributionGeneration(
      fixtures.coTenantPastXautBoundary,
      generation,
    );
    expect(xautAgedOut).toMatchObject({
      status: "applied",
      generationId: generation.generationId,
      acceptedAssetIds: ["wm-m0"],
      rejectedAssetIds: [],
      invalidAssetIds: ["xaut-tether"],
    });
    if (xautAgedOut.status !== "applied") throw new Error(xautAgedOut.reason);
    expect(
      Object.keys(
        xautAgedOut.fixedInput.safetyScoreV9SupplyAttributionById,
      ),
    ).toEqual(["wm-m0"]);
  });

  it("re-applies generations using every wM leg's 1800s bound while retaining XAUT's override", () => {
    // Owner ruling 2026-07-29: xaut-tether is the only per-asset override.
    expect(XAUT_SUPPLY_ATTRIBUTION_MAX_AGE_SEC).toBe(3_600);

    const generation = fixtures.coTenantGeneration;
    const wmBoundaryClockSec =
      SOURCE_CLOCK_SEC +
      REVIEWED_DEPLOYMENT_MAX_AGE_SEC +
      WM_FRESHNESS_OFFSET_SEC;
    const xautAgeSec =
      wmBoundaryClockSec + 1 - (SOURCE_CLOCK_SEC - XAUT_OBSERVATION_LAG_SEC);
    expect(xautAgeSec).toBeGreaterThan(REVIEWED_DEPLOYMENT_MAX_AGE_SEC);
    expect(xautAgeSec).toBeLessThanOrEqual(
      XAUT_SUPPLY_ATTRIBUTION_MAX_AGE_SEC,
    );

    const atWmBound = applySafetyScoreV9SupplyAttributionGeneration(
      fixtures.coTenantAtWmBoundary,
      generation,
    );
    expect(atWmBound).toMatchObject({
      status: "applied",
      acceptedAssetIds: ["wm-m0", "xaut-tether"],
      invalidAssetIds: [],
    });

    // The oldest wM leg is now 1801s old even though its sibling is younger
    // and within the cross-chain skew budget. A new source clock cannot renew it.
    const pastWmBound = applySafetyScoreV9SupplyAttributionGeneration(
      fixtures.coTenantPastWmBoundary,
      generation,
    );
    expect(pastWmBound).toMatchObject({
      status: "applied",
      acceptedAssetIds: ["xaut-tether"],
      rejectedAssetIds: [],
      invalidAssetIds: ["wm-m0"],
    });
  });

  it("fails closed when a generation ages beyond its observation window", () => {
    const generation = fixtures.acceptedGeneration;
    const applied = applySafetyScoreV9SupplyAttributionGeneration(
      fixtures.staleTarget,
      generation,
    );

    expect(applied).toMatchObject({
      status: "incompatible",
      generationId: generation.generationId,
      reason: "generation-stale",
    });
    expect(
      applied.fixedInput.safetyScoreV9SupplyAttributionById,
    ).toEqual({});
  });

  it("keeps complete generations compatible across the producer schedule beat", () => {
    const generation = fixtures.acceptedGeneration;
    const target = withClockAndAggregate(
      fixtures.acceptedFixture.fixedInput,
      SOURCE_CLOCK_SEC + 39 * 60,
      TARGET_AGGREGATE_USD,
    );

    expect(
      isSafetyScoreV9SupplyAttributionGenerationCompatible(
        target,
        generation,
      ),
    ).toBe(true);
    expect(
      applySafetyScoreV9SupplyAttributionGeneration(
        target,
        generation,
      ),
    ).toMatchObject({
      status: "applied",
      acceptedAssetIds: ["xaut-tether"],
    });
  });

  // A release that edits any registry input rotates the global fingerprint,
  // including for assets the edit never touched. Gating the whole generation on
  // that equality dropped every attribution packet for one publication cycle
  // after each deploy, which published xaut-tether at the 55 control-unverified
  // ceiling instead of its ~78. Per-asset admission already re-derives each
  // stored observation against the live route inventory and identity pins, so
  // a stale global fingerprint is not by itself evidence that a packet is wrong.
  it("applies the verified subset when the expectation set drifts between capture and consume", () => {
    const generation = fixtures.acceptedGeneration;
    const target = withWmAggregate(fixtures.target, WM_TARGET_AGGREGATE_USD);
    expect(generation.expectedAssetIds).toEqual(["xaut-tether"]);
    expect(safetyScoreV9SupplyAttributionExpectedAssetIds(target)).toEqual(["wm-m0", "xaut-tether"]);

    expect(
      diagnoseSafetyScoreV9SupplyAttributionGenerationCompatibility(
        target,
        generation,
      ),
    ).toBeNull();
    const applied = applySafetyScoreV9SupplyAttributionGeneration(target, generation);
    expect(applied).toMatchObject({
      status: "applied",
      acceptedAssetIds: ["xaut-tether"],
      supersededAssetIds: [],
      invalidAssetIds: [],
    });
    expect(Object.keys(applied.fixedInput.safetyScoreV9SupplyAttributionById)).toEqual(["xaut-tether"]);
  });

  it("applies a generation captured under an earlier registry fingerprint", () => {
    const generation = fixtures.acceptedGeneration;
    // A release rotates the fingerprint and the base input together, so drop
    // the derived identity and let normalizeFixedInput re-derive it.
    const {
      baseInputGenerationId: _rotatedBaseInputGenerationId,
      ...withoutBaseIdentity
    } = fixtures.target;
    const rotatedRegistry = normalizeFixedInput({
      ...withoutBaseIdentity,
      registryFingerprint: "f".repeat(64),
    });

    expect(
      diagnoseSafetyScoreV9SupplyAttributionGenerationCompatibility(
        rotatedRegistry,
        generation,
      ),
    ).toBeNull();
    expect(
      applySafetyScoreV9SupplyAttributionGeneration(
        rotatedRegistry,
        generation,
      ),
    ).toMatchObject({
      status: "applied",
      acceptedAssetIds: ["xaut-tether"],
      invalidAssetIds: [],
    });
  });

  it("reports exact compatibility reasons before applying a generation", () => {
    const generation = fixtures.acceptedGeneration;
    // Retire xaut-tether from every per-asset surface so the drifted input
    // stays contract-consistent (the old fixture only touched activeAssetIds,
    // which the input normalizer rejects once it is actually normalized).
    const expectedAssetMismatch = Object.fromEntries(
      Object.entries(fixtures.target).map(([key, value]) => {
        if (Array.isArray(value)) {
          return [key, value.filter((entry) => entry !== "xaut-tether")];
        }
        if (value && typeof value === "object" && "xaut-tether" in value) {
          const { "xaut-tether": _dropped, ...rest } = value as Record<string, unknown>;
          return [key, rest];
        }
        return [key, value];
      // The payload changed, so drop the derived identity and let
      // normalizeFixedInput re-derive it (same pattern as the rotated-registry
      // case above).
      }).filter(([key]) => key !== "baseInputGenerationId"),
    ) as typeof fixtures.target;
    const beforeSourceClock = {
      ...fixtures.target,
      clockSec: generation.sourceClockSec - 1,
    };

    // Expectation drift is handled per asset at apply time, never as a
    // whole-generation incompatibility: an asset that left the expectation
    // set is superseded, while the rest of the generation keeps applying.
    expect(
      diagnoseSafetyScoreV9SupplyAttributionGenerationCompatibility(
        expectedAssetMismatch,
        generation,
      ),
    ).toBeNull();
    expect(
      applySafetyScoreV9SupplyAttributionGeneration(
        expectedAssetMismatch,
        generation,
      ),
    ).toMatchObject({
      status: "applied",
      acceptedAssetIds: [],
      supersededAssetIds: ["xaut-tether"],
    });
    expect(
      diagnoseSafetyScoreV9SupplyAttributionGenerationCompatibility(
        beforeSourceClock,
        generation,
      ),
    ).toBe("source-clock-after-fixed-input");
    expect(
      diagnoseSafetyScoreV9SupplyAttributionGenerationCompatibility(
        fixtures.acceptedFixture.fixedInput,
        generation,
        generation.captureClockSec - 1,
      ),
    ).toBe("capture-clock-after-consumer");
    expect(
      isSafetyScoreV9SupplyAttributionGenerationCompatible(
        expectedAssetMismatch,
        generation,
      ),
    ).toBe(true);
  });

  it("clears attribution when no generation is available", () => {
    const applied = applySafetyScoreV9SupplyAttributionGeneration(
      fixtures.target,
      null,
    );

    expect(applied).toMatchObject({
      status: "unavailable",
      generationId: null,
      reason: "generation-missing",
    });
    expect(
      applied.fixedInput.safetyScoreV9SupplyAttributionById,
    ).toEqual({});
  });
  it.each(["applied", "unavailable", "incompatible"] as const)(
    "shallow-composes %s attribution without copying the authoritative base",
    status => {
      const input = status === "incompatible" ? fixtures.staleTarget : fixtures.target;
      const before = stableJsonStringifyV1(input);
      const result = applySafetyScoreV9SupplyAttributionGeneration(
        input, status === "unavailable" ? null : fixtures.acceptedGeneration,
      );
      expect(result.status).toBe(status);
      expect(result.fixedInput).not.toBe(input);
      for (const key of Object.keys(input) as Array<keyof typeof input>) {
        if (key !== "safetyScoreV9SupplyAttributionById") {
          expect(Reflect.get(result.fixedInput, key)).toBe(input[key]);
        }
      }
      expect(stableJsonStringifyV1(input)).toBe(before);
      expect(result.fixedInput.baseInputGenerationId).toBe(input.baseInputGenerationId);
    },
  );


  // The capture fires on a 15-minute grid (5,20,35,50) positioned so :20 and :50
  // land between the prepare slot and the :22/:52 publication. A cadence at or
  // above one grid step makes every other firing skip on cooldown, which leaves a
  // skipped :20 falling back to a packet from the previous half hour instead of
  // from :05. Both cadences must stay under one grid step.
  it("keeps both capture cadences under one 15-minute grid step", () => {
    const CAPTURE_GRID_STEP_SEC = 15 * 60;
    const accepted = fixtures.acceptedGeneration;
    expect(
      nextSafetyScoreV9SupplyAttributionDueAtSec(accepted),
    ).toBe(accepted.capturedAtSec + 12 * 60);
    expect(
      nextSafetyScoreV9SupplyAttributionDueAtSec(accepted) -
        accepted.capturedAtSec,
    ).toBeLessThan(CAPTURE_GRID_STEP_SEC);
    const {
      generationId: _generationId,
      ...acceptedPayload
    } = accepted;
    const rejectedPayload = {
      ...acceptedPayload,
      acceptedAssetIds: [],
      rejectedAssetIds: ["xaut-tether"],
      attributionById: {},
      outcomesById: {
        "xaut-tether": {
          status: "rejected" as const,
          rejectionCode: "transparency-stale" as const,
          failedRouteId: null,
          journalId: accepted.outcomesById["xaut-tether"]!.journalId,
        },
      },
    };
    const rejected = parseSafetyScoreV9SupplyAttributionGeneration({
      ...rejectedPayload,
      generationId:
        computeSafetyScoreV9SupplyAttributionGenerationId(
          rejectedPayload,
        ),
    });

    expect(
      nextSafetyScoreV9SupplyAttributionDueAtSec(rejected),
    ).toBe(rejected.capturedAtSec + 14 * 60);
    expect(
      nextSafetyScoreV9SupplyAttributionDueAtSec(rejected) -
        rejected.capturedAtSec,
    ).toBeLessThan(CAPTURE_GRID_STEP_SEC);
  });

  it("rejects malformed journal references even when the generation hash is recomputed", () => {
    const accepted = fixtures.acceptedGeneration;
    const { generationId: _generationId, ...payload } = accepted;
    const malformedPayload = {
      ...payload,
      outcomesById: {
        "xaut-tether": {
          ...payload.outcomesById["xaut-tether"]!,
          journalId: "not-a-content-addressed-journal-id",
        },
      },
    };

    expect(() =>
      parseSafetyScoreV9SupplyAttributionGeneration({
        ...malformedPayload,
        generationId:
          computeSafetyScoreV9SupplyAttributionGenerationId(
            malformedPayload,
          ),
      }),
    ).toThrow(/journalId/);
  });

  it("rejects journal provenance that is not bound to the accepted capture", () => {
    const fixture = fixtures.acceptedFixture;
    const mismatches: Array<{
      label: string;
      overrides: Partial<SupplyAttributionJournalV1Payload>;
      error: RegExp;
    }> = [
      {
        label: "base input",
        overrides: {
          baseInputGenerationId:
            `report-cards-input:v1:${"f".repeat(64)}`,
        },
        error: /source identity mismatch/,
      },
      {
        label: "source generation",
        overrides: { sourceGeneration: "report-cards:v8:other" },
        error: /source identity mismatch/,
      },
      {
        label: "registry",
        overrides: { registryFingerprint: "f".repeat(64) },
        error: /source identity mismatch/,
      },
      {
        label: "observer source",
        overrides: {
          sourceId:
            "centrifuge.reviewed-deployment-unit-partition.v1",
          sourceOriginClass: "onchain-observation",
        },
        error: /source identity mismatch/,
      },
      {
        label: "accepted content",
        overrides: { contentSha256: "f".repeat(64) },
        error: /accepted provenance mismatch/,
      },
    ];

    for (const mismatch of mismatches) {
      expect(
        () =>
          createAcceptedGenerationFromFixture(
            fixture,
            mismatch.overrides,
          ),
        mismatch.label,
      ).toThrow(mismatch.error);
    }
  });

  it("rejects an accepted journal without the matching accepted attribution", () => {
    const fixture = fixtures.acceptedFixture;
    const journal = createSupplyAttributionJournalV1(
      fixture.journalPayload,
    );

    expect(() =>
      createSafetyScoreV9SupplyAttributionGeneration({
        fixedInput: fixture.fixedInput,
        capturedAtSec: fixture.completedAtSec,
        capture: {
          captureClockSec: fixture.fixedInput.clockSec,
          expectedAssetIds: ["xaut-tether"],
          attributionById: {},
          journalRecords: [journal],
        },
      }),
    ).toThrow(/journal outcome mismatch/);
  });
});
