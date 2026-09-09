import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildCoverageShortfallWarnings,
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
 * non-USD amount as a USD figure. A payload whose asset and NAV currencies
 * differ (or are missing) is rejected, and an under-collateralized ratio
 * publishes as a `reserve-undercollateralized` degraded warning.
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

  // Assets and NAV must denominate in the same fund currency; a EUR assets /
  // USD NAV payload previously produced a meaningless ratio (0.5) with no
  // warning. A missing or mismatched currency cannot be cross-checked, so it
  // fails closed rather than publishing a NAV-accounting identity as solvency.
  const fundCurrency = payload.totalAssets?.currency;
  const navCurrency = payload.netAssetValue?.amount?.currency;
  if (typeof fundCurrency !== "string" || typeof navCurrency !== "string" || fundCurrency !== navCurrency) {
    throw new Error(
      `Spiko ${shareClassSymbol} totals payload has mismatched or missing fund/NAV currency (assets ${fundCurrency ?? "missing"} vs NAV ${navCurrency ?? "missing"})`,
    );
  }

  const supplyProduct = totalShares * navAmount;
  if (!Number.isFinite(supplyProduct)) {
    throw new Error(`Spiko ${shareClassSymbol} totals payload has a non-finite shares × NAV product`);
  }
  const collateralizationRatio = totalAssetsValue / supplyProduct;
  if (!Number.isFinite(collateralizationRatio)) {
    throw new Error(`Spiko ${shareClassSymbol} totals payload has a non-finite collateralization ratio`);
  }

  const isUsdFund = fundCurrency === "USD";
  const warnings = buildCoverageShortfallWarnings({
    code: "reserve-undercollateralized",
    message: (pct) => `Spiko ${shareClassSymbol} fund assets cover ${pct}% of issued share value`,
    coverageRatio: collateralizationRatio,
  });

  return {
    slices: [{
      sourceKey: `spiko-api:${shareClassSymbol.toLowerCase()}:total-assets`,
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
        ? { totalReserveUsd: totalAssetsValue, supplyUsd: supplyProduct }
        : {}),
      details: {
        shareClassSymbol,
        fundCurrency,
        ...(payload.netAssetValue?.day ? { navDay: payload.netAssetValue.day } : {}),
      },
    },
    ...(warnings.length > 0 ? { warnings } : {}),
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
