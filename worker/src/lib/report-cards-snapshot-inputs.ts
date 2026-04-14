import { getCache } from "./db-cache";
import {
  loadDexLiquiditySnapshot,
  type DexLiquidityLoadResult,
} from "./dex-liquidity";
import { loadFreshIndependentLiveReserveMap } from "./live-reserves-store";
import {
  loadRedemptionBackstopSnapshot,
  RedemptionBackstopSnapshotUnavailableError,
} from "./redemption-backstops-store";
import { loadStablecoinsCache, type StablecoinsCacheLoadOk } from "./stablecoins-cache";
import type { ReserveSlice } from "@shared/types/core";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";

export class ReportCardsSnapshotUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportCardsSnapshotUnavailableError";
  }
}

export interface ReportCardsSnapshotInputs {
  stablecoinsCached: StablecoinsCacheLoadOk;
  bluechipCached: Awaited<ReturnType<typeof getCache>> | null;
  dexLiquiditySnapshot: DexLiquidityLoadResult;
  redemptionBackstopMap: Record<string, RedemptionBackstopEntry>;
  liveReserveMap: Map<string, ReserveSlice[]>;
  liquidityStale: boolean;
  redemptionStale: boolean;
  inputFreshness: ReportCardsInputFreshness;
}

const EMPTY_DEX_LIQUIDITY_SNAPSHOT: DexLiquidityLoadResult = {
  map: {},
  latestUpdatedAt: null,
};

const REPORT_CARD_DEX_LIQUIDITY_FRESHNESS_SEC = 3600;
const REPORT_CARD_REDEMPTION_FRESHNESS_SEC = 3600;

export interface ReportCardsInputFreshnessEntry {
  updatedAt: number | null;
  ageSeconds: number | null;
  stale: boolean;
}

export interface ReportCardsInputFreshness {
  dexLiquidity: ReportCardsInputFreshnessEntry;
  redemptionBackstops: ReportCardsInputFreshnessEntry;
}

function buildFreshnessEntry(
  updatedAt: number | null,
  nowSec: number,
  maxAgeSec: number,
  forceStale = false,
): ReportCardsInputFreshnessEntry {
  const ageSeconds = updatedAt == null ? null : Math.max(0, nowSec - updatedAt);
  return {
    updatedAt,
    ageSeconds,
    stale: forceStale || ageSeconds == null || ageSeconds > maxAgeSec,
  };
}

export async function loadReportCardsSnapshotInputs(db: D1Database): Promise<ReportCardsSnapshotInputs> {
  const [
    stablecoinsCachedResult,
    bluechipCachedResult,
    dexLiquiditySnapshotResult,
    redemptionBackstopMapResult,
    liveReserveMapResult,
  ] = await Promise.allSettled([
    loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: false }),
    getCache(db, "bluechip-ratings"),
    loadDexLiquiditySnapshot(db),
    loadRedemptionBackstopSnapshot(db),
    loadFreshIndependentLiveReserveMap(db),
  ]);

  if (stablecoinsCachedResult.status === "rejected") {
    throw stablecoinsCachedResult.reason;
  }
  const stablecoinsCached = stablecoinsCachedResult.value;
  if (stablecoinsCached.kind !== "ok") {
    throw new ReportCardsSnapshotUnavailableError("Cached stablecoins data is corrupt");
  }

  if (redemptionBackstopMapResult.status === "rejected") {
    if (redemptionBackstopMapResult.reason instanceof RedemptionBackstopSnapshotUnavailableError) {
      throw new ReportCardsSnapshotUnavailableError(
        "Redemption backstop snapshot unavailable",
      );
    }
    throw redemptionBackstopMapResult.reason;
  }

  const bluechipCached = bluechipCachedResult.status === "fulfilled"
    ? bluechipCachedResult.value
    : (() => {
        console.warn("[report-cards] Bluechip ratings unavailable; continuing without bluechip overlay:", bluechipCachedResult.reason);
        return null;
      })();

  let dexLiquiditySnapshot = EMPTY_DEX_LIQUIDITY_SNAPSHOT;
  let liquidityStale = false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (dexLiquiditySnapshotResult.status === "fulfilled") {
    dexLiquiditySnapshot = dexLiquiditySnapshotResult.value;
    if (dexLiquiditySnapshot.latestUpdatedAt != null) {
      const ageSec = nowSec - dexLiquiditySnapshot.latestUpdatedAt;
      if (ageSec > REPORT_CARD_DEX_LIQUIDITY_FRESHNESS_SEC) {
        console.warn(`[report-cards] Liquidity data is stale (age: ${ageSec}s)`);
        liquidityStale = true;
      }
    }
  } else {
    console.warn("[report-cards] DEX liquidity snapshot unavailable; suppressing liquidity inputs:", dexLiquiditySnapshotResult.reason);
    liquidityStale = true;
  }

  const liveReserveMap = liveReserveMapResult.status === "fulfilled"
    ? liveReserveMapResult.value
    : (() => {
        console.warn("[report-cards] Live reserve snapshot unavailable; falling back to curated reserves:", liveReserveMapResult.reason);
        return new Map<string, ReserveSlice[]>();
      })();

  const redemptionFreshness = buildFreshnessEntry(
    redemptionBackstopMapResult.value.latestUpdatedAt,
    nowSec,
    REPORT_CARD_REDEMPTION_FRESHNESS_SEC,
  );
  const redemptionStale = redemptionFreshness.stale;
  const redemptionBackstopMap = redemptionStale ? {} : redemptionBackstopMapResult.value.map;
  if (redemptionStale) {
    console.warn(
      `[report-cards] Redemption backstop data is stale or missing` +
      (redemptionFreshness.ageSeconds != null ? ` (age: ${redemptionFreshness.ageSeconds}s)` : ""),
    );
  }

  return {
    stablecoinsCached,
    bluechipCached,
    dexLiquiditySnapshot,
    redemptionBackstopMap,
    liveReserveMap,
    liquidityStale,
    redemptionStale,
    inputFreshness: {
      dexLiquidity: buildFreshnessEntry(
        dexLiquiditySnapshot.latestUpdatedAt,
        nowSec,
        REPORT_CARD_DEX_LIQUIDITY_FRESHNESS_SEC,
        dexLiquiditySnapshotResult.status === "rejected",
      ),
      redemptionBackstops: redemptionFreshness,
    },
  };
}
