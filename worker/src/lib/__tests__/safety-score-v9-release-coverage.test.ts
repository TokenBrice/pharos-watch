import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST } from "@shared/data/safety-score-v9/evaluation-build-manifest-v1";
import { compileV9FactSetV2 } from "@shared/lib/safety-score-v9/compile";
import type { V9EvaluatedSet } from "@shared/lib/safety-score-v9/evaluate-set";
import type { CompiledV9FactSetV2 } from "@shared/types/safety-score-v9-facts";
import { describe, expect, it } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import {
  SAFETY_SCORE_V9_RELEASE_COVERAGE_UNAVAILABLE_BLOCKER,
  SafetyScoreV9ReleaseCohortConflictError,
  assessSafetyScoreV9ShadowReleaseCoverage,
  createSafetyScoreV9ReleaseCohortRecord,
  loadSafetyScoreV9ReleaseCohort,
  persistSafetyScoreV9ReleaseCohort,
  projectSafetyScoreV9CoverageEvaluation,
  type SafetyScoreV9ReleaseCohortRecord,
} from "../safety-score-v9-release-coverage";

const RELEASE_COHORT_MIGRATION_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../migrations/0211_safety_score_v9_release_cohorts.sql",
);
// The fixture intentionally executes the checked-in migration verbatim.
const RELEASE_COHORT_MIGRATION = readFileSync(RELEASE_COHORT_MIGRATION_PATH, "utf8");

const digest = (character: string) => character.repeat(64);
const AS_OF_SEC = 1_000;
const BASE_INPUT_GENERATION_ID = `report-cards-input:v1:${digest("a")}`;
const POLICY_DIGEST = digest("8");
const EVALUATED_SET_DIGEST = digest("9");
const SCORE_RESULT_DIGEST = digest("b");
const PRODUCER_CAPABILITY_DIGEST = digest("c");
const RELEASE_CANDIDATE_ID = "v9-rc-1";

function source(generationId: string, character: string) {
  return { generationId, payloadSha256: character.repeat(64), observedAtSec: 900 };
}

const SOURCES = {
  registry: source("registry:g1", "1"),
  dex: source("dex:g1", "2"),
  redemption: source("redemption:g1", "3"),
  liveReserves: source("reserves:g1", "4"),
  chainSupply: source("supply:g1", "5"),
  peg: source("peg:g1", "6"),
  researchOverlays: source("research:g1", "7"),
};

const EVIDENCE = {
  evidenceId: "evidence:current",
  sourceId: "fixture",
  sourceGenerationId: "fixture:g1",
  disposition: "observed" as const,
  observedAtSec: 900,
  publishedAtSec: null,
  url: null,
  contentSha256: null,
  freshness: { state: "current" as const, ageSec: 100, maxAgeSec: 200 },
  rejection: null,
};

function knownStatus(policyRuleId: string) {
  return {
    applicability: { state: "required" as const, policyRuleId, rationale: null, gapId: null },
    observationState: "known" as const,
    evidenceRefIds: [EVIDENCE.evidenceId],
    gapIds: [],
  };
}

function notApplicableStatus(policyRuleId: string) {
  return {
    applicability: {
      state: "not-applicable" as const,
      policyRuleId,
      rationale: "Reviewed as not applicable.",
      gapId: null,
    },
    observationState: "known" as const,
    evidenceRefIds: [EVIDENCE.evidenceId],
    gapIds: [],
  };
}

function mechanismFact(policyRuleId: string) {
  return {
    status: knownStatus(policyRuleId),
    quality: "strong" as const,
    failureDomains: [{ kind: "reserve-issuer" as const, key: "mechanism:fixture" }],
  };
}

