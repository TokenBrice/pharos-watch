#!/usr/bin/env tsx
/**
 * Builds candidate rows for the chart-annotation editorial queue.
 *
 * Reads four signals (depeg tape, blacklist surge tape, recent launches,
 * recent pre-launch milestones) and writes them to
 * `agents/annotation-candidates.{md,json}`. The files live under the gitignored
 * `agents/` scratch folder and feeds the `annotations-refresh` skill.
 *
 * Promotion to `shared/data/annotations/coins/<stablecoin-id>.json` is always
 * editorial — this producer never writes there.
 *
 * Failure mode: source-by-source. If the worker endpoint is unreachable —
 * or `PHAROS_API_KEY` is unset, which is the same thing from the queue's
 * point of view — the producer emits a note for that source and keeps
 * going so the repo-local sources still surface. Invalid replay/review input
 * or a filesystem failure exits non-zero. --replay merges retained snapshots
 * offline; only reviewer-authored dispositions close individual event IDs.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { loadPerCoinStablecoinEntries } from "../lib/stablecoin-catalog-sources";
import {
  DEFAULT_MAINTENANCE_API_BASE_URL,
  buildMaintenanceApiRequest,
} from "../lib/maintenance-api";
import { isDirectRun } from "../lib/smoke-runtime.mjs";
import { parseStrictCliArgs, runCliEntrypoint } from "../lib/cli-args.mjs";
import type { StablecoinMeta } from "@shared/types";

const ROOT = process.cwd();
const API_BASE_URL = process.env.PHAROS_API_BASE?.trim() || DEFAULT_MAINTENANCE_API_BASE_URL;

// Overlap covers a missed weekly collection; retained snapshots cover review cadence.
const DEFAULT_LOOKBACK_DAYS = 14;
const LAUNCH_LOOKBACK_DAYS = 30;
const FETCH_TIMEOUT_MS = 6000;
const SOURCE_TIMEOUT_MS = 30_000;
const MAX_TAPE_PAGES = 25;

const LAST_SWEPT_RE = /<!--\s*last_swept_at:\s*(\d{4}-\d{2}-\d{2})\s*-->/;

const CandidateSchema = z.object({
  id: z.string().min(1).optional(),
  coinId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  kind: z.string().min(1),
  description: z.string(),
  source: z.string(),
  severity: z.string().optional(),
  queueRow: z.string().optional(),
});
export type Candidate = z.infer<typeof CandidateSchema>;

function epochAt(daysAgo: number): number {
  return Date.now() - daysAgo * 24 * 60 * 60 * 1000;
}

export async function fetchTapeJson(url: string, headers: Record<string, string>, timeoutMs = FETCH_TIMEOUT_MS): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

const TapePageSchema = z.object({
  events: z.array(z.object({
    id: z.string().min(1),
    type: z.string(),
    severity: z.string(),
    ts: z.number().finite(),
    coinId: z.string().nullable(),
    title: z.string(),
    summary: z.string(),
    payload: z.record(z.string(), z.unknown()).optional(),
    sourceUrl: z.string().nullable(),
  })),
  nextCursor: z.string().min(1).nullable(),
});
type TapeEventLite = z.infer<typeof TapePageSchema>["events"][number];

export interface TapeCollection {
  events: TapeEventLite[];
  complete: boolean;
  pages: number;
  note?: string;
}

export async function fetchTapeEvents(
  classFilter: string,
  sinceMs: number,
  untilMs: number,
  { apiKey = process.env.PHAROS_API_KEY, maxPages = MAX_TAPE_PAGES, timeoutMs = SOURCE_TIMEOUT_MS } = {},
): Promise<TapeCollection> {
  // A missing or malformed credential is a source failure like any other, not
  // a reason to abandon the repo-local sources. buildMaintenanceApiRequest
  // throws on an empty key, and it sits outside the fetch guard below, so
  // without this catch the whole producer exits non-zero and the launch and
  // milestone rows are lost with it.
  let request: { url: string; headers: Record<string, string> };
  try {
    request = buildMaintenanceApiRequest(API_PATHS.events(), apiKey, API_BASE_URL);
  } catch {
    return { events: [], complete: false, pages: 0, note: "PHAROS_API_KEY is not set" };
  }
  const url = new URL(request.url);
  url.searchParams.set("class", classFilter);
  url.searchParams.set("severityFloor", "warning");
  url.searchParams.set("since", String(sinceMs));
  url.searchParams.set("until", String(untilMs));
  url.searchParams.set("limit", "200");

  const events: TapeEventLite[] = [];
  const cursors = new Set<string>();
  const deadline = Date.now() + timeoutMs;
  let pages = 0;
  try {
    while (pages < maxPages) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("source deadline reached");
      const page = TapePageSchema.parse(await fetchTapeJson(url.toString(), request.headers, Math.min(FETCH_TIMEOUT_MS, remaining)));
      pages += 1;
      events.push(...page.events);
      if (page.nextCursor === null) return { events, complete: true, pages };
      if (cursors.has(page.nextCursor)) throw new Error("repeated cursor");
      cursors.add(page.nextCursor);
      url.searchParams.set("cursor", page.nextCursor);
    }
    throw new Error(`page limit reached (${maxPages})`);
  } catch (error) {
    return { events, complete: false, pages, note: error instanceof Error ? error.message : String(error) };
  }
}

function toIsoDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function mapDepegCandidate(event: TapeEventLite): Candidate | null {
  if (!event.coinId) return null;
  const severity =
    event.severity === "critical"
      ? "high"
      : event.severity === "severe"
        ? "high"
        : event.severity === "warning"
          ? "med"
          : "low";
  return {
    id: `tape:${event.id}`,
    coinId: event.coinId,
    date: toIsoDate(event.ts),
    kind: "depeg",
    description: event.title || event.summary || "depeg event",
    source: "depeg tape (/api/events)",
    severity,
  };
}

export function buildCoinIdResolver(coins: readonly StablecoinMeta[]): (symbolOrName: unknown) => string | null {
  const byLabel = new Map<string, string | null>();
  const add = (label: string, coinId: string) => {
    const key = label.trim().toLowerCase();
    if (!key) return;
    if (!byLabel.has(key)) {
      byLabel.set(key, coinId);
      return;
    }
    const existing = byLabel.get(key);
    if (existing !== coinId) byLabel.set(key, null);
  };
  for (const coin of coins) {
    add(coin.id, coin.id);
    add(coin.symbol, coin.id);
    add(coin.name, coin.id);
  }
  return (symbolOrName: unknown) => {
    if (typeof symbolOrName !== "string") return null;
    return byLabel.get(symbolOrName.trim().toLowerCase()) ?? null;
  };
}

function mapBlacklistCandidate(
  event: TapeEventLite,
  resolveCoinId: (symbolOrName: unknown) => string | null,
): Candidate | null {
  const coinId = event.coinId ?? resolveCoinId(event.payload?.stablecoin);
  if (!coinId) return null;
  const severity =
    event.severity === "critical"
      ? "high"
      : event.severity === "severe"
        ? "high"
        : event.severity === "warning"
          ? "med"
          : "low";
  return {
    id: `tape:${event.id}`,
    coinId,
    date: toIsoDate(event.ts),
    kind: "blacklist-surge",
    description: event.title || event.summary || "blacklist surge",
    source: "freeze tape (/api/events)",
    severity,
  };
}

function findRecentLaunches(coins: readonly StablecoinMeta[]): Candidate[] {
  const cutoffMs = epochAt(LAUNCH_LOOKBACK_DAYS);
  const candidates: Candidate[] = [];
  for (const coin of coins) {
    const status = coin.status ?? "active";
    if (status !== "active") continue;
    const launchDate = coin.launchDate;
    if (typeof launchDate !== "string" || launchDate.length < 10) continue;
    const ts = Date.parse(`${launchDate.slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(ts) || ts < cutoffMs) continue;
    candidates.push({
      id: `launch:${coin.id}:${launchDate.slice(0, 10)}`,
      coinId: coin.id,
      date: launchDate.slice(0, 10),
      kind: "launch",
      description: `mainnet live ${launchDate.slice(0, 10)} per launchDate`,
      source: "registry launchDate",
      severity: "med",
    });
  }
  return candidates;
}

function findRecentMilestones(coins: readonly StablecoinMeta[]): Candidate[] {
  const cutoffMs = epochAt(LAUNCH_LOOKBACK_DAYS);
  const launchKeywords = /\b(mainnet|launch|live|public|production|go[- ]?live)\b/i;
  const candidates: Candidate[] = [];
  for (const coin of coins) {
    if ((coin.status ?? "active") !== "pre-launch") continue;
    const milestones = coin.milestones ?? [];
    for (const m of milestones) {
      if (typeof m.date !== "string" || m.date.length < 10) continue;
      const ts = Date.parse(`${m.date.slice(0, 10)}T00:00:00Z`);
      if (Number.isNaN(ts) || ts < cutoffMs) continue;
      if (!launchKeywords.test(m.title) && m.type !== "milestone") continue;
      candidates.push({
        coinId: coin.id,
        date: m.date.slice(0, 10),
        kind: "launch",
        description: `${m.title} (milestone: ${m.type})`,
        source: m.sourceUrl ? `milestone (${m.sourceUrl})` : "pre-launch milestone",
        severity: "med",
      });
    }
  }
  return candidates;
}

export function candidateId(c: Candidate): string {
  return c.id ?? `legacy:${createHash("sha256")
    .update(JSON.stringify([c.date, c.coinId, c.kind, c.description, c.source]))
    .digest("hex").slice(0, 24)}`;
}

export function readQueueCandidates(existingBody: string): Candidate[] {
  const candidates: Candidate[] = [];
  let currentDate: string | null = null;
  for (const line of existingBody.split("\n")) {
    const header = line.match(/^##\s+(\d{4}-\d{2}-\d{2})\s*$/);
    if (header) {
      currentDate = header[1];
      continue;
    }
    if (currentDate == null) continue;
    if (!line.startsWith("- ") || !line.includes(" | ")) continue;
    const fields = line.slice(2).split(" | ").map((field) => field.trim());
    const date = /^\d{4}-\d{2}-\d{2}$/.test(fields[0]) ? fields.shift()! : currentDate;
    const [coinId, kind, description] = fields;
    if (!coinId || !kind || !description) throw new Error(`Unrecognized queue row: ${line}`);
    const value = (label: string) => fields.find((field) => field.startsWith(`${label}: `))?.slice(label.length + 2);
    candidates.push({
      date, coinId, kind, description,
      source: value("source") ?? "legacy queue",
      severity: value("severity"),
      id: value("id"),
      // Keep legacy/editorial annotations verbatim while giving the row an identity.
      queueRow: line.replace(/ \| id: [^|]+/, "").replace(/ \| review: defer[^\n]*/, "").trimEnd(),
    });
  }
  return candidates;
}

