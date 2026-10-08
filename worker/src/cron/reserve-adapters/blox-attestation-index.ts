import type { ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import { fetchJsonWithRetry, requireJsonInput, verifiedFreshnessMetadata } from "./helpers";

const INDEX_URL = "https://api.blox.my/blox-admin/attestations";
const REPORT_URL = "https://cdn.blox.my/attestations/2026/Blox%20Attestation%20Report-2026-08-August.pdf";
const PERIOD = 2026 * 12 + 8;
const RESERVE_AMOUNT_MINOR = 180090377;
// Conservative UTC start of the examined date, not the September upload time.
const SOURCE_TIMESTAMP = Date.parse("2026-08-31T00:00:00Z") / 1000;

/** Reviewed composition only. The JSON index measures the MYR total, not its
 * allocation; a newer report must be reviewed before these slices can advance.
 * This is static-validated evidence, not runtime independent assurance. */
export function adaptBloxAttestationIndex(payload: unknown): AdapterResult {
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error("blox-attestation-index: missing attestation records");
  }
  let newestPeriod = 0;
  let newest: { fileUrl: string; reservedAmount: number } | undefined;
  let newestCount = 0;
  for (const row of payload) {
    if (!row || typeof row !== "object"
      || !Number.isInteger(row.year) || row.year < 2000 || row.year > 2100
      || !Number.isInteger(row.month) || row.month < 1 || row.month > 12
      || !Number.isSafeInteger(row.reservedAmount) || row.reservedAmount < 0
      || typeof row.fileUrl !== "string") {
      throw new Error("blox-attestation-index: malformed attestation record");
    }
    const url = new URL(row.fileUrl);
    if (url.protocol !== "https:" || url.hostname !== "cdn.blox.my"
      || !url.pathname.startsWith(`/attestations/${row.year}/`)
      || !url.pathname.toLowerCase().endsWith(".pdf") || url.search || url.hash) {
      throw new Error("blox-attestation-index: unexpected report identity");
    }
    const period = row.year * 12 + row.month;
    if (period > newestPeriod) {
      newestPeriod = period;
      newest = row;
      newestCount = 1;
    } else if (period === newestPeriod) {
      newestCount++;
    }
  }
  if (newestPeriod !== PERIOD || newestCount !== 1 || !newest
    || new URL(newest.fileUrl).href !== REPORT_URL
    || newest.reservedAmount !== RESERVE_AMOUNT_MINOR) {
    throw new Error("blox-attestation-index: newest report is not the reviewed August 2026 disclosure");
  }
  return {
    slices: [
      {
        sourceKey: "blox-independent-assurance:myrc:cash",
        name: "MYR cash at Malaysian banks",
        pct: 66.68,
        risk: "very-low",
        assetClass: "bank-deposit",
        issuerOrObligor: "Undisclosed Malaysian banks",
        riskFactors: ["counterparty", "custody", "concentration"],
        liquidityHorizon: "unknown",
      },
      {
        sourceKey: "blox-independent-assurance:myrc:halogen-myr-liquid-fund",
        name: "Halogen Shariah MYR Liquid Fund",
        pct: 33.32,
        risk: "very-low",
        assetClass: "money-market-fund",
        issuerOrObligor: "Halogen Capital",
        riskFactors: ["counterparty", "liquidity", "custody"],
        liquidityHorizon: "unknown",
      },
    ],
    metadata: {
      ...verifiedFreshnessMetadata(SOURCE_TIMESTAMP),
      details: {
        reportUrl: REPORT_URL,
        compositionAsOf: "2026-08-31",
        compositionBasis: "Reviewed August 2026 report; JSON index validates period, URL and MYR breakdown total only",
        reserveCurrency: "MYR",
        reserveAmount: RESERVE_AMOUNT_MINOR / 100,
        assertedReserveAmount: 1800903.74,
        reportedBreakdownDifference: 0.03,
        runtimeAssuranceVerification: false,
      },
    },
  };
}

export async function fetchBloxAttestationIndexReserves(
  coin: ReserveAdapterCoin,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, "blox-attestation-index");
  parseLiveReserveAdapterParams("blox-attestation-index", config.params);
  if (coin.id !== "myrc-blox" || input.url !== INDEX_URL) {
    throw new Error("blox-attestation-index: unexpected coin or index URL");
  }
  const payload = await fetchJsonWithRetry<unknown>(input.url, signal, 12_000, ctx);
  return adaptBloxAttestationIndex(payload);
}
