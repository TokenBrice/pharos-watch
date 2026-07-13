import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import {
  computeModeledExitSizeUsd,
  isExitRouteObservationScoreEligible,
  REDEMPTION_EFFECTIVE_EXIT_MODEL,
  SAME_NOTIONAL_EXIT_OBSERVATION_FRESHNESS_POLICY,
  SAME_NOTIONAL_EXIT_REQUEST_POLICY,
} from "@shared/lib/redemption-backstop-scoring";
import {
  isDexExitRouteCoverageComplete,
  P4_GENERAL_ACTIVATION_POLICY_V1,
  validateExitRouteCapacityCurve,
} from "@shared/lib/p4-exit-route-capacity";
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
  computeReportCardsReplayPayloadFingerprint,
  normalizeFixedInput,
  type ReportCardsFixedInput,
} from "../src/lib/report-cards-fixed-input";
import { projectReportCardsFixedInputMethodologyVersions } from "@shared/lib/report-cards-fixed-input-identity";

const DEFAULT_DEX_MAX_OBSERVATION_AGE_SEC = CRON_INTERVALS["sync-dex-liquidity"] * 2;
const DEFAULT_LIVE_REDEMPTION_MAX_OBSERVATION_AGE_SEC = CRON_INTERVALS["sync-redemption-backstops"] * 2;

