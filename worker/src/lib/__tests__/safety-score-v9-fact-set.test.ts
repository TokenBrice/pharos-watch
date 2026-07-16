import { describe, expect, it } from "vitest";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { buildV9DependencyEvaluationPlan } from "@shared/lib/safety-score-v9/dependencies";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { evaluateV9StressState } from "@shared/lib/safety-score-v9/stress";
import type { ExitRouteObservation } from "@shared/types/exit-route";
import { createReportCardsFixedInput } from "../report-cards-fixed-input";
import {
  compileSafetyScoreV9FactSetFromFixedInput,
  computeSafetyScoreV9ReserveExposureKey,
  type SafetyScoreV9FactSetExtensionV2,
} from "../safety-score-v9-fact-set";
import { buildSafetyScoreV9BaselineExtension, type V9ExtensionRegistryMeta } from "../safety-score-v9-extension";

const AS_OF_SEC = 10_000;
const OBSERVED_AT_SEC = 9_900;

function status(observationState: "known" | "missing" = "known", policyRuleId = "fixture.review") {
  return {
    applicability: { state: "required" as const, policyRuleId, rationale: null, gapId: null },
    observationState,
    evidenceRefIds: observationState === "known" ? ["placeholder:evidence"] : [],
    gapIds: observationState === "known" ? [] : ["placeholder:gap"],
  };
}

function notApplicableStatus(policyRuleId: string) {
  return {
    applicability: {
      state: "not-applicable" as const,
      policyRuleId,
      rationale: "Reviewed as not applicable for the fixture.",
      gapId: null,
    },
    observationState: "known" as const,
    evidenceRefIds: ["placeholder:evidence"],
    gapIds: [],
  };
}

function route(routeId = "dex:primary", observedAt = OBSERVED_AT_SEC, chain = "ethereum"): ExitRouteObservation {
  return {
    routeId,
    routeFamily: "dex-amm",
    scope: { kind: "chain-contract", chain, contractOrPoolId: routeId, protocol: "fixture-dex" },
    requestedNotionalUsd: 100_000,
    settlementHorizonSec: 300,
    maxCostBps: 200,
    executableUsd: 80_000,
    completionRatio: 0.8,
    output: { kind: "fiat", currency: "USD", assetKeys: ["fiat:USD"] },
    evidenceKind: "reserve-based-amm-simulation",
    confidence: "high",
    scoreEligible: true,
    observedAt,
    freshnessSeconds: AS_OF_SEC - observedAt,
    commonModeKeys: ["chain:ethereum", "protocol:fixture-dex"],
    capacityCurve: [
      {
        requestedNotionalUsd: 100_000,
        maxCostBps: 200,
        executableUsd: 80_000,
        completionRatio: 0.8,
      },
      {
        requestedNotionalUsd: 1_000_000,
        maxCostBps: 200,
        executableUsd: 400_000,
        completionRatio: 0.4,
      },
    ],
  };
}

function exactFixedInput(
  args: {
    liquidityScore?: number;
    classifiedReserve?: boolean;
    omitPegRow?: boolean;
    pegScore?: number | null;
    currentDeviationBps?: number | null;
    activeDepeg?: boolean;
    activeDepegPeakBps?: number;
    routeChain?: string;
    chainSupplyByChain?: Record<
      string,
      {
        current: number;
        circulatingPrevDay: number;
        circulatingPrevWeek: number;
        circulatingPrevMonth: number;
      }
    >;
  } = {},
) {
  const reserve = {
    name: "Custodied cash",
    pct: 100,
    risk: "very-low" as const,
    ...(args.classifiedReserve === false
      ? {}
      : {
          assetClass: "cash" as const,
          issuerOrObligor: "issuer:alpha",
          riskFactors: ["custody" as const, "counterparty" as const],
          liquidityHorizon: "immediate" as const,
          maturityDaysMax: 0,
        }),
  };
  return createReportCardsFixedInput({
    captureKind: "exact-publication-inputs",
    activeAssetIds: ["alpha"],
    capturedAt: "2026-07-13T00:00:00.000Z",
    sourceGeneration: "report-cards:fixture:10000",
    dexGenerationId: `dex-liquidity-${OBSERVED_AT_SEC}`,
    redemptionGenerationId: "redemption-backstops-unavailable",
    registryRevision: "registry:fixture",
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    clockSec: AS_OF_SEC,
    updatedAt: AS_OF_SEC,
    liquidityStale: false,
    redemptionStale: true,
    inputFreshness: {
      dexLiquidity: { updatedAt: OBSERVED_AT_SEC, ageSeconds: 100, stale: false },
      redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
    },
    pegDataById: args.omitPegRow
      ? {}
      : {
          alpha: {
            id: "alpha",
            symbol: "ALPHA",
            name: "Alpha",
            pegType: "peggedUSD",
            pegCurrency: "USD",
            governance: "centralized",
            currentDeviationBps: args.currentDeviationBps === undefined ? 1 : args.currentDeviationBps,
            pegScore: args.pegScore === undefined ? 99 : args.pegScore,
            priceSource: "fixture-price",
            priceObservedAt: OBSERVED_AT_SEC,
            pegPct: 99,
            severityScore: 0,
            spreadPenalty: 0,
            eventCount: 0,
            worstDeviationBps: 1,
            activeDepeg: args.activeDepeg ?? false,
            lastEventAt: null,
            trackingSpanDays: 365,
            methodologyVersion: "peg:fixture-v1",
          },
        },
    activeDepegPeakBpsById: args.activeDepegPeakBps === undefined ? {} : { alpha: args.activeDepegPeakBps },
    dexLiqMap: {
      alpha: {
        liquidityScore: args.liquidityScore ?? 12,
        concentrationHhi: 0.5,
        poolCount: 1,
        chainCount: 1,
        coverageClass: "primary",
        coverageConfidence: 1,
        liquidityEvidenceClass: "measured",
        hasMeasuredLiquidityEvidence: true,
        effectiveTvlUsd: 1_000_000,
        balanceMeasuredTvlUsd: 1_000_000,
        organicMeasuredTvlUsd: 1_000_000,
        exitRouteObservations: [route("dex:primary", OBSERVED_AT_SEC, args.routeChain ?? "ethereum")],
        exitRouteObservationCoverage: {
          status: "populated",
          capabilityMatrixVersion: "p4a.4",
          retainedPoolCount: 1,
          observationCount: 1,
          scoreEligibleObservationCount: 1,
          scoreEligiblePoolCount: 1,
          scoreEligibleCapabilityPoolCount: 1,
          unsupportedPoolCount: 0,
          evidenceCounts: { "reserve-based-amm-simulation": 1 },
          unsupportedReasons: {},
        },
        methodologyVersion: "dex:fixture-v1",
        updatedAt: OBSERVED_AT_SEC,
      },
    },
    redemptionBackstopMap: {},
    bluechipMap: {},
    resolvedBlacklistStatuses: { alpha: false },
    liveReserveMap: { alpha: [reserve] },
    liveReserveProvenanceMap: {
      alpha: { source: "fixture-reserve-api", fetchedAt: OBSERVED_AT_SEC },
    },
    chainCirculatingById: {
      alpha: args.chainSupplyByChain ?? {
        ethereum: {
          current: 10_000_000,
          circulatingPrevDay: 10_000_000,
          circulatingPrevWeek: 10_000_000,
          circulatingPrevMonth: 10_000_000,
        },
      },
    },
    dexDeploymentSupplyCoverageById: {},
    collateralDriftCoins: [],
    liveToFallbackCoins: [],
  });
}

function exactTwoAssetFixedInput(options: { mapAlphaCollateral?: boolean; omitAlphaReserve?: boolean } = {}) {
  const alpha = exactFixedInput();
  const alphaDex = alpha.dexLiqMap.alpha!;
  const alphaPeg = alpha.pegDataById.alpha!;
  const {
    schemaVersion: omittedSchemaVersion,
    activeAssetIds: omittedActiveAssetIds,
    dexPayloadFingerprint: omittedDexPayloadFingerprint,
    redemptionPayloadFingerprint: omittedRedemptionPayloadFingerprint,
    registryFingerprint: omittedRegistryFingerprint,
    inputMethodologyVersions: omittedInputMethodologyVersions,
    baseInputGenerationId: omittedBaseInputGenerationId,
    ...draft
  } = alpha;
  void [
    omittedSchemaVersion,
    omittedActiveAssetIds,
    omittedDexPayloadFingerprint,
    omittedRedemptionPayloadFingerprint,
    omittedRegistryFingerprint,
    omittedInputMethodologyVersions,
    omittedBaseInputGenerationId,
  ];
  const liveReserveMap = structuredClone(alpha.liveReserveMap);
  if (options.omitAlphaReserve) delete liveReserveMap.alpha;
  return createReportCardsFixedInput({
    ...draft,
    activeAssetIds: ["alpha", "beta"],
    pegDataById: {
      ...alpha.pegDataById,
      beta: { ...alphaPeg, id: "beta", symbol: "BETA", name: "Beta" },
    },
    dexLiqMap: {
      ...alpha.dexLiqMap,
      beta: {
        ...alphaDex,
        exitRouteObservations: [route("dex:beta")],
      },
    },
    resolvedBlacklistStatuses: { alpha: false, beta: false },
    liveReserveMap: {
      ...liveReserveMap,
      ...(options.mapAlphaCollateral
        ? {
            alpha: [
              {
                name: "Beta stablecoin",
                pct: 50,
                risk: "low" as const,
                coinId: "beta",
                depType: "collateral" as const,
                issuerOrObligor: "asset:beta",
                riskFactors: ["counterparty" as const],
                liquidityHorizon: "immediate" as const,
                maturityDaysMax: 0,
              },
              {
                name: "Custodied cash",
                pct: 50,
                risk: "very-low" as const,
                assetClass: "cash" as const,
                issuerOrObligor: "issuer:alpha",
                riskFactors: ["custody" as const, "counterparty" as const],
                liquidityHorizon: "immediate" as const,
                maturityDaysMax: 0,
              },
            ],
          }
        : {}),
      beta: [],
    },
    chainCirculatingById: {
      ...alpha.chainCirculatingById,
      beta: structuredClone(alpha.chainCirculatingById.alpha),
    },
  });
}

