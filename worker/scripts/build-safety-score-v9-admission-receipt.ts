#!/usr/bin/env node

/**
 * Safety Score V9 new-asset admission receipt builder and offline verifier (#1662).
 *
 * Emits `schemaVersion: 3` admission receipts from the single counting authority
 * (`projectV9CardOpenEvidence` in `shared/lib/safety-score-v9/open-questions.ts`):
 *
 *  - `prospective-offline` (default): compiles `{asset} ∪ transitiveAncestors(asset)`
 *    against the local branch checkout, all sidecars/overlays, and a Phase 1a
 *    external supply observation inside an evidence-free native v4 shell whose
 *    DEX, redemption, peg, live-reserve, and chain-supply lanes are explicitly
 *    unavailable (never verified-empty or zero). Recomputable offline in CI via
 *    `--verify <receipt>`.
 *  - `production-capture` (`--from-replay <replay.json>`): projects the same
 *    `schemaVersion: 3` receipt shape from a completed `safety-score-v9:replay`
 *    artifact (required for live-reserve-only wrappers whose parent collapses in
 *    an offline shell).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import accessLookthroughReviewsAsset from "@shared/data/safety-score-v9/access-lookthrough-reviews-v1.json";
import { SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST } from "@shared/data/safety-score-v9/evaluation-build-manifest-v1";
import evidenceGapClassificationsAsset from "@shared/data/safety-score-v9/evidence-gap-classifications-v1.json";
import exitExecutionModelReviewsAsset from "@shared/data/safety-score-v9/exit-execution-model-reviews-v1.json";
import incidentReviewsAsset from "@shared/data/safety-score-v9/incident-reviews-v1.json";
import mechanismReviewOverlaysAsset from "@shared/data/safety-score-v9/mechanism-review-overlays-v1.json";
import reserveBoundFactsAsset from "@shared/data/safety-score-v9/reserve-bound-facts-v1.json";
import supplyAttributionReviewsAsset from "@shared/data/safety-score-v9/supply-attribution-reviews-v1.json";
import transferReviewOverlaysAsset from "@shared/data/safety-score-v9/transfer-review-overlays-v1.json";
import wrapperAllocationReviewsAsset from "@shared/data/safety-score-v9/wrapper-allocation-reviews-v1.json";
import { compareCodeUnits } from "@shared/lib/compare";
import { deriveEffectiveDependencies } from "@shared/lib/dependency-derivation";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/constants";
import {
  computeRedemptionPayloadFingerprint,
  computeReportCardsRegistryFingerprint,
} from "@shared/lib/report-cards-fixed-input-identity";
import type { V9DocumentationAssetFacts, V9DocumentationClassification } from "@shared/lib/safety-score-v9/documentation";
import { projectV9CardOpenEvidence, type V9CardOpenQuestion } from "@shared/lib/safety-score-v9/open-questions";
import { loadV9CandidateMethodologyPolicy } from "@shared/lib/safety-score-v9/policy";
import { domainDigest } from "@shared/lib/safety-score-v9/primitives";
import { collectV9DocumentationGapIds } from "@shared/lib/safety-score-v9/public";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { parseIsoDateOrUtcInstantSec } from "@shared/types/date-primitives";
import type { V9OpenEvidenceByCard } from "@shared/types/safety-score-v9-open-evidence";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import {
  NEW_ASSET_ADMISSION_CLOCK_MAX_AGE_SEC,
  NEW_ASSET_RECEIPT_DIR,
  NEW_ASSET_RECEIPT_KIND,
  NewAssetAdmissionReceiptSchema,
  PROSPECTIVE_ABSENT_RUNTIME_LANES,
  PROSPECTIVE_ADMISSION_INPUT_ID_PREFIX,
  ProspectiveSupplyObservationSchema,
  type ProductionCaptureAdmissionReceipt,
  type ProspectiveOfflineAdmissionReceipt,
  type ProspectiveSupplyObservation,
  type ProspectiveVerifyFailureKind,
} from "../../scripts/ci/check-new-asset-evidence-packet";
import {
  assertCliUsage,
  parseCliInteger,
  parseStrictCliArgs,
  runDirectCli,
  writeCliHelpIfRequested,
} from "../../scripts/lib/cli-args.mjs";
import {
  buildSafetyScoreV9Candidate,
  type SafetyScoreV9CandidatePipelineResult,
} from "../src/lib/safety-score-v9/candidate";
import {
  computeNativeDexLiquidityPayloadFingerprint,
  type NativeDexLiquidityRow,
} from "../src/lib/safety-score-v9/native-input";
import type { SafetyScoreV9ReplayArtifact } from "./replay-safety-score-v9";

const USAGE = `Usage:
  npm run safety-score-v9:admit-receipt -- --asset <id> --supply-observations <path> [options]
  npm run safety-score-v9:admit-receipt -- --from-replay <path> --asset <id> [options]
  npm run safety-score-v9:admit-receipt -- --verify <receipt-path> [--now <time>] [--json]

Builds or verifies a schemaVersion 3 Safety Score V9 new-asset admission receipt.

Options:
  --asset <id>                    Target active stablecoin ID (prospective-offline or --from-replay)
  --supply-observations <path>    Phase 1a external supply observation JSON (keyed by asset ID or single object)
  --clock <time>                  Admission clock ISO timestamp or Unix seconds (default: --now / current time)
  --from-replay <path>            Build a production-capture receipt from a safety-score-v9:replay artifact
  --verify <path>                 Recompute and verify a committed prospective-offline receipt against this checkout
  --now <time>                    Reference Unix seconds or ISO timestamp for clock checks (default: current time)
  --output <path>                 Output receipt path (default: <receipt-dir>/<assetId>.json)
  --receipt-dir <path>            Receipt directory when --output is omitted (default: ${NEW_ASSET_RECEIPT_DIR})
  --json                          Print machine-readable JSON status to stdout
  -h, --help                      Show this help

Exit codes: 0 ok, 1 verification/build refusal, 2 usage error.`;

const UNAVAILABLE_DEX_UPDATED_AT_SEC = 0;
const UNAVAILABLE_DEX_GENERATION_ID = `dex-liquidity-${UNAVAILABLE_DEX_UPDATED_AT_SEC}`;
const UNAVAILABLE_REDEMPTION_GENERATION_ID = "redemption-backstops-unavailable";

const CURATED_DATE_STRING_KEYS = new Set([
  "reviewedAt",
  "compositionAsOf",
  "observedAt",
  "publishedAt",
  "periodEnd",
  "measuredAt",
]);

const CURATED_DATE_SEC_KEYS = new Set([
  "reviewedAtSec",
  "asOfSec",
]);

export type ProspectiveReceiptBuildResult =
  | {
      ok: true;
      receipt: ProspectiveOfflineAdmissionReceipt;
      pipeline: Readonly<SafetyScoreV9CandidatePipelineResult>;
    }
  | {
      ok: false;
      kind: ProspectiveVerifyFailureKind;
      message: string;
    };

export type ProspectiveReceiptVerifyResult =
  | {
      ok: true;
      assetId: string;
      prospectiveInputId: string;
    }
  | {
      ok: false;
      kind: ProspectiveVerifyFailureKind;
      message: string;
    };

function parseTimestampSec(value: unknown, optionName: string): number {
  const raw = String(value ?? "").trim();
  assertCliUsage(raw.length > 0, `${optionName} is required`);
  if (/^[0-9]+$/u.test(raw)) {
    return parseCliInteger(raw, { name: optionName, min: 1 });
  }
  const millis = Date.parse(raw);
  assertCliUsage(Number.isFinite(millis), `${optionName} must be a valid ISO timestamp or Unix seconds`);
  assertCliUsage(millis > 0, `${optionName} must be a positive Unix timestamp`);
  assertCliUsage(millis % 1_000 === 0, `${optionName} must resolve to whole Unix seconds`);
  return millis / 1_000;
}

function collectCuratedTimestampsSec(value: unknown, out: number[]): void {
  if (value === null || value === undefined || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectCuratedTimestampsSec(item, out);
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (CURATED_DATE_STRING_KEYS.has(key) && typeof entry === "string" && entry.length > 0) {
      const parsed = parseIsoDateOrUtcInstantSec(entry);
      if (Number.isFinite(parsed)) out.push(Math.ceil(parsed));
    } else if (CURATED_DATE_SEC_KEYS.has(key) && typeof entry === "number" && Number.isFinite(entry)) {
      out.push(Math.ceil(entry));
    } else if (entry !== null && typeof entry === "object") {
      collectCuratedTimestampsSec(entry, out);
    }
  }
}

/**
 * Deterministic prospective admission input identity bound into the receipt and
 * re-checked during CI `--verify` recomputation.
 */