function route(assetId: string, lane: "dex" | "redemption") {
  const sourceGenerationId = lane === "dex" ? SOURCES.dex.generationId : SOURCES.redemption.generationId;
  const routeId = `${assetId}-${lane}`;
  return {
    routeKey: `${lane}:${sourceGenerationId}:${routeId}`,
    routeId,
    lane,
    sourceGenerationId,
    routeFamily: lane === "dex" ? ("dex-amm" as const) : ("issuer-redemption" as const),
    holderAccess: lane === "dex" ? ("permissionless" as const) : ("retail-open" as const),
    executionModel: lane === "dex" ? ("market-depth" as const) : ("deterministic" as const),
    executionCertainty: "bounded" as const,
    modelConfidence: "medium" as const,
    observationConfidence: "high" as const,
    evidenceKind: lane === "dex" ? ("measured-executable-depth" as const) : ("documented-terms" as const),
    coverageClass: "exact-complete" as const,
    settlementModel: lane === "dex" ? ("atomic" as const) : ("same-day" as const),
    settlementSlaSec: lane === "dex" ? null : 86_400,
    settlementEvidenceRefIds: [EVIDENCE.evidenceId],
    physicalResourceKeys: [`resource:${assetId}:${lane}`],
    status: knownStatus(`exit.${lane}`),
    scoreEligible: true,
    request: { requestedNotionalUsd: 1_000_000, maxCostBps: 200, settlementHorizonSec: 300 },
    capacityCurve: [
      {
        requestedNotionalUsd: 1_000_000,
        maxCostBps: 200,
        executableUsd: 1_000_000,
        completionRatio: 1,
        executionCostBps: 100,
      },
    ],
    output: {
      status: knownStatus(`exit.${lane}.output`),
      kind: "fiat" as const,
      assetKeys: ["USD"],
      basketWeights: [],
      valuation: {
        basis: "reviewed-par" as const,
        referenceAssetKey: "USD",
        unitValueUsd: 1,
        expectedUnitValueUsd: 1,
        valueRetentionRatio: 1,
        sourceId: "fixture",
        sourceGenerationId,
        observedAtSec: 900,
        asOfSec: AS_OF_SEC,
        confidence: "high" as const,
        freshness: { state: "current" as const, ageSec: 100, maxAgeSec: 200 },
        evidenceRefIds: [EVIDENCE.evidenceId],
      },
    },
    failureDomains: [
      {
        kind: lane === "dex" ? ("dex-protocol" as const) : ("redemption-rail" as const),
        key: `${lane}:${assetId}`,
      },
    ],
  };
}

