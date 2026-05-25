import {
  DDR_PUBLIC_WARNING,
  type DdrResponse,
  type DdrRow,
} from "@shared/types/depeg-resolver";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import {
  DDR_DURATION_MODEL_VERSION,
  DDR_INCIDENT_GROUPING_VERSION,
  DDR_METHODOLOGY_CHANGELOG_PATH,
  DDR_METHODOLOGY_VERSION,
  DDR_METHODOLOGY_VERSION_LABEL,
  DDR_RESOLUTION_RUBRIC_VERSION,
  DDR_SUPPORT_RULES_VERSION,
} from "@shared/lib/depeg-resolver-version";
import { derivePegRates, getPegReference } from "@shared/lib/peg-rates";
import {
  groupIncidents,
  quarantinedCoins,
  resolveDepeg,
  structuralClass,
  type DdrActiveEventInput,
  type DdrCoinStructural,
  type DdrHistoricalEvent,
  type DdrIncident,
  type DdrLiveContext,
  type DdrSupplyContext,
} from "@shared/lib/depeg-resolver";
import { TRACKED_META_BY_ID, FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import type { StablecoinMeta } from "@shared/types/core";
import { sumPegBuckets } from "@shared/lib/supply";
import type { StablecoinData } from "@shared/types/market";
import { buildMethodologyEnvelope } from "../lib/api-utils";
import type { CronResult } from "../lib/cron-logger";
import { computeAndStoreDepegResolverReview } from "./compute-depeg-resolver-review";
import { writeDepegResolverAssessments } from "../lib/depeg-resolver-assessment-store";
import { writeDepegResolverSnapshot } from "../lib/depeg-resolver-snapshot-cache";
import { deriveDepegSignal } from "../lib/depeg-signals";
import { hasUsableStablecoinsPayload, loadStablecoinsCache } from "../lib/stablecoins-cache";

const TRAINING_WINDOW_SEC = 4 * 365 * 86400;
const HISTORICAL_ROW_CAP = 60000;
const DAY = 86400;
const CURRENT_PRICE_MAX_AGE_SEC = API_FRESHNESS_MAX_AGE_SEC.stablecoins;
const DEWS_MAX_AGE_SEC = API_FRESHNESS_MAX_AGE_SEC.stressSignals;
const DEX_LIQUIDITY_MAX_AGE_SEC = API_FRESHNESS_MAX_AGE_SEC.dexLiquidity;
const REDEMPTION_BACKSTOP_MAX_AGE_SEC = API_FRESHNESS_MAX_AGE_SEC.redemptionBackstops;

function abortIf(signal: AbortSignal | undefined, label: string): void {
  if (signal?.aborted) throw signal.reason ?? new Error(`${label} aborted`);
}

function pegCurrencyFromPegType(pegType: string): string {
  return pegType.startsWith("pegged") ? pegType.slice("pegged".length) : "USD";
}

function toStructural(meta: StablecoinMeta): DdrCoinStructural {
  return {
    id: meta.id,
    symbol: meta.symbol,
    name: meta.name,
    pegCurrency: meta.flags.pegCurrency,
    governance: meta.flags.governance,
    status: meta.status ?? null,
    mechanismArchetype: meta.mechanismArchetype ?? null,
    mintPath: meta.mintAuthority?.mintPath ?? null,
    authorityPosture: meta.mintAuthority?.authorityPosture ?? null,
    mintConfidence: meta.mintAuthority?.confidence ?? null,
    collateralQuality: meta.collateralQuality ?? null,
    custodyModel: meta.custodyModel ?? null,
    deploymentModel: meta.deploymentModel ?? null,
    governanceQuality: meta.governanceQuality ?? null,
    reserves: meta.reserves?.map((r) => ({ risk: r.risk, pct: r.pct })),
    canBeBlacklisted: meta.canBeBlacklisted ?? null,
    dependencyImpaired: meta.dependencies?.some((d) => FROZEN_IDS.has(d.id) && d.weight >= 0.3) ?? false,
  };
}

function fallbackStructural(id: string, symbol: string, pegType: string): DdrCoinStructural {
  return {
    id,
    symbol,
    name: symbol,
    pegCurrency: pegCurrencyFromPegType(pegType),
    governance: "centralized",
  };
}

/** Latest supply <= ts, walking a coin's ascending snapshots. */
function supplyAt(snapshots: { date: number; usd: number }[], ts: number): number | null {
  let val: number | null = null;
  for (const s of snapshots) {
    if (s.date <= ts) val = s.usd;
    else break;
  }
  return val;
}

function buildSupplyContext(snapshots: { date: number; usd: number }[], startedAt: number): DdrSupplyContext {
  if (snapshots.length < 2) {
    return { covered: false, change7dPct: null, change30dPct: null, mintSurge: null };
  }
  const onset = supplyAt(snapshots, startedAt) ?? snapshots[snapshots.length - 1].usd;
  const d7 = supplyAt(snapshots, startedAt - 7 * DAY);
  const d30 = supplyAt(snapshots, startedAt - 30 * DAY);
  const change7dPct = d7 != null && d7 > 0 ? ((onset - d7) / d7) * 100 : null;
  const change30dPct = d30 != null && d30 > 0 ? ((onset - d30) / d30) * 100 : null;
  return {
    covered: true,
    change7dPct,
    change30dPct,
    mintSurge: change7dPct != null ? change7dPct > 20 : null,
  };
}

async function buildCurrentDeviationMap(
  db: D1Database,
  nowSec: number,
): Promise<Map<string, number | null>> {
  const cache = await loadStablecoinsCache(db, { mode: "lenient", contract: "critical-fields" });
  if (!hasUsableStablecoinsPayload(cache) || cache.updatedAt == null || nowSec - cache.updatedAt > CURRENT_PRICE_MAX_AGE_SEC) {
    return new Map();
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

  return out;
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

function formatDdrrFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function persistDepegResolverReviewArtifacts(
  db: D1Database,
  snapshot: DdrResponse,
  signal?: AbortSignal,
): Promise<{ assessmentWriteCount: number; reviewRows: number; reviewError: string | null }> {
  let assessmentWriteCount = 0;
  let reviewRows = 0;

  try {
    assessmentWriteCount = await writeDepegResolverAssessments(db, snapshot);
    const reviewResult = await computeAndStoreDepegResolverReview(db, signal);
    reviewRows = reviewResult.itemCount ?? 0;
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      assessmentWriteCount,
      reviewRows,
      reviewError: formatDdrrFailure(error),
    };
  }

  return { assessmentWriteCount, reviewRows, reviewError: null };
}

export async function computeDepegResolver(db: D1Database, signal?: AbortSignal): Promise<CronResult> {
  abortIf(signal, "compute-depeg-resolver");
  const nowSec = Math.floor(Date.now() / 1000);

  const currencyOf = (id: string): string => TRACKED_META_BY_ID.get(id)?.flags.pegCurrency ?? "USD";
  const classOf = (id: string) => {
    const meta = TRACKED_META_BY_ID.get(id);
    return meta ? structuralClass(toStructural(meta)) : ("fragile" as const);
  };

  // 1. Active confirmed depeg events.
  const activeResult = await db
    .prepare(
      "SELECT id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, peg_reference " +
        "FROM depeg_events_with_provenance WHERE ended_at IS NULL " +
        "AND (provenance_audit_verdict IS NULL OR provenance_audit_verdict NOT IN ('false_positive', 'disputed', 'no_data')) " +
        "ORDER BY started_at ASC",
    )
    .all<{
      id: number;
      stablecoin_id: string;
      symbol: string;
      peg_type: string;
      direction: string;
      peak_deviation_bps: number;
      started_at: number;
      peg_reference: number;
    }>();
  const activeRows = activeResult.results ?? [];

  let rows: DdrRow[] = [];
  let lineage: DdrResponse["_meta"]["lineage"] = {
    trainingWindow: { start: nowSec - TRAINING_WINDOW_SEC, end: nowSec },
    eventCount: 0,
    incidentCount: 0,
    coinCount: 0,
    quarantinedCoins: 0,
  };

  if (activeRows.length > 0) {
    const currentDeviationByCoin = await buildCurrentDeviationMap(db, nowSec);
    const active: DdrActiveEventInput[] = activeRows.map((r) => ({
      id: r.id,
      stablecoinId: r.stablecoin_id,
      symbol: r.symbol,
      pegType: r.peg_type,
      direction: r.direction === "above" ? "above" : "below",
      peakDeviationBps: r.peak_deviation_bps,
      startedAt: r.started_at,
      pegReference: r.peg_reference,
      currentDeviationBps: currentDeviationByCoin.get(r.stablecoin_id) ?? null,
    }));
    const activeCoinIds = [...new Set(active.map((a) => a.stablecoinId))];
    const directions = [...new Set(active.map((a) => a.direction))];

    abortIf(signal, "compute-depeg-resolver");

    // 2. Historical recovered/closed events for grouping (training window, matching directions).
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
    const historical: DdrHistoricalEvent[] = histRows.map((r) => ({
      stablecoinId: r.stablecoin_id,
      direction: r.direction === "above" ? "above" : "below",
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

    abortIf(signal, "compute-depeg-resolver");

    // 3. Context: supply history + latest DEWS + latest DEX liquidity for active coins.
    const supplyResult = await db
      .prepare(
        `SELECT stablecoin_id, snapshot_date, circulating_usd FROM supply_history ` +
          `WHERE stablecoin_id IN (${placeholders(activeCoinIds.length)}) ORDER BY stablecoin_id, snapshot_date ASC`,
      )
      .bind(...activeCoinIds)
      .all<{ stablecoin_id: string; snapshot_date: number; circulating_usd: number }>();
    const supplyByCoin = new Map<string, { date: number; usd: number }[]>();
    for (const s of supplyResult.results ?? []) {
      const list = supplyByCoin.get(s.stablecoin_id) ?? [];
      list.push({ date: s.snapshot_date, usd: s.circulating_usd });
      supplyByCoin.set(s.stablecoin_id, list);
    }

    const dewsResult = await db
      .prepare(
        `SELECT s.stablecoin_id, s.score, s.band, s.computed_at FROM stress_signals s ` +
          `JOIN (SELECT stablecoin_id, MAX(computed_at) mc FROM stress_signals ` +
          `WHERE stablecoin_id IN (${placeholders(activeCoinIds.length)}) GROUP BY stablecoin_id) m ` +
          `ON s.stablecoin_id = m.stablecoin_id AND s.computed_at = m.mc`,
      )
      .bind(...activeCoinIds)
      .all<{ stablecoin_id: string; score: number; band: string; computed_at: number }>();
    const dewsByCoin = new Map((dewsResult.results ?? []).map((d) => [d.stablecoin_id, d]));

    const liqResult = await db
      .prepare(
        `SELECT stablecoin_id, liquidity_score, concentration_hhi, updated_at FROM dex_liquidity ` +
          `WHERE stablecoin_id IN (${placeholders(activeCoinIds.length)})`,
      )
      .bind(...activeCoinIds)
      .all<{ stablecoin_id: string; liquidity_score: number | null; concentration_hhi: number | null; updated_at: number }>();
    const liqByCoin = new Map((liqResult.results ?? []).map((l) => [l.stablecoin_id, l]));

    const redemptionResult = await db
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
      }>();
    const redemptionByCoin = new Map((redemptionResult.results ?? []).map((r) => [r.stablecoin_id, r]));

    abortIf(signal, "compute-depeg-resolver");

    rows = active.map((ev) => {
      const meta = TRACKED_META_BY_ID.get(ev.stablecoinId);
      const coin = meta ? toStructural(meta) : fallbackStructural(ev.stablecoinId, ev.symbol, ev.pegType);
      const supply = buildSupplyContext(supplyByCoin.get(ev.stablecoinId) ?? [], ev.startedAt);
      const dews = dewsByCoin.get(ev.stablecoinId);
      const liq = liqByCoin.get(ev.stablecoinId);
      const redemption = redemptionByCoin.get(ev.stablecoinId);
      const dewsFresh = dews != null && nowSec - dews.computed_at <= DEWS_MAX_AGE_SEC;
      const liqFresh = liq != null && nowSec - liq.updated_at <= DEX_LIQUIDITY_MAX_AGE_SEC;
      const redemptionFresh = redemption != null && nowSec - redemption.updated_at <= REDEMPTION_BACKSTOP_MAX_AGE_SEC;
      const live: DdrLiveContext = {
        dewsBand: dewsFresh ? dews.band : null,
        dewsScore: dewsFresh ? dews.score : null,
        liquidityScore: liqFresh ? liq.liquidity_score : null,
        concentrationHhi: liqFresh ? liq.concentration_hhi : null,
        redemptionCapacityRatio: redemptionFresh ? redemption.immediate_capacity_ratio : null,
        redemptionRouteFamily: redemptionFresh ? redemption.route_family : null,
      };
      return resolveDepeg({ active: ev, coin, supply, live, nowSec, incidents, quarantined });
    });

    lineage = {
      trainingWindow: { start: windowStart, end: nowSec },
      eventCount: historical.length,
      incidentCount: incidents.length,
      coinCount: new Set(incidents.map((i) => i.stablecoinId)).size,
      quarantinedCoins: quarantined.size,
    };
  }

  const snapshot: DdrResponse = {
    _meta: {
      dataAsOf: nowSec,
      modelAsOf: nowSec,
      computedAt: nowSec,
      expiresAt: nowSec + 1800,
      degraded: false,
      degradedReason: null,
      publicWarning: DDR_PUBLIC_WARNING,
      resolutionRubricVersion: DDR_RESOLUTION_RUBRIC_VERSION,
      durationModelVersion: DDR_DURATION_MODEL_VERSION,
      incidentGroupingVersion: DDR_INCIDENT_GROUPING_VERSION,
      supportRulesVersion: DDR_SUPPORT_RULES_VERSION,
      lineage,
    },
    rows,
    methodology: buildMethodologyEnvelope({
      version: DDR_METHODOLOGY_VERSION,
      versionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      currentVersion: DDR_METHODOLOGY_VERSION,
      currentVersionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      changelogPath: DDR_METHODOLOGY_CHANGELOG_PATH,
      asOf: nowSec,
    }),
  };

  await writeDepegResolverSnapshot(db, snapshot);
  const reviewArtifacts = await persistDepegResolverReviewArtifacts(db, snapshot, signal);

  return {
    itemCount: rows.length,
    metadata: JSON.stringify({
      activeEvents: rows.length,
      assessmentWriteCount: reviewArtifacts.assessmentWriteCount,
      reviewRows: reviewArtifacts.reviewRows,
      ddrrDegraded: reviewArtifacts.reviewError != null,
      ddrrDegradedReason: reviewArtifacts.reviewError,
      incidentCount: lineage?.incidentCount ?? 0,
      quarantinedCoins: lineage?.quarantinedCoins ?? 0,
    }),
  };
}
