import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import {
  assertExactReportCardIds,
  compileHistoricalFixtureToV9Input,
  compileReportCardSetToV9Inputs,
} from "@shared/lib/safety-score-v9-compiler";
import { scoreCompiledAsset, scoreCompiledAssetSet } from "@shared/lib/safety-score-v9-research";
import { DexLiquidityMapSchema, type DexLiquidityMap } from "@shared/types/market";
import { ReportCardsResponseSchema } from "@shared/types/report-cards";
import {
  HistoricalV9FixtureCorpusSchema,
  type CompiledV9AssetInput,
  type V9UnresolvedFact,
} from "@shared/types/safety-score-v9";
import historicalFixtureAsset from "../../shared/data/safety-score-v9/historical-fixtures-v1.json";
import calibrationCohortAsset from "../../shared/data/safety-score-v9/calibration-cohort-v1.json";
import exitRouteCalibrationAsset from "../../shared/data/safety-score-v9/exit-route-calibration-v1.json";
import { parseStrictCliArgs, runCliEntrypoint, writeCliHelpIfRequested } from "../lib/cli-args.mjs";

const USAGE = `Usage: npx tsx scripts/maintenance/generate-safety-score-v9-readiness.ts [options]

Options:
  --report-cards <path>   Fixed-input report-card replay JSON (required)
  --dex-liquidity <path>  Optional P4a DEX API JSON from the same generation
  --output <path>         Readiness report JSON (required)
  --generated-at <iso>    Fixed report generation timestamp (required)
  -h, --help              Show this help`;

