/**
 * Report per-asset score and grade movers between two Safety Score V9 replay
 * artifacts, and check them against an expected-movers manifest.
 *
 * The equivalence harness (`docs/process/safety-score-equivalence-harness.md`)
 * has two modes: `--assert-empty` for score-neutral refactors and
 * `--assert-grade-stable` for intentional changes that must not flip a grade.
 * A release that intentionally moves many grades fits neither. This tool adds
 * the third mode: every grade flip must be declared in a manifest, and any
 * undeclared flip fails the gate.
 *
 * Usage:
 *   npm run safety-score-v9:movers -- --before <replay.json> --after <replay.json>
 *     [--manifest <manifest.json>] [--markdown] [--json <path>] [--assert-declared]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { CliUsageError, parseStrictCliArgs, runCliEntrypoint, writeCliHelpIfRequested } from "../../scripts/lib/cli-args.mjs";
import {
  categorizeReplayChanges,
  detectMonotonicityViolations,
  diffReplayArtifacts,
  MonotonicityWitnessCodeSchema,
  type MonotonicityViolation,
  type MonotonicityWitnessCode,
  type ReplayChangeCategory,
  type ReplayDiffEntry,
} from "./diff-safety-score-v9-replays";
import { validateReplayCardProjection } from "./lib/safety-score-v9-replay-validation";
import { z } from "zod";
import { V9GradeSchema } from "@shared/types/safety-score-v9";
import { V9RatingStatusSchema } from "@shared/types/safety-score-v9-causes";
import { ReviewDateSchema } from "@shared/types/stablecoin-meta-primitives";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const USAGE = `Usage: npm run safety-score-v9:movers -- --before <path> --after <path> [options]

Options:
  --before <path>       Baseline replay artifact (required; repeatable with --after for multi-capture waiver checks)
  --after <path>        Candidate replay artifact (required; repeatable in matching pairs with --before)
  --manifest <path>     Expected-movers manifest JSON (may include strict monotonicityWaivers)
  --json <path>         Write the machine-readable mover report here
  --markdown            Emit a Markdown table instead of text
  --assert-declared     Fail on an undeclared grade/status change (implies --assert-monotone)
  --assert-monotone     Fail on any unwaived score/preCap/status rise caused by evidence weakening
  -h, --help            Show this help`;

interface ReplayCard {
  id: string;
  score: number | null;
  grade: string | null;
  ratingStatus?: "rated" | "not-rated" | "pipeline-gap";
  pillars?: Record<string, { score: number | null }>;
  bindingCap?: { kind: string; limit: number } | null;
  weakestPillar?: { pillar: string; score: number } | null;
}

/** One declared mover. `score` is optional: a grade flip is the gated fact. */
interface ManifestEntry {
  id: string;
  from: string | null;
  to: string | null;
  ratingStatusFrom?: "rated" | "not-rated" | "pipeline-gap";
  ratingStatusTo?: "rated" | "not-rated" | "pipeline-gap";
  reason: string;
  workstream: string;
}
export interface MonotonicityWaiver {
  id: string;
  workstream: string;
  reason: string;
  ownerApprovalRef: string;
  witnessCodes: readonly MonotonicityWitnessCode[];
  expiresOn: string;
}

export const MonotonicityWaiverSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .refine((id) => !id.includes("*"), {
        message: "monotonicityWaivers[].id cannot contain wildcards",
      }),
    workstream: z.string().trim().min(1),
    reason: z.string().trim().min(20),
    ownerApprovalRef: z.string().trim().min(1),
    witnessCodes: z.array(MonotonicityWitnessCodeSchema).min(1),
    expiresOn: ReviewDateSchema,
  })
  .strict();

interface Manifest {
  movers: readonly ManifestEntry[];
  monotonicityWaivers?: readonly MonotonicityWaiver[];
}

export interface Mover {
  id: string;
  scoreBefore: number | null;
  scoreAfter: number | null;
  scoreDelta: number | null;
  gradeBefore: string | null;
  gradeAfter: string | null;
  gradeFlipped: boolean;
  ratingStatusBefore: "rated" | "not-rated" | "pipeline-gap";
  ratingStatusAfter: "rated" | "not-rated" | "pipeline-gap";
  ratingStatusChanged: boolean;
  changes: ReplayDiffEntry[];
  categories: Partial<Record<ReplayChangeCategory, ReplayDiffEntry[]>>;
  pillarDeltas: Record<string, number | null>;
  capBefore: string | null;
  capAfter: string | null;
  declared: ManifestEntry | null;
}

