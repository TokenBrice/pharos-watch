import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { describe, expect, it } from "vitest";
import { createReportCardsFixedInput } from "../../src/lib/report-cards-fixed-input";
import { buildSafetyScoreV9Candidate } from "../../src/lib/safety-score-v9-candidate";
import {
  analyzeV9Calibration,
  captureMovements,
  computeCalibrationResultDigest,
  evaluateRealACandidateChecks,
  projectScoreBearingCalibrationInput,
  qualifyingCompositeCards,
  repeatedRealAAssetIds,
} from "../../../scripts/maintenance/analyze-safety-score-v9-calibration.mjs";

const BASE_CLOCK_SEC = 2_000_000_000;

// The adversarial tests need to mutate a JSON replay after the production
// builder freezes it. JSON round-tripping gives the test a deliberately mutable
// artifact with the same shape an operator supplies to the CLI.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MutableReplay = { pipeline: any };

interface ProductionReplayOptions {
  activeAssetIds?: string[];
  supplyById?: Record<string, number>;
}

function dexLiquidityRow(observedAtSec: number) {
  return {
    liquidityScore: 90,
    concentrationHhi: 0.5,
    poolCount: 1,
    chainCount: 1,
    coverageClass: "primary" as const,
    coverageConfidence: 1,
    liquidityEvidenceClass: "measured" as const,
    hasMeasuredLiquidityEvidence: true,
    effectiveTvlUsd: 1_000_000,
    balanceMeasuredTvlUsd: 1_000_000,
    organicMeasuredTvlUsd: 1_000_000,
    methodologyVersion: "dex:fixture-v1",
    updatedAt: observedAtSec,
  };
}

function chainSupply(current: number) {
  return {
    ethereum: {
      current,
      circulatingPrevDay: current,
      circulatingPrevWeek: current,
      circulatingPrevMonth: current,
    },
  };
}

function productionReplay(clockSec = BASE_CLOCK_SEC, options: ProductionReplayOptions = {}): MutableReplay {
  const observedAtSec = clockSec - 100;
  const activeAssetIds = options.activeAssetIds ?? ["usdc-circle"];
  const fixedInput = createReportCardsFixedInput({
    captureKind: "exact-publication-inputs",
    activeAssetIds,
    capturedAt: new Date(clockSec * 1_000).toISOString(),
    sourceGeneration: `report-cards:fixture:${clockSec}`,
    dexGenerationId: `dex-liquidity-${observedAtSec}`,
    redemptionGenerationId: "redemption-backstops-unavailable",
    registryRevision: "registry:calibration-analysis-fixture",
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    clockSec,
    updatedAt: clockSec,
    liquidityStale: false,
    redemptionStale: true,
    inputFreshness: {
      dexLiquidity: { updatedAt: observedAtSec, ageSeconds: 100, stale: false },
      redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
    },
    pegDataById: {},
    activeDepegPeakBpsById: {},
    dexLiqMap: Object.fromEntries(activeAssetIds.map((assetId) => [assetId, dexLiquidityRow(observedAtSec)])),
    redemptionBackstopMap: {},
    bluechipMap: {},
    resolvedBlacklistStatuses: Object.fromEntries(activeAssetIds.map((assetId) => [assetId, false])),
    liveReserveMap: {},
    liveReserveProvenanceMap: {},
    chainCirculatingById: Object.fromEntries(
      activeAssetIds.map((assetId) => [assetId, chainSupply(options.supplyById?.[assetId] ?? 10_000_000)]),
    ),
    dexDeploymentSupplyCoverageById: {},
    collateralDriftCoins: [],
    liveToFallbackCoins: [],
  });
  const pipeline = buildSafetyScoreV9Candidate({
    fixedInput,
    publishedAtSec: clockSec + 10,
  });
  return JSON.parse(JSON.stringify({ pipeline })) as MutableReplay;
}

function resealResult(replay: MutableReplay): void {
  const resultDigest = computeCalibrationResultDigest(replay.pipeline.evaluatedSet);
  replay.pipeline.evaluatedSet.scoreResultDigest = resultDigest;
  replay.pipeline.candidate.resultDigest = resultDigest;
}

