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
import { parseStrictCliArgs, runCliEntrypoint, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import { categorizeReplayChanges, diffReplayArtifacts, type ReplayChangeCategory, type ReplayDiffEntry } from "../../worker/scripts/diff-safety-score-v9-replays";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const USAGE = `Usage: npm run safety-score-v9:movers -- --before <path> --after <path> [options]

Options:
  --before <path>       Baseline replay artifact (required)
  --after <path>        Candidate replay artifact (required)
  --manifest <path>     Expected-movers manifest JSON
  --json <path>         Write the machine-readable mover report here
  --markdown            Emit a Markdown table instead of text
  --assert-declared     Fail on an undeclared grade or availability-status change
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
interface Manifest {
  movers: readonly ManifestEntry[];
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

function readCards(parsed: unknown, path: string): Map<string, ReplayCard> {
  if (parsed === null || typeof parsed !== "object" || !("pipeline" in parsed)) {
    throw new Error(`${path}: not a replay artifact (no pipeline key)`);
  }
  const pipeline = parsed.pipeline;
  if (pipeline === null || typeof pipeline !== "object" || !("candidate" in pipeline)) {
    throw new Error(`${path}: replay artifact has no pipeline.candidate`);
  }
  const candidate = pipeline.candidate;
  if (candidate === null || typeof candidate !== "object" || !("cards" in candidate)) {
    throw new Error(`${path}: replay artifact has no pipeline.candidate.cards`);
  }
  const cards = candidate.cards;
  if (!Array.isArray(cards)) throw new Error(`${path}: pipeline.candidate.cards is not an array`);
  const byId = new Map<string, ReplayCard>();
  for (const card of cards as ReplayCard[]) byId.set(card.id, card);
  return byId;
}

const PILLARS = ["backing", "exit", "control"] as const;


export function collectMovers(
  before: Map<string, ReplayCard>,
  after: Map<string, ReplayCard>,
  manifest: Manifest | null,
): { movers: Mover[]; appeared: string[]; disappeared: string[] } {
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
      before: { type: "string" },
      after: { type: "string" },
      manifest: { type: "string" },
      json: { type: "string" },
      markdown: { type: "boolean" },
      "assert-declared": { type: "boolean" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  if (typeof values.before !== "string") throw new Error("--before is required");
  if (typeof values.after !== "string") throw new Error("--after is required");

  const manifest =
    typeof values.manifest === "string"
      ? (JSON.parse(readFileSync(values.manifest, "utf8")) as Manifest)
      : null;

  const beforeArtifact: unknown = JSON.parse(readFileSync(values.before, "utf8"));
  const afterArtifact: unknown = JSON.parse(readFileSync(values.after, "utf8"));
  const artifactCategories = categorizeReplayChanges(beforeArtifact, afterArtifact);
  const { movers, appeared, disappeared } = collectMovers(
    readCards(beforeArtifact, values.before),
    readCards(afterArtifact, values.after),
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

  if (values.markdown === true) {
    console.log(`# Safety Score V9 movers\n`);
    console.log(
      `${movers.length} assets moved · ${flips.length} grade/status changes · ${undeclaredFlips.length} undeclared\n`,
    );
    console.log(`| id | score | grade | rating status | pillar deltas | binding cap | categories | declared |`);
    console.log(`| --- | ---: | --- | --- | --- | --- | --- | --- |`);
    for (const m of movers) {
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
    console.log(`movers: ${movers.length}  grade flips: ${flips.length}  undeclared flips: ${undeclaredFlips.length}`);
    for (const m of movers) {
      console.log(
        `  ${m.gradeFlipped || m.ratingStatusChanged ? "*" : " "} ${m.id.padEnd(34)} ${String(m.scoreBefore).padStart(5)} -> ${String(m.scoreAfter).padStart(5)}  ${m.gradeBefore} -> ${m.gradeAfter}  ${m.ratingStatusBefore} -> ${m.ratingStatusAfter}  [${Object.keys(m.categories).join(", ") || "other diagnostics"}]${m.declared ? `  [${m.declared.workstream}]` : m.gradeFlipped || m.ratingStatusChanged ? "  [UNDECLARED]" : ""}`,
      );
    }
  }
  const categoryCounts = Object.entries(artifactCategories).map(([category, rows]) => `${category}: ${rows.length}`).join(", ");
  console.log(`\nObserved diagnostic categories (not independent point effects): ${categoryCounts}`);
  if (appeared.length > 0) console.log(`\nassets only in --after: ${appeared.join(", ")}`);
  if (disappeared.length > 0) console.log(`assets only in --before: ${disappeared.join(", ")}`);
  if (declaredButAbsent.length > 0) {
    console.log(`\ndeclared in manifest but did not flip: ${declaredButAbsent.map((e) => e.id).join(", ")}`);
  }
  if (wrongDirection.length > 0) {
    console.log(
      `\nflipped differently than declared:\n${wrongDirection.map((m) => `  ${m.id}: declared ${m.declared?.from}->${m.declared?.to}, observed ${m.gradeBefore}->${m.gradeAfter}`).join("\n")}`,
    );
  }

  if (typeof values.json === "string") {
    writeFileSync(
      values.json,
      `${JSON.stringify({ attributionSemantics: "observed-diagnostic-changes-not-independent-point-effects", artifactCategories, movers, appeared, disappeared, flips: flips.length, undeclaredFlips: undeclaredFlips.length }, null, 2)}\n`,
    );
  }

  if (values["assert-declared"] === true && (undeclaredFlips.length > 0 || wrongDirection.length > 0)) {
    throw new Error(
      `expected-movers gate failed: ${undeclaredFlips.length} undeclared grade/status change(s), ${wrongDirection.length} mis-declared`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runCliEntrypoint(main, { label: "safety-score-v9:movers", usage: USAGE });
}
