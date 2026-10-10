import type { IndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import { ASSURANCE_RECONCILIATION_TOLERANCES } from "@shared/lib/independent-assurance-tolerances";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterFn, IndependentAssuranceProfile } from "./types";
import { fetchIndependentAssuranceReserves } from "./independent-assurance";
import { monthNumberFromLabel } from "./report-date";

export async function verifyMyrcIndexJson(json: string, manifest: IndependentAssuranceManifest): Promise<void> {
  const payload: unknown = JSON.parse(json);
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error("myrc-independent-assurance: missing attestation records");
  }
  const periods = new Set<number>();
  let newestPeriod = 0;
  let newest: { fileUrl: string; reservedAmount: number } | undefined;
  for (const value of payload) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("myrc-independent-assurance: malformed attestation record");
    }
    const row = value as Record<string, unknown>;
    if (typeof row.year !== "number" || !Number.isInteger(row.year) || row.year < 2000 || row.year > 2100
      || typeof row.month !== "number" || !Number.isInteger(row.month) || row.month < 1 || row.month > 12
      || typeof row.reservedAmount !== "number" || !Number.isSafeInteger(row.reservedAmount) || row.reservedAmount < 0
      || typeof row.fileUrl !== "string" || (row.product !== undefined && row.product !== "MYRC")) {
      throw new Error("myrc-independent-assurance: malformed attestation record or wrong product");
    }
    const url = new URL(row.fileUrl);
    const filename = decodeURIComponent(url.pathname).match(/\/Blox Attestation Report-(\d{4})-(\d{2})-([A-Za-z]+)\.pdf$/);
    if (url.protocol !== "https:" || url.hostname !== "cdn.blox.my" || url.username || url.password
      || !url.pathname.startsWith(`/attestations/${row.year}/`) || url.search || url.hash
      || !filename || Number(filename[1]) !== row.year || Number(filename[2]) !== row.month
      || monthNumberFromLabel(filename[3]) !== row.month) {
      throw new Error("myrc-independent-assurance: unexpected report identity");
    }
    const period = row.year * 12 + row.month;
    if (periods.has(period)) throw new Error("myrc-independent-assurance: duplicate attestation period");
    periods.add(period);
    if (period > newestPeriod) {
      newestPeriod = period;
      newest = { fileUrl: url.href, reservedAmount: row.reservedAmount };
    }
  }
  const [year, month] = manifest.reportDate.split("-").map(Number);
  if (manifest.product !== "MYRC" || manifest.unit !== "MYR"
    || newestPeriod !== year * 12 + month || !newest
    || newest.fileUrl !== new URL(manifest.reportUrl).href
    || newest.reservedAmount / 100 !== Number(manifest.computedAssetTotal)) {
    throw new Error("myrc-independent-assurance: newest report is not the reviewed MYRC examination");
  }
}

export const MYRC_INDEPENDENT_ASSURANCE_PROFILE: IndependentAssuranceProfile = {
  adapterName: "myrc-independent-assurance",
  product: "MYRC",
  profile: "myrc-v1",
  requiredAssetCodes: ["cash", "halogen-myr-liquid-fund"],
  classifications: {
    cash: {
      name: "MYR cash at Malaysian banks",
      risk: "very-low",
      assetClass: "bank-deposit",
      issuerOrObligor: "Undisclosed Malaysian banks",
      riskFactors: ["counterparty", "custody", "concentration"],
      liquidityHorizon: "unknown",
    },
    "halogen-myr-liquid-fund": {
      name: "Halogen Shariah MYR Liquid Fund",
      risk: "very-low",
      assetClass: "money-market-fund",
      issuerOrObligor: "Halogen Capital",
      riskFactors: ["counterparty", "liquidity", "custody"],
      liquidityHorizon: "unknown",
    },
  },
  reconciliation: ASSURANCE_RECONCILIATION_TOLERANCES.MYRC,
  isReportCandidate: () => false,
  reportDateFromCandidate: () => null,
  indexHeaders: { Accept: "application/json" },
  verifyIndexJson: verifyMyrcIndexJson,
};

export const fetchMyrcIndependentAssuranceReserves: AdapterFn = async (coin, config, signal, ctx) => {
  if (coin.id !== "myrc-blox") throw new Error("myrc-independent-assurance: unexpected coin identity");
  const params = parseLiveReserveAdapterParams("myrc-independent-assurance", config.params);
  const result = await fetchIndependentAssuranceReserves(coin, config, signal, MYRC_INDEPENDENT_ASSURANCE_PROFILE, params, ctx);
  return {
    ...result,
    metadata: {
      ...result.metadata,
      details: {
        ...result.metadata?.details,
        examinerRelianceCaveat: "Made solely to Blox Blockchain Sdn Bhd; examiner disclaims responsibility to other persons. This is a reliance caveat, not a proved public-distribution prohibition.",
        signatureDate: "2026-09-29",
        signatureDateIsSourceClock: false,
      },
    },
  };
};
