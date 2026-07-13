import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import {
  computeModeledExitSizeUsd,
  REDEMPTION_EFFECTIVE_EXIT_MODEL,
  SAME_NOTIONAL_EXIT_OBSERVATION_FRESHNESS_POLICY,
  SAME_NOTIONAL_EXIT_REQUEST_POLICY,
} from "@shared/lib/redemption-backstop-scoring";
import { validateExitRouteCapacityCurve } from "@shared/lib/p4-exit-route-capacity";
import type { ExitRouteObservation } from "@shared/types/market";
import type { ReportCard, ReportCardGrade } from "@shared/types/report-cards";
import {
  assertCliUsage,
  parseCliInteger,
  parseStrictCliArgs,
  runCliEntrypoint,
  writeCliHelpIfRequested,
} from "../../scripts/lib/cli-args.mjs";
import {
  buildReportCardsSnapshotFromFixedInput,
  normalizeFixedInput,
  type ReportCardsFixedInput,
} from "../src/lib/report-cards-fixed-input";

const DEFAULT_MAX_OBSERVATION_AGE_SEC =
  Math.max(CRON_INTERVALS["sync-dex-liquidity"], CRON_INTERVALS["sync-redemption-backstops"]) * 2;

const DEX_SCOREABLE_EVIDENCE = new Set<ExitRouteObservation["evidenceKind"]>([
  "measured-executable-depth",
  "reserve-based-amm-simulation",
  "direct-orderbook-depth",
]);
const REDEMPTION_SCOREABLE_EVIDENCE = new Set<ExitRouteObservation["evidenceKind"]>([
  "documented-terms",
  "live-reserve-state",
  "onchain-contract-state",
]);

const USAGE = `Usage: npx tsx worker/scripts/generate-exit-route-calibration.ts --input <path> --output <path> [options]

Options:
  --input <path>                         Fixed report-card input JSON (required)
  --output <path>                        Deterministic calibration report JSON (required)
  --generation-id <id>                  Complete P4a producer generation identifier (required)
  --producer-generation-status <status> complete or incomplete (required)
  --activation-decision <decision>       activate or hold (required)
  --decision-reason <reason>             Evidence-based general-policy rationale (required)
  --minimum-dex-eligible-assets <n>      General activation floor (default: 1)
  --minimum-redemption-eligible-assets <n> General activation floor (default: 1)
  --max-observation-age-sec <n>          Fixed freshness window (default: producer interval x2)
  --allow-methodology-mismatch           Replay an older capture through current code
  -h, --help                             Show this help`;

type RouteLane = "dex" | "redemption";
type ActivationDecision = "activate" | "hold";
type ProducerGenerationStatus = "complete" | "incomplete";

export interface ExitRouteCalibrationOptions {
  generationId: string;
  producerGenerationStatus: ProducerGenerationStatus;
  activationDecision: ActivationDecision;
  decisionReason: string;
  minimumDexEligibleAssets?: number;
  minimumRedemptionEligibleAssets?: number;
  maxObservationAgeSec?: number;
  allowMethodologyMismatch?: boolean;
}

export interface AuditedRouteCapacity {
  routeId: string;
  executableUsd: number;
  completionRatio: number;
  evidenceKind: ExitRouteObservation["evidenceKind"];
  confidence: ExitRouteObservation["confidence"];
  observedAt: number;
}

interface RouteLaneAudit {
  status: "eligible" | "observed-ineligible" | "absent";
  observationCount: number;
  eligibleObservationCount: number;
  best: AuditedRouteCapacity | null;
}

interface MovementSummary {
  increased: number;
  decreased: number;
  unchanged: number;
  becameRated: number;
  becameNr: number;
  gradeChanged: number;
  maxAbsoluteScoreDelta: number;
}

interface ScoreMovementRow {
  oldScore: number | null;
  newScore: number | null;
  oldGrade?: ReportCardGrade;
  newGrade?: ReportCardGrade;
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(0.01, Math.abs(right) * 1e-9);
}

function isConsistentCapacityPoint(point: {
  requestedNotionalUsd: number;
  executableUsd: number;
  completionRatio: number;
}): boolean {
  return (
    point.executableUsd <= point.requestedNotionalUsd + 0.01 &&
    Math.abs(point.completionRatio - point.executableUsd / point.requestedNotionalUsd) <= 0.00001
  );
}

