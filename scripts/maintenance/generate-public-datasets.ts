/**
 * Generate public dataset mirrors + Sheets-friendly CSVs (ideas 11.7 + 11.8 fused).
 *
 * Reads from W2-A's daily snapshot API (`GET /api/snapshots/<YYYY-MM-DD>.json`)
 * plus the depeg-events API for the depeg-history topic. Emits:
 *
 *   public/datasets/<topic>/latest.{csv,json,ndjson}
 *   public/datasets/<topic>/<YYYY-MM-DD>.{csv,json,ndjson}     (90-day retention)
 *   public/sheets/<topic>.csv                                  (flat, IMPORTDATA-friendly)
 *
 * Topics: top-stablecoins, depeg-history, scores-latest, peg-mechanism-distribution.
 *
 * `--check` mode: verify that `latest.*` files exist for each topic, carry a
 * recognizable preamble, and satisfy per-topic row floors. Does NOT re-fetch
 * (network-flakey in CI).
 *
 * Configure via env:
 *   PUBLIC_DATASETS_API_URL   — base API URL, e.g. `https://api.pharos.watch`
 *   SMOKE_API_BASE / API_BASE_URL — fallback bases (mirrors sync-digests)
 *   PUBLIC_DATASETS_API_KEY   — optional `X-API-Key` header
 *   PUBLIC_DATASETS_DATE      — optional ISO date to fetch (default: today UTC)
 *   PUBLIC_DATASETS_REQUIRE_API=1 — fail if no API base is configured
 *
 * When no API base is configured, valid checked-in mirrors are preserved for
 * local/PR validation builds. Production Pages workflows set
 * `PUBLIC_DATASETS_REQUIRE_API=1` so they fail closed instead of shipping stale
 * mirrors. Use `--allow-stub` or `PUBLIC_DATASETS_ALLOW_STUB=1` only for
 * explicit local placeholder regeneration.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_DATASET_TOPICS, type PublicDatasetTopic } from "../../shared/lib/api-endpoints/datasets";
import type { DepegEvent } from "../../shared/types/market";
import { getMechanismArchetypeLabel } from "../../shared/lib/classification/mechanism-archetypes";
import { DEPEG_DEWS_METHODOLOGY_VERSION_LABEL } from "../../shared/lib/depeg-dews-version";
import { LIQUIDITY_METHODOLOGY_VERSION_LABEL } from "../../shared/lib/liquidity-score-version";
import { SITE_ORIGIN } from "../../shared/lib/runtime-origins";
import { SAFETY_SCORE_METHODOLOGY_VERSION_LABEL } from "../../shared/lib/safety-score-version";
import { TRACKED_STABLECOINS } from "../../shared/lib/stablecoins/registry";
import { getCirculatingRaw } from "../../shared/lib/supply";
import { isDirectRun, parseCheckMode } from "../lib/smoke-runtime.mjs";
import { type CsvColumn, escapeCsvField } from "../lib/csv-helpers";
import {
  generatorFetchHeaders,
  resolveGeneratorApiBase,
} from "../lib/sync-from-api";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const DATASETS_DIR = join(REPO_ROOT, "public/datasets");
const SHEETS_DIR = join(REPO_ROOT, "public/sheets");
const RETENTION_DAYS = 90;
const CHECK_MODE = parseCheckMode(process.argv);
const ALLOW_STUB_MODE = process.argv.includes("--allow-stub") || process.env.PUBLIC_DATASETS_ALLOW_STUB === "1";
const REQUIRE_API_SOURCE = process.env.PUBLIC_DATASETS_REQUIRE_API === "1";
const ROW_FLOORS: Readonly<Record<PublicDatasetTopic, number>> = {
  "top-stablecoins": 1,
  "depeg-history": 1,
  "scores-latest": 1,
  "peg-mechanism-distribution": 1,
};

interface SnapshotEnvelope {
  snapshotDate: string;
  generatedAt: number;
  methodologyVersions: Record<string, string>;
  stablecoins: Array<{
    id: string;
    name: string;
    symbol: string;
    pegType: string;
    pegMechanism: string;
    price: number | null;
    circulating: Record<string, number>;
    chains: string[];
  }>;
  reportCards: { scores?: Record<string, ReportCardScore> } | null;
  dews: Array<{ stablecoinId: string; score: number; band: string }>;
  liquidity: Array<{ stablecoinId: string; liquidityScore: number | null; coverageClass: string | null }>;
}

/**
 * Normalized view of a report-card entry shared between the snapshot and
 * live-endpoint-fallback paths. `score`/`grade` are the snapshot-shape fields;
 * `safetyScore`/`safetyGrade`/`overall` are live-endpoint aliases for the same
 * values. The `?? fallback` chains at the consumer site handle whichever shape
 * is present — do NOT consolidate to a single field.
 */