export function computeProspectiveAdmissionInputId(input: {
  assetId: string;
  admissionClockSec: number;
  evaluatedCohortIds: readonly string[];
  supplyObservation: ProspectiveSupplyObservation;
  registryFingerprint: string;
  evaluationBuildDigest: string;
}): string {
  const digest = domainDigest("safety-score-v9.prospective-admission-input.v1", {
    assetId: input.assetId,
    admissionClockSec: input.admissionClockSec,
    evaluatedCohortIds: [...input.evaluatedCohortIds].sort(compareCodeUnits),
    supplyObservation: input.supplyObservation,
    registryFingerprint: input.registryFingerprint,
    evaluationBuildDigest: input.evaluationBuildDigest,
  });
  return `${PROSPECTIVE_ADMISSION_INPUT_ID_PREFIX}${digest}`;
}

/**
 * Transitive dependency closure `{assetId} ∪ transitiveAncestors(assetId)` over
 * active registry rows, ordered canonically by UTF-16 code units.
 */
export function collectProspectiveCohortIds(
  assetId: string,
  metaById: ReadonlyMap<string, StablecoinMeta> = ACTIVE_META_BY_ID,
): string[] {
  if (!metaById.has(assetId)) {
    throw new Error(`${assetId} is not active in the local registry`);
  }
  const visited = new Set<string>();
  const queue: string[] = [assetId];
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    if (visited.has(currentId)) continue;
    const meta = metaById.get(currentId);
    if (!meta) continue;
    visited.add(currentId);

    const upstreamIds = new Set<string>();
    for (const dependency of deriveEffectiveDependencies(meta)) upstreamIds.add(dependency.id);
    if (meta.variantOf) upstreamIds.add(meta.variantOf);
    if (meta.pegReferenceId) upstreamIds.add(meta.pegReferenceId);
    for (const relationship of meta.dependencyReview?.relationships ?? []) upstreamIds.add(relationship.id);
    for (const slice of meta.reserves ?? []) {
      if (slice.coinId) upstreamIds.add(slice.coinId);
    }
    for (const upstreamId of upstreamIds) {
      if (!visited.has(upstreamId) && metaById.has(upstreamId)) queue.push(upstreamId);
    }
  }
  return [...visited].sort(compareCodeUnits);
}

