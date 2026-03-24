import type { LiveReservesConfig, ReserveRisk, StablecoinMeta } from "@shared/types";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonWithRetry,
  getAdapterTimeout,
  requireJsonInputFromConfig,
  slicesFromValues,
} from "./helpers";

interface UsddCollateralItem {
  lockedValue?: number;
  vaultType?: string;
}

interface UsddLatestCollateralResponse {
  code?: number;
  data?: {
    items?: UsddCollateralItem[];
  };
}

interface UsddHistoryResponse {
  code?: number;
  data?: {
    items?: Array<{
      statisticTime?: number;
    }>;
  };
}

const USDD_HISTORY_URL = "https://app-api.usdd.io/data-platform/collateral-history?interval=WEEKLY&chain=tron";

type BucketValue = {
  name: string;
  value: number;
  risk: ReserveRisk;
  coinId?: string;
};

function assertSuccess<T extends { code?: number }>(payload: T, label: string): T {
  if (payload.code !== 0) {
    throw new Error(`${label} returned code ${String(payload.code)}`);
  }
  return payload;
}

export function adaptUsddLatestCollateral(
  latest: UsddLatestCollateralResponse,
  history?: UsddHistoryResponse,
): AdapterResult {
  const items = assertSuccess(latest, "usdd latest collateral").data?.items ?? [];

  const bucketValues = {
    smartAllocatorUsd: 0,
    psmUsdtUsd: 0,
    trxUsd: 0,
    directUsdtUsd: 0,
    stakedTrxUsd: 0,
  };

  for (const item of items) {
    const lockedValue = Number(item.lockedValue ?? 0);
    if (!Number.isFinite(lockedValue) || lockedValue <= 0) continue;
    switch (item.vaultType) {
      case "SA001-A":
        bucketValues.smartAllocatorUsd += lockedValue;
        break;
      case "PSM-USDT-A":
        bucketValues.psmUsdtUsd += lockedValue;
        break;
      case "TRX-A":
      case "TRX-B":
      case "TRX-C":
        bucketValues.trxUsd += lockedValue;
        break;
      case "USDT-A":
        bucketValues.directUsdtUsd += lockedValue;
        break;
      case "STRX-A":
        bucketValues.stakedTrxUsd += lockedValue;
        break;
      default:
        break;
    }
  }

  const historyItems = history && assertSuccess(history, "usdd collateral history").data?.items
    ? history.data?.items ?? []
    : [];
  const latestHistoryPoint = historyItems.length > 0 ? historyItems[historyItems.length - 1] : undefined;
  const statisticTimeMs = latestHistoryPoint?.statisticTime;

  const bucketSlices: BucketValue[] = [
      {
        name: "Smart Allocator (stablecoin DeFi via Aave/JustLend)",
        value: bucketValues.smartAllocatorUsd,
        risk: "medium",
      },
      {
        name: "USDT (PSM vaults)",
        value: bucketValues.psmUsdtUsd,
        risk: "low",
        coinId: "usdt-tether",
      },
      {
        name: "TRX",
        value: bucketValues.trxUsd,
        risk: "high",
      },
      {
        name: "USDT (direct vaults)",
        value: bucketValues.directUsdtUsd,
        risk: "high",
        coinId: "usdt-tether",
      },
      {
        name: "sTRX (direct vaults)",
        value: bucketValues.stakedTrxUsd,
        risk: "high",
      },
    ];

  return {
    slices: slicesFromValues(bucketSlices.sort((left, right) => right.value - left.value)),
    metadata: {
      vaultCount: items.length,
      trackedVaultCount: 5,
      ...(typeof statisticTimeMs === "number" && Number.isFinite(statisticTimeMs)
        ? {
            sourceTimestamp: Math.floor(statisticTimeMs / 1000),
            freshnessMode: "verified" as const,
          }
        : {
            freshnessMode: "unverified" as const,
          }),
    },
  };
}

export async function fetchUsddDataPlatformReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInputFromConfig(config, "usdd-data-platform");
  const timeout = getAdapterTimeout(config, 12_000);
  const [latest, history] = await Promise.all([
    fetchJsonWithRetry<UsddLatestCollateralResponse>(input.url, signal, timeout, ctx),
    fetchJsonWithRetry<UsddHistoryResponse>(USDD_HISTORY_URL, signal, timeout, ctx),
  ]);
  return adaptUsddLatestCollateral(latest, history);
}
