import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchIndependentAssuranceReserves,
  type IndependentAssuranceProfile,
} from "./independent-assurance";

const PROFILE: IndependentAssuranceProfile = {
  adapterName: "audx-independent-assurance",
  product: "AUDX",
  profile: "audx-v1",
  requiredAssetCodes: ["designated-bank-accounts"],
  classifications: {
    "designated-bank-accounts": {
      name: "Australian-dollar reserves in designated bank accounts",
      risk: "very-low",
      assetClass: "bank-deposit",
      issuerOrObligor: "Undisclosed Australian financial institutions",
      riskFactors: ["counterparty", "liquidity", "custody", "concentration"],
      liquidityHorizon: "unknown",
    },
  },
  isReportCandidate: (href, text) =>
    !/whitepaper/i.test(`${href} ${text}`) && /report|attestation|audit/i.test(`${href} ${text}`),
};

export async function fetchAudxIndependentAssuranceReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const params = parseLiveReserveAdapterParams("audx-independent-assurance", config.params) as
    LiveReserveAdapterParamsByKey["audx-independent-assurance"];
  return fetchIndependentAssuranceReserves(coin, config, signal, PROFILE, params, ctx);
}
