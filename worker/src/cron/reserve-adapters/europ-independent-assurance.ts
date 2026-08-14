import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchIndependentAssuranceReserves,
  type IndependentAssuranceProfile,
} from "./independent-assurance";

const PROFILE: IndependentAssuranceProfile = {
  adapterName: "europ-independent-assurance",
  product: "EUROP",
  profile: "europ-v1",
  requiredAssetCodes: ["cash", "cash-equivalents"],
  classifications: {
    cash: {
      name: "Euro cash held at regulated financial institutions",
      risk: "very-low",
      assetClass: "bank-deposit",
      issuerOrObligor: "Societe Generale S.A. and Banking Circle S.A.",
      riskFactors: ["counterparty", "liquidity", "custody", "legal", "concentration"],
      liquidityHorizon: "immediate",
    },
    "cash-equivalents": {
      name: "Euro cash equivalents held at regulated financial institutions (instruments undisclosed)",
      risk: "low",
      assetClass: "other",
      issuerOrObligor: "Societe Generale S.A. and Banking Circle S.A.; underlying instruments undisclosed",
      riskFactors: ["credit", "duration", "liquidity", "custody", "counterparty", "concentration"],
      liquidityHorizon: "unknown",
    },
  },
  reconciliation: {
    reportedAssetTotalTolerance: {
      absolute: "1",
      relativePpm: 1,
    },
    reportedLiabilityTotalTolerance: {
      absolute: "1",
      relativePpm: 1,
    },
  },
  isReportCandidate: (href, text) =>
    !/whitepaper/i.test(`${href} ${text}`) && /europ|reserve|attestation|audit/i.test(`${href} ${text}`),
};

export async function fetchEuropIndependentAssuranceReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const params = parseLiveReserveAdapterParams("europ-independent-assurance", config.params) as
    LiveReserveAdapterParamsByKey["europ-independent-assurance"];
  return fetchIndependentAssuranceReserves(coin, config, signal, PROFILE, params, ctx);
}