function asset(assetId: string, circulatingUsd: number, withRoutes: { dex: boolean; redemption: boolean }) {
  const routes = [...(withRoutes.dex ? [route(assetId, "dex")] : []), ...(withRoutes.redemption ? [route(assetId, "redemption")] : [])];
  return {
    assetId,
    archetype: "algorithmic" as const,
    evidence: [EVIDENCE],
    gaps: [],
    implementation: { status: knownStatus("implementation"), launchedAtSec: 100 },
    mechanismRiskReview: {
      status: knownStatus("backing.mechanism"),
      review: {
        archetype: "algorithmic" as const,
        exogenousBackingShare: 1,
        reflexiveBackingShare: 0,
        contractionCapacityRatio: 1,
        contractionCapacity: mechanismFact("backing.contraction"),
        confidenceAndIncentives: mechanismFact("backing.confidence"),
        oracleAndControlAssumptions: mechanismFact("backing.oracle"),
        emergencyRecovery: mechanismFact("backing.emergency"),
        lossRecovery: mechanismFact("backing.loss"),
      },
    },
    dependencies: {
      status: knownStatus("dependencies"),
      sourceGenerationId: SOURCES.researchOverlays.generationId,
      source: "none" as const,
      baseSource: "none" as const,
      dependencyFromLive: false,
      mappedLiveReserveWeight: null,
      fallbackReason: null,
      edges: [],
      diagnostics: { graphState: "valid" as const, issueCodes: [], sccMemberAssetIds: [] },
    },
    reserveStatus: notApplicableStatus("reserve.not-applicable"),
    reserveExposures: [],
    exitStatus: routes.length > 0 ? knownStatus("exit") : notApplicableStatus("exit.not-applicable"),
    exitRoutes: routes,
    controlStatus: notApplicableStatus("control.not-applicable"),
    controls: [],
    economicControlReview: {
      mint: {
        status: notApplicableStatus("control.mint.not-applicable"),
        controlKey: null,
        reconciliation: "not-applicable" as const,
        upgrade: { state: "not-applicable" as const, controlKey: null },
      },
      oracle: {
        status: notApplicableStatus("control.oracle.not-applicable"),
        tier: null,
        branches: [],
      },
      bridge: { status: notApplicableStatus("control.bridge.not-applicable"), routes: [] },
    },
    accessReview: {
      transfer: { status: knownStatus("access.transfer"), posture: "permissionless" as const },
      freeze: { status: notApplicableStatus("access.freeze.not-applicable"), reviews: [] },
    },
    peg: {
      status: knownStatus("peg"),
      pegKey: "peg:usd",
      sourceGenerationId: SOURCES.peg.generationId,
      referenceKind: "fiat" as const,
      referenceKey: "USD",
      methodologyVersion: "fixture-v1",
      pegScore: 99,
      currentDeviationBps: 1,
      activeDepeg: false,
      activeDepegBps: null,
      trackingSpanDays: 365,
      failureDomains: [{ kind: "oracle-feed" as const, key: "peg:fixture" }],
    },
    supply: {
      status: knownStatus("supply"),
      sourceGenerationId: SOURCES.chainSupply.generationId,
      sourceKind: "usd-denominated-circulating" as const,
      circulatingUnits: null,
      referencePriceUsd: null,
      circulatingUsd,
      chainDistribution: {
        chains: [{ chainId: "chain:fixture", supplyUsd: circulatingUsd, supplyShare: 1 }],
        unattributedSupplyUsd: 0,
        unattributedSupplyShare: 0,
      },
      selectedBridgeRoutes: [],
      selectedRouteSupplyShare: 0,
      unknownRouteSupplyShare: 0,
      unreviewedRouteSupplyShare: 0,
      failureDomains: [{ kind: "chain" as const, key: "chain:fixture" }],
    },
  };
}

interface FixtureOptions {
  assetCount?: number;
  nrAssetIds?: readonly string[];
  /** Diverges the evaluator NR reasons from the reviewed cohort reasons. */
  nrReasonCodeOverrideById?: Readonly<Record<string, "insufficient-evidence" | "partial-reserve-review">>;
  excludeFromCohortIds?: readonly string[];
  /** Diverges the CURRENT supply facts from the frozen cohort weights. */
  factWeightOverrideById?: Readonly<Record<string, number>>;
}

function fixtureIds(assetCount: number): string[] {
  return Array.from({ length: assetCount }, (_, index) => `asset-${String(index + 1).padStart(3, "0")}`);
}

function fixtureWeight(index: number, assetCount: number, nr: boolean): number {
  // Rated assets descend from the top; NR assets sit at the bottom with a
  // negligible weight so the 99% rateable-weight floor still passes.
  return nr ? 1_000 : (assetCount - index) * 1_000_000;
}

