#!/usr/bin/env tsx
/* eslint-disable security/detect-non-literal-regexp, security/detect-unsafe-regex */
/**
 * Detects AI editorial summaries whose baked-in scores/grades have drifted
 * away from live Pharos data, and writes an editorial refresh queue.
 *
 * Many summaries in `data/ai-summaries.json` hard-code claims the reader can
 * verify against the hero card and report card on the same page — an overall
 * safety grade ("the A- at 82"), a DEWS band ("in the Calm band"), a peg
 * score, dimension grades ("a D in dependency risk"), or a depeg-event count.
 * Those drift as the live scoring updates, leaving the prose contradicting the
 * dashboard right next to it. This producer extracts each such claim, compares
 * it to the current value, and writes the mismatches to
 * `agents/ai-summary-candidates.{md,json}` under the gitignored `agents/`
 * scratch folder. It never edits summaries — the rewrite is editorial and is
 * driven by the `write-ai-summaries` skill.
 *
 * Live data comes from three public endpoints (report-cards, stress-signals,
 * peg-summary). Default base is production; override with PHAROS_API_BASE and
 * authenticate with PHAROS_API_KEY. Pass `--fixtures <dir>` to read
 * pre-fetched `<endpoint>.json` files instead of hitting the network.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = process.cwd();
const SUMMARIES_PATH = resolve(ROOT, "data/ai-summaries.json");
const OUTPUT_MD = resolve(ROOT, "agents/ai-summary-candidates.md");
const OUTPUT_JSON = resolve(ROOT, "agents/ai-summary-candidates.json");
const API_BASE = (process.env.PHAROS_API_BASE ?? "https://api.pharos.watch").replace(/\/$/, "");
const API_KEY = process.env.PHAROS_API_KEY?.trim() || null;
const FETCH_TIMEOUT_MS = 30_000;

const FIXTURES_DIR = (() => {
  const i = process.argv.indexOf("--fixtures");
  return i !== -1 ? resolve(process.cwd(), process.argv[i + 1] ?? "") : null;
})();

// --- types ------------------------------------------------------------------

type Severity = "high" | "medium" | "low";

interface Current {
  name: string;
  symbol: string;
  overallGrade: string | null;
  overallScore: number | null;
  pegGrade: string | null;
  pegScore: number | null;
  liquidityScore: number | null;
  resilienceGrade: string | null;
  decentralizationGrade: string | null;
  dependencyGrade: string | null;
  dewsBand: string | null;
  dewsScore: number | null;
  depegCount: number | null;
}

interface ReportCardDimension {
  grade?: string | null;
  score?: number | null;
}

interface ReportCardRow {
  id: string;
  name?: string | null;
  symbol?: string | null;
  overallGrade?: string | null;
  overallScore?: number | null;
  dimensions?: {
    pegStability?: ReportCardDimension | null;
    liquidity?: ReportCardDimension | null;
    resilience?: ReportCardDimension | null;
    decentralization?: ReportCardDimension | null;
    dependencyRisk?: ReportCardDimension | null;
  } | null;
}

interface StressRow {
  band?: string | null;
  score?: number | null;
}

interface PegRow {
  id: string;
  eventCount?: number | null;
}

interface Finding {
  kind: string;
  claim: string; // verbatim matched phrase
  claimed: string;
  current: string;
  severity: Severity;
}

interface Candidate {
  id: string;
  name: string;
  symbol: string;
  updatedAt: string;
  factsAsOf: string | null;
  maxSeverity: Severity;
  findings: Finding[];
}

// --- grade vocabulary -------------------------------------------------------

const GRADES = ["A+", "A-", "A", "B+", "B-", "B", "C+", "C-", "C", "D+", "D-", "D", "F"];
// alternation ordered so multi-char grades (A+, A-) win over the bare letter
const GRADE_ALT = GRADES.map((g) => g.replace("+", "\\+")).join("|");
// A grade token is bounded by non-alphanumerics, not \b — \b breaks on the
// trailing +/- of "A-"/"B+" and silently falls back to the bare letter.
const GRADE_TOKEN = `(?<![A-Za-z0-9])(${GRADE_ALT})(?![A-Za-z0-9])`;
// Letter grades are always uppercase on the dashboard; prose articles ("a",
// "an") are not. Reject any captured grade that is not an exact uppercase grade
// so the indefinite article never reads as an "A".
const isGrade = (s: string): boolean => GRADES.includes(s);
const DEWS_BANDS = ["calm", "watch", "alert", "warning", "danger"];
const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

function baseLetter(grade: string): string {
  return grade.charAt(0).toUpperCase();
}

function parseCount(raw: string): number | null {
  const cleaned = raw.replace(/,/g, "").trim().toLowerCase();
  if (cleaned in NUMBER_WORDS) return NUMBER_WORDS[cleaned];
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// --- live data --------------------------------------------------------------

async function fetchJson(endpoint: string): Promise<unknown> {
  if (FIXTURES_DIR) {
    return JSON.parse(readFileSync(resolve(FIXTURES_DIR, `${endpoint}.json`), "utf8"));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/api/${endpoint}`, {
      headers: API_KEY ? { "X-API-Key": API_KEY, accept: "application/json" } : { accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`GET /api/${endpoint} -> ${res.status} ${(await res.text()).slice(0, 160)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function loadCurrent(): Promise<Map<string, Current>> {
  const [cardsRaw, stressRaw, pegRaw] = await Promise.all([
    fetchJson("report-cards"),
    fetchJson("stress-signals"),
    fetchJson("peg-summary"),
  ]);

  const cards = (cardsRaw as { cards?: ReportCardRow[] }).cards ?? [];
  const stress = (stressRaw as { signals?: Record<string, StressRow> }).signals ?? {};
  const peg = (pegRaw as { coins?: PegRow[] }).coins ?? [];
  const pegById = new Map(peg.map((c) => [c.id, c]));

  const map = new Map<string, Current>();
  for (const card of cards) {
    const d = card.dimensions ?? {};
    const dews = stress[card.id];
    const pegRow = pegById.get(card.id);
    map.set(card.id, {
      name: card.name ?? card.id,
      symbol: card.symbol ?? "",
      overallGrade: card.overallGrade ?? null,
      overallScore: typeof card.overallScore === "number" ? card.overallScore : null,
      pegGrade: d.pegStability?.grade ?? null,
      pegScore: typeof d.pegStability?.score === "number" ? d.pegStability.score : null,
      liquidityScore: typeof d.liquidity?.score === "number" ? d.liquidity.score : null,
      resilienceGrade: d.resilience?.grade ?? null,
      decentralizationGrade: d.decentralization?.grade ?? null,
      dependencyGrade: d.dependencyRisk?.grade ?? null,
      dewsBand: dews?.band ?? null,
      dewsScore: typeof dews?.score === "number" ? dews.score : null,
      depegCount: typeof pegRow?.eventCount === "number" ? pegRow.eventCount : null,
    });
  }
  return map;
}

// --- claim extraction -------------------------------------------------------

/** Normalize unicode dashes and whitespace so regexes stay simple. */
function normalize(text: string): string {
  return text
    .replace(/\{\{\/?term:?[a-z0-9-]*\}\}/gi, "") // strip glossary markup
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ");
}

