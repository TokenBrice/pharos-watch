import type { LiveReservesConfig, StablecoinMeta } from "@shared/types";
import type { AdapterContext, AdapterResult } from "./index";
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

export function adaptFraxCombinedData(payload: FraxCombinedDataResponse): AdapterResult {
  const collateral = payload.protocol?.collateral;
  if (!collateral || !Number.isFinite(collateral.total_dollar_value)) {
    throw new Error("Frax combineddata response missing collateral data");
  }

  return {
    slices: [
      {
        name: "Tokenized T-bills and cash equivalents (BUIDL, USTB, USCC, USDC)",
        pct: 100,
        risk: "low",
      },
    ],
    metadata: {
      collateralRatio: collateral.ratio,
      decentralizationRatio: collateral.decentralization_ratio,
      totalCollateralUsd: collateral.total_dollar_value,
    },
  };
}

export async function fetchFraxReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  _ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireJsonInputFromConfig(config, "frax");
  const payload = await fetchJsonWithRetry<FraxCombinedDataResponse>(
    primaryInput.url,
    signal,
    getAdapterTimeout(config, 12_000),
  );
  return adaptFraxCombinedData(payload);
}