function buildFixture(options: FixtureOptions = {}) {
  const assetCount = options.assetCount ?? 305;
  const nrIds = new Set(options.nrAssetIds ?? []);
  const ids = fixtureIds(assetCount);
  const weightOf = (id: string, index: number) => fixtureWeight(index, assetCount, nrIds.has(id));
  const factSet: CompiledV9FactSetV2 = compileV9FactSetV2({
    schemaVersion: 2,
    baseInputGenerationId: BASE_INPUT_GENERATION_ID,
    asOfSec: AS_OF_SEC,
    compiledAtSec: 1_100,
    sourceFingerprints: SOURCES,
    activeAssetIds: ids,
    assets: ids.map((id, index) =>
      asset(id, options.factWeightOverrideById?.[id] ?? weightOf(id, index), {
        dex: index < 45,
        redemption: index < 27,
      }),
    ),
  });
  const evaluatedSet = {
    factSetDigest: factSet.v9FactSetDigest,
    baseInputGenerationId: BASE_INPUT_GENERATION_ID,
    policyId: "safety-score-v9-candidate-v1",
    policyDigest: POLICY_DIGEST,
    evaluationBuildDigest: SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST,
    asOfSec: AS_OF_SEC,
    sourceGenerations: Object.fromEntries(
      Object.entries(SOURCES).map(([key, value]) => [key, value.generationId]),
    ),
    evaluatedSetDigest: EVALUATED_SET_DIGEST,
    scoreResultDigest: SCORE_RESULT_DIGEST,
    assets: ids.map((id) => {
      const routes = [
        ...(ids.indexOf(id) < 45 ? [`dex:${SOURCES.dex.generationId}:${id}-dex`] : []),
        ...(ids.indexOf(id) < 27 ? [`redemption:${SOURCES.redemption.generationId}:${id}-redemption`] : []),
      ];
      return {
        assetId: id,
        trace: {
          finalScore: nrIds.has(id) ? null : 90,
          nrReasons: nrIds.has(id)
            ? [
                {
                  code: options.nrReasonCodeOverrideById?.[id] ?? ("insufficient-evidence" as const),
                  message: "Critical evidence is unavailable",
                },
              ]
            : [],
          propagatedParentReasons: [],
        },
        exit: {
          primaryRouteKey: routes[0] ?? null,
          routes: routes.map((routeKey) => ({ routeKey, included: true })),
        },
      };
    }),
  } as unknown as V9EvaluatedSet;
  const excluded = new Set(options.excludeFromCohortIds ?? []);
  const cohortAssets = ids
    .filter((id) => !excluded.has(id))
    .map((id) => {
      const index = ids.indexOf(id);
      const nr = nrIds.has(id);
      return {
        assetId: id,
        archetype: "algorithmic" as const,
        weight: {
          disposition: "current-valid" as const,
          canonicalUsd: weightOf(id, index),
          conservativeUpperBoundUsd: null,
          sourceGenerationId: SOURCES.chainSupply.generationId,
          observedAtSec: SOURCES.chainSupply.observedAtSec,
          rank: index + 1,
          topCutoffMember: index < 25,
        },
        calibrationDisposition:
          index < 21
            ? ("required-rateable" as const)
            : index < 24
              ? ("intentional-evidence-gap" as const)
              : ("not-member" as const),
        nrReview: nr
          ? {
              state: "reviewed" as const,
              reasonCodes: ["insufficient-evidence" as const],
              disposition: "cannot-currently-establish" as const,
              owner: null,
              reviewedAtSec: 950,
            }
          : {
              state: "not-required" as const,
              reasonCodes: [],
              disposition: null,
              owner: null,
              reviewedAtSec: null,
            },
      };
    });
  const cohort = createSafetyScoreV9ReleaseCohortRecord({
    schemaVersion: 1,
    releaseCandidateId: RELEASE_CANDIDATE_ID,
    cohortId: "release-cohort-fixture",
    policyDigest: POLICY_DIGEST,
    evaluationBuildDigest: SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST,
    continuingActiveV8RateableCount: 305,
    ratifiedBy: "owner:fixture",
    rationale: "V9-9 fixture ratification",
    ratifiedAtSec: 960,
    assets: cohortAssets,
  });
  return { ids, factSet, evaluatedSet, cohort };
}

function assessmentInput(fixture: ReturnType<typeof buildFixture>, db: D1Database) {
  return {
    db,
    candidateId: RELEASE_CANDIDATE_ID,
    candidatePolicyDigest: POLICY_DIGEST,
    candidateEvaluationBuildDigest: SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST,
    candidateFactSetDigest: fixture.factSet.v9FactSetDigest,
    candidateResultDigest: SCORE_RESULT_DIGEST,
    compiledFacts: fixture.factSet,
    evaluatedSet: fixture.evaluatedSet,
    producerCapabilityDigest: PRODUCER_CAPABILITY_DIGEST,
  };
}