export function filterAgainstExisting(
  candidates: Candidate[],
  existingBody: string,
  _lastSweptAt: string | null = null,
): Candidate[] {
  // Legacy date-only cursors cannot prove same-day or recovered-source coverage.
  const existing = new Set(readQueueCandidates(existingBody).map(candidateId));
  return candidates.filter((c) => !existing.has(candidateId(c)));
}

function renderRow(c: Candidate): string {
  const sevTag = c.severity ? ` | severity: ${c.severity}` : "";
  const clean = (value: string) => value.replace(/[\r\n|]/g, " ");
  const row = c.queueRow ?? `- ${c.date} | ${c.coinId} | ${c.kind} | ${clean(c.description)} | source: ${clean(c.source)}${sevTag}`;
  return `${row} | id: ${candidateId(c)}`;
}

export function renderAppendBlock(date: string, candidates: Candidate[], notes: string[]): string {
  const lines: string[] = [];
  let currentDate: string | null = null;
  const startDate = (sectionDate: string) => {
    if (currentDate === sectionDate) return;
    if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
    lines.push(`## ${sectionDate}`);
    currentDate = sectionDate;
  };

  if (notes.length > 0 || candidates.length === 0) {
    startDate(date);
    for (const note of notes) {
      lines.push(`<!-- ${note} -->`);
    }
    if (candidates.length === 0) {
      lines.push(`<!-- producer found no new candidates this run -->`);
    }
  }

  for (const c of candidates) {
    startDate(c.date);
    lines.push(renderRow(c));
  }
  lines.push("");
  return lines.join("\n");
}

