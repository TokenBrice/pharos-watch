import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { vi } from "vitest";
import type { SafetyScoreV9CurrentResponseSchema } from "../safety-score-v9-publication-response";
import type { SafetyScoreV9BreakdownsSchema } from "../safety-score-v9-public-breakdowns";
import { V9_PUBLIC_EVIDENCE_RESPONSIBILITIES as EVIDENCE_RESPONSIBILITIES } from "../safety-score-v9-vocabulary";

type CurrentResponse = z.output<typeof SafetyScoreV9CurrentResponseSchema>;

const DIGEST = "a".repeat(64);

function emptyAttribution<S extends string>(semantics: S) {
  return { semantics, items: [] as never[] };
}

function emptyEvidenceSummary<R extends string>(responsibility: R) {
  return { responsibility, factCount: 0, criticalFactCount: 0, reasonCodes: [] as never[] };
}

function includedPillar() {
  return { aggregationDisposition: "included" as const, supportedComponentKeys: ["fixture-known"], causeGapRefs: [], limitedEvidenceCauses: [] };
}
function includedBreakdown() {
  const { supportedComponentKeys: _supported, ...fields } = includedPillar();
  return fields;
}

function includedContribution(effectiveScoringWeight: number) {
  return { cause: null, causeGapRefs: [], scoringDisposition: "included" as const, effectiveScoringWeight };
}

function pillar(score: number): CurrentResponse["cards"][number]["pillars"]["backing"] {
  return {
    score,
    ...includedPillar(),
    evidenceLevel: "strong",
    freshness: "current",
    components: [],
    reasons: [],
  };
}

export function breakdowns(backingScore = 90, exitScore = 92, controlScore = 95.2): z.output<typeof SafetyScoreV9BreakdownsSchema> {
  const exitComponents = [
    ["access", "Access", 0.2],
    ["settlement", "Settlement", 0.15],
    ["executionCertainty", "Execution certainty", 0.15],
    ["capacity", "Capacity", 0.25],
    ["outputAssetQuality", "Output asset quality", 0.15],
    ["cost", "Cost", 0.1],
  ] as const;
  return {
    backing: {
      ...includedBreakdown(),
      evaluatedScore: backingScore,
      publishedScore: backingScore,
      aggregationWeight: 0.4,
      groups: [{ key: "reserves", label: "Reserves", score: backingScore, ...includedContribution(1) }],
      components: [{
        key: "reserve:cash",
        label: "Cash",
        source: "reserve-exposure",
        score: backingScore,
        ...includedContribution(1),
        wholeAssetWeight: 1,
        weightedContribution: backingScore,
        observationState: "known",
      }],
      adjustments: [],
    },
    exit: {
      ...includedBreakdown(),
      evaluatedScore: exitScore,
      publishedScore: exitScore,
      aggregationWeight: 0.35,
      stressRequest: {
        requestedNotionalUsd: 1_000_000,
        maxCostBps: 200,
        comparisonWindowSec: 86_400,
      },
      primaryRoute: {
        key: "redemption:main",
        routeId: "main",
        lane: "redemption",
        label: "Protocol redemption",
        routeFamily: "protocol-redemption",
        score: exitScore,
        components: exitComponents.map(([key, label, weight]) => ({
          key,
          label,
          score: exitScore,
          weight,
          ...includedContribution(weight),
          weightedContribution: exitScore * weight,
        })),
        confidenceFactor: 1,
        confidenceDimensions: {
          observation: { factor: 1, cause: null, causeGapRefs: [] },
          model: { factor: 1, cause: null, causeGapRefs: [] },
          capacityMethod: { factor: 1, cause: null, causeGapRefs: [] },
        },
        capacityEvidenceTier: "live-direct",
        rawSameNotionalCostBps: 0,
        supportedComponentCeiling: exitScore,
        capsApplied: [],
      },
      diversification: null,
      alternatives: [],
      adjustments: [],
    },
    control: {
      ...includedBreakdown(),
      evaluatedScore: controlScore,
      publishedScore: controlScore,
      aggregationWeight: 0.25,
      method: "minimum-binding-component",
      components: [{
        key: "control:mint",
        label: "Mint control",
        kind: "mint",
        score: controlScore,
        ...includedContribution(1),
        binding: true,
        posture: "distributed",
      }],
      adjustments: [],
    },
  };
}