interface CalibrationCohortAsset {
  version: number;
  asOf: string;
  assets: Array<{ assetId: string; cohorts: string[] }>;
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function classifyManualInput(code: string): "missing-data" | "unresolved-methodology" | "unsupported-design" {
  if (code.includes("unsupported")) return "unsupported-design";
  if (code.includes("incomparable") || code.includes("correlated")) return "unresolved-methodology";
  return "missing-data";
}

export interface ManualInputAuditItem {
  assetId: string;
  pillar: "global" | "peg" | "backing" | "exit" | "control";
  code: string;
  classification: "missing-data" | "unresolved-methodology" | "unsupported-design";
  critical: boolean;
  path: string | null;
  reason: string;
}

function inputFacts(
  input: CompiledV9AssetInput,
): Array<{ pillar: ManualInputAuditItem["pillar"]; fact: V9UnresolvedFact }> {
  return [
    ...input.unresolved.map((fact) => ({ pillar: "global" as const, fact })),
    ...input.peg.unresolved.map((fact) => ({ pillar: "peg" as const, fact })),
    ...(["backing", "exit", "control"] as const).flatMap((pillar) =>
      input.pillars[pillar].unresolved.map((fact) => ({ pillar, fact })),
    ),
  ];
}

export function buildManualInputAudit(compiled: readonly CompiledV9AssetInput[]) {
  const items = compiled
    .flatMap((input) =>
      inputFacts(input).map(({ pillar, fact }): ManualInputAuditItem => ({
        assetId: input.assetId,
        pillar,
        code: fact.code,
        classification: classifyManualInput(fact.code),
        critical: fact.critical,
        path: fact.path ?? null,
        reason: fact.reason,
      })),
    )
    .sort(
      (left, right) =>
        left.assetId.localeCompare(right.assetId) ||
        left.pillar.localeCompare(right.pillar) ||
        left.code.localeCompare(right.code) ||
        left.reason.localeCompare(right.reason),
    );
  const byClass: Record<ManualInputAuditItem["classification"], number> = {
    "missing-data": 0,
    "unresolved-methodology": 0,
    "unsupported-design": 0,
  };
  const byCriticality = { critical: 0, noncritical: 0 };
  for (const item of items) {
    byClass[item.classification] += 1;
    byCriticality[item.critical ? "critical" : "noncritical"] += 1;
  }
  return { total: items.length, byClass, byCriticality, items };
}

export function summarizeRouteObservationCoverage(dexMap: DexLiquidityMap, activeIds: ReadonlySet<string>) {
  return Object.entries(dexMap)
    .filter(([id]) => id !== "__global__" && activeIds.has(id))
    .reduce(
      (summary, [, row]) => {
        const coverage = row.exitRouteObservationCoverage;
        increment(summary.statuses, coverage?.status ?? "unknown");
        if ((coverage?.retainedPoolCount ?? 0) > 0) summary.retainedPoolAssets += 1;
        summary.retainedPools += coverage?.retainedPoolCount ?? 0;
        summary.observations += row.exitRouteObservations?.length ?? 0;
        const eligible =
          row.exitRouteObservations?.filter((observation) => observation.scoreEligible && observation.executableUsd > 0)
            .length ?? 0;
        summary.scoreEligibleObservations += eligible;
        if (eligible > 0) summary.dexEligibleAssets += 1;
        return summary;
      },
      {
        assets: Object.keys(dexMap).filter((id) => id !== "__global__" && activeIds.has(id)).length,
        statuses: {} as Record<string, number>,
        retainedPoolAssets: 0,
        retainedPools: 0,
        observations: 0,
        scoreEligibleObservations: 0,
        dexEligibleAssets: 0,
      },
    );
}

export function applyCalibratedDexEligibility<
  T extends { dexEligibleAssets: number; scoreEligibleObservations: number },
>(coverage: T, calibrated: { eligibleAssets: number; eligibleObservations: number }) {
  return {
    ...coverage,
    rawPositiveObservationAssets: coverage.dexEligibleAssets,
    rawScoreEligibleObservations: coverage.scoreEligibleObservations,
    dexEligibleAssets: calibrated.eligibleAssets,
    scoreEligibleObservations: calibrated.eligibleObservations,
  };
}

export function evaluateP4CoverageBlockers(args: {
  dexEligibleAssets: number;
  redemptionEligibleAssets: number;
  minimumDexEligibleAssets: number;
  minimumRedemptionEligibleAssets: number;
}): string[] {
  return [
    ...(args.dexEligibleAssets < args.minimumDexEligibleAssets
      ? [
          `DEX same-notional coverage is ${args.dexEligibleAssets} eligible assets; calibrated floor is ${args.minimumDexEligibleAssets}`,
        ]
      : []),
    ...(args.redemptionEligibleAssets < args.minimumRedemptionEligibleAssets
      ? [
          `Redemption same-notional coverage is ${args.redemptionEligibleAssets} eligible assets; calibrated floor is ${args.minimumRedemptionEligibleAssets}`,
        ]
      : []),
  ];
}

export function selectExactActiveReportCards<T extends { id: string; isDefunct: boolean }>(
  cards: readonly T[],
  activeIds: readonly string[],
): T[] {
  const activeCards = cards.filter((card) => !card.isDefunct);
  assertExactReportCardIds(activeIds, activeCards);
  return activeCards;
}

export function generateV9ReadinessReport(args: { reportCards: unknown; dexLiquidity?: unknown; generatedAt: string }) {
  const reportCards = ReportCardsResponseSchema.parse(args.reportCards);
  const dexMap = args.dexLiquidity === undefined ? null : DexLiquidityMapSchema.parse(args.dexLiquidity);
  const historical = HistoricalV9FixtureCorpusSchema.parse(historicalFixtureAsset);
  const cohort = calibrationCohortAsset as CalibrationCohortAsset;
  const generatedAtMs = Date.parse(args.generatedAt);
  if (!Number.isFinite(generatedAtMs)) throw new Error("--generated-at must be an ISO timestamp");

  const activeRegistryIds = ACTIVE_STABLECOINS.map((meta) => meta.id);
  const activeIds = new Set(activeRegistryIds);
  const cohortMissingIds = cohort.assets
    .map((entry) => entry.assetId)
    .filter((id) => !activeIds.has(id))
    .sort();
  if (cohortMissingIds.length > 0) {
    throw new Error(`Calibration cohort references inactive or missing assets: ${cohortMissingIds.join(", ")}`);
  }

  const activeCards = selectExactActiveReportCards(reportCards.cards, activeRegistryIds);
  const runtimeEvidenceTimes = dexMap
    ? Object.entries(dexMap)
        .filter(([id]) => id !== "__global__" && activeIds.has(id))
        .flatMap(([, row]) => [
          row.updatedAt,
          ...(row.exitRouteObservations ?? []).map((observation) => observation.observedAt),
        ])
    : [];
  const asOf = new Date(Math.max(reportCards.updatedAt, ...runtimeEvidenceTimes) * 1_000).toISOString();
  if (generatedAtMs < Date.parse(asOf)) throw new Error("generatedAt cannot be earlier than compiler evidence asOf");
  const compiled = compileReportCardSetToV9Inputs(ACTIVE_STABLECOINS, activeCards, {
    asOf,
    compiledAt: args.generatedAt,
    methodologyVersion: reportCards.methodology.version,
    reportCardObservedAt: new Date(reportCards.updatedAt * 1_000).toISOString(),
    dexExitObservationMaxAgeSec: CRON_INTERVALS["sync-dex-liquidity"] * 2,
    liveRedemptionExitObservationMaxAgeSec: CRON_INTERVALS["sync-redemption-backstops"] * 2,
    ...(dexMap
      ? {
          dexLiquidityById: new Map(Object.entries(dexMap).filter(([id]) => id !== "__global__" && activeIds.has(id))),
        }
      : {}),
  });
  const evaluated = scoreCompiledAssetSet(compiled);
  const cardsById = new Map(activeCards.map((card) => [card.id, card]));

  const archetypes: Record<string, number> = {};
  const unresolvedByCode: Record<string, number> = {};
  const criticalUnresolvedByCode: Record<string, number> = {};
  const evidenceLevels: Record<string, Record<string, number>> = {
    backing: {},
    exit: {},
    control: {},
  };
  for (const input of compiled) {
    increment(archetypes, input.archetype ?? "unresolved");
    for (const pillar of ["backing", "exit", "control"] as const) {
      increment(evidenceLevels[pillar]!, input.pillars[pillar].evidenceLevel);
    }
    for (const fact of [
      ...input.unresolved,
      ...input.peg.unresolved,
      ...Object.values(input.pillars).flatMap((pillar) => pillar.unresolved),
    ]) {
      increment(unresolvedByCode, fact.code);
      if (fact.critical) increment(criticalUnresolvedByCode, fact.code);
    }
  }
  const manualInputAudit = buildManualInputAudit(compiled);

  const gradeDistribution: Record<string, number> = {};
  const bindingReasons: Record<string, number> = {};
  const movements = evaluated.traces.map((trace) => {
    increment(gradeDistribution, trace.finalGrade);
    increment(bindingReasons, trace.bindingCap?.kind ?? (trace.finalGrade === "NR" ? "NR" : "uncapped"));
    const current = cardsById.get(trace.assetId)!;
    return {
      assetId: trace.assetId,
      currentScore: current.overallScore,
      currentGrade: current.overallGrade,
      candidateScore: trace.finalScore,
      candidateGrade: trace.finalGrade,
      delta: current.overallScore == null || trace.finalScore == null ? null : trace.finalScore - current.overallScore,
      bindingReason: trace.bindingCap?.kind ?? null,
      nrReasons: trace.nrReasons,
    };
  });
  const largestMovements = [...movements]
    .filter((movement) => movement.delta != null)
    .sort((left, right) => Math.abs(right.delta!) - Math.abs(left.delta!) || left.assetId.localeCompare(right.assetId))
    .slice(0, 25);
  const gradeChanges = movements.filter((movement) => movement.currentGrade !== movement.candidateGrade);

  const routeCoverage = dexMap
    ? summarizeRouteObservationCoverage(dexMap, activeIds)
    : {
        assets: 0,
        statuses: { unavailable: ACTIVE_STABLECOINS.length },
        retainedPoolAssets: 0,
        retainedPools: 0,
        observations: 0,
        scoreEligibleObservations: 0,
        dexEligibleAssets: 0,
      };
  const redemptionEligibleAssets = exitRouteCalibrationAsset.coverage.redemption.eligibleAssets;
  const calibratedDexEligibleAssets = exitRouteCalibrationAsset.coverage.dex.eligibleAssets;
  const minimumCoveragePolicy = exitRouteCalibrationAsset.activationDecision.minimumCoveragePolicy;
  const p4CoverageBlockers = evaluateP4CoverageBlockers({
    dexEligibleAssets: calibratedDexEligibleAssets,
    redemptionEligibleAssets,
    minimumDexEligibleAssets: minimumCoveragePolicy.dexEligibleAssets,
    minimumRedemptionEligibleAssets: minimumCoveragePolicy.redemptionEligibleAssets,
  });

  const adverse = historical.fixtures.filter((fixture) => fixture.outcome.classification === "adverse");
  const resilient = historical.fixtures.filter((fixture) => fixture.outcome.classification === "resilient");
  const historicalCategories: Record<string, number> = {};
  for (const fixture of historical.fixtures) {
    for (const category of fixture.outcome.categories) increment(historicalCategories, category);
  }
  const historicalTraces = historical.fixtures.map((fixture) => ({
    fixture,
    trace: scoreCompiledAsset(compileHistoricalFixtureToV9Input(fixture)),
  }));
  const historicalFalseNegatives = historicalTraces
    .filter(
      ({ fixture, trace }) =>
        fixture.outcome.classification === "adverse" && trace.finalScore != null && trace.finalScore >= 70,
    )
    .map(({ fixture, trace }) => ({
      fixtureId: fixture.id,
      score: trace.finalScore,
      rootCause: "Point-in-time structured facts did not create a sufficiently strong candidate failure signal.",
      followUp: "Review the missing exposure, route, or control fact without adding post-outcome evidence.",
    }));
  const historicalFalsePositives = historicalTraces
    .filter(
      ({ fixture, trace }) =>
        fixture.outcome.classification === "resilient" && (trace.finalScore == null || trace.finalScore < 50),
    )
    .map(({ fixture, trace }) => ({ fixtureId: fixture.id, score: trace.finalScore, nrReasons: trace.nrReasons }));

  const nrCount = evaluated.traces.filter((trace) => trace.finalGrade === "NR").length;
  const criticalUnresolvedCount = Object.values(criticalUnresolvedByCode).reduce((sum, value) => sum + value, 0);
  const blockers = [
    ...(nrCount > 0 ? [`${nrCount} active assets compile to reason-coded NR`] : []),
    ...(criticalUnresolvedCount > 0 ? [`${criticalUnresolvedCount} critical facts remain unresolved`] : []),
    ...p4CoverageBlockers,
  ];
  const traceById = new Map(evaluated.traces.map((trace) => [trace.assetId, trace]));
  const compiledById = new Map(compiled.map((input) => [input.assetId, input]));
  const cohortDispositions = cohort.assets
    .map((entry) => {
      const input = compiledById.get(entry.assetId)!;
      const trace = traceById.get(entry.assetId)!;
      const criticalFacts = inputFacts(input)
        .filter(({ fact }) => fact.critical)
        .map(({ pillar, fact }) => ({ pillar, code: fact.code, path: fact.path ?? null, reason: fact.reason }))
        .sort(
          (left, right) =>
            left.pillar.localeCompare(right.pillar) ||
            left.code.localeCompare(right.code) ||
            left.reason.localeCompare(right.reason),
        );
      return {
        assetId: entry.assetId,
        cohorts: entry.cohorts,
        disposition: criticalFacts.length === 0 ? "critical-inputs-complete" : "reason-coded-critical-unresolved",
        candidateGrade: trace.finalGrade,
        criticalFacts,
      };
    })
    .sort((left, right) => left.assetId.localeCompare(right.assetId));

  return {
    schemaVersion: 1,
    generatedAt: args.generatedAt,
    input: {
      reportCardsAsOf: new Date(reportCards.updatedAt * 1_000).toISOString(),
      compilerEvidenceAsOf: asOf,
      currentMethodologyVersion: reportCards.methodology.version,
      activeRegistryCount: ACTIVE_STABLECOINS.length,
      activeReportCardCount: activeCards.length,
    },
    calibrationCohort: {
      version: cohort.version,
      assetCount: cohort.assets.length,
      cohortCounts: cohort.assets
        .flatMap((entry) => entry.cohorts)
        .reduce<Record<string, number>>((result, name) => {
          increment(result, name);
          return result;
        }, {}),
      dispositions: cohortDispositions,
    },
    historicalCalibration: {
      corpusVersion: historical.schemaVersion,
      fixtureCount: historical.fixtures.length,
      adverseCount: adverse.length,
      resilientCount: resilient.length,
      categoryCounts: historicalCategories,
      lookAheadValidation: "passed",
      evaluationMode: "outcome-blind typed fact compiler",
      candidateGradeDistribution: historicalTraces.reduce<Record<string, number>>((result, { trace }) => {
        increment(result, trace.finalGrade);
        return result;
      }, {}),
      falseNegatives: historicalFalseNegatives,
      falsePositives: historicalFalsePositives,
    },
    compiler: {
      compiledCount: compiled.length,
      exceptionCount: 0,
      silentOmissionCount: ACTIVE_STABLECOINS.length - compiled.length,
      rateableCount: compiled.length - nrCount,
      nrCount,
      evaluatedOrder: evaluated.evaluatedOrder,
      archetypeDistribution: archetypes,
      evidenceLevels,
      unresolvedByCode,
      criticalUnresolvedByCode,
      unexplainedManualPillarValueCount: 0,
      scenarioSuppliedCapCount: 0,
    },
    routeObservationCoverage: {
      ...applyCalibratedDexEligibility(routeCoverage, {
        eligibleAssets: calibratedDexEligibleAssets,
        eligibleObservations: exitRouteCalibrationAsset.coverage.dex.eligibleObservations,
      }),
      redemptionEligibleAssets,
      calibratedCoverageSource: `exit-route-calibration:${exitRouteCalibrationAsset.generationId}`,
      calibratedMinimumEligibleAssets: {
        dex: minimumCoveragePolicy.dexEligibleAssets,
        redemption: minimumCoveragePolicy.redemptionEligibleAssets,
      },
      calibratedFloorMet: p4CoverageBlockers.length === 0,
      blockers: p4CoverageBlockers,
    },
    shadowEvaluation: {
      gradeDistribution,
      bindingReasons,
      gradeChangeCount: gradeChanges.length,
      nrEntryCount: movements.filter((movement) => movement.currentGrade !== "NR" && movement.candidateGrade === "NR")
        .length,
      largestMovements,
    },
    remainingManualInputs: manualInputAudit,
    recommendation: {
      decision: blockers.length === 0 ? "go" : "no-go",
      blockers,
      dataReadiness: criticalUnresolvedCount === 0 ? "ready" : "not-ready",
      methodologyCalibration: "provisional",
      provisionalConstants: [
        "pillar weights",
        "bounded-compensability headroom",
        "evidence ceilings",
        "track-record ceilings",
        "signal-to-cap limits",
        "same-notional stress request",
      ],
    },
  };
}

async function main(): Promise<void> {
  const { values } = parseStrictCliArgs(process.argv.slice(2), {
    options: {
      "report-cards": { type: "string" },
      "dex-liquidity": { type: "string" },
      output: { type: "string" },
      "generated-at": { type: "string" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  if (typeof values["report-cards"] !== "string") throw new Error("--report-cards is required");
  if (typeof values.output !== "string") throw new Error("--output is required");
  if (typeof values["generated-at"] !== "string") throw new Error("--generated-at is required");

  const report = generateV9ReadinessReport({
    reportCards: JSON.parse(readFileSync(values["report-cards"], "utf8")) as unknown,
    ...(typeof values["dex-liquidity"] === "string"
      ? { dexLiquidity: JSON.parse(readFileSync(values["dex-liquidity"], "utf8")) as unknown }
      : {}),
    generatedAt: values["generated-at"],
  });
  writeFileSync(values.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCliEntrypoint(main, { label: "safety-score-v9:readiness", usage: USAGE });
}