function readCards(parsed: unknown, _path: string): Map<string, ReplayCard> {
  return new Map(validateReplayCardProjection(parsed).map(card => [card.id, card as ReplayCard]));
}

export function parseMoverManifest(value: unknown): Manifest {
  const manifest = z.object({
    movers: z.array(z.object({
      id: z.string().trim().min(1),
      from: V9GradeSchema.nullable(),
      to: V9GradeSchema.nullable(),
      ratingStatusFrom: V9RatingStatusSchema.optional(),
      ratingStatusTo: V9RatingStatusSchema.optional(),
      reason: z.string().trim().min(1),
      workstream: z.string().trim().min(1),
    }).strict()),
    monotonicityWaivers: z.array(MonotonicityWaiverSchema).optional(),
  }).strict().parse(value);
  const seen = new Set<string>();
  for (const entry of manifest.movers) {
    if (seen.has(entry.id)) throw new Error(`Duplicate mover declaration: ${entry.id}`);
    seen.add(entry.id);
    const status = (grade: string | null) => grade === null ? "pipeline-gap" : grade === "NR" ? "not-rated" : "rated";
    if ((entry.ratingStatusFrom !== undefined && entry.ratingStatusFrom !== status(entry.from)) ||
      (entry.ratingStatusTo !== undefined && entry.ratingStatusTo !== status(entry.to)) ||
      (entry.from === entry.to && entry.ratingStatusFrom === entry.ratingStatusTo)) {
      throw new Error(`Invalid mover transition: ${entry.id}`);
    }
  }
  const seenWaivers = new Set<string>();
  for (const waiver of manifest.monotonicityWaivers ?? []) {
    if (seenWaivers.has(waiver.id)) throw new Error(`Duplicate monotonicity waiver: ${waiver.id}`);
    seenWaivers.add(waiver.id);
  }
  return manifest;
}

export interface MonotonicityGateOutcome {
  clockDate: string;
  violations: readonly MonotonicityViolation[];
  waivedViolations: MonotonicityViolation[];
  unwaivedViolations: MonotonicityViolation[];
  usedWaiverIds: string[];
  unusedWaiverIds: string[];
  expiredWaiverIds: string[];
}

export function evaluateMonotonicityGate(
  violations: readonly MonotonicityViolation[],
  manifest: Manifest | null,
  clockSec: number,
): MonotonicityGateOutcome {
  const clockDate = new Date(clockSec * 1_000).toISOString().slice(0, 10);
  const waivers = manifest?.monotonicityWaivers ?? [];
  const activeWaiversById = new Map<string, MonotonicityWaiver>();
  const expiredWaiverIds: string[] = [];
  for (const waiver of waivers) {
    if (waiver.expiresOn < clockDate) {
      expiredWaiverIds.push(waiver.id);
    } else {
      activeWaiversById.set(waiver.id, waiver);
    }
  }
  const usedWaiverIds = new Set<string>();
  const waivedViolations: MonotonicityViolation[] = [];
  const unwaivedViolations: MonotonicityViolation[] = [];
  for (const violation of violations) {
    const waiver = activeWaiversById.get(violation.assetId);
    const witnessCodes = new Set(violation.witnesses.map((w) => w.code));
    const coversAll =
      waiver !== undefined &&
      witnessCodes.size > 0 &&
      [...witnessCodes].every((code) => waiver.witnessCodes.includes(code));
    if (coversAll) {
      usedWaiverIds.add(waiver.id);
      waivedViolations.push(violation);
    } else {
      unwaivedViolations.push(violation);
    }
  }
  const unusedWaiverIds = waivers
    .filter((waiver) => !expiredWaiverIds.includes(waiver.id) && !usedWaiverIds.has(waiver.id))
    .map((waiver) => waiver.id)
    .sort();
  return {
    clockDate,
    violations,
    waivedViolations,
    unwaivedViolations,
    usedWaiverIds: [...usedWaiverIds].sort(),
    unusedWaiverIds,
    expiredWaiverIds: expiredWaiverIds.sort(),
  };
}