function response() {
  return {
    model: "v9-critical-path",
    schemaVersion: 1,
    lifecycle: "candidate",
    candidateId: "candidate-v1",
    policyVersion: "candidate-v1",
    publicationGenerationId: "safety-score:v9:1",
    baseInputGenerationId: `report-cards-input:v1:${"b".repeat(64)}`,
    factSetDigest: DIGEST,
    resultDigest: "c".repeat(64),
    policy: { id: "safety-score-v9-candidate-v1", semanticDigest: "d".repeat(64) },
    evaluationBuildDigest: "e".repeat(64),
    sourceGenerations: { dex: "dex:g1", registry: "registry:g1" },
    asOfSec: 100,
    publishedAtSec: 101,
    completeness: { expectedCount: 1, ratedCount: 1, notRatedCount: 0, notRatedIds: [], pipelineGapCount: 0, pipelineGapIds: [] },
    foreignCauseGaps: [],
    cards: [
      {
        id: "asset",
        localCauseGaps: [], foreignCauseGapRefs: [],
        score: 90,
        grade: "A+",
        ratingStatus: "rated",
        partialEvidence: null,
        qualityScore: 92,
        pegMultiplier: 1,
        pegAdjustedScore: 92,
        pillars: { backing: pillar(90), exit: pillar(92), control: pillar(95.2) },
        weakestPillar: { pillar: "backing", score: 90 },
        caps: [
          { kind: "track-record", limit: 90, source: "track-record", reason: "Track record binds.", binding: true },
        ],
        bindingCap: {
          kind: "track-record",
          limit: 90,
          source: "track-record",
          reason: "Track record binds.",
          binding: true,
        },
        nrReasons: [],
        reasonCodes: [],
        evidence: { level: "strong", freshness: "current", reasons: [] },
        accessPosture: {
          transfer: "restrictable",
          freezeExposure: "direct",
          primaryExit: "eligibility-gated",
          governance: "single-entity",
          unknownFields: [],
          signals: [
            "freeze:direct",
            "governance:single-entity",
            "primary-exit:eligibility-gated",
            "transfer:restrictable",
          ],
          reasons: [],
        },
        dependencies: { serial: [], basket: [], cycleBlocked: false, reasonCodes: [] },
      },
    ],
  } as const;
}

export function currentResponse() {
  const current = response() as unknown as CurrentResponse;
  current.schemaVersion = 8;
  current.lifecycle = "active";
  current.policyVersion = "9.0";
  current.policy = { id: "safety-score-v9", semanticDigest: "d".repeat(64) };
  current.openEvidence = {
    semantics: "open-question-v1",
    totals: { questions: 0, open: 0, issuer: 0, documentation: 0, obligations: 0 },
    owners: [],
    reasons: [],
    documentation: { questions: 0, datums: 0, facts: 0, reasons: [] },
    issuer: { questions: 0, assets: 0, oldestReviewedAtSec: null, newestReviewedAtSec: null },
    byCard: [],
  };
  current.cards[0]!.scoreTrace = {
    schemaVersion: 4,
    legacyAliases: {
      qualityScore: "weighted-pillar-mean",
      pegAdjustedScore: "post-deployment-pre-cap-score",
      score: "post-cap-public-score",
    },
    aggregation: {
      method: "smooth-bounded-headroom",
      includedPillars: ["backing", "control", "exit"],
      excludedPillars: [],
      effectiveScoringWeights: { backing: 0.4, exit: 0.35, control: 0.25 },
      supportCeiling: 92,
      score: 92,
      weightedPillarMean: 92,
      weakestPillar: "backing",
      weakestScore: 90,
      headroom: 45,
    },
    stages: {
      weightedPillarMean: 92,
      aggregatedQualityScore: 92,
      pegMultiplier: 1,
      baseAssetScore: 92,
      deploymentAdjustedScore: 92,
      deploymentAdjustmentPoints: 0,
      preCapScore: 92,
      publishedScore: 90,
    },
    deploymentRisk: {
      method: "holder-slice-exposure-weighted-v2",
      totalAdjustmentPoints: 0,
      adjustments: [],
      unresolvedExposures: [],
    },
    adverseAttribution: emptyAttribution("causal-measured-adverse-v1"),
    boundedUncertaintyAttribution: emptyAttribution("causal-bounded-uncertainty-v1"),
    evidenceResponsibility: {
      semantics: "limiting-fact-cause-v2",
      totalFactCount: 0,
      facts: [],
      summaries: EVIDENCE_RESPONSIBILITIES.map(emptyEvidenceSummary),
    },
    scoreAdjustments: [],
    wrapperParentLimit: null,
  };
  current.cards[0]!.breakdowns = breakdowns();
  return current;
}

