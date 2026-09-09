import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import { fetchIndependentAssuranceReserves, type IndependentAssuranceProfile } from "./independent-assurance";
import { formatValidIsoDate, lastDayOfMonth } from "./report-date";
import type { AdapterContext, AdapterResult } from "./types";

// Brale publishes MCCPA's monthly SBC reserve attestations on
// brale.xyz/stablecoins/SBC as direct monthly PDF links (01-2026 … 07-2026).
// Discovery reads those anchors; the reviewed July 2026 report must remain the
// latest dated candidate or the adapter fails closed on a newer unreviewed
// report. The report's examiner limitation — MCCPA did not independently
// confirm the authenticity of company-provided data — is carried in the
// manifest engagement, not in this profile.

function sbcReportDate(href: string): string | null {
  const match = decodeURIComponent(href).match(/-(\d{2})-(\d{4})\.pdf$/i);
  if (!match) return null;
  const month = Number(match[1]);
  const year = Number(match[2]);
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year)) return null;
  return formatValidIsoDate(year, month, lastDayOfMonth(year, month)!);
}

const SBC_INDEPENDENT_ASSURANCE_PROFILE: IndependentAssuranceProfile = {
  adapterName: "sbc-independent-assurance",
  product: "SBC",
  profile: "sbc-v1",
  requiredAssetCodes: ["cash-and-cash-equivalents", "us-government-backed-debt"],
  classifications: {
    "cash-and-cash-equivalents": {
      name: "Cash and cash equivalents in unencumbered accounts segregated from other Brale accounts",
      risk: "very-low",
      assetClass: "cash",
      issuerOrObligor: "Undisclosed U.S. financial institutions holding Brale segregated accounts",
      riskFactors: ["counterparty", "custody", "concentration"],
      liquidityHorizon: "immediate",
    },
    "us-government-backed-debt": {
      name: "U.S. government backed debt",
      risk: "very-low",
      assetClass: "treasury-bill",
      issuerOrObligor: "United States Government",
      riskFactors: ["duration", "liquidity", "custody"],
      liquidityHorizon: "one-day",
    },
  },
  isReportCandidate: (href) => /SBC-Stable-Coin-Reserve-Attestation-Report/i.test(href),
  reportDateFromCandidate: sbcReportDate,
};

export async function fetchSbcIndependentAssuranceReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const params = parseLiveReserveAdapterParams("sbc-independent-assurance", config.params) as
    LiveReserveAdapterParamsByKey["sbc-independent-assurance"];
  return fetchIndependentAssuranceReserves(coin, config, signal, SBC_INDEPENDENT_ASSURANCE_PROFILE, params, ctx);
}
