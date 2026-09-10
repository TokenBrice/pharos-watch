import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import { fetchIndependentAssuranceReserves, type IndependentAssuranceProfile } from "./independent-assurance";
import type { AdapterContext, AdapterResult } from "./types";
import { formatValidIsoDate } from "./report-date";

// Anchorage publishes Deloitte's monthly USAT and USDPT examinations on
// anchorage.com/platform/usat-reserve-attestations and
// anchorage.com/platform/usdpt-reserve-attestations-anchorage-digital; the
// report links follow the same learn.anchorage.com host the USDGO manifest
// already pins. The schema.org JSON-LD on the pages is stale relative to the
// rendered anchor list, so discovery reads the anchors the page actually
// serves. Only reviewed products are registered; absent products fail closed.
function anchorageReportCandidate(product: "USAT" | "USDPT") {
  // eslint-disable-next-line security/detect-non-literal-regexp -- product is a fixed 'USAT' | 'USDPT' union, not runtime input.
  const hrefPattern = new RegExp(`${product}[-_ ]Stablecoin[-_ ]Attestation[-_ ]Report`, "i");
  return (href: string): boolean => hrefPattern.test(decodeURIComponent(href));
}

function anchorageReportDate(product: "USAT" | "USDPT") {
  // eslint-disable-next-line security/detect-non-literal-regexp -- product is a fixed 'USAT' | 'USDPT' union, not runtime input.
  const fileNamePattern = new RegExp(`^(\\d{2})[.](\\d{2})[.](\\d{2})_${product}[-_ ]Stablecoin[-_ ]Attestation`, "i");
  return (href: string): string | null => {
    const fileName = decodeURIComponent(new URL(href).pathname.split("/").pop() ?? "");
    const match = fileName.match(fileNamePattern);
    if (!match) return null;
    return formatValidIsoDate(2000 + Number(match[3]), Number(match[1]), Number(match[2]));
  };
}

export const USAT_INDEPENDENT_ASSURANCE_PROFILE: IndependentAssuranceProfile = {
  adapterName: "anchorage-independent-assurance",
  product: "USAT",
  profile: "usat-v1",
  requiredAssetCodes: ["cash", "reverse-repo"],
  classifications: {
    cash: {
      name: "Cash at major commercial banks (FDIC-insured demand deposits)",
      risk: "very-low",
      assetClass: "bank-deposit",
      issuerOrObligor: "Major U.S. commercial banks; uninsured balances above the FDIC limit are disclosed in the report",
      riskFactors: ["counterparty", "custody", "liquidity", "concentration"],
      liquidityHorizon: "immediate",
    },
    "reverse-repo": {
      name: "Reverse repurchase agreements collateralized by U.S. Treasury securities",
      risk: "very-low",
      assetClass: "repo",
      issuerOrObligor: "U.S. Treasury (collateral) via U.S. commercial banks and broker-dealers",
      riskFactors: ["counterparty", "liquidity", "custody"],
      liquidityHorizon: "one-day",
    },
  },
  isReportCandidate: anchorageReportCandidate("USAT"),
  reportDateFromCandidate: anchorageReportDate("USAT"),
};

// Western Union's USDPT rides the same monthly Deloitte flow; usdpt-v1 reviews
// the July 2026 examination, whose cash row discloses uninsured FDIC balances
// and whose money-market-funds row lists the funds by CUSIP.
export const USDPT_INDEPENDENT_ASSURANCE_PROFILE: IndependentAssuranceProfile = {
  adapterName: "anchorage-independent-assurance",
  product: "USDPT",
  profile: "usdpt-v1",
  requiredAssetCodes: ["cash", "money-market-funds"],
  classifications: {
    cash: {
      name: "Demand deposits at FDIC-insured depository institutions",
      risk: "very-low",
      assetClass: "bank-deposit",
      issuerOrObligor:
        "FDIC-insured depository institutions; uninsured balances above the FDIC limit are disclosed in the report",
      riskFactors: ["credit", "counterparty", "custody", "legal"],
      liquidityHorizon: "immediate",
    },
    "money-market-funds": {
      name: "Money market funds, at net asset value",
      risk: "low",
      assetClass: "money-market-fund",
      issuerOrObligor:
        "JPMorgan OnChain Liquidity-Token Money Market Fund (JLTXX; CUSIP 46655R119) and further funds disclosed by CUSIP only",
      riskFactors: ["credit", "duration", "liquidity", "custody", "counterparty"],
      liquidityHorizon: "one-day",
    },
  },
  isReportCandidate: anchorageReportCandidate("USDPT"),
  reportDateFromCandidate: anchorageReportDate("USDPT"),
};

const ANCHORAGE_ASSURANCE_PROFILES: Record<"USAT" | "USDPT", IndependentAssuranceProfile> = {
  USAT: USAT_INDEPENDENT_ASSURANCE_PROFILE,
  USDPT: USDPT_INDEPENDENT_ASSURANCE_PROFILE,
};

export async function fetchAnchorageIndependentAssuranceReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const params = parseLiveReserveAdapterParams("anchorage-independent-assurance", config.params) as
    LiveReserveAdapterParamsByKey["anchorage-independent-assurance"];
  return fetchIndependentAssuranceReserves(coin, config, signal, ANCHORAGE_ASSURANCE_PROFILES[params.product], params, ctx);
}
