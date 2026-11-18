import {
  resolveDepeg,
  type DdrLiveContext,
  type DdrSupplyContext,
  type DdrWindDownFingerprintContext,
} from "@shared/lib/depeg-resolver";
import { isAmbiguousSupplyPerimeterDay, isEarlierSupplyPerimeter } from "@shared/lib/supply-perimeter-changes";
import { unwrapStressSignalsEnvelope } from "@shared/lib/stress-signals-envelope";
import { isRecord } from "@shared/lib/type-guards";
import { WORKER_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import {
  DEWS_MAX_AGE_SEC,
  DEX_LIQUIDITY_MAX_AGE_SEC,
  DAY,
  REDEMPTION_BACKSTOP_MAX_AGE_SEC,
} from "./constants";
import type { DdrLoadedContext, DdrMintBurnHourlyRow, DdrSupplySnapshot } from "./context";
import type { DdrAssessmentRow } from "./types";
import {
  addMintBurnValuationTally,
  emptyMintBurnValuationTally,
  mintBurnSignedNetRange,
  summarizeMintBurnValuation,
} from "@shared/lib/mint-burn-valuation";
import { MINT_BURN_COVERED_COIN_IDS } from "./mint-burn-coverage";
import { fallbackStructural, toStructural } from "./utils";

const DDR_BANK_RUN_SUPPLY_SIGNAL_THRESHOLD = 65;
const DDR_BLACKLIST_SURGE_SIGNAL_THRESHOLD = 55;
const MINT_SURGE_NET_INFLOW_PCT = 20;
const MINT_SURGE_WINDOW_SEC = 7 * DAY;

function supplyAt<Snapshot extends { date: number }>(snapshots: Snapshot[], ts: number): Snapshot | null {
  let latest: Snapshot | null = null;
  for (const s of snapshots) {
    if (s.date <= ts) latest = s;
    else break;
  }
  return latest;
}

function nativeQuantityAt(snapshot: DdrSupplySnapshot, targetAt: number): number | null {
  const observedAt = snapshot.nativeObservedAt;
  return Math.floor(snapshot.date / DAY) === Math.floor(targetAt / DAY) &&
    observedAt != null && Number.isSafeInteger(observedAt) && observedAt > 0 && observedAt <= targetAt
    ? snapshot.native ?? null : null;
}

function supplyChange(
  snapshots: DdrSupplySnapshot[], endAt: number, baselineAt: number,
): { pct: number | null; covered: boolean } {
  const latest = supplyAt(snapshots, endAt);
  const baseline = supplyAt(snapshots, baselineAt);
  const missing = { pct: null, covered: false };
  if (!latest || !baseline) return missing;
  const native = latest.native !== undefined || baseline.native !== undefined;
  if (native && latest.date <= baseline.date) return missing;
  const end = native ? nativeQuantityAt(latest, endAt) : latest.usd;
  const start = native ? nativeQuantityAt(baseline, baselineAt) : baseline.usd;
  if (end == null || start == null || !Number.isFinite(end) || end < 0 || !Number.isFinite(start) || start <= 0) return missing;
  const pct = ((end - start) / start) * 100;
  return Number.isFinite(pct) ? { pct, covered: native || end > 0 } : missing;
}

/**
 * Mint surge from measured hourly net inflow. Missing USD valuation can move
 * the true net only one way per side (unpriced mints raise it, unpriced burns
 * lower it), so a surge is taken from mint/burn evidence only when the proven
 * net range decides the threshold on both ends. Otherwise, as for uncovered
 * coins, the supply-history proxy decides.
 */
export function deriveMintSurge(
  snapshots: { date: number; usd: number }[],
  startedAt: number,
  change7dPct: number | null,
  hourlyRows: DdrMintBurnHourlyRow[],
  hasMintBurnCoverage: boolean | null,
): Pick<DdrSupplyContext, "mintSurge" | "mintSurgeCoverage"> {
  if (hasMintBurnCoverage === null) return { mintSurge: null, mintSurgeCoverage: "unavailable" };
  if (hasMintBurnCoverage) {
    const onset = supplyAt(snapshots, startedAt)?.usd;
    if (onset == null || !Number.isFinite(onset) || onset <= 0) {
      return { mintSurge: null, mintSurgeCoverage: "unavailable" };
    }
    const end = Math.floor(startedAt / 3600) * 3600;
    const windowedRows = hourlyRows.filter(
      (row) => row.hourTs >= end - MINT_SURGE_WINDOW_SEC && row.hourTs < end,
    );
    if (windowedRows.some((row) => !Number.isFinite(row.netFlowUsd))) {
      return { mintSurge: null, mintSurgeCoverage: "unavailable" };
    }
    const valuation = emptyMintBurnValuationTally();
    let knownNetInflowUsd = 0;
    for (const row of windowedRows) {
      knownNetInflowUsd += row.netFlowUsd;
      addMintBurnValuationTally(valuation, row.valuation);
    }
    const { lowerUsd, upperUsd } = mintBurnSignedNetRange(knownNetInflowUsd, summarizeMintBurnValuation(valuation));
    if ((lowerUsd / onset) * 100 > MINT_SURGE_NET_INFLOW_PCT) {
      return { mintSurge: true, mintSurgeCoverage: "mint-burn-hourly" };
    }
    if ((upperUsd / onset) * 100 <= MINT_SURGE_NET_INFLOW_PCT) {
      return { mintSurge: false, mintSurgeCoverage: "mint-burn-hourly" };
    }
  }

  if (change7dPct == null || !Number.isFinite(change7dPct)) {
    return { mintSurge: null, mintSurgeCoverage: "unavailable" };
  }
  return {
    mintSurge: change7dPct > MINT_SURGE_NET_INFLOW_PCT,
    mintSurgeCoverage: "supply-history-proxy",
  };
}

/**
 * Supply context for one active event. Exported so tests can prove the windowed
 * `supply_history` read (`readActiveSupplyHistory`) yields exactly the same
 * context as the coin's full series for every lookup it performs.
 */
export function buildSupplyContext(
  snapshots: DdrSupplySnapshot[],
  startedAt: number,
  evaluatedAt: number,
  mintBurnHourly: DdrMintBurnHourlyRow[],
  hasMintBurnCoverage: boolean | null,
) {
  if (snapshots.length < 2) {
    return {
      covered: false,
      change7dPct: null,
      change30dPct: null,
      mintSurge: null,
      mintSurgeCoverage: "unavailable" as const,
    };
  }
  const { pct: change7dPct, covered } = supplyChange(snapshots, startedAt, startedAt - 7 * DAY);
  const { pct: change30dPct } = supplyChange(snapshots, evaluatedAt, evaluatedAt - 30 * DAY);
  return {
    covered,
    change7dPct,
    change30dPct,
    ...deriveMintSurge(snapshots, startedAt, change7dPct, mintBurnHourly, hasMintBurnCoverage),
  };
}

function parseDewsSignals(signalsJson: string | null | undefined): Record<string, unknown> | null {
  if (!signalsJson) return null;
  try {
    return unwrapStressSignalsEnvelope(JSON.parse(signalsJson))?.signals ?? null;
  } catch {
    return null;
  }
}

function dewsSignalAtLeast(
  signals: Record<string, unknown> | null,
  key: string,
  threshold: number,
): boolean | null {
  const signal = signals?.[key];
  if (!isRecord(signal) || signal.available !== true) return null;
  return typeof signal.value === "number" && Number.isFinite(signal.value)
    ? signal.value >= threshold
    : null;
}

/** Latest admitted supply snapshot no older than the dislocation-sizing budget; otherwise unavailable. */
const DDR_DISLOCATION_SUPPLY_MAX_AGE_SEC = 3 * 86400;

function latestCirculatingUsd(snapshots: readonly { date: number; usd: number }[], nowSec: number): number | null {
  let latest: { date: number; usd: number } | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.date > nowSec) continue;
    if (latest == null || snapshot.date > latest.date) latest = snapshot;
  }
  if (latest == null || nowSec - latest.date > DDR_DISLOCATION_SUPPLY_MAX_AGE_SEC) return null;
  return Number.isFinite(latest.usd) && latest.usd > 0 ? latest.usd : null;
}