interface ReportCardScore {
  pegScore?: number;
  safetyScore?: number;
  score?: number;
  safetyGrade?: string;
  overall?: number;
  grade?: string;
}

interface StablecoinsResponse {
  peggedAssets?: SnapshotEnvelope["stablecoins"];
}

interface ReportCardsResponse {
  cards?: Array<{
    id: string;
    overallGrade?: string | null;
    overallScore?: number | null;
    rawInputs?: {
      pegScore?: number | null;
    };
  }>;
  methodology?: unknown;
  updatedAt?: number;
}

interface StressSignalsResponse {
  signals?: Record<string, { score?: number | null; band?: string | null }>;
  methodology?: unknown;
  updatedAt?: number;
}

interface DexLiquidityResponse {
  [stablecoinId: string]: {
    liquidityScore?: number | null;
    coverageClass?: string | null;
  };
}

function isoDateUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function resolveSnapshotDate(): string {
  return process.env.PUBLIC_DATASETS_DATE?.trim() || isoDateUtc(new Date());
}

async function safeFetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: generatorFetchHeaders() });
    if (!res.ok) {
      console.warn(`[generate-public-datasets] ${url} → HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[generate-public-datasets] ${url} fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function fetchSnapshot(apiBase: string, date: string): Promise<SnapshotEnvelope | null> {
  return safeFetchJson<SnapshotEnvelope>(`${apiBase}/api/snapshots/${date}.json`);
}

async function fetchDepegEvents(apiBase: string, cutoffSec?: number): Promise<DepegEvent[] | null> {
  const events: DepegEvent[] = [];
  let nextCursor: string | undefined;

  for (let page = 0; page < 100; page += 1) {
    const params = new URLSearchParams({ limit: "1000" });
    if (nextCursor) params.set("cursor", nextCursor);

    const payload = await safeFetchJson<{ events: DepegEvent[]; nextCursor?: string | null }>(
      `${apiBase}/api/depeg-events?${params.toString()}`,
    );
    if (!payload) return null;

    const batch = payload.events ?? [];
    events.push(...batch);

    const lastStartedAt = batch.at(-1)?.startedAt;
    if (
      batch.length === 0 ||
      !payload.nextCursor ||
      (cutoffSec != null && lastStartedAt != null && lastStartedAt < cutoffSec)
    ) {
      return events;
    }
    nextCursor = payload.nextCursor;
  }

  console.warn("[generate-public-datasets] depeg-events pagination hit the 100-page safety cap.");
  return events;
}

async function fetchLiveEndpointEnvelope(apiBase: string, snapshotDate: string): Promise<SnapshotEnvelope | null> {
  const [stablecoins, reportCards, stressSignals, dexLiquidity] = await Promise.all([
    safeFetchJson<StablecoinsResponse>(`${apiBase}/api/stablecoins`),
    safeFetchJson<ReportCardsResponse>(`${apiBase}/api/report-cards`),
    safeFetchJson<StressSignalsResponse>(`${apiBase}/api/stress-signals`),
    safeFetchJson<DexLiquidityResponse>(`${apiBase}/api/dex-liquidity`),
  ]);

  if (!stablecoins?.peggedAssets || !reportCards?.cards || !stressSignals?.signals || !dexLiquidity) {
    return null;
  }

  const scores: Record<string, ReportCardScore> = {};
  for (const card of reportCards.cards) {
    scores[card.id] = {
      pegScore: card.rawInputs?.pegScore ?? undefined,
      safetyScore: card.overallScore ?? undefined,
      score: card.overallScore ?? undefined,
      safetyGrade: card.overallGrade ?? undefined,
      overall: card.overallScore ?? undefined,
      grade: card.overallGrade ?? undefined,
    };
  }

  const dews = Object.entries(stressSignals.signals).map(([stablecoinId, signal]) => ({
    stablecoinId,
    score: signal.score ?? 0,
    band: signal.band ?? "unknown",
  }));

  const liquidity = Object.entries(dexLiquidity).map(([stablecoinId, row]) => ({
    stablecoinId,
    liquidityScore: row.liquidityScore ?? null,
    coverageClass: row.coverageClass ?? null,
  }));

  return {
    snapshotDate,
    generatedAt: Math.max(reportCards.updatedAt ?? 0, stressSignals.updatedAt ?? 0),
    methodologyVersions: {
      reportCards: JSON.stringify(reportCards.methodology ?? null),
      dews: JSON.stringify(stressSignals.methodology ?? null),
      source: "live-endpoint-fallback",
    },
    stablecoins: stablecoins.peggedAssets,
    reportCards: { scores },
    dews,
    liquidity,
  };
}

// --- CSV helpers ------------------------------------------------------------
// `escapeCsvField` + `CsvColumn` live in scripts/lib/csv-helpers.ts (imported
// above); the preamble-aware builders below are script-specific.

interface Preamble {
  endpoint: string;
  asOfISO: string;
  sourceUrl: string;
  methodologyLabel: string;
}

function preambleLine(p: Preamble): string {
  return `Pharos pharos.watch | Endpoint: ${p.endpoint} | As of: ${p.asOfISO} | URL: ${p.sourceUrl} | Methodology: ${p.methodologyLabel}`;
}

function buildCsv<T>(rows: T[], columns: CsvColumn<T>[], preamble: Preamble): string {
  const head = `# ${preambleLine(preamble)}`;
  const header = columns.map((c) => c.header).join(",");
  const body = rows.map((row, rowIndex) =>
    columns.map((c) => escapeCsvField(c.accessor(row, rowIndex))).join(","),
  );
  return [head, header, ...body].join("\n") + "\n";
}

function buildJson<T>(rows: T[], columns: CsvColumn<T>[], preamble: Preamble): string {
  const objects = rows.map((row, rowIndex) => {
    const obj: Record<string, string | number | null> = {};
    for (const column of columns) {
      obj[column.header] = column.accessor(row, rowIndex);
    }
    return obj;
  });
  return (
    JSON.stringify(
      {
        _meta: {
          endpoint: preamble.endpoint,
          asOfISO: preamble.asOfISO,
          sourceUrl: preamble.sourceUrl,
          methodologyLabel: preamble.methodologyLabel,
          rowCount: rows.length,
        },
        rows: objects,
      },
      null,
      2,
    ) + "\n"
  );
}

function buildNdjson<T>(rows: T[], columns: CsvColumn<T>[], preamble: Preamble): string {
  const meta = JSON.stringify({
    _meta: {
      endpoint: preamble.endpoint,
      asOfISO: preamble.asOfISO,
      sourceUrl: preamble.sourceUrl,
      methodologyLabel: preamble.methodologyLabel,
    },
  });
  const body = rows.map((row, rowIndex) => {
    const obj: Record<string, string | number | null> = {};
    for (const column of columns) {
      obj[column.header] = column.accessor(row, rowIndex);
    }
    return JSON.stringify(obj);
  });
  return [meta, ...body].join("\n") + "\n";
}

// --- Topic projections ------------------------------------------------------

interface TopStablecoinRow {
  id: string;
  name: string;
  symbol: string;
  pegType: string;
  pegMechanism: string;
  price: number | null;
  circulatingUsd: number;
  chainCount: number;
  chains: string;
}

const TOP_STABLECOINS_COLUMNS: CsvColumn<TopStablecoinRow>[] = [
  { header: "id", accessor: (r) => r.id },
  { header: "symbol", accessor: (r) => r.symbol },
  { header: "name", accessor: (r) => r.name },
  { header: "pegType", accessor: (r) => r.pegType },
  { header: "pegMechanism", accessor: (r) => r.pegMechanism },
  { header: "price", accessor: (r) => r.price ?? null },
  { header: "circulatingUsd", accessor: (r) => r.circulatingUsd },
  { header: "chainCount", accessor: (r) => r.chainCount },
  { header: "chains", accessor: (r) => r.chains },
];

function projectTopStablecoins(envelope: SnapshotEnvelope | null): TopStablecoinRow[] {
  if (!envelope) return [];
  return envelope.stablecoins
    .map((coin) => ({
      id: coin.id,
      name: coin.name,
      symbol: coin.symbol,
      pegType: coin.pegType,
      pegMechanism: coin.pegMechanism,
      price: coin.price,
      circulatingUsd: getCirculatingRaw(coin),
      chainCount: coin.chains.length,
      chains: coin.chains.join(";"),
    }))
    .sort((a, b) => b.circulatingUsd - a.circulatingUsd);
}

interface DepegHistoryRow {
  id: number;
  stablecoinId: string;
  symbol: string;
  direction: "above" | "below";
  peakDeviationBps: number;
  startedAtISO: string;
  endedAtISO: string | null;
  durationSec: number | null;
  startPrice: number;
  peakPrice: number | null;
  recoveryPrice: number | null;
  pegReference: number;
  source: "live" | "backfill";
}

const DEPEG_HISTORY_COLUMNS: CsvColumn<DepegHistoryRow>[] = [
  { header: "id", accessor: (r) => String(r.id) },
  { header: "stablecoinId", accessor: (r) => r.stablecoinId },
  { header: "symbol", accessor: (r) => r.symbol },
  { header: "direction", accessor: (r) => r.direction },
  { header: "peakDeviationBps", accessor: (r) => r.peakDeviationBps },
  { header: "startedAtISO", accessor: (r) => r.startedAtISO },
  { header: "endedAtISO", accessor: (r) => r.endedAtISO },
  { header: "durationSec", accessor: (r) => r.durationSec },
  { header: "startPrice", accessor: (r) => r.startPrice },
  { header: "peakPrice", accessor: (r) => r.peakPrice },
  { header: "recoveryPrice", accessor: (r) => r.recoveryPrice },
  { header: "pegReference", accessor: (r) => r.pegReference },
  { header: "source", accessor: (r) => r.source },
];

function projectDepegHistory(events: DepegEvent[], snapshotDate: string): DepegHistoryRow[] {
  const cutoffSec = cutoffSecForSnapshotDate(snapshotDate);
  return events
    .filter((event) => event.startedAt >= cutoffSec)
    .map((event) => ({
      id: event.id,
      stablecoinId: event.stablecoinId,
      symbol: event.symbol,
      direction: event.direction,
      peakDeviationBps: event.peakDeviationBps,
      startedAtISO: new Date(event.startedAt * 1000).toISOString(),
      endedAtISO: event.endedAt ? new Date(event.endedAt * 1000).toISOString() : null,
      durationSec: event.endedAt ? event.endedAt - event.startedAt : null,
      startPrice: event.startPrice,
      peakPrice: event.peakPrice,
      recoveryPrice: event.recoveryPrice,
      pegReference: event.pegReference,
      source: event.source,
    }))
    .sort((a, b) => b.startedAtISO.localeCompare(a.startedAtISO) || a.id - b.id);
}

interface ScoreLatestRow {
  stablecoinId: string;
  symbol: string;
  pegScore: number | null;
  safetyScore: number | null;
  safetyGrade: string | null;
  dewsScore: number | null;
  dewsBand: string | null;
  liquidityScore: number | null;
  coverageClass: string | null;
}

const SCORES_LATEST_COLUMNS: CsvColumn<ScoreLatestRow>[] = [
  { header: "stablecoinId", accessor: (r) => r.stablecoinId },
  { header: "symbol", accessor: (r) => r.symbol },
  { header: "pegScore", accessor: (r) => r.pegScore },
  { header: "safetyScore", accessor: (r) => r.safetyScore },
  { header: "safetyGrade", accessor: (r) => r.safetyGrade },
  { header: "dewsScore", accessor: (r) => r.dewsScore },
  { header: "dewsBand", accessor: (r) => r.dewsBand },
  { header: "liquidityScore", accessor: (r) => r.liquidityScore },
  { header: "coverageClass", accessor: (r) => r.coverageClass },
];

function projectScoresLatest(envelope: SnapshotEnvelope | null): ScoreLatestRow[] {
  if (!envelope) return [];
  const reportCardScores = envelope.reportCards?.scores ?? {};
  const dewsByCoin = new Map(envelope.dews.map((row) => [row.stablecoinId, row]));
  const liquidityByCoin = new Map(envelope.liquidity.map((row) => [row.stablecoinId, row]));

  return envelope.stablecoins
    .map((coin) => {
      const reportCard = reportCardScores[coin.id] ?? null;
      const dews = dewsByCoin.get(coin.id) ?? null;
      const liquidity = liquidityByCoin.get(coin.id) ?? null;
      return {
        stablecoinId: coin.id,
        symbol: coin.symbol,
        pegScore: reportCard?.pegScore ?? null,
        safetyScore: reportCard?.safetyScore ?? reportCard?.score ?? reportCard?.overall ?? null,
        safetyGrade: reportCard?.safetyGrade ?? reportCard?.grade ?? null,
        dewsScore: dews?.score ?? null,
        dewsBand: dews?.band ?? null,
        liquidityScore: liquidity?.liquidityScore ?? null,
        coverageClass: liquidity?.coverageClass ?? null,
      };
    })
    .sort((a, b) => (b.pegScore ?? -1) - (a.pegScore ?? -1));
}

interface PegMechanismDistributionRow {
  mechanismArchetype: string;
  mechanismLabel: string;
  pegReferenceId: string;
  jurisdiction: string;
  coinCount: number;
}

const PEG_MECHANISM_COLUMNS: CsvColumn<PegMechanismDistributionRow>[] = [
  { header: "mechanismArchetype", accessor: (r) => r.mechanismArchetype },
  { header: "mechanismLabel", accessor: (r) => r.mechanismLabel },
  { header: "pegReferenceId", accessor: (r) => r.pegReferenceId },
  { header: "jurisdiction", accessor: (r) => r.jurisdiction },
  { header: "coinCount", accessor: (r) => r.coinCount },
];

function projectPegMechanismDistribution(): PegMechanismDistributionRow[] {
  const counts = new Map<string, PegMechanismDistributionRow>();
  for (const coin of TRACKED_STABLECOINS) {
    const archetype = coin.mechanismArchetype ?? "unknown";
    const pegReferenceId = coin.pegReferenceId ?? "unknown";
    const jurisdiction = coin.jurisdiction?.country ?? "unknown";
    const key = `${archetype}|${pegReferenceId}|${jurisdiction}`;
    const existing = counts.get(key);
    if (existing) {
      existing.coinCount += 1;
    } else {
      counts.set(key, {
        mechanismArchetype: archetype,
        mechanismLabel: archetype === "unknown" ? "Unknown" : getMechanismArchetypeLabel(coin.mechanismArchetype!),
        pegReferenceId,
        jurisdiction,
        coinCount: 1,
      });
    }
  }
  return Array.from(counts.values()).sort((a, b) => b.coinCount - a.coinCount);
}

// --- Per-topic metadata + write loop ----------------------------------------

interface TopicSpec<T> {
  topic: PublicDatasetTopic;
  rows: T[];
  columns: CsvColumn<T>[];
  /** Methodology label for the preamble. */
  methodologyLabel: string;
  /** Sheets-friendly column subset (flat-only — no nested cells). */
  sheetColumns: CsvColumn<T>[];
}

function topicPreamble(
  topic: PublicDatasetTopic,
  methodologyLabel: string,
  asOfISO: string,
  variant: "csv" | "json" | "ndjson",
): Preamble {
  return {
    endpoint: topic,
    asOfISO,
    sourceUrl: `${SITE_ORIGIN}/datasets/${topic}/latest.${variant}`,
    methodologyLabel,
  };
}

function sheetPreamble(topic: PublicDatasetTopic, methodologyLabel: string, asOfISO: string): Preamble {
  return {
    endpoint: topic,
    asOfISO,
    sourceUrl: `${SITE_ORIGIN}/sheets/${topic}.csv`,
    methodologyLabel,
  };
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeArtifact(path: string, contents: string): { changed: boolean } {
  const previous = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (previous === contents) {
    return { changed: false };
  }
  ensureDir(dirname(path));
  writeFileSync(path, contents, "utf8");
  return { changed: true };
}

function pruneOldSnapshots(topicDir: string, snapshotDate: string): number {
  if (!existsSync(topicDir)) return 0;
  const cutoffMs = new Date(`${snapshotDate}T00:00:00Z`).getTime() - RETENTION_DAYS * 86_400_000;
  const cutoffDate = isoDateUtc(new Date(cutoffMs));
  let removed = 0;
  for (const name of readdirSync(topicDir)) {
    const match = /^(\d{4}-\d{2}-\d{2})\.(csv|json|ndjson)$/.exec(name);
    if (!match) continue;
    if (match[1] < cutoffDate) {
      rmSync(join(topicDir, name));
      removed += 1;
    }
  }
  return removed;
}

function writeTopic<T>(
  spec: TopicSpec<T>,
  snapshotDate: string,
  asOfISO: string,
): { dated: string[]; written: number } {
  const topicDir = join(DATASETS_DIR, spec.topic);
  const csv = buildCsv(spec.rows, spec.columns, topicPreamble(spec.topic, spec.methodologyLabel, asOfISO, "csv"));
  const json = buildJson(spec.rows, spec.columns, topicPreamble(spec.topic, spec.methodologyLabel, asOfISO, "json"));
  const ndjson = buildNdjson(
    spec.rows,
    spec.columns,
    topicPreamble(spec.topic, spec.methodologyLabel, asOfISO, "ndjson"),
  );

  const targets = [
    { path: join(topicDir, "latest.csv"), contents: csv },
    { path: join(topicDir, "latest.json"), contents: json },
    { path: join(topicDir, "latest.ndjson"), contents: ndjson },
    { path: join(topicDir, `${snapshotDate}.csv`), contents: csv },
    { path: join(topicDir, `${snapshotDate}.json`), contents: json },
    { path: join(topicDir, `${snapshotDate}.ndjson`), contents: ndjson },
  ];

  let written = 0;
  for (const target of targets) {
    const result = writeArtifact(target.path, target.contents);
    if (result.changed) written += 1;
  }

  const sheetPreambleObj = sheetPreamble(spec.topic, spec.methodologyLabel, asOfISO);
  const sheetCsv = buildCsv(spec.rows, spec.sheetColumns, sheetPreambleObj);
  const sheetResult = writeArtifact(join(SHEETS_DIR, `${spec.topic}.csv`), sheetCsv);
  if (sheetResult.changed) written += 1;

  return { dated: [`${snapshotDate}.csv`, `${snapshotDate}.json`, `${snapshotDate}.ndjson`], written };
}

interface ArtifactDirs {
  datasetsDir: string;
  sheetsDir: string;
}

const DEFAULT_ARTIFACT_DIRS: ArtifactDirs = {
  datasetsDir: DATASETS_DIR,
  sheetsDir: SHEETS_DIR,
};

function readJsonRowCount(path: string, topic: PublicDatasetTopic): number | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { _meta?: { endpoint?: string; rowCount?: unknown } };
    if (parsed._meta?.endpoint !== topic) return null;
    return typeof parsed._meta.rowCount === "number" ? parsed._meta.rowCount : null;
  } catch {
    return null;
  }
}