export function adjustedResponse() {
  const adjusted = currentResponse();
  const card = adjusted.cards[0]!;
  card.score = 87;
  card.grade = "A+";
  card.pegAdjustedScore = 87;
  card.caps = [];
  card.bindingCap = null;
  card.scoreTrace.stages.baseAssetScore = 83;
  card.scoreTrace.stages.deploymentAdjustedScore = 83;
  card.scoreTrace.stages.preCapScore = 87;
  card.scoreTrace.stages.publishedScore = 87;
  card.scoreTrace.scoreAdjustments = [{
    source: "asset-premium",
    kind: "market-anchor-longevity",
    label: "#1 & Longevity Premium",
    configuredPoints: 12,
    appliedPoints: 4,
    scoreBefore: 83,
    scoreAfter: 87,
    publishedScoreBefore: 83,
    publishedScoreAfter: 87,
  }];
  return adjusted;
}

export function boundedResponse() {
  const bounded = currentResponse();
  bounded.cards[0]!.localCauseGaps = ["mechanism"];
  bounded.cards[0]!.score = 45;
  bounded.cards[0]!.grade = "D";
  bounded.cards[0]!.qualityScore = 45;
  bounded.cards[0]!.pegAdjustedScore = 45;
  bounded.cards[0]!.pillars = {
    backing: {
      ...includedPillar(),
      causeGapRefs: [0],
      limitedEvidenceCauses: ["U"],
      score: 45,
      evidenceLevel: "limited",
      freshness: "current",
      components: [],
      reasons: [{
        code: "bounded-mechanism-review",
        path: "backing:mechanism",
        message: "A bounded backing review remains unresolved.",
      }],
    },
    exit: { ...pillar(45), components: [], reasons: [] },
    control: { ...pillar(45), components: [], reasons: [] },
  };
  bounded.cards[0]!.breakdowns = breakdowns(45, 45, 45);
  bounded.cards[0]!.weakestPillar = { pillar: "backing", score: 45 };
  bounded.cards[0]!.caps = bounded.cards[0]!.caps.map((cap) => ({ ...cap, binding: false }));
  bounded.cards[0]!.bindingCap = null;
  bounded.cards[0]!.reasonCodes = ["bounded-mechanism-review"];
  bounded.cards[0]!.scoreTrace.aggregation = {
    method: "smooth-bounded-headroom",
    includedPillars: ["backing", "control", "exit"], excludedPillars: [],
    effectiveScoringWeights: { backing: 0.4, exit: 0.35, control: 0.25 }, supportCeiling: 45,
    score: 45,
    weightedPillarMean: 45,
    weakestPillar: "backing",
    weakestScore: 45,
    headroom: 45,
  };
  Object.assign(bounded.cards[0]!.scoreTrace.stages, {
    weightedPillarMean: 45,
    aggregatedQualityScore: 45,
    baseAssetScore: 45,
    deploymentAdjustedScore: 45,
    preCapScore: 45,
    publishedScore: 45,
  });
  bounded.cards[0]!.scoreTrace.boundedUncertaintyAttribution.items = [{
    source: "reason",
    code: "bounded-mechanism-review",
    path: "backing:mechanism",
    message: "A bounded backing review remains unresolved.",
    responsibility: "unresearched",
    cause: "U",
    causeGapRefs: [0],
  }];
  bounded.cards[0]!.scoreTrace.evidenceResponsibility.totalFactCount = 1;
  bounded.cards[0]!.scoreTrace.evidenceResponsibility.facts = [[
    "bounded-mechanism-review", "backing:mechanism", 0, "unresearched", false, "U", [0],
  ]];
  bounded.cards[0]!.scoreTrace.evidenceResponsibility.summaries[7] = {
    responsibility: "unresearched",
    factCount: 1,
    criticalFactCount: 0,
    reasonCodes: ["bounded-mechanism-review"],
  };
  return bounded;
}

