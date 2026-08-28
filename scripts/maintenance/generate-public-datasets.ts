/**
 * Generate public dataset snapshots + stable latest/Sheets aliases (ideas 11.7 + 11.8 fused).
 *
 * Reads from W2-A's daily snapshot API (`GET /api/snapshots/<YYYY-MM-DD>.json`)
 * plus the depeg-events API for the depeg-history topic. Emits:
 *
 *   public/datasets/<topic>/<YYYY-MM-DD>.{csv,json,ndjson}     (90-day retention)
 *
 * A generated block in `public/_redirects` serves both `/datasets/<topic>/latest.*`
 * and IMPORTDATA-friendly `/sheets/<topic>.csv` URLs as 200 rewrites to the dated
 * files. No byte-identical alias files are written.
 *
 * Topics: top-stablecoins, depeg-history, scores-latest, peg-mechanism-distribution.
 *
 * `--check` mode: verify that every latest/Sheets rewrite resolves directly to
 * an existing dated file, that artifacts carry recognizable preambles, and that
 * each topic satisfies its row floor. Does NOT re-fetch (network-flakey in CI).
 *
 * Configure via env:
 *   PUBLIC_DATASETS_API_URL   — base API URL, e.g. `https://api.pharos.watch`
 *   SMOKE_API_BASE / API_BASE_URL — fallback bases (mirrors sync-digests)
 *   PUBLIC_DATASETS_API_KEY   — optional `X-API-Key` header
 *   PUBLIC_DATASETS_DATE      — optional ISO date to fetch (default: today UTC); historical dates require the matching snapshot
 *   PUBLIC_DATASETS_REQUIRE_API=1 — fail if no API base is configured
 *   PUBLIC_DATASETS_ALLOW_EXISTING_ON_FETCH_FAILURE=1 — preserve valid mirrors if live fetch fails
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
import { PUBLIC_DATASET_TOPICS, type PublicDatasetTopic } from "@shared/lib/api-endpoints/datasets";
import type { DepegEvent } from "@shared/types/market";
import { getMechanismArchetypeLabel } from "@shared/lib/classification/mechanism-archetypes";
import { DEPEG_DEWS_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/depeg-dews";
import { LIQUIDITY_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/liquidity-score";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { SAFETY_SCORE_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/safety-score";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { getCirculatingRaw } from "@shared/lib/supply";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/stablecoin-taxonomy";
import {
  PublicSnapshotEnvelopeSchema,
  type PublicSnapshotEnvelope,
  type PublicSnapshotEnvelopeV2,
} from "@shared/types/public-snapshot";
import { isDirectRun, parseCheckMode } from "../lib/smoke-runtime.mjs";
import { type CsvColumn, escapeCsvField } from "@shared/lib/csv";
import {
  RELEASE_DATA_FALLBACK_ENV_NAME,
  generatorFetchHeaders,
  resolveApiPathUrl,
  resolveGeneratorApiBase,
  shouldAllowExistingDataOnFetchFailure,
} from "../lib/sync-from-api";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const DATASETS_DIR = join(REPO_ROOT, "public/datasets");
const REDIRECTS_PATH = join(REPO_ROOT, "public/_redirects");
const CURRENT_DATASET_MODULE_PATH = join(REPO_ROOT, "src/generated/public-dataset-current.ts");
const RETENTION_DAYS = 90;
const REDIRECT_BLOCK_START = "# BEGIN GENERATED PUBLIC DATASET ALIASES";
const REDIRECT_BLOCK_END = "# END GENERATED PUBLIC DATASET ALIASES";
const CHECK_MODE = parseCheckMode(process.argv);
const ALLOW_STUB_MODE = process.argv.includes("--allow-stub") || process.env.PUBLIC_DATASETS_ALLOW_STUB === "1";
const REQUIRE_API_SOURCE = process.env.PUBLIC_DATASETS_REQUIRE_API === "1";
const ROW_FLOORS: Readonly<Record<PublicDatasetTopic, number>> = {
  "top-stablecoins": 493,
  // A fixed live-generation floor is invalid for this rolling window because
  // legitimate event volume can decline. Live generation separately proves that
  // the fetched source crosses the retention boundary before accepting the
  // projection. Checked artifacts keep a legacy floor below to reject obviously
  // truncated mirrors when raw source coverage is unavailable in the artifact.
  "depeg-history": 1,
  "scores-latest": 493,
  "peg-mechanism-distribution": 99,
};
const CHECK_ROW_FLOORS: Readonly<Record<PublicDatasetTopic, number>> = {
  ...ROW_FLOORS,
  "depeg-history": 300,
};
const FRESHNESS_CONTRACT = "point-in-time sample; not guaranteed to track production freshness";

type SnapshotEnvelope = Pick<PublicSnapshotEnvelopeV2, "snapshotDate" | "generatedAt" | "stablecoins"> & {
  methodologyVersions?: Record<string, string>;
  reportCards: {
    scores?: Record<string, ReportCardScore>;
    cards?: Array<{
      id: string;
      score: number | null;
      grade: string;
    }>;
  } | null;
  dews: Array<{ stablecoinId: string; score: number; band: string }>;
  liquidity: Array<{ stablecoinId: string; liquidityScore: number | null; coverageClass: string | null }>;
};

/**
 * Normalized view of a safety-score entry. The aliases remain only so dated
 * pre-V9 public snapshots can still be projected.
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
    grade: string;
    score: number | null;
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

function isHistoricalSnapshotDate(snapshotDate: string): boolean {
  return snapshotDate !== isoDateUtc(new Date());
}

function resolveSnapshotDate(): string {
  return process.env.PUBLIC_DATASETS_DATE?.trim() || isoDateUtc(new Date());
}

async function safeFetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: generatorFetchHeaders(url) });
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
  const url = resolveApiPathUrl(apiBase, `/api/snapshots/${date}.json`);
  const payload = await safeFetchJson<unknown>(url);
  if (payload == null) return null;

  const parsed = PublicSnapshotEnvelopeSchema.safeParse(payload);
  if (!parsed.success || !isProjectionEnvelope(parsed.data)) {
    console.warn(`[generate-public-datasets] ${url} returned an invalid public snapshot envelope`);
    return null;
  }
  return parsed.data;
}

function isProjectionEnvelope(envelope: PublicSnapshotEnvelope): envelope is PublicSnapshotEnvelope & SnapshotEnvelope {
  return (
    typeof envelope.snapshotDate === "string"
    && typeof envelope.generatedAt === "number"
    && Array.isArray(envelope.stablecoins)
    && envelope.stablecoins.every((coin) => (
      typeof coin.name === "string"
      && typeof coin.symbol === "string"
      && typeof coin.pegType === "string"
      && typeof coin.pegMechanism === "string"
      && (typeof coin.price === "number" || coin.price === null)
      && typeof coin.circulating === "object"
      && coin.circulating !== null
      && Array.isArray(coin.chains)
    ))
    && (envelope.reportCards === null || (typeof envelope.reportCards === "object" && envelope.reportCards !== null))
    && Array.isArray(envelope.dews)
    && envelope.dews.every((row) => typeof row.score === "number" && typeof row.band === "string")
    && Array.isArray(envelope.liquidity)
    && envelope.liquidity.every((row) => (
      (typeof row.liquidityScore === "number" || row.liquidityScore === null)
      && (typeof row.coverageClass === "string" || row.coverageClass === null)
    ))
  );
}

async function fetchDepegEvents(apiBase: string): Promise<DepegEvent[] | null> {
  const events: DepegEvent[] = [];
  const seenCursors = new Set<string>();
  let nextCursor: string | undefined;

  for (let page = 0; page < 100; page += 1) {
    const params = new URLSearchParams({ limit: "1000" });
    if (nextCursor) params.set("cursor", nextCursor);

    const payload = await safeFetchJson<{ events: DepegEvent[]; nextCursor?: string | null }>(
      resolveApiPathUrl(apiBase, `/api/depeg-events?${params.toString()}`),
    );
    if (!payload) return null;

    const batch = payload.events ?? [];
    events.push(...batch);

    if (!payload.nextCursor) return events;
    if (batch.length === 0) {
      throw new Error("Depeg event pagination returned an empty page with a continuation cursor.");
    }
    if (seenCursors.has(payload.nextCursor)) {
      throw new Error(`Depeg event pagination repeated cursor "${payload.nextCursor}".`);
    }
    seenCursors.add(payload.nextCursor);
    nextCursor = payload.nextCursor;
  }

  throw new Error("Depeg event pagination hit the 100-page safety cap before exhaustion.");
}

async function fetchLiveEndpointEnvelope(apiBase: string, snapshotDate: string): Promise<SnapshotEnvelope | null> {
  const [stablecoins, reportCards, stressSignals, dexLiquidity] = await Promise.all([
    safeFetchJson<StablecoinsResponse>(resolveApiPathUrl(apiBase, "/api/stablecoins")),
    safeFetchJson<ReportCardsResponse>(resolveApiPathUrl(apiBase, "/api/report-cards/v9")),
    safeFetchJson<StressSignalsResponse>(resolveApiPathUrl(apiBase, "/api/stress-signals")),
    safeFetchJson<DexLiquidityResponse>(resolveApiPathUrl(apiBase, "/api/dex-liquidity")),
  ]);

  if (!stablecoins?.peggedAssets || !reportCards?.cards || !stressSignals?.signals || !dexLiquidity) {
    return null;
  }

  const scores: Record<string, ReportCardScore> = {};
  for (const card of reportCards.cards) {
    scores[card.id] = {
      safetyScore: card.score ?? undefined,
      score: card.score ?? undefined,
      safetyGrade: card.grade,
      overall: card.score ?? undefined,
      grade: card.grade,
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
// `escapeCsvField` + `CsvColumn` come from shared/lib/csv.ts (imported above);
// the preamble-aware builders below are script-specific.

interface Preamble {
  endpoint: string;
  asOfISO: string;
  sourceUrl: string;
  methodologyLabel: string;
  metadataStatus?: "approximated";
  metadataNote?: string;
}

function preambleLine(p: Preamble): string {
  const metadata = p.metadataStatus
    ? ` | Metadata: ${p.metadataStatus}${p.metadataNote ? ` (${p.metadataNote})` : ""}`
    : "";
  return `Pharos pharos.watch | Endpoint: ${p.endpoint} | As of: ${p.asOfISO} | URL: ${p.sourceUrl} | Methodology: ${p.methodologyLabel} | Freshness: ${FRESHNESS_CONTRACT}${metadata}`;
}

function buildCsv<T>(rows: T[], columns: CsvColumn<T>[], preamble: Preamble): string {
  const head = `# ${preambleLine(preamble)}`;
  const header = columns.map((c) => c.header).join(",");
  const body = rows.map((row, rowIndex) => columns.map((c) => escapeCsvField(c.accessor(row, rowIndex))).join(","));
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
          freshnessContract: FRESHNESS_CONTRACT,
          ...(preamble.metadataStatus
            ? { metadataStatus: preamble.metadataStatus, metadataNote: preamble.metadataNote }
            : {}),
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
      freshnessContract: FRESHNESS_CONTRACT,
      ...(preamble.metadataStatus
        ? { metadataStatus: preamble.metadataStatus, metadataNote: preamble.metadataNote }
        : {}),
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
  const snapshotEndSec = snapshotEndSecForDate(snapshotDate);
  return events
    .filter((event) => event.startedAt >= cutoffSec && event.startedAt <= snapshotEndSec)
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
  const reportCardScores: Record<string, ReportCardScore> =
    envelope.reportCards?.scores ??
    Object.fromEntries(
      (envelope.reportCards?.cards ?? []).map((card) => [
        card.id,
        {
          safetyScore: card.score ?? undefined,
          score: card.score ?? undefined,
          safetyGrade: card.grade,
          grade: card.grade,
        },
      ]),
    );
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
    .sort((a, b) => (b.safetyScore ?? -1) - (a.safetyScore ?? -1));
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

interface PegCatalogFields {
  mechanismArchetype?: string | null;
  pegReferenceId?: string | null;
  jurisdiction?: { country?: string | null } | null;
}

interface PegMechanismProjection {
  rows: PegMechanismDistributionRow[];
  metadataStatus?: "approximated";
  metadataNote?: string;
}

function projectPegMechanismRows(coins: readonly PegCatalogFields[]): PegMechanismDistributionRow[] {
  const counts = new Map<string, PegMechanismDistributionRow>();
  for (const coin of coins) {
    const archetype = coin.mechanismArchetype ?? "unknown";
    const pegReferenceId = coin.pegReferenceId ?? "unknown";
    const jurisdiction = coin.jurisdiction?.country ?? "unknown";
    const key = `${archetype}|${pegReferenceId}|${jurisdiction}`;
    const existing = counts.get(key);
    if (existing) {
      existing.coinCount += 1;
    } else {
      const knownArchetype = MECHANISM_ARCHETYPE_VALUES.includes(
        archetype as (typeof MECHANISM_ARCHETYPE_VALUES)[number],
      );
      counts.set(key, {
        mechanismArchetype: archetype,
        mechanismLabel: knownArchetype
          ? getMechanismArchetypeLabel(archetype as (typeof MECHANISM_ARCHETYPE_VALUES)[number])
          : "Unknown",
        pegReferenceId,
        jurisdiction,
        coinCount: 1,
      });
    }
  }
  return Array.from(counts.values()).sort((a, b) => b.coinCount - a.coinCount);
}

function hasSnapshotCatalogFields(coin: SnapshotEnvelope["stablecoins"][number]): boolean {
  return (
    Object.prototype.hasOwnProperty.call(coin, "mechanismArchetype")
    && Object.prototype.hasOwnProperty.call(coin, "pegReferenceId")
    && Object.prototype.hasOwnProperty.call(coin, "jurisdiction")
  );
}

function projectPegMechanismDistribution(
  envelope: SnapshotEnvelope | null,
  historical = false,
): PegMechanismProjection {
  if (!envelope) {
    return { rows: projectPegMechanismRows(TRACKED_STABLECOINS) };
  }

  if (envelope.stablecoins.length > 0 && envelope.stablecoins.every(hasSnapshotCatalogFields)) {
    return { rows: projectPegMechanismRows(envelope.stablecoins) };
  }

  const metadataNote =
    `legacy snapshot ${envelope.snapshotDate} omitted mechanismArchetype, pegReferenceId, or jurisdiction; `
    + "using current catalog metadata as an approximation";
  console.warn(`[generate-public-datasets] ${metadataNote}.`);

  // Pre-catalog snapshots cannot provide an exact historical classification. Keep
  // the legacy latest output intact, and restrict historical approximation to
  // stablecoin IDs present in the snapshot envelope.
  if (!historical) {
    return {
      rows: projectPegMechanismRows(TRACKED_STABLECOINS),
      metadataStatus: "approximated",
      metadataNote,
    };
  }

  const currentById = new Map(TRACKED_STABLECOINS.map((coin) => [coin.id, coin]));
  const projectedCoins = envelope.stablecoins.map((coin) => {
    const current = currentById.get(coin.id);
    return {
      mechanismArchetype: coin.mechanismArchetype ?? current?.mechanismArchetype,
      pegReferenceId: coin.pegReferenceId ?? current?.pegReferenceId,
      jurisdiction: coin.jurisdiction ?? current?.jurisdiction,
    };
  });

  return {
    rows: projectPegMechanismRows(projectedCoins),
    metadataStatus: "approximated",
    metadataNote,
  };
}

// --- Per-topic metadata + write loop ----------------------------------------

interface TopicSpec<T> {
  topic: PublicDatasetTopic;
  rows: T[];
  columns: CsvColumn<T>[];
  /** Methodology label for the preamble. */
  methodologyLabel: string;
  metadataStatus?: "approximated";
  metadataNote?: string;
}