function validateTopicRowFloor(topic: PublicDatasetTopic, rows: readonly unknown[]): void {
  const floor = ROW_FLOORS[topic];
  if (rows.length < floor) {
    throw new Error(`Public dataset ${topic} has ${rows.length} rows; expected at least ${floor}.`);
  }
}

function checkTopic(
  topic: PublicDatasetTopic,
  dirs: ArtifactDirs = DEFAULT_ARTIFACT_DIRS,
): { ok: boolean; reason?: string } {
  const topicDir = join(dirs.datasetsDir, topic);
  const required = [
    join(topicDir, "latest.csv"),
    join(topicDir, "latest.json"),
    join(topicDir, "latest.ndjson"),
    join(dirs.sheetsDir, `${topic}.csv`),
  ];
  for (const path of required) {
    if (!existsSync(path)) {
      return { ok: false, reason: `${path} missing` };
    }
    const head = readFileSync(path, "utf8").slice(0, 512);
    const hasCsvPreamble = head.startsWith("# Pharos pharos.watch");
    const hasJsonMeta = head.includes(`"_meta"`) && head.includes(`"endpoint": "${topic}"`);
    const hasNdjsonMeta = head.startsWith(`{"_meta":`) && head.includes(`"endpoint":"${topic}"`);
    if (!hasCsvPreamble && !hasJsonMeta && !hasNdjsonMeta) {
      return { ok: false, reason: `${path} missing preamble` };
    }
  }
  const rowCount = readJsonRowCount(join(topicDir, "latest.json"), topic);
  const floor = ROW_FLOORS[topic];
  if (rowCount == null) {
    return { ok: false, reason: `${join(topicDir, "latest.json")} missing numeric _meta.rowCount` };
  }
  if (rowCount < floor) {
    return { ok: false, reason: `${topic} rowCount ${rowCount} below required floor ${floor}` };
  }
  return { ok: true };
}

