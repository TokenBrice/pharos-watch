import { beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
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
  isSafetyScoreV9SupplyAttributionGenerationCadenceDeferred,
  isSafetyScoreV9SupplyAttributionGenerationCompatible,
  nextSafetyScoreV9SupplyAttributionDueAtSec,
  parseSafetyScoreV9SupplyAttributionGeneration,
  serializeSafetyScoreV9SupplyAttributionGeneration,
} from "../safety-score-v9/supply-attribution-generation";
import {
  createSafetyScoreV9FullRegistryInput,
  FULL_REGISTRY_CLOCK_SEC,
} from "./fixtures/safety-score-v9-full-registry-input";
import {
  makeWmDeploymentObservations,
  makeXautObservation,
  patchXautObservation,
} from "../../test-helpers/v9-fixed-input";

// Mirrors the full-registry input fixture's own clock: this suite re-clocks that
// input, so a source clock behind the fixture's own DEX observation would
// re-derive a negative `inputFreshness.dexLiquidity.ageSeconds`. Both now derive
// from `v9TestClockSec()`, so they advance together. Every offset below is
// relative, so the timeline shifts intact.
const SOURCE_CLOCK_SEC = FULL_REGISTRY_CLOCK_SEC;
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

/** wM's attribution observes at its latest route block time. */
const WM_OBSERVED_OFFSET_SEC = Math.max(
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
  const fullRegistryInput = createSafetyScoreV9FullRegistryInput();
  const source = withClockAndAggregate(
    fullRegistryInput,
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
    WM_OBSERVED_OFFSET_SEC;
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
    expect([generation.generationId, new TextEncoder().encode(serialized).byteLength, sha256Hex(serialized)]).toEqual([
      "safety-score-v9-supply-attribution:v1:3fded246844327e7cbc3b769a08e934231ae78c8037df24b755def0f1b7e01fa",
      3_867,
      "52596ed4490813e4f6fe7c599d1c63e4f2e2fdeae787399c38df0d97ca3b72ec",
    ]);
    expect(generation.expectedAssetIds).toEqual(["xaut-tether"]);
    expect(generation.observedAssetIds).toEqual(["xaut-tether"]);
  });

  it("rejects malformed serialized generation cache values", () => {
    expect(() =>
      parseSafetyScoreV9SupplyAttributionGeneration("{"),
    ).toThrow("Malformed supply attribution generation cache");
    expect(() => parseSafetyScoreV9SupplyAttributionGeneration(" ".repeat(128 * 1_024 + 1))).toThrow("Supply attribution generation cache value is oversized");
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

  it("keeps XAUT past 1800s while co-tenants stay on the 1800s bound", () => {
    // Owner ruling 2026-07-29: xaut-tether is the only per-asset override.
    expect(XAUT_SUPPLY_ATTRIBUTION_MAX_AGE_SEC).toBe(3_600);

    const generation = fixtures.coTenantGeneration;
    const wmBoundaryClockSec =
      SOURCE_CLOCK_SEC +
      REVIEWED_DEPLOYMENT_MAX_AGE_SEC +
      WM_OBSERVED_OFFSET_SEC;
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

    // One second later wM's own 1800s bound expires while XAUT, whose
    // production-shaped observation is already older, survives on its override.
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
    const generation = {
      ...fixtures.acceptedGeneration,
      // The producer captured under a smaller expectation set (co-tenants had
      // upstream chain rows then); by consume time they lost them and joined
      // the expectation. The stored XAUT packet must still apply.
      expectedAssetIds: ["xaut-tether"],
      observedAssetIds: ["xaut-tether"],
    };

    expect(
      diagnoseSafetyScoreV9SupplyAttributionGenerationCompatibility(
        fixtures.target,
        generation,
      ),
    ).toBeNull();
    expect(
      applySafetyScoreV9SupplyAttributionGeneration(fixtures.target, generation),
    ).toMatchObject({
      status: "applied",
      acceptedAssetIds: ["xaut-tether"],
      supersededAssetIds: [],
      invalidAssetIds: [],
    });
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

  it("classifies only same-input complete future generations as cadence deferred", () => {
    const generation = fixtures.acceptedGeneration;

    expect(
      applySafetyScoreV9SupplyAttributionGeneration(
        fixtures.acceptedFixture.fixedInput,
        generation,
      ),
    ).toMatchObject({
      status: "incompatible",
      reason: "captured-after-consumer",
    });
    expect(
      isSafetyScoreV9SupplyAttributionGenerationCadenceDeferred(
        fixtures.acceptedFixture.fixedInput,
        generation,
      ),
    ).toBe(true);
    expect(
      isSafetyScoreV9SupplyAttributionGenerationCadenceDeferred(
        fixtures.target,
        generation,
      ),
    ).toBe(false);
    expect(
      isSafetyScoreV9SupplyAttributionGenerationCadenceDeferred(
        fixtures.staleTarget,
        generation,
      ),
    ).toBe(false);
  });

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