function resolveCapacityAtRequest(
  observation: ExitRouteObservation,
  modeledExitSizeUsd: number,
): { executableUsd: number; completionRatio: number } | null {
  if (observation.capacityCurve && validateExitRouteCapacityCurve(observation.capacityCurve).length > 0) return null;
  const points = [observation, ...(observation.capacityCurve ?? [])]
    .filter((point) => approximatelyEqual(point.maxCostBps, SAME_NOTIONAL_EXIT_REQUEST_POLICY.maxCostBps))
    .sort((left, right) => left.requestedNotionalUsd - right.requestedNotionalUsd);
  if (points.length === 0 || points.some((point) => !isConsistentCapacityPoint(point))) return null;
  const exact = points.find((point) => approximatelyEqual(point.requestedNotionalUsd, modeledExitSizeUsd));
  if (exact) return { executableUsd: exact.executableUsd, completionRatio: exact.completionRatio };
  const lower = [...points].reverse().find((point) => point.requestedNotionalUsd < modeledExitSizeUsd);
  const executableUsd = Math.min(modeledExitSizeUsd, lower?.executableUsd ?? points[0]!.executableUsd);
  return { executableUsd, completionRatio: executableUsd / modeledExitSizeUsd };
}

function isEligibleObservation(
  observation: ExitRouteObservation,
  lane: RouteLane,
  clockSec: number,
  maxObservationAgeSec: number,
): boolean {
  if (!observation.scoreEligible) return false;
  if (observation.settlementHorizonSec !== SAME_NOTIONAL_EXIT_REQUEST_POLICY.settlementHorizonSec) return false;
  const allowedEvidence = lane === "dex" ? DEX_SCOREABLE_EVIDENCE : REDEMPTION_SCOREABLE_EVIDENCE;
  if (!allowedEvidence.has(observation.evidenceKind)) return false;
  const ageSec = Math.max(0, clockSec - observation.observedAt, observation.freshnessSeconds);
  const evidenceMaxAgeSec =
    observation.evidenceKind === "documented-terms"
      ? SAME_NOTIONAL_EXIT_OBSERVATION_FRESHNESS_POLICY.documentedTermsMaxAgeSec
      : maxObservationAgeSec;
  return ageSec <= evidenceMaxAgeSec;
}

export function selectBestRouteCapacity(args: {
  observations: readonly ExitRouteObservation[] | null | undefined;
  lane: RouteLane;
  modeledExitSizeUsd: number | null;
  clockSec: number;
  maxObservationAgeSec: number;
}): RouteLaneAudit {
  const observations = args.observations ?? [];
  if (observations.length === 0) {
    return { status: "absent", observationCount: 0, eligibleObservationCount: 0, best: null };
  }
  if (args.modeledExitSizeUsd == null) {
    return {
      status: "observed-ineligible",
      observationCount: observations.length,
      eligibleObservationCount: 0,
      best: null,
    };
  }
  const eligible = observations.flatMap((observation) => {
    if (!isEligibleObservation(observation, args.lane, args.clockSec, args.maxObservationAgeSec)) return [];
    const capacity = resolveCapacityAtRequest(observation, args.modeledExitSizeUsd!);
    return capacity ? [{ observation, capacity }] : [];
  });
  const best = eligible.sort(
    (left, right) =>
      right.capacity.executableUsd - left.capacity.executableUsd ||
      left.observation.routeId.localeCompare(right.observation.routeId),
  )[0];
  return {
    status: best ? "eligible" : "observed-ineligible",
    observationCount: observations.length,
    eligibleObservationCount: eligible.length,
    best: best
      ? {
          routeId: best.observation.routeId,
          executableUsd: best.capacity.executableUsd,
          completionRatio: best.capacity.completionRatio,
          evidenceKind: best.observation.evidenceKind,
          confidence: best.observation.confidence,
          observedAt: best.observation.observedAt,
        }
      : null,
  };
}

function scoreDelta(oldScore: number | null, newScore: number | null): number | null {
  return oldScore == null || newScore == null ? null : newScore - oldScore;
}