interface PublicDatasetLiveInputs {
  envelope: SnapshotEnvelope;
  depegEvents: DepegEvent[];
  effectiveSnapshotDate: string;
  asOfISO: string;
}

function cutoffSecForSnapshotDate(snapshotDate: string): number {
  return Math.floor(new Date(`${snapshotDate}T00:00:00Z`).getTime() / 1000) - RETENTION_DAYS * 86_400;
}

function asOfIsoFromEnvelope(envelope: SnapshotEnvelope, snapshotDate: string): string {
  if (envelope.methodologyVersions.source === "live-endpoint-fallback") {
    return new Date(Math.max(Date.now(), envelope.generatedAt * 1000)).toISOString();
  }
  return envelope.generatedAt > 0
    ? new Date(envelope.generatedAt * 1000).toISOString()
    : `${snapshotDate}T00:00:00.000Z`;
}

async function fetchLatestSnapshotDate(apiBase: string): Promise<string | null> {
  const indexPayload = await safeFetchJson<{ snapshots: Array<{ snapshotDate: string }> }>(
    `${apiBase}/api/snapshots/index`,
  );
  return indexPayload?.snapshots[0]?.snapshotDate ?? null;
}

export async function loadPublicDatasetLiveInputs(
  apiBase: string,
  requestedSnapshotDate: string,
): Promise<PublicDatasetLiveInputs> {
  let effectiveSnapshotDate = requestedSnapshotDate;
  let envelope = await fetchSnapshot(apiBase, requestedSnapshotDate);
  if (!envelope) {
    const latestDate = await fetchLatestSnapshotDate(apiBase);
    if (latestDate && latestDate !== requestedSnapshotDate) {
      effectiveSnapshotDate = latestDate;
      envelope = await fetchSnapshot(apiBase, latestDate);
    }
  }
  if (!envelope) {
    console.warn(
      `[generate-public-datasets] Snapshot API unavailable for ${requestedSnapshotDate}; falling back to current live endpoints.`,
    );
    envelope = await fetchLiveEndpointEnvelope(apiBase, effectiveSnapshotDate);
  }
  if (!envelope) {
    throw new Error(
      `Unable to fetch public snapshot or live endpoint fallback for ${requestedSnapshotDate}.`,
    );
  }
  effectiveSnapshotDate = envelope.snapshotDate || effectiveSnapshotDate;
  const asOfISO = asOfIsoFromEnvelope(envelope, effectiveSnapshotDate);

  const depegEvents = await fetchDepegEvents(apiBase, cutoffSecForSnapshotDate(effectiveSnapshotDate));
  if (!depegEvents) {
    throw new Error("Unable to fetch depeg events for public dataset generation.");
  }

  return { envelope, depegEvents, effectiveSnapshotDate, asOfISO };
}