const USAGE = `Usage: npx tsx worker/scripts/generate-exit-route-calibration.ts --input <path> --output <path> [options]

Options:
  --input <path>                         Fixed report-card input JSON (required)
  --output <path>                        Deterministic calibration report JSON (required)
  --generation-id <id>                  Complete P4a producer generation identifier (required)
  --producer-generation-status <status> complete or incomplete (required)
  --activation-decision <decision>       activate or hold (required)
  --decision-reason <reason>             Evidence-based general-policy rationale (required)
  --minimum-dex-eligible-assets <n>      General activation floor (minimum/default: 45)
  --minimum-redemption-eligible-assets <n> General activation floor (minimum/default: 27)
  --dex-max-observation-age-sec <n>      DEX freshness window (default: DEX interval x2)
  --live-redemption-max-observation-age-sec <n> Live redemption freshness window (default: redemption interval x2)
  --allow-methodology-mismatch           Replay an older capture through current code
  --allow-registry-mismatch              Replay against a changed stablecoin registry
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
  dexMaxObservationAgeSec?: number;
  liveRedemptionMaxObservationAgeSec?: number;
  allowMethodologyMismatch?: boolean;
  allowRegistryMismatch?: boolean;
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
    if (
      !isExitRouteObservationScoreEligible(observation, args.lane, {
        exitObservationAsOfSec: args.clockSec,
        ...(args.lane === "dex"
          ? { dexExitObservationMaxAgeSec: args.maxObservationAgeSec }
          : { liveRedemptionExitObservationMaxAgeSec: args.maxObservationAgeSec }),
      })
    ) {
      return [];
    }
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
  const inputMethodologyVersions = projectReportCardsFixedInputMethodologyVersions({
    methodologyVersion: fixedInput.methodologyVersion,
    dexLiqMap: fixedInput.dexLiqMap,
    pegDataById: fixedInput.pegDataById,
    redemptionBackstopMap: fixedInput.redemptionBackstopMap,
  });
  const minimumDexEligibleAssets =
    options.minimumDexEligibleAssets ?? P4_GENERAL_ACTIVATION_POLICY_V1.minimumDexEligibleAssets;
  const minimumRedemptionEligibleAssets =
    options.minimumRedemptionEligibleAssets ?? P4_GENERAL_ACTIVATION_POLICY_V1.minimumRedemptionEligibleAssets;
  const dexMaxObservationAgeSec = options.dexMaxObservationAgeSec ?? DEFAULT_DEX_MAX_OBSERVATION_AGE_SEC;
  const liveRedemptionMaxObservationAgeSec =
    options.liveRedemptionMaxObservationAgeSec ?? DEFAULT_LIVE_REDEMPTION_MAX_OBSERVATION_AGE_SEC;
  const methodologyMismatchBypassUsed = options.allowMethodologyMismatch === true;
  const registryMismatchBypassUsed = options.allowRegistryMismatch === true;
  if (!options.generationId.trim()) throw new Error("generationId must be non-empty");
  if (options.generationId !== fixedInput.dexGenerationId) {
    throw new Error(
      `Calibration generation ${options.generationId} does not match fixed input DEX generation ${fixedInput.dexGenerationId}`,
    );
  }
  if (!options.decisionReason.trim()) throw new Error("decisionReason must be non-empty");
  if (
    !Number.isInteger(minimumDexEligibleAssets) ||
    minimumDexEligibleAssets < P4_GENERAL_ACTIVATION_POLICY_V1.minimumDexEligibleAssets
  ) {
    throw new Error(
      `minimumDexEligibleAssets must be an integer at least ${P4_GENERAL_ACTIVATION_POLICY_V1.minimumDexEligibleAssets}`,
    );
  }
  if (
    !Number.isInteger(minimumRedemptionEligibleAssets) ||
    minimumRedemptionEligibleAssets < P4_GENERAL_ACTIVATION_POLICY_V1.minimumRedemptionEligibleAssets
  ) {
    throw new Error(
      `minimumRedemptionEligibleAssets must be an integer at least ${P4_GENERAL_ACTIVATION_POLICY_V1.minimumRedemptionEligibleAssets}`,
    );
  }
  if (!Number.isInteger(dexMaxObservationAgeSec) || dexMaxObservationAgeSec < 0) {
    throw new Error("dexMaxObservationAgeSec must be a non-negative integer");
  }
  if (!Number.isInteger(liveRedemptionMaxObservationAgeSec) || liveRedemptionMaxObservationAgeSec < 0) {
    throw new Error("liveRedemptionMaxObservationAgeSec must be a non-negative integer");
  }

  const replayOptions = {
    allowMethodologyMismatch: methodologyMismatchBypassUsed,
    allowRegistryMismatch: registryMismatchBypassUsed,
    dexExitObservationMaxAgeSec: dexMaxObservationAgeSec,
    liveRedemptionExitObservationMaxAgeSec: liveRedemptionMaxObservationAgeSec,
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
      const selectedDex = selectBestRouteCapacity({
        observations: fixedInput.dexLiqMap[newCard.id]?.exitRouteObservations,
        lane: "dex",
        modeledExitSizeUsd,
        clockSec: fixedInput.clockSec,
        maxObservationAgeSec: dexMaxObservationAgeSec,
      });
      const dexProducerCoverage = fixedInput.dexLiqMap[newCard.id]?.exitRouteObservationCoverage;
      const dexProducerCoverageComplete = isDexExitRouteCoverageComplete(dexProducerCoverage);
      const dex =
        selectedDex.status === "eligible" && !dexProducerCoverageComplete
          ? {
              ...selectedDex,
              status: "observed-ineligible" as const,
              eligibleObservationCount: 0,
              best: null,
            }
          : selectedDex;
      const redemption = selectBestRouteCapacity({
        observations: redemptionProfile?.exitRouteObservations,
        lane: "redemption",
        modeledExitSizeUsd,
        clockSec: fixedInput.clockSec,
        maxObservationAgeSec: liveRedemptionMaxObservationAgeSec,
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
              scoreEligiblePoolCount: dexProducerCoverage.scoreEligiblePoolCount ?? 0,
              unsupportedPoolCount: dexProducerCoverage.unsupportedPoolCount,
              complete: dexProducerCoverageComplete,
            }
          : {
              status: "unknown" as const,
              retainedPoolCount: 0,
              scoreEligiblePoolCount: 0,
              unsupportedPoolCount: 0,
              complete: false,
            },
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
    ...(fixedInput.captureKind === "exact-publication-inputs" ? [] : ["capture-not-publication-exact"]),
    ...(methodologyMismatchBypassUsed ? ["methodology-mismatch-bypass-used"] : []),
    ...(registryMismatchBypassUsed ? ["registry-mismatch-bypass-used"] : []),
    ...(options.producerGenerationStatus === "complete" ? [] : ["producer-generation-incomplete"]),
    ...(dexEligibleAssets >= minimumDexEligibleAssets ? [] : ["dex-eligible-asset-floor-not-met"]),
    ...(redemptionEligibleAssets >= minimumRedemptionEligibleAssets ? [] : ["redemption-eligible-asset-floor-not-met"]),
  ];
  const activationReady = blockers.length === 0;
  if (options.activationDecision === "activate" && !activationReady) {
    throw new Error(`Cannot activate same-notional scoring: ${blockers.join(", ")}`);
  }

  return {
    schemaVersion: 1,
    generationId: options.generationId,
    source: {
      sourceGeneration: fixedInput.sourceGeneration,
      baseInputGenerationId: fixedInput.baseInputGenerationId,
      captureKind: fixedInput.captureKind,
      methodologyMismatchBypassUsed,
      registryMismatchBypassUsed,
      registryRevision: fixedInput.registryRevision,
      registryFingerprint: fixedInput.registryFingerprint,
      dexGenerationId: fixedInput.dexGenerationId,
      redemptionGenerationId: fixedInput.redemptionGenerationId,
      dexPayloadFingerprint: fixedInput.dexPayloadFingerprint,
      redemptionPayloadFingerprint: fixedInput.redemptionPayloadFingerprint,
      inputMethodologyVersions,
      capturedAt: fixedInput.capturedAt,
      clockSec: fixedInput.clockSec,
      inputMethodologyVersion: fixedInput.methodologyVersion,
      replayMethodologyVersion: active.methodology.version,
      legacyReplayPayloadFingerprint: computeReportCardsReplayPayloadFingerprint(legacy),
      activeReplayPayloadFingerprint: computeReportCardsReplayPayloadFingerprint(active),
    },
    generalPolicy: {
      activationPolicyVersion: P4_GENERAL_ACTIVATION_POLICY_V1.version,
      modeledExitSize: REDEMPTION_EFFECTIVE_EXIT_MODEL.modeledExitSize,
      modeledExitSizeFormulaChanged: false,
      comparisonRequest: SAME_NOTIONAL_EXIT_REQUEST_POLICY,
      dexMaxObservationAgeSec,
      liveRedemptionMaxObservationAgeSec,
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
      "minimum-dex-eligible-assets": {
        type: "string",
        default: String(P4_GENERAL_ACTIVATION_POLICY_V1.minimumDexEligibleAssets),
      },
      "minimum-redemption-eligible-assets": {
        type: "string",
        default: String(P4_GENERAL_ACTIVATION_POLICY_V1.minimumRedemptionEligibleAssets),
      },
      "dex-max-observation-age-sec": { type: "string", default: String(DEFAULT_DEX_MAX_OBSERVATION_AGE_SEC) },
      "live-redemption-max-observation-age-sec": {
        type: "string",
        default: String(DEFAULT_LIVE_REDEMPTION_MAX_OBSERVATION_AGE_SEC),
      },
      "allow-methodology-mismatch": { type: "boolean" },
      "allow-registry-mismatch": { type: "boolean" },
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
      min: P4_GENERAL_ACTIVATION_POLICY_V1.minimumDexEligibleAssets,
    }),
    minimumRedemptionEligibleAssets: parseCliInteger(values["minimum-redemption-eligible-assets"], {
      name: "--minimum-redemption-eligible-assets",
      min: P4_GENERAL_ACTIVATION_POLICY_V1.minimumRedemptionEligibleAssets,
    }),
    dexMaxObservationAgeSec: parseCliInteger(values["dex-max-observation-age-sec"], {
      name: "--dex-max-observation-age-sec",
      min: 0,
    }),
    liveRedemptionMaxObservationAgeSec: parseCliInteger(values["live-redemption-max-observation-age-sec"], {
      name: "--live-redemption-max-observation-age-sec",
      min: 0,
    }),
    allowMethodologyMismatch: values["allow-methodology-mismatch"] === true,
    allowRegistryMismatch: values["allow-registry-mismatch"] === true,
  });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- explicit local operator output path.
  writeFileSync(values.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runCliEntrypoint(runCli, { label: "report-cards:calibrate-exit-routes", usage: USAGE });
}