/**
 * Latest curated review timestamp (whole Unix seconds) across coin metadata and
 * all V9 overlay files for every asset in `cohortIds`. Returns `0` when no
 * curated review dates exist for the cohort.
 */
export function maxCuratedReviewSecForCohort(
  cohortIds: readonly string[],
  metaById: ReadonlyMap<string, StablecoinMeta> = ACTIVE_META_BY_ID,
): number {
  const cohortSet = new Set(cohortIds);
  const timestamps: number[] = [];

  for (const id of cohortIds) {
    const meta = metaById.get(id);
    if (meta) collectCuratedTimestampsSec(meta, timestamps);
  }
  for (const overlay of mechanismReviewOverlaysAsset.overlays) {
    if (cohortSet.has(overlay.assetId)) collectCuratedTimestampsSec(overlay, timestamps);
  }
  for (const review of transferReviewOverlaysAsset.reviews) {
    if (cohortSet.has(review.assetId)) collectCuratedTimestampsSec(review, timestamps);
  }
  for (const entry of evidenceGapClassificationsAsset.entries) {
    if (cohortSet.has(entry.assetId)) collectCuratedTimestampsSec(entry, timestamps);
  }
  for (const review of wrapperAllocationReviewsAsset.reviews) {
    if (cohortSet.has(review.assetId)) collectCuratedTimestampsSec(review, timestamps);
  }
  for (const review of wrapperAllocationReviewsAsset.localReviews) {
    if (cohortSet.has(review.assetId)) collectCuratedTimestampsSec(review, timestamps);
  }
  for (const review of accessLookthroughReviewsAsset.reviews) {
    if (cohortSet.has(review.assetId)) collectCuratedTimestampsSec(review, timestamps);
  }
  for (const review of exitExecutionModelReviewsAsset.reviews) {
    if (cohortSet.has(review.identity.assetId)) collectCuratedTimestampsSec(review, timestamps);
  }
  for (const incident of incidentReviewsAsset.incidents) {
    if (cohortSet.has(incident.assetId)) collectCuratedTimestampsSec(incident, timestamps);
  }
  for (const review of incidentReviewsAsset.negativeReviews) {
    if (review.assetId !== undefined && cohortSet.has(review.assetId)) {
      collectCuratedTimestampsSec(review, timestamps);
    }
  }
  const reserveBoundByAsset = reserveBoundFactsAsset.assets as Record<string, unknown>;
  for (const id of cohortIds) {
    if (Object.prototype.hasOwnProperty.call(reserveBoundByAsset, id)) {
      collectCuratedTimestampsSec(reserveBoundByAsset[id], timestamps);
    }
  }
  for (const review of supplyAttributionReviewsAsset.reviews) {
    if (cohortSet.has(review.assetId)) collectCuratedTimestampsSec(review, timestamps);
  }

  return timestamps.length === 0 ? 0 : Math.max(...timestamps);
}

/**
 * Evidence-free native v4 compiler shell for offline admission.
 *
 * DEX is explicitly unavailable — never verified-empty (REVIEW-1 #1, R1/R2):
 *  - `dexLiqMap[id] = { updatedAt: 0 }` omits `exitRouteObservations` and
 *    `exitRouteObservationCoverage`;
 *  - `dexGenerationId = "dex-liquidity-0"`, `liquidityStale: true`,
 *    `inputFreshness.dexLiquidity = { updatedAt: 0, ageSeconds: admissionClockSec, stale: true }`;
 *  - `v9PublicationInputHealth.dex = { state: "unavailable", generationId: null, updatedAtSec: null }`;
 *  - `dexDeploymentSupplyCoverageById: {}` and no `acceptedPublication`.
 *
 * Together those guarantee `locallyEmptySurface = false`, `partialVerifiedEmpty = false`,
 * `fullSupplyVerifiedEmpty = false`, and `priorVerifiedEmptyExitCeiling = undefined` in
 * `fact-set-exit.ts` and `exit.ts`, so Exit emits `missing-runtime-route-evidence`
 * (counted as an open question) and never verified-empty coverage.
 */
