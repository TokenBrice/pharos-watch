#!/usr/bin/env tsx
/* eslint-disable security/detect-non-literal-regexp, security/detect-unsafe-regex */
/**
 * Detects AI editorial summaries whose baked-in scores/grades have drifted
 * away from live Pharos data, and writes an editorial refresh queue.
 *
 * Many summaries in `data/ai-summaries.json` hard-code claims the reader can
 * verify against the hero card and report card on the same page — an overall
 * safety grade ("the A- at 82"), a DEWS band ("in the Calm band"), a peg
 * score, V9 pillar grades ("a D in economic control"), or a depeg-event count.
 * Those drift as the live scoring updates, leaving the prose contradicting the
 * dashboard right next to it. This producer extracts each such claim, compares
 * it to the current value, and writes the mismatches to
 * `agents/ai-summary-candidates.{md,json}` under the gitignored `agents/`
 * scratch folder. It never edits summaries — the rewrite is editorial and is
 * driven by the `write-ai-summaries` skill.
 *
 * Live data comes from three authenticated public API endpoints
 * (report-cards/v9, stress-signals, peg-summary). Override the production API
 * with PHAROS_API_BASE and authenticate with PHAROS_API_KEY. Pass `--fixtures
 * <dir>` to read pre-fetched `<endpoint>.json` files instead of hitting the network.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { scoreToGrade } from "@shared/lib/report-card-core";
import { getCirculatingRaw } from "@shared/lib/supply";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  ReportCardsV9CurrentResponseSchema,
  type ReportCardsV9CurrentResponse,
} from "@shared/types/report-cards-v9";
import {
  PegSummaryResponseSchema,
  StablecoinListResponseSchema,
  StressSignalsAllResponseSchema,
  type PegSummaryResponse,
  type StablecoinListResponse,
  type StressSignalsAllResponse,
} from "@shared/types/market";
import {
  DEFAULT_MAINTENANCE_API_BASE_URL,
  buildMaintenanceApiRequest,
} from "../lib/maintenance-api";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const ROOT = process.cwd();
const SUMMARIES_PATH = resolve(ROOT, "data/ai-summaries.json");
const OUTPUT_MD = resolve(ROOT, "agents/ai-summary-candidates.md");
const OUTPUT_JSON = resolve(ROOT, "agents/ai-summary-candidates.json");
const API_BASE_URL = process.env.PHAROS_API_BASE?.trim() || DEFAULT_MAINTENANCE_API_BASE_URL;
const API_KEY = process.env.PHAROS_API_KEY;
const FETCH_TIMEOUT_MS = 30_000;
const REPORT_CARDS_ENDPOINT = {
  apiPath: API_PATHS.reportCardsV9(),
  fixtureName: "report-cards-v9",
} as const;
const STRESS_SIGNALS_ENDPOINT = {
  apiPath: API_PATHS.stressSignalsBase(),
  fixtureName: "stress-signals",
} as const;
const PEG_SUMMARY_ENDPOINT = {
  apiPath: API_PATHS.pegSummary(),
  fixtureName: "peg-summary",
} as const;
const STABLECOINS_ENDPOINT = {
  apiPath: API_PATHS.stablecoins(),
  fixtureName: "stablecoins",
} as const;

const FIXTURES_DIR = (() => {
  const i = process.argv.indexOf("--fixtures");
  return i !== -1 ? resolve(process.cwd(), process.argv[i + 1] ?? "") : null;
})();

// --- types ------------------------------------------------------------------

export type Severity = "high" | "medium" | "low";

export interface Current {
  name: string;
  symbol: string;
  overallGrade: string | null;
  overallScore: number | null;
  pegGrade: string | null;
  pegScore: number | null;
  backingGrade: string | null;
  backingScore: number | null;
  exitGrade: string | null;
  exitScore: number | null;
  controlGrade: string | null;
  controlScore: number | null;
  dewsBand: string | null;
  dewsScore: number | null;
  depegCount: number | null;
  circulatingUsd?: number | null;
}

export interface Finding {
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

function parseUsdAmount(raw: string, suffix: string | undefined): number | null {
  const value = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  const multiplier = suffix?.toUpperCase() === "B"
    ? 1_000_000_000
    : suffix?.toUpperCase() === "M"
      ? 1_000_000
      : suffix?.toUpperCase() === "K"
        ? 1_000
        : 1;
  return value * multiplier;
}

// --- live data --------------------------------------------------------------

interface LiveEndpoint {
  apiPath: string;
  fixtureName: string;
}

async function fetchJson(endpoint: LiveEndpoint): Promise<unknown> {
  if (FIXTURES_DIR) {
    return JSON.parse(readFileSync(resolve(FIXTURES_DIR, `${endpoint.fixtureName}.json`), "utf8"));
  }
  const request = buildMaintenanceApiRequest(endpoint.apiPath, API_KEY, API_BASE_URL);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(request.url, {
      headers: request.headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`GET ${endpoint.apiPath} -> ${res.status} ${(await res.text()).slice(0, 160)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

function parseLiveContract<T>(
  label: string,
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: Error } },
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${label} contract validation failed: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function buildCurrentMap(
  cards: ReportCardsV9CurrentResponse["cards"],
  stress: StressSignalsAllResponse["signals"],
  peg: PegSummaryResponse["coins"],
  stablecoins: StablecoinListResponse["peggedAssets"] = [],
): Map<string, Current> {
  const pegById = new Map(peg.map((coin) => [coin.id, coin]));
  const stablecoinById = new Map(stablecoins.map((coin) => [coin.id, coin]));
  const map = new Map<string, Current>();

  for (const card of cards) {
    const meta = TRACKED_META_BY_ID.get(card.id);
    const dews = stress[card.id];
    const pegRow = pegById.get(card.id);
    const stablecoin = stablecoinById.get(card.id);
    const pegScore = typeof pegRow?.pegScore === "number" ? pegRow.pegScore : null;
    const backingScore = card.pillars.backing.score;
    const exitScore = card.pillars.exit.score;
    const controlScore = card.pillars.control.score;
    map.set(card.id, {
      name: meta?.name ?? pegRow?.name ?? card.id,
      symbol: meta?.symbol ?? pegRow?.symbol ?? "",
      overallGrade: card.grade,
      overallScore: card.score,
      pegGrade: pegScore == null ? null : scoreToGrade(pegScore),
      pegScore,
      backingGrade: scoreToGrade(backingScore),
      backingScore,
      exitGrade: scoreToGrade(exitScore),
      exitScore,
      controlGrade: scoreToGrade(controlScore),
      controlScore,
      dewsBand: dews?.band ?? null,
      dewsScore: typeof dews?.score === "number" ? dews.score : null,
      depegCount: typeof pegRow?.eventCount === "number" ? pegRow.eventCount : null,
      ...(stablecoin ? { circulatingUsd: getCirculatingRaw(stablecoin) } : {}),
    });
  }
  return map;
}

export async function loadCurrent(): Promise<Map<string, Current>> {
  const [cardsRaw, stressRaw, pegRaw, stablecoinsRaw] = await Promise.all([
    fetchJson(REPORT_CARDS_ENDPOINT),
    fetchJson(STRESS_SIGNALS_ENDPOINT),
    fetchJson(PEG_SUMMARY_ENDPOINT),
    fetchJson(STABLECOINS_ENDPOINT),
  ]);

  const cards = parseLiveContract(
    "report-cards/v9",
    ReportCardsV9CurrentResponseSchema,
    cardsRaw,
  );
  const stress = parseLiveContract("stress-signals", StressSignalsAllResponseSchema, stressRaw);
  const peg = parseLiveContract("peg-summary", PegSummaryResponseSchema, pegRaw);
  const stablecoins = parseLiveContract("stablecoins", StablecoinListResponseSchema, stablecoinsRaw);
  return buildCurrentMap(cards.cards, stress.signals, peg.coins, stablecoins.peggedAssets);
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

function retiredDimensionFinding(
  kind: string,
  claim: string,
  claimed: string,
): Finding | null {
  if (!isGrade(claimed)) return null;
  return {
    kind,
    claim,
    claimed,
    current: "retired in Safety Score v9",
    severity: "medium",
  };
}

export function extractFindings(text: string, cur: Current): Finding[] {
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

  // Static adoption and balance-sheet figures require a dated, displayed
  // source even when no current producer can compare like-for-like values.
  const volatileUsdRe = /\$([\d,.]+)\s*([KMB])?\s+(?:in\s+)?(circulation|market\s+cap|TVL)\b/gi;
  for (const match of t.matchAll(volatileUsdRe)) {
    const claimed = parseUsdAmount(match[1], match[2]);
    push({
      kind: "volatile-dollar-claim",
      claim: match[0],
      claimed: claimed == null ? match[0] : String(claimed),
      current: "manual dated/source review required",
      severity: "medium",
    });
    if (claimed == null || cur.circulatingUsd == null || !/circulation|market\s+cap/i.test(match[3])) continue;
    const ratio = Math.abs(claimed - cur.circulatingUsd) / Math.max(cur.circulatingUsd, 1);
    if (ratio < 0.1) continue;
    push({
      kind: "cross-chain-circulation-drift",
      claim: match[0],
      claimed: String(claimed),
      current: String(cur.circulatingUsd),
      severity: ratio >= 0.5 ? "high" : "medium",
    });
  }

  const holderScopeRe = /\b([\d,]+)\s+(holders?|users?)\b/gi;
  for (const match of t.matchAll(holderScopeRe)) {
    push({
      kind: "holder-address-scope",
      claim: match[0],
      claimed: match[1],
      current: "define chain scope, addresses vs users, contract/EOA handling, deduplication, and block/date",
      severity: "medium",
    });
  }

  const financingComparisonRe = /[^.]{0,120}(?:\braised\b[^.]{0,120}\$[\d,.]+\s*[KMB]?|\$[\d,.]+\s*[KMB]?[^.]{0,120}\braised\b)[^.]{0,160}\b(?:circulation|market\s+cap|supply|used)\b[^.]{0,80}/gi;
  for (const match of t.matchAll(financingComparisonRe)) {
    push({
      kind: "financing-to-product-scale",
      claim: match[0],
      claimed: "parent/project financing compared with product scale",
      current: "manual economic-comparability review required",
      severity: "high",
    });
  }

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

  // 4. Current V9 pillar grades: "D in economic control", "an A in backing",
  //    "X exit grade", reverse "backing grade of X".
  const dims: Array<[RegExp, string | null, string]> = [
    [/backing/i, cur.backingGrade, "backing"],
    [/exit(?:ability)?/i, cur.exitGrade, "exit"],
    [/(?:economic\s+)?control/i, cur.controlGrade, "control"],
    [/peg\s+stability/i, cur.pegGrade, "peg-stability"],
  ];
  for (const [dimRe, grade, label] of dims) {
    const fwd = new RegExp(`${GRADE_TOKEN}(?:\\s+grade)?\\s+(?:in\\s+)?(?:${dimRe.source})`, "gi");
    const rev = new RegExp(`(?:${dimRe.source})(?:\\s+grade)?\\s+(?:of\\s+)?(?:an?\\s+)?${GRADE_TOKEN}`, "gi");
    for (const m of t.matchAll(fwd)) push(gradeFinding(`${label}-grade`, m[0], m[1], grade, { dimension: true }));
    for (const m of t.matchAll(rev)) push(gradeFinding(`${label}-grade`, m[0], m[1], grade, { dimension: true }));
  }

  // V8 dimensions have no like-for-like current value. Flag precise legacy
  // grade claims for editorial removal instead of mapping them onto a V9 pillar.
  const legacyDims: Array<[RegExp, string]> = [
    [/dependency(?:\s+risk)?/i, "dependency"],
    [/decentrali\w+/i, "decentralization"],
    [/resilience/i, "resilience"],
    [/liquidity/i, "liquidity"],
  ];
  for (const [dimRe, label] of legacyDims) {
    const fwd = new RegExp(`${GRADE_TOKEN}(?:\\s+grade)?\\s+(?:in\\s+)?(?:${dimRe.source})`, "gi");
    const rev = new RegExp(`(?:${dimRe.source})(?:\\s+grade)?\\s+(?:of\\s+)?(?:an?\\s+)?${GRADE_TOKEN}`, "gi");
    for (const m of t.matchAll(fwd)) push(retiredDimensionFinding(`legacy-${label}-grade`, m[0], m[1]));
    for (const m of t.matchAll(rev)) push(retiredDimensionFinding(`legacy-${label}-grade`, m[0], m[1]));
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

  // 7. Current V9 pillar scores.
  const pillarScores: Array<[RegExp, number | null, string]> = [
    [/\bbacking\s+score\s+(?:of|at|is)\s+(\d{1,3})\b/gi, cur.backingScore, "backing"],
    [/\bexit\s+score\s+(?:of|at|is)\s+(\d{1,3})\b/gi, cur.exitScore, "exit"],
    [/\b(?:economic\s+)?control\s+score\s+(?:of|at|is)\s+(\d{1,3})\b/gi, cur.controlScore, "control"],
  ];
  for (const [pattern, current, label] of pillarScores) {
    for (const m of t.matchAll(pattern)) push(scoreFinding(`${label}-score`, m[0], Number(m[1]), current));
  }

  const legacyScoreRe =
    /\b(liquidity|resilience|decentralization|dependency(?:\s+risk)?)\s+score\s+(?:of|at|is)\s+(\d{1,3})\b/gi;
  for (const m of t.matchAll(legacyScoreRe)) {
    push({
      kind: `legacy-${m[1].toLowerCase().replace(/\s+/g, "-")}-score`,
      claim: m[0],
      claimed: m[2],
      current: "retired in Safety Score v9",
      severity: "medium",
    });
  }

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
    console.error("Check PHAROS_API_KEY / PHAROS_API_BASE, or pass --fixtures <dir>.");
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
    `Source: ${FIXTURES_DIR ? `fixtures ${FIXTURES_DIR}` : API_BASE_URL}`,
    "",
    `Audited ${meta.total} summaries; ${meta.unmatched} have no live report card (non-active lifecycle) and were skipped.`,
    `Stale: ${candidates.length} — high ${meta.counts.high}, medium ${meta.counts.medium}, low ${meta.counts.low}.`,
    "",
    "Severity: **high** = visible hero contradiction (overall grade or DEWS band changed); ",
    "**medium** = pillar-grade change, a retired V8 dimension claim, or a cited score off by 5+; **low** = minor score/count drift.",
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
    JSON.stringify({ generatedAt: today, source: FIXTURES_DIR ?? API_BASE_URL, ...meta, candidates }, null, 2),
    "utf8",
  );
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  void main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
