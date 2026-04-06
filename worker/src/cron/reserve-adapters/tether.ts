import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonWithRetry,
  requireJsonInputFromConfig,
  unverifiedFreshnessMetadata,
} from "./helpers";

export interface TetherTransparencyResponse {
  data: {
    usdt: {
      total_assets: string | number;
      total_liabilities: string | number;
      shareholder_eq: string | number;
    };
  };
}

function toNumber(value: string | number | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number.parseFloat(value);
  return Number.NaN;
}

export function adaptTetherTransparency(payload: TetherTransparencyResponse): AdapterResult {
  const usdt = payload.data?.usdt;
  if (!usdt) throw new Error("Tether transparency response missing usdt data");

  const total_assets = toNumber(usdt.total_assets);
  const total_liabilities = toNumber(usdt.total_liabilities);
  const shareholder_eq = toNumber(usdt.shareholder_eq);

  if (!Number.isFinite(total_assets) || total_assets <= 0) {
    throw new Error("Tether total_assets invalid or zero");
  }

  return {
    slices: [
      {
        name: "Issuer-attested reserves (coarse composition undisclosed in this feed)",
        pct: 100,
        risk: "medium",
      },
    ],
    metadata: {
      ...unverifiedFreshnessMetadata(
        "issuer-transparency-api",
        "Tether transparency totals do not disclose a reserve-category mix or trustworthy source timestamp",
      ),
      totalAssetsUsd: total_assets,
      totalLiabilitiesUsd: total_liabilities,
      shareholderEquityUsd: shareholder_eq,
      ...(total_liabilities > 0 ? { collateralizationRatio: total_assets / total_liabilities } : {}),
    },
  };
}

export async function fetchTetherReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireJsonInputFromConfig(config, "tether");
  const payload = await fetchJsonWithRetry<TetherTransparencyResponse>(
      primaryInput.url,
      signal,
      12_000,
      ctx,
  );
  return adaptTetherTransparency(payload);
}