export interface MultiCaptureMonotonicityGateOutcome {
  captures: MonotonicityGateOutcome[];
  unwaivedViolationCount: number;
  usedWaiverIds: string[];
  unusedWaiverIds: string[];
  expiredWaiverIds: string[];
}

/**
 * Evaluate a shared waiver manifest across one or more capture pairs.
 * A waiver counts as used if any capture in the run triggered it; expiry is
 * checked against every capture clock, and single-pair runs remain strictly
 * per-pair.
 */
export function evaluateMultiCaptureMonotonicityGate(
  captures: readonly { violations: readonly MonotonicityViolation[]; clockSec: number }[],
  manifest: Manifest | null,
): MultiCaptureMonotonicityGateOutcome {
  const outcomes = captures.map((capture) => evaluateMonotonicityGate(capture.violations, manifest, capture.clockSec));
  const usedWaiverIds = new Set(outcomes.flatMap((outcome) => outcome.usedWaiverIds));
  const expiredWaiverIds = new Set(outcomes.flatMap((outcome) => outcome.expiredWaiverIds));
  const unusedWaiverIds = (manifest?.monotonicityWaivers ?? [])
    .filter((waiver) => !expiredWaiverIds.has(waiver.id) && !usedWaiverIds.has(waiver.id))
    .map((waiver) => waiver.id)
    .sort();
  return {
    captures: outcomes,
    unwaivedViolationCount: outcomes.reduce((sum, outcome) => sum + outcome.unwaivedViolations.length, 0),
    usedWaiverIds: [...usedWaiverIds].sort(),
    unusedWaiverIds,
    expiredWaiverIds: [...expiredWaiverIds].sort(),
  };
}

const PILLARS = ["backing", "exit", "control"] as const;


export function collectMovers(
  before: Map<string, ReplayCard>,
  after: Map<string, ReplayCard>,
  manifest: Manifest | null,
): { movers: Mover[]; appeared: string[]; disappeared: string[] } {
  if (manifest !== null) manifest = parseMoverManifest(manifest);
  for (const cards of [before, after]) {
    validateReplayCardProjection({ pipeline: { candidate: { cards: [...cards.values()] } } });
    for (const [id, card] of cards) if (id !== card.id) throw new Error(`Card map key differs from ID: ${id}`);
  }
  const declaredById = new Map((manifest?.movers ?? []).map((m) => [m.id, m]));
  const movers: Mover[] = [];
  for (const [id, a] of after) {
    const b = before.get(id);
    if (!b) continue;
    const scoreDelta = a.score === null || b.score === null ? null : +(a.score - b.score).toFixed(2);
    const gradeFlipped = a.grade !== b.grade;
    const ratingStatusBefore = b.ratingStatus ?? (b.grade === null ? "pipeline-gap" : b.grade === "NR" ? "not-rated" : "rated");
    const ratingStatusAfter = a.ratingStatus ?? (a.grade === null ? "pipeline-gap" : a.grade === "NR" ? "not-rated" : "rated");
    const ratingStatusChanged = ratingStatusBefore !== ratingStatusAfter;
    const baseline = { pipeline: { candidate: { cards: [b] } } };
    const candidate = { pipeline: { candidate: { cards: [a] } } };
    const changes = diffReplayArtifacts(baseline, candidate).entries;
    if (changes.length === 0) continue;
    const categories = Object.fromEntries(Object.entries(categorizeReplayChanges(baseline, candidate)).filter(([, entries]) => entries.length > 0));
    const pillarDeltas: Record<string, number | null> = {};
    for (const pillar of PILLARS) {
      const bp = b.pillars?.[pillar]?.score;
      const ap = a.pillars?.[pillar]?.score;
      if (typeof bp === "number" && typeof ap === "number" && Math.abs(ap - bp) > 0.005) {
        pillarDeltas[pillar] = +(ap - bp).toFixed(2);
      }
      if (bp !== ap && (bp === null || ap === null)) pillarDeltas[pillar] = null;
    }
    movers.push({
      id,
      scoreBefore: b.score,
      scoreAfter: a.score,
      scoreDelta,
      gradeBefore: b.grade,
      gradeAfter: a.grade,
      gradeFlipped,
      ratingStatusBefore,
      ratingStatusAfter,
      ratingStatusChanged,
      changes,
      categories,
      pillarDeltas,
      capBefore: b.bindingCap?.kind ?? null,
      capAfter: a.bindingCap?.kind ?? null,
      declared: declaredById.get(id) ?? null,
    });
  }
  movers.sort(
    (x, y) =>
      Math.abs(y.scoreDelta ?? 0) - Math.abs(x.scoreDelta ?? 0) || x.id.localeCompare(y.id),
  );
  return {
    movers,
    appeared: [...after.keys()].filter((id) => !before.has(id)).sort(),
    disappeared: [...before.keys()].filter((id) => !after.has(id)).sort(),
  };
}