export function deploymentResponse() {
  const result = currentResponse();
  const card = result.cards[0]!;
  card.pegAdjustedScore = 90;
  Object.assign(card.scoreTrace.stages, {
    deploymentAdjustedScore: 90,
    deploymentAdjustmentPoints: 2,
    preCapScore: 90,
  });
  card.scoreTrace.deploymentRisk.totalAdjustmentPoints = 2;
  card.scoreTrace.deploymentRisk.adjustments = ["a", "b"].map((key, index) => ({
    signalKey: key,
    sourceSignalKeys: [key],
    exposureKey: key,
    riskEventKey: `event:${key}`,
    failureDomainKey: `domain:${key}`,
    nominalExposureShare: 0.5,
    exposureShare: 0.5,
    exposedScore: 90,
    scoreBefore: 92 - index,
    scoreAfter: 91 - index,
    adjustmentPoints: 1,
    modeledLossPoints: 1,
    reason: "Measured deployment exposure.",
  }));
  return result;
}

export function partialResponse(
  excluded: readonly ("backing" | "exit" | "control")[],
  unavailable: readonly ("backing" | "exit" | "control")[] = [],
) {
  const result = currentResponse();
  const card = result.cards[0]!;
  const pillars = ["backing", "control", "exit"] as const;
  const excludedPillars = [...excluded].sort();
  const excludedAB = excludedPillars.filter((key) => !unavailable.includes(key));
  card.localCauseGaps = excludedAB;
  const included = pillars.filter((key) => !excluded.includes(key));
  const pipeline = included.length < 2;
  const weights = { backing: 0.4, exit: 0.35, control: 0.25 };
  const totalWeight = included.reduce((sum, key) => sum + weights[key], 0);
  for (const key of pillars) {
    card.breakdowns![key].aggregationWeight = pipeline || excluded.includes(key) ? 0 : weights[key] / totalWeight;
    if (!excluded.includes(key)) continue;
    if (unavailable.includes(key)) {
      Object.assign(card.pillars[key], {
        score: null, aggregationDisposition: "unavailable", supportedComponentKeys: [],
        causeGapRefs: [], limitedEvidenceCauses: [],
      });
      Object.assign(card.breakdowns![key], {
        evaluatedScore: null, publishedScore: null, aggregationDisposition: "unavailable",
        causeGapRefs: [], limitedEvidenceCauses: [], adjustments: [],
      });
      if (key === "backing") {
        card.breakdowns!.backing.groups = [];
        card.breakdowns!.backing.components = [];
      } else if (key === "exit") {
        card.breakdowns!.exit.primaryRoute = null;
        card.breakdowns!.exit.diversification = null;
        card.breakdowns!.exit.alternatives = [];
      } else {
        card.breakdowns!.control.components = [];
      }
      continue;
    }
    const cause = key === "exit" ? "B" as const : "A" as const;
    const gapRef = excludedAB.indexOf(key);
    const disposition = cause === "A" ? "excluded-pipeline" as const : "excluded-uncurated" as const;
    const diagnostic = { cause, causeGapRefs: [gapRef], scoringDisposition: disposition, effectiveScoringWeight: 0, score: null };
    Object.assign(card.pillars[key], {
      score: null, aggregationDisposition: "excluded-a-b", supportedComponentKeys: [],
      causeGapRefs: [gapRef], limitedEvidenceCauses: [],
    });
    Object.assign(card.breakdowns![key], {
      evaluatedScore: null, publishedScore: null, aggregationDisposition: "excluded-a-b",
      causeGapRefs: [gapRef], limitedEvidenceCauses: [], adjustments: [],
    });
    if (key === "backing") {
      for (const row of card.breakdowns!.backing.groups) Object.assign(row, diagnostic);
      for (const row of card.breakdowns!.backing.components) Object.assign(row, diagnostic, { weightedContribution: 0, observationState: "missing" });
    } else if (key === "exit") {
      const route = card.breakdowns!.exit.primaryRoute!;
      route.score = null; route.supportedComponentCeiling = null; route.rawSameNotionalCostBps = null;
      for (const row of route.components) Object.assign(row, diagnostic, { weightedContribution: 0 });
      for (const dimension of Object.values(route.confidenceDimensions)) Object.assign(dimension, { factor: 1, cause, causeGapRefs: [gapRef] });
    } else {
      for (const row of card.breakdowns!.control.components) Object.assign(row, diagnostic, { binding: false });
    }
  }
  if (excluded.length > 0) {
    card.partialEvidence = {
      reasonCode: "partial-evidence-pipeline-gap", excludedPillars,
      excludedComponentKeys: excludedAB.map((key) => `${key}:fixture-known`),
      causeGapRefs: excludedAB.map((_, index) => index),
      causes: excludedAB.includes("exit") && excludedAB.length > 1 ? ["A", "B"] : excludedAB.includes("exit") ? ["B"] : excludedAB.length > 0 ? ["A"] : [],
    };
    card.reasonCodes = ["partial-evidence-pipeline-gap"];
  }
  if (pipeline) {
    Object.assign(card, { ratingStatus: "pipeline-gap", score: null, grade: null, qualityScore: null,
      pegMultiplier: null, pegAdjustedScore: null, weakestPillar: null, bindingCap: null });
    for (const cap of card.caps) cap.binding = false;
    card.reasonCodes = [excluded.length === 3 ? "all-pillars-pipeline-gap" : "single-pillar-pipeline-gap", "partial-evidence-pipeline-gap"].sort() as typeof card.reasonCodes;
    card.scoreTrace.aggregation = null;
    for (const field of Object.keys(card.scoreTrace.stages) as (keyof typeof card.scoreTrace.stages)[]) card.scoreTrace.stages[field] = null;
    card.scoreTrace.deploymentRisk.totalAdjustmentPoints = null;
    Object.assign(result.completeness, { ratedCount: 0, pipelineGapCount: 1, pipelineGapIds: [card.id] });
  } else if (excluded.length > 0) {
    const effectiveScoringWeights = { backing: 0, exit: 0, control: 0 };
    for (const key of included) effectiveScoringWeights[key] = weights[key] / totalWeight;
    const mean = included.reduce((sum, key) => sum + card.pillars[key].score! * effectiveScoringWeights[key], 0);
    const weakest = included.reduce((left, right) => card.pillars[left].score! <= card.pillars[right].score! ? left : right);
    card.qualityScore = mean; card.pegAdjustedScore = mean;
    card.weakestPillar = { pillar: weakest, score: card.pillars[weakest].score! };
    Object.assign(card.scoreTrace.aggregation!, {
      score: mean, weightedPillarMean: mean, supportCeiling: mean, includedPillars: included,
      excludedPillars, effectiveScoringWeights, weakestPillar: weakest, weakestScore: card.pillars[weakest].score,
    });
    Object.assign(card.scoreTrace.stages, { weightedPillarMean: mean, aggregatedQualityScore: mean,
      baseAssetScore: mean, deploymentAdjustedScore: mean, preCapScore: mean });
  }
  return result;
}