function buildTopicSpecs(
  envelope: SnapshotEnvelope | null,
  depegEvents: DepegEvent[],
  snapshotDate: string,
): TopicSpec<unknown>[] {
  return [
    {
      topic: "top-stablecoins",
      rows: projectTopStablecoins(envelope),
      columns: TOP_STABLECOINS_COLUMNS,
      methodologyLabel: `safety-score ${SAFETY_SCORE_METHODOLOGY_VERSION_LABEL}`,
      sheetColumns: TOP_STABLECOINS_COLUMNS,
    } as TopicSpec<TopStablecoinRow> as TopicSpec<unknown>,
    {
      topic: "depeg-history",
      rows: projectDepegHistory(depegEvents, snapshotDate),
      columns: DEPEG_HISTORY_COLUMNS,
      methodologyLabel: `depeg-dews ${DEPEG_DEWS_METHODOLOGY_VERSION_LABEL}`,
      sheetColumns: DEPEG_HISTORY_COLUMNS,
    } as TopicSpec<DepegHistoryRow> as TopicSpec<unknown>,
    {
      topic: "scores-latest",
      rows: projectScoresLatest(envelope),
      columns: SCORES_LATEST_COLUMNS,
      methodologyLabel: `safety-score ${SAFETY_SCORE_METHODOLOGY_VERSION_LABEL} | dews ${DEPEG_DEWS_METHODOLOGY_VERSION_LABEL} | liquidity ${LIQUIDITY_METHODOLOGY_VERSION_LABEL}`,
      sheetColumns: SCORES_LATEST_COLUMNS,
    } as TopicSpec<ScoreLatestRow> as TopicSpec<unknown>,
    {
      topic: "peg-mechanism-distribution",
      rows: projectPegMechanismDistribution(),
      columns: PEG_MECHANISM_COLUMNS,
      methodologyLabel: `safety-score ${SAFETY_SCORE_METHODOLOGY_VERSION_LABEL}`,
      sheetColumns: PEG_MECHANISM_COLUMNS,
    } as TopicSpec<PegMechanismDistributionRow> as TopicSpec<unknown>,
  ];
}