export function buildProspectiveOfflineFixedInput(input: {
  assetId: string;
  admissionClockSec: number;
  cohortIds: readonly string[];
  supplyObservation: ProspectiveSupplyObservation;
  registryFingerprint?: string;
}) {
  const registryFingerprint = input.registryFingerprint ?? computeReportCardsRegistryFingerprint();
  const activeAssetIds = [...input.cohortIds].sort(compareCodeUnits);
  const dexLiqMap: Record<string, NativeDexLiquidityRow> = Object.fromEntries(
    activeAssetIds.map((id) => [id, { updatedAt: UNAVAILABLE_DEX_UPDATED_AT_SEC }]),
  );
  return {
    schemaVersion: 4 as const,
    captureKind: "native-v9-inputs" as const,
    capturedAt: new Date(input.admissionClockSec * 1_000).toISOString(),
    sourceGeneration: `prospective-offline:${SAFETY_SCORE_METHODOLOGY_VERSION}:${input.admissionClockSec}`,
    registryRevision: `sha256:${registryFingerprint}`,
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    clockSec: input.admissionClockSec,
    updatedAt: input.admissionClockSec,
    liquidityStale: true,
    redemptionStale: true,
    inputFreshness: {
      dexLiquidity: {
        updatedAt: UNAVAILABLE_DEX_UPDATED_AT_SEC,
        ageSeconds: input.admissionClockSec,
        stale: true,
      },
      redemptionBackstops: {
        updatedAt: null,
        ageSeconds: null,
        stale: true,
      },
    },
    v9PublicationInputHealth: {
      dex: { state: "unavailable" as const, generationId: null, updatedAtSec: null },
      redemption: { state: "unavailable" as const, generationId: null, updatedAtSec: null },
      liveReserves: { state: "unavailable" as const, coverageRatio: null },
    },
    pegDataById: {},
    activeDepegPeakBpsById: {},
    redemptionBackstopMap: {},
    liveReserveMap: {},
    liveReserveProvenanceMap: {},
    chainCirculatingById: {},
    aggregateCirculatingById: {},
    dexDeploymentSupplyCoverageById: {},
    liveToFallbackCoins: [],
    replaySupplyObservationsById: {
      [input.assetId]: input.supplyObservation,
    },
    activeAssetIds,
    dexGenerationId: UNAVAILABLE_DEX_GENERATION_ID,
    redemptionGenerationId: UNAVAILABLE_REDEMPTION_GENERATION_ID,
    dexPayloadFingerprint: computeNativeDexLiquidityPayloadFingerprint(dexLiqMap, UNAVAILABLE_DEX_GENERATION_ID),
    redemptionPayloadFingerprint: computeRedemptionPayloadFingerprint({}, UNAVAILABLE_REDEMPTION_GENERATION_ID),
    registryFingerprint,
    inputMethodologyVersions: {
      safetyScore: SAFETY_SCORE_METHODOLOGY_VERSION,
      dexLiquidity: [],
      pegScore: [],
      redemptionBackstop: [],
    },
    dexLiqMap,
  };
}

/**
 * Projects `card` and `questions[]` from an evaluated V9 pipeline using the
 * single open-evidence authority (`projectV9CardOpenEvidence`) and verifies
 * exact parity with `pipeline.candidate.openEvidence.byCard`.
 */
export function projectReceiptEvidenceFromPipeline(
  pipeline: Readonly<SafetyScoreV9CandidatePipelineResult>,
  assetId: string,
): { card: V9OpenEvidenceByCard; questions: V9CardOpenQuestion[] } {
  const policy = loadV9CandidateMethodologyPolicy(pipeline.fixedInput.clockSec);
  const factsById = new Map(pipeline.compiledFacts.assets.map((asset) => [asset.assetId, asset]));
  const gapIds = new Map<string, V9DocumentationClassification>();

  for (const evaluatedAsset of pipeline.evaluatedSet.assets) {
    const facts = factsById.get(evaluatedAsset.assetId);
    if (!facts) {
      throw new Error(`Compiled facts missing evaluated asset ${evaluatedAsset.assetId}`);
    }
    const admittedExitRouteKeys = new Set<string>();
    for (const route of evaluatedAsset.exit.routes) {
      if (route.included) admittedExitRouteKeys.add(route.routeKey);
    }
    const enriched: V9DocumentationAssetFacts = { ...facts, admittedExitRouteKeys };
    for (const [gapId, classification] of collectV9DocumentationGapIds(policy, [enriched])) {
      gapIds.set(gapId, classification);
    }
  }

  const projections = projectV9CardOpenEvidence({
    assets: pipeline.compiledFacts.assets,
    evaluated: pipeline.evaluatedSet.assets,
    isDocumentationGap: (gap) => gapIds.get(gap.gapId)?.reason ?? null,
  });
  const projection = projections.get(assetId);
  if (!projection) {
    throw new Error(`Evaluated pipeline does not contain asset ${assetId}`);
  }

  const publishedByCard = pipeline.candidate.openEvidence?.byCard.find((entry) => entry.id === assetId);
  const card: V9OpenEvidenceByCard = publishedByCard?.documentationOnlyLimited !== undefined
    ? { ...projection.card, documentationOnlyLimited: [...publishedByCard.documentationOnlyLimited] }
    : projection.card;

  if (publishedByCard !== undefined) {
    if (stableJsonStringifyV1(card) !== stableJsonStringifyV1(publishedByCard)) {
      throw new Error(
        `Projected admission card for ${assetId} drifted from published openEvidence.byCard`,
      );
    }
  } else if (
    projection.questions.length !== 0 ||
    card.openBucketQuestionsCarried !== 0 ||
    card.inheritedOpenBucketQuestionsCarried !== 0 ||
    card.openBucketObligationsCarried !== 0 ||
    card.documentationObligationsCarried !== 0
  ) {
    throw new Error(
      `Asset ${assetId} is absent from published openEvidence.byCard but projected non-zero obligations`,
    );
  }

  return {
    card,
    questions: [...projection.questions],
  };
}