function stripFooter(body: string): string {
  return body.replace(/\n*<!--\s*last_swept_at:[^>]*-->\s*$/m, "");
}

export function buildFile(existingBody: string, appendBlock: string): string {
  const reviewFooter = LAST_SWEPT_RE.exec(existingBody)?.[0] ?? "";
  const trimmed = stripFooter(existingBody.trimEnd());
  const header =
    trimmed === ""
      ? "# Annotation candidates\n\nReview queue feeding the `annotations-refresh` skill. Each identified row is a machine-found event — promote, drop, or defer in annotation-review.json. Generation never records review decisions.\n"
      : "";
  const sections = [header, trimmed, appendBlock, reviewFooter].filter(Boolean);
  return (
    sections
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  );
}

const SourceCoverageSchema = z.object({
  source: z.string(),
  since: z.string().datetime(),
  until: z.string().datetime(),
  complete: z.boolean(),
  pages: z.number().int().nonnegative(),
  note: z.string().optional(),
});
export const AnnotationSnapshotSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().datetime(),
  coverage: z.array(SourceCoverageSchema),
  candidates: z.array(CandidateSchema),
});
export type AnnotationSnapshot = z.infer<typeof AnnotationSnapshotSchema>;
export const AnnotationReviewSchema = z.object({
  version: z.literal(1),
  decisions: z.record(z.string(), z.object({
    disposition: z.enum(["promote", "drop", "defer"]),
    reviewedAt: z.string().datetime(),
    reason: z.string().min(1),
  }).strict()),
}).strict();
export type AnnotationReview = z.infer<typeof AnnotationReviewSchema>;

