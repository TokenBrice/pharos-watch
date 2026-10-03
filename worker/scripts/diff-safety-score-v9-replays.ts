import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  assertCliUsage,
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
  const a = stripVolatile(baseline);
  const b = stripVolatile(candidate);
  const cardsA = resolvePath(a, CARD_ARRAY_PATH);
  const cardsB = resolvePath(b, CARD_ARRAY_PATH);
  const entries: ReplayDiffEntry[] = [];
  if (!Array.isArray(cardsA) || !Array.isArray(cardsB)) {
    walkDiff(null, "$", a, b, entries);
    return { equal: entries.length === 0, entries };
  }
  const byId = (cards: readonly unknown[]): Map<string, unknown> =>
    new Map(cards.map((card) => [String((card as Record<string, unknown>)[CARD_ID_FIELD]), card]));
  const mapA = byId(cardsA);
  const mapB = byId(cardsB);
  for (const id of [...new Set([...mapA.keys(), ...mapB.keys()])].sort()) {
    walkDiff(id, `cards[${id}]`, mapA.get(id), mapB.get(id), entries);
  }
  // Diff everything outside the card array too (aggregates, dependency graph).
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
  const cards = resolvePath(artifactValue, CARD_ARRAY_PATH);
  const out = new Map<string, { grade: string | null; score: number | null; ratingStatus: "rated" | "not-rated" | "pipeline-gap" }>();
  if (!Array.isArray(cards)) return out;
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
      process.stdout.write("EMPTY DIFF — bit-identical\n");
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