function mechanismReview() {
  const component = {
    status: status(),
    quality: "strong" as const,
    failureDomains: [{ kind: "reserve-issuer" as const, key: "issuer:alpha" }],
  };
  return {
    archetype: "fiat-cash" as const,
    claimAndSegregation: component,
    custodyContinuity: component,
    assuranceAndReconciliation: component,
  };
}

function routeReview(routeId = "dex:primary", observedAt = OBSERVED_AT_SEC) {
  return {
    lane: "dex" as const,
    routeId,
    holderAccess: "permissionless" as const,
    executionModel: "market-depth" as const,
    executionCertainty: "bounded" as const,
    modelConfidence: "medium" as const,
    coverageClass: "exact-complete" as const,
    settlementModel: "atomic" as const,
    settlementSlaSec: null,
    physicalResourceKeys: [`pool:${routeId}`],
    executionCosts: [
      { requestedNotionalUsd: 1_000_000, maxCostBps: 200, executionCostBps: 180 },
      { requestedNotionalUsd: 100_000, maxCostBps: 200, executionCostBps: 120 },
    ],
    output: {
      kind: "fiat" as const,
      assetKeys: ["fiat:USD"],
      basketWeights: [],
      valuation: {
        basis: "reviewed-par" as const,
        referenceAssetKey: "fiat:USD",
        unitValueUsd: 1,
        expectedUnitValueUsd: 1,
        sourceId: "fixture-valuation",
        sourceGenerationId: "valuation:fixture-v1",
        observedAtSec: observedAt,
        maxAgeSec: 500,
        confidence: "high" as const,
        url: null,
        contentSha256: null,
      },
    },
    failureDomains: [
      { kind: "chain" as const, key: "ethereum" },
      { kind: "dex-protocol" as const, key: "fixture-dex" },
    ],
  };
}

function extension(): SafetyScoreV9FactSetExtensionV2 {
  return {
    schemaVersion: 2,
    registryFingerprint: exactFixedInput().registryFingerprint,
    compiledAtSec: AS_OF_SEC + 1,
    sources: {
      registryObservedAtSec: OBSERVED_AT_SEC,
      unavailableRedemptionObservedAtSec: OBSERVED_AT_SEC,
      liveReserves: { generationId: "reserves:fixture-v1", observedAtSec: OBSERVED_AT_SEC, maxAgeSec: 500 },
      chainSupply: { generationId: "supply:fixture-v1", observedAtSec: OBSERVED_AT_SEC, maxAgeSec: 500 },
      peg: { generationId: "peg:fixture-v1", observedAtSec: OBSERVED_AT_SEC, maxAgeSec: 500 },
      researchOverlays: { generationId: "research:fixture-v1", observedAtSec: OBSERVED_AT_SEC, maxAgeSec: 500 },
    },
    routeFreshness: { dexMaxAgeSec: 500, redemptionMaxAgeSec: 500, documentedTermsMaxAgeSec: 31_536_000 },
    assets: [
      {
        assetId: "alpha",
        archetype: "fiat-cash",
        launchedAtSec: 1_000,
        mechanismRiskReview: mechanismReview(),
        dependencies: {
          source: "none",
          baseSource: "none",
          dependencyFromLive: false,
          mappedLiveReserveWeight: null,
          fallbackReason: null,
          edges: [],
          diagnostics: { graphState: "valid", issueCodes: [], sccMemberAssetIds: [] },
        },
        reserveApplicability: { state: "required" },
        reserveClassifications: [],
        routeReviews: [routeReview()],
        retainedRoutes: [],
        controlReview: {
          state: "no-privileged-controls",
          rationale: "The reviewed fixture implementation has no privileged deployment controls.",
        },
        economicControlReview: {
          mint: {
            status: notApplicableStatus("v9.control.mint-review"),
            controlKey: null,
            reconciliation: "not-applicable",
            supervision: "unknown",
            upgrade: { state: "not-applicable", controlKey: null },
          },
          oracle: {
            status: notApplicableStatus("v9.control.oracle-review"),
            tier: null,
            branches: [],
          },
          bridge: {
            status: notApplicableStatus("v9.control.bridge-review"),
            routes: [],
          },
        },
        accessReview: {
          transfer: { status: status("known", "v9.access.transfer-review"), posture: "permissionless" },
          freeze: {
            status: status("known", "v9.access.freeze-review"),
            reviews: [
              {
                reviewKey: "freeze:none-reviewed",
                source: "blacklist",
                status: status("known", "v9.access.freeze-review"),
                reach: "none",
                controlKey: null,
                upstreamAssetId: null,
                failureDomains: [],
              },
            ],
          },
        },
        pegReference: {
          referenceKind: "fiat",
          referenceKey: "USD",
          failureDomains: [{ kind: "oracle-feed", key: "fixture-price" }],
        },
        supplyReview: {
          selectedBridgeRoutes: [],
          selectedRouteSupplyShare: 0,
          // Single-chain native with no route rows conserves to unknown=1 (VER-007).
          unknownRouteSupplyShare: 1,
          unreviewedRouteSupplyShare: 0,
          failureDomains: [],
        },
        researchEvidence: [],
        componentEvidence: [],
      },
    ],
  };
}

const V9_EVALUATION_TEST_TIMEOUT_MS = 30_000;