// Frozen reader vocabulary from 10555474f4, before issue #1918.
export const PRE_DUST_REASON_CODES = (
  "bounded-mechanism-review|bounded-unknown-reserve-exposure|correlated-exit-routes|critical-unresolved|future-dated-input-fact|historical-critical-input|implementation-parent-cycle|incomparable-route-requests|incomplete-dex-route-coverage|incomplete-oracle-liquidation-branch|" +
  "inherited-access-exposure|reviewed-possible-access|insufficient-evidence|material-bridge-supply-unmatched|material-dependency-unavailable|material-reserve-slice-unstructured|material-unknown-reserve-exposure|mint-control-question|missing-applicable-peg|missing-archetype|" +
  "missing-bridge-route-rows|missing-bridge-routes|missing-custody-profile|missing-implementation-date|missing-latest-assurance-report|missing-mint-authority|missing-oracle-profile|missing-parent-score|missing-peg-input|peg-price-unavailable-adverse-history|" +
  "peg-supply-floor-withheld|missing-pillar|missing-access-review|missing-pillar-evidence|missing-required-oracle-branches|missing-reserve-composition|missing-runtime-route-evidence|missing-same-notional-route|unproven-settlement-bound|missing-upgrade-control|" +
  "missing-upgradeability-review|nonmaterial-bridge-supply-unmatched|nonmaterial-dependency-unavailable|no-viable-exit-path|oracle-topology-undisclosed|parent-cycle|partial-reserve-review|stale-audited-reserve-composition|runtime-bridge-materiality-unavailable|scoped-control-question|" +
  "selected-bridge-route-missing|selected-bridge-route-unresolved|unknown-control-cap-authority|unknown-control-mint-ability|unknown-upgrade-authority|unresolved-control-identity|unresolved-exit-output|unresolved-mint-authority|unresolved-oracle-branch-applicability|unsupported-same-notional-route|" +
  "unreviewed-dependency-relationships|unreviewed-oracle-profile|unreviewed-reserve-envelope|partial-evidence-pipeline-gap|single-pillar-pipeline-gap|all-pillars-pipeline-gap|f-without-measured-adverse"
).split("|");

