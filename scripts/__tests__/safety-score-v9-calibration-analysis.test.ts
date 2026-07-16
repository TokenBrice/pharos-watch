import { describe, expect, it } from "vitest";
import {
  analyzeV9Calibration,
  computeCalibrationBaseInputGenerationId,
  computeCalibrationCandidateId,
  computeCalibrationFactSetDigest,
  computeCalibrationIdentityDigest,
  computeCalibrationResultDigest,
} from "../maintenance/analyze-safety-score-v9-calibration.mjs";

const ADVERSE = [
  ["usdd-tron-dao-reserve", 31, "F"],
  ["u-united-stables", 31, "F"],
  ["usdai-usd-ai", 39, "F"],
  ["tusd-trueusd", 53, "C-"],
  ["eurs-stasis", 20, "F"],
  ["mim-abracadabra", 0, "F"],
] as const;

function card(id: string, score: number, grade: string) {
  return {
    id,
    score,
    grade,
    evidence: { level: "strong", freshness: "current", reasons: [] },
    pillars: {
      backing: { score, evidenceLevel: "strong", reasons: [], components: [] },
      exit: { score, evidenceLevel: "strong", reasons: [], components: [] },
      control: { score, evidenceLevel: "strong", reasons: [], components: [] },
    },
    caps: [],
    bindingCap: null,
  };
}

const POLICY_ID = "safety-score-v9-candidate-v2";
const POLICY_DIGEST = "1".repeat(64);
const BUILD_DIGEST = "2".repeat(64);

