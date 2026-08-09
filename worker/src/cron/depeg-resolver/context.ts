import { derivePegRates, getPegReference } from "@shared/lib/peg-rates";
import {
  groupIncidents,
  quarantinedCoins,
  structuralClass,
  type DdrActiveEventInput,
  type DdrIncident,
  type DdrSafetyContextProvenance,
  type DdrV9ExitContext,
} from "@shared/lib/depeg-resolver";
import { DDR_V2_EFFECTIVE_AT } from "@shared/lib/methodology-versions/depeg-resolver";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { isTerminalStablecoinStatus } from "@shared/lib/stablecoin-lifecycle";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { sumPegBuckets } from "@shared/lib/supply";
import type { StablecoinData } from "@shared/types/market";
import {
  getDexLiquidityTrendTolerances,
  selectTrendBaseline,
  type DexHistoryRow,
} from "../../api/dex-liquidity-response";
import { deriveDepegSignal } from "../../lib/depeg-signals";
import { DEX_LIQUIDITY_PUBLISHED_ROW_FILTER } from "../../lib/dex-liquidity";
import {
  loadRedemptionBackstopLiveSignalRows,
  RedemptionBackstopSnapshotUnavailableError,
} from "../../lib/redemption-backstops-store";
import { hasUsableStablecoinsPayload, loadStablecoinsCache } from "../../lib/stablecoins-cache";
import { loadActiveSafetyScoreSource } from "../../lib/safety-score-active-source";
import { loadPublishedStressSignalGeneration } from "../../lib/stress-signals-current-rows";
import { MINT_BURN_CONFIGS } from "../../lib/mint-burn-contracts";
import {
  CURRENT_PRICE_MAX_AGE_SEC,
  DAY,
  HISTORICAL_ROW_CAP,
  TRAINING_WINDOW_SEC,
} from "./constants";
import type {
  CurrentDeviationMapResult,
  DdrEventDbRow,
  DdrLineage,
  QueryRowsResult,
} from "./types";
import {
  clearV9DependencyImpairment,
  formatDdrrFailure,
  hydrateV9DependencyImpairment,
  placeholders,
  toStructural,
} from "./utils";

export interface DdrLoadedContext {
  active: DdrActiveEventInput[];
  activeCoinIds: string[];
  activeEventById: Map<number, DdrEventDbRow>;
  incidents: DdrIncident[];
  quarantined: Set<string>;
  supplyByCoin: Map<string, { date: number; usd: number }[]>;
  mintBurnHourlyByCoin: Map<string, { hourTs: number; netFlowUsd: number }[]>;
  dewsByCoin: Map<string, { stablecoin_id: string; score: number; band: string; signals_json: string | null; computed_at: number }>;
  liqByCoin: Map<string, { stablecoin_id: string; liquidity_score: number | null; concentration_hhi: number | null; total_tvl_usd: number | null; total_volume_24h_usd: number | null; updated_at: number }>;
  liqTvlChange7dByCoin: Map<string, number>;
  liqTvlChange30dByCoin: Map<string, number>;
  liqVolumeChange30dByCoin: Map<string, number>;
  redemptionByCoin: Map<string, { stablecoin_id: string; immediate_capacity_ratio: number | null; route_family: string | null; updated_at: number }>;
  safetyByCoin: Map<string, { stablecoin_id: string; grade: string; score: number | null; recorded_at: number }>;
  v9ExitByCoin: Map<string, DdrV9ExitContext>;
  safetyContext: DdrSafetyContextProvenance;
  lineage: DdrLineage;
}

export type DdrContextLoadResult =
  | { kind: "ok"; context: DdrLoadedContext }
  | { kind: "degraded"; reason: string; dataAsOf: number | null };

type DdrDexHistoryRow = DexHistoryRow & {
  total_volume_24h_usd: number;
};

const MINT_BURN_COVERED_COIN_IDS = new Set(MINT_BURN_CONFIGS.map((config) => config.stablecoinId));