function checkAdmissionClockBounds(input: {
  admissionClockSec: number;
  nowSec: number;
  maxCuratedReviewSec: number;
  supplyObservation: ProspectiveSupplyObservation;
}): { ok: true } | { ok: false; kind: "stale-admission-clock"; message: string } {
  if (input.admissionClockSec > input.nowSec) {
    return {
      ok: false,
      kind: "stale-admission-clock",
      message: `admissionClockSec ${input.admissionClockSec} is in the future relative to ${input.nowSec}`,
    };
  }
  const ageSec = input.nowSec - input.admissionClockSec;
  if (ageSec > NEW_ASSET_ADMISSION_CLOCK_MAX_AGE_SEC) {
    return {
      ok: false,
      kind: "stale-admission-clock",
      message: `admissionClockSec ${input.admissionClockSec} is ${ageSec}s old (max ${NEW_ASSET_ADMISSION_CLOCK_MAX_AGE_SEC}s)`,
    };
  }
  if (input.admissionClockSec < input.maxCuratedReviewSec) {
    return {
      ok: false,
      kind: "stale-admission-clock",
      message:
        `admissionClockSec ${input.admissionClockSec} predates the evaluated cohort's latest curated review ` +
        `(${input.maxCuratedReviewSec})`,
    };
  }
  const { observedAtSec, retrievedAtSec } = input.supplyObservation;
  if (observedAtSec !== null && observedAtSec > Math.min(input.admissionClockSec, retrievedAtSec)) {
    return {
      ok: false,
      kind: "stale-admission-clock",
      message:
        `supplyObservation.observedAtSec (${observedAtSec}) exceeds ` +
        `min(admissionClockSec=${input.admissionClockSec}, retrievedAtSec=${retrievedAtSec})`,
    };
  }
  return { ok: true };
}

/**
 * Builds a `schemaVersion: 3, receiptMode: "prospective-offline"` admission
 * receipt for an active local registry coin without requiring a production D1
 * capture.
 */
