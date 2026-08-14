import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchIndependentAssuranceReserves,
  type IndependentAssuranceProfile,
} from "./independent-assurance";

function formatDate(year: number, month: number, day: number): string | null {
  if (
    year < 2000 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate()
  ) {
    return null;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function europReportDate(href: string): string | null {
  const fileName = decodeURIComponent(new URL(href).pathname.split("/").pop() ?? "");
  const yearFirst = fileName.match(/((?:19|20)\d{2})[._-](\d{1,2})[._-](\d{1,2})/);
  const dayFirst = fileName.match(/(\d{1,2})[._-](\d{1,2})[._-]((?:19|20)?\d{2})/);
  const quarter = fileName.match(/Q([1-4])[_-]((?:19|20)\d{2})/i);
  if (yearFirst) {
    return formatDate(Number(yearFirst[1]), Number(yearFirst[2]), Number(yearFirst[3]));
  }
  if (dayFirst) {
    const year = dayFirst[3].length === 2 ? 2000 + Number(dayFirst[3]) : Number(dayFirst[3]);
    return formatDate(year, Number(dayFirst[2]), Number(dayFirst[1]));
  }
  if (quarter) {
    const month = Number(quarter[1]) * 3;
    const day = new Date(Date.UTC(Number(quarter[2]), month, 0)).getUTCDate();
    return formatDate(Number(quarter[2]), month, day);
  }
  return null;
}

export const EUROP_INDEPENDENT_ASSURANCE_PROFILE: IndependentAssuranceProfile = {
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
  isReportCandidate: (href) => {
    const decoded = decodeURIComponent(href);
    return /(?:SALVUS.*Attestation.*(?:EUROP|Letter)|Attestation.*(?:number|nombre).*EUROP)/i.test(decoded);
  },
  reportDateFromCandidate: europReportDate,
};

export async function fetchEuropIndependentAssuranceReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const params = parseLiveReserveAdapterParams("europ-independent-assurance", config.params) as
    LiveReserveAdapterParamsByKey["europ-independent-assurance"];
  return fetchIndependentAssuranceReserves(
    coin,
    config,
    signal,
    EUROP_INDEPENDENT_ASSURANCE_PROFILE,
    params,
    ctx,
  );
}
