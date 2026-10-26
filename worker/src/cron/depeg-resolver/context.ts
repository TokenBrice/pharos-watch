import { deriveCurrentPegObservationMap } from "../../lib/current-peg-observations";
import { DDR_INELIGIBLE_AUDIT_VERDICTS } from "@shared/types/depeg-audit";
import { auditVerdictNotInSql } from "../../lib/depeg-audit";
import {
  groupIncidents,
  quarantinedCoins,
  structuralClass,
  type DdrActiveEventInput,
  type DdrHistoricalEvent,
  type DdrIncident,
  type DdrSafetyContextProvenance,
  type DdrV9ExitContext,
} from "@shared/lib/depeg-resolver";
import { DDR_V2_EFFECTIVE_AT } from "@shared/lib/methodology-versions/depeg-resolver";
import { WORKER_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { isTerminalStablecoinStatus } from "@shared/lib/stablecoin-lifecycle";
import { chunkArray } from "../../lib/collections";
import { buildInClause } from "../../lib/d1-primitives";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import type { StablecoinData } from "@shared/types/market";
import {
  getDexLiquidityTrendTolerances,
  selectLiquidityObservation,
  selectTrendBaseline,
  type DexHistoryRow,
} from "../../lib/dex-liquidity-response";
import { DEX_LIQUIDITY_PUBLISHED_ROW_FILTER } from "../../lib/dex-liquidity";
import { parseDexVolumeAvailabilityRecord, readStoredDexVolumeWindow } from "@shared/lib/dex-volume-availability";
import { tallyMintBurnHourlyBucket, type MintBurnValuationTally } from "@shared/lib/mint-burn-valuation";
import {
  loadRedemptionBackstopLiveSignalRows,
  RedemptionBackstopSnapshotUnavailableError,
} from "../../lib/redemption-backstops-store";
import { hasUsableStablecoinsPayload, loadStablecoinsCache } from "../../lib/stablecoins-cache";
import { loadActiveSafetyScoreCohort } from "../../lib/safety-score-active-source";
import { loadPublishedStressSignalGeneration } from "../../lib/stress-signals-current-rows";
import {
  CURRENT_PRICE_MAX_AGE_SEC,
  DAY,
  HISTORICAL_ROW_CAP,
  TRAINING_WINDOW_SEC,
} from "./constants";
import { MINT_BURN_COVERED_COIN_IDS } from "./mint-burn-coverage";
import { MINT_BURN_CONFIGS } from "../../lib/mint-burn-contracts";
import { decodeMintBurnScanCoverage, mintBurnScanCoverageAdmits, prepareMintBurnScanCoverage, type MintBurnScanSegment } from "../../lib/mint-burn-pipeline/scan-coverage";
import { readDdrOpenTrainingHistory, readDdrTrainingHistory } from "./training-history";
import type {
  CurrentDeviationMapResult,
  DdrEventDbRow,
  DdrLineage,
  DdrStructuralContext,
  QueryRowsResult,
} from "./types";
import {
  buildDdrStructuralContext,
  formatDdrrFailure,
  toStructural,
} from "./utils";

/** Stored hourly bucket read for DDR mint-surge evidence; `netFlowUsd` is the known-valuation net. */
export interface DdrMintBurnHourlyRow {
  hourTs: number;
  netFlowUsd: number;
  valuation: MintBurnValuationTally;
}
export interface DdrLoadedContext {
  active: DdrActiveEventInput[];
  activeCoinIds: string[];
  activeEventById: Map<number, DdrEventDbRow>;
  incidents: DdrIncident[];
  quarantined: Set<string>;
  supplyByCoin: Map<string, { date: number; usd: number }[]>;
  mintBurnHourlyByCoin: Map<string, DdrMintBurnHourlyRow[]>;
  mintBurnCoveredEventIds: Set<number>;
  dewsByCoin: Map<string, { stablecoin_id: string; score: number; band: string; signals_json: string | null; computed_at: number }>;
  liqByCoin: Map<string, { stablecoin_id: string; liquidity_score: number | null; concentration_hhi: number | null; total_tvl_usd: number | null; total_volume_24h_usd: number | null; updated_at: number; methodology_version: string | null }>;
  liqTvlChange7dByCoin: Map<string, number>;
  liqTvlChange30dByCoin: Map<string, number>;
  liqVolumeChange30dByCoin: Map<string, number>;
  /** DDRv5: DEX TVL change from the admitted snapshot at or before each active event's onset. */
  liqTvlChangeSinceOnsetByEventId: Map<number, number>;
  redemptionByCoin: Map<string, { stablecoin_id: string; immediate_capacity_ratio: number | null; route_family: string | null; updated_at: number }>;
  safetyByCoin: Map<string, { stablecoin_id: string; grade: string; score: number | null; recorded_at: number }>;
  v9ExitByCoin: Map<string, DdrV9ExitContext>;
  safetyContext: DdrSafetyContextProvenance;
  structuralContext: DdrStructuralContext | null;
  lineage: DdrLineage;
}

export type DdrContextLoadResult =
  | { kind: "ok"; context: DdrLoadedContext }
  | { kind: "degraded"; reason: string; dataAsOf: number | null };

// Measured 24h volume after the DEC-19 availability read: null when the
// stored record marks the window partial/missing/stale/unreadable.
type DdrDexHistoryRow = DexHistoryRow & {
  total_volume_24h_usd: number | null;
};

function measuredVolume24h(storedUsd: number | null, availabilityJson: string | null | undefined): number | null {
  return readStoredDexVolumeWindow(storedUsd, parseDexVolumeAvailabilityRecord(availabilityJson), "24h").measuredUsd;
}

export function emptyDdrLineage(nowSec: number): DdrLineage {
  return {
    trainingWindow: { start: nowSec - TRAINING_WINDOW_SEC, end: nowSec },
    eventCount: 0,
    incidentCount: 0,
    coinCount: 0,
    quarantinedCoins: 0,
    trainingRowsTruncated: false,
  };
}

async function queryRows<T>(label: string, query: () => Promise<{ results?: T[] }>): Promise<QueryRowsResult<T>> {
  try {
    // Transient "D1 DB is overloaded" spikes were converting whole DDR runs
    // into failed cron_runs; these reads are idempotent and retryable.
    const result = await runWithOverloadRetry(query);
    return { rows: result.results ?? [], error: null };
  } catch (error) {
    return {
      rows: [],
      error: `${label}:${formatDdrrFailure(error)}`,
    };
  }
}

/**
 * Run an `IN (…)` read in bind-limit-safe chunks. A market-wide depeg pushes
 * the active-coin list past `D1_MAX_BOUND_PARAMETERS`, where a single
 * statement would throw and degrade the whole run.
 */
export async function queryRowsChunked<T>(
  label: string,
  ids: readonly string[],
  query: (inClauseSql: string, binds: unknown[]) => Promise<{ results?: T[] }>,
): Promise<QueryRowsResult<T>> {
  const rows: T[] = [];
  for (const chunk of chunkArray(ids)) {
    const inClause = buildInClause(chunk);
    const result = await queryRows(label, () => query(inClause.sql, inClause.binds));
    if (result.error) return { rows: [], error: result.error };
    rows.push(...result.rows);
  }
  return { rows, error: null };
}

/**
 * Rows retained per coin *below* the supply-context window.
 *
 * The resolver reads supply only through `buildSupplyContext`, which resolves
 * `supplyAt(snapshots, ts)` (the newest row at or before `ts`) at four targets
 * per active event — `startedAt`, `startedAt - 7d`, `nowSec`, and
 * `nowSec - 30d`. Rows older than the window start can only supply the
 * nearest-earlier observation for the earliest target. Two retained rows
 * also preserve the minimum two-observation guard.
 */
export const SUPPLY_CONTEXT_LOOKBACK_ROWS = 2;

/**
 * Window start for the active cohort's supply read.
 *
 * Every supply lookup the resolver performs is a `supplyAt(snapshots, ts)`
 * target (`startedAt`, `startedAt - 7d`, `nowSec`, `nowSec - 30d`), so the read
 * must reach back to the *earliest* of them: a cohort whose events all started
 * within the last month still resolves `nowSec - 30d`, which is older than
 * `min(startedAt) - 7d`. With no active events nothing reads supply, and the
 * `nowSec - 30d` target keeps the expression shape identical.
 */
export function resolveSupplyWindowStart(
  activeStartedAtSec: readonly number[],
  nowSec: number,
): number {
  const thirtyDayTarget = nowSec - 30 * DAY;
  if (activeStartedAtSec.length === 0) return thirtyDayTarget;
  return Math.min(Math.min(...activeStartedAtSec) - 7 * DAY, thirtyDayTarget);
}

export interface ActiveSupplyHistoryRow {
  stablecoin_id: string;
  snapshot_date: number;
  circulating_usd: number;
}

/**
 * Reads the supply series the resolver consumes for the active cohort.
 *
 * The previous unbounded `stablecoin_id IN (…)` read returned every daily row
 * for every active coin — 32,095 rows for the 2026-09-23 cohort, growing by one
 * row per coin per day — so an old coin's whole history was buffered on each
 * fifteen-minute run to answer four point lookups. The window keeps the read
 * proportional to active-event age instead of coin age, with the lookback rows
 * above preserving `supplyAt` and the coverage guard for every target.
 */
/**
 * Two arms on purpose. Folding the lookback into the window predicate
 * (`snapshot_date >= ? OR snapshot_date IN (…)`) makes SQLite evaluate the
 * correlated lookback once per candidate supply row: measured on production D1
 * for the 2026-09-23 cohort that shape read 78,107 rows for 9,180 returned.
 * Driving both arms from the coin list keeps every read anchored to an index
 * seek — 18,550 rows read, 29.5 ms, and the same 9,180 rows (identical
 * count/date/amount fingerprint) — against 32,179 rows read for the previous
 * unbounded read on the same cohort.
 */
const ACTIVE_SUPPLY_HISTORY_SQL =
  "SELECT h.stablecoin_id, h.snapshot_date, h.circulating_usd " +
  "FROM supply_history h " +
  "JOIN (SELECT value AS coin_id FROM json_each(?)) c ON c.coin_id = h.stablecoin_id " +
  "WHERE h.snapshot_date >= ? " +
  "UNION ALL " +
  "SELECT h.stablecoin_id, h.snapshot_date, h.circulating_usd " +
  "FROM supply_history h " +
  "JOIN (SELECT value AS coin_id FROM json_each(?)) c ON c.coin_id = h.stablecoin_id " +
  "WHERE h.snapshot_date IN (" +
  "SELECT h2.snapshot_date FROM supply_history h2 " +
  "WHERE h2.stablecoin_id = c.coin_id AND h2.snapshot_date < ? " +
  "ORDER BY h2.snapshot_date DESC " +
  `LIMIT ${SUPPLY_CONTEXT_LOOKBACK_ROWS}) ` +
  "ORDER BY stablecoin_id, snapshot_date ASC";

export async function readActiveSupplyHistory(
  db: D1Database,
  activeCoinIds: readonly string[],
  windowStartSec: number,
): Promise<QueryRowsResult<ActiveSupplyHistoryRow>> {
  const rows: ActiveSupplyHistoryRow[] = [];
  for (const chunk of chunkArray(activeCoinIds)) {
    if (chunk.length === 0) continue;
    const coinIdsJson = JSON.stringify(chunk);
    const result = await queryRows("supply_history", () => db
      .prepare(ACTIVE_SUPPLY_HISTORY_SQL)
      .bind(coinIdsJson, windowStartSec, coinIdsJson, windowStartSec)
      .all<ActiveSupplyHistoryRow>());
    if (result.error) return { rows: [], error: result.error };
    rows.push(...result.rows);
  }
  return { rows, error: null };
}

export async function buildCurrentDeviationMap(
  db: D1Database,
  nowSec: number,
): Promise<CurrentDeviationMapResult> {
  const cache = await loadStablecoinsCache(db, { mode: "lenient", contract: "critical-fields" });
  if (!hasUsableStablecoinsPayload(cache) || cache.updatedAt == null || nowSec - cache.updatedAt > CURRENT_PRICE_MAX_AGE_SEC) {
    const reason = !hasUsableStablecoinsPayload(cache)
      ? `stablecoins-cache-${cache.kind === "error" || cache.kind === "degraded" ? cache.reason : "unusable"}`
      : "stablecoins-cache-stale";
    return { byCoin: new Map(), healthy: false, degradedReason: reason, dataAsOf: cache.updatedAt ?? null };
  }

  const assets = cache.payload.peggedAssets as StablecoinData[];
  const observations = deriveCurrentPegObservationMap({
    peggedAssets: assets,
    fxFallbackRates: cache.payload.fxFallbackRates,
    asOf: cache.updatedAt,
  });
  const out = new Map<string, number | null>();

  for (const asset of assets) {
    const meta = TRACKED_META_BY_ID.get(asset.id);
    if (!meta || meta.flags.navToken) continue;
    const supply = getCirculatingRawOrNull(asset);
    // DDR requires positive observed supply in addition to canonical live-price admission.
    out.set(asset.id, supply === null || supply <= 0
      ? null
      : observations.get(asset.id)?.currentDeviationBps ?? null);
  }

  return { byCoin: out, healthy: true, degradedReason: null, dataAsOf: cache.updatedAt };
}

export async function loadPolicyUniverseEvents(db: D1Database): Promise<DdrEventDbRow[]> {
  const auditEligible = auditVerdictNotInSql("provenance_audit_verdict", DDR_INELIGIBLE_AUDIT_VERDICTS);
  const result = await runWithOverloadRetry(() => db
    .prepare(
      "SELECT id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, " +
        "recovery_price, peg_reference, source, confirmation_sources, pending_reason, " +
        "provenance_replay_run_id, provenance_replay_version " +
        "FROM depeg_events_with_provenance " +
        `WHERE ${auditEligible.sql} ` +
        "AND (started_at >= ? OR (started_at < ? AND (ended_at IS NULL OR ended_at >= ?))) " +
        "ORDER BY started_at ASC, id ASC",
    )
    .bind(...auditEligible.binds, DDR_V2_EFFECTIVE_AT, DDR_V2_EFFECTIVE_AT, DDR_V2_EFFECTIVE_AT)
    .all<DdrEventDbRow>());
  return result.results ?? [];
}

/** Onset DEX TVL baselines are read only for events younger than this. */
const DDR_ONSET_TVL_LOOKBACK_SEC = 120 * DAY;

/** History window covering the 7/30-day trend targets and every active onset within the lookback. */
export function resolveDexHistoryWindowStart(startedAts: readonly number[], nowSec: number): number {
  const trendStart = nowSec - 32 * DAY;
  if (startedAts.length === 0) return trendStart;
  const earliestOnset = Math.max(Math.min(...startedAts), nowSec - DDR_ONSET_TVL_LOOKBACK_SEC);
  return Math.min(trendStart, earliestOnset - 8 * DAY);
}

/**
 * When a tracked coin entered a terminal lifecycle state, from the registry's
 * day-precision `frozenAt`. Unknown dates stay null: the incident is then
 * censored rather than labelled terminal at a guessed time.
 */
function registryTerminalAtSec(meta: { status?: string | null; frozenAt?: string } | undefined): number | null {
  if (!meta || !isTerminalStablecoinStatus(meta.status ?? null) || !meta.frozenAt) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(meta.frozenAt);
  if (!match) return null;
  const millis = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(millis) ? Math.floor(millis / 1000) : null;
}

export async function loadActiveConfirmedEvents(db: D1Database): Promise<DdrEventDbRow[]> {
  const auditEligible = auditVerdictNotInSql("provenance_audit_verdict", DDR_INELIGIBLE_AUDIT_VERDICTS);
  const activeResult = await runWithOverloadRetry(() => db
    .prepare(
      "SELECT id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, " +
        "recovery_price, peg_reference, source, confirmation_sources, pending_reason, " +
        "provenance_replay_run_id, provenance_replay_version " +
        "FROM depeg_events_with_provenance WHERE ended_at IS NULL " +
        `AND ${auditEligible.sql} ` +
        "ORDER BY started_at ASC",
    )
    .bind(...auditEligible.binds)
    .all<DdrEventDbRow>());

  return (activeResult.results ?? []).filter((row) => {
    const status = TRACKED_META_BY_ID.get(row.stablecoin_id)?.status ?? null;
    return !isTerminalStablecoinStatus(status);
  });
}

/** The same bounded, audit-eligible temporal corpus used by loadDdrContext. */
export async function loadDdrHistoricalEvents(
  db: D1Database,
  directions: readonly string[],
  windowStart: number,
): Promise<{ historical: DdrHistoricalEvent[]; trainingRowsTruncated: boolean }> {
  if (directions.length === 0) return { historical: [], trainingRowsTruncated: false };
  const closedRows = await readDdrTrainingHistory(db, directions, windowStart);
  const trainingRowsTruncated = closedRows.length === HISTORICAL_ROW_CAP;
  const rows = [...closedRows, ...await readDdrOpenTrainingHistory(db, directions, windowStart)];
  closedRows.length = 0;
  const historical = rows.map((row): DdrHistoricalEvent => {
    // The aggregate is generated by SQLite, not untrusted stored JSON. Reject
    // nonnumeric sample values rather than coercing missing evidence to zero.
    const samples: unknown = JSON.parse(row.severity_observations_json ?? "[]");
    const severityObservations: NonNullable<DdrHistoricalEvent["severityObservations"]> = [];
    if (Array.isArray(samples)) {
      for (const sample of samples) {
        if (sample != null && typeof sample === "object" &&
          typeof sample.observedAt === "number" && typeof sample.deviationBps === "number" &&
          Number.isFinite(sample.observedAt) && Number.isFinite(sample.deviationBps)) {
          severityObservations.push({ observedAt: sample.observedAt, deviationBps: sample.deviationBps });
        }
      }
    }
    if (row.last_seen_at != null && row.last_seen_bps != null) {
      severityObservations.push({ observedAt: row.last_seen_at, deviationBps: row.last_seen_bps });
    }
    return {
      stablecoinId: row.stablecoin_id,
      direction: row.direction === "above" ? "above" : "below",
      peakDeviationBps: row.peak_deviation_bps,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      recoveryPrice: row.recovery_price,
      closeReason: row.close_reason,
      onsetDeviationBps: row.first_seen_bps,
      severityObservations,
    };
  });
  rows.length = 0;
  return { historical, trainingRowsTruncated };
}

export async function loadDdrContext(
  db: D1Database,
  activeRows: DdrEventDbRow[],
  nowSec: number,
): Promise<DdrContextLoadResult> {
  const currentDeviation = await buildCurrentDeviationMap(db, nowSec);
  if (!currentDeviation.healthy) {
    return {
      kind: "degraded",
      reason: currentDeviation.degradedReason ?? "stablecoins-cache-unusable",
      dataAsOf: currentDeviation.dataAsOf,
    };
  }

  const active: DdrActiveEventInput[] = activeRows.map((r) => ({
    id: r.id,
    stablecoinId: r.stablecoin_id,
    symbol: r.symbol,
    pegType: r.peg_type,
    direction: r.direction === "above" ? "above" : "below",
    peakDeviationBps: r.peak_deviation_bps,
    startedAt: r.started_at,
    pegReference: r.peg_reference,
    currentDeviationBps: currentDeviation.byCoin.get(r.stablecoin_id) ?? null,
  }));
  const activeCoinIds = [...new Set(active.map((a) => a.stablecoinId))];
  const directions = [...new Set(active.map((a) => a.direction))];

  const currencyOf = (id: string): string => TRACKED_META_BY_ID.get(id)?.flags.pegCurrency ?? "USD";

  const windowStart = nowSec - TRAINING_WINDOW_SEC;
  const { historical, trainingRowsTruncated } = await loadDdrHistoricalEvents(db, directions, windowStart);


  // Every consumer reads supply through `buildSupplyContext`
  // (`supplyAt(snapshots, ts)`) at `startedAt`, `startedAt - 7d`, `nowSec`, and
  // `nowSec - 30d` for the active events only, so the read is windowed to
  // `min(startedAt) - 7d` plus the per-coin lookback rows that keep the
  // nearest-earlier observations and minimum two-observation guard identical.
  const supplyWindowStart = resolveSupplyWindowStart(
    active.map((event) => event.startedAt),
    nowSec,
  );
  const supplyResult = await readActiveSupplyHistory(db, activeCoinIds, supplyWindowStart);
  const supplyByCoin = new Map<string, { date: number; usd: number }[]>();
  for (const s of supplyResult.rows) {
    const list = supplyByCoin.get(s.stablecoin_id) ?? [];
    list.push({ date: s.snapshot_date, usd: s.circulating_usd });
    supplyByCoin.set(s.stablecoin_id, list);
  }

  const mintBurnCoinIds = activeCoinIds.filter((id) => MINT_BURN_COVERED_COIN_IDS.has(id));
  const scanConfigs = MINT_BURN_CONFIGS.filter((config) => mintBurnCoinIds.includes(config.stablecoinId));
  let scanSegments = new Map<string, MintBurnScanSegment[]>();
  const scanFrom = Math.floor(Math.min(...active.map((event) => event.startedAt)) / 3600) * 3600 - 7 * DAY;
  const scanTo = Math.floor(Math.max(...active.map((event) => event.startedAt)) / 3600) * 3600;
  type MintBurnStoredRow = {
    stablecoin_id: string;
    hour_ts: number;
    net_flow_usd: number;
    mint_count: number;
    burn_count: number;
    mint_unpriced_event_count: number | null;
    burn_unpriced_event_count: number | null;
  };
  const mintBurnResult = await queryRows<MintBurnStoredRow>("mint_burn_hourly", async () => {
    if (scanConfigs.length === 0) return { results: [] };
    const snapshot = await db.batch([
      db.prepare(
        `SELECT stablecoin_id, hour_ts, net_flow_usd, mint_count, burn_count,
                mint_unpriced_event_count, burn_unpriced_event_count FROM mint_burn_hourly
         WHERE stablecoin_id IN (SELECT value FROM json_each(?)) AND hour_ts >= ? AND hour_ts < ?
         ORDER BY stablecoin_id, hour_ts ASC`,
      ).bind(JSON.stringify(mintBurnCoinIds), scanFrom, scanTo),
      prepareMintBurnScanCoverage(db, scanConfigs, scanFrom, scanTo),
    ]);
    scanSegments = decodeMintBurnScanCoverage(snapshot[1] as D1Result<MintBurnScanSegment>);
    return snapshot[0] as D1Result<MintBurnStoredRow>;
  });
  const scanCoverageError = mintBurnResult.error;
  const mintBurnCoveredEventIds = new Set(active.filter((event) => {
    const end = Math.floor(event.startedAt / 3600) * 3600;
    return mintBurnScanCoverageAdmits(scanConfigs.filter((config) => config.stablecoinId === event.stablecoinId),
      scanSegments, end - 7 * DAY, end);
  }).map((event) => event.id));
  const mintBurnHourlyByCoin = new Map<string, DdrMintBurnHourlyRow[]>();
  for (const row of mintBurnResult.rows) {
    const list = mintBurnHourlyByCoin.get(row.stablecoin_id) ?? [];
    list.push({
      hourTs: row.hour_ts,
      netFlowUsd: row.net_flow_usd,
      valuation: tallyMintBurnHourlyBucket({
        mintCount: row.mint_count,
        burnCount: row.burn_count,
        unpricedMintEventCount: row.mint_unpriced_event_count,
        unpricedBurnEventCount: row.burn_unpriced_event_count,
      }),
    });
    mintBurnHourlyByCoin.set(row.stablecoin_id, list);
  }

  const publishedDews = await loadPublishedStressSignalGeneration(db, nowSec);
  const activeCoinIdSet = new Set(activeCoinIds);
  const dewsResult: QueryRowsResult<{
    stablecoin_id: string;
    score: number;
    band: string;
    signals_json: string | null;
    computed_at: number;
  }> = publishedDews.status === "ok"
    ? {
        rows: publishedDews.rows.filter((row) => activeCoinIdSet.has(row.stablecoin_id)),
        error: null,
      }
    : { rows: [], error: `stress_signals:${publishedDews.reason}` };
  const dewsByCoin = new Map(dewsResult.rows.map((d) => [d.stablecoin_id, d]));

  const liqResult = await queryRowsChunked("dex_liquidity", activeCoinIds, (inClauseSql, binds) => db
    .prepare(
      `SELECT stablecoin_id, liquidity_score, concentration_hhi, total_tvl_usd, total_volume_24h_usd, volume_availability_json, updated_at, methodology_version FROM dex_liquidity ` +
        `WHERE stablecoin_id IN (${inClauseSql}) ` +
        `AND ${DEX_LIQUIDITY_PUBLISHED_ROW_FILTER}`,
    )
    .bind(...binds)
    .all<{
      stablecoin_id: string;
      liquidity_score: number | null;
      concentration_hhi: number | null;
      total_tvl_usd: number | null;
      total_volume_24h_usd: number | null;
      volume_availability_json?: string | null;
      updated_at: number;
      methodology_version: string | null;
    }>());
  const liqRows = liqResult.rows.map(({ volume_availability_json, ...row }) => ({
    ...row,
    total_volume_24h_usd: measuredVolume24h(row.total_volume_24h_usd, volume_availability_json),
  }));
  const liqByCoin = new Map(liqRows.map((l) => [l.stablecoin_id, l]));

  const liqHistResult = await queryRowsChunked("dex_liquidity_history", activeCoinIds, (inClauseSql, binds) => db
    .prepare(
      `SELECT stablecoin_id, total_tvl_usd, total_volume_24h_usd, volume_availability_json, snapshot_date, coverage_class, coverage_confidence, methodology_version ` +
        `FROM dex_liquidity_history ` +
        `WHERE stablecoin_id IN (${inClauseSql}) AND snapshot_date >= ? ` +
        `ORDER BY stablecoin_id, snapshot_date DESC`,
    )
    .bind(...binds, resolveDexHistoryWindowStart(active.map((event) => event.startedAt), nowSec))
    .all<DdrDexHistoryRow & { volume_availability_json?: string | null }>());
  const liqHistoryByCoin = new Map<string, DdrDexHistoryRow[]>();
  for (const { volume_availability_json, ...stored } of liqHistResult.rows) {
    const row: DdrDexHistoryRow = {
      ...stored,
      total_volume_24h_usd: measuredVolume24h(stored.total_volume_24h_usd, volume_availability_json),
    };
    const rows = liqHistoryByCoin.get(row.stablecoin_id) ?? [];
    rows.push(row);
    liqHistoryByCoin.set(row.stablecoin_id, rows);
  }
  const liqTvlChange7dByCoin = new Map<string, number>();
  const liqTvlChange30dByCoin = new Map<string, number>();
  const liqVolumeChange30dByCoin = new Map<string, number>();
  const liqTvlChangeSinceOnsetByEventId = new Map<number, number>();
  const target7d = nowSec - 7 * DAY;
  const target30d = nowSec - 30 * DAY;
  const { week: trend7dToleranceSec } = getDexLiquidityTrendTolerances();
  for (const row of liqRows) {
    const currentTvl = row.total_tvl_usd;
    const history = liqHistoryByCoin.get(row.stablecoin_id) ?? [];
    const baseline7d = selectTrendBaseline(history, target7d, trend7dToleranceSec, row.methodology_version);
    if (
      currentTvl != null &&
      Number.isFinite(currentTvl) &&
      baseline7d &&
      baseline7d.total_tvl_usd > 0
    ) {
      liqTvlChange7dByCoin.set(
        row.stablecoin_id,
        ((currentTvl - baseline7d.total_tvl_usd) / baseline7d.total_tvl_usd) * 100,
      );
    }
    const baseline30d = selectTrendBaseline(history, target30d, trend7dToleranceSec, row.methodology_version);
    if (
      currentTvl != null &&
      Number.isFinite(currentTvl) &&
      baseline30d &&
      baseline30d.total_tvl_usd > 0
    ) {
      liqTvlChange30dByCoin.set(
        row.stablecoin_id,
        ((currentTvl - baseline30d.total_tvl_usd) / baseline30d.total_tvl_usd) * 100,
      );
    }
    for (const event of active) {
      if (event.stablecoinId !== row.stablecoin_id || event.startedAt < nowSec - DDR_ONSET_TVL_LOOKBACK_SEC) continue;
      const onsetHistory = history.filter((entry) => entry.snapshot_date <= event.startedAt);
      const onsetBaseline = selectTrendBaseline(onsetHistory, event.startedAt, trend7dToleranceSec, row.methodology_version);
      if (currentTvl != null && Number.isFinite(currentTvl) && onsetBaseline && onsetBaseline.total_tvl_usd > 0) {
        liqTvlChangeSinceOnsetByEventId.set(
          event.id,
          ((currentTvl - onsetBaseline.total_tvl_usd) / onsetBaseline.total_tvl_usd) * 100,
        );
      }
    }
    const currentVolume = row.total_volume_24h_usd;
    const volumeBaseline30d = selectLiquidityObservation(history, target30d, trend7dToleranceSec);
    if (
      volumeBaseline30d &&
      volumeBaseline30d.total_volume_24h_usd != null &&
      volumeBaseline30d.total_volume_24h_usd > 0 &&
      currentVolume != null &&
      Number.isFinite(currentVolume)
    ) {
      liqVolumeChange30dByCoin.set(
        row.stablecoin_id,
        ((currentVolume - volumeBaseline30d.total_volume_24h_usd) / volumeBaseline30d.total_volume_24h_usd) * 100,
      );
    }
  }

  // Redemption fields come from the store's completed-run snapshot (immutable
  // run rows); the legacy `redemption_backstop` current-table mirror is
  // retired. A snapshot that has never completed behaves like the old empty
  // table read: non-fatal, redemption live context stays null. Real read
  // failures still degrade the run like any other resolver health input.
  const redemptionResult = await queryRows("redemption_backstop", async () => {
    try {
      return { results: await loadRedemptionBackstopLiveSignalRows(db, activeCoinIds) };
    } catch (error) {
      if (error instanceof RedemptionBackstopSnapshotUnavailableError && error.cause == null) return { results: [] };
      throw error;
    }
  });
  const redemptionByCoin = new Map(redemptionResult.rows.map((r) => [r.stablecoin_id, r]));

  let safetyByCoin = new Map<string, { stablecoin_id: string; grade: string; score: number | null; recorded_at: number }>();
  let v9ExitByCoin = new Map<string, DdrV9ExitContext>();
  let structuralContext: DdrStructuralContext | null = null;
  let safetyContext: DdrSafetyContextProvenance = {
    status: "cache-unavailable",
    reason: "safety-score-v9-unavailable",
    identity: null,
  };
  try {
    const activeSafetySource = await loadActiveSafetyScoreCohort(db);
    if (activeSafetySource.kind === "held") {
      safetyContext = {
        status: "cache-unavailable",
        reason: activeSafetySource.reason,
        identity: activeSafetySource.snapshot.safetyScoreIdentity,
      };
    } else if (activeSafetySource.kind === "v9") {
      structuralContext = buildDdrStructuralContext(activeSafetySource.snapshot.cards);
      safetyContext = {
        status: "v9-identified",
        reason: null,
        identity: activeSafetySource.snapshot.safetyScoreIdentity,
      };
      safetyByCoin = new Map(
        activeSafetySource.snapshot.cards
          .filter((card) => activeCoinIds.includes(card.id))
          .flatMap((card) => card.ratingStatus === "pipeline-gap" || card.grade === null ? [] : [[
            card.id,
            {
              stablecoin_id: card.id,
              grade: card.grade,
              score: card.score,
              recorded_at: activeSafetySource.snapshot.updatedAt,
            },
          ] as const]),
      );
      v9ExitByCoin = new Map(
        activeSafetySource.snapshot.cards
          .filter((card) => activeCoinIds.includes(card.id))
          .map((card) => [
            card.id,
            {
              pillarScore: card.pillars.exit.score,
              reasonCodes: card.pillars.exit.reasons.map((reason) => reason.code),
              stressRequest: card.breakdowns?.exit.stressRequest ?? null,
              primaryRoute:
                card.breakdowns?.exit.primaryRoute == null
                  ? null
                  : {
                      key: card.breakdowns.exit.primaryRoute.key,
                      score: card.breakdowns.exit.primaryRoute.score,
                      capacity: card.breakdowns.exit.primaryRoute.capacity ?? null,
                    },
            },
          ]),
      );
    } else {
      safetyContext = {
        status: "cache-unavailable",
        reason: activeSafetySource.reason,
        identity: null,
      };
    }
  } catch {
    safetyContext = { status: "cache-unavailable", reason: "safety-score-v9-read-failed", identity: null };
  }

  const incidents = groupIncidents(historical, currencyOf).map((inc): DdrIncident => {
    const meta = TRACKED_META_BY_ID.get(inc.stablecoinId);
    return {
      ...inc,
      structural: meta ? structuralClass(toStructural(meta, structuralContext)) : "fragile",
      terminalAt: inc.recovered ? null : registryTerminalAtSec(meta),
    };
  });
  const quarantined = quarantinedCoins(incidents);

  const resolverHealthFailures = [
    supplyResult.error,
    mintBurnResult.error,
    scanCoverageError,
    dewsResult.error,
    liqResult.error,
    liqHistResult.error,
    redemptionResult.error,
  ].filter((reason): reason is string => reason != null);
  if (resolverHealthFailures.length > 0) {
    return { kind: "degraded", reason: resolverHealthFailures.join(","), dataAsOf: currentDeviation.dataAsOf };
  }

  return {
    kind: "ok",
    context: {
      active,
      activeCoinIds,
      activeEventById: new Map(activeRows.map((row) => [row.id, row])),
      incidents,
      quarantined,
      supplyByCoin,
      mintBurnHourlyByCoin,
      mintBurnCoveredEventIds,
      dewsByCoin,
      liqByCoin,
      liqTvlChange7dByCoin,
      liqTvlChange30dByCoin,
      liqVolumeChange30dByCoin,
      liqTvlChangeSinceOnsetByEventId,
      redemptionByCoin,
      safetyByCoin,
      v9ExitByCoin,
      safetyContext,
      structuralContext,
      lineage: {
        trainingWindow: { start: windowStart, end: nowSec },
        eventCount: historical.length,
        incidentCount: incidents.length,
        coinCount: new Set(incidents.map((i) => i.stablecoinId)).size,
        quarantinedCoins: quarantined.size,
        trainingRowsTruncated,
      },
    },
  };
}
