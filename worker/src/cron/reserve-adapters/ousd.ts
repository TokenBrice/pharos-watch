import type { LiveReservesConfig, ReserveSlice, StablecoinMeta } from "@shared/types";
import type { AdapterContext, AdapterResult } from "./index";
import { fetchJsonWithRetry, getAdapterTimeout, requireJsonInputFromConfig, slicesFromValues } from "./helpers";

export interface OusdCollateralResponse {
  collateral: Record<string, { total: number; price: number }>;
}

const SYMBOL_TO_COIN_ID: Record<string, string> = {
  USDC: "usdc-circle",
  USDT: "usdt-tether",
  DAI: "dai-makerdao",
};

const SYMBOL_TO_RISK: Record<string, ReserveSlice["risk"]> = {
  USDC: "low",
  USDT: "low",
  DAI: "low",
};

export function adaptOusdCollateral(payload: OusdCollateralResponse): AdapterResult {
  const entries = Object.entries(payload.collateral)
    .map(([symbol, data]) => ({
      name: symbol,
      value: data.total * data.price,
      risk: (SYMBOL_TO_RISK[symbol] ?? "medium") as ReserveSlice["risk"],
      ...(SYMBOL_TO_COIN_ID[symbol] ? { coinId: SYMBOL_TO_COIN_ID[symbol] } : {}),
      depType: "wrapper" as const,
    }))
    .filter((e) => e.value > 0);

  if (entries.length === 0) return { slices: [] };

  const slices = slicesFromValues(entries);
  return {
    slices,
    metadata: {
      assetCount: entries.length,
    },
  };
}

export async function fetchOusdReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  _ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireJsonInputFromConfig(config, "ousd");
  const payload = await fetchJsonWithRetry<OusdCollateralResponse>(
    primaryInput.url,
    signal,
    getAdapterTimeout(config, 12_000),
  );
  return adaptOusdCollateral(payload);
}
