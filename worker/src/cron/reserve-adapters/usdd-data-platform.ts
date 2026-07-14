import type { ReserveRisk, ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildUnknownExposureWarning,
  computeUnknownExposurePct,
  fetchJsonWithRetry,
  parseTimestampLikeToUnixSeconds,
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

const USDD_HISTORY_INTERVAL = "WEEKLY";
const USDD_UNKNOWN_VAULT_SLICE_NAME = "Unknown / unmapped collateral vaults";

type BucketValue = {
  name: string;
  value: number;
  risk: ReserveRisk;
  coinId?: string;
  depType?: ReserveSlice["depType"];
};

function assertSuccess<T extends { code?: number }>(payload: T, label: string): T {
  if (payload.code !== 0) {
    throw new Error(`${label} returned code ${String(payload.code)}`);
  }
  return payload;
}

export function buildUsddHistoryUrl(latestUrl: string): string {
  const latest = new URL(latestUrl);
  const history = new URL(latest.toString());
  history.pathname = latest.pathname.endsWith("/latest-collateral")
    ? latest.pathname.replace(/\/latest-collateral$/, "/collateral-history")
    : "/data-platform/collateral-history";
  history.search = "";
  history.searchParams.set("interval", USDD_HISTORY_INTERVAL);
  const chain = latest.searchParams.get("chain");
  if (chain) {
    history.searchParams.set("chain", chain);
  }
  return history.toString();
}

function createUnknownVaultWarning(
  unknownVaultTypes: Iterable<string>,
  unknownExposurePct: number,
): LiveReserveWarning {
  return buildUnknownExposureWarning({
    code: "unknown-vault-type",
    message: `USDD collateral feed includes unmapped vault types: ${Array.from(unknownVaultTypes).sort().join(", ")}`,
    unknownExposurePct,
  });
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
  const unknownVaultTypes = new Set<string>();
  let unknownVaultCount = 0;
  let unknownVaultUsd = 0;
  let totalVaultUsd = 0;

  for (const item of items) {
    const lockedValue = Number(item.lockedValue ?? 0);
    if (!Number.isFinite(lockedValue) || lockedValue <= 0) continue;
    totalVaultUsd += lockedValue;
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
        unknownVaultCount += 1;
        unknownVaultUsd += lockedValue;
        unknownVaultTypes.add(
          typeof item.vaultType === "string" && item.vaultType.trim().length > 0
            ? item.vaultType.trim()
            : "unknown",
        );
        break;
    }
  }

  const historyItems = history ? (assertSuccess(history, "usdd collateral history").data?.items ?? []) : [];
  // statisticTime may be a millisecond epoch; parseTimestampLikeToUnixSeconds auto-detects the unit.
  const statisticTimeRaw = historyItems.reduce<number | null>((latestPoint, item) => {
    if (typeof item.statisticTime !== "number" || !Number.isFinite(item.statisticTime)) {
      return latestPoint;
    }
    return latestPoint == null || item.statisticTime > latestPoint
      ? item.statisticTime
      : latestPoint;
  }, null);

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
      depType: "collateral",
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
    ...(unknownVaultUsd > 0
      ? [{
          name: USDD_UNKNOWN_VAULT_SLICE_NAME,
          value: unknownVaultUsd,
          risk: "high" as const,
        }]
      : []),
  ];
  const unknownExposurePct = computeUnknownExposurePct(unknownVaultUsd, totalVaultUsd);
  const warnings: LiveReserveWarning[] = unknownVaultTypes.size > 0
    ? [createUnknownVaultWarning(unknownVaultTypes, unknownExposurePct)]
    : [];
  const stableRedeemableUsd = bucketValues.psmUsdtUsd + bucketValues.directUsdtUsd;
  const sourceTimestamp = parseTimestampLikeToUnixSeconds(statisticTimeRaw);

  return {
    slices: slicesFromValues(bucketSlices.sort((left, right) => right.value - left.value)),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      vaultCount: items.length,
      trackedVaultCount: 5,
      ...(unknownVaultCount > 0 ? { unknownVaultCount } : {}),
      ...(unknownVaultTypes.size > 0 ? { unknownVaultTypes: Array.from(unknownVaultTypes).sort() } : {}),
      ...(unknownExposurePct > 0 ? { unknownExposurePct } : {}),
      ...(sourceTimestamp != null
        ? {
            sourceTimestamp,
            freshnessMode: "verified" as const,
          }
        : {
            freshnessMode: "unverified" as const,
            details: {
              freshnessSource: "collateral-history",
              freshnessReason: "history timestamp unavailable",
            },
          }),
      stableVaultUsd: stableRedeemableUsd,
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
  const timeout = 12_000;
  const historyUrl = buildUsddHistoryUrl(input.url);
  const [latest, history] = await Promise.all([
    fetchJsonWithRetry<UsddLatestCollateralResponse>(input.url, signal, timeout, ctx),
    fetchJsonWithRetry<UsddHistoryResponse>(historyUrl, signal, timeout, ctx),
  ]);
  return adaptUsddLatestCollateral(latest, history);
}
