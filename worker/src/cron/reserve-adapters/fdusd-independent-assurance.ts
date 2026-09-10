import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import {
  fetchIndependentAssuranceReserves,
  type IndependentAssuranceProfile,
} from "./independent-assurance";
import { formatValidIsoDate, lastDayOfMonth, monthNumberFromLabel } from "./report-date";
import type { AdapterContext, AdapterResult } from "./types";

const ADAPTER_KEY = "fdusd-independent-assurance";

// The official firstdigitallabs.com index 403s Cloudflare Worker egress on every
// strategy (IA7); the issuer's Webflow mirror is the pinned working source and
// carries the same dated ISAE 3000 report series.
export const FDUSD_INDEPENDENT_ASSURANCE_PROFILE: IndependentAssuranceProfile = {
  adapterName: ADAPTER_KEY,
  product: "FDUSD",
  profile: "fdusd-v1",
  requiredAssetCodes: ["treasury-bills", "fixed-deposits", "custody-cash"],
  classifications: {
    "treasury-bills": {
      name: "U.S. Treasury Bills (maturities 11-Aug-26 through 22-Sep-26)",
      risk: "very-low",
      assetClass: "treasury-bill",
      issuerOrObligor: "United States Government",
      riskFactors: ["credit", "duration", "liquidity", "custody"],
      liquidityHorizon: "one-day",
    },
    "fixed-deposits": {
      name: "U.S. government guaranteed fixed deposits held pursuant to reserve repurchase agreements",
      risk: "very-low",
      assetClass: "repo",
      issuerOrObligor: "U.S. Government guaranteed institutions",
      riskFactors: ["credit", "counterparty", "custody"],
      liquidityHorizon: "one-day",
    },
    "custody-cash": {
      name: "US$ held in custody accounts",
      risk: "very-low",
      assetClass: "cash",
      issuerOrObligor: "First Digital Trust Limited (custodian) and underlying financial institutions",
      riskFactors: ["counterparty", "custody", "concentration"],
      liquidityHorizon: "immediate",
    },
  },
  isReportCandidate: (href) =>
    !/whitepaper/i.test(href) && /ISAE[-_ ]?3000/i.test(decodeURIComponent(href)),
  reportDateFromCandidate: fdusdReportDate,
};

function fdusdReportDate(href: string, text: string): string | null {
  const decoded = decodeURIComponent(`${href} ${text}`);
  const match = decoded.match(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+((?:19|20)\d{2})\b/i,
  );
  if (!match) return null;
  const month = monthNumberFromLabel(match[1].slice(0, 3));
  const year = Number(match[2]);
  if (!month) return null;
  return formatValidIsoDate(year, month, lastDayOfMonth(year, month)!, 2000);
}

export async function fetchFdusdIndependentAssuranceReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const params = parseLiveReserveAdapterParams(ADAPTER_KEY, config.params) as
    LiveReserveAdapterParamsByKey["fdusd-independent-assurance"];
  return fetchIndependentAssuranceReserves(coin, config, signal, FDUSD_INDEPENDENT_ASSURANCE_PROFILE, params, ctx);
}