function topicPreamble(
  topic: PublicDatasetTopic,
  methodologyLabel: string,
  asOfISO: string,
  variant: "csv" | "json" | "ndjson",
  metadata?: Pick<TopicSpec<unknown>, "metadataStatus" | "metadataNote">,
): Preamble {
  return {
    endpoint: topic,
    asOfISO,
    sourceUrl: `${SITE_ORIGIN}/datasets/${topic}/latest.${variant}`,
    methodologyLabel,
    ...metadata,
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

function buildPublicDatasetRedirectBlock(snapshotDate: string): string {
  const lines = [
    REDIRECT_BLOCK_START,
    "# Generated by scripts/maintenance/generate-public-datasets.ts. Do not edit by hand.",
    "# Cloudflare Pages 200 rewrites preserve direct-fetch URLs without redirect chains.",
  ];
  for (const topic of PUBLIC_DATASET_TOPICS) {
    for (const variant of ["csv", "json", "ndjson"] as const) {
      lines.push(`/datasets/${topic}/latest.${variant} /datasets/${topic}/${snapshotDate}.${variant} 200`);
    }
  }
  lines.push("# Sheets aliases rewrite directly to dated CSVs; Pages does not follow chained redirects.");
  for (const topic of PUBLIC_DATASET_TOPICS) {
    lines.push(`/sheets/${topic}.csv /datasets/${topic}/${snapshotDate}.csv 200`);
  }
  lines.push(REDIRECT_BLOCK_END);
  return `${lines.join("\n")}\n`;
}

function writePublicDatasetRedirects(snapshotDate: string, redirectsPath = REDIRECTS_PATH): { changed: boolean } {
  const redirects = readFileSync(redirectsPath, "utf8");
  const start = redirects.indexOf(REDIRECT_BLOCK_START);
  const end = redirects.indexOf(REDIRECT_BLOCK_END);
  if (start < 0 || end < start) {
    throw new Error(`Public dataset redirect markers missing or out of order in ${redirectsPath}`);
  }
  const after = end + REDIRECT_BLOCK_END.length;
  const replacement = buildPublicDatasetRedirectBlock(snapshotDate).trimEnd();
  return writeArtifact(redirectsPath, `${redirects.slice(0, start)}${replacement}${redirects.slice(after)}`);
}

function buildPublicDatasetCurrentModule(snapshotDate: string): string {
  const imports = PUBLIC_DATASET_TOPICS.map((topic) => {
    const name = `${topic.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())}Export`;
    return {
      name,
      topic,
      statement: `import ${name} from "../../public/datasets/${topic}/${snapshotDate}.json";`,
    };
  });
  return [
    "/** Generated by scripts/maintenance/generate-public-datasets.ts. Do not edit by hand. */",
    ...imports.map(({ statement }) => statement),
    "",
    "export const PUBLIC_DATASET_CURRENT_EXPORTS = {",
    ...imports.map(({ name, topic }) => `  "${topic}": ${name},`),
    "} as const;",
    "",
  ].join("\n");
}

function writePublicDatasetCurrentModule(
  snapshotDate: string,
  modulePath = CURRENT_DATASET_MODULE_PATH,
): { changed: boolean } {
  return writeArtifact(modulePath, buildPublicDatasetCurrentModule(snapshotDate));
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
  const csv = buildCsv(
    spec.rows,
    spec.columns,
    topicPreamble(spec.topic, spec.methodologyLabel, asOfISO, "csv", spec),
  );
  const json = buildJson(
    spec.rows,
    spec.columns,
    topicPreamble(spec.topic, spec.methodologyLabel, asOfISO, "json", spec),
  );
  const ndjson = buildNdjson(
    spec.rows,
    spec.columns,
    topicPreamble(spec.topic, spec.methodologyLabel, asOfISO, "ndjson", spec),
  );

  const targets = [
    { path: join(topicDir, `${snapshotDate}.csv`), contents: csv },
    { path: join(topicDir, `${snapshotDate}.json`), contents: json },
    { path: join(topicDir, `${snapshotDate}.ndjson`), contents: ndjson },
  ];

  let written = 0;
  for (const target of targets) {
    const result = writeArtifact(target.path, target.contents);
    if (result.changed) written += 1;
  }

  return { dated: [`${snapshotDate}.csv`, `${snapshotDate}.json`, `${snapshotDate}.ndjson`], written };
}

interface ArtifactDirs {
  datasetsDir: string;
  redirectsPath: string;
  currentDatasetModulePath: string;
}

const DEFAULT_ARTIFACT_DIRS: ArtifactDirs = {
  datasetsDir: DATASETS_DIR,
  redirectsPath: REDIRECTS_PATH,
  currentDatasetModulePath: CURRENT_DATASET_MODULE_PATH,
};

function readRedirectRules(path: string): Map<string, { destination: string; status: string }> {
  const rules = new Map<string, { destination: string; status: string }>();
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const [source, destination, status = "302"] = line.split(/\s+/);
    if (source && destination) rules.set(source, { destination, status });
  }
  return rules;
}

interface JsonArtifactMetadata {
  rowCount: number;
  actualRowCount: number;
}

function readJsonArtifactMetadata(path: string, topic: PublicDatasetTopic): JsonArtifactMetadata | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      _meta?: { endpoint?: string; rowCount?: unknown };
      rows?: unknown;
    };
    if (parsed._meta?.endpoint !== topic || typeof parsed._meta.rowCount !== "number") return null;
    return {
      rowCount: parsed._meta.rowCount,
      actualRowCount: Array.isArray(parsed.rows) ? parsed.rows.length : -1,
    };
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
  const rules = readRedirectRules(dirs.redirectsPath);
  const resolved = new Map<"csv" | "json" | "ndjson", string>();
  for (const variant of ["csv", "json", "ndjson"] as const) {
    const source = `/datasets/${topic}/latest.${variant}`;
    const rule = rules.get(source);
    const expectedDestination = new RegExp(`^/datasets/${topic}/\\d{4}-\\d{2}-\\d{2}\\.${variant}$`);
    if (!rule || rule.status !== "200" || !expectedDestination.test(rule.destination)) {
      return { ok: false, reason: `${source} must be a 200 rewrite to a dated ${variant} artifact` };
    }
    resolved.set(variant, join(dirs.datasetsDir, topic, rule.destination.split("/").at(-1)!));
  }
  const sheetSource = `/sheets/${topic}.csv`;
  const sheetRule = rules.get(sheetSource);
  const csvDestination = rules.get(`/datasets/${topic}/latest.csv`)?.destination;
  if (!sheetRule || sheetRule.status !== "200" || sheetRule.destination !== csvDestination) {
    return { ok: false, reason: `${sheetSource} must rewrite directly to the dated CSV artifact` };
  }

  for (const [variant, path] of resolved) {
    if (!existsSync(path)) {
      return { ok: false, reason: `${path} missing` };
    }
    const head = readFileSync(path, "utf8").slice(0, 512);
    const hasPreamble = variant === "csv"
      ? head.startsWith("# Pharos pharos.watch")
      : variant === "json"
        ? head.includes(`"_meta"`) && head.includes(`"endpoint": "${topic}"`)
        : head.startsWith(`{"_meta":`) && head.includes(`"endpoint":"${topic}"`);
    if (!hasPreamble) {
      return { ok: false, reason: `${path} missing preamble` };
    }
  }
  const jsonPath = resolved.get("json")!;
  const jsonMetadata = readJsonArtifactMetadata(jsonPath, topic);
  const floor = CHECK_ROW_FLOORS[topic];
  if (jsonMetadata == null) {
    return { ok: false, reason: `${jsonPath} missing numeric _meta.rowCount` };
  }
  if (jsonMetadata.actualRowCount !== jsonMetadata.rowCount) {
    return {
      ok: false,
      reason: `${topic} rowCount ${jsonMetadata.rowCount} does not match rows length ${jsonMetadata.actualRowCount}`,
    };
  }
  if (jsonMetadata.rowCount < floor) {
    return { ok: false, reason: `${topic} rowCount ${jsonMetadata.rowCount} below required floor ${floor}` };
  }
  return { ok: true };
}