export function buildProspectiveAdmissionReceipt(input: {
  assetId: string;
  admissionClockSec: number;
  supplyObservation: ProspectiveSupplyObservation;
  nowSec?: number;
  metaById?: ReadonlyMap<string, StablecoinMeta>;
  registryFingerprint?: string;
}): ProspectiveReceiptBuildResult {
  const metaById = input.metaById ?? ACTIVE_META_BY_ID;
  if (!metaById.has(input.assetId)) {
    return {
      ok: false,
      kind: "recomputed-receipt-mismatch",
      message: `asset "${input.assetId}" is not active in the local registry`,
    };
  }
  const parsedSupply = ProspectiveSupplyObservationSchema.safeParse(input.supplyObservation);
  if (!parsedSupply.success) {
    const issue = parsedSupply.error.issues[0];
    return {
      ok: false,
      kind: "recomputed-receipt-mismatch",
      message: `invalid supplyObservation at ${issue?.path.join(".") || "<root>"}: ${issue?.message}`,
    };
  }
  const supplyObservation = parsedSupply.data;
  const evaluatedCohortIds = collectProspectiveCohortIds(input.assetId, metaById);
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1_000);
  const maxCuratedReviewSec = maxCuratedReviewSecForCohort(evaluatedCohortIds, metaById);
  const clockCheck = checkAdmissionClockBounds({
    admissionClockSec: input.admissionClockSec,
    nowSec,
    maxCuratedReviewSec,
    supplyObservation,
  });
  if (!clockCheck.ok) return clockCheck;

  const registryFingerprint = input.registryFingerprint ?? computeReportCardsRegistryFingerprint();
  const fixedInput = buildProspectiveOfflineFixedInput({
    assetId: input.assetId,
    admissionClockSec: input.admissionClockSec,
    cohortIds: evaluatedCohortIds,
    supplyObservation,
    registryFingerprint,
  });
  const pipeline = buildSafetyScoreV9Candidate(
    {
      fixedInput,
      publishedAtSec: input.admissionClockSec,
      ...(input.metaById === undefined
        ? {}
        : { registry: { metaById: input.metaById, registryFingerprint } }),
    },
    "asset-admission",
  );

  const directQuarantine = pipeline.quarantines.find((quarantine) => quarantine.assetId === input.assetId);
  if (directQuarantine) {
    return {
      ok: false,
      kind: "prospective-asset-quarantined",
      message: `candidate ${input.assetId} was quarantined during offline compilation (${directQuarantine.code}: ${directQuarantine.message})`,
    };
  }

  const cardById = new Map(pipeline.candidate.cards.map((card) => [card.id, card]));
  const quarantinedById = new Map(pipeline.quarantines.map((quarantine) => [quarantine.assetId, quarantine]));
  for (const parentId of evaluatedCohortIds) {
    if (parentId === input.assetId) continue;
    const parentQuarantine = quarantinedById.get(parentId);
    if (parentQuarantine) {
      return {
        ok: false,
        kind: "prospective-parent-pipeline-gap",
        message:
          `transitive parent ${parentId} was quarantined during offline compilation ` +
          `(${parentQuarantine.code}: ${parentQuarantine.message}); use a production-capture receipt instead`,
      };
    }
    const parentCard = cardById.get(parentId);
    if (!parentCard || parentCard.ratingStatus === "pipeline-gap") {
      return {
        ok: false,
        kind: "prospective-parent-pipeline-gap",
        message:
          `transitive parent ${parentId} resolved to ${parentCard?.ratingStatus ?? "missing"} in the offline shell, ` +
          "which can blank dependent pillars; use a production-capture receipt instead",
      };
    }
  }

  if (!cardById.has(input.assetId)) {
    return {
      ok: false,
      kind: "prospective-asset-quarantined",
      message: `candidate ${input.assetId} is absent from evaluated candidate cards`,
    };
  }

  const evaluationBuildDigest = pipeline.candidateIdentity.evaluationBuildDigest;
  if (evaluationBuildDigest !== SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST) {
    return {
      ok: false,
      kind: "recomputed-receipt-mismatch",
      message:
        `pipeline evaluationBuildDigest (${evaluationBuildDigest}) does not match checkout ` +
        `SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST (${SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST})`,
    };
  }

  const { card, questions } = projectReceiptEvidenceFromPipeline(pipeline, input.assetId);
  const prospectiveInputId = computeProspectiveAdmissionInputId({
    assetId: input.assetId,
    admissionClockSec: input.admissionClockSec,
    evaluatedCohortIds,
    supplyObservation,
    registryFingerprint,
    evaluationBuildDigest,
  });

  const receipt = NewAssetAdmissionReceiptSchema.parse({
    schemaVersion: 3,
    receiptMode: "prospective-offline",
    kind: NEW_ASSET_RECEIPT_KIND,
    assetId: input.assetId,
    prospectiveInputId,
    admissionClockSec: input.admissionClockSec,
    evaluatedCohortIds,
    absentRuntimeLanes: [...PROSPECTIVE_ABSENT_RUNTIME_LANES],
    supplyObservation,
    registryFingerprint,
    evaluationBuildDigest,
    card,
    questions,
  }) as ProspectiveOfflineAdmissionReceipt;

  return { ok: true, receipt, pipeline };
}

/**
 * Projects a `schemaVersion: 3, receiptMode: "production-capture"` receipt from
 * a completed `safety-score-v9:replay` artifact.
 */
export function buildProductionCaptureAdmissionReceipt(
  artifact: SafetyScoreV9ReplayArtifact,
  assetId: string,
): ProductionCaptureAdmissionReceipt {
  if (artifact.kind !== "safety-score-v9-candidate-replay" || !artifact.pipeline) {
    throw new Error("Input is not a valid safety-score-v9-candidate-replay artifact");
  }
  const { pipeline, replayScenario } = artifact;
  const admissionEntry = replayScenario?.kind === "asset-admission"
    ? replayScenario.assets.find((entry) => entry.assetId === assetId)
    : undefined;
  const captureId = admissionEntry
    ? `${replayScenario!.sourceBaseInputGenerationId}${admissionEntry.captureIdSuffix}`
    : pipeline.fixedInput.baseInputGenerationId;
  const registryFingerprint = admissionEntry && replayScenario?.kind === "asset-admission"
    ? replayScenario.registryFingerprint
    : pipeline.fixedInput.registryFingerprint;
  const evaluationBuildDigest = admissionEntry && replayScenario?.kind === "asset-admission"
    ? replayScenario.evaluationBuildDigest
    : pipeline.candidateIdentity.evaluationBuildDigest;
  const { card, questions } = projectReceiptEvidenceFromPipeline(pipeline, assetId);

  return NewAssetAdmissionReceiptSchema.parse({
    schemaVersion: 3,
    receiptMode: "production-capture",
    kind: NEW_ASSET_RECEIPT_KIND,
    assetId,
    captureId,
    captureClockSec: pipeline.fixedInput.clockSec,
    registryFingerprint,
    evaluationBuildDigest,
    card,
    questions,
  }) as ProductionCaptureAdmissionReceipt;
}

