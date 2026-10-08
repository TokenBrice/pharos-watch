import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { IndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import { fetchIndependentAssuranceReserves, type IndependentAssuranceProfile } from "./independent-assurance";
import { formatValidIsoDate, lastDayOfMonth } from "./report-date";
import type { AdapterFn } from "./types";

/** JSON membership is a discovery fence, never the assurance artifact itself. */
export function verifyBloxAttestationIndex(json: string, manifest: IndependentAssuranceManifest): void {
  const payload: unknown = JSON.parse(json);
  if (!Array.isArray(payload) || payload.length === 0 || payload.length > 1200) {
    throw new Error("blox-independent-assurance: missing or oversized attestation index");
  }
  const seenPeriods = new Set<string>();
  const seenUrls = new Set<string>();
  let reviewedMatches = 0;
  let newestDate = "";
  for (const row of payload) {
    if (!row || typeof row !== "object" || !Number.isInteger(row.year) || row.year < 2000 || row.year > 2100
      || !Number.isInteger(row.month) || row.month < 1 || row.month > 12
      || !Number.isSafeInteger(row.reservedAmount) || row.reservedAmount < 0 || typeof row.fileUrl !== "string") {
      throw new Error("blox-independent-assurance: malformed or undated attestation record");
    }
    const url = new URL(row.fileUrl);
    const period = `${row.year}-${String(row.month).padStart(2, "0")}`;
    const reportDate = formatValidIsoDate(row.year, row.month, lastDayOfMonth(row.year, row.month)!);
    if (!reportDate || url.protocol !== "https:" || url.hostname !== "cdn.blox.my" || url.username || url.password
      || url.port || url.search || url.hash
      || !decodeURIComponent(url.pathname).startsWith(`/attestations/${row.year}/Blox Attestation Report-${period}-`)
      || !url.pathname.toLowerCase().endsWith(".pdf")) {
      throw new Error("blox-independent-assurance: unexpected report identity");
    }
    if (seenPeriods.has(period) || seenUrls.has(url.href)) {
      throw new Error("blox-independent-assurance: duplicated attestation period or URL");
    }
    seenPeriods.add(period);
    seenUrls.add(url.href);
    if (reportDate > newestDate) newestDate = reportDate;
    if (url.href === new URL(manifest.reportUrl).href) {
      if (reportDate !== manifest.reportDate || row.reservedAmount !== Math.round(Number(manifest.computedAssetTotal) * 100)) {
        throw new Error("blox-independent-assurance: reviewed report date or itemized total mismatch");
      }
      reviewedMatches++;
    }
  }
  if (newestDate > manifest.reportDate) throw new Error("blox-independent-assurance: newer unreviewed report on official index");
  if (newestDate !== manifest.reportDate || reviewedMatches !== 1) {
    throw new Error("blox-independent-assurance: reviewed newest report missing from official index");
  }
}

export const BLOX_INDEPENDENT_ASSURANCE_PROFILE: IndependentAssuranceProfile = {
  adapterName: "blox-independent-assurance", product: "MYRC", profile: "myrc-v1",
  requiredAssetCodes: ["cash", "halogen-myr-liquid-fund"],
  classifications: {
    cash: { name: "MYR cash at Malaysian banks", risk: "very-low", assetClass: "bank-deposit", issuerOrObligor: "Undisclosed Malaysian banks", riskFactors: ["counterparty", "custody", "concentration"], liquidityHorizon: "unknown" },
    "halogen-myr-liquid-fund": { name: "Halogen Shariah MYR Liquid Fund", risk: "very-low", assetClass: "money-market-fund", issuerOrObligor: "Halogen Capital", riskFactors: ["counterparty", "liquidity", "custody"], liquidityHorizon: "unknown" },
  },
  reconciliation: { reportedAssetTotalTolerance: { absolute: "0.03", relativePpm: 0.02 } },
  // JSON discovery uses verifyIndexJson; HTML candidates are never admitted.
  isReportCandidate: () => false,
  reportDateFromCandidate: () => null,
  indexHeaders: { Accept: "application/json" },
  verifyIndexJson: async (json, manifest) => verifyBloxAttestationIndex(json, manifest),
};

/** Staged and unbound until a fresh qualifying report and cohort packet pass. */
export const fetchBloxIndependentAssuranceReserves: AdapterFn = async (coin, config, signal, ctx) => {
  const params = parseLiveReserveAdapterParams("blox-independent-assurance", config.params);
  return fetchIndependentAssuranceReserves(coin, config, signal, BLOX_INDEPENDENT_ASSURANCE_PROFILE, params, ctx);
};
