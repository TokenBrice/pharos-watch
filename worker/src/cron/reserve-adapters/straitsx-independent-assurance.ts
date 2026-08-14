import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchIndependentAssuranceReserves,
  type IndependentAssuranceProfile,
} from "./independent-assurance";

const STRAITSX_PROFILE_BASE: Omit<IndependentAssuranceProfile, "product" | "requiredAssetCodes"> = {
  adapterName: "straitsx-independent-assurance",
  profile: "straitsx-v1",
  classifications: {
    cash: {
      name: "Cash deposits in the safeguarded reserve account",
      risk: "very-low",
      assetClass: "cash",
      issuerOrObligor: "Undisclosed MAS-permitted safeguarding institution",
      riskFactors: ["counterparty", "custody", "concentration"],
      liquidityHorizon: "immediate",
    },
    "short-dated-government-or-repo": {
      name: "Short-dated sovereign instruments or eligible overnight reverse repos",
      risk: "very-low",
      assetClass: "other",
      issuerOrObligor: "Relevant government or eligible highly rated overnight reverse-repo counterparty",
      riskFactors: ["counterparty", "duration", "liquidity", "custody"],
      liquidityHorizon: "unknown",
    },
    "fixed-deposits": {
      name: "Fixed deposits",
      risk: "very-low",
      assetClass: "bank-deposit",
      issuerOrObligor: "Undisclosed safeguarding institution",
      riskFactors: ["counterparty", "custody", "liquidity"],
      liquidityHorizon: "unknown",
    },
  },
  isReportCandidate: (href, text) =>
    !/whitepaper/i.test(`${href} ${text}`) && /xsgd|xusd/i.test(`${href} ${text}`) && /report|attestation|reserve/i.test(`${href} ${text}`),
};

function profileForProduct(product: "XSGD" | "XUSD"): IndependentAssuranceProfile {
  return {
    ...STRAITSX_PROFILE_BASE,
    product,
    requiredAssetCodes: product === "XSGD" ? ["cash", "short-dated-government-or-repo"] : ["cash"],
  };
}

export async function fetchStraitsxIndependentAssuranceReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const params = parseLiveReserveAdapterParams("straitsx-independent-assurance", config.params) as
    LiveReserveAdapterParamsByKey["straitsx-independent-assurance"];
  return fetchIndependentAssuranceReserves(coin, config, signal, profileForProduct(params.product), params, ctx);
}
