#!/usr/bin/env tsx
/**
 * Builds candidate rows for the chart-annotation editorial queue.
 *
 * Reads four signals (depeg tape, blacklist surge tape, recent launches,
 * recent pre-launch milestones) and writes them to
 * `agents/annotation-candidates.md`. The file lives under the gitignored
 * `agents/` scratch folder and feeds the `annotations-refresh` skill.
 *
 * Promotion to `shared/data/annotations/curated-annotations.ts` is always
 * editorial — this producer never writes there.
 *
 * Failure mode: source-by-source. If the worker endpoint is unreachable,
 * the producer emits a `<!-- source unreachable -->` note for that
 * source and keeps going so repo-local sources still surface.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadPerCoinStablecoinEntries } from "../lib/stablecoin-catalog-sources";
import type { StablecoinMeta } from "../../shared/types";

const ROOT = process.cwd();
const OUTPUT_PATH = resolve(ROOT, "agents/annotation-candidates.md");
const WORKER_BASE_URL =
  process.env.PHAROS_WORKER_BASE_URL ?? "http://127.0.0.1:8787";
const PHAROS_API_KEY = process.env.PHAROS_API_KEY?.trim() || null;
const DEFAULT_LOOKBACK_DAYS = 7;
const LAUNCH_LOOKBACK_DAYS = 30;
const FETCH_TIMEOUT_MS = 6000;

const LAST_SWEPT_RE = /<!--\s*last_swept_at:\s*(\d{4}-\d{2}-\d{2})\s*-->/;

interface Candidate {
  coinId: string;
  date: string;
  kind: string;
  description: string;
  source: string;
  severity?: string;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function epochAt(daysAgo: number): number {
  return Date.now() - daysAgo * 24 * 60 * 60 * 1000;
}

function readExistingQueue(): { body: string; lastSweptAt: string | null } {
  if (!existsSync(OUTPUT_PATH)) {
    return { body: "", lastSweptAt: null };
  }
  const raw = readFileSync(OUTPUT_PATH, "utf8");
  const match = LAST_SWEPT_RE.exec(raw);
  return { body: raw, lastSweptAt: match ? match[1]! : null };
}

async function fetchWithTimeout(url: string): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const headers: Record<string, string> = {};
  if (PHAROS_API_KEY) headers["X-API-Key"] = PHAROS_API_KEY;
  try {
    const response = await fetch(url, { signal: controller.signal, headers });
    return response;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface TapeEventLite {
  type: string;
  severity: string;
  ts: number;
  coinId: string | null;
  title: string;
  summary: string;
  sourceUrl: string | null;
}

async function fetchTapeEvents(
  classFilter: string,
  sinceMs: number,
): Promise<TapeEventLite[] | null> {
  const url = new URL("/api/events", WORKER_BASE_URL);
  url.searchParams.set("class", classFilter);
  url.searchParams.set("severityFloor", "warning");
  url.searchParams.set("since", String(sinceMs));
  url.searchParams.set("limit", "200");

  const res = await fetchWithTimeout(url.toString());
  if (!res || !res.ok) return null;
  try {
    const json = (await res.json()) as { events?: TapeEventLite[] };
    return Array.isArray(json.events) ? json.events : [];
  } catch {
    return null;
  }
}

function toIsoDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function mapDepegCandidate(event: TapeEventLite): Candidate | null {
  if (!event.coinId) return null;
  const severity =
    event.severity === "critical" ? "high"
    : event.severity === "severe" ? "high"
    : event.severity === "warning" ? "med"
    : "low";
  return {
    coinId: event.coinId,
    date: toIsoDate(event.ts),
    kind: "depeg",
    description: event.title || event.summary || "depeg event",
    source: "depeg tape (/api/events)",
    severity,
  };
}

function mapBlacklistCandidate(event: TapeEventLite): Candidate | null {
  if (!event.coinId) return null;
  const severity =
    event.severity === "critical" ? "high"
    : event.severity === "severe" ? "high"
    : event.severity === "warning" ? "med"
    : "low";
  return {
    coinId: event.coinId,
    date: toIsoDate(event.ts),
    kind: "blacklist-surge",
    description: event.title || event.summary || "blacklist surge",
    source: "blacklist tape (/api/events)",
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
  const launchKeywords =
    /\b(mainnet|launch|live|public|production|go[- ]?live)\b/i;
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

function dedupe(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of candidates) {
    const key = `${c.coinId}|${c.date}|${c.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function filterAgainstExisting(
  candidates: Candidate[],
  existingBody: string,
): Candidate[] {
  // The queue body is editorial — a simple substring scan is enough to
  // suppress duplicates produced by overlapping runs. The skill that
  // drains the queue is the canonical de-duper.
  return candidates.filter((c) => {
    const fingerprint = `${c.coinId} | ${c.kind} |`;
    if (!existingBody.includes(fingerprint)) return true;
    return !existingBody.includes(c.date) || !existingBody.includes(c.coinId + " | " + c.kind);
  });
}

function renderRow(c: Candidate): string {
  const sevTag = c.severity ? ` | severity: ${c.severity}` : "";
  return `- ${c.coinId} | ${c.kind} | ${c.description} | source: ${c.source}${sevTag}`;
}

function renderAppendBlock(
  date: string,
  candidates: Candidate[],
  notes: string[],
): string {
  const lines: string[] = [];
  lines.push(`## ${date}`);
  if (notes.length > 0) {
    for (const note of notes) {
      lines.push(`<!-- ${note} -->`);
    }
  }
  if (candidates.length === 0) {
    lines.push(`<!-- producer found no new candidates this run -->`);
  } else {
    for (const c of candidates) lines.push(renderRow(c));
  }
  lines.push("");
  return lines.join("\n");
}

function stripFooter(body: string): string {
  return body.replace(/\n*<!--\s*last_swept_at:[^>]*-->\s*$/m, "");
}

function buildFile(existingBody: string, appendBlock: string, todaysFooter: string): string {
  const trimmed = stripFooter(existingBody.trimEnd());
  const header =
    trimmed === ""
      ? "# Annotation candidates\n\nAppend-only queue feeding the `annotations-refresh` skill. Each row is a machine-found event for editorial review — promote, drop, or defer.\n"
      : "";
  const sections = [header, trimmed, appendBlock, todaysFooter].filter(Boolean);
  return sections.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

async function main(): Promise<void> {
  const lookbackDays = DEFAULT_LOOKBACK_DAYS;
  const sinceMs = epochAt(lookbackDays);
  const today = todayIso();

  const { body: existingBody } = readExistingQueue();

  const notes: string[] = [];
  const collected: Candidate[] = [];

  const [depegEvents, blacklistEvents] = await Promise.all([
    fetchTapeEvents("depeg", sinceMs),
    fetchTapeEvents("blacklist", sinceMs),
  ]);

  if (depegEvents == null) {
    notes.push(`depeg tape unreachable at ${WORKER_BASE_URL} — skipped`);
  } else {
    for (const e of depegEvents) {
      const c = mapDepegCandidate(e);
      if (c) collected.push(c);
    }
  }

  if (blacklistEvents == null) {
    notes.push(`blacklist tape unreachable at ${WORKER_BASE_URL} — skipped`);
  } else {
    for (const e of blacklistEvents) {
      const c = mapBlacklistCandidate(e);
      if (c) collected.push(c);
    }
  }

  const entries = loadPerCoinStablecoinEntries(ROOT);
  const coins = entries.map((entry) => entry.coin);
  collected.push(...findRecentLaunches(coins));
  collected.push(...findRecentMilestones(coins));

  const deduped = dedupe(collected);
  const fresh = filterAgainstExisting(deduped, existingBody);
  fresh.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    if (a.coinId !== b.coinId) return a.coinId.localeCompare(b.coinId);
    return a.kind.localeCompare(b.kind);
  });

  const appendBlock = renderAppendBlock(today, fresh, notes);
  const footer = `\n<!-- last_swept_at: ${today} -->\n`;
  const updated = buildFile(existingBody, appendBlock, footer);

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, updated, "utf8");

  process.stdout.write(
    `Annotation candidates: ${fresh.length} new row(s) appended to ${OUTPUT_PATH} ` +
      `(${notes.length} source note${notes.length === 1 ? "" : "s"}).\n`,
  );
}

void main();
