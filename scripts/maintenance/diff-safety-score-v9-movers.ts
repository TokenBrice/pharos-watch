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

const USAGE = `Usage: npm run safety-score-v9:movers -- --before <path> --after <path> [options]

Options:
  --before <path>       Baseline replay artifact (required)
  --after <path>        Candidate replay artifact (required)
  --manifest <path>     Expected-movers manifest JSON
  --json <path>         Write the machine-readable mover report here
  --markdown            Emit a Markdown table instead of text
  --assert-declared     Exit non-zero when a grade flip is not declared in the manifest
  -h, --help            Show this help`;

interface ReplayCard {
  id: string;
  score: number | null;
  grade: string;
  pillars?: Record<string, { score: number }>;
  bindingCap?: { kind: string; limit: number } | null;
  weakestPillar?: { pillar: string; score: number };
}

/** One declared mover. `score` is optional: a grade flip is the gated fact. */
interface ManifestEntry {
  id: string;
  from: string;
  to: string;
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
  gradeBefore: string;
  gradeAfter: string;
  gradeFlipped: boolean;
  pillarDeltas: Record<string, number>;
  capBefore: string | null;
  capAfter: string | null;
  declared: ManifestEntry | null;
}

function readCards(path: string): Map<string, ReplayCard> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
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
    if (scoreDelta === 0 && !gradeFlipped) continue;
    if (scoreDelta === null && a.score === b.score && !gradeFlipped) continue;
    const pillarDeltas: Record<string, number> = {};
    for (const pillar of PILLARS) {
      const bp = b.pillars?.[pillar]?.score;
      const ap = a.pillars?.[pillar]?.score;
      if (typeof bp === "number" && typeof ap === "number" && Math.abs(ap - bp) > 0.005) {
        pillarDeltas[pillar] = +(ap - bp).toFixed(2);
      }
    }
    movers.push({
      id,
      scoreBefore: b.score,
      scoreAfter: a.score,
      scoreDelta,
      gradeBefore: b.grade,
      gradeAfter: a.grade,
      gradeFlipped,
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

  const { movers, appeared, disappeared } = collectMovers(
    readCards(values.before),
    readCards(values.after),
    manifest,
  );

  const flips = movers.filter((m) => m.gradeFlipped);
  const undeclaredFlips = flips.filter((m) => m.declared === null);
  const wrongDirection = flips.filter(
    (m) => m.declared !== null && (m.declared.from !== m.gradeBefore || m.declared.to !== m.gradeAfter),
  );
  const declaredButAbsent = (manifest?.movers ?? []).filter(
    (entry) => !flips.some((m) => m.id === entry.id),
  );

  if (values.markdown === true) {
    console.log(`# Safety Score V9 movers\n`);
    console.log(
      `${movers.length} assets moved · ${flips.length} grade flips · ${undeclaredFlips.length} undeclared\n`,
    );
    console.log(`| id | score | grade | pillar deltas | binding cap | declared |`);
    console.log(`| --- | ---: | --- | --- | --- | --- |`);
    for (const m of movers) {
      const pd =
        Object.entries(m.pillarDeltas)
          .map(([p, d]) => `${p} ${d > 0 ? "+" : ""}${d}`)
          .join(", ") || "—";
      const cap = m.capBefore === m.capAfter ? (m.capAfter ?? "—") : `${m.capBefore ?? "none"} → ${m.capAfter ?? "none"}`;
      console.log(
        `| \`${m.id}\` | ${m.scoreBefore} → ${m.scoreAfter} (${(m.scoreDelta ?? 0) > 0 ? "+" : ""}${m.scoreDelta}) | ${m.gradeBefore}${m.gradeFlipped ? ` → **${m.gradeAfter}**` : ""} | ${pd} | ${cap} | ${m.declared ? `${m.declared.workstream}: ${m.declared.reason}` : m.gradeFlipped ? "**UNDECLARED**" : "n/a" } |`,
      );
    }
  } else {
    console.log(`movers: ${movers.length}  grade flips: ${flips.length}  undeclared flips: ${undeclaredFlips.length}`);
    for (const m of movers) {
      console.log(
        `  ${m.gradeFlipped ? "*" : " "} ${m.id.padEnd(34)} ${String(m.scoreBefore).padStart(5)} -> ${String(m.scoreAfter).padStart(5)}  ${m.gradeBefore} -> ${m.gradeAfter}${m.declared ? `  [${m.declared.workstream}]` : m.gradeFlipped ? "  [UNDECLARED]" : ""}`,
      );
    }
  }
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
      `${JSON.stringify({ movers, appeared, disappeared, flips: flips.length, undeclaredFlips: undeclaredFlips.length }, null, 2)}\n`,
    );
  }

  if (values["assert-declared"] === true && (undeclaredFlips.length > 0 || wrongDirection.length > 0)) {
    throw new Error(
      `expected-movers gate failed: ${undeclaredFlips.length} undeclared grade flip(s), ${wrongDirection.length} mis-declared`,
    );
  }
}

void runCliEntrypoint(main, { label: "safety-score-v9:movers", usage: USAGE });