function summarizeMovements(rows: readonly ScoreMovementRow[]): MovementSummary {
  const summary: MovementSummary = {
    increased: 0,
    decreased: 0,
    unchanged: 0,
    becameRated: 0,
    becameNr: 0,
    gradeChanged: 0,
    maxAbsoluteScoreDelta: 0,
  };
  for (const row of rows) {
    if (row.oldScore == null && row.newScore != null) summary.becameRated += 1;
    else if (row.oldScore != null && row.newScore == null) summary.becameNr += 1;
    else {
      const delta = scoreDelta(row.oldScore, row.newScore) ?? 0;
      if (delta > 0) summary.increased += 1;
      else if (delta < 0) summary.decreased += 1;
      else summary.unchanged += 1;
      summary.maxAbsoluteScoreDelta = Math.max(summary.maxAbsoluteScoreDelta, Math.abs(delta));
    }
    if (row.oldGrade != null && row.newGrade != null && row.oldGrade !== row.newGrade) summary.gradeChanged += 1;
  }
  return summary;
}

function cardsById(cards: readonly ReportCard[]): Map<string, ReportCard> {
  return new Map(cards.map((card) => [card.id, card]));
}

export function buildExitRouteCalibrationReport(fixedInputValue: unknown, options: ExitRouteCalibrationOptions) {
  const fixedInput: ReportCardsFixedInput = normalizeFixedInput(fixedInputValue);
  const minimumDexEligibleAssets = options.minimumDexEligibleAssets ?? 1;
  const minimumRedemptionEligibleAssets = options.minimumRedemptionEligibleAssets ?? 1;
  const maxObservationAgeSec = options.maxObservationAgeSec ?? DEFAULT_MAX_OBSERVATION_AGE_SEC;
  if (!options.generationId.trim()) throw new Error("generationId must be non-empty");
  if (!options.decisionReason.trim()) throw new Error("decisionReason must be non-empty");
  if (!Number.isInteger(minimumDexEligibleAssets) || minimumDexEligibleAssets < 0) {
    throw new Error("minimumDexEligibleAssets must be a non-negative integer");
  }
  if (!Number.isInteger(minimumRedemptionEligibleAssets) || minimumRedemptionEligibleAssets < 0) {
    throw new Error("minimumRedemptionEligibleAssets must be a non-negative integer");
  }
  if (!Number.isInteger(maxObservationAgeSec) || maxObservationAgeSec < 0) {
    throw new Error("maxObservationAgeSec must be a non-negative integer");
  }

  const replayOptions = {
    allowMethodologyMismatch: options.allowMethodologyMismatch,
    maxExitObservationAgeSec: maxObservationAgeSec,
  };
  const legacy = buildReportCardsSnapshotFromFixedInput(fixedInput, {
    ...replayOptions,
    sameNotionalScoringMode: "legacy",
  });
  const active = buildReportCardsSnapshotFromFixedInput(fixedInput, {
    ...replayOptions,
    sameNotionalScoringMode: "active",
  });
  const legacyById = cardsById(legacy.cards);

  const rows = active.cards
    .filter((card) => !card.isDefunct)
    .map((newCard) => {
      const oldCard = legacyById.get(newCard.id);
      if (!oldCard || oldCard.isDefunct) throw new Error(`Legacy replay is missing active card ${newCard.id}`);
      const supplyUsd = Object.values(fixedInput.chainCirculatingById[newCard.id] ?? {}).reduce(
        (sum, point) => sum + point.current,
        0,
      );
      const redemptionProfile = fixedInput.redemptionBackstopMap[newCard.id]?.capacityProfile;
      const modeledExitSizeUsd = redemptionProfile?.modeledExitSizeUsd ?? computeModeledExitSizeUsd(supplyUsd);
      const dex = selectBestRouteCapacity({
        observations: fixedInput.dexLiqMap[newCard.id]?.exitRouteObservations,
        lane: "dex",
        modeledExitSizeUsd,
        clockSec: fixedInput.clockSec,
        maxObservationAgeSec,
      });
      const dexProducerCoverage = fixedInput.dexLiqMap[newCard.id]?.exitRouteObservationCoverage;
      const redemption = selectBestRouteCapacity({
        observations: redemptionProfile?.exitRouteObservations,
        lane: "redemption",
        modeledExitSizeUsd,
        clockSec: fixedInput.clockSec,
        maxObservationAgeSec,
      });
      return {
        id: newCard.id,
        name: newCard.name,
        symbol: newCard.symbol,
        circulatingSupplyUsd: supplyUsd > 0 ? supplyUsd : null,
        modeledRequest: {
          requestedNotionalUsd: modeledExitSizeUsd,
          maxCostBps: SAME_NOTIONAL_EXIT_REQUEST_POLICY.maxCostBps,
          settlementHorizonSec: SAME_NOTIONAL_EXIT_REQUEST_POLICY.settlementHorizonSec,
        },
        dex,
        dexProducerCoverage: dexProducerCoverage
          ? {
              status: dexProducerCoverage.status,
              retainedPoolCount: dexProducerCoverage.retainedPoolCount,
              unsupportedPoolCount: dexProducerCoverage.unsupportedPoolCount,
            }
          : { status: "unknown" as const, retainedPoolCount: 0, unsupportedPoolCount: 0 },
        redemption,
        oldExitScore: oldCard.rawInputs.effectiveExitScore,
        newExitScore: newCard.rawInputs.effectiveExitScore,
        exitScoreDelta: scoreDelta(oldCard.rawInputs.effectiveExitScore, newCard.rawInputs.effectiveExitScore),
        oldLiquidityScore: oldCard.dimensions.liquidity.score,
        newLiquidityScore: newCard.dimensions.liquidity.score,
        oldLiquidityGrade: oldCard.dimensions.liquidity.grade,
        newLiquidityGrade: newCard.dimensions.liquidity.grade,
        oldOverallScore: oldCard.overallScore,
        newOverallScore: newCard.overallScore,
        overallScoreDelta: scoreDelta(oldCard.overallScore, newCard.overallScore),
        oldOverallGrade: oldCard.overallGrade,
        newOverallGrade: newCard.overallGrade,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  const dexEligibleAssets = rows.filter((row) => row.dex.status === "eligible").length;
  const redemptionEligibleAssets = rows.filter((row) => row.redemption.status === "eligible").length;
  const blockers = [
    ...(options.producerGenerationStatus === "complete" ? [] : ["producer-generation-incomplete"]),
    ...(dexEligibleAssets >= minimumDexEligibleAssets ? [] : ["dex-eligible-asset-floor-not-met"]),
    ...(redemptionEligibleAssets >= minimumRedemptionEligibleAssets ? [] : ["redemption-eligible-asset-floor-not-met"]),
  ];
  const activationReady = blockers.length === 0;

  return {
    schemaVersion: 1,
    generationId: options.generationId,
    source: {
      sourceGeneration: fixedInput.sourceGeneration,
      registryRevision: fixedInput.registryRevision,
      capturedAt: fixedInput.capturedAt,
      clockSec: fixedInput.clockSec,
      inputMethodologyVersion: fixedInput.methodologyVersion,
      replayMethodologyVersion: active.methodology.version,
    },
    generalPolicy: {
      modeledExitSize: REDEMPTION_EFFECTIVE_EXIT_MODEL.modeledExitSize,
      modeledExitSizeFormulaChanged: false,
      comparisonRequest: SAME_NOTIONAL_EXIT_REQUEST_POLICY,
      maxObservationAgeSec,
      documentedTermsMaxAgeSec: SAME_NOTIONAL_EXIT_OBSERVATION_FRESHNESS_POLICY.documentedTermsMaxAgeSec,
      selection: "greatest absolute executable capacity among policy-eligible observations",
      capacityInterpolation: "exact point or conservative lower bound from the retained monotonic curve",
      namedAssetTuning: false,
    },
    activationDecision: {
      decision: options.activationDecision,
      reason: options.decisionReason,
      producerGenerationStatus: options.producerGenerationStatus,
      activationReady,
      decisionConsistentWithGate: options.activationDecision === "hold" || activationReady,
      blockers,
      minimumCoveragePolicy: {
        dexEligibleAssets: minimumDexEligibleAssets,
        redemptionEligibleAssets: minimumRedemptionEligibleAssets,
      },
      rollingDeploymentPolicy:
        "Activate only from a fixed input containing the audited producer generation; do not defer score activation to a later cron republish.",
    },
    coverage: {
      activeAssets: rows.length,
      assetsWithModeledRequest: rows.filter((row) => row.modeledRequest.requestedNotionalUsd != null).length,
      dex: {
        eligibleAssets: dexEligibleAssets,
        observedIneligibleAssets: rows.filter((row) => row.dex.status === "observed-ineligible").length,
        absentAssets: rows.filter((row) => row.dex.status === "absent").length,
        observations: rows.reduce((sum, row) => sum + row.dex.observationCount, 0),
        eligibleObservations: rows.reduce((sum, row) => sum + row.dex.eligibleObservationCount, 0),
        producerCoverageStatuses: {
          populated: rows.filter((row) => row.dexProducerCoverage.status === "populated").length,
          unsupported: rows.filter((row) => row.dexProducerCoverage.status === "unsupported").length,
          unknown: rows.filter((row) => row.dexProducerCoverage.status === "unknown").length,
        },
        retainedPools: rows.reduce((sum, row) => sum + row.dexProducerCoverage.retainedPoolCount, 0),
        unsupportedPools: rows.reduce((sum, row) => sum + row.dexProducerCoverage.unsupportedPoolCount, 0),
      },
      redemption: {
        eligibleAssets: redemptionEligibleAssets,
        observedIneligibleAssets: rows.filter((row) => row.redemption.status === "observed-ineligible").length,
        absentAssets: rows.filter((row) => row.redemption.status === "absent").length,
        observations: rows.reduce((sum, row) => sum + row.redemption.observationCount, 0),
        eligibleObservations: rows.reduce((sum, row) => sum + row.redemption.eligibleObservationCount, 0),
      },
    },
    movements: {
      exit: summarizeMovements(rows.map((row) => ({ oldScore: row.oldExitScore, newScore: row.newExitScore }))),
      liquidity: summarizeMovements(
        rows.map((row) => ({
          oldScore: row.oldLiquidityScore,
          newScore: row.newLiquidityScore,
          oldGrade: row.oldLiquidityGrade,
          newGrade: row.newLiquidityGrade,
        })),
      ),
      overall: summarizeMovements(
        rows.map((row) => ({
          oldScore: row.oldOverallScore,
          newScore: row.newOverallScore,
          oldGrade: row.oldOverallGrade,
          newGrade: row.newOverallGrade,
        })),
      ),
    },
    rows,
  };
}

export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const { values } = parseStrictCliArgs([...argv], {
    options: {
      input: { type: "string" },
      output: { type: "string" },
      "generation-id": { type: "string" },
      "producer-generation-status": { type: "string" },
      "activation-decision": { type: "string" },
      "decision-reason": { type: "string" },
      "minimum-dex-eligible-assets": { type: "string", default: "1" },
      "minimum-redemption-eligible-assets": { type: "string", default: "1" },
      "max-observation-age-sec": { type: "string", default: String(DEFAULT_MAX_OBSERVATION_AGE_SEC) },
      "allow-methodology-mismatch": { type: "boolean" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  assertCliUsage(typeof values.input === "string", "--input is required");
  assertCliUsage(typeof values.output === "string", "--output is required");
  assertCliUsage(typeof values["generation-id"] === "string", "--generation-id is required");
  assertCliUsage(typeof values["decision-reason"] === "string", "--decision-reason is required");
  assertCliUsage(
    values["producer-generation-status"] === "complete" || values["producer-generation-status"] === "incomplete",
    "--producer-generation-status must be complete or incomplete",
  );
  assertCliUsage(
    values["activation-decision"] === "activate" || values["activation-decision"] === "hold",
    "--activation-decision must be activate or hold",
  );
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- explicit local operator input path.
  const fixedInput = JSON.parse(readFileSync(values.input, "utf8")) as unknown;
  const report = buildExitRouteCalibrationReport(fixedInput, {
    generationId: values["generation-id"],
    producerGenerationStatus: values["producer-generation-status"],
    activationDecision: values["activation-decision"],
    decisionReason: values["decision-reason"],
    minimumDexEligibleAssets: parseCliInteger(values["minimum-dex-eligible-assets"], {
      name: "--minimum-dex-eligible-assets",
      min: 0,
    }),
    minimumRedemptionEligibleAssets: parseCliInteger(values["minimum-redemption-eligible-assets"], {
      name: "--minimum-redemption-eligible-assets",
      min: 0,
    }),
    maxObservationAgeSec: parseCliInteger(values["max-observation-age-sec"], {
      name: "--max-observation-age-sec",
      min: 0,
    }),
    allowMethodologyMismatch: values["allow-methodology-mismatch"] === true,
  });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- explicit local operator output path.
  writeFileSync(values.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runCliEntrypoint(runCli, { label: "report-cards:calibrate-exit-routes", usage: USAGE });
}
