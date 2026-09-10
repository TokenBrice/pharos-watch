import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import { fetchIndependentAssuranceReserves, type IndependentAssuranceProfile } from "./independent-assurance";
import type { AdapterContext, AdapterResult } from "./types";
import { formatValidIsoDate, lastDayOfMonth } from "./report-date";

// AUDD's monthly William Buck ASRS 4400 report is an agreed-upon-procedures
// engagement ("not an assurance engagement; we do not express an opinion or an
// assurance conclusion"), so the adapter publishes through the
// static-validated / issuer-attested descriptor rather than the independent
// class of its AUDX sibling.
export const AUDD_INDEPENDENT_ASSURANCE_PROFILE: IndependentAssuranceProfile = {
  adapterName: "audd-independent-assurance",
  product: "AUDD",
  profile: "audd-v1",
  requiredAssetCodes: ["banking-circle", "westpac"],
  classifications: {
    "banking-circle": {
      name: "AUD cash at Banking Circle (AUDC Reserve Account)",
      risk: "very-low",
      assetClass: "bank-deposit",
      issuerOrObligor: "Banking Circle S.A.",
      riskFactors: ["counterparty", "custody", "liquidity", "concentration"],
      liquidityHorizon: "immediate",
    },
    westpac: {
      name: "AUD cash at Westpac under the AMAL Bare Trust",
      risk: "very-low",
      assetClass: "bank-deposit",
      issuerOrObligor: "Westpac Banking Corporation via AMAL Trustees Pty Ltd ATF AMAL Bare Trust",
      riskFactors: ["counterparty", "custody", "liquidity", "concentration"],
      liquidityHorizon: "immediate",
    },
  },
  isReportCandidate: (href) =>
    /Agreed[+_-]upon[+_-]procedures[+_-]report/i.test(decodeURIComponent(href)),
  reportDateFromCandidate: auddReportDate,
};

const AUDD_REPORT_MONTHS: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function auddReportDate(href: string): string | null {
  const fileName = decodeURIComponent(new URL(href).pathname.split("/").pop() ?? "");
  const match = fileName.match(/report[+_-]?([A-Za-z]{3,4})[+._-]?(?:20)?(\d{2})_?\.pdf$/i);
  if (!match) return null;
  const month = AUDD_REPORT_MONTHS[match[1].toLowerCase()];
  const year = 2000 + Number(match[2]);
  if (!month) return null;
  return formatValidIsoDate(year, month, lastDayOfMonth(year, month)!);
}

export async function fetchAuddIndependentAssuranceReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const params = parseLiveReserveAdapterParams("audd-independent-assurance", config.params) as
    LiveReserveAdapterParamsByKey["audd-independent-assurance"];
  return fetchIndependentAssuranceReserves(coin, config, signal, AUDD_INDEPENDENT_ASSURANCE_PROFILE, params, ctx);
}