// Exact pre-dust reader closure; reject future fields/refinements before reusing current modules.
const PRE_DUST_READER_FILES = (
  "bridge-risk.ts|business-calendars.ts|chain-identity.ts|coin-projection.ts|core.ts|" +
  "custody.ts|date-primitives.ts|dependency-graph.ts|dependency-types.ts|deployment-amounts.ts|deployment-id.ts|exit-route-identity.ts|exit-route.ts|" +
  "live-reserve-core.ts|methodology-envelope.ts|mint-authority-vocabulary.ts|oracle-risk.ts|redemption.ts|report-card-grade.ts|report-cards-v9-materialization.ts|" +
  "report-cards-v9-projections.ts|report-cards-v9.ts|reserve-assurance.ts|reserve-bounded-facts.ts|reserve-input.ts|reserves.ts|safety-schema-primitives.ts|safety-score-publication.ts|" +
  "safety-score-v9-access-lookthrough.ts|safety-score-v9-allocation.ts|safety-score-v9-backing.ts|safety-score-v9-causes.ts|safety-score-v9-control-scope.ts|safety-score-v9-deployment-supply-census.ts|safety-score-v9-fact-input-primitives.ts|safety-score-v9-fact-primitives.ts|" +
  "safety-score-v9-facts.ts|safety-score-v9-grade.ts|safety-score-v9-immutable.ts|safety-score-v9-incidents.ts|safety-score-v9-l2-messenger-pending.ts|safety-score-v9-lender-book.ts|safety-score-v9-open-evidence.ts|safety-score-v9-operational-resilience-primitives.ts|" +
  "safety-score-v9-public-attribution.ts|safety-score-v9-public-breakdowns.ts|safety-score-v9-public-cause-gaps.ts|safety-score-v9-public-causes.ts|safety-score-v9-public-evidence-facts.ts|safety-score-v9-public-facts.ts|safety-score-v9-public-historical.ts|safety-score-v9-public-internal.ts|" +
  "safety-score-v9-public-trace.ts|safety-score-v9-public-witness-texts.ts|safety-score-v9-public.ts|safety-score-v9-publication-response.ts|safety-score-v9-quality-pillars.ts|safety-score-v9-reserve-scope.ts|safety-score-v9-supply-attribution.ts|safety-score-v9-vocabulary.ts|safety-score-v9-wrapper.ts|" +
  "safety-score-v9.ts|stablecoin-lifecycle.ts|stablecoin-meta-control-schemas.ts|stablecoin-meta-mint-authority-refinements.ts|stablecoin-meta-primitives.ts|stablecoin-taxonomy.ts|validators.ts|" +
  "yield-vocabulary.ts"
).split("|");
function assertPreviousReaderSource() {
  const hash = createHash("sha256");
  for (const path of PRE_DUST_READER_FILES) {
    let source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    if (path === "safety-score-v9.ts") source = source.replace(/^  "negligible-dex-route",\r?\n/m, "");
    hash.update(path).update("\0").update(source).update("\0");
  }
  const policy = JSON.parse(readFileSync(new URL("../../data/safety-score-v9/methodology-policy-candidate-v1.json", import.meta.url), "utf8")) as {
    semantic: unknown; reasonRegistry: { code: string; defaultTreatment: string }[];
  };
  // Version/identity metadata is not a validator input; semantic policy and charged reason vocabulary are.
  // Hash the same frozen-vocabulary projection the reconstructed reader loads (see previousReader):
  // a post-freeze charged code the pre-dust enum cannot parse is not a reader-input change.
  hash.update("policy-reader-values\0").update(JSON.stringify({
    semantic: policy.semantic,
    reasonCodes: policy.reasonRegistry.filter(reason => reason.defaultTreatment !== "diagnostic" && PRE_DUST_REASON_CODES.includes(reason.code)).map(reason => reason.code),
  }));
  // Dated Mento status has its own snapshot schema. Replay supply provenance is input/fact-set only.
  // Only typed report8 gets the pipeline-gap exception. The previous card rejects admission diagnostics.
  // v10.47 own-liability refresh: optional selfReferential/ownLiability/scopedWeights producer fields
  // only; strict objects and refinements for inputs without them are byte-identical (verified by
  // substituting origin/main's three changed files, which restores the prior digest).
  // v10.48 refresh: vocabulary-additive only — one V9_REASON_CODES member plus one charged policy
  // reason (expired-reviewed-reserve-composition); the policy hash keeps the frozen-vocabulary
  // projection, so the only digest delta is the added enum line itself.
  // v10.48 ceiling refresh: exactly two closure files changed (safety-score-v9-facts.ts,
  // safety-score-v9-public-breakdowns.ts), each adding one optional field
  // (expiredReviewedAdmittedReserveScore fact; admittedScoreCeiling backing component) — strict
  // objects and refinements for inputs without them are byte-identical (verified by substituting
  // the v10.48 commit's two files, which restores the prior 708cb50b… digest). previousReader()
  // rejects admittedScoreCeiling, as the frozen strict breakdown did.
  // v10.50 verified-empty Exit ceiling refresh: additive-only changes in safety-score-v9-facts.ts
  // (optional priorVerifiedEmptyExitCeiling fact) and safety-score-v9.ts + policy.semantic.exit
  // (verifiedEmptyCarryMaxAgeSec = 172800). No public card, breakdown, or trace schema changed;
  // strict public objects and refinements remain byte-identical for all pre-dust inputs.
  // V9 capacity Release 1 refresh (#1827): report-cards-v9-materialization.ts raises
  // V9_PUBLIC_REPRESENTATION_MAX_BYTES 16 -> 24 MiB and exports V9_SITE_MATERIALIZATIONS_MAX_BYTES.
  // The cap only bounds the materialization manifest `bytes` field (a looser max); no card,
  // breakdown or trace schema changed, so every pre-dust input still parses identically
  // (verified by substituting origin/main's file, which restores the prior e4db44ef… digest).
  // v10.53 periodic-filing budget refresh: additive-only changes in safety-score-v9.ts +
  // policy.semantic.evidence.evidenceExpiry (regulatorPeriodicFilingCompositionMaxAgeSec = 11664000)
  // and stablecoin-meta-primitives.ts (optional ReserveReview.compositionFiling). No public card,
  // breakdown, or trace schema changed; strict public objects and refinements remain byte-identical
  // for all pre-dust inputs (verified by substituting 76689b225's three files, which restores the
  // prior 29c92c0f… digest).
  // Redemption v4.55 payout-basket refresh: exit-route.ts replaces the literal 16-member
  // `.max(16)` output bounds with the shared MAX_REDEMPTION_OUTPUT_ASSETS = 32. A looser max only;
  // every pre-dust input still parses identically (verified by substituting 07a0afb4e's
  // exit-route.ts, which restores the prior d4029dcc… digest).
  // v10.54 refresh, two closure files, both additive or narrowly scoped:
  // - safety-score-v9-facts.ts exports PHYSICAL_DELIVERY_CAPACITY_POLICY_RULE_ID and adds a scoped
  //   V9ExitRouteFactV2Schema exemption for diagnostic, score-ineligible redemption-lane
  //   physical-commodity-delivery routes (sameNotionalEligible false, not-applicable route and
  //   capacity status under that exact rule id);
  // - safety-score-v9-supply-attribution.ts adds optional, strict CCIP LockBox bindings and
  //   multi-account escrow backing for reviewed supply plans.
  // No public card, breakdown, or trace schema changed; every pre-dust input still parses
  // identically (verified by substituting fd0259e97's two files, which restores the prior
  // 45c54905… digest).
  // v10.55 + listing-policy v2 refresh: stablecoin-taxonomy.ts (48315a494) replaces retired
  // listing classes with tokenized-fund/review-hold; safety-score-v9.ts appends
  // tokenized-fund-not-graded to V9_REASON_CODES; safety-score-v9-public-attribution.ts adds
  // isUngradedTokenizedFundCard (only matching tokenized-fund-not-graded NR cards); and
  // report-cards-v9.ts adds optional notRatedReason on SafetyGradesResponseSchema. Every
  // pre-dust input still parses identically (verified against base commit 3660bd95c).
  // Delist-code adapter prune (b793b64c9): live-reserve-core.ts removes 9 retired adapter keys
  // from ADAPTER_KEYS (unused by reserve-input.ts or any public card, breakdown, or trace schema);
  // substituting c4726bf73's live-reserve-core.ts restores the prior ac9397e4… digest.
  // v10.55 fx-safety refresh: safety-score-v9-public-attribution.ts exports primaryV9NotRatedReason
  // (prioritizing tokenized-fund-not-graded) and extends isUngradedTokenizedFundCard exemption to
  // serial dependency attribution; report-cards-v9.ts uses primaryV9NotRatedReason in
  // projectSafetyGrades. Both changes are strictly scoped to tokenized-fund-not-graded (absent
  // from PRE_DUST_REASON_CODES), so every pre-dust input parses identically.
  // v10.56 risk-absorption wrapper form: vocabulary-additive only. safety-score-v9-wrapper.ts adds
  // one V9WrapperFormSchema member (risk-absorption) and safety-score-v9-facts.ts admits it for
  // risk-absorption variants beside the two earlier forms. Pre-dust cards carry only the earlier
  // forms and parse identically (verified by substituting 4e9d09b7e's two files, which restores the
  // prior b35c7f4b… digest).
  // #2341 PR-1 strict-schema widening: stablecoin-taxonomy.ts exports ListingClassSchema;
  // dependency-graph.ts and report-cards-v9.ts add optional nullable listingClass on
  // DependencyGraphNodeSchema and SafetyGradesResponseSchema (no card/breakdown/trace changes;
  // substituting origin/main's 3 files restores the prior a660a454… digest).
  // v10.57 lapsed bridge review monotonicity (#2327): additive-only schema changes in
  // bridge-risk.ts ("retired" disposition), stablecoin-meta-control-schemas.ts (optional
  // retiredReason/retired fields), and safety-score-v9-facts.ts (optional lapsedReview flag).
  // No public card, breakdown, or trace schema changed; substituting origin/main's 3 files
  // restores the prior 21cdf3e2… digest.
  // #1827 moves fact-set validation into reusable header and asset checks. Public schemas are unchanged.
  if (hash.digest("hex") !== "964de1f7c429a8cbc9c128d3ef5e6a7007216a74cff494a851f861e16de8b893") throw new Error("Pre-dust reader source/refinement inputs changed");
}

