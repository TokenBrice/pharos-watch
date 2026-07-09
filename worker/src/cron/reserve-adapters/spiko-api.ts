import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonWithRetry,
  parseTimestampLikeToUnixSeconds,
  requireJsonInput,
  verifiedFreshnessMetadata,
} from "./helpers";

export interface SpikoShareClassTotals {
  totalShares: string;
  totalAssets: { value: string; currency: string };
  numberOfHolders?: number;
  netAssetValue: {
    day?: string;
    amount: { value: string; currency: string };
    updatedAt: string;
  };
}

interface SpikoSliceConfig {
  name: ReserveSlice["name"];
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
}

function parsePositiveNumber(value: unknown, label: string, shareClassSymbol: string): number {
  const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Spiko ${shareClassSymbol} totals payload has invalid ${label}`);
  }
  return parsed;
}

/**
 * Reads Spiko's public share-class totals payload. `totalAssets.value`,
 * `totalShares`, and `netAssetValue.amount.value` all denominate in the same
 * fund currency, so the reserve ratio needs no FX conversion. USD reserve/
 * supply totals are only persisted when the fund currency is USD; EUR/GBP
 * funds leave `totalReserveUsd`/`supplyUsd` unset rather than mislabeling a
 * non-USD amount as a USD figure.
 */
export function adaptSpikoShareClassTotals(
  payload: SpikoShareClassTotals,
  shareClassSymbol: string,
  slice: SpikoSliceConfig,
): AdapterResult {
  const totalShares = parsePositiveNumber(payload.totalShares, "totalShares", shareClassSymbol);
  const totalAssetsValue = parsePositiveNumber(payload.totalAssets?.value, "totalAssets.value", shareClassSymbol);
  const navAmount = parsePositiveNumber(
    payload.netAssetValue?.amount?.value,
    "netAssetValue.amount.value",
    shareClassSymbol,
  );

  const sourceTimestamp = parseTimestampLikeToUnixSeconds(payload.netAssetValue?.updatedAt);
  if (sourceTimestamp == null) {
    throw new Error(`Spiko ${shareClassSymbol} totals payload has an unreadable netAssetValue.updatedAt`);
  }

  const collateralizationRatio = totalAssetsValue / (totalShares * navAmount);
  const fundCurrency = payload.totalAssets?.currency;
  const isUsdFund = fundCurrency === "USD" && payload.netAssetValue?.amount?.currency === "USD";

  return {
    slices: [{
      name: slice.name,
      pct: 100,
      risk: slice.risk,
      ...(slice.coinId ? { coinId: slice.coinId } : {}),
      ...(slice.depType ? { depType: slice.depType } : {}),
    }],
    metadata: {
      ...verifiedFreshnessMetadata(sourceTimestamp),
      collateralizationRatio,
      ...(isUsdFund
        ? { totalReserveUsd: totalAssetsValue, supplyUsd: totalShares * navAmount }
        : {}),
      details: {
        shareClassSymbol,
        fundCurrency,
        ...(payload.netAssetValue?.day ? { navDay: payload.netAssetValue.day } : {}),
      },
    },
  };
}

export async function fetchSpikoApiReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, "spiko-api");
  const params = parseLiveReserveAdapterParams("spiko-api", config.params);
  const payload = await fetchJsonWithRetry<SpikoShareClassTotals>(input.url, signal, 12_000, ctx);
  return adaptSpikoShareClassTotals(payload, params.shareClassSymbol, params.slice);
}
