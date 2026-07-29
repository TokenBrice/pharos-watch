import { describe, expect, it } from "vitest";
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
  buildReviewedDeploymentRouteInventory,
  deriveReviewedDeploymentUnitPartition,
  expectedWmDeploymentIdentity,
  type ReviewedDeploymentSupplyObservation,
} from "../safety-score-v9-supply-attribution-contract";
import {
  buildXautTransparencySource,
  deriveXautRepresentationGroupSupplyAttribution,
  XAUT0_ADAPTER_ADDRESS,
  XAUT0_ADAPTER_IMPLEMENTATION_ADDRESS,
  XAUT0_ADAPTER_IMPLEMENTATION_CODE_SHA256,
  XAUT0_ADAPTER_RUNTIME_CODE_SHA256,
  XAUT0_LAYERZERO_ENDPOINT_ADDRESS,
  XAUT_CANONICAL_IMPLEMENTATION_ADDRESS,
  XAUT_CANONICAL_IMPLEMENTATION_CODE_SHA256,
  XAUT_CANONICAL_RUNTIME_CODE_SHA256,
  XAUT_CANONICAL_TOKEN_ADDRESS,
  XAUT_TRANSPARENCY_SOURCE_ID,
  XAUT_TREASURY_ADDRESS,
  type XautLockMintObservation,
} from "../safety-score-v9-xaut-supply-attribution-contract";
import {
  applySafetyScoreV9SupplyAttributionGeneration,
  computeSafetyScoreV9SupplyAttributionGenerationId,
  createSafetyScoreV9SupplyAttributionGeneration,
  nextSafetyScoreV9SupplyAttributionDueAtSec,
  parseSafetyScoreV9SupplyAttributionGeneration,
  serializeSafetyScoreV9SupplyAttributionGeneration,
} from "../safety-score-v9-supply-attribution-generation";
import { createSafetyScoreV9FullRegistryInput } from "./fixtures/safety-score-v9-full-registry-input";

const SOURCE_CLOCK_SEC = 1_785_283_200;
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

function sourceFixedInput(): ReportCardsFixedInput {
  return withClockAndAggregate(
    createSafetyScoreV9FullRegistryInput(),
    SOURCE_CLOCK_SEC,
    SOURCE_AGGREGATE_USD,
  );
}

function xautObservation(): XautLockMintObservation {
  return {
    chainId: "ethereum",
    canonicalTokenAddress: XAUT_CANONICAL_TOKEN_ADDRESS,
    adapterAddress: XAUT0_ADAPTER_ADDRESS,
    decimals: 6,
    canonicalTotalSupplyRaw: "707747089000",
    treasuryAddress: XAUT_TREASURY_ADDRESS,
    treasuryBalanceRaw: "94923429468",
    adapterLockedSupplyRaw: "29720802896",
    blockNumber: 25_601_844,
    blockTimeSec: SOURCE_CLOCK_SEC - 100,
    blockHash: `0x${"ab".repeat(32)}`,
    canonicalRuntimeCodeSha256:
      XAUT_CANONICAL_RUNTIME_CODE_SHA256,
    canonicalImplementationAddress:
      XAUT_CANONICAL_IMPLEMENTATION_ADDRESS,
    canonicalImplementationCodeSha256:
      XAUT_CANONICAL_IMPLEMENTATION_CODE_SHA256,
    adapterRuntimeCodeSha256: XAUT0_ADAPTER_RUNTIME_CODE_SHA256,
    adapterImplementationAddress:
      XAUT0_ADAPTER_IMPLEMENTATION_ADDRESS,
    adapterImplementationCodeSha256:
      XAUT0_ADAPTER_IMPLEMENTATION_CODE_SHA256,
    adapterTokenAddress: XAUT_CANONICAL_TOKEN_ADDRESS,
    adapterEndpointAddress: XAUT0_LAYERZERO_ENDPOINT_ADDRESS,
    disclosure: {
      sourceId: XAUT_TRANSPARENCY_SOURCE_ID,
      sourceConfigDigest: buildXautTransparencySource()!.configDigest,
      sourceTimestampSec: SOURCE_CLOCK_SEC - 200,
      responseSha256: "c".repeat(64),
      totalAuthorizedRaw: "707747089000",
      notIssuedRaw: "94923429468",
      quarantinedRaw: "0",
    },
  };
}

