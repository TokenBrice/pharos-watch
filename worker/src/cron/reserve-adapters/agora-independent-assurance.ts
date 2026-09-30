import { getIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import { fetchIndependentAssuranceReserves, type IndependentAssuranceProfile } from "./independent-assurance";
import { formatValidIsoDate, lastDayOfMonth, monthNumberFromLabel } from "./report-date";
import type { AdapterContext, AdapterResult } from "./types";

const ADAPTER_KEY = "agora-independent-assurance";

const MONTH_NAMES = /Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?/i;

function agoraReportDate(href: string, text: string): string | null {
  const decoded = decodeURIComponent(`${href} ${text}`);
  // eslint-disable-next-line security/detect-non-literal-regexp -- pattern fragment is a static constant.
  const monthYear = decoded.match(new RegExp(`20\\d{2}\\s+(${MONTH_NAMES.source})\\b`, "i"));
  if (monthYear) {
    const year = Number(monthYear[0].slice(0, 4));
    const month = monthNumberFromLabel(monthYear[1])!;
    const day = lastDayOfMonth(year, month)!;
    return formatValidIsoDate(year, month, day, 2000);
  }
  const asOf = decoded.match(/as of\s+(\d{1,2})\.(\d{1,2})\.(\d{2})\b/i);
  if (asOf) return formatValidIsoDate(2000 + Number(asOf[3]), Number(asOf[1]), Number(asOf[2]), 2000);
  return null;
}

function isAgoraReportCandidate(href: string, text: string): boolean {
  const decoded = decodeURIComponent(`${href} ${text}`);
  return /Agora Dollar Reserve Report|Management Report on Agora Dollar/i.test(decoded);
}

/**
 * Fern serves report links as either signed S3 URLs, stable mirror URLs, or
 * same-origin /_fern-files/ paths. Match the complete reviewed asset path,
 * including the content hash and report filename, before rewriting to the
 * stable mirror. The shared verifier still checks dates and PDF bytes.
 * A missing, drifted, or duplicated reviewed link fails closed.
 */
async function prepareAgoraIndexHtml(html: string): Promise<string> {
  const manifest = getIndependentAssuranceManifest("AUSD");
  const reviewedPath = new URL(manifest.reportUrl).pathname;
  const indexUrl = "https://docs.agora.finance/developer/transparency";
  let reviewedCount = 0;
  const rewritten = html.replace(/href="([^"]*\.pdf[^"]*)"/gi, (attribute, href: string) => {
    const decoded = href.replaceAll("&amp;", "&");
    let url: URL;
    try {
      url = new URL(decoded, indexUrl);
    } catch {
      return attribute;
    }
    const fernPath = url.hostname === "docs.agora.finance" && url.pathname.startsWith("/_fern-files/")
      ? url.pathname.slice("/_fern-files".length)
      : url.pathname;
    const reviewedHost = url.hostname === "docs.agora.finance"
      || url.hostname === "files.buildwithfern.com"
      || url.hostname === "fdr-prod-docs-files-public.s3.us-east-1.amazonaws.com";
    if (url.protocol !== "https:" || !reviewedHost || fernPath !== reviewedPath) return attribute;
    reviewedCount += 1;
    return `href="${manifest.reportUrl}"`;
  });
  if (reviewedCount !== 1) {
    throw new Error(`${ADAPTER_KEY}: reviewed report link missing or ambiguous on official index`);
  }
  return rewritten;
}

export const AGORA_INDEPENDENT_ASSURANCE_PROFILE: IndependentAssuranceProfile = {
  adapterName: ADAPTER_KEY,
  product: "AUSD",
  profile: "ausd-v1",
  requiredAssetCodes: ["us-treasury-securities", "us-treasury-repos"],
  reconciliation: {
    // Reviewed August category sum is $1 below the printed reserve total.
    reportedAssetTotalTolerance: { absolute: "1", relativePpm: 1 },
  },
  classifications: {
    "us-treasury-securities": {
      name: "Short-dated U.S. Treasury securities held in the Agora Reserve Fund",
      risk: "very-low",
      assetClass: "treasury-bill",
      issuerOrObligor: "United States Treasury",
      riskFactors: ["duration", "liquidity", "custody"],
      liquidityHorizon: "seven-days",
    },
    "us-treasury-repos": {
      name: "Overnight U.S. Treasury repurchase agreements held in the Agora Reserve Fund",
      risk: "very-low",
      assetClass: "repo",
      issuerOrObligor: "Undisclosed overnight repo counterparties",
      riskFactors: ["counterparty", "liquidity", "custody"],
      liquidityHorizon: "one-day",
    },
    "fund-cash": {
      name: "Cash held in the Agora Reserve Fund at regulated financial institutions",
      risk: "very-low",
      assetClass: "bank-deposit",
      issuerOrObligor: "Undisclosed regulated financial institutions",
      riskFactors: ["counterparty", "custody", "concentration"],
      liquidityHorizon: "immediate",
    },
    "company-cash": {
      name: "Cash held by Agora Bermuda Limited at regulated financial institutions",
      risk: "very-low",
      assetClass: "bank-deposit",
      issuerOrObligor: "Undisclosed regulated financial institutions",
      riskFactors: ["counterparty", "custody", "concentration"],
      liquidityHorizon: "immediate",
    },
    stablecoins: {
      name: "Stablecoin cash equivalents held in segregated wallets",
      risk: "low",
      assetClass: "stablecoin",
      issuerOrObligor: "Circle USDC and Paxos-issued PYUSD; individual split undisclosed",
      riskFactors: ["counterparty", "custody", "smart-contract", "liquidity"],
      liquidityHorizon: "unknown",
    },
  },
  isReportCandidate: isAgoraReportCandidate,
  reportDateFromCandidate: agoraReportDate,
  prepareIndexHtml: prepareAgoraIndexHtml,
};

export async function fetchAgoraIndependentAssuranceReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const params = parseLiveReserveAdapterParams(ADAPTER_KEY, config.params) as
    LiveReserveAdapterParamsByKey["agora-independent-assurance"];
  return fetchIndependentAssuranceReserves(coin, config, signal, AGORA_INDEPENDENT_ASSURANCE_PROFILE, params, ctx);
}
