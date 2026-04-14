import { getCache } from "./db-cache";
import {
  loadDexLiquiditySnapshot,
  type DexLiquidityLoadResult,
} from "./dex-liquidity";
import { loadFreshIndependentLiveReserveMap } from "./live-reserves-store";
import {
  loadRedemptionBackstopMap,
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
}

const EMPTY_DEX_LIQUIDITY_SNAPSHOT: DexLiquidityLoadResult = {
  map: {},
  latestUpdatedAt: null,
};

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
    loadRedemptionBackstopMap(db),
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
  if (dexLiquiditySnapshotResult.status === "fulfilled") {
    dexLiquiditySnapshot = dexLiquiditySnapshotResult.value;
    if (dexLiquiditySnapshot.latestUpdatedAt != null) {
      const ageSec = Math.floor(Date.now() / 1000) - dexLiquiditySnapshot.latestUpdatedAt;
      if (ageSec > 3600) {
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

  return {
    stablecoinsCached,
    bluechipCached,
    dexLiquiditySnapshot,
    redemptionBackstopMap: redemptionBackstopMapResult.value,
    liveReserveMap,
    liquidityStale,
  };
}