export function resolveDdrIncidents(context: DdrLoadedContext, nowSec: number): DdrAssessmentRow[] {
  return context.active.map((ev) => {
    const meta = TRACKED_META_BY_ID.get(ev.stablecoinId);
    const coin = meta ? toStructural(meta, context.structuralContext) : fallbackStructural(ev.stablecoinId, ev.symbol, ev.pegType);
    const supply = buildSupplyContext(
      (context.supplyByCoin.get(ev.stablecoinId) ?? []).filter((snapshot) =>
        !isAmbiguousSupplyPerimeterDay(ev.stablecoinId, snapshot.date) &&
        (isEarlierSupplyPerimeter(ev.stablecoinId, nowSec) || !isEarlierSupplyPerimeter(ev.stablecoinId, snapshot.date))),
      ev.startedAt,
      nowSec,
      context.mintBurnHourlyByCoin.get(ev.stablecoinId) ?? [],
      MINT_BURN_COVERED_COIN_IDS.has(ev.stablecoinId) ? context.mintBurnCoveredEventIds.has(ev.id) ? true : null : false,
    );
    const dews = context.dewsByCoin.get(ev.stablecoinId);
    const liq = context.liqByCoin.get(ev.stablecoinId);
    const redemption = context.redemptionByCoin.get(ev.stablecoinId);
    const dewsFresh = dews != null && nowSec - dews.computed_at <= DEWS_MAX_AGE_SEC;
    const liqFresh = liq != null && nowSec - liq.updated_at <= DEX_LIQUIDITY_MAX_AGE_SEC;
    const redemptionFresh = redemption != null && nowSec - redemption.updated_at <= REDEMPTION_BACKSTOP_MAX_AGE_SEC;
    const dewsSignals = dewsFresh ? parseDewsSignals(dews.signals_json) : null;
    const safety = context.safetyByCoin.get(ev.stablecoinId);
    const v9Exit = context.safetyContext.status === "v9-identified"
      ? context.v9ExitByCoin.get(ev.stablecoinId) ?? null
      : null;
    const live: DdrLiveContext & DdrWindDownFingerprintContext = {
      dewsBand: dewsFresh ? dews.band : null,
      dewsScore: dewsFresh ? dews.score : null,
      bankRun: dewsSignalAtLeast(dewsSignals, "supply", DDR_BANK_RUN_SUPPLY_SIGNAL_THRESHOLD),
      blacklistSurge: dewsSignalAtLeast(dewsSignals, "black", DDR_BLACKLIST_SURGE_SIGNAL_THRESHOLD),
      liquidityScore: liqFresh ? liq.liquidity_score : null,
      tvlChange7d: liqFresh ? context.liqTvlChange7dByCoin.get(ev.stablecoinId) ?? null : null,
      tvlChangeSinceOnsetPct: liqFresh ? context.liqTvlChangeSinceOnsetByEventId.get(ev.id) ?? null : null,
      circulatingUsd: latestCirculatingUsd(context.supplyByCoin.get(ev.stablecoinId) ?? [], nowSec),
      tvlChange30d: liqFresh ? context.liqTvlChange30dByCoin.get(ev.stablecoinId) ?? null : null,
      volumeChange30d: liqFresh ? context.liqVolumeChange30dByCoin.get(ev.stablecoinId) ?? null : null,
      totalVolume24hUsd: liqFresh ? liq.total_volume_24h_usd : null,
      concentrationHhi: liqFresh ? liq.concentration_hhi : null,
      safetyGrade: safety?.grade ?? null,
      safetyScore: safety?.score ?? null,
      safetyContext: context.safetyContext,
      v9Exit,
      redemptionCapacityRatio: redemptionFresh ? redemption.immediate_capacity_ratio : null,
      redemptionRouteFamily: redemptionFresh ? redemption.route_family : null,
    };
    const row: DdrAssessmentRow = resolveDepeg({ active: ev, coin, supply, live, nowSec, incidents: context.incidents, quarantined: context.quarantined });
    if (row.currentDeviationBps != null && ev.currentDeviationObservedAtSec != null) {
      row.currentDeviationObservedAtSec = ev.currentDeviationObservedAtSec;
    }
    return row;
  });
}