function createTestDatabase(applyMigration = true): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  if (applyMigration) sqlite.exec(RELEASE_COHORT_MIGRATION);
  return { sqlite, db: createSqliteD1(sqlite) };
}

async function seedCohort(cohort: SafetyScoreV9ReleaseCohortRecord): Promise<{ sqlite: DatabaseSync; db: D1Database }> {
  const database = createTestDatabase();
  await persistSafetyScoreV9ReleaseCohort(database.db, cohort);
  return database;
}

describe("Safety Score V9 release cohort store", () => {
  it("round-trips a ratified cohort record and rejects re-ratification drift", async () => {
    const { cohort } = buildFixture();
    const { db } = createTestDatabase();

    const recorded = await persistSafetyScoreV9ReleaseCohort(db, cohort);
    expect(recorded.status).toBe("recorded");
    expect((await persistSafetyScoreV9ReleaseCohort(db, cohort)).status).toBe("unchanged");
    const { cohortDigest: _cohortDigest, ...cohortPayload } = cohort;
    const reratified = createSafetyScoreV9ReleaseCohortRecord({ ...cohortPayload, rationale: "A different rationale" });
    await expect(persistSafetyScoreV9ReleaseCohort(db, reratified)).rejects.toBeInstanceOf(
      SafetyScoreV9ReleaseCohortConflictError,
    );

    expect(await loadSafetyScoreV9ReleaseCohort(db, RELEASE_CANDIDATE_ID)).toEqual(cohort);
    expect(await loadSafetyScoreV9ReleaseCohort(db, "v9-rc-2")).toBeNull();
  });

  it("fails closed when a stored cohort payload is tampered with", async () => {
    const { cohort } = buildFixture();
    const { sqlite, db } = await seedCohort(cohort);
    const tampered = {
      ...cohort,
      assets: cohort.assets.map((entry, index) =>
        index === 0 ? { ...entry, weight: { ...entry.weight, canonicalUsd: 1 } } : entry,
      ),
    };
    sqlite
      .prepare("UPDATE safety_score_v9_release_cohorts SET cohort_json = ? WHERE release_candidate_id = ?")
      .run(JSON.stringify(tampered), RELEASE_CANDIDATE_ID);

    await expect(loadSafetyScoreV9ReleaseCohort(db, RELEASE_CANDIDATE_ID)).rejects.toThrow(
      "release cohort digest does not match",
    );
  });
});