function gradeFinding(
  kind: string,
  claim: string,
  claimed: string,
  current: string | null,
  opts: { dimension?: boolean } = {},
): Finding | null {
  if (!current || !isGrade(claimed)) return null;
  if (claimed === current) return null;
  // A base-letter change (A vs B) is loud; a modifier-only change (A vs A-) is
  // milder but still a printed contradiction with the hero/report card.
  const sameBase = baseLetter(claimed) === baseLetter(current);
  const severity: Severity = opts.dimension
    ? sameBase
      ? "low"
      : "medium"
    : sameBase
      ? "medium"
      : "high";
  return { kind, claim, claimed, current, severity };
}

function scoreFinding(
  kind: string,
  claim: string,
  claimed: number,
  current: number | null,
): Finding | null {
  if (current == null) return null;
  const diff = Math.abs(claimed - current);
  if (diff < 3) return null;
  const severity: Severity = diff >= 5 ? "medium" : "low";
  return { kind, claim, claimed: String(claimed), current: String(current), severity };
}

function extractFindings(text: string, cur: Current): Finding[] {
  const t = normalize(text);
  const out: Finding[] = [];
  const seen = new Set<string>();
  const push = (f: Finding | null) => {
    if (!f) return;
    const key = `${f.kind}|${f.claimed}|${f.current}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(f);
  };

  // 1. Overall grade + score: "B+ safety grade at 75", "B- report card at 69",
  //    "A grade at 85". Both letter and number checked against the overall card.
  const gradeScoreRe = new RegExp(
    `${GRADE_TOKEN}\\s+(?:safety\\s+grade|overall\\s+grade|report\\s+card|safety\\s+score|grade)\\s+(?:at|of)\\s+(\\d{1,3})\\b`,
    "gi",
  );
  for (const m of t.matchAll(gradeScoreRe)) {
    if (!isGrade(m[1])) continue;
    push(gradeFinding("overall-grade", m[0], m[1], cur.overallGrade));
    push(scoreFinding("overall-score", m[0], Number(m[2]), cur.overallScore));
  }

  // 2. Bare grade-at-score with a multi-char grade: "the A- at 82" (number 0-100).
  const bareGradeScoreRe = new RegExp(
    `(?<![A-Za-z0-9])(A\\+|A-|B\\+|B-|C\\+|C-|D\\+|D-)\\s+at\\s+(\\d{1,3})\\b`,
    "g",
  );
  for (const m of t.matchAll(bareGradeScoreRe)) {
    const n = Number(m[2]);
    if (n > 100) continue;
    push(gradeFinding("overall-grade", m[0], m[1], cur.overallGrade));
    push(scoreFinding("overall-score", m[0], n, cur.overallScore));
  }

  // 3. Overall grade only: "X safety grade", "X overall grade", "safety grade of X".
  const gradeOnlyRe = new RegExp(
    `${GRADE_TOKEN}[\\s-]+(?:safety\\s+grade|overall\\s+grade|overall\\s+score|safety\\s+score)\\b` +
      `|(?:safety|overall)\\s+grade\\s+of\\s+(?:an?\\s+)?${GRADE_TOKEN}`,
    "gi",
  );
  for (const m of t.matchAll(gradeOnlyRe)) {
    push(gradeFinding("overall-grade", m[0], m[1] ?? m[2], cur.overallGrade));
  }

  // 4. Dimension grades: "D in dependency risk", "an A in decentralization",
  //    "X decentralization grade", reverse "decentralization grade of X".
  const dims: Array<[RegExp, string | null, string]> = [
    [/dependency(?:\s+risk)?/i, cur.dependencyGrade, "dependency"],
    [/decentrali\w+/i, cur.decentralizationGrade, "decentralization"],
    [/resilience/i, cur.resilienceGrade, "resilience"],
    [/peg\s+stability/i, cur.pegGrade, "peg-stability"],
  ];
  for (const [dimRe, grade, label] of dims) {
    const fwd = new RegExp(`${GRADE_TOKEN}(?:\\s+grade)?\\s+(?:in\\s+)?(?:${dimRe.source})`, "gi");
    const rev = new RegExp(`(?:${dimRe.source})(?:\\s+grade)?\\s+(?:of\\s+)?(?:an?\\s+)?${GRADE_TOKEN}`, "gi");
    for (const m of t.matchAll(fwd)) push(gradeFinding(`${label}-grade`, m[0], m[1], grade, { dimension: true }));
    for (const m of t.matchAll(rev)) push(gradeFinding(`${label}-grade`, m[0], m[1], grade, { dimension: true }));
  }

  // 5. DEWS band (+ optional score): "in the Calm band", "DEWS at 10 in the Calm band",
  //    "DEWS reads Watch", "Calm band".
  const bandAlt = DEWS_BANDS.join("|");
  const dewsRe = new RegExp(
    `\\bDEWS\\b[^.]{0,40}?\\b(${bandAlt})\\b` +
      `|\\bin\\s+the\\s+(${bandAlt})\\s+band\\b` +
      `|\\b(${bandAlt})\\s+band\\b`,
    "gi",
  );
  for (const m of t.matchAll(dewsRe)) {
    const claimed = (m[1] ?? m[2] ?? m[3] ?? "").toLowerCase();
    if (claimed && cur.dewsBand && claimed !== cur.dewsBand.toLowerCase()) {
      push({ kind: "dews-band", claim: m[0], claimed, current: cur.dewsBand, severity: "high" });
    }
  }
  const dewsScoreRe = /\bDEWS\b[^.]{0,20}?\bat\s+(\d{1,3})\b/gi;
  for (const m of t.matchAll(dewsScoreRe)) push(scoreFinding("dews-score", m[0], Number(m[1]), cur.dewsScore));

  // 6. Peg score: "peg score of 99", "peg score at 95".
  const pegScoreRe = /\bpeg\s+score\s+(?:of|at|is|sits?\s+at)\s+(\d{1,3})\b/gi;
  for (const m of t.matchAll(pegScoreRe)) push(scoreFinding("peg-score", m[0], Number(m[1]), cur.pegScore));

  // 7. Liquidity score: "liquidity score of 68".
  const liqScoreRe = /\bliquidity\s+score\s+(?:of|at|is)\s+(\d{1,3})\b/gi;
  for (const m of t.matchAll(liqScoreRe)) push(scoreFinding("liquidity-score", m[0], Number(m[1]), cur.liquidityScore));

  // 8. Depeg-event count: "294 lifetime depeg events", "Four depeg events".
  const depegRe = /\b([\d,]+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:lifetime\s+|recorded\s+)?depeg\s+events?\b/gi;
  for (const m of t.matchAll(depegRe)) {
    const claimed = parseCount(m[1]);
    if (claimed == null || cur.depegCount == null) continue;
    if (claimed === cur.depegCount) continue;
    // Counts grow over time; only loud when the printed figure is materially wrong.
    const diff = Math.abs(claimed - cur.depegCount);
    const ratio = diff / Math.max(cur.depegCount, 1);
    const severity: Severity = ratio >= 0.5 || diff >= 50 ? "medium" : "low";
    push({ kind: "depeg-count", claim: m[0], claimed: String(claimed), current: String(cur.depegCount), severity });
  }

  return out;
}

const SEV_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

// --- main -------------------------------------------------------------------

async function main(): Promise<void> {
  const summaries = JSON.parse(readFileSync(SUMMARIES_PATH, "utf8")) as Record<
    string,
    { title?: string; text?: string; updatedAt?: string; factsAsOf?: string }
  >;

  let current: Map<string, Current>;
  try {
    current = await loadCurrent();
  } catch (err) {
    console.error(`Failed to load live data: ${(err as Error).message}`);
    console.error("Set PHAROS_API_KEY (and optionally PHAROS_API_BASE), or pass --fixtures <dir>.");
    process.exit(1);
    return;
  }

  const candidates: Candidate[] = [];
  let unmatched = 0;
  for (const [id, entry] of Object.entries(summaries)) {
    const cur = current.get(id);
    if (!cur) {
      unmatched += 1;
      continue;
    }
    const findings = extractFindings(entry.text ?? "", cur);
    if (findings.length === 0) continue;
    const maxSeverity = findings.reduce<Severity>(
      (acc, f) => (SEV_RANK[f.severity] > SEV_RANK[acc] ? f.severity : acc),
      "low",
    );
    candidates.push({
      id,
      name: cur.name,
      symbol: cur.symbol,
      updatedAt: entry.updatedAt ?? "",
      factsAsOf: entry.factsAsOf ?? null,
      maxSeverity,
      findings,
    });
  }

  candidates.sort((a, b) => SEV_RANK[b.maxSeverity] - SEV_RANK[a.maxSeverity] || a.id.localeCompare(b.id));

  const counts = {
    high: candidates.filter((c) => c.maxSeverity === "high").length,
    medium: candidates.filter((c) => c.maxSeverity === "medium").length,
    low: candidates.filter((c) => c.maxSeverity === "low").length,
  };

  writeOutputs(candidates, { unmatched, total: Object.keys(summaries).length, counts });

  console.log(
    `Audited ${Object.keys(summaries).length} summaries (${unmatched} not in live report cards).`,
  );
  console.log(`Stale: ${candidates.length}  [high ${counts.high} · medium ${counts.medium} · low ${counts.low}]`);
  console.log(`Wrote ${OUTPUT_MD} and ${OUTPUT_JSON}`);
  for (const c of candidates.filter((x) => x.maxSeverity !== "low")) {
    const head = c.findings.filter((f) => f.severity !== "low").map((f) => `${f.kind} ${f.claimed}->${f.current}`);
    console.log(`  [${c.maxSeverity.toUpperCase()}] ${c.id}: ${head.join("; ")}`);
  }
}

function writeOutputs(
  candidates: Candidate[],
  meta: { unmatched: number; total: number; counts: Record<Severity, number> },
): void {
  mkdirSync(dirname(OUTPUT_MD), { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [
    "# AI Summary Refresh Candidates",
    "",
    `Generated ${today} by \`npm run candidates:ai-summaries\`.`,
    `Source: ${FIXTURES_DIR ? `fixtures ${FIXTURES_DIR}` : API_BASE}`,
    "",
    `Audited ${meta.total} summaries; ${meta.unmatched} have no live report card (non-active lifecycle) and were skipped.`,
    `Stale: ${candidates.length} — high ${meta.counts.high}, medium ${meta.counts.medium}, low ${meta.counts.low}.`,
    "",
    "Severity: **high** = visible hero contradiction (overall grade or DEWS band changed); ",
    "**medium** = dimension-grade change or a cited score off by 5+; **low** = minor score/count drift.",
    "Refresh `high`/`medium` first. The rewrite is editorial — drive it with the `write-ai-summaries` skill.",
    "",
  ];
  for (const c of candidates) {
    lines.push(`## ${c.id} — ${c.name} (${c.symbol}) · ${c.maxSeverity.toUpperCase()}`);
    lines.push(`updatedAt ${c.updatedAt || "?"} · factsAsOf ${c.factsAsOf ?? "?"}`);
    for (const f of c.findings) {
      lines.push(`- [${f.severity}] **${f.kind}**: summary says \`${f.claimed}\`, live is \`${f.current}\` — "${f.claim.trim()}"`);
    }
    lines.push("");
  }
  writeFileSync(OUTPUT_MD, lines.join("\n"), "utf8");

  writeFileSync(
    OUTPUT_JSON,
    JSON.stringify({ generatedAt: today, source: FIXTURES_DIR ?? API_BASE, ...meta, candidates }, null, 2),
    "utf8",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
