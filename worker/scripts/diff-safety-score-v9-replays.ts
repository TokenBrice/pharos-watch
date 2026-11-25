import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { readRecord } from "@shared/lib/type-guards";
import { validateReplayCardProjection } from "./lib/safety-score-v9-replay-validation";
import {
  assertCliUsage,
  CliUsageError,
  parseStrictCliArgs,
  runCliEntrypoint,
  writeCliHelpIfRequested,
} from "../../scripts/lib/cli-args.mjs";

// Pinned against `SafetyScoreV9CandidatePipelineResult` (worker/src/lib/
// safety-score-v9-candidate.ts) and `buildSafetyScoreV9Response`
// (shared/lib/safety-score-v9/public.ts): the replay artifact carries the
// published response at `pipeline.candidate`, whose `cards` array holds one
// `SafetyScoreV9CurrentCard` per asset keyed by `id` with `grade` and a
// nullable `score`.
const CARD_ARRAY_PATH = ["pipeline", "candidate", "cards"] as const;
const CARD_ID_FIELD = "id";
const CARD_GRADE_FIELD = "grade";
const CARD_SCORE_FIELD = "score";

/**
 * Keys stripped at every depth before comparing. These carry publication
 * identity or capture timing, so they legitimately differ between two replays
 * of the same scored output and would otherwise drown the real drift.
 *
 * This is the **per-run** family: values that move on every capture or
 * publication attempt even when nothing about the build or the methodology
 * changed. Contrast `VERSION_ACTIVATION_KEYS` below.
 */
export const VOLATILE_KEYS = new Set([
  "publishedAt",
  "capturedAt",
  "updatedAt",
  "safetyScoreIdentity",
  "baseInputGenerationId",
  "publicationGenerationId",
  "evaluationBuildDigest",
  "payloadSha256",
  "contentSha256",
  "generationId",
  "releaseCandidateId",
]);

/**
 * Also stripped at every depth, but for a different reason, so it is a
 * separate set.
 *
 * These are digests and version strings derived from the pinned evaluation
 * build and the methodology identity. They are stable across ordinary runs —
 * unlike `VOLATILE_KEYS` — and change only on a deliberate version activation:
 * regenerating the V9 evaluation-build manifest, or bumping the methodology
 * version and the active policy asset's release version.
 *
 * `evaluationBuildDigest` and `policyDigest` are already governed elsewhere
 * (`VOLATILE_KEYS` strips the former as a leaf), but the digests below are
 * sha256 *over* content that includes them, so a legitimate activation
 * rewrites all of them without moving a single scored value. Comparing them
 * here would report one entry per asset and hide real drift underneath.
 *
 * Their correctness is owned by the changelog and version tests — the
 * methodology changelog entry, `current-version.json`, the policy asset's
 * `releaseVersion`, and the generated-artifact check on the evaluation-build
 * manifest — not by this diff. This tool's job is the scored output: grades,
 * scores, pillars, breakdowns, reasons, evidence, and coverage, all of which
 * remain compared in full.
 */
export const VERSION_ACTIVATION_KEYS = new Set([
  "stateDigest",
  "resultDigest",
  "scoreResultDigest",
  "evaluatedSetDigest",
  "candidateId",
  "compilerFactSchemaDigest",
  "policyVersion",
]);

export interface ReplayDiffEntry {
  assetId: string | null;
  path: string;
  baseline: unknown;
  candidate: unknown;
}

export type ReplayChangeCategory = "unknown-credit-raises" | "cap-removal" | "reserve-admission" |
  "route-selection" | "cause-classification" | "availability" | "schema";

/** Diagnostic attribution only: categories do not assert independent marginal point effects. */
export function categorizeReplayChanges(baseline: unknown, candidate: unknown): Record<ReplayChangeCategory, ReplayDiffEntry[]> {
  validateReplayCardProjection(baseline);
  validateReplayCardProjection(candidate);
  const categories: Record<ReplayChangeCategory, ReplayDiffEntry[]> = {
    "unknown-credit-raises": [], "cap-removal": [], "reserve-admission": [],
    "route-selection": [], "cause-classification": [], availability: [], schema: [],
  };
  const inspect = (a: unknown, b: unknown, path: string, assetId: string | null, uncertain = false): void => {
    if (stableJsonStringifyV1(a) === stableJsonStringifyV1(b)) return;
    const entry = { assetId, path, baseline: a, candidate: b };
    const field = path.slice(path.lastIndexOf(".") + 1);
    if (field === "schemaVersion") categories.schema.push(entry);
    if (/^(ratingStatus|partialEvidence|aggregationDisposition|pipelineGapCount|pipelineGapIds)$/u.test(field)) categories.availability.push(entry);
    if (/^(cause|causeProof|causeScope|causeGapIds|causeGapRefs|localCauseGaps|foreignCauseGapRefs|foreignCauseGaps|evidenceResponsibility|limitedEvidenceCauses|scoringDisposition)$/u.test(field)) categories["cause-classification"].push(entry);
    if (/^(bindingCap|caps)$/u.test(field) && ((b === null && a !== null) ||
      (Array.isArray(a) && Array.isArray(b) && a.some(cap => !b.some(next => next.kind === cap.kind && next.source === cap.source))))) {
      categories["cap-removal"].push(entry);
    }
    if (/^(primaryRoute|backupRoute|primaryRouteKey|backupRouteKey|selectedRoutes|diversificationBonus)$/u.test(field)) categories["route-selection"].push(entry);
    if (/reserveExposures|reserveResidual|reserveEnvelope|admittedReserve|wholeAssetWeight/u.test(path)) {
      if (field === "reserveExposures" || field === "reserveResidual" || field === "reserveEnvelope" || field === "wholeAssetWeight") categories["reserve-admission"].push(entry);
    }
    if (uncertain && /^(score|quality|factor)$/u.test(field) && typeof a === "number" && typeof b === "number" && b > a) {
      categories["unknown-credit-raises"].push(entry);
    }
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b)) return;
      const keyField = ["componentKey", "exposureKey", "routeKey", "key", "assetId", "gapId"].find(key =>
        [...a, ...b].length > 0 && [...a, ...b].every(row => row !== null && typeof row === "object" && typeof row[key] === "string"));
      if (keyField) {
        const before = new Map(a.map(row => [row[keyField], row]));
        const after = new Map(b.map(row => [row[keyField], row]));
        for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) inspect(before.get(key), after.get(key), `${path}[${key}]`, assetId, uncertain);
      } else if ([...a, ...b].every(row => row !== null && typeof row === "object")) {
        for (let index = 0; index < Math.max(a.length, b.length); index++) inspect(a[index], b[index], `${path}[${index}]`, assetId, uncertain);
      }
      return;
    }
    if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
      const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
      const unknown = uncertain || ["missing", "bounded-unknown", "unsupported", "stale"].includes(String(left.observationState)) ||
        /(?:^|-)unknown$/u.test(String(left.posture)) || left.posture === "bounded-unknown" || left.cause === "C" || left.cause === "U";
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
        if (!VOLATILE_KEYS.has(key) && !VERSION_ACTIVATION_KEYS.has(key)) inspect(left[key], right[key], `${path}.${key}`, assetId, unknown);
      }
    }
  };
  const cardsA = resolvePath(baseline, CARD_ARRAY_PATH), cardsB = resolvePath(candidate, CARD_ARRAY_PATH);
  if (Array.isArray(cardsA) && Array.isArray(cardsB)) {
    const before = new Map(cardsA.map(card => [String(card.id), card]));
    const after = new Map(cardsB.map(card => [String(card.id), card]));
    for (const id of [...new Set([...before.keys(), ...after.keys()])].sort()) inspect(before.get(id), after.get(id), `cards[${id}]`, id);
  }
  inspect(stripCards(baseline), stripCards(candidate), "$", null);
  return categories;
}