export function emptyDdrLineage(nowSec: number): DdrLineage {
  return {
    trainingWindow: { start: nowSec - TRAINING_WINDOW_SEC, end: nowSec },
    eventCount: 0,
    incidentCount: 0,
    coinCount: 0,
    quarantinedCoins: 0,
  };
}

export async function queryRows<T>(label: string, query: () => Promise<{ results?: T[] }>): Promise<QueryRowsResult<T>> {
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

async function buildCurrentDeviationMap(
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
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const { rates } = derivePegRates(assets, TRACKED_META_BY_ID, cache.payload.fxFallbackRates);
  const out = new Map<string, number | null>();

  for (const [id, asset] of assetById) {
    const meta = TRACKED_META_BY_ID.get(id);
    if (!meta || meta.flags.navToken) continue;
    const supply = asset.circulating ? sumPegBuckets(asset.circulating) : 0;
    if (supply <= 0 || asset.price == null || !Number.isFinite(asset.price)) {
      out.set(id, null);
      continue;
    }
    const pegRef = getPegReference(asset.pegType, rates, meta.commodityOunces);
    out.set(id, deriveDepegSignal(asset.price, pegRef)?.bps ?? null);
  }

  return { byCoin: out, healthy: true, degradedReason: null, dataAsOf: cache.updatedAt };
}

export async function loadPolicyUniverseEvents(db: D1Database): Promise<DdrEventDbRow[]> {
  const result = await runWithOverloadRetry(() => db
    .prepare(
      "SELECT id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, " +
        "recovery_price, peg_reference, source, confirmation_sources, pending_reason, " +
        "provenance_replay_run_id, provenance_replay_version " +
        "FROM depeg_events_with_provenance " +
        "WHERE (provenance_audit_verdict IS NULL OR provenance_audit_verdict NOT IN ('false_positive', 'disputed', 'no_data')) " +
        "AND (started_at >= ? OR (started_at < ? AND (ended_at IS NULL OR ended_at >= ?))) " +
        "ORDER BY started_at ASC, id ASC",
    )
    .bind(DDR_V2_EFFECTIVE_AT, DDR_V2_EFFECTIVE_AT, DDR_V2_EFFECTIVE_AT)
    .all<DdrEventDbRow>());
  return result.results ?? [];
}

export async function loadActiveConfirmedEvents(db: D1Database): Promise<DdrEventDbRow[]> {
  const activeResult = await runWithOverloadRetry(() => db
    .prepare(
      "SELECT id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, " +
        "recovery_price, peg_reference, source, confirmation_sources, pending_reason, " +
        "provenance_replay_run_id, provenance_replay_version " +
        "FROM depeg_events_with_provenance WHERE ended_at IS NULL " +
        "AND (provenance_audit_verdict IS NULL OR provenance_audit_verdict NOT IN ('false_positive', 'disputed', 'no_data')) " +
        "ORDER BY started_at ASC",
    )
    .all<DdrEventDbRow>());

  return (activeResult.results ?? []).filter((row) => {
    const status = TRACKED_META_BY_ID.get(row.stablecoin_id)?.status ?? null;
    return !isTerminalStablecoinStatus(status);
  });
}

export async function loadDdrContext(
  db: D1Database,
  activeRows: DdrEventDbRow[],
  nowSec: number,
): Promise<DdrContextLoadResult> {
  clearV9DependencyImpairment();
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
  const classOf = (id: string) => {
    const meta = TRACKED_META_BY_ID.get(id);
    return meta ? structuralClass(toStructural(meta)) : ("fragile" as const);
  };

  const windowStart = nowSec - TRAINING_WINDOW_SEC;
  const histResult = await runWithOverloadRetry(() => db
    .prepare(
      "SELECT stablecoin_id, direction, peak_deviation_bps, started_at, ended_at, recovery_price " +
        "FROM depeg_events WHERE ended_at IS NOT NULL AND started_at >= ? " +
        `AND direction IN (${placeholders(directions.length)}) LIMIT ${HISTORICAL_ROW_CAP}`,
    )
    .bind(windowStart, ...directions)
    .all<{
      stablecoin_id: string;
      direction: string;
      peak_deviation_bps: number;
      started_at: number;
      ended_at: number | null;
      recovery_price: number | null;
    }>());
  const histRows = histResult.results ?? [];
  const historical = histRows.map((r) => ({
    stablecoinId: r.stablecoin_id,
    direction: r.direction === "above" ? "above" as const : "below" as const,
    peakDeviationBps: r.peak_deviation_bps,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    recoveryPrice: r.recovery_price,
  }));

  const incidents: DdrIncident[] = groupIncidents(historical, currencyOf).map((inc) => ({
    ...inc,
    structural: classOf(inc.stablecoinId),
  }));
  const quarantined = quarantinedCoins(incidents);

  const supplyResult = await queryRows("supply_history", () => db
    .prepare(
      `SELECT stablecoin_id, snapshot_date, circulating_usd FROM supply_history ` +
        `WHERE stablecoin_id IN (${placeholders(activeCoinIds.length)}) ORDER BY stablecoin_id, snapshot_date ASC`,
    )
    .bind(...activeCoinIds)
    .all<{ stablecoin_id: string; snapshot_date: number; circulating_usd: number }>());
  const supplyByCoin = new Map<string, { date: number; usd: number }[]>();
  for (const s of supplyResult.rows) {
    const list = supplyByCoin.get(s.stablecoin_id) ?? [];
    list.push({ date: s.snapshot_date, usd: s.circulating_usd });
    supplyByCoin.set(s.stablecoin_id, list);
  }

  const mintBurnCoinIds = activeCoinIds.filter((id) => MINT_BURN_COVERED_COIN_IDS.has(id));
  const mintBurnResult: QueryRowsResult<{
    stablecoin_id: string;
    hour_ts: number;
    net_flow_usd: number;
  }> = mintBurnCoinIds.length === 0
    ? { rows: [], error: null }
    : await queryRows("mint_burn_hourly", () => db
        .prepare(
          `SELECT stablecoin_id, hour_ts, net_flow_usd FROM mint_burn_hourly ` +
            `WHERE stablecoin_id IN (${placeholders(mintBurnCoinIds.length)}) AND hour_ts >= ? AND hour_ts <= ? ` +
            "ORDER BY stablecoin_id, hour_ts ASC",
        )
        .bind(
          ...mintBurnCoinIds,
          Math.min(...active.map((event) => event.startedAt - 7 * DAY)),
          Math.max(...active.map((event) => event.startedAt)),
        )
        .all<{
          stablecoin_id: string;
          hour_ts: number;
          net_flow_usd: number;
        }>());
  const mintBurnHourlyByCoin = new Map<string, { hourTs: number; netFlowUsd: number }[]>();
  for (const row of mintBurnResult.rows) {
    const list = mintBurnHourlyByCoin.get(row.stablecoin_id) ?? [];
    list.push({ hourTs: row.hour_ts, netFlowUsd: row.net_flow_usd });
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

  const liqResult = await queryRows("dex_liquidity", () => db
    .prepare(
      `SELECT stablecoin_id, liquidity_score, concentration_hhi, total_tvl_usd, total_volume_24h_usd, updated_at FROM dex_liquidity ` +
        `WHERE stablecoin_id IN (${placeholders(activeCoinIds.length)}) ` +
        `AND ${DEX_LIQUIDITY_PUBLISHED_ROW_FILTER}`,
    )
    .bind(...activeCoinIds)
    .all<{
      stablecoin_id: string;
      liquidity_score: number | null;
      concentration_hhi: number | null;
      total_tvl_usd: number | null;
      total_volume_24h_usd: number | null;
      updated_at: number;
    }>());
  const liqByCoin = new Map(liqResult.rows.map((l) => [l.stablecoin_id, l]));

  const liqHistResult = await queryRows("dex_liquidity_history", () => db
    .prepare(
      `SELECT stablecoin_id, total_tvl_usd, total_volume_24h_usd, snapshot_date, coverage_class, coverage_confidence ` +
        `FROM dex_liquidity_history ` +
        `WHERE stablecoin_id IN (${placeholders(activeCoinIds.length)}) AND snapshot_date >= ? ` +
        `ORDER BY stablecoin_id, snapshot_date DESC`,
    )
    .bind(...activeCoinIds, nowSec - 32 * DAY)
    .all<DdrDexHistoryRow>());
  const liqHistoryByCoin = new Map<string, DdrDexHistoryRow[]>();
  for (const row of liqHistResult.rows) {
    const rows = liqHistoryByCoin.get(row.stablecoin_id) ?? [];
    rows.push(row);
    liqHistoryByCoin.set(row.stablecoin_id, rows);
  }
  const liqTvlChange7dByCoin = new Map<string, number>();
  const liqTvlChange30dByCoin = new Map<string, number>();
  const liqVolumeChange30dByCoin = new Map<string, number>();
  const target7d = nowSec - 7 * DAY;
  const target30d = nowSec - 30 * DAY;
  const { week: trend7dToleranceSec } = getDexLiquidityTrendTolerances();
  for (const row of liqResult.rows) {
    const currentTvl = row.total_tvl_usd;
    const history = liqHistoryByCoin.get(row.stablecoin_id) ?? [];
    const baseline7d = selectTrendBaseline(history, target7d, trend7dToleranceSec) as DdrDexHistoryRow | null;
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
    const baseline30d = selectTrendBaseline(history, target30d, trend7dToleranceSec) as DdrDexHistoryRow | null;
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
    const currentVolume = row.total_volume_24h_usd;
    if (
      baseline30d &&
      baseline30d.total_volume_24h_usd > 0 &&
      currentVolume != null &&
      Number.isFinite(currentVolume)
    ) {
      liqVolumeChange30dByCoin.set(
        row.stablecoin_id,
        ((currentVolume - baseline30d.total_volume_24h_usd) / baseline30d.total_volume_24h_usd) * 100,
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
      if (error instanceof RedemptionBackstopSnapshotUnavailableError) return { results: [] };
      throw error;
    }
  });
  const redemptionByCoin = new Map(redemptionResult.rows.map((r) => [r.stablecoin_id, r]));

  let safetyByCoin = new Map<string, { stablecoin_id: string; grade: string; score: number | null; recorded_at: number }>();
  let v9ExitByCoin = new Map<string, DdrV9ExitContext>();
  let safetyContext: DdrSafetyContextProvenance = {
    status: "cache-unavailable",
    reason: "safety-score-v9-unavailable",
    identity: null,
  };
  try {
    const activeSafetySource = await loadActiveSafetyScoreSource(db);
    if (activeSafetySource.kind === "held") {
      safetyContext = {
        status: "cache-unavailable",
        reason: activeSafetySource.reason,
        identity: activeSafetySource.snapshot.safetyScoreIdentity,
      };
    } else if (activeSafetySource.kind === "v9") {
      hydrateV9DependencyImpairment(activeSafetySource.snapshot.cards);
      safetyContext = {
        status: "v9-identified",
        reason: null,
        identity: activeSafetySource.snapshot.safetyScoreIdentity,
      };
      safetyByCoin = new Map(
        activeSafetySource.snapshot.cards
          .filter((card) => activeCoinIds.includes(card.id))
          .map((card) => [
            card.id,
            {
              stablecoin_id: card.id,
              grade: card.grade,
              score: card.score,
              recorded_at: activeSafetySource.snapshot.updatedAt,
            },
          ]),
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

  const resolverHealthFailures = [
    supplyResult.error,
    mintBurnResult.error,
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
      dewsByCoin,
      liqByCoin,
      liqTvlChange7dByCoin,
      liqTvlChange30dByCoin,
      liqVolumeChange30dByCoin,
      redemptionByCoin,
      safetyByCoin,
      v9ExitByCoin,
      safetyContext,
      lineage: {
        trainingWindow: { start: windowStart, end: nowSec },
        eventCount: historical.length,
        incidentCount: incidents.length,
        coinCount: new Set(incidents.map((i) => i.stablecoinId)).size,
        quarantinedCoins: quarantined.size,
      },
    },
  };
}