export async function previousReader() {
  assertPreviousReaderSource();
  vi.resetModules();
  // The pre-dust reader predates post-freeze charged vocabulary: reclassify
  // registry codes the frozen enum cannot parse as diagnostic in the loaded
  // policy. The coverage refine still sees every code, while the bounded
  // attribution set (charged codes only) stays exactly the pre-dust one.
  vi.doMock("../../data/safety-score-v9/methodology-policy-candidate-v1.json", async (original) => {
    const policy = await original<{ default: { reasonRegistry: { code: string; defaultTreatment: string }[] } }>();
    return { default: { ...policy.default,
      reasonRegistry: policy.default.reasonRegistry.map((reason) => PRE_DUST_REASON_CODES.includes(reason.code)
        ? reason
        : { ...reason, defaultFactClass: "optional-unsupported", permittedTreatments: ["diagnostic"], defaultTreatment: "diagnostic" }) } };
  });
  vi.doMock("../safety-score-v9", async (original) => ({
    ...await original<typeof import("../safety-score-v9")>(),
    V9_REASON_CODES: PRE_DUST_REASON_CODES,
    V9ReasonCodeSchema: z.enum(PRE_DUST_REASON_CODES),
  }));
  try {
    const { SafetyScoreV9PreviousCardSchema: current } = await import("../safety-score-v9-public");
    const { ReportCardsV9TableCardSchema: table } = await import("../report-cards-v9-projections");
    const { SafetyScoreV9CurrentResponseSchema } = await import("../safety-score-v9-publication-response");
    // The frozen strict breakdown had no v10.48 admittedScoreCeiling field.
    const card = current.superRefine((value, ctx) => {
      if (value.breakdowns?.backing.components.some((component) => component.admittedScoreCeiling !== undefined)) {
        ctx.addIssue({ code: "custom", message: "Pre-dust breakdown components have no admittedScoreCeiling" });
      }
    });
    const response = SafetyScoreV9CurrentResponseSchema.safeExtend({ cards: z.array(card) });
    return { card, table, response };
  } finally {
    vi.doUnmock("../safety-score-v9");
    vi.resetModules();
  }
}
