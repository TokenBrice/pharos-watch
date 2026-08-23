import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/safety-score";
import { describe, expect, it } from "vitest";
import { createReportCardsFixedInput } from "../../src/lib/report-cards-fixed-input";
import { buildSafetyScoreV9Candidate } from "../../src/lib/safety-score-v9-candidate";
import {
  analyzeV9Calibration,
  captureMovements,
  computeCalibrationResultDigest,
  evaluateRealACandidateChecks,
  measuredAdverseFDrivers,
  projectScoreBearingCalibrationInput,
  qualifyingCompositeCards,
  repeatedRealAAssetIds,
  summarizeDistribution,
} from "../../../scripts/maintenance/analyze-safety-score-v9-calibration.mjs";

// A realistic fixed clock: this suite compiles the REAL registry and should stay
// within its review windows so calibration assertions exercise current evidence.
// The score-trace reconciliation suite separately owns the far-future aged-review
// regression.
const BASE_CLOCK_SEC = 1_787_529_600; // 2026-08-24T00:00:00Z, after the newest curated review dates

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
  it("verifies both homogeneous legacy and adjustment-aware result digests", () => {
    const replay = productionReplay();
    expect(computeCalibrationResultDigest(replay.pipeline.evaluatedSet)).toBe(
      replay.pipeline.evaluatedSet.scoreResultDigest,
    );

    const legacy = structuredClone(replay.pipeline.evaluatedSet);
    for (const asset of legacy.assets) {
      delete asset.trace.inheritableScore;
      delete asset.trace.scoreAdjustments;
    }
    expect(computeCalibrationResultDigest(legacy)).toMatch(/^[a-f0-9]{64}$/);
    expect(computeCalibrationResultDigest(legacy)).not.toBe(
      replay.pipeline.evaluatedSet.scoreResultDigest,
    );
  });

  it("rejects partial or mixed result-digest trace contracts", () => {
    const partial = structuredClone(productionReplay().pipeline.evaluatedSet);
    delete partial.assets[0]!.trace.scoreAdjustments;
    expect(() => computeCalibrationResultDigest(partial)).toThrow(
      /both inheritableScore and scoreAdjustments/,
    );

    const mixed = structuredClone(
      productionReplay(BASE_CLOCK_SEC, {
        activeAssetIds: ["usdc-circle", "usdt-tether"],
      }).pipeline.evaluatedSet,
    );
    delete mixed.assets[0]!.trace.inheritableScore;
    delete mixed.assets[0]!.trace.scoreAdjustments;
    expect(() => computeCalibrationResultDigest(mixed)).toThrow(
      /one homogeneous result-digest trace version/,
    );
  });

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

  it("rejects fresh captures that omit candidate assets", () => {
    const activeAssetIds = ["usdc-circle", "usdt-tether"];
    const baseline = productionReplay(BASE_CLOCK_SEC, { activeAssetIds });
    const candidate = productionReplay(BASE_CLOCK_SEC, { activeAssetIds });
    const captures = [0, 100, 200].map((offset) =>
      productionReplay(BASE_CLOCK_SEC + offset, { activeAssetIds: ["usdc-circle"] }),
    );

    const report = analyzeV9Calibration(baseline, candidate, { freshCaptures: captures });

    expect(report.fridayEvidence.freshCaptures).toMatchObject({
      providedCount: 3,
      distinctAndOrdered: true,
      assetSetsMatch: false,
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

interface DistributionAssetOptions {
  id: string;
  grade: string;
  score?: number;
  backing?: number;
  exit?: number;
  control?: number;
  supplyUsd?: number | null;
  supplyObservationState?: "known" | "bounded-unknown" | "missing";
  pegMultiplier?: number;
  caps?: { kind: string; limit: number; binding: boolean }[];
  reasonCodes?: string[];
  archetype?: string;
}

/**
 * Minimal replay shaped for the distribution gates only. `summarizeDistribution`
 * reads exactly `candidate.cards` plus `compiledFacts.assets`, so the identity
 * envelope the rest of the analyzer asserts is deliberately omitted.
 */
function distributionReplay(assets: DistributionAssetOptions[]) {
  const cards = assets.map((asset) => {
    const caps = asset.caps ?? [];
    return {
      id: asset.id,
      score: asset.score ?? 50,
      grade: asset.grade,
      pegMultiplier: asset.pegMultiplier ?? 1,
      pillars: {
        backing: { score: asset.backing ?? 60 },
        exit: { score: asset.exit ?? 60 },
        control: { score: asset.control ?? 60 },
      },
      caps,
      bindingCap: caps.find((cap) => cap.binding) ?? null,
      reasonCodes: asset.reasonCodes ?? [],
    };
  });
  const compiled = assets.map((asset) => ({
    assetId: asset.id,
    archetype: asset.archetype ?? "fiat-cash",
    supply: {
      status: { observationState: asset.supplyObservationState ?? (asset.supplyUsd == null ? "missing" : "known") },
      circulatingUsd: asset.supplyUsd ?? null,
    },
  }));
  return { pipeline: { candidate: { cards }, compiledFacts: { assets: compiled }, evaluatedSet: { assets: [] } } };
}

function metricsFor(assets: DistributionAssetOptions[]) {
  return summarizeDistribution(distributionReplay(assets)).distributionMetrics;
}

describe("Safety Score V9 distribution gates D1-D6", () => {
  it("D1 excludes the two largest assets and treats a pillar exactly at its floor as unevidenced", () => {
    const evidenced = { backing: 60, exit: 60, control: 60 };
    const metrics = metricsFor([
      // The duopoly: fully evidenced, and excluded so it cannot carry the gate.
      { id: "top-1", grade: "A", supplyUsd: 800, ...evidenced },
      { id: "top-2", grade: "A", supplyUsd: 100, ...evidenced },
      { id: "evidenced", grade: "C", supplyUsd: 30, ...evidenced },
      // control exactly at the bounded-unknown floor of 45 counts as at floor.
      { id: "at-floor", grade: "C", supplyUsd: 70, backing: 60, exit: 60, control: 45 },
    ]);

    expect(metrics.materialEvidenceCoverageExTop2).toBe(0.3);
  });

  it("D2 counts only known supply observations and reports the largest NR supply", () => {
    const metrics = metricsFor([
      { id: "known", grade: "C", supplyUsd: 100 },
      { id: "bounded", grade: "F", supplyUsd: 0, supplyObservationState: "bounded-unknown" },
      { id: "missing", grade: "F", supplyUsd: null },
      { id: "unrated", grade: "NR", supplyUsd: 42 },
    ]);

    // A bounded-unknown supply is not an observation: 1 known of 3 rated.
    expect(metrics.supplyObservationCoverage).toBeCloseTo(1 / 3, 6);
    expect(metrics.maxNrSupplyUsd).toBe(42);
  });

  it.each([
    { driver: "compromisedMintPosture", asset: { control: 25 } },
    { driver: "subFloorPillar", asset: { backing: 34 } },
    { driver: "measuredPegHistory", asset: { pegMultiplier: 0.89 } },
    {
      driver: "bindingAdverseCap",
      asset: { caps: [{ kind: "signal:centralized-mint:critical", limit: 39, binding: true }] },
    },
    { driver: "unsupportedExitDesign", asset: { reasonCodes: ["no-viable-exit-path"] } },
  ])("D3 attributes an F held by $driver to a measured adverse fact", ({ driver, asset }) => {
    const adverse = { id: "adverse", grade: "F", supplyUsd: 10, ...asset } as DistributionAssetOptions;
    const drivers = measuredAdverseFDrivers(distributionReplay([adverse]).pipeline.candidate.cards[0]);

    expect(drivers[driver as keyof typeof drivers]).toBe(true);
    expect(metricsFor([adverse]).unattributedFCount).toBe(0);
  });

  it("D3 counts an F with no adverse driver as unattributed and shares its supply over observed supply", () => {
    const metrics = metricsFor([
      { id: "big", grade: "C", supplyUsd: 900 },
      // Sits on the bounded-unknown floors, not below them: an evidence gap.
      { id: "under-evidenced", grade: "F", supplyUsd: 100, backing: 35, exit: 35, control: 45 },
    ]);

    expect(metrics.unattributedFCount).toBe(1);
    expect(metrics.unattributedFSupplyShare).toBe(0.1);
  });

  it("D3 does not count a non-binding adverse cap as attribution", () => {
    const metrics = metricsFor([
      {
        id: "unpinned",
        grade: "F",
        backing: 35,
        exit: 35,
        control: 45,
        caps: [{ kind: "signal:unsafe-backing:critical", limit: 39, binding: false }],
      },
    ]);

    expect(metrics.unattributedFCount).toBe(1);
  });

  it("D4 measures discrimination only where policy leaves the score free to float", () => {
    const pinned = (id: string) => ({
      id,
      grade: "C",
      score: 55,
      caps: [{ kind: "bounded-compensability", limit: 55, binding: true }],
    });
    const metrics = metricsFor([
      pinned("pin-a"),
      pinned("pin-b"),
      pinned("pin-c"),
      { id: "free-a", grade: "C", score: 41, backing: 41, exit: 60, control: 60 },
      { id: "free-b", grade: "C", score: 42, backing: 42, exit: 60, control: 60 },
    ]);

    // The 3-asset cap pile-up is 60% of the corpus but is excluded outright.
    expect(metrics.freeFloatingLargestBucketShare).toBe(0.5);
    expect(metrics.freeFloatingLargestTupleShare).toBe(0.5);
  });

  it("D5 scopes the material cohort by a supply window and ignores assets with no observation", () => {
    const metrics = metricsFor([
      { id: "material-a", grade: "B-", supplyUsd: 400_000_000 },
      { id: "material-b", grade: "C-", supplyUsd: 300_000_000 },
      { id: "material-c", grade: "F", supplyUsd: 200_000_000 },
      { id: "material-d", grade: "F", supplyUsd: 100_000_000 },
      // Below the window: immaterial supply cannot dilute the cohort.
      { id: "sub-window", grade: "F", supplyUsd: 99_999_999 },
      // No supply observation: outside the cohort, so it cannot dilute it.
      { id: "immaterial", grade: "F", supplyUsd: null },
    ]);

    expect(metrics.materialCohortCMinusOrBetterShare).toBe(0.5);
    expect(metrics.materialCohortBMinusOrBetterCount).toBe(1);
  });

  it("D5 membership is stable when a lower-ranked asset appears above a cohort member", () => {
    // The retired top-50 cutoff dropped a stable member whenever enough assets
    // sorted above it; a supply window only moves when the member's own supply
    // crosses the line.
    const member = { id: "stable-member", grade: "B-" as const, supplyUsd: 150_000_000 };
    const before = metricsFor([member, { id: "other", grade: "F", supplyUsd: 120_000_000 }]);
    const after = metricsFor([
      member,
      { id: "other", grade: "F", supplyUsd: 120_000_000 },
      ...Array.from({ length: 60 }, (_, index) => ({
        id: `newly-visible-${index}`,
        grade: "F" as const,
        supplyUsd: 200_000_000,
      })),
    ]);

    expect(before.materialCohortBMinusOrBetterCount).toBe(1);
    expect(after.materialCohortBMinusOrBetterCount).toBe(1);
  });

  it("splits the unattributed F cohort into curable and methodology-blocked classes", () => {
    const floors = { backing: 35, exit: 35, control: 45 };
    const diagnostics = summarizeDistribution(
      distributionReplay([
        { id: "adverse", grade: "F", control: 25 },
        { id: "curable", grade: "F", archetype: "cdp", reasonCodes: ["bounded-mechanism-review"], ...floors },
        {
          id: "blocked",
          grade: "F",
          archetype: "rwa-credit-fund",
          reasonCodes: ["bounded-mechanism-review"],
          ...floors,
        },
      ]),
    ).distributionDiagnostics;

    expect(diagnostics.fCohortClassCounts).toEqual({ a: 1, b: 1, c: 1 });
  });

  it("retires the legacy distribution gates in favour of D1-D6", () => {
    const replay = productionReplay();
    const report = analyzeV9Calibration(structuredClone(replay), replay);

    for (const retired of [
      "fAtMost180",
      "cMinusOrBetterAtLeast35",
      "bMinusOrBetterAtLeast5",
      "largestPillarTupleAtMost20Pct",
      "largestScoreBucketAtMost15Pct",
      "scoreIqrAtLeast12",
    ]) {
      expect(report.gates).not.toHaveProperty(retired);
    }
    for (const gate of [
      "d1MaterialEvidenceCoverageExTop2",
      "d2aSupplyObservationCoverage",
      "d2bMaxNrSupplyUsd",
      "d3aUnattributedFCount",
      "d3bUnattributedFSupplyShare",
      "d4aFreeFloatingLargestBucketShare",
      "d4bFreeFloatingLargestTupleShare",
      "d5aMaterialCohortCMinusOrBetterShare",
      "d5bMaterialCohortBMinusOrBetterCount",
      "d6ScoreIqr",
    ]) {
      expect(report.gates).toHaveProperty(gate);
    }
    // The preserved non-distribution gates are untouched.
    for (const preserved of ["baselineLocked", "sameInput", "coverage", "realA", "adverseControlsUnchanged"]) {
      expect(report.gates).toHaveProperty(preserved);
    }
  });

  it("reports a supply-weighted metric as unavailable when no supply is observed", () => {
    const metrics = metricsFor([
      { id: "no-supply-a", grade: "C", supplyUsd: null },
      { id: "no-supply-b", grade: "F", supplyUsd: null },
    ]);

    // Null metrics fail their gate closed rather than reading as a pass.
    expect(metrics.materialEvidenceCoverageExTop2).toBeNull();
    expect(metrics.unattributedFSupplyShare).toBeNull();
    expect(metrics.materialCohortCMinusOrBetterShare).toBeNull();
    expect(metrics.supplyObservationCoverage).toBe(0);
    expect(metrics.maxNrSupplyUsd).toBe(0);
  });
});