describe("Safety Score V9 ratified release coverage floor", () => {
  it("projects both legacy and shock-aware source generations without dropping keys", () => {
    const fixture = buildFixture();
    const legacy = projectSafetyScoreV9CoverageEvaluation({
      evaluatedSet: fixture.evaluatedSet,
      producerCapabilityDigest: PRODUCER_CAPABILITY_DIGEST,
    });
    expect(legacy.sourceGenerations).not.toHaveProperty("shockCoverage");

    const shockAware = projectSafetyScoreV9CoverageEvaluation({
      evaluatedSet: {
        ...fixture.evaluatedSet,
        sourceGenerations: { ...fixture.evaluatedSet.sourceGenerations, shockCoverage: "shock:g1" },
      },
      producerCapabilityDigest: PRODUCER_CAPABILITY_DIGEST,
    });
    expect(shockAware.sourceGenerations.shockCoverage).toBe("shock:g1");
  });

  it("passes on a gate-passed report bound to the exact candidate and drops the blocker", async () => {
    const fixture = buildFixture();
    const { db } = await seedCohort(fixture.cohort);

    const result = await assessSafetyScoreV9ShadowReleaseCoverage(assessmentInput(fixture, db));

    expect(result.unresolvedReleaseBlockers).toEqual([]);
    expect(result.report?.decision).toBe("gate-passed");
    expect(result.floor).toMatchObject({
      id: "ratified-release-coverage",
      status: "pass",
      observed: 305,
      required: "a gate-passed V9-9 release coverage report bound to this exact candidate",
    });
    expect(result.floor.detail).toContain(result.report?.reportDigest);
    expect(result.floor.detail).not.toContain(SAFETY_SCORE_V9_RELEASE_COVERAGE_UNAVAILABLE_BLOCKER);
  });

  it("passes with a reviewed NR justification set on a larger cohort", async () => {
    const fixture = buildFixture({ assetCount: 306, nrAssetIds: ["asset-306"] });
    const { db } = await seedCohort(fixture.cohort);

    const result = await assessSafetyScoreV9ShadowReleaseCoverage(assessmentInput(fixture, db));

    expect(result.report?.decision).toBe("gate-passed");
    expect(result.report?.nrReviews).toMatchObject({
      notRatedAssetIds: ["asset-306"],
      reviewedAssetIds: ["asset-306"],
      missingReviewAssetIds: [],
      reasonMismatchAssetIds: [],
      passed: true,
    });
    expect(result.floor.status).toBe("pass");
  });

  it("fails closed when no cohort is ratified for the candidate", async () => {
    const fixture = buildFixture();
    const { db } = createTestDatabase();

    const result = await assessSafetyScoreV9ShadowReleaseCoverage(assessmentInput(fixture, db));

    expect(result.unresolvedReleaseBlockers).toEqual([SAFETY_SCORE_V9_RELEASE_COVERAGE_UNAVAILABLE_BLOCKER]);
    expect(result.floor).toMatchObject({
      id: "ratified-release-coverage",
      status: "fail",
      observed: 0,
      detail: "No frozen V9-9 release cohort and passing coverage report is wired into the shadow candidate",
    });
    expect(result.report).toBeNull();
  });

  it("fails closed on candidate-identity mismatch", async () => {
    const fixture = buildFixture();
    const { db } = await seedCohort(fixture.cohort);

    const mismatchedPolicy = await assessSafetyScoreV9ShadowReleaseCoverage({
      ...assessmentInput(fixture, db),
      candidatePolicyDigest: digest("7"),
    });
    expect(mismatchedPolicy.floor.status).toBe("fail");
    expect(mismatchedPolicy.floor.detail).toContain("different policy or evaluation build");
    expect(mismatchedPolicy.unresolvedReleaseBlockers).toEqual([SAFETY_SCORE_V9_RELEASE_COVERAGE_UNAVAILABLE_BLOCKER]);

    const mismatchedBuild = await assessSafetyScoreV9ShadowReleaseCoverage({
      ...assessmentInput(fixture, db),
      candidateEvaluationBuildDigest: digest("7"),
    });
    expect(mismatchedBuild.floor.status).toBe("fail");
    expect(mismatchedBuild.unresolvedReleaseBlockers).toEqual([SAFETY_SCORE_V9_RELEASE_COVERAGE_UNAVAILABLE_BLOCKER]);

    const mismatchedResult = await assessSafetyScoreV9ShadowReleaseCoverage({
      ...assessmentInput(fixture, db),
      candidateResultDigest: digest("7"),
    });
    expect(mismatchedResult.floor.status).toBe("fail");
    expect(mismatchedResult.floor.detail).toContain("not bound to this exact candidate");
    expect(mismatchedResult.unresolvedReleaseBlockers).toEqual([SAFETY_SCORE_V9_RELEASE_COVERAGE_UNAVAILABLE_BLOCKER]);
  });

  it("fails closed on cohort drift: roster, weight, and NR-reason changes all go no-go", async () => {
    const rosterDrift = buildFixture({ excludeFromCohortIds: ["asset-305"] });
    const rosterDb = (await seedCohort(rosterDrift.cohort)).db;
    const rosterResult = await assessSafetyScoreV9ShadowReleaseCoverage(assessmentInput(rosterDrift, rosterDb));
    expect(rosterResult.floor.status).toBe("fail");
    expect(rosterResult.floor.detail).toContain("no-go");
    expect(rosterResult.floor.detail).toContain("active-id-bijection-failed");
    expect(rosterResult.unresolvedReleaseBlockers).toEqual([SAFETY_SCORE_V9_RELEASE_COVERAGE_UNAVAILABLE_BLOCKER]);

    // The cohort was ratified over the default weight; the current facts now
    // carry a divergent supply, so the frozen weight no longer matches.
    const weightDrift = buildFixture({ factWeightOverrideById: { "asset-001": 1 } });
    const weightDb = (await seedCohort(weightDrift.cohort)).db;
    const weightResult = await assessSafetyScoreV9ShadowReleaseCoverage(assessmentInput(weightDrift, weightDb));
    expect(weightResult.floor.status).toBe("fail");
    expect(weightResult.floor.detail).toContain("canonical-weight-fact-mismatch");

    const nrDrift = buildFixture({
      assetCount: 306,
      nrAssetIds: ["asset-306"],
      nrReasonCodeOverrideById: { "asset-306": "partial-reserve-review" },
    });
    const nrDb = (await seedCohort(nrDrift.cohort)).db;
    const nrResult = await assessSafetyScoreV9ShadowReleaseCoverage(assessmentInput(nrDrift, nrDb));
    expect(nrResult.floor.status).toBe("fail");
    expect(nrResult.floor.detail).toContain("nr-reason-mismatch");
  }, 30_000);

  it("fails closed when the stored cohort record is tampered with or the table is missing", async () => {
    const fixture = buildFixture();
    const { sqlite, db } = await seedCohort(fixture.cohort);
    sqlite
      .prepare("UPDATE safety_score_v9_release_cohorts SET cohort_json = ? WHERE release_candidate_id = ?")
      .run(JSON.stringify({ ...fixture.cohort, rationale: "edited after ratification" }), RELEASE_CANDIDATE_ID);

    const tampered = await assessSafetyScoreV9ShadowReleaseCoverage(assessmentInput(fixture, db));
    expect(tampered.floor.status).toBe("fail");
    expect(tampered.floor.detail).toContain("failed integrity verification");
    expect(tampered.unresolvedReleaseBlockers).toEqual([SAFETY_SCORE_V9_RELEASE_COVERAGE_UNAVAILABLE_BLOCKER]);

    const { db: unmigrated } = createTestDatabase(false);
    const missingTable = await assessSafetyScoreV9ShadowReleaseCoverage(assessmentInput(fixture, unmigrated));
    expect(missingTable.floor.status).toBe("fail");
    expect(missingTable.unresolvedReleaseBlockers).toEqual([SAFETY_SCORE_V9_RELEASE_COVERAGE_UNAVAILABLE_BLOCKER]);
  });

  it("fails closed when the report is no-go for an unreviewed NR asset", async () => {
    const fixture = buildFixture({ assetCount: 306, nrAssetIds: ["asset-306"] });
    const { cohortDigest: _cohortDigest, ...cohortPayload } = fixture.cohort;
    const unreviewedCohort = createSafetyScoreV9ReleaseCohortRecord({
      ...cohortPayload,
      assets: cohortPayload.assets.map((entry) =>
        entry.assetId === "asset-306"
          ? {
              ...entry,
              nrReview: { state: "not-required", reasonCodes: [], disposition: null, owner: null, reviewedAtSec: null },
            }
          : entry,
      ),
    });
    const { db } = await seedCohort(unreviewedCohort);

    const result = await assessSafetyScoreV9ShadowReleaseCoverage(assessmentInput(fixture, db));

    expect(result.floor.status).toBe("fail");
    expect(result.floor.detail).toContain("nr-review-missing");
    expect(result.unresolvedReleaseBlockers).toEqual([SAFETY_SCORE_V9_RELEASE_COVERAGE_UNAVAILABLE_BLOCKER]);
  });
});