function replay(boldScore: number, boldGrade: string) {
  const cards = [
    card("bold-liquity", boldScore, boldGrade),
    ...ADVERSE.map(([id, score, grade]) => card(id, score, grade)),
  ];
  const activeAssetIds = cards.map((entry) => entry.id);
  const fixedInput = {
    schemaVersion: 3,
    captureKind: "exact-publication-inputs",
    clockSec: 1_700_000_000,
    updatedAt: 1_700_000_000,
    activeAssetIds,
    registryFingerprint: "3".repeat(64),
    dexGenerationId: "dex-fixture",
    redemptionGenerationId: "redemption-fixture",
    dexPayloadFingerprint: "4".repeat(64),
    redemptionPayloadFingerprint: "5".repeat(64),
    inputMethodologyVersions: {
      safetyScore: "8.17",
      dexLiquidity: ["4.12"],
      pegScore: ["3.1"],
      redemptionBackstop: ["4.18"],
    },
    pegDataById: {},
    activeDepegPeakBpsById: {},
    dexLiqMap: {},
    redemptionBackstopMap: {},
    bluechipMap: {},
    resolvedBlacklistStatuses: {},
    liveReserveMap: {},
    liveReserveProvenanceMap: {},
    chainCirculatingById: {},
    dexDeploymentSupplyCoverageById: {},
    liquidityStale: false,
    redemptionStale: false,
    inputFreshness: {},
    sourceGeneration: "source",
    baseInputGenerationId: "",
  };
  fixedInput.baseInputGenerationId = computeCalibrationBaseInputGenerationId(fixedInput);

  const compiledFacts = {
    schemaVersion: 2,
    baseInputGenerationId: fixedInput.baseInputGenerationId,
    asOfSec: fixedInput.clockSec,
    sourceFingerprints: {},
    activeAssetIds,
    assets: cards.map((entry) => ({
      assetId: entry.id,
      gaps: [] as Array<{
        ownerDomain: string;
        reasonCode: string;
        observationState: string;
        path: { kind: string };
      }>,
    })),
    v9FactSetDigest: "",
  };
  compiledFacts.v9FactSetDigest = computeCalibrationFactSetDigest(compiledFacts);

  const evaluatedAssets = cards.map((entry) => ({
    assetId: entry.id,
    stressState: { exitPortfolio: { circulatingUsd: 1_000_000 } },
    backing: { contributions: [] },
    exit: {
      routes:
        entry.id === "bold-liquity"
          ? [
              {
                routeKey: "dex:fixture:bold",
                included: true,
                score: 90,
                capacityPoint: { executableUsd: 1_000_000 },
              },
            ]
          : [],
    },
    control: { components: [] },
    scoreInput: {
      pillars: {
        backing: { score: entry.score, evidenceLevel: "strong" },
        exit: { score: entry.score, evidenceLevel: "strong" },
        control: { score: entry.score, evidenceLevel: "strong" },
      },
    },
    trace: {
      assetId: entry.id,
      finalScore: entry.score,
      finalGrade: entry.grade,
      pillarContributions: [
        { pillar: "backing", score: entry.score },
        { pillar: "exit", score: entry.score },
        { pillar: "control", score: entry.score },
      ],
      weakestPillar: { pillar: "backing", score: entry.score },
      bindingCap: null,
      nrReasons: [],
      factSetDigest: compiledFacts.v9FactSetDigest,
      baseInputGenerationId: fixedInput.baseInputGenerationId,
      policyId: POLICY_ID,
      policyDigest: POLICY_DIGEST,
      evaluationBuildDigest: BUILD_DIGEST,
      asOfSec: fixedInput.clockSec,
    },
  }));
  const evaluatedSet = {
    factSetDigest: compiledFacts.v9FactSetDigest,
    policyId: POLICY_ID,
    policyDigest: POLICY_DIGEST,
    evaluationBuildDigest: BUILD_DIGEST,
    assets: evaluatedAssets,
    scoreResultDigest: "",
  };
  evaluatedSet.scoreResultDigest = computeCalibrationResultDigest(evaluatedSet);

  const compilerFactSchemaIdentity = {
    schemaVersion: 1,
    fixedInputSchemaVersion: 3,
    factExtensionSchemaVersion: 2,
    compiledFactSchemaVersion: 2,
    compiledFactSchemaCapabilities: ["canonical-chain-supply-distribution.v1", "exit-route-modeled-confidence.v1"],
    compilerAdapter: "exact-fixed-input-to-v9-facts.v1",
    evaluationBuildDigest: BUILD_DIGEST,
  };
  const producerCapabilityIdentity = {
    schemaVersion: 1,
    inputContractVersions: { fixedInput: 3, factExtension: 2 },
    sourceAdapters: {
      registry: "fixed-input.registry.v1",
      dexExitRoutes: "fixed-input.dex-exit-observations.v2",
      redemptionExitRoutes: "fixed-input.redemption-exit-observations.v2",
      liveReserves: "fixed-input.live-reserves.v1",
      chainSupply: "fixed-input.usd-circulating-supply.v2",
      peg: "fixed-input.peg-summary.v1",
      researchOverlays: "v9-fact-extension.review-overlays.v2",
    },
    scoreBearingMethodologyVersions: {
      dexExitRoutes: ["4.12"],
      redemptionExitRoutes: ["4.18"],
      peg: ["3.1"],
    },
    dexRouteCapabilityMatrixVersions: [`declared-source-capabilities:v1:${"6".repeat(64)}`],
    freshnessPolicySec: {
      dexExitRoutes: 3_600,
      redemptionExitRoutes: 28_800,
      documentedTermsExitRoutes: 31_536_000,
      liveReserves: 28_800,
      chainSupply: 1_800,
      peg: 1_800,
      researchOverlays: 31_536_000,
    },
  };
  const compilerFactSchemaDigest = computeCalibrationIdentityDigest(
    "safety-score-v9.compiler-fact-schema.v1",
    compilerFactSchemaIdentity,
  );
  const producerCapabilityDigest = computeCalibrationIdentityDigest(
    "safety-score-v9.producer-capability-build.v1",
    producerCapabilityIdentity,
  );
  const candidateIdentity = {
    schemaVersion: 1,
    policyId: POLICY_ID,
    policyDigest: POLICY_DIGEST,
    evaluationBuildDigest: BUILD_DIGEST,
    compilerFactSchemaDigest,
    producerCapabilityDigest,
  };
  return {
    pipeline: {
      candidateIdentity,
      compilerFactSchemaIdentity,
      compilerFactSchemaDigest,
      producerCapabilityIdentity,
      producerCapabilityDigest,
      fixedInput,
      extension: {
        schemaVersion: 2,
        routeFreshness: {
          dexMaxAgeSec: 3_600,
          redemptionMaxAgeSec: 28_800,
          documentedTermsMaxAgeSec: 31_536_000,
        },
        sources: {
          liveReserves: { maxAgeSec: 28_800 },
          chainSupply: { maxAgeSec: 1_800 },
          peg: { maxAgeSec: 1_800 },
          researchOverlays: { maxAgeSec: 31_536_000 },
        },
      },
      candidate: {
        candidateId: computeCalibrationCandidateId(candidateIdentity),
        baseInputGenerationId: fixedInput.baseInputGenerationId,
        factSetDigest: compiledFacts.v9FactSetDigest,
        resultDigest: evaluatedSet.scoreResultDigest,
        cards,
      },
      evaluatedSet,
      compiledFacts,
    },
  };
}

