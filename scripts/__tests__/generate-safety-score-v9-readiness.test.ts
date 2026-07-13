import { describe, expect, it } from "vitest";
import type { DexLiquidityMap, ExitRouteObservation } from "@shared/types/market";
import type { RedemptionBackstopMap } from "@shared/types/redemption";
import type { CompiledV9AssetInput } from "@shared/types/safety-score-v9";
import { HistoricalV9FixtureCorpusSchema } from "@shared/types/safety-score-v9";
import { ReportCardsResponseSchema, type ReportCardsResponse } from "@shared/types/report-cards";
import historicalFixtures from "@shared/data/safety-score-v9/historical-fixtures-v1.json";
import {
  computeDexLiquidityPayloadFingerprint,
  computeRedemptionPayloadFingerprint,
  computeReportCardsRegistryFingerprint,
} from "@shared/lib/report-cards-fixed-input-identity";
import { deriveReportCardsBaseInputGenerationId } from "@shared/lib/report-cards-base-input-identity";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9-research";
import {
  assessFixedInputProvenance,
  assessHistoricalEvidenceIntegrity,
  assessReadinessInputBindings,
  applyCalibratedDexEligibility,
  buildExitRouteObservationMap,
  buildExitRouteObservationSet,
  buildManualInputAudit,
  evaluateCalibrationActivationBlockers,
  evaluateP4CoverageBlockers,
  parseFixedPublicationInput,
  selectExactActiveReportCards,
  summarizeHistoricalRateabilityByOutcome,
  summarizeRedemptionObservationCoverage,
  summarizeRouteObservationCoverage,
} from "../maintenance/generate-safety-score-v9-readiness";

const FIXTURE_CLOCK_SEC = 1_000;
const FIXTURE_DEX_UPDATED_AT = 900;
const FIXTURE_REDEMPTION_UPDATED_AT = 850;

function exactFixedInputFixture() {
  const dexGenerationId = `dex-liquidity-${FIXTURE_DEX_UPDATED_AT}`;
  const redemptionGenerationId = "redemption:fixture-generation";
  const dexLiqMap = {
    asset: {
      liquidityScore: 50,
      concentrationHhi: null,
      poolCount: 1,
      chainCount: 1,
      methodologyVersion: "dex-fixture-v1",
      updatedAt: FIXTURE_DEX_UPDATED_AT,
    },
  };
  const redemptionBackstopMap: RedemptionBackstopMap = {
    asset: {
      stablecoinId: "asset",
      score: 80,
      effectiveExitScore: 80,
      dexLiquidityScore: 50,
      accessScore: 80,
      settlementScore: 80,
      executionCertaintyScore: 80,
      capacityScore: 80,
      outputAssetQualityScore: 80,
      costScore: 80,
      routeFamily: "offchain-issuer",
      accessModel: "issuer-api",
      settlementModel: "same-day",
      executionModel: "rules-based-nav",
      outputAssetType: "stable-single",
      provider: "fixture",
      sourceMode: "static",
      resolutionState: "resolved",
      routeStatus: "open",
      routeStatusSource: "static-config",
      holderEligibility: "verified-customer",
      capacityConfidence: "documented-bound",
      capacitySemantics: "immediate-bounded",
      feeConfidence: "fixed",
      feeModelKind: "fixed-bps",
      modelConfidence: "high",
      immediateCapacityUsd: 1_000_000,
      immediateCapacityRatio: 1,
      feeBps: 0,
      queueEnabled: false,
      methodologyVersion: "redemption-fixture-v1",
      updatedAt: FIXTURE_REDEMPTION_UPDATED_AT,
    },
  };
  const input = {
    schemaVersion: 3 as const,
    captureKind: "exact-publication-inputs" as const,
    capturedAt: "2026-07-13T01:00:00.000Z",
    sourceGeneration: "report-cards:fixture",
    registryRevision: "fixture-revision",
    registryFingerprint: computeReportCardsRegistryFingerprint(),
    methodologyVersion: "safety-fixture-v1",
    clockSec: FIXTURE_CLOCK_SEC,
    updatedAt: FIXTURE_CLOCK_SEC,
    liquidityStale: false,
    redemptionStale: false,
    inputFreshness: {
      dexLiquidity: { updatedAt: FIXTURE_DEX_UPDATED_AT, ageSeconds: 100, stale: false },
      redemptionBackstops: { updatedAt: FIXTURE_REDEMPTION_UPDATED_AT, ageSeconds: 150, stale: false },
    },
    pegDataById: { asset: { methodologyVersion: "peg-fixture-v1" } },
    activeDepegPeakBpsById: {},
    dexLiqMap,
    redemptionBackstopMap,
    bluechipMap: {},
    resolvedBlacklistStatuses: {},
    liveReserveMap: {},
    liveReserveProvenanceMap: {},
    chainCirculatingById: {},
    dexDeploymentSupplyCoverageById: {},
    activeAssetIds: ["asset"],
    dexGenerationId,
    redemptionGenerationId,
    dexPayloadFingerprint: computeDexLiquidityPayloadFingerprint(dexLiqMap, dexGenerationId),
    redemptionPayloadFingerprint: computeRedemptionPayloadFingerprint(redemptionBackstopMap, redemptionGenerationId),
    inputMethodologyVersions: {
      safetyScore: "safety-fixture-v1",
      dexLiquidity: ["dex-fixture-v1"],
      pegScore: ["peg-fixture-v1"],
      redemptionBackstop: ["redemption-fixture-v1"],
    },
  };
  return { ...input, baseInputGenerationId: deriveReportCardsBaseInputGenerationId(input) };
}