export const testExports = {
  buildTopicSpecs,
  checkTopic,
  cutoffSecForSnapshotDate,
  projectDepegHistory,
  validateTopicRowFloor,
};

function checkAllTopics(dirs: ArtifactDirs = DEFAULT_ARTIFACT_DIRS): { ok: boolean; reason?: string } {
  for (const topic of PUBLIC_DATASET_TOPICS) {
    const result = checkTopic(topic, dirs);
    if (!result.ok) return result;
  }
  return { ok: true };
}

// --- Main -------------------------------------------------------------------

async function main(): Promise<void> {
  const requestedSnapshotDate = resolveSnapshotDate();
  let snapshotDate = requestedSnapshotDate;

  if (CHECK_MODE) {
    for (const topic of PUBLIC_DATASET_TOPICS) {
      const result = checkTopic(topic);
      if (!result.ok) {
        console.error(
          `Public dataset mirrors are out of date. Run \`tsx scripts/maintenance/generate-public-datasets.ts\`. (${result.reason})`,
        );
        process.exit(1);
      }
    }
    console.log("Public dataset mirrors are current");
    return;
  }

  const apiBase = resolveGeneratorApiBase();
  let envelope: SnapshotEnvelope | null = null;
  let depegEvents: DepegEvent[] = [];
  let asOfISO = `${snapshotDate}T00:00:00.000Z`;

  if (apiBase) {
    const liveInputs = await loadPublicDatasetLiveInputs(apiBase, requestedSnapshotDate);
    envelope = liveInputs.envelope;
    depegEvents = liveInputs.depegEvents;
    snapshotDate = liveInputs.effectiveSnapshotDate;
    asOfISO = liveInputs.asOfISO;
    if (snapshotDate !== requestedSnapshotDate) {
      console.log(
        `[generate-public-datasets] Requested snapshot ${requestedSnapshotDate} unavailable; using latest snapshot ${snapshotDate}.`,
      );
    }
  } else {
    if (REQUIRE_API_SOURCE) {
      throw new Error(
        "No public dataset API source configured. Set PUBLIC_DATASETS_API_URL, SMOKE_API_BASE, or API_BASE_URL; use --allow-stub only for explicit local placeholder regeneration.",
      );
    }
    if (!ALLOW_STUB_MODE) {
      const existing = checkAllTopics();
      if (existing.ok) {
        console.log(
          "[generate-public-datasets] No PUBLIC_DATASETS_API_URL / SMOKE_API_BASE / API_BASE_URL set; preserving checked-in public dataset mirrors.",
        );
        return;
      }
      throw new Error(
        `No public dataset API source configured and checked-in mirrors are not current. Set PUBLIC_DATASETS_API_URL, SMOKE_API_BASE, or API_BASE_URL; use --allow-stub only for explicit local placeholder regeneration. (${existing.reason})`,
      );
    }
    console.log(
      "[generate-public-datasets] No PUBLIC_DATASETS_API_URL / SMOKE_API_BASE / API_BASE_URL set; emitting explicit stub mirrors.",
    );
  }

  const specs = buildTopicSpecs(envelope, depegEvents, snapshotDate);
  if (apiBase) {
    for (const spec of specs) {
      validateTopicRowFloor(spec.topic, spec.rows);
    }
  }

  ensureDir(DATASETS_DIR);
  ensureDir(SHEETS_DIR);

  let totalWritten = 0;
  let totalPruned = 0;
  for (const spec of specs) {
    const result = writeTopic(spec as TopicSpec<unknown>, snapshotDate, asOfISO);
    totalWritten += result.written;
    totalPruned += pruneOldSnapshots(join(DATASETS_DIR, spec.topic), snapshotDate);
  }

  console.log(
    `Generated public dataset mirrors for ${PUBLIC_DATASET_TOPICS.length} topics ` +
      `(snapshotDate=${snapshotDate}, wrote ${totalWritten}, pruned ${totalPruned}).`,
  );
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