type ReplayFixture = ReturnType<typeof replay>;

function resealResult(artifact: ReplayFixture): void {
  artifact.pipeline.evaluatedSet.scoreResultDigest = computeCalibrationResultDigest(artifact.pipeline.evaluatedSet);
  artifact.pipeline.candidate.resultDigest = artifact.pipeline.evaluatedSet.scoreResultDigest;
}

function setScore(artifact: ReplayFixture, assetId: string, score: number, grade: string): void {
  const card = artifact.pipeline.candidate.cards.find((entry) => entry.id === assetId)!;
  card.score = score;
  card.grade = grade;
  for (const pillar of Object.values(card.pillars) as Array<{ score: number }>) pillar.score = score;
  const evaluated = artifact.pipeline.evaluatedSet.assets.find((entry) => entry.assetId === assetId)!;
  evaluated.trace.finalScore = score;
  evaluated.trace.finalGrade = grade;
  for (const contribution of evaluated.trace.pillarContributions) contribution.score = score;
  for (const pillar of Object.values(evaluated.scoreInput.pillars) as Array<{ score: number }>) pillar.score = score;
  resealResult(artifact);
}

function resealFactSet(artifact: ReplayFixture): void {
  const digest = computeCalibrationFactSetDigest(artifact.pipeline.compiledFacts);
  artifact.pipeline.compiledFacts.v9FactSetDigest = digest;
  artifact.pipeline.evaluatedSet.factSetDigest = digest;
  artifact.pipeline.candidate.factSetDigest = digest;
  for (const asset of artifact.pipeline.evaluatedSet.assets) asset.trace.factSetDigest = digest;
  resealResult(artifact);
}