function reportCardsFixture(fixedInput: ReturnType<typeof parseFixedPublicationInput>): ReportCardsResponse {
  const dimension = { grade: "A" as const, score: 90, detail: "Fixture evidence." };
  return ReportCardsResponseSchema.parse({
    cards: [
      {
        id: "asset",
        name: "Asset",
        symbol: "AST",
        overallGrade: "A",
        overallScore: 90,
        baseScore: 90,
        dimensions: {
          pegStability: dimension,
          liquidity: dimension,
          resilience: dimension,
          decentralization: dimension,
          dependencyRisk: dimension,
        },
        ratedDimensions: 5,
        rawInputs: {
          pegScore: 90,
          activeDepeg: false,
          depegEventCount: 0,
          lastEventAt: null,
          liquidityScore: 90,
          effectiveExitScore: 90,
          redemptionBackstopScore: 90,
          redemptionRouteFamily: "offchain-issuer",
          redemptionModelConfidence: "high",
          redemptionUsedForLiquidity: true,
          redemptionImmediateCapacityUsd: 1_000_000,
          redemptionImmediateCapacityRatio: 1,
          concentrationHhi: null,
          bluechipGrade: null,
          canBeBlacklisted: false,
          chainTier: "ethereum",
          deploymentModel: "single-chain",
          collateralQuality: "native",
          custodyModel: "onchain",
          governanceTier: "decentralized",
          governanceQuality: "immutable-code",
          dependencies: [],
          navToken: false,
        },
        isDefunct: false,
      },
    ],
    methodology: {
      version: "8.17",
      weights: {
        pegStability: 0.2,
        liquidity: 0.2,
        resilience: 0.2,
        decentralization: 0.2,
        dependencyRisk: 0.2,
      },
      pegMultiplierExponent: 1,
      thresholds: [{ grade: "A", min: 80 }],
    },
    dependencyGraph: { edges: [] },
    updatedAt: fixedInput.updatedAt,
    liquidityStale: fixedInput.liquidityStale,
    redemptionStale: fixedInput.redemptionStale,
    inputFreshness: fixedInput.inputFreshness,
  });
}

function assessExactFixedInput(
  value: ReturnType<typeof exactFixedInputFixture>,
  reportCardsValue?: ReportCardsResponse,
): string[] {
  const fixedInput = parseFixedPublicationInput(value);
  const reportCards = reportCardsValue ?? reportCardsFixture(fixedInput);
  return assessReadinessInputBindings({
    fixedInput,
    reportCards,
    activeIds: ["asset"],
    suppliedEvidenceTimes: [],
  });
}