function resealScoreTamper(replay: MutableReplay): void {
  const card = replay.pipeline.candidate.cards[0];
  const evaluated = replay.pipeline.evaluatedSet.assets[0];
  card.score += 1;
  for (const pillar of Object.values(card.pillars) as Array<{ score: number | null }>) {
    if (pillar.score !== null) pillar.score += 1;
  }
  evaluated.trace.finalScore += 1;
  for (const contribution of evaluated.trace.pillarContributions) contribution.score += 1;
  for (const pillar of Object.values(evaluated.scoreInput.pillars) as Array<{ score: number | null }>) {
    if (pillar.score !== null) pillar.score += 1;
  }
  resealResult(replay);
}

function knownStatus(evidenceRefIds = ["score-evidence"]) {
  return {
    applicability: { state: "required", policyRuleId: "fixture.rule", rationale: null, gapId: null },
    observationState: "known",
    evidenceRefIds,
    gapIds: [],
  };
}

function realAFixture(freshnessState: "current" | "stale" | "not-assessed" = "current") {
  const status = knownStatus();
  const card = { id: "real-a", score: 84, grade: "A" };
  const evaluated = {
    stressState: { exitPortfolio: { circulatingUsd: 10_000_000 } },
    backing: { evidenceRefIds: ["score-evidence"] },
    exit: {
      routes: [
        {
          routeKey: "dex:real-a",
          included: true,
          capacityPoint: { executableUsd: 1_000_000 },
        },
      ],
    },
    control: { components: [], reasons: [] },
    scoreInput: {
      pillars: {
        backing: { evidenceLevel: "strong", reasons: [] },
        exit: { evidenceLevel: "strong", reasons: [] },
        control: { evidenceLevel: "strong", reasons: [] },
      },
      peg: { reasons: [] },
      dependencyReasons: [],
      methodologyReasons: [],
    },
  };
  const facts = {
    evidence: [
      {
        evidenceId: "score-evidence",
        disposition: "observed",
        freshness: {
          state: freshnessState,
          ageSec: freshnessState === "stale" ? 101 : 1,
          maxAgeSec: freshnessState === "not-assessed" ? null : 100,
        },
      },
    ],
    gaps: [],
    implementation: { status },
    dependencies: { status, edges: [] },
    supply: { status },
    peg: { status },
    exitRoutes: [
      {
        routeKey: "dex:real-a",
        status,
        settlementEvidenceRefIds: ["score-evidence"],
        output: { status, valuation: null },
      },
    ],
    controlStatus: status,
    controls: [],
    economicControlReview: {
      mint: { status, upgrade: { state: "immutable" } },
      oracle: { status, branches: [] },
      bridge: { status, routes: [] },
    },
    mechanismRiskReview: { review: null },
  };
  return { card, evaluated, facts };
}

