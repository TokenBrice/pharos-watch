import {
  resolveDepeg,
  type DdrLiveContext,
  type DdrSupplyContext,
  type DdrWindDownFingerprintContext,
} from "@shared/lib/depeg-resolver";
import { unwrapStressSignalsEnvelope } from "@shared/lib/stress-signals-envelope";
import { isRecord } from "@shared/lib/type-guards";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { DdrRow } from "@shared/types/depeg-resolver";
import { MINT_BURN_CONFIGS } from "../../lib/mint-burn-contracts";
import {
  DEWS_MAX_AGE_SEC,
  DEX_LIQUIDITY_MAX_AGE_SEC,
  DAY,
  REDEMPTION_BACKSTOP_MAX_AGE_SEC,
} from "./constants";
import type { DdrLoadedContext } from "./context";
import { fallbackStructural, toStructural } from "./utils";

const DDR_BANK_RUN_SUPPLY_SIGNAL_THRESHOLD = 65;
const DDR_BLACKLIST_SURGE_SIGNAL_THRESHOLD = 55;
const MINT_SURGE_NET_INFLOW_PCT = 20;
const MINT_SURGE_WINDOW_SEC = 7 * DAY;
const MINT_BURN_COVERED_COIN_IDS = new Set(MINT_BURN_CONFIGS.map((config) => config.stablecoinId));

type MintBurnHourlyRow = { hourTs: number; netFlowUsd: number };

function supplyAt(snapshots: { date: number; usd: number }[], ts: number): number | null {
  let val: number | null = null;
  for (const s of snapshots) {
    if (s.date <= ts) val = s.usd;
    else break;
  }
  return val;
}

export function deriveMintSurge(
  snapshots: { date: number; usd: number }[],
  startedAt: number,
  change7dPct: number | null,
  hourlyRows: MintBurnHourlyRow[],
  hasMintBurnCoverage: boolean,
): Pick<DdrSupplyContext, "mintSurge" | "mintSurgeCoverage"> {
  if (hasMintBurnCoverage) {
    const onset = supplyAt(snapshots, startedAt) ?? snapshots[snapshots.length - 1]?.usd ?? null;
    if (onset == null || !Number.isFinite(onset) || onset <= 0) {
      return { mintSurge: null, mintSurgeCoverage: "unavailable" };
    }
    const netInflowUsd = hourlyRows
      .filter((row) => row.hourTs >= startedAt - MINT_SURGE_WINDOW_SEC && row.hourTs <= startedAt)
      .reduce((sum, row) => sum + (Number.isFinite(row.netFlowUsd) ? row.netFlowUsd : 0), 0);
    return {
      mintSurge: (netInflowUsd / onset) * 100 > MINT_SURGE_NET_INFLOW_PCT,
      mintSurgeCoverage: "mint-burn-hourly",
    };
  }

  if (change7dPct == null || !Number.isFinite(change7dPct)) {
    return { mintSurge: null, mintSurgeCoverage: "unavailable" };
  }
  return {
    mintSurge: change7dPct > MINT_SURGE_NET_INFLOW_PCT,
    mintSurgeCoverage: "supply-history-proxy",
  };
}

function buildSupplyContext(
  snapshots: { date: number; usd: number }[],
  startedAt: number,
  evaluatedAt: number,
  mintBurnHourly: MintBurnHourlyRow[],
  hasMintBurnCoverage: boolean,
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
  const onset = supplyAt(snapshots, startedAt) ?? snapshots[snapshots.length - 1].usd;
  const current = supplyAt(snapshots, evaluatedAt) ?? snapshots[snapshots.length - 1].usd;
  const d7 = supplyAt(snapshots, startedAt - 7 * DAY);
  const d30 = supplyAt(snapshots, evaluatedAt - 30 * DAY);
  const change7dPct = d7 != null && d7 > 0 ? ((onset - d7) / d7) * 100 : null;
  const change30dPct = d30 != null && d30 > 0 ? ((current - d30) / d30) * 100 : null;
  return {
    covered: true,
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

export function resolveDdrIncidents(context: DdrLoadedContext, nowSec: number): DdrRow[] {
  return context.active.map((ev) => {
    const meta = TRACKED_META_BY_ID.get(ev.stablecoinId);
    const coin = meta ? toStructural(meta) : fallbackStructural(ev.stablecoinId, ev.symbol, ev.pegType);
    const supply = buildSupplyContext(
      context.supplyByCoin.get(ev.stablecoinId) ?? [],
      ev.startedAt,
      nowSec,
      context.mintBurnHourlyByCoin.get(ev.stablecoinId) ?? [],
      MINT_BURN_COVERED_COIN_IDS.has(ev.stablecoinId),
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
    return resolveDepeg({ active: ev, coin, supply, live, nowSec, incidents: context.incidents, quarantined: context.quarantined });
  });
}