export function mergeSnapshots(snapshots: AnnotationSnapshot[], existingBody: string, generatedAt: string): AnnotationSnapshot {
  const candidates = new Map<string, Candidate>();
  const coverage = new Map<string, AnnotationSnapshot["coverage"][number]>();
  for (const snapshot of snapshots) {
    for (const entry of snapshot.coverage) coverage.set(JSON.stringify(entry), entry);
    for (const candidate of snapshot.candidates) candidates.set(candidateId(candidate), candidate);
  }
  for (const candidate of readQueueCandidates(existingBody)) candidates.set(candidateId(candidate), candidate);
  return {
    version: 1,
    generatedAt,
    coverage: [...coverage.values()],
    candidates: [...candidates.values()].map((candidate) => ({ ...candidate, id: candidateId(candidate) }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.coinId.localeCompare(b.coinId) || a.id.localeCompare(b.id)),
  };
}

export function renderReviewQueue(snapshot: AnnotationSnapshot, review: AnnotationReview, existingBody = "", hasLegacyBackup = false): string {
  const pending = snapshot.candidates.filter((candidate) => {
    const decision = review.decisions[candidateId(candidate)];
    return !decision || decision.disposition === "defer";
  });
  const notes = snapshot.coverage.map((entry) =>
    `${entry.source}: ${entry.complete ? "complete collection" : "INCOMPLETE collection"} ` +
    `${entry.since} through ${entry.until}; ${entry.pages} page(s)${entry.note ? `; ${entry.note}` : ""}`);
  // A collection interval is never an editorial watermark. Preserve the legacy
  // comment for compatibility, but only explicit dispositions suppress rows.
  const footer = LAST_SWEPT_RE.exec(existingBody)?.[0] ?? "";
  const block = renderAppendBlock(snapshot.generatedAt.slice(0, 10), pending, notes);
  const withDeferrals = block.split("\n").map((line) => {
    const id = / \| id: ([^|]+)$/.exec(line)?.[1]?.trim();
    const decision = id ? review.decisions[id] : undefined;
    return decision?.disposition === "defer"
      ? `${line} | review: defer — ${decision.reason.replace(/[\r\n|]/g, " ")}`
      : line;
  }).join("\n");
  const body = buildFile(footer, withDeferrals);
  return hasLegacyBackup
    ? body.replace("# Annotation candidates\n", "# Annotation candidates\n\n" +
      "Legacy review evidence: [original queue](annotation-candidates.legacy.md). Read its preserved notes, deferral evidence, and collection gaps alongside these rows; keep it with the review handoff.\n")
    : body;
}

export function readSnapshotHistory(directory: string): AnnotationSnapshot[] {
  const snapshots: AnnotationSnapshot[] = [];
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && entry.name === "annotation-candidates.json") {
        snapshots.push(AnnotationSnapshotSchema.parse(JSON.parse(readFileSync(child, "utf8"))));
      }
    }
  };
  walk(directory);
  if (snapshots.length === 0) throw new Error(`No annotation-candidates.json snapshots found under ${directory}`);
  return snapshots.sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
}