function acceptedGenerationFixture() {
  const fixedInput = sourceFixedInput();
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

function createAcceptedGeneration(
  journalOverrides: Partial<SupplyAttributionJournalV1Payload> = {},
) {
  return createAcceptedGenerationFromFixture(
    acceptedGenerationFixture(),
    journalOverrides,
  );
}

// Production XAUT observations are pinned to a finalized Ethereum block and are
// already 780-1150s old when the generation is published, while wM/Centrifuge
// route reads land within ~30s of capture.
const XAUT_OBSERVATION_LAG_SEC = 1_000;
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

function wmObservations(): ReviewedDeploymentSupplyObservation[] {
  const inventory = buildReviewedDeploymentRouteInventory("wm-m0");
  if (!inventory) throw new Error("Missing wM route inventory");
  return inventory.routes.map((route, index) => {
    const identity = expectedWmDeploymentIdentity(route.routeId);
    const rawSupply = WM_RAW_SUPPLY_BY_ROUTE[route.routeId];
    const blockTimeOffset =
      WM_BLOCK_TIME_OFFSET_BY_CHAIN[route.chainId];
    if (!identity || rawSupply === undefined || blockTimeOffset === undefined) {
      throw new Error(`Missing wM fixture row for ${route.routeId}`);
    }
    const common = {
      routeId: route.routeId,
      chainId: route.chainId,
      contractAddress: route.contractAddress,
      decimals: route.decimals,
      rawSupply,
      blockNumberOrSlot: (25_000_000 + index).toString(),
      blockTimeSec: SOURCE_CLOCK_SEC + blockTimeOffset,
    };
    return identity.runtime === "evm"
      ? {
          ...common,
          blockHash: `0x${(index + 1).toString(16).repeat(64)}`,
          runtimeCodeSha256: identity.runtimeCodeSha256,
          implementationAddress: identity.implementationAddress,
          implementationCodeSha256: identity.implementationCodeSha256,
          underlyingTokenAddress: identity.underlyingTokenAddress,
          controllerAddress: identity.controllerAddress,
        }
      : {
          ...common,
          blockHash: "B".repeat(44),
          programOwner: identity.programOwner,
          mintAuthority: identity.mintAuthority,
          controllerAddress: identity.controllerAddress,
          controllerProgramOwner: identity.controllerProgramOwner,
        };
  });
}

/** Adds wM to the expected inventory by removing its upstream chain supply. */
function coTenantFixedInput(
  clockSec: number,
  xautAggregateSupplyUsd: number,
  wmAggregateSupplyUsd: number,
): ReportCardsFixedInput {
  const base = withClockAndAggregate(
    createSafetyScoreV9FullRegistryInput(),
    clockSec,
    xautAggregateSupplyUsd,
  );
  const {
    baseInputGenerationId: _baseInputGenerationId,
    ...withoutBaseIdentity
  } = base;
  const { "wm-m0": _wmChainSupply, ...chainCirculatingById } =
    base.chainCirculatingById;
  return normalizeFixedInput({
    ...withoutBaseIdentity,
    chainCirculatingById,
    aggregateCirculatingById: {
      ...base.aggregateCirculatingById,
      "wm-m0": {
        circulating: { peggedUSD: wmAggregateSupplyUsd },
        observedAtSec: clockSec,
      },
    },
  });
}

function laggedXautObservation(): XautLockMintObservation {
  const observation = xautObservation();
  return {
    ...observation,
    blockTimeSec: SOURCE_CLOCK_SEC - XAUT_OBSERVATION_LAG_SEC,
    disclosure: {
      ...observation.disclosure,
      sourceTimestampSec:
        SOURCE_CLOCK_SEC - XAUT_OBSERVATION_LAG_SEC - 100,
    },
  };
}

function createCoTenantGeneration() {
  const fixedInput = coTenantFixedInput(
    SOURCE_CLOCK_SEC,
    SOURCE_AGGREGATE_USD,
    WM_SOURCE_AGGREGATE_USD,
  );
  const xautAttribution =
    deriveXautRepresentationGroupSupplyAttribution({
      aggregateSupplyUsd: SOURCE_AGGREGATE_USD,
      registryFingerprint: fixedInput.registryFingerprint,
      scoringClockSec: fixedInput.clockSec,
      observation: laggedXautObservation(),
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

describe("isolated Safety Score V9 supply attribution generation", () => {
  it("round-trips a complete content-addressed generation", () => {
    const generation = createAcceptedGeneration();
    expect(
      parseSafetyScoreV9SupplyAttributionGeneration(
        serializeSafetyScoreV9SupplyAttributionGeneration(generation),
      ),
    ).toEqual(generation);
    expect(generation.generationId).toMatch(
      /^safety-score-v9-supply-attribution:v1:[a-f0-9]{64}$/,
    );
    expect(generation.expectedAssetIds).toEqual(["xaut-tether"]);
    expect(generation.observedAssetIds).toEqual(["xaut-tether"]);
  });

  it("re-derives accepted raw observations against the current aggregate", () => {
    const generation = createAcceptedGeneration();
    const target = withClockAndAggregate(
      sourceFixedInput(),
      SOURCE_CLOCK_SEC + 15 * 60,
      TARGET_AGGREGATE_USD,
    );
    const applied = applySafetyScoreV9SupplyAttributionGeneration(
      target,
      generation,
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
    const generation = createCoTenantGeneration();
    expect(generation.acceptedAssetIds).toEqual([
      "wm-m0",
      "xaut-tether",
    ]);

    const bothFresh = applySafetyScoreV9SupplyAttributionGeneration(
      coTenantFixedInput(
        SOURCE_CLOCK_SEC + 300,
        TARGET_AGGREGATE_USD,
        WM_TARGET_AGGREGATE_USD,
      ),
      generation,
    );
    expect(bothFresh).toMatchObject({
      status: "applied",
      acceptedAssetIds: ["wm-m0", "xaut-tether"],
      invalidAssetIds: [],
    });

    // The generation is still inside its own freshness window, but XAUT's
    // finalized-block observation is not. wM must keep its attribution.
    const xautAgedOut = applySafetyScoreV9SupplyAttributionGeneration(
      coTenantFixedInput(
        SOURCE_CLOCK_SEC + 900,
        TARGET_AGGREGATE_USD,
        WM_TARGET_AGGREGATE_USD,
      ),
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

  it("fails closed when a generation ages beyond its observation window", () => {
    const generation = createAcceptedGeneration();
    const staleTarget = withClockAndAggregate(
      sourceFixedInput(),
      generation.capturedAtSec + 30 * 60 + 1,
      TARGET_AGGREGATE_USD,
    );
    const applied = applySafetyScoreV9SupplyAttributionGeneration(
      staleTarget,
      generation,
    );

    expect(applied).toMatchObject({
      status: "incompatible",
      generationId: generation.generationId,
      reason: "generation-identity-or-freshness-mismatch",
    });
    expect(
      applied.fixedInput.safetyScoreV9SupplyAttributionById,
    ).toEqual({});
  });

  it("uses the shorter retry cadence for complete rejected generations", () => {
    const accepted = createAcceptedGeneration();
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
    ).toBe(rejected.capturedAtSec + 15 * 60);
  });

  it("rejects malformed journal references even when the generation hash is recomputed", () => {
    const accepted = createAcceptedGeneration();
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
    const fixture = acceptedGenerationFixture();
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
    const fixture = acceptedGenerationFixture();
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