function checkCurrentDatasetModule(dirs: ArtifactDirs = DEFAULT_ARTIFACT_DIRS): { ok: boolean; reason?: string } {
  const rule = readRedirectRules(dirs.redirectsPath).get("/datasets/top-stablecoins/latest.json");
  const snapshotDate = /^\/datasets\/top-stablecoins\/(\d{4}-\d{2}-\d{2})\.json$/.exec(rule?.destination ?? "")?.[1];
  if (!snapshotDate) {
    return { ok: false, reason: "top-stablecoins latest.json is not a dated rewrite" };
  }
  const expected = buildPublicDatasetCurrentModule(snapshotDate);
  if (!existsSync(dirs.currentDatasetModulePath)) {
    return { ok: false, reason: `${dirs.currentDatasetModulePath} missing` };
  }
  if (readFileSync(dirs.currentDatasetModulePath, "utf8") !== expected) {
    return { ok: false, reason: `${dirs.currentDatasetModulePath} does not match current dataset redirects` };
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

function snapshotEndSecForDate(snapshotDate: string): number {
  return Math.floor(new Date(`${snapshotDate}T00:00:00Z`).getTime() / 1000) + 86_400 - 1;
}

function validateDepegHistoryCoverage(events: readonly DepegEvent[], snapshotDate: string): void {
  const cutoffSec = cutoffSecForSnapshotDate(snapshotDate);
  const oldestStartedAt = events.reduce((oldest, event) => Math.min(oldest, event.startedAt), Number.POSITIVE_INFINITY);
  if (oldestStartedAt > cutoffSec) {
    throw new Error(
      `Depeg event source does not cover the ${RETENTION_DAYS}-day export window for ${snapshotDate}; ` +
        "refusing a potentially truncated public dataset.",
    );
  }
}

function asOfIsoFromEnvelope(envelope: SnapshotEnvelope, snapshotDate: string): string {
  if (envelope.methodologyVersions?.source === "live-endpoint-fallback") {
    return new Date(Math.max(Date.now(), envelope.generatedAt * 1000)).toISOString();
  }
  return envelope.generatedAt > 0
    ? new Date(envelope.generatedAt * 1000).toISOString()
    : `${snapshotDate}T00:00:00.000Z`;
}

async function fetchLatestSnapshotDate(apiBase: string): Promise<string | null> {
  const indexPayload = await safeFetchJson<{ snapshots: Array<{ snapshotDate: string }> }>(
    resolveApiPathUrl(apiBase, "/api/snapshots/index"),
  );
  return indexPayload?.snapshots[0]?.snapshotDate ?? null;
}

export async function loadPublicDatasetLiveInputs(
  apiBase: string,
  requestedSnapshotDate: string,
): Promise<PublicDatasetLiveInputs> {
  const historical = isHistoricalSnapshotDate(requestedSnapshotDate);
  let effectiveSnapshotDate = requestedSnapshotDate;
  let envelope = await fetchSnapshot(apiBase, requestedSnapshotDate);
  if (!envelope) {
    if (historical) {
      throw new Error(
        `Unable to fetch historical public snapshot for ${requestedSnapshotDate}; refusing live-endpoint fallback.`,
      );
    }
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
    throw new Error(`Unable to fetch public snapshot or live endpoint fallback for ${requestedSnapshotDate}.`);
  }
  effectiveSnapshotDate = envelope.snapshotDate || effectiveSnapshotDate;
  const asOfISO = asOfIsoFromEnvelope(envelope, effectiveSnapshotDate);

  const depegEvents = await fetchDepegEvents(apiBase);
  if (!depegEvents) {
    throw new Error("Unable to fetch depeg events for public dataset generation.");
  }
  validateDepegHistoryCoverage(depegEvents, effectiveSnapshotDate);

  return { envelope, depegEvents, effectiveSnapshotDate, asOfISO };
}

function buildTopicSpecs(
  envelope: SnapshotEnvelope | null,
  depegEvents: DepegEvent[],
  snapshotDate: string,
  options: { historical?: boolean } = {},
): TopicSpec<unknown>[] {
  const historical = options.historical ?? isHistoricalSnapshotDate(snapshotDate);
  const envelopeSnapshotDate = envelope?.snapshotDate || snapshotDate;
  const pegMechanismProjection = projectPegMechanismDistribution(envelope, historical);
  const methodologyVersion = (
    keys: readonly string[],
    fallback: string,
  ): string => {
    const version = keys
      .map((key) => envelope?.methodologyVersions?.[key])
      .find((value): value is string => typeof value === "string" && value.length > 0);
    if (version) return version.startsWith("v") ? version : `v${version}`;
    return historical ? "unavailable (legacy snapshot methodology not recorded)" : fallback;
  };

  return [
    {
      topic: "top-stablecoins",
      rows: projectTopStablecoins(envelope),
      columns: TOP_STABLECOINS_COLUMNS,
      methodologyLabel:
        `safety-score ${methodologyVersion(["reportCard", "pegScore"], SAFETY_SCORE_METHODOLOGY_VERSION_LABEL)}`,
    } as TopicSpec<TopStablecoinRow> as TopicSpec<unknown>,
    {
      topic: "depeg-history",
      rows: projectDepegHistory(depegEvents, envelopeSnapshotDate),
      columns: DEPEG_HISTORY_COLUMNS,
      methodologyLabel: `depeg-dews ${methodologyVersion(["dews"], DEPEG_DEWS_METHODOLOGY_VERSION_LABEL)}`,
    } as TopicSpec<DepegHistoryRow> as TopicSpec<unknown>,
    {
      topic: "scores-latest",
      rows: projectScoresLatest(envelope),
      columns: SCORES_LATEST_COLUMNS,
      methodologyLabel:
        `safety-score ${methodologyVersion(["reportCard", "pegScore"], SAFETY_SCORE_METHODOLOGY_VERSION_LABEL)} `
        + `| dews ${methodologyVersion(["dews"], DEPEG_DEWS_METHODOLOGY_VERSION_LABEL)} `
        + `| liquidity ${methodologyVersion(["liquidityScore"], LIQUIDITY_METHODOLOGY_VERSION_LABEL)}`,
    } as TopicSpec<ScoreLatestRow> as TopicSpec<unknown>,
    {
      topic: "peg-mechanism-distribution",
      rows: pegMechanismProjection.rows,
      columns: PEG_MECHANISM_COLUMNS,
      methodologyLabel:
        `safety-score ${methodologyVersion(["reportCard", "pegScore"], SAFETY_SCORE_METHODOLOGY_VERSION_LABEL)}`,
      ...(pegMechanismProjection.metadataStatus
        ? {
            metadataStatus: pegMechanismProjection.metadataStatus,
            metadataNote: pegMechanismProjection.metadataNote,
          }
        : {}),
    } as TopicSpec<PegMechanismDistributionRow> as TopicSpec<unknown>,
  ];
}

export const testExports = {
  buildPublicDatasetCurrentModule,
  buildPublicDatasetRedirectBlock,
  buildTopicSpecs,
  checkTopic,
  cutoffSecForSnapshotDate,
  isHistoricalSnapshotDate,
  projectDepegHistory,
  projectPegMechanismDistribution,
  snapshotEndSecForDate,
  validateDepegHistoryCoverage,
  validateTopicRowFloor,
};

function checkAllTopics(dirs: ArtifactDirs = DEFAULT_ARTIFACT_DIRS): { ok: boolean; reason?: string } {
  for (const topic of PUBLIC_DATASET_TOPICS) {
    const result = checkTopic(topic, dirs);
    if (!result.ok) return result;
  }
  return checkCurrentDatasetModule(dirs);
}

function shouldPreserveExistingDatasetMirrorsAfterFetchFailure(): boolean {
  return shouldAllowExistingDataOnFetchFailure(["PUBLIC_DATASETS_ALLOW_EXISTING_ON_FETCH_FAILURE"]);
}

function preserveExistingDatasetMirrorsAfterFetchFailure(error: unknown): boolean {
  if (!shouldPreserveExistingDatasetMirrorsAfterFetchFailure()) {
    return false;
  }
  const existing = checkAllTopics();
  if (!existing.ok) {
    console.error(
      `[generate-public-datasets] Live API fetch failed and checked-in mirrors are not current: ${existing.reason}`,
    );
    return false;
  }
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(
    `[generate-public-datasets] Live API fetch failed (${reason}); preserving checked-in public dataset mirrors. ` +
      `Unset ${RELEASE_DATA_FALLBACK_ENV_NAME} / PUBLIC_DATASETS_ALLOW_EXISTING_ON_FETCH_FAILURE to fail closed.`,
  );
  return true;
}

// --- Main -------------------------------------------------------------------

async function main(): Promise<void> {
  const requestedSnapshotDate = resolveSnapshotDate();
  let snapshotDate = requestedSnapshotDate;

  if (CHECK_MODE) {
    const result = checkAllTopics();
    if (!result.ok) {
      console.error(
        `Public dataset mirrors are out of date. Run \`tsx scripts/maintenance/generate-public-datasets.ts\`. (${result.reason})`,
      );
      process.exit(1);
    }
    console.log("Public dataset mirrors are current");
    return;
  }

  const apiBase = resolveGeneratorApiBase();
  let envelope: SnapshotEnvelope | null = null;
  let depegEvents: DepegEvent[] = [];
  let asOfISO = `${snapshotDate}T00:00:00.000Z`;

  if (apiBase) {
    try {
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
    } catch (err) {
      if (preserveExistingDatasetMirrorsAfterFetchFailure(err)) {
        return;
      }
      throw err;
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

  const specs = buildTopicSpecs(envelope, depegEvents, snapshotDate, {
    historical: isHistoricalSnapshotDate(requestedSnapshotDate),
  });
  if (apiBase) {
    for (const spec of specs) {
      validateTopicRowFloor(spec.topic, spec.rows);
    }
  }

  ensureDir(DATASETS_DIR);

  let totalWritten = 0;
  let totalPruned = 0;
  for (const spec of specs) {
    const result = writeTopic(spec as TopicSpec<unknown>, snapshotDate, asOfISO);
    totalWritten += result.written;
    totalPruned += pruneOldSnapshots(join(DATASETS_DIR, spec.topic), snapshotDate);
  }
  if (writePublicDatasetRedirects(snapshotDate).changed) totalWritten += 1;
  if (writePublicDatasetCurrentModule(snapshotDate).changed) totalWritten += 1;

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