export async function runAnnotationCandidates(argv: string[], root = ROOT): Promise<void> {
  const { values } = parseStrictCliArgs(argv, { options: {
    replay: { type: "string" },
    review: { type: "string" },
  } });
  if (values.help) {
    process.stdout.write("Usage: candidates:annotations [--replay <downloaded-artifact-directory>] [--review <review.json>]\n" +
      "Default: collect a bounded 14-day tape window and local launch signals.\n" +
      "--replay: merge all retained annotation snapshots offline, preserving local rows and dispositions.\n" +
      "Writes agents/annotation-candidates.{md,json}; never writes review decisions or product annotations.\n");
    return;
  }
  const outputPath = resolve(root, "agents/annotation-candidates.md");
  const snapshotPath = resolve(root, "agents/annotation-candidates.json");
  const legacyPath = resolve(root, "agents/annotation-candidates.legacy.md");
  const reviewPath = resolve(root, typeof values.review === "string" ? values.review : "agents/annotation-review.json");
  if (typeof values.review === "string" && !existsSync(reviewPath)) throw new Error(`Review file not found: ${reviewPath}`);
  const existingBody = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";
  const review = existsSync(reviewPath)
    ? AnnotationReviewSchema.parse(JSON.parse(readFileSync(reviewPath, "utf8")))
    : { version: 1 as const, decisions: {} };
  const hasSnapshot = existsSync(snapshotPath);
  const snapshots: AnnotationSnapshot[] = hasSnapshot
    ? [AnnotationSnapshotSchema.parse(JSON.parse(readFileSync(snapshotPath, "utf8")))]
    : [];
  const generatedAt = new Date().toISOString();
  if (typeof values.replay === "string") {
    snapshots.push(...readSnapshotHistory(resolve(root, values.replay)));
  } else {
    const untilMs = Date.parse(generatedAt);
    const sinceMs = untilMs - DEFAULT_LOOKBACK_DAYS * 86_400_000;
    const coins = loadPerCoinStablecoinEntries(root).map((entry) => entry.coin);
    const resolveCoinId = buildCoinIdResolver(coins);
    const [depeg, freeze] = await Promise.all([
      fetchTapeEvents("depeg", sinceMs, untilMs),
      fetchTapeEvents("freeze", sinceMs, untilMs),
    ]);
    const candidates = [
      ...depeg.events.map(mapDepegCandidate),
      ...freeze.events.map((event) => mapBlacklistCandidate(event, resolveCoinId)),
      ...findRecentLaunches(coins),
      ...findRecentMilestones(coins),
    ].filter((candidate): candidate is Candidate => candidate !== null);
    snapshots.push({
      version: 1,
      generatedAt,
      coverage: [
        ...([ ["depeg", depeg], ["freeze", freeze] ] as const).map(([source, result]) => ({
          source, since: new Date(sinceMs).toISOString(), until: generatedAt,
          complete: result.complete, pages: result.pages, ...(result.note ? { note: result.note } : {}),
        })),
        { source: "registry", since: new Date(untilMs - LAUNCH_LOOKBACK_DAYS * 86_400_000).toISOString(),
          until: generatedAt, complete: true, pages: 0 },
      ],
      candidates,
    });
  }
  const snapshot = mergeSnapshots(snapshots, existingBody, generatedAt);
  // Rows are structured; historical free-form notes are not. Save the entire
  // original before migration so indented evidence and gap notes cannot vanish.
  const migrating = !hasSnapshot && existingBody.trim().length > 0;
  if (migrating && existsSync(legacyPath) && readFileSync(legacyPath, "utf8") !== existingBody) {
    throw new Error(`Legacy backup already contains different evidence: ${legacyPath}. Preserve both queues before migrating.`);
  }
  const body = renderReviewQueue(snapshot, review, existingBody, migrating || existsSync(legacyPath));
  mkdirSync(dirname(outputPath), { recursive: true });
  if (migrating && !existsSync(legacyPath)) writeFileSync(legacyPath, existingBody, { encoding: "utf8", flag: "wx" });
  writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  writeFileSync(outputPath, body, "utf8");
  const incomplete = snapshot.coverage.filter((entry) => !entry.complete).length;
  process.stdout.write(`Annotation candidates: ${readQueueCandidates(body).length} pending row(s); ` +
    `${incomplete} incomplete source window(s). Full queue: ${outputPath}\n`);
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  void runCliEntrypoint(() => runAnnotationCandidates(process.argv.slice(2)), { label: "Failed to build annotation candidates" });
}