/**
 * Recomputes a committed `prospective-offline` receipt against the current
 * checkout and fails closed on any clock, binding, quarantine, parent, or
 * evidence-projection mismatch.
 */
export function verifyProspectiveAdmissionReceipt(
  rawReceipt: unknown,
  options: {
    nowSec?: number;
    metaById?: ReadonlyMap<string, StablecoinMeta>;
    registryFingerprint?: string;
  } = {},
): ProspectiveReceiptVerifyResult {
  const parsed = NewAssetAdmissionReceiptSchema.safeParse(rawReceipt);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      kind: "recomputed-receipt-mismatch",
      message: `committed receipt failed schema validation at ${issue?.path.join(".") || "<root>"}: ${issue?.message}`,
    };
  }
  const committed = parsed.data;
  if (committed.schemaVersion !== 3 || committed.receiptMode !== "prospective-offline") {
    return {
      ok: false,
      kind: "recomputed-receipt-mismatch",
      message: `expected a schemaVersion 3 prospective-offline receipt, got schemaVersion ${committed.schemaVersion}`,
    };
  }

  const registryFingerprint = options.registryFingerprint ?? computeReportCardsRegistryFingerprint();
  if (committed.registryFingerprint !== registryFingerprint) {
    return {
      ok: false,
      kind: "recomputed-receipt-mismatch",
      message: `receipt registryFingerprint ${committed.registryFingerprint} does not match checkout ${registryFingerprint}`,
    };
  }
  if (committed.evaluationBuildDigest !== SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST) {
    return {
      ok: false,
      kind: "recomputed-receipt-mismatch",
      message:
        `receipt evaluationBuildDigest ${committed.evaluationBuildDigest} does not match checkout ` +
        `${SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST}`,
    };
  }

  const recomputed = buildProspectiveAdmissionReceipt({
    assetId: committed.assetId,
    admissionClockSec: committed.admissionClockSec,
    supplyObservation: committed.supplyObservation,
    nowSec: options.nowSec,
    metaById: options.metaById,
    registryFingerprint,
  });
  if (!recomputed.ok) {
    return { ok: false, kind: recomputed.kind, message: recomputed.message };
  }

  const diffs: string[] = [];
  if (committed.prospectiveInputId !== recomputed.receipt.prospectiveInputId) {
    diffs.push(
      `prospectiveInputId committed=${committed.prospectiveInputId} recomputed=${recomputed.receipt.prospectiveInputId}`,
    );
  }
  if (stableJsonStringifyV1(committed.evaluatedCohortIds) !== stableJsonStringifyV1(recomputed.receipt.evaluatedCohortIds)) {
    diffs.push(
      `evaluatedCohortIds committed=[${committed.evaluatedCohortIds.join(",")}] ` +
        `recomputed=[${recomputed.receipt.evaluatedCohortIds.join(",")}]`,
    );
  }
  if (stableJsonStringifyV1(committed.absentRuntimeLanes) !== stableJsonStringifyV1(recomputed.receipt.absentRuntimeLanes)) {
    diffs.push("absentRuntimeLanes drifted");
  }
  if (stableJsonStringifyV1(committed.card) !== stableJsonStringifyV1(recomputed.receipt.card)) {
    diffs.push("card open-evidence counts drifted from recomputation");
  }
  if (stableJsonStringifyV1(committed.questions) !== stableJsonStringifyV1(recomputed.receipt.questions)) {
    diffs.push("questions[] audit trail drifted from recomputation");
  }
  if (diffs.length > 0) {
    return {
      ok: false,
      kind: "recomputed-receipt-mismatch",
      message: `committed prospective receipt does not match checkout recomputation: ${diffs.join("; ")}`,
    };
  }

  return {
    ok: true,
    assetId: committed.assetId,
    prospectiveInputId: recomputed.receipt.prospectiveInputId,
  };
}

function readSupplyObservationFile(path: string, assetId: string): ProspectiveSupplyObservation {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  assertCliUsage(raw !== null && typeof raw === "object" && !Array.isArray(raw), "--supply-observations must be a JSON object");
  const record = raw as Record<string, unknown>;
  const isDirectObservation =
    "circulating" in record && "url" in record && "field" in record && "retrievedAtSec" in record;
  const candidate = isDirectObservation ? record : record[assetId];
  assertCliUsage(
    candidate !== undefined,
    `--supply-observations file does not contain an entry for asset "${assetId}"`,
  );
  const parsed = ProspectiveSupplyObservationSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    assertCliUsage(
      false,
      `Invalid supply observation for "${assetId}" at ${issue?.path.join(".") || "<root>"}: ${issue?.message}`,
    );
  }
  assertCliUsage(
    getCirculatingRawOrNull(parsed.data) !== null,
    `Supply observation for "${assetId}" requires observed USD circulating buckets`,
  );
  return parsed.data;
}