describe("Safety Score v9 exact base fact-set adapter", { timeout: V9_EVALUATION_TEST_TIMEOUT_MS }, () => {
  it("defaults retained v2 route reviews without modeled confidence to low", () => {
    const fixed = exactFixedInput();
    const retained = structuredClone(extension());
    delete (retained.assets[0]!.routeReviews[0] as unknown as Record<string, unknown>).modelConfidence;

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, retained);
    expect(compiled.assets[0]!.exitRoutes[0]).toMatchObject({ modelConfidence: "low" });
  });

  it("builds a conservative baseline overlay without inventing missing reviews", () => {
    const fixed = exactFixedInput();
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "fiat-cash",
            launchDate: "2020-01-01",
          },
        ],
      ]),
    });
    expect(baseline.assets[0]).toMatchObject({
      assetId: "alpha",
      archetype: "fiat-cash",
      // The reviewed cash reserve backs the claim/custody components at the
      // bounded quality; assurance stays missing without a proof-of-reserves
      // report, and the captured DEX observation yields a derived exit route.
      mechanismRiskReview: {
        archetype: "fiat-cash",
        claimAndSegregation: { status: { observationState: "bounded-unknown" } },
        custodyContinuity: { status: { observationState: "bounded-unknown" } },
        assuranceAndReconciliation: { status: { observationState: "missing" } },
      },
      controlReview: null,
      economicControlReview: null,
      accessReview: null,
      routeReviews: [{ lane: "dex", routeId: "dex:primary", coverageClass: "exact-complete" }],
    });
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    expect(compiled.assets[0]!.gaps.map((gap) => gap.reasonCode)).toEqual(
      expect.arrayContaining(["missing-access-review"]),
    );
    expect(evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!.trace.finalGrade).not.toBe("NR");
  });

  it("marks pure NAV tokens as reviewed not-applicable for fixed-peg scoring", () => {
    const fixed = exactFixedInput({ omitPegRow: true });
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "fiat-cash",
            launchDate: "2020-01-01",
            flags: {
              backing: "rwa-backed",
              pegCurrency: "USD",
              governance: "centralized",
              yieldBearing: true,
              rwa: true,
              navToken: true,
            },
          },
        ],
      ]),
    });

    expect(baseline.assets[0]!.pegReference).toEqual({
      referenceKind: "nav",
      referenceKey: "nav:alpha",
      failureDomains: [],
    });
    expect(compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline).assets[0]!.peg).toMatchObject({
      status: { applicability: { state: "not-applicable" }, observationState: "known" },
      referenceKind: "nav",
      referenceKey: "nav:alpha",
      pegScore: null,
    });
  });

  it("keeps reviewed fallback collateral bounded until an exact reserve exposure maps it", () => {
    const fixed = exactTwoAssetFixedInput();
    const dependencyReview = {
      reviewedAt: "1970-01-01",
      reviewer: "Fixture reviewer",
      confidence: "manual-review" as const,
      sources: [{ label: "Fixture dependency analysis", url: "https://example.com/dependencies/alpha" }],
      rationale: "Beta is a reviewed collateral dependency.",
      relationships: [
        {
          id: "beta",
          weight: 0.5,
          type: "collateral" as const,
          reason: "Half of the reviewed backing is Beta.",
        },
      ],
    };
    const metaById = new Map<string, V9ExtensionRegistryMeta>([
      [
        "alpha",
        {
          id: "alpha",
          mechanismArchetype: "fiat-cash" as const,
          launchDate: "1970-01-01",
          dependencies: [{ id: "beta", weight: 0.5, type: "collateral" as const }],
          dependencyReview,
        },
      ],
      [
        "beta",
        {
          id: "beta",
          mechanismArchetype: "fiat-cash" as const,
          launchDate: "1970-01-01",
        },
      ],
    ]);

    const baseline = buildSafetyScoreV9BaselineExtension(fixed, { metaById });
    const alpha = baseline.assets.find((asset) => asset.assetId === "alpha")!;
    expect(alpha.dependencies).toMatchObject({
      source: "manual",
      diagnostics: {
        graphState: "unresolved",
        issueCodes: ["collateral-edge-exposure-unmapped:beta"],
      },
      edges: [{ upstreamAssetId: "beta", dependencyType: "collateral", weight: 0.5 }],
    });
    expect(alpha.researchEvidence).toEqual([
      expect.objectContaining({
        sourceId: "stablecoin-meta.dependency-review",
        url: "https://example.com/dependencies/alpha",
        confidence: "manual-review",
        contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(alpha.componentEvidence).toEqual([expect.objectContaining({ componentKey: "dependencies" })]);

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    const compiledAlpha = compiled.assets.find((asset) => asset.assetId === "alpha")!;
    expect(compiledAlpha.dependencies.status).toMatchObject({ observationState: "bounded-unknown" });
    expect(compiledAlpha.dependencies.diagnostics.issueCodes).toContain("collateral-edge-exposure-unmapped:beta");
    expect(compiledAlpha.dependencies.edges[0]!.evidenceRefIds).toEqual(
      compiledAlpha.dependencies.status.evidenceRefIds,
    );
    expect(compiledAlpha.dependencies.status.evidenceRefIds[0]).toContain("stablecoin-meta.dependency-review");
    expect(
      evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1)
        .assets.find((asset) => asset.assetId === "alpha")!
        .scoreInput.dependencyReasons.map((reason) => reason.code),
    ).toContain("unreviewed-dependency-relationships");

    const mismatchedMeta = new Map(metaById);
    mismatchedMeta.set("alpha", {
      ...metaById.get("alpha")!,
      dependencyReview: {
        ...dependencyReview,
        relationships: [{ ...dependencyReview.relationships[0]!, weight: 0.4 }],
      },
    });
    const mismatched = buildSafetyScoreV9BaselineExtension(fixed, { metaById: mismatchedMeta });
    expect(mismatched.assets.find((asset) => asset.assetId === "alpha")!.dependencies).toMatchObject({
      diagnostics: {
        graphState: "unresolved",
        issueCodes: ["collateral-edge-exposure-unmapped:beta", "dependency-review-mismatch"],
      },
    });

    const mappedFixed = exactTwoAssetFixedInput({ mapAlphaCollateral: true });
    const mapped = buildSafetyScoreV9BaselineExtension(mappedFixed, { metaById });
    expect(mapped.assets.find((asset) => asset.assetId === "alpha")!.dependencies).toMatchObject({
      source: "live-reserve",
      diagnostics: { graphState: "valid", issueCodes: [] },
      edges: [{ upstreamAssetId: "beta", dependencyType: "collateral", weight: 0.5 }],
    });
    const compiledMapped = compileSafetyScoreV9FactSetFromFixedInput(mappedFixed, mapped);
    const compiledMappedAlpha = compiledMapped.assets.find((asset) => asset.assetId === "alpha")!;
    expect(compiledMappedAlpha.dependencies.status.observationState).toBe("known");
    expect(compiledMappedAlpha.reserveExposures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          trackedAssetId: "beta",
          assetClass: "stablecoin",
          weight: 0.5,
          status: expect.objectContaining({ observationState: "known" }),
        }),
      ]),
    );
    expect(
      evaluateV9FactSet(compiledMapped, V9_CANDIDATE_POLICY_V1)
        .assets.find((asset) => asset.assetId === "alpha")!
        .scoreInput.dependencyReasons.map((reason) => reason.code),
    ).not.toContain("unreviewed-dependency-relationships");

    const retainedNullClassification = structuredClone(mapped);
    retainedNullClassification.assets
      .find((asset) => asset.assetId === "alpha")!
      .reserveClassifications.find((classification) => classification.issuerOrObligorKey === "asset:beta")!.assetClass =
      null;
    expect(
      compileSafetyScoreV9FactSetFromFixedInput(mappedFixed, retainedNullClassification)
        .assets.find((asset) => asset.assetId === "alpha")!
        .reserveExposures.find((exposure) => exposure.trackedAssetId === "beta"),
    ).toMatchObject({ assetClass: "stablecoin", status: { observationState: "known" } });

    const mismatchedMapping = structuredClone(mapped);
    mismatchedMapping.assets.find((asset) => asset.assetId === "alpha")!.dependencies!.edges[0]!.weight = 0.4;
    const compiledMismatch = compileSafetyScoreV9FactSetFromFixedInput(mappedFixed, mismatchedMapping);
    expect(compiledMismatch.assets.find((asset) => asset.assetId === "alpha")!.dependencies).toMatchObject({
      status: { observationState: "bounded-unknown" },
      diagnostics: {
        graphState: "unresolved",
        issueCodes: ["collateral-edge-exposure-weight-mismatch:beta"],
      },
    });
  });

  it("reconciles curated collateral only when no live reserve snapshot exists", () => {
    const metaById = new Map<string, V9ExtensionRegistryMeta>([
      [
        "alpha",
        {
          id: "alpha",
          mechanismArchetype: "fiat-cash",
          launchDate: "1970-01-01",
          reserves: [{ name: "Beta stablecoin", pct: 50, risk: "low", coinId: "beta", depType: "collateral" }],
        },
      ],
      ["beta", { id: "beta", mechanismArchetype: "fiat-cash", launchDate: "1970-01-01" }],
    ]);
    const noLiveSnapshot = exactTwoAssetFixedInput({ omitAlphaReserve: true });

    const curated = buildSafetyScoreV9BaselineExtension(noLiveSnapshot, { metaById });
    expect(curated.assets.find((asset) => asset.assetId === "alpha")!.dependencies).toMatchObject({
      source: "curated-reserve",
      diagnostics: { graphState: "valid", issueCodes: [] },
      edges: [{ upstreamAssetId: "beta", dependencyType: "collateral", weight: 0.5 }],
    });

    const liveSnapshot = exactTwoAssetFixedInput();
    const liveMismatch = buildSafetyScoreV9BaselineExtension(liveSnapshot, { metaById });
    expect(liveMismatch.assets.find((asset) => asset.assetId === "alpha")!.dependencies).toMatchObject({
      source: "curated-reserve",
      diagnostics: {
        graphState: "unresolved",
        issueCodes: ["collateral-edge-exposure-unmapped:beta"],
      },
    });
  });

  it("compiles exact base facts and explicit reviews without consulting v8 score outputs", () => {
    const fixed = exactFixedInput();
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension());
    const alpha = compiled.assets[0]!;

    expect(compiled.baseInputGenerationId).toBe(fixed.baseInputGenerationId);
    expect(compiled.asOfSec).toBe(AS_OF_SEC);
    expect(compiled.sourceFingerprints.dex).toMatchObject({
      generationId: fixed.dexGenerationId,
      payloadSha256: fixed.dexPayloadFingerprint,
      observedAtSec: OBSERVED_AT_SEC,
    });
    expect(compiled.activeAssetIds).toEqual(["alpha"]);
    expect(
      compiled.assets.every((asset) => Object.prototype.hasOwnProperty.call(asset.supply, "chainDistribution")),
    ).toBe(true);
    expect(alpha.mechanismRiskReview.review?.archetype).toBe("fiat-cash");
    expect(alpha.economicControlReview.mint.status.applicability.state).toBe("not-applicable");
    expect(alpha.accessReview.transfer.posture).toBe("permissionless");
    expect(alpha.reserveStatus.observationState).toBe("known");
    expect(alpha.supply).toMatchObject({
      sourceKind: "usd-denominated-circulating",
      referencePriceUsd: null,
      circulatingUsd: 10_000_000,
      chainDistribution: {
        chains: [{ chainId: "ethereum", supplyUsd: 10_000_000, supplyShare: 1 }],
        unattributedSupplyUsd: 0,
        unattributedSupplyShare: 0,
      },
    });
    expect(alpha.exitRoutes[0]).toMatchObject({
      routeId: "dex:primary",
      modelConfidence: "medium",
      status: { observationState: "known" },
      scoreEligible: true,
    });
    expect(alpha.gaps).toEqual([]);

    const evaluated = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1);
    expect(evaluated.assets).toHaveLength(1);
    expect(evaluated.assets[0]!.trace).toMatchObject({ finalGrade: "B+", finalScore: 79 });
    expect(evaluated.assets[0]!.access).toMatchObject({
      transfer: "permissionless",
      freezeExposure: "none-known",
      primaryExit: "permissionless",
    });
    expect(evaluateV9StressState(evaluated.assets[0]!.stressState, V9_CANDIDATE_POLICY_V1)).toEqual(
      evaluated.assets[0]!.trace,
    );

    const low = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput({ liquidityScore: 1 }), extension());
    const high = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput({ liquidityScore: 99 }), extension());
    expect(low.assets).toEqual(high.assets);
    expect(low.baseInputGenerationId).not.toBe(high.baseInputGenerationId);
  });

  it("aggregates chain aliases and conserves unresolved source supply without price multiplication", () => {
    const original = exactFixedInput();
    const template = original.chainCirculatingById.alpha!.ethereum!;
    const fixed = exactFixedInput({
      chainSupplyByChain: {
        Ethereum: { ...template, current: 6_000_000 },
        ethereum: { ...template, current: 4_000_000 },
        "Hyperliquid L1": { ...template, current: 3_000_000 },
        "hyperliquid-l1": { ...template, current: 2_000_000 },
        "Future Network": { ...template, current: 1_000_000 },
        "Zero Network": { ...template, current: 0 },
      },
    });

    const supply = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension()).assets[0]!.supply;
    expect(supply.referencePriceUsd).toBeNull();
    expect(supply.circulatingUsd).toBe(16_000_000);
    expect(supply.chainDistribution).toEqual({
      chains: [
        { chainId: "ethereum", supplyUsd: 10_000_000, supplyShare: 10 / 16 },
        { chainId: "hyperliquid", supplyUsd: 5_000_000, supplyShare: 5 / 16 },
      ],
      unattributedSupplyUsd: 1_000_000,
      unattributedSupplyShare: 1 / 16,
    });
    expect(supply.failureDomains).toEqual(
      expect.arrayContaining([
        { kind: "chain", key: "future network" },
        { kind: "chain", key: "hyperliquid" },
        { kind: "chain", key: "zero network" },
      ]),
    );
  });

  it("joins route display names and supply IDs into one canonical chain common mode", () => {
    const original = exactFixedInput();
    const template = original.chainCirculatingById.alpha!.ethereum!;
    const fixed = exactFixedInput({
      routeChain: "Monad",
      chainSupplyByChain: { monad: { ...template, current: 10_000_000 } },
    });
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension());
    const alpha = compiled.assets[0]!;

    expect(alpha.exitRoutes[0]!.failureDomains).toContainEqual({ kind: "chain", key: "monad" });
    expect(alpha.supply.failureDomains).toContainEqual({ kind: "chain", key: "monad" });
    const group = buildV9DependencyEvaluationPlan(compiled).commonModeGroups.find(
      (candidate) => candidate.failureDomain.kind === "chain" && candidate.failureDomain.key === "monad",
    );
    expect(group?.members).toEqual([
      { assetId: "alpha", owner: "exit", pathKey: alpha.exitRoutes[0]!.routeKey },
      { assetId: "alpha", owner: "supply", pathKey: "supply" },
    ]);
  });

  it("keeps shaped diagnostic pools out of the DEX completeness denominator without hiding exact gates", () => {
    const fixedWithCoverage = (exactCapabilityPoolCount: number) => {
      const original = exactFixedInput();
      const {
        schemaVersion: omittedSchemaVersion,
        activeAssetIds: omittedActiveAssetIds,
        dexPayloadFingerprint: omittedDexPayloadFingerprint,
        redemptionPayloadFingerprint: omittedRedemptionPayloadFingerprint,
        registryFingerprint: omittedRegistryFingerprint,
        inputMethodologyVersions: omittedInputMethodologyVersions,
        baseInputGenerationId: omittedBaseInputGenerationId,
        ...draft
      } = original;
      void [
        omittedSchemaVersion,
        omittedActiveAssetIds,
        omittedDexPayloadFingerprint,
        omittedRedemptionPayloadFingerprint,
        omittedRegistryFingerprint,
        omittedInputMethodologyVersions,
        omittedBaseInputGenerationId,
      ];
      return createReportCardsFixedInput({
        ...draft,
        activeAssetIds: ["alpha"],
        dexLiqMap: {
          alpha: {
            ...original.dexLiqMap.alpha!,
            exitRouteObservationCoverage: {
              status: "populated",
              capabilityMatrixVersion: "p4a.4",
              retainedPoolCount: 2_380 + exactCapabilityPoolCount,
              observationCount: 1,
              scoreEligibleObservationCount: 1,
              scoreEligiblePoolCount: 1,
              scoreEligibleCapabilityPoolCount: exactCapabilityPoolCount,
              unsupportedPoolCount: 2_379 + exactCapabilityPoolCount,
              evidenceCounts: { "reserve-based-amm-simulation": 1 },
              unsupportedReasons: {
                "nonExecutableEvidence:defillama-pool-shaped": 1_449,
                "nonExecutableEvidence:curve-stableswap-shaped": 11,
                "nonExecutableEvidence:direct-api-amm-shaped": 653,
                "nonExecutableEvidence:discovery-pool-shaped": 267,
                ...(exactCapabilityPoolCount > 1
                  ? { "executionCapabilityGate:curve-stableswap:rate-bearing-inputs": 1 }
                  : {}),
              },
            },
          },
        },
      });
    };

    const complete = compileSafetyScoreV9FactSetFromFixedInput(fixedWithCoverage(1), extension()).assets[0]!;
    expect(complete.exitStatus.observationState).toBe("known");
    expect(complete.gaps.map((gap) => gap.reasonCode)).not.toContain("incomplete-dex-route-coverage");

    const gated = compileSafetyScoreV9FactSetFromFixedInput(fixedWithCoverage(2), extension()).assets[0]!;
    expect(gated.exitStatus.observationState).toBe("bounded-unknown");
    expect(gated.gaps.map((gap) => gap.reasonCode)).toContain("incomplete-dex-route-coverage");
  });

  it("treats a pure NAV peg reference as not-applicable while fiat assets still require a peg row", () => {
    const withoutPegRow = () => exactFixedInput({ omitPegRow: true });
    const navExtension = extension();
    navExtension.assets[0]!.pegReference = { referenceKind: "nav", referenceKey: "nav:alpha", failureDomains: [] };
    const navCompiled = compileSafetyScoreV9FactSetFromFixedInput(withoutPegRow(), navExtension);
    const navPeg = navCompiled.assets[0]!.peg;
    expect(navPeg.status.applicability.state).toBe("not-applicable");
    expect(navPeg.status.observationState).toBe("known");
    expect(navPeg.pegScore).toBeNull();
    const navEvaluated = evaluateV9FactSet(navCompiled, V9_CANDIDATE_POLICY_V1);
    expect(navEvaluated.assets[0]!.trace.finalGrade).not.toBe("NR");

    const fiatCompiled = compileSafetyScoreV9FactSetFromFixedInput(withoutPegRow(), extension());
    expect(fiatCompiled.assets[0]!.peg.status.observationState).toBe("missing");
    // A fiat asset without a peg row stays rateable under the bounded policy:
    // the peg multiplier floors at par and the peg-unverified ceiling caps the
    // final score instead of reason-coding NR.
    const fiatTrace = evaluateV9FactSet(fiatCompiled, V9_CANDIDATE_POLICY_V1).assets[0]!.trace;
    expect(fiatTrace.finalGrade).not.toBe("NR");
    expect(fiatTrace.pegMultiplier).toBe(1);
    expect(fiatTrace.caps.map((cap) => cap.kind)).toContain("reason:missing-peg-input");
  });

  it("retains an independently observed active depeg when current deviation is unavailable", () => {
    const fixed = exactFixedInput({
      pegScore: 27,
      currentDeviationBps: null,
      activeDepeg: true,
      activeDepegPeakBps: 5_783,
    });
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension());

    expect(compiled.assets[0]!.peg).toMatchObject({
      status: { observationState: "bounded-unknown" },
      pegScore: 27,
      currentDeviationBps: null,
      activeDepeg: true,
      activeDepegBps: 5_783,
    });
    const trace = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!.trace;
    expect(trace.pegMultiplier).toBeCloseTo(0.592305, 6);
    expect(trace.caps).toContainEqual(
      expect.objectContaining({ source: "active-depeg", kind: "active-depeg:f", limit: 39 }),
    );
    const missingPeak = exactFixedInput({ pegScore: 27, currentDeviationBps: null, activeDepeg: true });
    const missingPeakTrace = evaluateV9FactSet(
      compileSafetyScoreV9FactSetFromFixedInput(missingPeak, extension()),
      V9_CANDIDATE_POLICY_V1,
    ).assets[0]!.trace;
    expect(trace.finalScore).toBeLessThan(missingPeakTrace.finalScore!);
  });

  it("keeps an active peg row suppressed when its depeg peak is absent", () => {
    const fixed = exactFixedInput({ pegScore: 27, currentDeviationBps: null, activeDepeg: true });
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension());

    expect(compiled.assets[0]!.peg).toMatchObject({
      status: { observationState: "bounded-unknown" },
      pegScore: null,
      currentDeviationBps: null,
      activeDepeg: null,
      activeDepegBps: null,
    });
    const trace = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!.trace;
    expect(trace.caps.map((cap) => cap.kind)).toContain("reason:missing-peg-input");
    expect(trace.caps.some((cap) => cap.source === "active-depeg")).toBe(false);
  });

  it("canonicalizes extension ordering and produces a deterministic digest", () => {
    const ordered = extension();
    const reversed = structuredClone(ordered);
    const review = reversed.assets[0]!.routeReviews[0]!;
    review.executionCosts.reverse();
    review.failureDomains.reverse();
    review.physicalResourceKeys.reverse();
    const reversedMechanism = reversed.assets[0]!.mechanismRiskReview!;
    if (reversedMechanism.archetype !== "fiat-cash") throw new Error("Fixture archetype changed");
    reversedMechanism.claimAndSegregation.status.evidenceRefIds = ["other:placeholder"];
    const left = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), ordered);
    const right = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), reversed);
    expect(right).toEqual(left);
    expect(right.v9FactSetDigest).toBe(left.v9FactSetDigest);
  });

  it("turns unavailable classifications, valuation, dependencies, and controls into typed gaps", () => {
    const incomplete = extension();
    const asset = incomplete.assets[0]!;
    asset.mechanismRiskReview = null;
    asset.dependencies = null;
    asset.controlReview = null;
    asset.economicControlReview = null;
    asset.accessReview = null;
    asset.supplyReview = null;
    asset.routeReviews[0]!.output!.valuation = null;

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(
      exactFixedInput({ classifiedReserve: false }),
      incomplete,
    );
    const alpha = compiled.assets[0]!;
    const reasons = alpha.gaps.map((gap) => gap.reasonCode);
    expect(reasons).toEqual(
      expect.arrayContaining([
        "material-reserve-slice-unstructured",
        "unresolved-exit-output",
        "unreviewed-dependency-relationships",
        "missing-upgradeability-review",
        "missing-mint-authority",
        "missing-oracle-profile",
        "missing-bridge-routes",
        "runtime-bridge-materiality-unavailable",
      ]),
    );
    expect(alpha.reserveExposures[0]).toMatchObject({
      assetClass: null,
      status: { observationState: "bounded-unknown" },
    });
    expect(alpha.exitRoutes[0]!.output).toMatchObject({ valuation: null, status: { observationState: "missing" } });
    expect(alpha.controls).toEqual([]);
  });

  it("preserves supplied stale and rejected last-known route observations", () => {
    const withRetained = extension();
    const asset = withRetained.assets[0]!;
    asset.retainedRoutes = [
      { lane: "dex", observation: route("dex:stale", 8_000), disposition: "observed", rejection: null },
      {
        lane: "dex",
        observation: route("dex:rejected", 9_800),
        disposition: "rejected",
        rejection: { code: "unsupported-pool", reason: "Producer rejected the pool model.", rejectedAtSec: 9_900 },
      },
    ];
    asset.routeReviews = [routeReview(), routeReview("dex:stale", 8_000), routeReview("dex:rejected", 9_800)];

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), withRetained);
    const stale = compiled.assets[0]!.exitRoutes.find((candidate) => candidate.routeId === "dex:stale")!;
    const rejected = compiled.assets[0]!.exitRoutes.find((candidate) => candidate.routeId === "dex:rejected")!;
    expect(stale).toMatchObject({
      status: { observationState: "stale" },
      request: { requestedNotionalUsd: 100_000 },
    });
    expect(stale.capacityCurve).toHaveLength(2);
    expect(rejected).toMatchObject({ status: { observationState: "unsupported" }, scoreEligible: false });
    const rejectedEvidence = compiled.assets[0]!.evidence.find((evidence) =>
      rejected.status.evidenceRefIds.includes(evidence.evidenceId),
    );
    expect(rejectedEvidence).toMatchObject({ disposition: "rejected", rejection: { code: "unsupported-pool" } });
  });

  it("rejects reconstructed/report-card inputs, score-shaped extension fields, and active-set drift", () => {
    expect(() => compileSafetyScoreV9FactSetFromFixedInput({ cards: [], overallScore: 99 }, extension())).toThrow(
      /Malformed fixed report-card input/,
    );
    expect(() =>
      compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), { ...extension(), overallScore: 99 }),
    ).toThrow(/Unrecognized key/);
    const scoreShapedAsset = extension();
    expect(() =>
      compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), {
        ...scoreShapedAsset,
        assets: [{ ...scoreShapedAsset.assets[0]!, dimensions: {}, baseScore: 99 }],
      }),
    ).toThrow(/Unrecognized key/);
    const wrongAsset = extension();
    wrongAsset.assets[0]!.assetId = "beta";
    expect(() => compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), wrongAsset)).toThrow(
      /active set mismatch/,
    );

    const conflictingOutput = extension();
    conflictingOutput.assets[0]!.routeReviews[0]!.output!.assetKeys = ["fiat:EUR"];
    expect(() => compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), conflictingOutput)).toThrow(
      /output review conflicts with exact base facts/,
    );
  });

  it("maps reviewed blacklistability without inventing permissionlessness", () => {
    const fixed = exactFixedInput();
    const reviewBase = {
      sources: [{ label: "Reviewed token controls", url: "https://example.com/token-controls" }],
      evidence: "The reviewed token controls establish the authored blacklist status.",
      reviewer: "Fixture reviewer",
      reviewedAt: "1970-01-01",
    };
    const build = (reviewedStatus: true | false | "possible") =>
      buildSafetyScoreV9BaselineExtension(fixed, {
        metaById: new Map([
          [
            "alpha",
            {
              id: "alpha",
              mechanismArchetype: "fiat-cash" as const,
              blacklistabilityReview: { ...reviewBase, reviewedStatus },
            },
          ],
        ]),
      });

    const restrictable = compileSafetyScoreV9FactSetFromFixedInput(fixed, build(true)).assets[0]!;
    expect(restrictable.accessReview.transfer).toMatchObject({
      posture: "restrictable",
      status: { observationState: "known" },
    });
    expect(restrictable.accessReview.freeze.reviews[0]).toMatchObject({
      source: "blacklist",
      reach: "individual",
      status: { observationState: "known" },
    });
    expect(
      restrictable.evidence.find((candidate) => candidate.sourceId === "stablecoin-meta.blacklistability-review"),
    ).toMatchObject({ url: "https://example.com/token-controls", freshness: { state: "not-assessed" } });

    const noBlacklist = compileSafetyScoreV9FactSetFromFixedInput(fixed, build(false)).assets[0]!;
    expect(noBlacklist.accessReview.transfer).toMatchObject({
      posture: null,
      status: { observationState: "missing" },
    });
    expect(noBlacklist.accessReview.freeze.reviews[0]).toMatchObject({ reach: "none" });

    const possible = compileSafetyScoreV9FactSetFromFixedInput(fixed, build("possible")).assets[0]!;
    expect(possible.accessReview.transfer).toMatchObject({
      posture: null,
      status: { observationState: "bounded-unknown" },
    });
    expect(possible.accessReview.freeze.reviews[0]).toMatchObject({
      reach: "possible",
      status: { observationState: "bounded-unknown" },
    });
  });

  it("maps only explicit oracle branch families and remains NR without a mechanism review", () => {
    const fixed = exactFixedInput();
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "cdp" as const,
            oracleRisk: {
              tier: "redundant-with-failover" as const,
              summary: "The fixture has reviewed oracle and liquidation branch behavior.",
              branchModel: "multi-branch" as const,
              branchApplicability: {
                disposition: "branches-required" as const,
                reviewedAt: "1970-01-01",
                reviewer: "Fixture reviewer",
                rationale: "The collateral market requires explicit branch evidence.",
                sources: [{ label: "Branch docs", url: "https://example.com/branches" }],
              },
              reviewedAt: "1970-01-01",
              reviewer: "Fixture reviewer",
              confidence: "verified" as const,
              sources: [{ label: "Oracle docs", url: "https://example.com/oracle" }],
              branches: [
                {
                  id: "eth",
                  label: "ETH branch",
                  tier: "redundant-with-failover" as const,
                  summary: "The ETH branch has complete reviewed controls.",
                  feeds: [{ provider: "Fixture", path: "ETH/USD", chain: "ethereum" }],
                  collateralParameters: [{ asset: "ETH", minimumCollateralRatioPct: 120 }],
                  liquidationMechanism: "Immediate permissionless liquidation through the branch.",
                  liquidationDelaySec: 0,
                  backstop: "A dedicated stability pool absorbs liquidated debt.",
                  shutdownOrBadDebtBehavior: "The branch shuts down and exposes residual bad debt explicitly.",
                  sources: [{ label: "Branch docs", url: "https://example.com/branches" }],
                },
              ],
            },
          },
        ],
      ]),
    });
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    const oracle = compiled.assets[0]!.economicControlReview.oracle;
    expect(oracle.status.observationState).toBe("known");
    expect(oracle.tier).toBe("redundant-with-failover");
    expect(oracle.branches.map((branch) => [branch.branch, branch.status.observationState])).toEqual([
      ["backstop", "known"],
      ["collateral-parameter", "known"],
      ["feed", "known"],
      ["liquidation", "known"],
      ["shutdown-bad-debt", "known"],
    ]);
    expect(oracle.branches.every((branch) => branch.mechanismKey !== null && branch.controlKey === null)).toBe(true);
    expect(evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!.trace.finalGrade).not.toBe("NR");

    const withoutOracle = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([["alpha", { id: "alpha", mechanismArchetype: "cdp" as const }]]),
    });
    expect(withoutOracle.assets[0]!.economicControlReview).toBeNull();
  });

  it("retains mint controls while leaving reconciliation, incidents, and upgrades unresolved", () => {
    const fixed = exactFixedInput();
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "cdp" as const,
            mintAuthority: {
              mintPath: "issuer-direct-mint" as const,
              authorityPosture: "concentrated-admin" as const,
              confidence: "verified" as const,
              summary: "A reviewed issuer backend can mint the fixture token directly.",
              controls: [
                {
                  chain: "ethereum",
                  address: "0x1111111111111111111111111111111111111111",
                  label: "Issuer minter",
                  role: "direct-minter" as const,
                  authorityType: "issuer-backend" as const,
                  directMintAbility: "direct" as const,
                  sources: [{ label: "Minter docs", url: "https://example.com/minter" }],
                },
              ],
              review: {
                sources: [{ label: "Minter docs", url: "https://example.com/minter" }],
                evidence: "The issuer minter path is reviewed, but reconciliation and upgrades are not established.",
                reviewer: "Fixture reviewer",
                reviewedAt: "1970-01-01",
                // Open questions keep the review incomplete, so the control is
                // retained while reconciliation, incidents, and upgrades stay
                // unresolved (bounded-unknown).
                unresolvedQuestions: ["Reconciliation cadence and upgrade authority are not yet established."],
              },
            },
          },
        ],
      ]),
    });
    expect(baseline.assets[0]!.controlReview).toMatchObject({ state: "partially-reviewed-controls" });
    expect(baseline.assets[0]!.economicControlReview?.mint).toMatchObject({
      status: { observationState: "bounded-unknown" },
      reconciliation: "unknown",
      upgrade: { state: "unknown", controlKey: null },
    });
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    expect(compiled.assets[0]!.controls[0]).toMatchObject({
      status: { observationState: "bounded-unknown" },
      capSemantics: { kind: "unbounded", bound: null },
      claimImpairment: "unbounded",
      economicLossScope: "global-claim",
      incidentState: "unknown",
    });
    expect(evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!.trace.finalGrade).not.toBe("NR");
  });

  it("keeps a reviewed upgrade control known inside a partial control inventory", () => {
    const fixed = exactFixedInput();
    const mixed = extension();
    const asset = mixed.assets[0]!;
    const bridgeDeploymentKey = "ethereum:0x3333333333333333333333333333333333333333";
    const bridgeControlKey = "bridge:unresolved";
    const mintControlKey = "mint:unresolved";
    const upgradeControlKey = "upgrade:reviewed";

    asset.controlReview = {
      state: "partially-reviewed-controls",
      rationale: "The upgrade authority is reviewed, while bridge and direct-minter identities remain unresolved.",
      controls: [
        {
          controlKey: bridgeControlKey,
          deploymentKey: bridgeDeploymentKey,
          controlKind: "bridge",
          scope: "deployment",
          capabilities: ["bridge-mint"],
          capSemantics: { kind: "unbounded", bound: null },
          claimImpairment: "unbounded",
          economicLossScope: "deployment",
          authority: { authorityKey: `bridge-route:${bridgeDeploymentKey}`, model: "unknown", threshold: null },
          delaySec: null,
          materialSupplyShare: 1,
          incidentState: "none",
          failureDomains: [{ kind: "bridge-route", key: bridgeDeploymentKey }],
        },
        {
          controlKey: mintControlKey,
          deploymentKey: "asset:alpha",
          controlKind: "mint",
          scope: "global",
          capabilities: ["mint"],
          capSemantics: { kind: "raiseable", bound: null },
          claimImpairment: "bounded",
          economicLossScope: "global-claim",
          authority: null,
          delaySec: null,
          materialSupplyShare: null,
          incidentState: "none",
          failureDomains: [],
        },
        {
          controlKey: upgradeControlKey,
          deploymentKey: "asset:alpha",
          controlKind: "upgrade",
          scope: "global",
          capabilities: ["upgrade"],
          capSemantics: { kind: "not-applicable", bound: null },
          claimImpairment: "unbounded",
          economicLossScope: "global-claim",
          authority: {
            authorityKey: "ethereum:0x4444444444444444444444444444444444444444",
            model: "multisig",
            threshold: { required: 3, total: 6 },
          },
          delaySec: null,
          materialSupplyShare: null,
          incidentState: "none",
          failureDomains: [{ kind: "upgrade-control", key: "ethereum:0x4444444444444444444444444444444444444444" }],
        },
      ],
    };
    asset.economicControlReview = {
      ...asset.economicControlReview!,
      mint: {
        status: status("known", "v9.control.mint-review"),
        controlKey: mintControlKey,
        reconciliation: "not-applicable",
        supervision: "unknown",
        upgrade: { state: "reviewed", controlKey: upgradeControlKey },
      },
      bridge: {
        status: {
          applicability: {
            state: "required",
            policyRuleId: "v9.control.bridge-review",
            rationale: null,
            gapId: null,
          },
          observationState: "bounded-unknown",
          evidenceRefIds: ["placeholder:evidence"],
          gapIds: ["extension-gap:bridge:alpha"],
        },
        routes: [],
      },
    };
    asset.supplyReview = {
      selectedBridgeRoutes: [
        {
          deploymentRouteKey: bridgeDeploymentKey,
          supplyUsd: 10_000_000,
          supplyShare: 1,
          reviewState: "selected-unresolved",
        },
      ],
      selectedRouteSupplyShare: 0,
      unknownRouteSupplyShare: 0,
      unreviewedRouteSupplyShare: 1,
      failureDomains: [{ kind: "bridge-route", key: bridgeDeploymentKey }],
    };

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, mixed).assets[0]!;
    expect(compiled.controlStatus).toMatchObject({ observationState: "bounded-unknown" });
    expect(compiled.controls.find((control) => control.controlKey === upgradeControlKey)?.status).toMatchObject({
      observationState: "known",
      gapIds: [],
    });
    for (const unresolvedControlKey of [bridgeControlKey, mintControlKey]) {
      expect(compiled.controls.find((control) => control.controlKey === unresolvedControlKey)?.status).toMatchObject({
        observationState: "bounded-unknown",
        gapIds: [expect.stringContaining(unresolvedControlKey)],
      });
    }

    const evaluated = evaluateV9FactSet(compileSafetyScoreV9FactSetFromFixedInput(fixed, mixed), V9_CANDIDATE_POLICY_V1)
      .assets[0]!;
    expect(evaluated.control.reasons.map((reason) => reason.code)).not.toContain("missing-upgradeability-review");
    expect(evaluated.control.reasons.some((reason) => reason.path.includes(bridgeControlKey))).toBe(true);
    expect(evaluated.control.reasons.some((reason) => reason.path.includes(mintControlKey))).toBe(true);
  });

  it("joins a capped minter to its separately reviewed cap-raising governor", () => {
    const fixed = exactFixedInput();
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "cdp" as const,
            mintAuthority: {
              mintPath: "user-collateralized-governed" as const,
              authorityPosture: "partially-bounded-admin" as const,
              confidence: "verified" as const,
              summary: "A protocol adapter mints within a cap that a separate governor can raise.",
              upgradeability: {
                model: "immutable" as const,
                canChangeMintLogic: false,
                sources: [{ label: "Contract source", url: "https://example.com/source" }],
              },
              controls: [
                {
                  chain: "ethereum",
                  address: "0x1111111111111111111111111111111111111111",
                  label: "Capped protocol minter",
                  role: "direct-minter" as const,
                  authorityType: "contract" as const,
                  directMintAbility: "cap-limited" as const,
                  canRaiseCap: false,
                  sources: [{ label: "Minter docs", url: "https://example.com/minter" }],
                },
                {
                  chain: "ethereum",
                  address: "0x2222222222222222222222222222222222222222",
                  label: "Cap governor",
                  role: "governor" as const,
                  authorityType: "dao-governor" as const,
                  directMintAbility: "parameter-only" as const,
                  canRaiseCap: true,
                  sources: [{ label: "Governance docs", url: "https://example.com/governance" }],
                },
              ],
              review: {
                sources: [{ label: "Minter docs", url: "https://example.com/minter" }],
                evidence: "The capped mint path and the separate cap-raising governor are both reviewed.",
                reviewer: "Fixture reviewer",
                reviewedAt: "1970-01-01",
              },
            },
          },
        ],
      ]),
    });

    const controlReview = baseline.assets[0]!.controlReview;
    expect(controlReview).toMatchObject({ state: "reviewed-controls" });
    if (controlReview?.state !== "reviewed-controls") {
      throw new Error("expected reviewed controls");
    }
    expect(controlReview.controls[0]).toMatchObject({
      capSemantics: { kind: "raiseable", bound: null },
      claimImpairment: "bounded",
    });
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    expect(compiled.assets[0]!.controls[0]!.capSemantics).toEqual({ kind: "raiseable", bound: null });
  });

  it("does not join a capped minter to a cap raiser on another chain", () => {
    const fixed = exactFixedInput();
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "cdp" as const,
            mintAuthority: {
              mintPath: "user-collateralized-governed" as const,
              authorityPosture: "partially-bounded-admin" as const,
              confidence: "verified" as const,
              summary: "A capped minter and an unrelated cross-chain cap raiser.",
              upgradeability: {
                model: "immutable" as const,
                canChangeMintLogic: false,
                sources: [{ label: "Contract source", url: "https://example.com/source" }],
              },
              controls: [
                {
                  chain: "ethereum",
                  address: "0x1111111111111111111111111111111111111111",
                  label: "Ethereum capped minter",
                  role: "direct-minter" as const,
                  authorityType: "contract" as const,
                  directMintAbility: "cap-limited" as const,
                  canRaiseCap: false,
                  sources: [{ label: "Minter docs", url: "https://example.com/minter" }],
                },
                {
                  chain: "arbitrum",
                  address: "0x2222222222222222222222222222222222222222",
                  label: "Arbitrum cap governor",
                  role: "governor" as const,
                  authorityType: "dao-governor" as const,
                  directMintAbility: "parameter-only" as const,
                  canRaiseCap: true,
                  sources: [{ label: "Governance docs", url: "https://example.com/governance" }],
                },
              ],
              review: {
                sources: [{ label: "Minter docs", url: "https://example.com/minter" }],
                evidence: "Both controls are reviewed but operate on different chains.",
                reviewer: "Fixture reviewer",
                reviewedAt: "1970-01-01",
              },
            },
          },
        ],
      ]),
    });

    const controlReview = baseline.assets[0]!.controlReview;
    expect(controlReview).toMatchObject({ state: "partially-reviewed-controls" });
    if (controlReview?.state !== "partially-reviewed-controls") {
      throw new Error("expected partially reviewed controls");
    }
    expect(controlReview.controls[0]).toMatchObject({ capSemantics: { kind: "unknown", bound: null } });
  });

  it("does not infer immutable upgradeability from an immutable mint path", () => {
    const fixed = exactFixedInput();
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "cdp" as const,
            mintAuthority: {
              mintPath: "immutable-user-collateralized" as const,
              authorityPosture: "none-resolved" as const,
              confidence: "verified" as const,
              summary: "Protocol contracts mediate issuance and no privileged issuer minter is resolved.",
              controls: [
                {
                  chain: "ethereum",
                  address: "0x2222222222222222222222222222222222222222",
                  label: "Protocol token",
                  role: "other" as const,
                  authorityType: "contract" as const,
                  directMintAbility: "none" as const,
                  sources: [{ label: "Token docs", url: "https://example.com/token" }],
                },
              ],
              review: {
                sources: [{ label: "Token docs", url: "https://example.com/token" }],
                evidence: "The token mint path is reviewed without a separate upgradeability conclusion.",
                reviewer: "Fixture reviewer",
                reviewedAt: "1970-01-01",
              },
            },
          },
        ],
      ]),
    });
    expect(baseline.assets[0]!.economicControlReview?.mint.upgrade).toEqual({
      state: "unknown",
      controlKey: null,
    });
  });

  it("resolves reviewed zero-share bridge semantics without contaminating the control aggregate", () => {
    const fixed = exactFixedInput();
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "fiat-cash" as const,
            bridgeRouteRisk: {
              tier: "external-lock-mint" as const,
              summary: "A reviewed external bridge route represents the fixture token.",
              reviewedAt: "1970-01-01",
              reviewer: "Fixture reviewer",
              confidence: "verified" as const,
              sources: [{ label: "Bridge docs", url: "https://example.com/bridge" }],
              routes: [
                {
                  id: "ethereum:0x1111111111111111111111111111111111111111",
                  destinationChain: "ethereum",
                  canonicalChain: "ethereum",
                  contractAddress: "0x1111111111111111111111111111111111111111",
                  protocol: "Fixture native issuance",
                  issuanceModel: "native-issuance" as const,
                  routeClass: "native" as const,
                  riskTier: "single-chain-or-native" as const,
                  semantics: "native-mint" as const,
                  scope: "canonical" as const,
                  reviewDisposition: "reviewed" as const,
                  observedAt: "1970-01-01",
                  sources: [{ label: "Bridge docs", url: "https://example.com/bridge" }],
                },
                {
                  id: "base:0x3333333333333333333333333333333333333333",
                  sourceChain: "ethereum",
                  destinationChain: "base",
                  canonicalChain: "ethereum",
                  contractAddress: "0x3333333333333333333333333333333333333333",
                  protocol: "Fixture bridge",
                  issuanceModel: "bridge-representation" as const,
                  routeClass: "third-party" as const,
                  riskTier: "external-lock-mint" as const,
                  semantics: "lock-mint" as const,
                  scope: "peripheral" as const,
                  reviewDisposition: "reviewed" as const,
                  observedAt: "1970-01-01",
                  sources: [{ label: "Bridge docs", url: "https://example.com/bridge" }],
                },
              ],
            },
          },
        ],
      ]),
    });
    expect(baseline.assets[0]!.economicControlReview?.bridge).toMatchObject({
      status: { observationState: "known" },
      routes: [{ tier: "external-lock-mint" }],
    });
    // The reviewed bridge-representation route resolves cap, claim, and incident
    // semantics. Its unknown controller remains visible on the exact zero-share
    // control without making the aggregate partially reviewed.
    const bridgeControl =
      baseline.assets[0]!.controlReview?.state === "reviewed-controls"
        ? baseline.assets[0]!.controlReview.controls[0]
        : null;
    expect(bridgeControl).toMatchObject({
      materialSupplyShare: 0,
      authority: { model: "unknown" },
      capSemantics: { kind: "unbounded" },
      claimImpairment: "unbounded",
      incidentState: "none",
    });
  });

  it("keeps a present empty bridge profile fail-closed on a single exact deployment", () => {
    const fixed = exactFixedInput();
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "fiat-cash" as const,
            bridgeRouteRisk: {
              tier: "opaque-or-unknown" as const,
              summary: "The profile is present but has no reviewed deployment rows.",
              reviewedAt: "1970-01-01",
              reviewer: "Fixture reviewer",
              confidence: "verified" as const,
              sources: [{ label: "Bridge docs", url: "https://example.com/bridge" }],
              routes: [],
            },
          },
        ],
      ]),
    });

    expect(baseline.assets[0]!.supplyReview?.selectedBridgeRoutes).toEqual([
      {
        deploymentRouteKey: "unmatched-chain:alpha:ethereum",
        supplyUsd: 10_000_000,
        supplyShare: 1,
        reviewState: "unmatched",
      },
    ]);
    expect(baseline.assets[0]!.economicControlReview?.bridge.status.observationState).toBe("bounded-unknown");
    expect(baseline.assets[0]!.controlReview).toMatchObject({
      state: "partially-reviewed-controls",
      controls: [expect.objectContaining({ deploymentKey: "unmatched-chain:alpha:ethereum", materialSupplyShare: 1 })],
    });
  });

  it("retains exact route shares while only material unresolved deployments contaminate the control aggregate", () => {
    const totalSupply = 1_000;
    const reviewedShare = 0.05;
    const baselineFor = (unresolvedShare: number | null) => {
      const row = (current: number) => ({
        current,
        circulatingPrevDay: current,
        circulatingPrevWeek: current,
        circulatingPrevMonth: current,
      });
      const fixed = exactFixedInput({
        chainSupplyByChain:
          unresolvedShare === null
            ? {}
            : {
                ethereum: row(totalSupply * (1 - reviewedShare - unresolvedShare)),
                base: row(totalSupply * reviewedShare),
                polygon: row(totalSupply * unresolvedShare),
              },
      });
      const extension = buildSafetyScoreV9BaselineExtension(fixed, {
        metaById: new Map([
          [
            "alpha",
            {
              id: "alpha",
              mechanismArchetype: "fiat-cash" as const,
              bridgeRouteRisk: {
                tier: "canonical-rollup-bridge" as const,
                summary: "A reviewed canonical route coexists with an unresolved peripheral deployment.",
                reviewedAt: "1970-01-01",
                reviewer: "Fixture reviewer",
                confidence: "verified" as const,
                sources: [{ label: "Bridge docs", url: "https://example.com/bridge" }],
                routes: [
                  {
                    id: "ethereum:0x1111111111111111111111111111111111111111",
                    destinationChain: "ethereum",
                    canonicalChain: "ethereum",
                    contractAddress: "0x1111111111111111111111111111111111111111",
                    protocol: "Fixture native issuance",
                    issuanceModel: "native-issuance" as const,
                    routeClass: "native" as const,
                    riskTier: "single-chain-or-native" as const,
                    semantics: "native-mint" as const,
                    scope: "canonical" as const,
                    reviewDisposition: "reviewed" as const,
                    observedAt: "1970-01-01",
                    sources: [{ label: "Bridge docs", url: "https://example.com/bridge" }],
                  },
                  {
                    id: "base:0x2222222222222222222222222222222222222222",
                    sourceChain: "ethereum",
                    destinationChain: "base",
                    canonicalChain: "ethereum",
                    contractAddress: "0x2222222222222222222222222222222222222222",
                    protocol: "Fixture canonical bridge",
                    issuanceModel: "bridge-representation" as const,
                    routeClass: "canonical" as const,
                    riskTier: "canonical-rollup-bridge" as const,
                    semantics: "lock-mint" as const,
                    scope: "peripheral" as const,
                    reviewDisposition: "reviewed" as const,
                    observedAt: "1970-01-01",
                    sources: [{ label: "Bridge docs", url: "https://example.com/bridge" }],
                  },
                  {
                    id: "polygon:0x3333333333333333333333333333333333333333",
                    destinationChain: "polygon",
                    contractAddress: "0x3333333333333333333333333333333333333333",
                    protocol: "Unresolved fixture route",
                    issuanceModel: "unknown" as const,
                    routeClass: "unknown" as const,
                    riskTier: "opaque-or-unknown" as const,
                    semantics: "unknown" as const,
                    scope: "unknown" as const,
                    reviewDisposition: "unresolved" as const,
                    reviewNote: "The route controller and issuance semantics remain unresolved.",
                    observedAt: "1970-01-01",
                  },
                ],
              },
            },
          ],
        ]),
      });
      return { fixed, extension, asset: extension.assets[0]! };
    };

    const threshold = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.deploymentMaterialSharePct / 100;
    const peripheralFixture = baselineFor(threshold - 0.001);
    const peripheral = peripheralFixture.asset;
    expect(peripheral.controlReview).toMatchObject({ state: "reviewed-controls" });
    expect(peripheral.economicControlReview?.bridge.status.observationState).toBe("known");
    if (peripheral.controlReview?.state !== "reviewed-controls") {
      throw new Error("expected below-threshold deployment controls to be reviewed");
    }
    expect(
      peripheral.controlReview.controls.find((control) => control.deploymentKey.startsWith("base:")),
    ).toMatchObject({ materialSupplyShare: reviewedShare });
    expect(
      peripheral.controlReview.controls.find((control) => control.deploymentKey.startsWith("polygon:")),
    ).toMatchObject({
      materialSupplyShare: threshold - 0.001,
      capSemantics: { kind: "unknown" },
      claimImpairment: "unknown",
      incidentState: "unknown",
    });
    const compiledPeripheral = compileSafetyScoreV9FactSetFromFixedInput(
      peripheralFixture.fixed,
      peripheralFixture.extension,
    ).assets[0]!;
    expect(compiledPeripheral.controlStatus).toMatchObject({ observationState: "known" });
    expect(compiledPeripheral.controls.find((control) => control.deploymentKey.startsWith("base:"))).toMatchObject({
      authority: { model: "unknown" },
      status: { observationState: "bounded-unknown" },
    });
    const compiledPeripheralUnresolved = compiledPeripheral.controls.find((control) =>
      control.deploymentKey.startsWith("polygon:"),
    )!;
    expect(compiledPeripheralUnresolved.status).toMatchObject({ observationState: "bounded-unknown" });
    expect(compiledPeripheralUnresolved.status.gapIds).toHaveLength(1);
    expect(
      evaluateV9FactSet(
        compileSafetyScoreV9FactSetFromFixedInput(peripheralFixture.fixed, peripheralFixture.extension),
        V9_CANDIDATE_POLICY_V1,
      ).assets[0]!.control.reasons.some((reason) => reason.path.includes(compiledPeripheralUnresolved.controlKey)),
    ).toBe(false);

    for (const unresolvedShare of [threshold, threshold + 0.01, null]) {
      const materialFixture = baselineFor(unresolvedShare);
      const material = materialFixture.asset;
      expect(material.controlReview).toMatchObject({ state: "partially-reviewed-controls" });
      expect(material.economicControlReview?.bridge.status.observationState).toBe("bounded-unknown");
      const compiledMaterial = compileSafetyScoreV9FactSetFromFixedInput(
        materialFixture.fixed,
        materialFixture.extension,
      );
      const evaluatedMaterial = evaluateV9FactSet(compiledMaterial, V9_CANDIDATE_POLICY_V1).assets[0]!;
      expect(evaluatedMaterial.control.reasons.some((reason) => reason.code === "unresolved-control-identity")).toBe(
        true,
      );
    }
  });

  it("exempts only complete independently subthreshold unmatched bridge inventories", () => {
    const row = (current: number) => ({
      current,
      circulatingPrevDay: current,
      circulatingPrevWeek: current,
      circulatingPrevMonth: current,
    });
    const route = (id: string, disposition: "reviewed" | "unresolved" = "unresolved") => ({
      id,
      destinationChain: id.slice(0, id.indexOf(":")),
      contractAddress: id.slice(id.indexOf(":") + 1),
      protocol: disposition === "reviewed" ? "Fixture native issuance" : "Unresolved fixture route",
      issuanceModel: disposition === "reviewed" ? ("native-issuance" as const) : ("unknown" as const),
      routeClass: disposition === "reviewed" ? ("native" as const) : ("unknown" as const),
      riskTier: disposition === "reviewed" ? ("single-chain-or-native" as const) : ("opaque-or-unknown" as const),
      semantics: disposition === "reviewed" ? ("native-mint" as const) : ("unknown" as const),
      scope: disposition === "reviewed" ? ("canonical" as const) : ("unknown" as const),
      reviewDisposition: disposition,
      reviewNote: disposition === "unresolved" ? "The route semantics remain unresolved." : undefined,
      observedAt: "1970-01-01",
      sources: disposition === "reviewed" ? [{ label: "Bridge docs", url: "https://example.com/bridge" }] : undefined,
    });
    const baselineFor = (chainShares: Record<string, number>, extraRoutes: ReturnType<typeof route>[] = []) => {
      const fixed = exactFixedInput({
        chainSupplyByChain: Object.fromEntries(
          Object.entries(chainShares).map(([chain, share]) => [chain, row(share * 10_000)]),
        ),
      });
      const extension = buildSafetyScoreV9BaselineExtension(fixed, {
        metaById: new Map([
          [
            "alpha",
            {
              id: "alpha",
              mechanismArchetype: "fiat-cash" as const,
              bridgeRouteRisk: {
                tier: "canonical-rollup-bridge" as const,
                summary: "Fixture bridge inventory for exact deployment materiality.",
                reviewedAt: "1970-01-01",
                reviewer: "Fixture reviewer",
                confidence: "verified" as const,
                sources: [{ label: "Bridge docs", url: "https://example.com/bridge" }],
                routes: [route("ethereum:0x1111111111111111111111111111111111111111", "reviewed"), ...extraRoutes],
              },
            },
          ],
        ]),
      });
      return { fixed, extension, asset: extension.assets[0]! };
    };

    const independent = baselineFor({
      ethereum: 0.5005,
      base: 0.0999,
      polygon: 0.0999,
      arbitrum: 0.0999,
      optimism: 0.0999,
      avalanche: 0.0999,
    });
    expect(independent.asset.economicControlReview?.bridge.status.observationState).toBe("known");
    expect(independent.asset.controlReview).toMatchObject({ state: "reviewed-controls" });
    const independentControls =
      independent.asset.controlReview?.state === "reviewed-controls"
        ? independent.asset.controlReview.controls.filter((control) => control.controlKind === "bridge")
        : [];
    expect(independentControls).toHaveLength(5);
    expect(independentControls.every((control) => control.materialSupplyShare === 0.0999)).toBe(true);
    const independentEvaluation = evaluateV9FactSet(
      compileSafetyScoreV9FactSetFromFixedInput(independent.fixed, independent.extension),
      V9_CANDIDATE_POLICY_V1,
    ).assets[0]!;
    expect(
      independentEvaluation.control.reasons.some((reason) => reason.code === "material-bridge-supply-unmatched"),
    ).toBe(false);

    const exactThreshold = baselineFor({ ethereum: 0.9, base: 0.1 });
    expect(exactThreshold.asset.economicControlReview?.bridge.status.observationState).toBe("bounded-unknown");

    const pooledBelow = baselineFor({ ethereum: 0.9001, "Future Chain": 0.0499, future_chain: 0.05 });
    expect(pooledBelow.asset.economicControlReview?.bridge.status.observationState).toBe("known");
    expect(
      pooledBelow.asset.supplyReview?.selectedBridgeRoutes.find((candidate) => candidate.reviewState === "unmatched"),
    ).toMatchObject({ deploymentRouteKey: "unmatched-chain-label-pool:alpha", supplyShare: 0.0999 });

    const pooledAtThreshold = baselineFor({ ethereum: 0.9, "Future Chain": 0.05, future_chain: 0.05 });
    expect(pooledAtThreshold.asset.economicControlReview?.bridge.status.observationState).toBe("bounded-unknown");

    const ambiguous = baselineFor({ ethereum: 0.95, base: 0.05 }, [
      route("base:0x2222222222222222222222222222222222222222"),
      route("base:0x3333333333333333333333333333333333333333"),
    ]);
    expect(ambiguous.asset.supplyReview?.selectedBridgeRoutes).toContainEqual(
      expect.objectContaining({ deploymentRouteKey: "ambiguous-chain:alpha:base", supplyShare: 0.05 }),
    );
    expect(ambiguous.asset.economicControlReview?.bridge.status.observationState).toBe("bounded-unknown");

    const canonicalOrphan = baselineFor({ ethereum: 1 }, [
      route("hyperevm:0x4444444444444444444444444444444444444444"),
    ]);
    expect(canonicalOrphan.asset.economicControlReview?.bridge.status.observationState).toBe("known");
    expect(
      canonicalOrphan.asset.controlReview?.state === "reviewed-controls"
        ? canonicalOrphan.asset.controlReview.controls.find((control) => control.deploymentKey.startsWith("hyperevm:"))
        : null,
    ).toMatchObject({ materialSupplyShare: 0, capSemantics: { kind: "unknown" } });

    const uncanonicalizableOrphan = baselineFor({ ethereum: 1 }, [
      route("futurechain:0x5555555555555555555555555555555555555555"),
    ]);
    expect(uncanonicalizableOrphan.asset.economicControlReview?.bridge.status.observationState).toBe("bounded-unknown");
  });

  it("does not let an unresolved access-only control contaminate a resolved aggregate", () => {
    const fixed = exactFixedInput();
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "cdp" as const,
            mintAuthority: {
              mintPath: "immutable-user-collateralized" as const,
              authorityPosture: "none-resolved" as const,
              confidence: "verified" as const,
              summary: "Immutable user issuance includes a non-claiming control with no privileged authority identity.",
              upgradeability: {
                model: "immutable" as const,
                canChangeMintLogic: false,
                sources: [{ label: "Token source", url: "https://example.com/token" }],
              },
              controls: [
                {
                  label: "Non-claiming protocol surface",
                  role: "other" as const,
                  authorityType: "none" as const,
                  directMintAbility: "none" as const,
                  canRaiseCap: false,
                  sources: [{ label: "Token source", url: "https://example.com/token" }],
                },
              ],
              review: {
                sources: [{ label: "Token source", url: "https://example.com/token" }],
                evidence: "The reviewed surface cannot mint or impair the protocol claim.",
                reviewer: "Fixture reviewer",
                reviewedAt: "1970-01-01",
              },
            },
          },
        ],
      ]),
    });

    expect(baseline.assets[0]!.controlReview).toMatchObject({
      state: "reviewed-controls",
      controls: [
        expect.objectContaining({
          economicLossScope: "access-only",
          authority: null,
        }),
      ],
    });
  });

  it("rejects registry drift, future reviews, and stale evidence claimed as known", () => {
    const fixed = exactFixedInput();
    expect(() =>
      buildSafetyScoreV9BaselineExtension(fixed, {
        registryFingerprint: "f".repeat(64),
        metaById: new Map([["alpha", { id: "alpha", mechanismArchetype: "fiat-cash" as const }]]),
      }),
    ).toThrow(/registry fingerprint/);
    expect(() =>
      buildSafetyScoreV9BaselineExtension(fixed, {
        metaById: new Map([
          [
            "alpha",
            {
              id: "alpha",
              mechanismArchetype: "fiat-cash" as const,
              blacklistabilityReview: {
                reviewedStatus: true,
                sourceFreeRationale: "Fixture-only review.",
                evidence: "This future-dated review must not enter an earlier candidate.",
                reviewer: "Fixture reviewer",
                reviewedAt: "2026-07-14",
              },
            },
          ],
        ]),
      }),
    ).toThrow(/later than the scoring clock/);

    const staleKnown = extension();
    staleKnown.assets[0]!.researchEvidence = [
      {
        evidenceKey: "stale-control-review",
        sourceId: "fixture.stale-control-review",
        observedAtSec: 8_000,
        publishedAtSec: null,
        url: "https://example.com/stale",
        contentSha256: "a".repeat(64),
        confidence: "verified",
        maxAgeSec: 500,
      },
    ];
    staleKnown.assets[0]!.componentEvidence = [{ componentKey: "control", evidenceKeys: ["stale-control-review"] }];
    expect(() => compileSafetyScoreV9FactSetFromFixedInput(fixed, staleKnown)).toThrow(/cannot be known with stale/);
  });

  it("exports stable reserve exposure identities for exact overlay joins", () => {
    const slice = exactFixedInput().liveReserveMap.alpha![0]!;
    expect(computeSafetyScoreV9ReserveExposureKey(slice)).toMatch(/^reserve:[a-f0-9]{24}$/);
    expect(computeSafetyScoreV9ReserveExposureKey({ ...slice, pct: 50 })).toBe(
      computeSafetyScoreV9ReserveExposureKey(slice),
    );
  });
});
