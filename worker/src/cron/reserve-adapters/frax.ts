import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import { fetchJsonWithRetry, getAdapterTimeout, requireJsonInputFromConfig } from "./helpers";

export interface FraxCombinedDataResponse {
  protocol?: {
    collateral?: {
      ratio: number;
      decentralization_ratio: number;
      total_dollar_value: number;
    };
  };
}

const FALLBACK_SLICE = [
  { name: "Tokenized T-bills and cash equivalents (BUIDL, USTB, USCC, USDC)", pct: 100, risk: "low" as const },
];

export function adaptFraxCombinedData(payload: FraxCombinedDataResponse, coin?: StablecoinMeta): AdapterResult {
  const collateral = payload.protocol?.collateral;
  if (!collateral || !Number.isFinite(collateral.total_dollar_value)) {
    throw new Error("Frax combineddata response missing collateral data");
  }

  return {
    slices: coin?.reserves?.length ? coin.reserves : FALLBACK_SLICE,
    metadata: {
      freshnessMode: "unverified",
      collateralRatio: collateral.ratio,
      decentralizationRatio: collateral.decentralization_ratio,
      totalCollateralUsd: collateral.total_dollar_value,
    },
  };
}

export async function fetchFraxReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireJsonInputFromConfig(config, "frax");
  const payload = await fetchJsonWithRetry<FraxCombinedDataResponse>(
      primaryInput.url,
      signal,
      getAdapterTimeout(config, 12_000),
      ctx,
  );
  return adaptFraxCombinedData(payload, coin);
}