export async function runSafetyScoreV9AdmissionReceiptCli(
  argv: readonly string[],
  { cwd = process.cwd() }: { cwd?: string } = {},
): Promise<number> {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      asset: { type: "string" },
      "supply-observations": { type: "string" },
      clock: { type: "string" },
      "from-replay": { type: "string" },
      verify: { type: "string" },
      now: { type: "string" },
      output: { type: "string" },
      "receipt-dir": { type: "string" },
      json: { type: "boolean" },
    },
    conflicts: [
      ["verify", "asset"],
      ["verify", "supply-observations"],
      ["verify", "clock"],
      ["verify", "from-replay"],
      ["verify", "output"],
      ["verify", "receipt-dir"],
      ["from-replay", "supply-observations"],
      ["from-replay", "clock"],
      ["output", "receipt-dir"],
    ],
  });
  if (writeCliHelpIfRequested(values, USAGE)) return 0;

  const nowSec = values.now === undefined
    ? Math.floor(Date.now() / 1_000)
    : parseTimestampSec(values.now, "--now");

  if (typeof values.verify === "string") {
    const receiptPath = resolve(cwd, values.verify);
    let rawReceipt: unknown;
    try {
      rawReceipt = JSON.parse(readFileSync(receiptPath, "utf8")) as unknown;
    } catch (error) {
      const failure: ProspectiveReceiptVerifyResult = {
        ok: false,
        kind: "recomputed-receipt-mismatch",
        message: `failed to read receipt ${receiptPath}: ${error instanceof Error ? error.message : String(error)}`,
      };
      if (values.json === true) process.stdout.write(`${JSON.stringify(failure)}\n`);
      else process.stderr.write(`verify failed (${failure.kind}): ${failure.message}\n`);
      return 1;
    }
    const result = verifyProspectiveAdmissionReceipt(rawReceipt, { nowSec });
    if (values.json === true) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else if (result.ok) {
      process.stdout.write(`ok ${result.assetId}: verified ${result.prospectiveInputId}\n`);
    } else {
      process.stderr.write(`verify failed (${result.kind}): ${result.message}\n`);
    }
    return result.ok ? 0 : 1;
  }

  assertCliUsage(typeof values.asset === "string", "--asset is required (unless using --verify)");
  const assetId = values.asset;
  const outputPath = typeof values.output === "string"
    ? resolve(cwd, values.output)
    : resolve(cwd, typeof values["receipt-dir"] === "string" ? values["receipt-dir"] : NEW_ASSET_RECEIPT_DIR, `${assetId}.json`);

  if (typeof values["from-replay"] === "string") {
    const replayPath = resolve(cwd, values["from-replay"]);
    const artifact = JSON.parse(readFileSync(replayPath, "utf8")) as SafetyScoreV9ReplayArtifact;
    const receipt = buildProductionCaptureAdmissionReceipt(artifact, assetId);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    if (values.json === true) {
      process.stdout.write(`${JSON.stringify({ ok: true, outputPath, receipt })}\n`);
    } else {
      process.stdout.write(
        `wrote production-capture receipt for ${assetId} (${receipt.card.openBucketQuestionsCarried} open) -> ${outputPath}\n`,
      );
    }
    return 0;
  }

  assertCliUsage(
    typeof values["supply-observations"] === "string",
    "--supply-observations is required in prospective-offline mode",
  );
  const admissionClockSec = values.clock === undefined
    ? nowSec
    : parseTimestampSec(values.clock, "--clock");
  const supplyObservation = readSupplyObservationFile(resolve(cwd, values["supply-observations"]), assetId);
  const built = buildProspectiveAdmissionReceipt({
    assetId,
    admissionClockSec,
    supplyObservation,
    nowSec,
  });
  if (!built.ok) {
    if (values.json === true) {
      process.stdout.write(`${JSON.stringify(built)}\n`);
    } else {
      process.stderr.write(`refused ${assetId} (${built.kind}): ${built.message}\n`);
    }
    return 1;
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(built.receipt, null, 2)}\n`, "utf8");
  if (values.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, outputPath, receipt: built.receipt })}\n`);
  } else {
    const ownOpen = built.receipt.card.openBucketQuestionsCarried - built.receipt.card.inheritedOpenBucketQuestionsCarried;
    process.stdout.write(
      `wrote prospective-offline receipt for ${assetId} (${ownOpen} own open, ` +
        `${built.receipt.card.inheritedOpenBucketQuestionsCarried} inherited, cohort=${built.receipt.evaluatedCohortIds.length}) -> ${outputPath}\n`,
    );
  }
  return 0;
}

runDirectCli(
  import.meta.url,
  async () => {
    process.exitCode = await runSafetyScoreV9AdmissionReceiptCli(process.argv.slice(2));
  },
  { label: "safety-score-v9:admit-receipt", usage: USAGE },
);