async function main(): Promise<void> {
  const { values } = parseStrictCliArgs(process.argv.slice(2), {
    options: {
      before: { type: "string", multiple: true },
      after: { type: "string", multiple: true },
      manifest: { type: "string" },
      json: { type: "string" },
      markdown: { type: "boolean" },
      "assert-declared": { type: "boolean" },
      "assert-monotone": { type: "boolean" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  const beforePaths = Array.isArray(values.before) ? values.before.map(String) : [];
  const afterPaths = Array.isArray(values.after) ? values.after.map(String) : [];
  if (beforePaths.length === 0) throw new CliUsageError("--before is required");
  if (afterPaths.length === 0) throw new CliUsageError("--after is required");
  if (beforePaths.length !== afterPaths.length) {
    throw new CliUsageError(`--before (${beforePaths.length}) and --after (${afterPaths.length}) must be supplied in matching pairs`);
  }

  const manifest =
    typeof values.manifest === "string"
      ? parseMoverManifest(JSON.parse(readFileSync(values.manifest, "utf8")))
      : null;

  const assertMonotone = values["assert-monotone"] === true || values["assert-declared"] === true;
  const pairRuns = beforePaths.map((beforePath, index) => {
    const afterPath = afterPaths[index]!;
    const beforeArtifact: unknown = JSON.parse(readFileSync(beforePath, "utf8"));
    const afterArtifact: unknown = JSON.parse(readFileSync(afterPath, "utf8"));
    const monotonicityResult = assertMonotone
      ? detectMonotonicityViolations(beforeArtifact, afterArtifact)
      : null;
    const artifactCategories = categorizeReplayChanges(beforeArtifact, afterArtifact);
    const { movers, appeared, disappeared } = collectMovers(
      readCards(beforeArtifact, beforePath),
      readCards(afterArtifact, afterPath),
      manifest,
    );
    const flips = movers.filter((m) => m.gradeFlipped || m.ratingStatusChanged);
    const undeclaredFlips = flips.filter((m) => m.declared === null);
    const wrongDirection = flips.filter(
      (m) => m.declared !== null && (m.declared.from !== m.gradeBefore || m.declared.to !== m.gradeAfter ||
        (m.declared.ratingStatusFrom !== undefined && m.declared.ratingStatusFrom !== m.ratingStatusBefore) ||
        (m.declared.ratingStatusTo !== undefined && m.declared.ratingStatusTo !== m.ratingStatusAfter)),
    );
    const declaredButAbsent = (manifest?.movers ?? []).filter(
      (entry) => !flips.some((m) => m.id === entry.id),
    );
    return {
      beforePath,
      afterPath,
      monotonicityResult,
      artifactCategories,
      movers,
      appeared,
      disappeared,
      flips,
      undeclaredFlips,
      wrongDirection,
      declaredButAbsent,
    };
  });

  const multiMonotonicity = assertMonotone
    ? evaluateMultiCaptureMonotonicityGate(
        pairRuns.map((run) => ({
          violations: run.monotonicityResult!.violations,
          clockSec: run.monotonicityResult!.clockSec,
        })),
        manifest,
      )
    : null;

  const pairGates = pairRuns.map((run, index) => {
    const captureGate = multiMonotonicity ? multiMonotonicity.captures[index]! : null;
    const monotonicityGate = captureGate === null
      ? null
      : {
          checkedAssetCount: run.monotonicityResult!.checkedAssetCount,
          ...captureGate,
        };
    if (pairRuns.length > 1) {
      console.log(`\n=== Capture pair ${index + 1}/${pairRuns.length}: ${run.beforePath} -> ${run.afterPath} ===`);
    }
    if (values.markdown === true) {
      console.log(`# Safety Score V9 movers\n`);
      console.log(
        `${run.movers.length} assets moved · ${run.flips.length} grade/status changes · ${run.undeclaredFlips.length} undeclared\n`,
      );
      console.log(`| id | score | grade | rating status | pillar deltas | binding cap | categories | declared |`);
      console.log(`| --- | ---: | --- | --- | --- | --- | --- | --- |`);
      for (const m of run.movers) {
        const pd =
          Object.entries(m.pillarDeltas)
            .map(([p, d]) => `${p} ${d === null ? "availability transition" : `${d > 0 ? "+" : ""}${d}`}`)
            .join(", ") || "—";
        const cap = m.capBefore === m.capAfter ? (m.capAfter ?? "—") : `${m.capBefore ?? "none"} → ${m.capAfter ?? "none"}`;
        console.log(
          `| \`${m.id}\` | ${m.scoreBefore ?? "—"} → ${m.scoreAfter ?? "—"} (${m.scoreDelta ?? "—"}) | ${m.gradeBefore ?? "—"} → ${m.gradeAfter ?? "—"} | ${m.ratingStatusBefore} → ${m.ratingStatusAfter} | ${pd} | ${cap} | ${Object.keys(m.categories).join(", ") || "other diagnostics"} | ${m.declared ? `${m.declared.workstream}: ${m.declared.reason}` : m.gradeFlipped || m.ratingStatusChanged ? "**UNDECLARED**" : "n/a" } |`,
        );
      }
    } else {
      console.log(`movers: ${run.movers.length}  grade flips: ${run.flips.length}  undeclared flips: ${run.undeclaredFlips.length}`);
      for (const m of run.movers) {
        console.log(
          `  ${m.gradeFlipped || m.ratingStatusChanged ? "*" : " "} ${m.id.padEnd(34)} ${String(m.scoreBefore).padStart(5)} -> ${String(m.scoreAfter).padStart(5)}  ${m.gradeBefore} -> ${m.gradeAfter}  ${m.ratingStatusBefore} -> ${m.ratingStatusAfter}  [${Object.keys(m.categories).join(", ") || "other diagnostics"}]${m.declared ? `  [${m.declared.workstream}]` : m.gradeFlipped || m.ratingStatusChanged ? "  [UNDECLARED]" : ""}`,
        );
      }
    }
    const categoryCounts = Object.entries(run.artifactCategories).map(([category, rows]) => `${category}: ${rows.length}`).join(", ");
    console.log(`\nObserved diagnostic categories (not independent point effects): ${categoryCounts}`);
    if (monotonicityGate !== null) {
      const displayUnusedCount = pairRuns.length === 1 ? monotonicityGate.unusedWaiverIds.length : 0;
      console.log(
        `\nMonotonicity guard: checked=${monotonicityGate.checkedAssetCount} violations=${monotonicityGate.violations.length} waived=${monotonicityGate.waivedViolations.length} unwaived=${monotonicityGate.unwaivedViolations.length} expiredWaivers=${monotonicityGate.expiredWaiverIds.length}${pairRuns.length === 1 ? ` unusedWaivers=${displayUnusedCount}` : ""}`,
      );
      for (const v of monotonicityGate.unwaivedViolations) {
        console.log(
          `  MONOTONICITY VIOLATION ${v.assetId}: score ${v.scoreBefore}->${v.scoreAfter} preCap ${v.preCapBefore}->${v.preCapAfter} channels=[${v.riseChannels.join(",")}] witnesses=[${v.witnesses.map((w) => `${w.scope}:${w.code}`).join(",")}]`,
        );
      }
      if (monotonicityGate.expiredWaiverIds.length > 0) {
        console.log(`  expired monotonicity waivers (clock ${monotonicityGate.clockDate}): ${monotonicityGate.expiredWaiverIds.join(", ")}`);
      }
      if (pairRuns.length === 1 && monotonicityGate.unusedWaiverIds.length > 0) {
        console.log(`  unused monotonicity waivers: ${monotonicityGate.unusedWaiverIds.join(", ")}`);
      }
    }
    if (run.appeared.length > 0) console.log(`\nassets only in --after: ${run.appeared.join(", ")}`);
    if (run.disappeared.length > 0) console.log(`assets only in --before: ${run.disappeared.join(", ")}`);
    if (run.declaredButAbsent.length > 0) {
      console.log(`\ndeclared in manifest but did not flip: ${run.declaredButAbsent.map((e) => e.id).join(", ")}`);
    }
    if (run.wrongDirection.length > 0) {
      console.log(
        `\nflipped differently than declared:\n${run.wrongDirection.map((m) => `  ${m.id}: declared ${m.declared?.from}->${m.declared?.to}, observed ${m.gradeBefore}->${m.gradeAfter}`).join("\n")}`,
      );
    }
    return monotonicityGate;
  });

  if (pairRuns.length > 1 && multiMonotonicity !== null && multiMonotonicity.unusedWaiverIds.length > 0) {
    console.log(`\nunused monotonicity waivers across all ${pairRuns.length} capture pairs: ${multiMonotonicity.unusedWaiverIds.join(", ")}`);
  }

  if (typeof values.json === "string") {
    if (pairRuns.length === 1) {
      const run = pairRuns[0]!;
      const monotonicityGate = pairGates[0]!;
      writeFileSync(
        values.json,
        `${JSON.stringify({
          attributionSemantics: "observed-diagnostic-changes-not-independent-point-effects",
          artifactCategories: run.artifactCategories,
          movers: run.movers,
          appeared: run.appeared,
          disappeared: run.disappeared,
          flips: run.flips.length,
          undeclaredFlips: run.undeclaredFlips.length,
          ...(monotonicityGate === null ? {} : { monotonicity: monotonicityGate }),
        }, null, 2)}\n`,
      );
    } else {
      writeFileSync(
        values.json,
        `${JSON.stringify({
          attributionSemantics: "observed-diagnostic-changes-not-independent-point-effects",
          captures: pairRuns.map((run, index) => ({
            before: run.beforePath,
            after: run.afterPath,
            artifactCategories: run.artifactCategories,
            movers: run.movers,
            appeared: run.appeared,
            disappeared: run.disappeared,
            flips: run.flips.length,
            undeclaredFlips: run.undeclaredFlips.length,
            ...(pairGates[index] === null ? {} : { monotonicity: pairGates[index] }),
          })),
          ...(multiMonotonicity === null ? {} : {
            monotonicitySummary: {
              unwaivedViolationCount: multiMonotonicity.unwaivedViolationCount,
              usedWaiverIds: multiMonotonicity.usedWaiverIds,
              unusedWaiverIds: multiMonotonicity.unusedWaiverIds,
              expiredWaiverIds: multiMonotonicity.expiredWaiverIds,
            },
          }),
        }, null, 2)}\n`,
      );
    }
  }

  const gateErrors: string[] = [];
  if (values["assert-declared"] === true) {
    const totalUndeclared = pairRuns.reduce((sum, run) => sum + run.undeclaredFlips.length, 0);
    const totalWrong = pairRuns.reduce((sum, run) => sum + run.wrongDirection.length, 0);
    if (totalUndeclared > 0 || totalWrong > 0) {
      gateErrors.push(
        `expected-movers gate failed: ${totalUndeclared} undeclared grade/status change(s), ${totalWrong} mis-declared`,
      );
    }
  }
  if (
    multiMonotonicity !== null &&
    (multiMonotonicity.unwaivedViolationCount > 0 ||
      multiMonotonicity.expiredWaiverIds.length > 0 ||
      multiMonotonicity.unusedWaiverIds.length > 0)
  ) {
    gateErrors.push(
      `monotonicity gate failed: ${multiMonotonicity.unwaivedViolationCount} unwaived violation(s), ${multiMonotonicity.expiredWaiverIds.length} expired waiver(s), ${multiMonotonicity.unusedWaiverIds.length} unused waiver(s)`,
    );
  }
  if (gateErrors.length > 0) {
    throw new Error(gateErrors.join("; "));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runCliEntrypoint(main, { label: "safety-score-v9:movers", usage: USAGE });
}