describe("Safety Score V9 calibration analysis", () => {
  it("detects a real A, unchanged adverse controls, and causal score movement", () => {
    const report = analyzeV9Calibration(replay(79, "B+"), replay(84, "A"));

    expect(report.realA).toEqual([{ assetId: "bold-liquity", score: 84, grade: "A" }]);
    expect(report.gates.realA).toBe(true);
    expect(report.realACandidates[0]?.checks).toEqual({
      gradeAndRange: true,
      positiveSupply: true,
      executableDexRoute: true,
      strongEvidence: true,
      currentEvidence: true,
      assetWideControlsResolved: true,
    });
    expect(report.gates.adverseControlsUnchanged).toBe(true);
    expect(report.changes).toEqual([
      expect.objectContaining({
        assetId: "bold-liquity",
        score: { from: 79, to: 84, delta: 5 },
        grade: { from: "B+", to: "A" },
      }),
    ]);
    expect(report.uncertaintyLedger.top80BySupply).toHaveLength(7);
  });

  it("fails the adverse gate on any same-input lift", () => {
    const baseline = replay(79, "B+");
    const candidate = replay(84, "A");
    setScore(candidate, "usdd-tron-dao-reserve", 32, "F");

    const report = analyzeV9Calibration(baseline, candidate);
    expect(report.gates.adverseControlsUnchanged).toBe(false);
    expect(report.adverseControls.find((entry) => entry.assetId === "usdd-tron-dao-reserve")?.lifted).toBe(true);
  });

  it("binds same-input counterfactuals by base input rather than the derived fact set", () => {
    const baseline = replay(79, "B+");
    const candidate = replay(84, "A");
    Object.assign(candidate.pipeline.compiledFacts.assets[0], { compilerCorrection: true });
    resealFactSet(candidate);

    expect(analyzeV9Calibration(baseline, candidate).gates.sameInput).toBe(true);

    candidate.pipeline.evaluatedSet.factSetDigest = "6".repeat(64);
    expect(() => analyzeV9Calibration(baseline, candidate)).toThrow("fact-set digest");
    candidate.pipeline.evaluatedSet.factSetDigest = candidate.pipeline.compiledFacts.v9FactSetDigest;

    candidate.pipeline.candidate.baseInputGenerationId = "different-input";
    expect(() => analyzeV9Calibration(baseline, candidate)).toThrow("candidate and fixed-input generations");
  });

  it("rejects payload, result, and candidate identity tampering", () => {
    const baseline = replay(79, "B+");

    const payloadTamper = replay(84, "A");
    Object.assign(payloadTamper.pipeline.fixedInput.pegDataById, { injected: { score: 100 } });
    expect(() => analyzeV9Calibration(baseline, payloadTamper)).toThrow("score-bearing payload");

    const resultTamper = replay(84, "A");
    resultTamper.pipeline.candidate.cards[0].score = 85;
    expect(() => analyzeV9Calibration(baseline, resultTamper)).toThrow("evaluated trace");

    const identityTamper = replay(84, "A");
    identityTamper.pipeline.candidate.candidateId = `safety-score-v9-candidate:v1:${"7".repeat(64)}`;
    expect(() => analyzeV9Calibration(baseline, identityTamper)).toThrow("candidate ID");

    const compilerBuildTamper = replay(84, "A");
    compilerBuildTamper.pipeline.compilerFactSchemaIdentity.evaluationBuildDigest = "8".repeat(64);
    compilerBuildTamper.pipeline.compilerFactSchemaDigest = computeCalibrationIdentityDigest(
      "safety-score-v9.compiler-fact-schema.v1",
      compilerBuildTamper.pipeline.compilerFactSchemaIdentity,
    );
    compilerBuildTamper.pipeline.candidateIdentity.compilerFactSchemaDigest =
      compilerBuildTamper.pipeline.compilerFactSchemaDigest;
    compilerBuildTamper.pipeline.candidate.candidateId = computeCalibrationCandidateId(
      compilerBuildTamper.pipeline.candidateIdentity,
    );
    expect(() => analyzeV9Calibration(baseline, compilerBuildTamper)).toThrow("compiler schema/build identity");

    const compilerAdapterTamper = replay(84, "A");
    compilerAdapterTamper.pipeline.compilerFactSchemaIdentity.compilerAdapter = "tampered-compiler-adapter";
    compilerAdapterTamper.pipeline.compilerFactSchemaDigest = computeCalibrationIdentityDigest(
      "safety-score-v9.compiler-fact-schema.v1",
      compilerAdapterTamper.pipeline.compilerFactSchemaIdentity,
    );
    compilerAdapterTamper.pipeline.candidateIdentity.compilerFactSchemaDigest =
      compilerAdapterTamper.pipeline.compilerFactSchemaDigest;
    compilerAdapterTamper.pipeline.candidate.candidateId = computeCalibrationCandidateId(
      compilerAdapterTamper.pipeline.candidateIdentity,
    );
    expect(() => analyzeV9Calibration(baseline, compilerAdapterTamper)).toThrow("compiler identity");

    const producerContractTamper = replay(84, "A");
    producerContractTamper.pipeline.producerCapabilityIdentity.inputContractVersions.fixedInput = 2;
    producerContractTamper.pipeline.producerCapabilityDigest = computeCalibrationIdentityDigest(
      "safety-score-v9.producer-capability-build.v1",
      producerContractTamper.pipeline.producerCapabilityIdentity,
    );
    producerContractTamper.pipeline.candidateIdentity.producerCapabilityDigest =
      producerContractTamper.pipeline.producerCapabilityDigest;
    producerContractTamper.pipeline.candidate.candidateId = computeCalibrationCandidateId(
      producerContractTamper.pipeline.candidateIdentity,
    );
    expect(() => analyzeV9Calibration(baseline, producerContractTamper)).toThrow("producer identity");
  });

  it("rejects an A without executable trading evidence or with an asset-wide control gap", () => {
    const baseline = replay(79, "B+");
    const candidate = replay(84, "A");
    const bold = candidate.pipeline.evaluatedSet.assets.find((entry) => entry.assetId === "bold-liquity")!;
    bold.exit.routes = [];

    expect(analyzeV9Calibration(baseline, candidate).gates.realA).toBe(false);

    bold.exit.routes = [
      {
        routeKey: "dex:fixture:bold",
        included: true,
        score: 90,
        capacityPoint: { executableUsd: 1_000_000 },
      },
    ];
    candidate.pipeline.compiledFacts.assets.find((entry) => entry.assetId === "bold-liquity")!.gaps = [
      {
        ownerDomain: "control",
        reasonCode: "unresolved-control-identity",
        observationState: "bounded-unknown",
        path: { kind: "local-component" },
      },
    ];
    resealFactSet(candidate);

    expect(analyzeV9Calibration(baseline, candidate).gates.realA).toBe(false);
  });
});