export interface ReplayDiffResult {
  equal: boolean;
  entries: ReplayDiffEntry[];
}

function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (VOLATILE_KEYS.has(key) || VERSION_ACTIVATION_KEYS.has(key)) continue;
      out[key] = stripVolatile(entry);
    }
    return out;
  }
  return value;
}

function resolvePath(root: unknown, path: readonly string[]): unknown {
  let cursor: unknown = root;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/** Remove the per-asset card array, which is diffed by asset id instead. */
function stripCards(root: unknown): unknown {
  if (root === null || typeof root !== "object") return root;
  const clone = { ...(root as Record<string, unknown>) };
  let cursor = clone;
  for (const segment of CARD_ARRAY_PATH.slice(0, -1)) {
    const next = cursor[segment];
    if (next === null || typeof next !== "object") return clone;
    const nextClone = { ...(next as Record<string, unknown>) };
    cursor[segment] = nextClone;
    cursor = nextClone;
  }
  delete cursor[CARD_ARRAY_PATH[CARD_ARRAY_PATH.length - 1]!];
  return clone;
}

function walkDiff(
  assetId: string | null,
  path: string,
  baseline: unknown,
  candidate: unknown,
  out: ReplayDiffEntry[],
): void {
  if (stableJsonStringifyV1(baseline) === stableJsonStringifyV1(candidate)) return;
  if (
    baseline !== null &&
    candidate !== null &&
    typeof baseline === "object" &&
    typeof candidate === "object" &&
    !Array.isArray(baseline) &&
    !Array.isArray(candidate)
  ) {
    const keys = new Set([...Object.keys(baseline), ...Object.keys(candidate)]);
    for (const key of [...keys].sort()) {
      walkDiff(
        assetId,
        `${path}.${key}`,
        (baseline as Record<string, unknown>)[key],
        (candidate as Record<string, unknown>)[key],
        out,
      );
    }
    return;
  }
  out.push({ assetId, path, baseline, candidate });
}

/**
 * Compare two `safety-score-v9-candidate-replay` artifacts after dropping the
 * volatile identity/timestamp family. Per-asset cards are matched by id so a
 * reordered or resized card array reports real drift instead of an index shift.
 */
export function diffReplayArtifacts(baseline: unknown, candidate: unknown): ReplayDiffResult {
  validateReplayCardProjection(baseline);
  validateReplayCardProjection(candidate);
  const a = stripVolatile(baseline);
  const b = stripVolatile(candidate);
  const cardsA = resolvePath(a, CARD_ARRAY_PATH);
  const cardsB = resolvePath(b, CARD_ARRAY_PATH);
  const entries: ReplayDiffEntry[] = [];
  if (!Array.isArray(cardsA) || !Array.isArray(cardsB)) throw new Error("Validated card projection disappeared");
  const byId = (cards: readonly unknown[]): Map<string, unknown> =>
    new Map(cards.map((card) => [String((card as Record<string, unknown>)[CARD_ID_FIELD]), card]));
  const mapA = byId(cardsA);
  const mapB = byId(cardsB);
  for (const id of [...new Set([...mapA.keys(), ...mapB.keys()])].sort()) {
    walkDiff(id, `cards[${id}]`, mapA.get(id), mapB.get(id), entries);
  }
  walkDiff(null, "$", stripCards(a), stripCards(b), entries);
  return { equal: entries.length === 0, entries };
}

/**
 * Grade/score projection used by the grade-stability gate. The card path and
 * the three read fields are never volatile, so this reads the artifact
 * directly instead of copying a multi-megabyte tree through `stripVolatile`.
 */
export function extractCardGrades(
  artifactValue: unknown,
): Map<string, { grade: string | null; score: number | null; ratingStatus: "rated" | "not-rated" | "pipeline-gap" }> {
  const cards = validateReplayCardProjection(artifactValue);
  const out = new Map<string, { grade: string | null; score: number | null; ratingStatus: "rated" | "not-rated" | "pipeline-gap" }>();
  for (const card of cards) {
    const row = card as Record<string, unknown>;
    const score = row[CARD_SCORE_FIELD];
    out.set(String(row[CARD_ID_FIELD]), {
      grade: row[CARD_GRADE_FIELD] === null ? null : String(row[CARD_GRADE_FIELD]),
      score: typeof score === "number" ? score : null,
      ratingStatus: row.ratingStatus === "pipeline-gap" ? "pipeline-gap" : row.ratingStatus === "not-rated" || row[CARD_GRADE_FIELD] === "NR" ? "not-rated" : "rated",
    });
  }
  return out;
}

export const MONOTONICITY_WITNESS_CODES = [
  "observation-state-regressed",
  "unknown-priced-weight-increased",
  "evidence-inventory-shrunk",
  "deployment-adjustment-dropped-on-weakening",
  "cap-removed-on-weakening",
  "unknown-credit-raised",
] as const;
export type MonotonicityWitnessCode = (typeof MONOTONICITY_WITNESS_CODES)[number];
export const MonotonicityWitnessCodeSchema = z.enum(MONOTONICITY_WITNESS_CODES);

export type MonotonicityRiseChannel =
  | "pillar-rise"
  | "deployment-adjustment-drop"
  | "cap-removed"
  | "parent-propagated"
  | "rating-status-elevated";

export type MonotonicityWitnessScope =
  | "backing"
  | "exit"
  | "control"
  | "deployment"
  | "cap"
  | "parent"
  | "asset";

export interface MonotonicityWitness {
  code: MonotonicityWitnessCode;
  scope: MonotonicityWitnessScope;
  detail: string;
}

export interface MonotonicityViolation {
  assetId: string;
  scoreBefore: number | null;
  scoreAfter: number | null;
  preCapBefore: number | null;
  preCapAfter: number | null;
  ratingStatusBefore: "rated" | "not-rated" | "pipeline-gap";
  ratingStatusAfter: "rated" | "not-rated" | "pipeline-gap";
  riseChannels: MonotonicityRiseChannel[];
  witnesses: MonotonicityWitness[];
  parentWitnesses: Array<{
    parentAssetId: string;
    witnesses: MonotonicityWitness[];
  }>;
}

type MonotonicityPillar = "backing" | "exit" | "control";
const MONOTONICITY_PILLARS: readonly MonotonicityPillar[] = ["backing", "exit", "control"];
const MONOTONICITY_EPSILON = 1e-6;

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function observationStateRank(state: unknown): number | null {
  switch (state) {
    case "known":
      return 3;
    case "bounded-unknown":
      return 2;
    case "stale":
      return 1;
    case "missing":
    case "unsupported":
      return 0;
    default:
      return null;
  }
}

function evidenceLevelRank(level: unknown): number | null {
  switch (level) {
    case "strong":
      return 2;
    case "limited":
      return 1;
    case "insufficient":
      return 0;
    default:
      return null;
  }
}

function aggregationDispositionRank(disposition: unknown): number | null {
  switch (disposition) {
    case "included":
      return 2;
    case "excluded-a-b":
      return 1;
    case "unavailable":
      return 0;
    default:
      return null;
  }
}

function ratingStatusRank(status: "rated" | "not-rated" | "pipeline-gap"): number {
  return status === "rated" ? 2 : status === "not-rated" ? 1 : 0;
}

function isUnknownComponentItem(item: Record<string, unknown>): boolean {
  const cause = item.cause;
  const disposition = item.scoringDisposition;
  const posture = typeof item.posture === "string" ? item.posture : "";
  const obs = item.observationState;
  return (
    cause === "U" ||
    cause === "C" ||
    disposition === "bounded-uncertainty" ||
    posture === "unknown" ||
    posture === "opaque-or-unknown" ||
    posture === "bounded-unknown" ||
    obs === "missing" ||
    obs === "stale" ||
    obs === "bounded-unknown" ||
    obs === "unsupported"
  );
}

/**
 * Verify both replay artifacts share an identical fixed input and carry
 * `pipeline.evaluatedSet.assets`. Throws `CliUsageError` (exit code 2) on
 * mismatch or missing evaluation traces so `--assert-monotone` fails closed.
 */
export function assertMatchingFixedInput(
  beforeArtifact: unknown,
  afterArtifact: unknown,
): { baseInputGenerationId: string; clockSec: number } {
  const beforePipeline = readRecord(readRecord(beforeArtifact)?.pipeline);
  const afterPipeline = readRecord(readRecord(afterArtifact)?.pipeline);
  const beforeFixed = readRecord(beforePipeline?.fixedInput);
  const afterFixed = readRecord(afterPipeline?.fixedInput);
  if (!beforeFixed || !afterFixed) {
    throw new CliUsageError(
      "--assert-monotone requires pipeline.fixedInput on both --before and --after replay artifacts",
    );
  }
  const beforeGen = asString(beforeFixed.baseInputGenerationId);
  const afterGen = asString(afterFixed.baseInputGenerationId);
  const beforeClock = asNumber(beforeFixed.clockSec);
  const afterClock = asNumber(afterFixed.clockSec);
  if (beforeGen === null || afterGen === null || beforeClock === null || afterClock === null) {
    throw new CliUsageError(
      "--assert-monotone requires baseInputGenerationId and clockSec on pipeline.fixedInput",
    );
  }
  if (beforeGen !== afterGen) {
    throw new CliUsageError(
      `--assert-monotone requires matching fixedInput.baseInputGenerationId (before=${beforeGen}, after=${afterGen})`,
    );
  }
  if (beforeClock !== afterClock) {
    throw new CliUsageError(
      `--assert-monotone requires matching fixedInput.clockSec (before=${beforeClock}, after=${afterClock})`,
    );
  }
  for (const field of ["fixedInputDigest", "dexPayloadFingerprint", "redemptionPayloadFingerprint", "sourceGeneration"] as const) {
    const left = asString(beforeFixed[field]);
    const right = asString(afterFixed[field]);
    if (left !== null && right !== null && left !== right) {
      throw new CliUsageError(
        `--assert-monotone requires matching fixedInput.${field} (before=${left}, after=${right})`,
      );
    }
    if ((left === null) !== (right === null) && field === "fixedInputDigest") {
      throw new CliUsageError(
        `--assert-monotone requires matching fixedInput.${field} (before=${left ?? "missing"}, after=${right ?? "missing"})`,
      );
    }
  }
  const beforeAssets = readRecord(beforePipeline?.evaluatedSet)?.assets;
  const afterAssets = readRecord(afterPipeline?.evaluatedSet)?.assets;
  if (!Array.isArray(beforeAssets) || !Array.isArray(afterAssets)) {
    throw new CliUsageError(
      "--assert-monotone requires pipeline.evaluatedSet.assets on both replay artifacts",
    );
  }
  return { baseInputGenerationId: beforeGen, clockSec: beforeClock };
}

function unknownWeightShareForPillar(evalAsset: Record<string, unknown>, pillar: MonotonicityPillar): number {
  const pillarScore = asNumber(readRecord(readRecord(readRecord(evalAsset.scoreInput)?.pillars)?.[pillar])?.score);
  if (pillar === "backing") {
    const contributions = asArray(readRecord(evalAsset.backing)?.contributions)
      .map(readRecord)
      .filter((row): row is Record<string, unknown> => row !== null);
    if (contributions.length === 0) return pillarScore !== null ? 1 : 0;
    let total = 0;
    let unknown = 0;
    for (const row of contributions) {
      const weight = asNumber(row.effectiveScoringWeight) ?? asNumber(row.weight) ?? 0;
      if (weight <= 0) continue;
      total += weight;
      if (isUnknownComponentItem(row)) unknown += weight;
    }
    return total > 0 ? unknown / total : 0;
  }
  if (pillar === "exit") {
    const exit = readRecord(evalAsset.exit);
    const routes = asArray(exit?.routes)
      .map(readRecord)
      .filter((row): row is Record<string, unknown> => row !== null);
    if (routes.length === 0) return pillarScore !== null ? 1 : 0;
    const primaryKey = asString(exit?.primaryRouteKey);
    if (primaryKey !== null) {
      const primary = routes.find((route) => asString(route.routeKey) === primaryKey);
      if (primary) return isUnknownComponentItem(primary) ? 1 : 0;
    }
    const unknownCount = routes.filter(isUnknownComponentItem).length;
    return unknownCount / routes.length;
  }
  const components = asArray(readRecord(evalAsset.control)?.components)
    .map(readRecord)
    .filter((row): row is Record<string, unknown> => row !== null);
  const binding = components.filter((component) => component.binding !== false);
  const pool = binding.length > 0 ? binding : components;
  if (pool.length === 0) return pillarScore !== null ? 1 : 0;
  const unknownCount = pool.filter(isUnknownComponentItem).length;
  return unknownCount / pool.length;
}

function knownInventoryCountForPillar(
  evalAsset: Record<string, unknown>,
  factAsset: Record<string, unknown> | null,
  pillar: MonotonicityPillar,
): { items: number; supported: number; extra: number } {
  const pillarEval = readRecord(readRecord(readRecord(evalAsset.scoreInput)?.pillars)?.[pillar]);
  const supported = asArray(pillarEval?.supportedComponentKeys).length;
  if (pillar === "backing") {
    const contributions = asArray(readRecord(evalAsset.backing)?.contributions)
      .map(readRecord)
      .filter((row): row is Record<string, unknown> => row !== null && !isUnknownComponentItem(row));
    return {
      items: contributions.length,
      supported,
      extra: factAsset ? asArray(factAsset.reserveExposures).length : 0,
    };
  }
  if (pillar === "exit") {
    const routes = asArray(readRecord(evalAsset.exit)?.routes)
      .map(readRecord)
      .filter((row): row is Record<string, unknown> => row !== null && !isUnknownComponentItem(row));
    return {
      items: routes.length,
      supported,
      extra: factAsset ? asArray(factAsset.exitRoutes).length : 0,
    };
  }
  const components = asArray(readRecord(evalAsset.control)?.components)
    .map(readRecord)
    .filter((row): row is Record<string, unknown> => row !== null && !isUnknownComponentItem(row));
  const bridgeRoutesCount = factAsset
    ? asArray(readRecord(readRecord(factAsset.economicControlReview)?.bridge)?.routes).length
    : 0;
  return {
    items: components.length,
    supported,
    extra: factAsset ? asArray(factAsset.controls).length + bridgeRoutesCount : 0,
  };
}

function collectPillarWeakeningWitnesses(
  pillar: MonotonicityPillar,
  beforeEval: Record<string, unknown>,
  afterEval: Record<string, unknown>,
  beforeFact: Record<string, unknown> | null,
  afterFact: Record<string, unknown> | null,
): MonotonicityWitness[] {
  const witnesses: MonotonicityWitness[] = [];
  const push = (code: MonotonicityWitnessCode, detail: string) => {
    if (!witnesses.some((w) => w.code === code && w.scope === pillar && w.detail === detail)) {
      witnesses.push({ code, scope: pillar, detail });
    }
  };

  const beforePillar = readRecord(readRecord(readRecord(beforeEval.scoreInput)?.pillars)?.[pillar]);
  const afterPillar = readRecord(readRecord(readRecord(afterEval.scoreInput)?.pillars)?.[pillar]);
  const beforeScore = asNumber(beforePillar?.score);
  const afterScore = asNumber(afterPillar?.score);

  // 1. observation-state-regressed (from compiled facts + pillar evidence level/disposition/causes)
  const beforeEvRank = evidenceLevelRank(beforePillar?.evidenceLevel);
  const afterEvRank = evidenceLevelRank(afterPillar?.evidenceLevel);
  if (beforeEvRank !== null && afterEvRank !== null && afterEvRank < beforeEvRank) {
    push("observation-state-regressed", `${pillar}.evidenceLevel ${String(beforePillar?.evidenceLevel)} -> ${String(afterPillar?.evidenceLevel)}`);
  }
  const beforeDispRank = aggregationDispositionRank(beforePillar?.aggregationDisposition);
  const afterDispRank = aggregationDispositionRank(afterPillar?.aggregationDisposition);
  if (beforeDispRank !== null && afterDispRank !== null && afterDispRank < beforeDispRank) {
    push("observation-state-regressed", `${pillar}.aggregationDisposition ${String(beforePillar?.aggregationDisposition)} -> ${String(afterPillar?.aggregationDisposition)}`);
  }
  const beforeLimited = new Set(asArray(beforePillar?.limitedEvidenceCauses).map(String));
  const afterLimited = asArray(afterPillar?.limitedEvidenceCauses).map(String);
  const newLimited = afterLimited.filter((cause) => (cause === "U" || cause === "C") && !beforeLimited.has(cause));
  if (newLimited.length > 0) {
    push("observation-state-regressed", `${pillar}.limitedEvidenceCauses added ${newLimited.join(",")}`);
  }
  const beforeGapCount = asArray(beforePillar?.causeGapIds).length;
  const afterGapCount = asArray(afterPillar?.causeGapIds).length;
  if (afterGapCount > beforeGapCount && afterLimited.some((c) => c === "U" || c === "C")) {
    push("observation-state-regressed", `${pillar}.causeGapIds grew ${beforeGapCount} -> ${afterGapCount}`);
  }
  if (beforeFact && afterFact) {
    const statusChecks: Array<[string, unknown, unknown]> =
      pillar === "backing"
        ? [
            ["reserveStatus", readRecord(beforeFact.reserveStatus)?.observationState, readRecord(afterFact.reserveStatus)?.observationState],
            ["peg.status", readRecord(readRecord(beforeFact.peg)?.status)?.observationState, readRecord(readRecord(afterFact.peg)?.status)?.observationState],
          ]
        : pillar === "exit"
          ? [["exitStatus", readRecord(beforeFact.exitStatus)?.observationState, readRecord(afterFact.exitStatus)?.observationState]]
          : [
              ["controlStatus", readRecord(beforeFact.controlStatus)?.observationState, readRecord(afterFact.controlStatus)?.observationState],
              ["mint.status", readRecord(readRecord(readRecord(beforeFact.economicControlReview)?.mint)?.status)?.observationState, readRecord(readRecord(readRecord(afterFact.economicControlReview)?.mint)?.status)?.observationState],
              ["oracle.status", readRecord(readRecord(readRecord(beforeFact.economicControlReview)?.oracle)?.status)?.observationState, readRecord(readRecord(readRecord(afterFact.economicControlReview)?.oracle)?.status)?.observationState],
              ["bridge.status", readRecord(readRecord(readRecord(beforeFact.economicControlReview)?.bridge)?.status)?.observationState, readRecord(readRecord(readRecord(afterFact.economicControlReview)?.bridge)?.status)?.observationState],
              ["supply.status", readRecord(readRecord(beforeFact.supply)?.status)?.observationState, readRecord(readRecord(afterFact.supply)?.status)?.observationState],
            ];
    for (const [label, left, right] of statusChecks) {
      const lr = observationStateRank(left);
      const rr = observationStateRank(right);
      if (lr !== null && rr !== null && rr < lr) {
        push("observation-state-regressed", `${label} ${String(left)} -> ${String(right)}`);
      }
    }
    if (pillar === "control") {
      const beforeBridge = readRecord(readRecord(beforeFact.economicControlReview)?.bridge);
      const afterBridge = readRecord(readRecord(afterFact.economicControlReview)?.bridge);
      if (beforeBridge?.lapsedReview !== true && afterBridge?.lapsedReview === true) {
        push("observation-state-regressed", "bridge.lapsedReview became true");
      }
      const beforeLapsedRoutes = asArray(beforeBridge?.routes).filter((r) => readRecord(r)?.lapsedReview === true).length;
      const afterLapsedRoutes = asArray(afterBridge?.routes).filter((r) => readRecord(r)?.lapsedReview === true).length;
      if (afterLapsedRoutes > beforeLapsedRoutes) {
        push("observation-state-regressed", `bridge.routes lapsedReview count grew ${beforeLapsedRoutes} -> ${afterLapsedRoutes}`);
      }
    }
  }

  // 2. unknown-priced-weight-increased
  const beforeUnknownShare = unknownWeightShareForPillar(beforeEval, pillar);
  const afterUnknownShare = unknownWeightShareForPillar(afterEval, pillar);
  if (afterUnknownShare > beforeUnknownShare + MONOTONICITY_EPSILON) {
    push("unknown-priced-weight-increased", `${pillar} unknown share ${beforeUnknownShare.toFixed(4)} -> ${afterUnknownShare.toFixed(4)}`);
  }

  // 3. evidence-inventory-shrunk
  const beforeInv = knownInventoryCountForPillar(beforeEval, beforeFact, pillar);
  const afterInv = knownInventoryCountForPillar(afterEval, afterFact, pillar);
  if (afterInv.items < beforeInv.items) {
    push("evidence-inventory-shrunk", `${pillar} known components ${beforeInv.items} -> ${afterInv.items}`);
  } else if (afterInv.supported < beforeInv.supported) {
    push("evidence-inventory-shrunk", `${pillar} supportedComponentKeys ${beforeInv.supported} -> ${afterInv.supported}`);
  } else if (beforeFact && afterFact && afterInv.extra < beforeInv.extra) {
    push("evidence-inventory-shrunk", `${pillar} compiled inventory ${beforeInv.extra} -> ${afterInv.extra}`);
  }

  // 4. unknown-credit-raised
  const listForPillar = (evalAsset: Record<string, unknown>): Array<{ key: string; row: Record<string, unknown> }> => {
    const raw =
      pillar === "backing"
        ? asArray(readRecord(evalAsset.backing)?.contributions)
        : pillar === "exit"
          ? asArray(readRecord(evalAsset.exit)?.routes)
          : asArray(readRecord(evalAsset.control)?.components);
    const keyField = pillar === "backing" ? "exposureKey" : pillar === "exit" ? "routeKey" : "componentKey";
    return raw
      .map(readRecord)
      .filter((row): row is Record<string, unknown> => row !== null)
      .map((row, idx) => ({ key: asString(row[keyField]) ?? asString(row.componentKey) ?? String(idx), row }));
  };
  const beforeUnknownByKey = new Map(
    listForPillar(beforeEval)
      .filter(({ row }) => isUnknownComponentItem(row))
      .map(({ key, row }) => [key, asNumber(row.score)]),
  );
  for (const { key, row } of listForPillar(afterEval)) {
    if (!isUnknownComponentItem(row)) continue;
    const prev = beforeUnknownByKey.get(key);
    const next = asNumber(row.score);
    if (prev !== undefined && prev !== null && next !== null && next > prev + MONOTONICITY_EPSILON) {
      push("unknown-credit-raised", `${pillar}[${key}] unknown score ${prev} -> ${next}`);
    }
  }
  if (
    beforeScore !== null &&
    afterScore !== null &&
    afterScore > beforeScore + MONOTONICITY_EPSILON &&
    afterUnknownShare > beforeUnknownShare + MONOTONICITY_EPSILON
  ) {
    push("unknown-credit-raised", `${pillar} score ${beforeScore} -> ${afterScore} under higher unknown share`);
  }

  return witnesses;
}

function sumAdjustmentPoints(trace: Record<string, unknown> | null): number {
  const rows = [
    ...asArray(trace?.deploymentAdjustments),
    ...asArray(trace?.scoreAdjustments),
  ];
  return rows.reduce<number>((sum, item) => {
    const pts = asNumber(readRecord(item)?.adjustmentPoints);
    return sum + (pts ?? 0);
  }, 0);
}

function extractUpstreamIds(evalAsset: Record<string, unknown>): string[] {
  const deps = readRecord(evalAsset.dependencyInputs);
  const ids = new Set<string>();
  for (const row of [...asArray(deps?.serial), ...asArray(deps?.basket)]) {
    const id = asString(readRecord(row)?.upstreamAssetId);
    if (id) ids.add(id);
  }
  return [...ids].sort();
}

/**
 * Detect monotonicity violations between two replay artifacts on the exact same
 * fixed input: any published score rise, preCapScore rise, or rating-status
 * elevation coupled to scoped evidence weakening in that rising channel.
 */
export function detectMonotonicityViolations(
  beforeArtifact: unknown,
  afterArtifact: unknown,
): { violations: MonotonicityViolation[]; checkedAssetCount: number; clockSec: number } {
  const { clockSec } = assertMatchingFixedInput(beforeArtifact, afterArtifact);
  validateReplayCardProjection(beforeArtifact);
  validateReplayCardProjection(afterArtifact);

  const beforeGrades = extractCardGrades(beforeArtifact);
  const afterGrades = extractCardGrades(afterArtifact);
  const beforePipeline = readRecord(readRecord(beforeArtifact)?.pipeline)!;
  const afterPipeline = readRecord(readRecord(afterArtifact)?.pipeline)!;
  const beforeEvalById = new Map<string, Record<string, unknown>>();
  for (const raw of asArray(readRecord(beforePipeline.evaluatedSet)?.assets)) {
    const row = readRecord(raw);
    const id = asString(row?.assetId);
    if (row && id) beforeEvalById.set(id, row);
  }
  const afterEvalById = new Map<string, Record<string, unknown>>();
  for (const raw of asArray(readRecord(afterPipeline.evaluatedSet)?.assets)) {
    const row = readRecord(raw);
    const id = asString(row?.assetId);
    if (row && id) afterEvalById.set(id, row);
  }
  const beforeFactById = new Map<string, Record<string, unknown>>();
  for (const raw of asArray(readRecord(beforePipeline.compiledFacts)?.assets)) {
    const row = readRecord(raw);
    const id = asString(row?.assetId);
    if (row && id) beforeFactById.set(id, row);
  }
  const afterFactById = new Map<string, Record<string, unknown>>();
  for (const raw of asArray(readRecord(afterPipeline.compiledFacts)?.assets)) {
    const row = readRecord(raw);
    const id = asString(row?.assetId);
    if (row && id) afterFactById.set(id, row);
  }

  const assetIds = [...afterEvalById.keys()].filter((id) => beforeEvalById.has(id)).sort();
  const violationsById = new Map<string, MonotonicityViolation>();
  const risingAssets = new Map<
    string,
    {
      scoreBefore: number | null;
      scoreAfter: number | null;
      preCapBefore: number | null;
      preCapAfter: number | null;
      ratingStatusBefore: "rated" | "not-rated" | "pipeline-gap";
      ratingStatusAfter: "rated" | "not-rated" | "pipeline-gap";
      upstreamIds: string[];
    }
  >();

  for (const assetId of assetIds) {
    const beforeEval = beforeEvalById.get(assetId)!;
    const afterEval = afterEvalById.get(assetId)!;
    const beforeFact = beforeFactById.get(assetId) ?? null;
    const afterFact = afterFactById.get(assetId) ?? null;
    const beforeTrace = readRecord(beforeEval.trace);
    const afterTrace = readRecord(afterEval.trace);
    const beforeCard = beforeGrades.get(assetId);
    const afterCard = afterGrades.get(assetId);

    const scoreBefore = beforeCard?.score ?? asNumber(beforeTrace?.finalScore);
    const scoreAfter = afterCard?.score ?? asNumber(afterTrace?.finalScore);
    const preCapBefore = asNumber(beforeTrace?.preCapScore);
    const preCapAfter = asNumber(afterTrace?.preCapScore);
    const ratingStatusBefore =
      beforeCard?.ratingStatus ??
      (beforeTrace?.ratingStatus === "pipeline-gap"
        ? "pipeline-gap"
        : beforeTrace?.ratingStatus === "not-rated"
          ? "not-rated"
          : "rated");
    const ratingStatusAfter =
      afterCard?.ratingStatus ??
      (afterTrace?.ratingStatus === "pipeline-gap"
        ? "pipeline-gap"
        : afterTrace?.ratingStatus === "not-rated"
          ? "not-rated"
          : "rated");

    const scoreRose = scoreBefore !== null && scoreAfter !== null && scoreAfter > scoreBefore + MONOTONICITY_EPSILON;
    const preCapRose = preCapBefore !== null && preCapAfter !== null && preCapAfter > preCapBefore + MONOTONICITY_EPSILON;
    const ratingElevated = ratingStatusRank(ratingStatusAfter) > ratingStatusRank(ratingStatusBefore);
    if (!scoreRose && !preCapRose && !ratingElevated) continue;

    risingAssets.set(assetId, {
      scoreBefore,
      scoreAfter,
      preCapBefore,
      preCapAfter,
      ratingStatusBefore,
      ratingStatusAfter,
      upstreamIds: [...new Set([...extractUpstreamIds(beforeEval), ...extractUpstreamIds(afterEval)])].sort(),
    });

    const pillarWitnesses: Record<MonotonicityPillar, MonotonicityWitness[]> = {
      backing: collectPillarWeakeningWitnesses("backing", beforeEval, afterEval, beforeFact, afterFact),
      exit: collectPillarWeakeningWitnesses("exit", beforeEval, afterEval, beforeFact, afterFact),
      control: collectPillarWeakeningWitnesses("control", beforeEval, afterEval, beforeFact, afterFact),
    };

    const channels = new Set<MonotonicityRiseChannel>();
    const witnesses: MonotonicityWitness[] = [];
    const addWitness = (witness: MonotonicityWitness) => {
      if (!witnesses.some((w) => w.code === witness.code && w.scope === witness.scope && w.detail === witness.detail)) {
        witnesses.push(witness);
      }
    };

    // Channel 1: Scoped pillar rise (only witnesses on the rising pillar count)
    for (const pillar of MONOTONICITY_PILLARS) {
      const bp = asNumber(readRecord(readRecord(readRecord(beforeEval.scoreInput)?.pillars)?.[pillar])?.score);
      const ap = asNumber(readRecord(readRecord(readRecord(afterEval.scoreInput)?.pillars)?.[pillar])?.score);
      const pillarRose =
        (bp !== null && ap !== null && ap > bp + MONOTONICITY_EPSILON) ||
        (bp === null && ap !== null);
      if (pillarRose && pillarWitnesses[pillar].length > 0) {
        channels.add("pillar-rise");
        for (const witness of pillarWitnesses[pillar]) addWitness(witness);
      }
    }

    // Channel 2: Deployment adjustment drop coupled to weakening
    const adjBefore = sumAdjustmentPoints(beforeTrace);
    const adjAfter = sumAdjustmentPoints(afterTrace);
    if ((preCapRose || scoreRose) && adjAfter < adjBefore - MONOTONICITY_EPSILON) {
      const beforeFailures = asArray(readRecord(beforeEval.control)?.structuralFailures).length;
      const afterFailures = asArray(readRecord(afterEval.control)?.structuralFailures).length;
      const beforeAdjCount = asArray(beforeTrace?.deploymentAdjustments).length + asArray(beforeTrace?.scoreAdjustments).length;
      const afterAdjCount = asArray(afterTrace?.deploymentAdjustments).length + asArray(afterTrace?.scoreAdjustments).length;
      if (pillarWitnesses.control.length > 0 || (afterFailures < beforeFailures && afterAdjCount < beforeAdjCount)) {
        channels.add("deployment-adjustment-drop");
        addWitness({
          code: "deployment-adjustment-dropped-on-weakening",
          scope: "deployment",
          detail: `deployment adjustment dropped ${adjBefore.toFixed(4)} -> ${adjAfter.toFixed(4)} while preCap rose ${String(preCapBefore)} -> ${String(preCapAfter)}`,
        });
        for (const witness of pillarWitnesses.control) addWitness(witness);
      }
    }

    // Channel 3: Binding cap removal or loosening coupled to weakening
    if (scoreRose) {
      const beforeBindingCaps = asArray(beforeTrace?.caps)
        .map(readRecord)
        .filter((cap): cap is Record<string, unknown> => cap !== null && cap.binding === true);
      const afterCaps = asArray(afterTrace?.caps)
        .map(readRecord)
        .filter((cap): cap is Record<string, unknown> => cap !== null);
      for (const cap of beforeBindingCaps) {
        const source = asString(cap.source) ?? "unknown";
        const kind = asString(cap.kind) ?? "unknown";
        const beforeLimit = asNumber(cap.limit);
        const matchingAfter = afterCaps.find(
          (candidate) => asString(candidate.source) === source && asString(candidate.kind) === kind,
        );
        const afterLimit = asNumber(matchingAfter?.limit);
        const capLoosened =
          !matchingAfter ||
          matchingAfter.binding !== true ||
          (beforeLimit !== null && afterLimit !== null && afterLimit > beforeLimit + MONOTONICITY_EPSILON);
        if (!capLoosened) continue;
        const capWeakeningWitnesses =
          source === "speculative-credit" || source === "reserve" || source === "active-depeg" || source === "track-record"
            ? pillarWitnesses.backing
            : source === "control"
              ? pillarWitnesses.control
              : [...pillarWitnesses.backing, ...pillarWitnesses.exit, ...pillarWitnesses.control];
        const pegRegressed =
          source === "active-depeg" &&
          beforeFact &&
          afterFact &&
          (observationStateRank(readRecord(readRecord(afterFact.peg)?.status)?.observationState) ?? 3) <
            (observationStateRank(readRecord(readRecord(beforeFact.peg)?.status)?.observationState) ?? 3);
        if (capWeakeningWitnesses.length > 0 || pegRegressed) {
          channels.add("cap-removed");
          addWitness({
            code: "cap-removed-on-weakening",
            scope: "cap",
            detail: `binding cap ${source}:${kind} (${String(beforeLimit)}) removed or loosened on weakening`,
          });
          for (const witness of capWeakeningWitnesses) addWitness(witness);
        }
      }
    }

    // Channel 4: Rating-status elevation coupled to weakening
    if (ratingElevated) {
      const allPillarWitnesses = [
        ...pillarWitnesses.backing,
        ...pillarWitnesses.exit,
        ...pillarWitnesses.control,
      ];
      const evidenceShrunk =
        beforeFact && afterFact && asArray(afterFact.evidence).length < asArray(beforeFact.evidence).length;
      if (allPillarWitnesses.length > 0 || evidenceShrunk) {
        channels.add("rating-status-elevated");
        for (const witness of allPillarWitnesses) addWitness(witness);
        if (evidenceShrunk) {
          addWitness({
            code: "evidence-inventory-shrunk",
            scope: "asset",
            detail: `evidence inventory shrunk ${asArray(beforeFact?.evidence).length} -> ${asArray(afterFact?.evidence).length} on status elevation ${ratingStatusBefore} -> ${ratingStatusAfter}`,
          });
        }
      }
    }

    if (witnesses.length > 0) {
      violationsById.set(assetId, {
        assetId,
        scoreBefore,
        scoreAfter,
        preCapBefore,
        preCapAfter,
        ratingStatusBefore,
        ratingStatusAfter,
        riseChannels: [...channels].sort(),
        witnesses,
        parentWitnesses: [],
      });
    }
  }

  // Channel 5: Parent-propagated rise (fixed-point propagation across dependency DAG)
  let changed = true;
  let guard = 0;
  while (changed && guard < 16) {
    changed = false;
    guard += 1;
    for (const [assetId, info] of risingAssets) {
      const parentEntries: Array<{ parentAssetId: string; witnesses: MonotonicityWitness[] }> = [];
      for (const parentId of info.upstreamIds) {
        const parentViolation = violationsById.get(parentId);
        if (!parentViolation) continue;
        const propagatedWitnesses =
          parentViolation.witnesses.length > 0
            ? parentViolation.witnesses
            : parentViolation.parentWitnesses.flatMap((entry) => entry.witnesses);
        if (propagatedWitnesses.length > 0) {
          parentEntries.push({ parentAssetId: parentId, witnesses: propagatedWitnesses });
        }
      }
      if (parentEntries.length === 0) continue;
      const existing = violationsById.get(assetId);
      if (!existing) {
        violationsById.set(assetId, {
          assetId,
          scoreBefore: info.scoreBefore,
          scoreAfter: info.scoreAfter,
          preCapBefore: info.preCapBefore,
          preCapAfter: info.preCapAfter,
          ratingStatusBefore: info.ratingStatusBefore,
          ratingStatusAfter: info.ratingStatusAfter,
          riseChannels: ["parent-propagated"],
          witnesses: parentEntries.flatMap((entry) =>
            entry.witnesses.map((w) => ({
              code: w.code,
              scope: "parent" as const,
              detail: `propagated from ${entry.parentAssetId}: ${w.detail}`,
            })),
          ),
          parentWitnesses: parentEntries,
        });
        changed = true;
      } else if (!existing.riseChannels.includes("parent-propagated")) {
        existing.riseChannels = ([...existing.riseChannels, "parent-propagated"] as MonotonicityRiseChannel[]).sort();
        existing.parentWitnesses = parentEntries;
        changed = true;
      }
    }
  }

  const violations = [...violationsById.values()].sort((a, b) => a.assetId.localeCompare(b.assetId));
  return { violations, checkedAssetCount: assetIds.length, clockSec };
}

const USAGE = `Usage: npm run safety-score-v9:diff -- --baseline <path> --candidate <path> [assertion]

Options:
  --baseline <path>          Baseline V9 replay artifact JSON (required)
  --candidate <path>         Candidate V9 replay artifact JSON (required)
  --assert-empty             Exit non-zero unless the diff is empty
  --assert-grade-stable      Exit non-zero unless every card keeps its grade
  -h, --help                 Show this help`;

const MAX_REPORTED_ENTRIES = 50;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export async function runSafetyScoreV9DiffCli(argv: readonly string[]): Promise<void> {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      baseline: { type: "string" },
      candidate: { type: "string" },
      "assert-empty": { type: "boolean" },
      "assert-grade-stable": { type: "boolean" },
    },
    conflicts: [["assert-empty", "assert-grade-stable"]],
  });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  assertCliUsage(typeof values.baseline === "string", "--baseline is required");
  assertCliUsage(typeof values.candidate === "string", "--candidate is required");

  const baseline = readJson(String(values.baseline));
  const candidate = readJson(String(values.candidate));
  const diff = diffReplayArtifacts(baseline, candidate);

  if (values["assert-empty"] === true) {
    if (diff.equal) {
      process.stdout.write("EMPTY DIFF — normalized score-output equality (activation identity checked separately)\n");
      return;
    }
    process.stderr.write(`DIFF: ${diff.entries.length} entries\n`);
    for (const entry of diff.entries.slice(0, MAX_REPORTED_ENTRIES)) {
      process.stderr.write(`${JSON.stringify(entry)}\n`);
    }
    process.exitCode = 1;
    return;
  }

  if (values["assert-grade-stable"] === true) {
    const gradesA = extractCardGrades(baseline);
    const gradesB = extractCardGrades(candidate);
    const flips: string[] = [];
    for (const [id, entry] of gradesA) {
      const other = gradesB.get(id);
      if (!other || other.grade !== entry.grade || other.ratingStatus !== entry.ratingStatus) {
        flips.push(`${id}: ${entry.grade} (${entry.ratingStatus}) -> ${other ? `${other.grade} (${other.ratingStatus})` : "MISSING"}`);
      }
    }
    for (const [id, entry] of gradesB) {
      if (!gradesA.has(id)) flips.push(`${id}: MISSING -> ${entry.grade}`);
    }
    process.stdout.write(`drift entries: ${diff.entries.length}; grade flips: ${flips.length}\n`);
    for (const flip of flips) process.stderr.write(`FLIP ${flip}\n`);
    if (flips.length > 0) process.exitCode = 1;
    return;
  }

  process.stdout.write(`${JSON.stringify({ ...diff, attribution: {
    semantics: "observed-diagnostic-changes-not-independent-point-effects",
    categories: categorizeReplayChanges(baseline, candidate),
  } }, null, 2)}\n`);
  if (!diff.equal) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void runCliEntrypoint(() => runSafetyScoreV9DiffCli(process.argv.slice(2)), {
    label: "safety-score-v9:diff",
    usage: USAGE,
  });
}
