import type { LiveReservesConfig, StablecoinMeta } from "@shared/types";
import type { AdapterContext, AdapterResult } from "./index";
import { fetchJsonWithRetry, getAdapterTimeout, requireJsonInputFromConfig } from "./helpers";

export interface TetherTransparencyResponse {
  data: {
    usdt: {
      total_assets: number;
      total_liabilities: number;
      shareholder_eq: number;
    };
  };
}

export function adaptTetherTransparency(payload: TetherTransparencyResponse): AdapterResult {
  const usdt = payload.data?.usdt;
  if (!usdt) throw new Error("Tether transparency response missing usdt data");

  const { total_assets, total_liabilities } = usdt;
  if (!Number.isFinite(total_assets) || total_assets <= 0) {
    throw new Error("Tether total_assets invalid or zero");
  }

  return {
    slices: [
      {
        name: "U.S. Treasury Bills, repos, cash, and other reserves",
        pct: 100,
        risk: "very-low",
      },
    ],
    metadata: {
      totalAssetsUsd: total_assets,
      totalLiabilitiesUsd: total_liabilities,
      shareholderEquityUsd: usdt.shareholder_eq,
      collateralizationRatio:
        total_liabilities > 0 ? total_assets / total_liabilities : null,
    },
  };
}

export async function fetchTetherReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  _ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireJsonInputFromConfig(config, "tether");
  const payload = await fetchJsonWithRetry<TetherTransparencyResponse>(
    primaryInput.url,
    signal,
    getAdapterTimeout(config, 12_000),
  );
  return adaptTetherTransparency(payload);
}
