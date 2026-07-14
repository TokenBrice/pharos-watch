import { describe, expect, it } from "vitest";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
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

function route(routeId = "dex:primary", observedAt = OBSERVED_AT_SEC): ExitRouteObservation {
  return {
    routeId,
    routeFamily: "dex-amm",
    scope: { kind: "chain-contract", chain: "ethereum", contractOrPoolId: routeId, protocol: "fixture-dex" },
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

function exactFixedInput(args: { liquidityScore?: number; classifiedReserve?: boolean; omitPegRow?: boolean } = {}) {
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
    pegDataById: args.omitPegRow ? {} : {
      alpha: {
        id: "alpha",
        symbol: "ALPHA",
        name: "Alpha",
        pegType: "peggedUSD",
        pegCurrency: "USD",
        governance: "centralized",
        currentDeviationBps: 1,
        pegScore: 99,
        priceSource: "fixture-price",
        priceObservedAt: OBSERVED_AT_SEC,
        pegPct: 99,
        severityScore: 0,
        spreadPenalty: 0,
        eventCount: 0,
        worstDeviationBps: 1,
        activeDepeg: false,
        lastEventAt: null,
        trackingSpanDays: 365,
        methodologyVersion: "peg:fixture-v1",
      },
    },
    activeDepegPeakBpsById: {},
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
        exitRouteObservations: [route()],
        exitRouteObservationCoverage: {
          status: "populated",
          capabilityMatrixVersion: "fixture-v1",
          retainedPoolCount: 1,
          observationCount: 1,
          scoreEligibleObservationCount: 1,
          scoreEligiblePoolCount: 1,
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
      alpha: {
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

function exactTwoAssetFixedInput(options: { mapAlphaCollateral?: boolean } = {}) {
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
      ...alpha.liveReserveMap,
      ...(options.mapAlphaCollateral
        ? {
            alpha: [
              {
                name: "Beta stablecoin",
                pct: 50,
                risk: "low" as const,
                coinId: "beta",
                depType: "collateral" as const,
                assetClass: "stablecoin" as const,
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
          unknownRouteSupplyShare: 0,
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
      expect.arrayContaining(["missing-pillar-evidence"]),
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
      expect.arrayContaining([expect.objectContaining({ trackedAssetId: "beta", weight: 0.5 })]),
    );
    expect(
      evaluateV9FactSet(compiledMapped, V9_CANDIDATE_POLICY_V1)
        .assets.find((asset) => asset.assetId === "alpha")!
        .scoreInput.dependencyReasons.map((reason) => reason.code),
    ).not.toContain("unreviewed-dependency-relationships");

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
    expect(alpha.mechanismRiskReview.review?.archetype).toBe("fiat-cash");
    expect(alpha.economicControlReview.mint.status.applicability.state).toBe("not-applicable");
    expect(alpha.accessReview.transfer.posture).toBe("permissionless");
    expect(alpha.reserveStatus.observationState).toBe("known");
    expect(alpha.supply).toMatchObject({
      sourceKind: "usd-denominated-circulating",
      referencePriceUsd: null,
      circulatingUsd: 10_000_000,
    });
    expect(alpha.exitRoutes[0]).toMatchObject({
      routeId: "dex:primary",
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

  it("resolves reviewed bridge route semantics while an unknown controller keeps the control partially reviewed", () => {
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
                  id: "ethereum-to-base",
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
    // semantics, but the controller address is unknown, so the control stays
    // partially reviewed and its authority model is unknown.
    const bridgeControl =
      baseline.assets[0]!.controlReview?.state === "partially-reviewed-controls"
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
