import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import { fetchIndependentAssuranceReserves, type IndependentAssuranceProfile } from "./independent-assurance";
import { decodeHtmlEntities } from "./helpers";
import { formatValidIsoDate, lastDayOfMonth, monthNumberFromLabel } from "./report-date";
import type { AdapterContext, AdapterResult } from "./types";

// Ripple's archive uses month-only anchor labels. The report filename carries
// the year, with both full years and abbreviated forms such as June'26.
function rlusdReportDate(href: string): string | null {
  const filename = (decodeHtmlEntities(decodeURIComponent(href)).split("/").pop() ?? "").replace(/_/g, " ");
  const match = filename.match(/\b(January|February|March|April|May|June|July|August|September|Sept|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[ '’-]+(20\d{2}|\d{2})(?!\d)/i);
  if (!match) return null;
  const month = monthNumberFromLabel(match[1]);
  const year = Number(match[2]) + (match[2].length === 2 ? 2000 : 0);
  return month ? formatValidIsoDate(year, month, lastDayOfMonth(year, month)!) : null;
}

export const RLUSD_INDEPENDENT_ASSURANCE_PROFILE: IndependentAssuranceProfile = {
  adapterName: "rlusd-independent-assurance",
  product: "RLUSD",
  profile: "rlusd-v1",
  requiredAssetCodes: ["treasury-bills", "government-mmf", "cash"],
  classifications: {
    "treasury-bills": {
      name: "U.S. Treasury bills", risk: "very-low", assetClass: "treasury-bill",
      issuerOrObligor: "United States Treasury", riskFactors: ["duration", "liquidity", "custody"], liquidityHorizon: "seven-days",
    },
    "government-mmf": {
      name: "Government money-market funds", risk: "very-low", assetClass: "money-market-fund",
      issuerOrObligor: "U.S. government money-market funds", riskFactors: ["counterparty", "liquidity", "custody"], liquidityHorizon: "one-day",
    },
    cash: {
      name: "Cash and deposit accounts", risk: "very-low", assetClass: "bank-deposit",
      issuerOrObligor: "U.S. regulated financial institutions", riskFactors: ["counterparty", "custody", "concentration"], liquidityHorizon: "immediate",
    },
  },
  isReportCandidate: (href) => /RLUSD/i.test(decodeURIComponent(href)) && /(?:Reserves?|Attestation)[ _]Reports?/i.test(decodeURIComponent(href)),
  reportDateFromCandidate: rlusdReportDate,
  // Decode HTML-escaped apostrophes/ampersands before the shared URL matcher;
  // percent-encode quotes so decoding cannot change the attribute boundary.
  prepareIndexHtml: async (html) => html.replace(/\bhref=("([^"]*)"|'([^']*)')/gi, (_match, _attribute: string, double: string | undefined, single: string | undefined) =>
    `href="${decodeHtmlEntities(double ?? single ?? "").replace(/"/g, "%22").replace(/'/g, "%27")}"`),
};

export async function fetchRlusdIndependentAssuranceReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const params = parseLiveReserveAdapterParams("rlusd-independent-assurance", config.params) as
    LiveReserveAdapterParamsByKey["rlusd-independent-assurance"];
  return fetchIndependentAssuranceReserves(coin, config, signal, RLUSD_INDEPENDENT_ASSURANCE_PROFILE, params, ctx);
}