describe("Safety Score V9 calibration analysis", { timeout: 30_000 }, () => {
  it("accepts an untampered candidate only after a trusted production rerun", () => {
    const replay = productionReplay();
    const report = analyzeV9Calibration(structuredClone(replay), replay);

    expect(report.gates.candidateReproduced).toBe(true);
  });

  it("rejects a coherently resealed score tamper", () => {
    const baseline = productionReplay();
    const candidate = productionReplay();
    resealScoreTamper(candidate);

    expect(() => analyzeV9Calibration(baseline, candidate)).toThrow("trusted production compiler and evaluator");
  });

  it.each([
    {
      name: "duplicate fixed-input IDs",
      mutate: (replay: MutableReplay) => replay.pipeline.fixedInput.activeAssetIds.push("usdc-circle"),
      message: "fixed-input assets must contain unique asset IDs",
    },
    {
      name: "mismatched compiled active IDs",
      mutate: (replay: MutableReplay) => {
        replay.pipeline.compiledFacts.activeAssetIds = ["other-asset"];
      },
      message: "asset set mismatch",
    },
    {
      name: "duplicate compiled rows",
      mutate: (replay: MutableReplay) => {
        replay.pipeline.compiledFacts.assets.push(structuredClone(replay.pipeline.compiledFacts.assets[0]));
      },
      message: "compiled rows must contain unique asset IDs",
    },
    {
      name: "duplicate evaluated rows",
      mutate: (replay: MutableReplay) => {
        replay.pipeline.evaluatedSet.assets.push(structuredClone(replay.pipeline.evaluatedSet.assets[0]));
      },
      message: "evaluated rows must contain unique asset IDs",
    },
    {
      name: "mismatched cards",
      mutate: (replay: MutableReplay) => {
        replay.pipeline.candidate.cards[0].id = "other-asset";
      },
      message: "asset set mismatch",
    },
  ])("rejects $name before constructing replay maps", ({ mutate, message }) => {
    const replay = productionReplay();
    mutate(replay);

    expect(() => analyzeV9Calibration(productionReplay(), replay)).toThrow(message);
  });

  it.each(["stale", "not-assessed"] as const)(
    "rejects %s score-bearing evidence even when there is no stale gap",
    (freshnessState) => {
      const fixture = realAFixture(freshnessState);
      const result = evaluateRealACandidateChecks(fixture.card, fixture.evaluated, fixture.facts);

      expect(fixture.facts.gaps).toEqual([]);
      expect(result.checks.currentEvidence).toBe(false);
      expect(result.evidenceFreshness.noncurrentIds).toEqual(["score-evidence"]);
      expect(result.passed).toBe(false);
    },
  );

  it("rejects rejected score-bearing evidence", () => {
    const fixture = realAFixture();
    fixture.facts.evidence[0].disposition = "rejected";
    const result = evaluateRealACandidateChecks(fixture.card, fixture.evaluated, fixture.facts);

    expect(result.checks.currentEvidence).toBe(false);
    expect(result.evidenceFreshness.noncurrentIds).toEqual(["score-evidence"]);
  });

  it("rejects the actual custody and oracle profile gap types", () => {
    const custody = realAFixture();
    custody.facts.gaps.push({ reasonCode: "missing-custody-profile" } as never);
    const custodyResult = evaluateRealACandidateChecks(custody.card, custody.evaluated, custody.facts);
    expect(custodyResult.checks.assetWideControlsResolved).toBe(false);
    expect(custodyResult.controls.unresolvedProfileGapCodes).toEqual(["missing-custody-profile"]);

    const oracle = realAFixture();
    oracle.evaluated.control.reasons.push({
      code: "missing-oracle-profile",
      pathKind: "local-component",
      path: "oracle",
      controlKey: null,
    } as never);
    const oracleResult = evaluateRealACandidateChecks(oracle.card, oracle.evaluated, oracle.facts);
    expect(oracleResult.checks.assetWideControlsResolved).toBe(false);
    expect(oracleResult.controls.unresolvedReasonCodes).toEqual(["missing-oracle-profile"]);
  });

  it("treats null-key aggregate bridge reasons as asset-wide", () => {
    const fixture = realAFixture();
    fixture.evaluated.control.reasons.push({
      code: "bridge-unverified",
      pathKind: "aggregate",
      path: "bridge",
      controlKey: null,
    } as never);
    const result = evaluateRealACandidateChecks(fixture.card, fixture.evaluated, fixture.facts);

    expect(result.checks.assetWideControlsResolved).toBe(false);
    expect(result.controls.unresolvedReasonCodes).toEqual(["bridge-unverified"]);
  });

  it("treats deployment reasons backed by global controls as asset-wide", () => {
    const fixture = realAFixture();
    fixture.facts.controls.push({ controlKey: "bridge:global", scope: "global" } as never);
    fixture.evaluated.control.reasons.push({
      code: "bridge-unverified",
      pathKind: "deployment",
      path: "bridge:ethereum",
      controlKey: "bridge:global",
    } as never);
    const result = evaluateRealACandidateChecks(fixture.card, fixture.evaluated, fixture.facts);

    expect(result.checks.assetWideControlsResolved).toBe(false);
    expect(result.controls.unresolvedReasonCodes).toEqual(["bridge-unverified"]);
  });

  it("does not let omitted Friday evidence produce a full-contract pass", () => {
    const replay = productionReplay();
    const report = analyzeV9Calibration(structuredClone(replay), replay);

    expect(report.gates).toMatchObject({
      compositeAPlus: false,
      threeFreshCaptures: false,
      repeatedRealA: false,
      captureStability: false,
      causalAttribution: false,
      allPassed: false,
    });
    expect(report.fridayEvidence).toMatchObject({
      composite: { provided: false },
      freshCaptures: { providedCount: 0 },
      causalAttribution: { provided: false },
    });
  });

  it("rejects duplicate capture generations", () => {
    const replay = productionReplay();
    const report = analyzeV9Calibration(structuredClone(replay), replay, {
      freshCaptures: [replay, structuredClone(replay), structuredClone(replay)],
    });

    expect(report.fridayEvidence.freshCaptures).toMatchObject({
      providedCount: 3,
      distinctAndOrdered: false,
    });
    expect(report.gates.threeFreshCaptures).toBe(false);
  });

  it("rejects a stale capture even when all three generations are distinct", () => {
    const replay = productionReplay();
    const captures = [0, 100, 200].map((offset) => productionReplay(BASE_CLOCK_SEC + offset));
    const report = analyzeV9Calibration(structuredClone(replay), replay, { freshCaptures: captures });

    expect(report.fridayEvidence.freshCaptures).toMatchObject({
      providedCount: 3,
      distinctAndOrdered: true,
      identitiesMatch: true,
      allInputsFresh: false,
    });
    expect(report.gates.threeFreshCaptures).toBe(false);
  });

  it("does not treat a switched A identity as repeated real-A evidence", () => {
    expect(repeatedRealAAssetIds(["asset-a"], [["asset-a"], ["asset-b"], ["asset-a"]])).toEqual([]);
    expect(repeatedRealAAssetIds(["asset-a"], [["asset-a"], ["asset-a"], ["asset-a"]])).toEqual(["asset-a"]);
  });

  it("requires the composite A+ score to be at least 87", () => {
    expect(
      qualifyingCompositeCards([
        { id: "qualified", score: 87, grade: "A+" },
        { id: "too-low", score: 86, grade: "A+" },
        { id: "wrong-grade", score: 90, grade: "A" },
      ]),
    ).toEqual([{ assetId: "qualified", score: 87, grade: "A+" }]);
  });

  it("flags only score movements greater than three points", () => {
    const capture = (digest: string, score: number, factRevision: number) => ({
      pipeline: {
        candidate: { resultDigest: digest, cards: [{ id: "asset-a", score }] },
        evaluatedSet: {
          assets: [
            {
              assetId: "asset-a",
              scoreInput: {
                pillars: Object.fromEntries(
                  ["backing", "exit", "control"].map((pillar) => [
                    pillar,
                    {
                      score: pillar === "backing" ? factRevision : 80,
                      evidenceLevel: "strong",
                      reasons: [],
                      structuralSignals: [],
                    },
                  ]),
                ),
                peg: { applicable: true, score: 100, activeDepegBps: null, reasons: [] },
                trackRecordMonths: 24,
                parent: { required: false, score: null, propagatedReasons: [] },
                dependencyReasons: [],
                dependencyStructuralSignals: [],
              },
            },
          ],
        },
      },
    });

    expect(captureMovements([capture("first", 80, 1), capture("second", 83, 2)])).toEqual([]);
    expect(captureMovements([capture("first", 80, 1), capture("second", 84, 2)])).toEqual([
      expect.objectContaining({ assetId: "asset-a", delta: 4, scoreBearingInputChanged: true }),
    ]);
  });

  it("does not attribute an unrelated asset fact-set change to the target", () => {
    const activeAssetIds = ["usdc-circle", "usdt-tether"];
    const baseline = productionReplay(BASE_CLOCK_SEC, {
      activeAssetIds,
      supplyById: { "usdc-circle": 10_000_000, "usdt-tether": 20_000_000 },
    });
    const candidate = productionReplay(BASE_CLOCK_SEC, {
      activeAssetIds,
      supplyById: { "usdc-circle": 10_000_000, "usdt-tether": 30_000_000 },
    });
    const target = (replay: MutableReplay) =>
      replay.pipeline.evaluatedSet.assets.find((asset: { assetId: string }) => asset.assetId === "usdc-circle");

    expect(candidate.pipeline.compiledFacts.v9FactSetDigest).not.toBe(baseline.pipeline.compiledFacts.v9FactSetDigest);
    expect(projectScoreBearingCalibrationInput(target(candidate))).toEqual(
      projectScoreBearingCalibrationInput(target(baseline)),
    );
  });
});