describe("v9 readiness audit helpers", () => {
  it("rejects a capture-kind-only artifact before provenance assessment", () => {
    expect(() =>
      parseFixedPublicationInput({
        schemaVersion: 3,
        captureKind: "exact-publication-inputs",
        capturedAt: "2026-07-13T01:00:00.000Z",
        redemptionBackstopMap: {},
      }),
    ).toThrow();
  });

  it("fails closed unless the replay input is a schema-v3 exact publication capture", () => {
    const fixed = (value: unknown) => value as Parameters<typeof assessFixedInputProvenance>[0];

    expect(
      assessFixedInputProvenance(
        fixed({ schemaVersion: 1, capturedAt: "2026-07-13T01:00:00.000Z", redemptionBackstopMap: {} }),
      ),
    ).toMatchObject({
      schemaVersion: 1,
      captureKind: "legacy-unverified",
      exactPublicationInputs: false,
      blockers: ["Fixed replay input is schema v1 legacy-unverified, not schema v3 exact-publication-inputs"],
    });
    expect(
      assessFixedInputProvenance(
        fixed({
          schemaVersion: 3,
          captureKind: "public-reconstruction",
          capturedAt: "2026-07-13T01:00:00.000Z",
          redemptionBackstopMap: {},
        }),
      ).blockers,
    ).toHaveLength(1);
    expect(
      assessFixedInputProvenance(
        fixed({
          schemaVersion: 3,
          captureKind: "exact-publication-inputs",
          capturedAt: "2026-07-13T01:00:00.000Z",
          redemptionBackstopMap: {},
        }),
      ),
    ).toMatchObject({ exactPublicationInputs: true, blockers: [] });
  });

  it("recomputes schema-v3 DEX payload identity instead of trusting the declared fingerprint", () => {
    const input = exactFixedInputFixture();
    input.dexLiqMap.asset.liquidityScore = 51;

    expect(assessExactFixedInput(input)).toContainEqual(
      expect.stringMatching(/^Fixed input DEX payload fingerprint .* does not match payload /),
    );
  });

  it("binds the model-neutral base generation to the normalized score-bearing payload", () => {
    const input = exactFixedInputFixture();
    input.pegDataById.asset.methodologyVersion = "peg-fixture-v2";

    expect(assessExactFixedInput(input)).toContainEqual(
      expect.stringMatching(/^Fixed input base generation .* does not match payload /),
    );
  });

  it("binds redemption payload identity to its producer generation", () => {
    const input = exactFixedInputFixture();
    input.redemptionGenerationId = "redemption:tampered-generation";

    expect(assessExactFixedInput(input)).toContainEqual(
      expect.stringMatching(/^Fixed input redemption payload fingerprint .* does not match payload /),
    );
  });

  it("recomputes the normalized report-card replay fingerprint", () => {
    const input = exactFixedInputFixture();
    const fixedInput = parseFixedPublicationInput(input);
    const baselineReplay = reportCardsFixture(fixedInput);
    const mutatedReplay = structuredClone(baselineReplay);
    mutatedReplay.cards[0]!.dimensions.pegStability.score = 89;
    const replayBlocker = (report: ReportCardsResponse) =>
      assessExactFixedInput(input, report).find((blocker) =>
        blocker.startsWith("Report-card replay payload fingerprint"),
      );

    expect(replayBlocker(baselineReplay)).toMatch(/does not match calibrated/);
    expect(replayBlocker(mutatedReplay)).toMatch(/does not match calibrated/);
    expect(replayBlocker(mutatedReplay)).not.toBe(replayBlocker(baselineReplay));
  });

  it("derives producer methodology versions from the score-bearing payloads", () => {
    const input = exactFixedInputFixture();
    expect(assessExactFixedInput(input)).not.toContain(
      "Fixed input producer methodology versions do not match the score-bearing payloads",
    );
    input.inputMethodologyVersions.pegScore = ["peg-fixture-v2"];

    expect(assessExactFixedInput(input)).toContain(
      "Fixed input producer methodology versions do not match the score-bearing payloads",
    );
  });

  it("rejects schema-v3 captures with an empty producer methodology lane", () => {
    for (const lane of ["dexLiquidity", "pegScore", "redemptionBackstop"] as const) {
      const input = exactFixedInputFixture();
      input.inputMethodologyVersions[lane] = [];
      expect(() => parseFixedPublicationInput(input)).toThrow();
    }
  });

  it("combines DEX and redemption observations for the live compiler boundary", () => {
    const dexObservation: ExitRouteObservation = {
      routeId: "dex:a",
      routeFamily: "dex-amm",
      scope: { kind: "chain-contract", chain: "ethereum", contractOrPoolId: "pool-a", protocol: "amm" },
      requestedNotionalUsd: 10_000,
      settlementHorizonSec: 300,
      maxCostBps: 200,
      scoreEligible: true,
      executableUsd: 1_000,
      completionRatio: 0.1,
      output: { kind: "fiat", currency: "USD" },
      evidenceKind: "reserve-based-amm-simulation",
      confidence: "high",
      observedAt: 1_000,
      freshnessSeconds: 60,
      commonModeKeys: [],
    };
    const redemptionObservation: ExitRouteObservation = {
      ...dexObservation,
      routeId: "redeem:a",
      routeFamily: "issuer-redemption",
      scope: { kind: "issuer", issuerId: "issuer-a" },
      executableUsd: 2_000,
      completionRatio: 0.2,
      evidenceKind: "documented-terms",
    };
    const dexMap = {
      asset: { exitRouteObservations: [dexObservation] },
      inactive: { exitRouteObservations: [{ ...dexObservation, routeId: "dex:inactive" }] },
    } as unknown as DexLiquidityMap;
    const redemptionMap = {
      asset: { capacityProfile: { exitRouteObservations: [redemptionObservation] } },
      redemptionOnly: {
        capacityProfile: { exitRouteObservations: [{ ...redemptionObservation, routeId: "redeem:b" }] },
      },
    } as unknown as Parameters<typeof buildExitRouteObservationMap>[1];
    const activeIds = new Set(["asset", "redemptionOnly"]);

    const combined = buildExitRouteObservationMap(dexMap, redemptionMap, activeIds);
    expect(combined.get("asset")?.map((observation) => observation.routeId)).toEqual(["dex:a", "redeem:a"]);
    expect(combined.get("redemptionOnly")?.map((observation) => observation.routeId)).toEqual(["redeem:b"]);
    expect(combined.has("inactive")).toBe(false);
    expect(buildExitRouteObservationSet(dexMap, redemptionMap, activeIds).summary).toMatchObject({
      dex: { assetCount: 1, observationCount: 1, resolvedAssetOutputCount: 1 },
      redemption: { assetCount: 2, observationCount: 2, resolvedAssetOutputCount: 2 },
    });
    expect(summarizeRedemptionObservationCoverage(redemptionMap, activeIds)).toEqual({
      assets: 2,
      observations: 2,
      scoreEligibleObservations: 2,
      scoreEligibleAssets: 2,
    });
  });

  it("reports mutable sources and unverified historical authoring as no-go evidence blockers", () => {
    const corpus = HistoricalV9FixtureCorpusSchema.parse(historicalFixtures);
    const integrity = assessHistoricalEvidenceIntegrity(corpus.fixtures);

    expect(integrity).toMatchObject({
      sourceCount: 26,
      sourceCaptureStatuses: { unarchived: 26 },
      blindingModes: { "retrospective-unverified": 26 },
      outcomeAccess: { "not-attested": 26 },
      chronologyValidation: "passed",
      immutabilityValidation: "blocked",
      blindingValidation: "blocked",
    });
    expect(integrity.blockers).toEqual([
      "26 historical sources are mutable and unarchived",
      "26 historical fixtures lack independently verified outcome blinding",
      "26 fact-freeze records lack an outcome-access attestation",
    ]);
  });

  it("reports rateable and NR denominators separately for adverse and resilient history", () => {
    expect(
      summarizeHistoricalRateabilityByOutcome([
        { classification: "adverse", score: 30 },
        { classification: "adverse", score: null },
        { classification: "resilient", score: 82 },
        { classification: "resilient", score: null },
        { classification: "resilient", score: null },
      ]),
    ).toEqual({
      adverse: { fixtureCount: 2, rateableCount: 1, nrCount: 1 },
      resilient: { fixtureCount: 3, rateableCount: 1, nrCount: 2 },
    });
  });

  it("requires the calibration artifact itself to authorize activation", () => {
    expect(
      evaluateCalibrationActivationBlockers({
        decision: "activate",
        activationReady: true,
        decisionConsistentWithGate: true,
        blockers: [],
      }),
    ).toEqual([]);

    expect(
      evaluateCalibrationActivationBlockers({
        decision: "hold",
        activationReady: false,
        decisionConsistentWithGate: true,
        blockers: ["producer-generation-incomplete"],
      }),
    ).toEqual([
      "P4 calibration decision is hold, not activate",
      "P4 calibration activation gate is not ready",
      "P4 calibration blocker: producer-generation-incomplete",
    ]);
  });

  it("reports every manual input with computed class and criticality", () => {
    const compiled = [
      {
        assetId: "asset-b",
        unresolved: [
          {
            code: "unsupported-same-notional-route",
            reason: "No exact adapter.",
            critical: true,
            path: "exitRouteObservations",
          },
        ],
        peg: { unresolved: [] },
        pillars: {
          backing: {
            unresolved: [
              {
                code: "material-reserve-slice-unstructured",
                reason: "Missing reserve fields.",
                critical: true,
              },
            ],
          },
          exit: { unresolved: [] },
          control: {
            unresolved: [
              {
                code: "correlated-exit-routes",
                reason: "Shared operator.",
                critical: false,
              },
            ],
          },
        },
      },
    ] as unknown as CompiledV9AssetInput[];

    const audit = buildManualInputAudit(compiled, V9_CANDIDATE_POLICY_V1);
    expect(audit.total).toBe(3);
    expect(audit.byClass).toEqual({
      "missing-data": 1,
      "unresolved-methodology": 1,
      "unsupported-design": 1,
    });
    expect(audit.byCriticality).toEqual({ critical: 1, noncritical: 2 });
    expect(audit.items.map((item) => item.code)).toEqual([
      "material-reserve-slice-unstructured",
      "correlated-exit-routes",
      "unsupported-same-notional-route",
    ]);
  });

  it("enforces calibrated coverage floors even when coverage is nonzero", () => {
    expect(
      evaluateP4CoverageBlockers({
        dexEligibleAssets: 6,
        redemptionEligibleAssets: 31,
        minimumDexEligibleAssets: 45,
        minimumRedemptionEligibleAssets: 27,
      }),
    ).toEqual(["DEX same-notional coverage is 6 eligible assets; calibrated floor is 45"]);
    expect(
      evaluateP4CoverageBlockers({
        dexEligibleAssets: 45,
        redemptionEligibleAssets: 27,
        minimumDexEligibleAssets: 45,
        minimumRedemptionEligibleAssets: 27,
      }),
    ).toEqual([]);
  });

  it("counts route eligibility by asset rather than observation count", () => {
    const eligibleObservation = {
      routeId: "route-1",
      scoreEligible: true,
      executableUsd: 100,
    };
    const dexMap = {
      eligible: {
        exitRouteObservations: [eligibleObservation, { ...eligibleObservation, routeId: "route-2" }],
        exitRouteObservationCoverage: { status: "populated", retainedPoolCount: 2 },
      },
      unsupported: {
        exitRouteObservations: [],
        exitRouteObservationCoverage: { status: "unsupported", retainedPoolCount: 1 },
      },
      inactive: {
        exitRouteObservations: [eligibleObservation],
        exitRouteObservationCoverage: { status: "populated", retainedPoolCount: 1 },
      },
    } as unknown as DexLiquidityMap;

    expect(summarizeRouteObservationCoverage(dexMap, new Set(["eligible", "unsupported"]))).toMatchObject({
      assets: 2,
      retainedPoolAssets: 2,
      retainedPools: 3,
      observations: 2,
      scoreEligibleObservations: 2,
      dexEligibleAssets: 1,
      statuses: { populated: 1, unsupported: 1 },
    });
  });

  it("separates raw positive observations from calibrated DEX eligibility", () => {
    expect(
      applyCalibratedDexEligibility(
        { assets: 7, dexEligibleAssets: 7, scoreEligibleObservations: 18 },
        { eligibleAssets: 0, eligibleObservations: 0 },
      ),
    ).toEqual({
      assets: 7,
      rawPositiveObservationAssets: 7,
      rawScoreEligibleObservations: 18,
      dexEligibleAssets: 0,
      scoreEligibleObservations: 0,
    });
  });

  it("selects an exact active report-card ID set without admitting unexpected rows", () => {
    const cards = [
      { id: "active-a", isDefunct: false },
      { id: "active-b", isDefunct: false },
      { id: "retired", isDefunct: true },
    ];
    expect(selectExactActiveReportCards(cards, ["active-a", "active-b"])).toEqual(cards.slice(0, 2));

    expect(() =>
      selectExactActiveReportCards(
        [
          { id: "active-a", isDefunct: false },
          { id: "active-a", isDefunct: false },
          { id: "unexpected", isDefunct: false },
        ],
        ["active-a", "active-b"],
      ),
    ).toThrow(
      "duplicate report card IDs: active-a; missing report cards: active-b; unexpected report cards: unexpected",
    );
  });
});
