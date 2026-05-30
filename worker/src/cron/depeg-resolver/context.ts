import { derivePegRates, getPegReference } from "@shared/lib/peg-rates";
import { groupIncidents, quarantinedCoins, structuralClass, type DdrActiveEventInput, type DdrIncident } from "@shared/lib/depeg-resolver";
import { DDR_V2_EFFECTIVE_AT } from "@shared/lib/depeg-resolver-version";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { isTerminalStablecoinStatus } from "@shared/lib/stablecoin-lifecycle";
import { sumPegBuckets } from "@shared/lib/supply";
import type { StablecoinData } from "@shared/types/market";
import { deriveDepegSignal } from "../../lib/depeg-signals";
import { hasUsableStablecoinsPayload, loadStablecoinsCache } from "../../lib/stablecoins-cache";
import {
  CURRENT_PRICE_MAX_AGE_SEC,
  HISTORICAL_ROW_CAP,
  TRAINING_WINDOW_SEC,
} from "./constants";
import type {
  CurrentDeviationMapResult,
  DdrEventDbRow,
  DdrLineage,
  QueryRowsResult,
} from "./types";
import { formatDdrrFailure, placeholders, toStructural } from "./utils";

export interface DdrLoadedContext {
  active: DdrActiveEventInput[];
  activeCoinIds: string[];
  activeEventById: Map<number, DdrEventDbRow>;
  incidents: DdrIncident[];
  quarantined: Set<string>;
  supplyByCoin: Map<string, { date: number; usd: number }[]>;
  dewsByCoin: Map<string, { stablecoin_id: string; score: number; band: string; computed_at: number }>;
  liqByCoin: Map<string, { stablecoin_id: string; liquidity_score: number | null; concentration_hhi: number | null; updated_at: number }>;
  redemptionByCoin: Map<string, { stablecoin_id: string; immediate_capacity_ratio: number | null; route_family: string | null; updated_at: number }>;
  lineage: DdrLineage;
}

export type DdrContextLoadResult =
  | { kind: "ok"; context: DdrLoadedContext }
  | { kind: "degraded"; reason: string; dataAsOf: number | null };

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
    const result = await query();
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
  const result = await db
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
    .all<DdrEventDbRow>();
  return result.results ?? [];
}

export async function loadActiveConfirmedEvents(db: D1Database): Promise<DdrEventDbRow[]> {
  const activeResult = await db
    .prepare(
      "SELECT id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, " +
        "recovery_price, peg_reference, source, confirmation_sources, pending_reason, " +
        "provenance_replay_run_id, provenance_replay_version " +
        "FROM depeg_events_with_provenance WHERE ended_at IS NULL " +
        "AND (provenance_audit_verdict IS NULL OR provenance_audit_verdict NOT IN ('false_positive', 'disputed', 'no_data')) " +
        "ORDER BY started_at ASC",
    )
    .all<DdrEventDbRow>();

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
  const histResult = await db
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
    }>();
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

  const dewsResult = await queryRows("stress_signals", () => db
    .prepare(
      `SELECT s.stablecoin_id, s.score, s.band, s.computed_at FROM stress_signals s ` +
        `JOIN (SELECT stablecoin_id, MAX(computed_at) mc FROM stress_signals ` +
        `WHERE stablecoin_id IN (${placeholders(activeCoinIds.length)}) GROUP BY stablecoin_id) m ` +
        `ON s.stablecoin_id = m.stablecoin_id AND s.computed_at = m.mc`,
    )
    .bind(...activeCoinIds)
    .all<{ stablecoin_id: string; score: number; band: string; computed_at: number }>());
  const dewsByCoin = new Map(dewsResult.rows.map((d) => [d.stablecoin_id, d]));

  const liqResult = await queryRows("dex_liquidity", () => db
    .prepare(
      `SELECT stablecoin_id, liquidity_score, concentration_hhi, updated_at FROM dex_liquidity ` +
        `WHERE stablecoin_id IN (${placeholders(activeCoinIds.length)})`,
    )
    .bind(...activeCoinIds)
    .all<{ stablecoin_id: string; liquidity_score: number | null; concentration_hhi: number | null; updated_at: number }>());
  const liqByCoin = new Map(liqResult.rows.map((l) => [l.stablecoin_id, l]));

  const redemptionResult = await queryRows("redemption_backstop", () => db
    .prepare(
      `SELECT stablecoin_id, immediate_capacity_ratio, route_family, updated_at FROM redemption_backstop ` +
        `WHERE stablecoin_id IN (${placeholders(activeCoinIds.length)})`,
    )
    .bind(...activeCoinIds)
    .all<{
      stablecoin_id: string;
      immediate_capacity_ratio: number | null;
      route_family: string | null;
      updated_at: number;
    }>());
  const redemptionByCoin = new Map(redemptionResult.rows.map((r) => [r.stablecoin_id, r]));

  const resolverHealthFailures = [
    supplyResult.error,
    dewsResult.error,
    liqResult.error,
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
      dewsByCoin,
      liqByCoin,
      redemptionByCoin,
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
