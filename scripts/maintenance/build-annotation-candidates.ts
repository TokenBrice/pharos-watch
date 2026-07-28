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
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { loadPerCoinStablecoinEntries } from "../lib/stablecoin-catalog-sources";
import {
  DEFAULT_MAINTENANCE_API_BASE_URL,
  buildMaintenanceApiRequest,
} from "../lib/maintenance-api";
import { isDirectRun } from "../lib/smoke-runtime.mjs";
import type { StablecoinMeta } from "../../shared/types";

const ROOT = process.cwd();
const OUTPUT_PATH = resolve(ROOT, "agents/annotation-candidates.md");
const API_BASE_URL = process.env.PHAROS_API_BASE?.trim() || DEFAULT_MAINTENANCE_API_BASE_URL;
const API_KEY = process.env.PHAROS_API_KEY;
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

async function fetchWithTimeout(url: string, headers: Record<string, string>): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
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
  payload?: Record<string, unknown>;
  sourceUrl: string | null;
}

async function fetchTapeEvents(classFilter: string, sinceMs: number): Promise<TapeEventLite[] | null> {
  const request = buildMaintenanceApiRequest(API_PATHS.events(), API_KEY, API_BASE_URL);
  const url = new URL(request.url);
  url.searchParams.set("class", classFilter);
  url.searchParams.set("severityFloor", "warning");
  url.searchParams.set("since", String(sinceMs));
  url.searchParams.set("limit", "200");

  const res = await fetchWithTimeout(url.toString(), request.headers);
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
    event.severity === "critical"
      ? "high"
      : event.severity === "severe"
        ? "high"
        : event.severity === "warning"
          ? "med"
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

function indexExistingFingerprints(existingBody: string): Set<string> {
  // Walk the queue body, tracking the current `## date` section so each row's
  // identity (date + coinId + kind) is captured precisely. A plain substring
  // scan over the whole body is lossy: dates recur in editorial comments and
  // footers, so an `includes(date)` check degenerates and can suppress
  // legitimate new candidates.
  const seen = new Set<string>();
  let currentDate: string | null = null;
  for (const line of existingBody.split("\n")) {
    const header = line.match(/^##\s+(\d{4}-\d{2}-\d{2})\s*$/);
    if (header) {
      currentDate = header[1];
      continue;
    }
    if (currentDate == null) continue;
    const row = line.match(/^-\s+([^|]+?)\s+\|\s+([^|]+?)\s+\|\s+([^|]+?)\s+\|/);
    if (row) {
      const first = row[1]!.trim();
      const second = row[2]!.trim();
      const third = row[3]!.trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(first)) seen.add(`${first}|${second}|${third}`);
      else seen.add(`${currentDate}|${first}|${second}`);
    }
  }
  return seen;
}

function filterAgainstExisting(candidates: Candidate[], existingBody: string): Candidate[] {
  const existing = indexExistingFingerprints(existingBody);
  return candidates.filter((c) => !existing.has(`${c.date}|${c.coinId}|${c.kind}`));
}

function renderRow(c: Candidate): string {
  const sevTag = c.severity ? ` | severity: ${c.severity}` : "";
  return `- ${c.date} | ${c.coinId} | ${c.kind} | ${c.description} | source: ${c.source}${sevTag}`;
}

function renderAppendBlock(date: string, candidates: Candidate[], notes: string[]): string {
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

function buildFile(existingBody: string, appendBlock: string, todaysFooter: string): string {
  const trimmed = stripFooter(existingBody.trimEnd());
  const header =
    trimmed === ""
      ? "# Annotation candidates\n\nAppend-only queue feeding the `annotations-refresh` skill. Each row is a machine-found event for editorial review — promote, drop, or defer.\n"
      : "";
  const sections = [header, trimmed, appendBlock, todaysFooter].filter(Boolean);
  return (
    sections
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  );
}

async function main(): Promise<void> {
  const lookbackDays = DEFAULT_LOOKBACK_DAYS;
  const sinceMs = epochAt(lookbackDays);
  const today = todayIso();

  const { body: existingBody } = readExistingQueue();

  const notes: string[] = [];
  const collected: Candidate[] = [];

  const entries = loadPerCoinStablecoinEntries(ROOT);
  const coins = entries.map((entry) => entry.coin);
  const resolveCoinId = buildCoinIdResolver(coins);

  const [depegEvents, blacklistEvents] = await Promise.all([
    fetchTapeEvents("depeg", sinceMs),
    fetchTapeEvents("freeze", sinceMs),
  ]);

  if (depegEvents == null) {
    notes.push(`depeg tape unreachable at ${API_BASE_URL} — skipped`);
  } else {
    for (const e of depegEvents) {
      const c = mapDepegCandidate(e);
      if (c) collected.push(c);
    }
  }

  if (blacklistEvents == null) {
    notes.push(`freeze tape unreachable at ${API_BASE_URL} — skipped`);
  } else {
    for (const e of blacklistEvents) {
      const c = mapBlacklistCandidate(e, resolveCoinId);
      if (c) collected.push(c);
    }
  }

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

if (isDirectRun(import.meta.url, process.argv[1])) {
  void main();
}
