import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import { fetchIndependentAssuranceReserves, type IndependentAssuranceProfile } from "./independent-assurance";
import { fetchTextResponseWithRetry } from "./request";
import { formatValidIsoDate, lastDayOfMonth, monthNumberFromLabel } from "./report-date";
import type { AdapterContext, AdapterResult } from "./types";

const WIDEN_HOST = "fwc.widen.net";

// Fidelity publishes PwC's monthly FIDD examination on
// fidelitydigitalassets.com/stablecoin, but the index links a Widen viewer
// page (fwc.widen.net/s/<id>/...-july26), not the PDF. The viewer page serves
// the original PDF through its id="download" anchor, so discovery resolves the
// reviewed July 2026 viewer link, fetches the viewer HTML, and rewrites the
// download href to its absolute fwc.widen.net URL for candidate collection.
// Products without a reviewed viewer link or download anchor fail closed.

function assertWidenHost(value: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`fidd-independent-assurance: ${label} is not a valid URL`);
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== WIDEN_HOST) {
    throw new Error(`fidd-independent-assurance: ${label} host is not the reviewed Widen host`);
  }
}

function fiddReportDate(href: string): string | null {
  const match = decodeURIComponent(href).match(
    /---(january|february|march|april|may|june|july|august|september|october|november|december)26\.pdf/i,
  );
  if (!match) return null;
  const month = monthNumberFromLabel(match[1]);
  if (!month) return null;
  return formatValidIsoDate(2026, month, lastDayOfMonth(2026, month)!);
}

export const FIDD_INDEPENDENT_ASSURANCE_PROFILE: IndependentAssuranceProfile = {
  adapterName: "fidd-independent-assurance",
  product: "FIDD",
  profile: "fidd-v1",
  requiredAssetCodes: ["cash-deposits", "us-treasury-bills"],
  classifications: {
    "cash-deposits": {
      name: "Cash deposits held in bank deposit accounts at The Bank of New York Mellon",
      risk: "very-low",
      assetClass: "bank-deposit",
      issuerOrObligor: "The Bank of New York Mellon",
      riskFactors: ["counterparty", "custody", "concentration"],
      liquidityHorizon: "immediate",
    },
    "us-treasury-bills": {
      name: "U.S. Treasury bills",
      risk: "very-low",
      assetClass: "treasury-bill",
      issuerOrObligor: "United States Treasury",
      riskFactors: ["duration", "liquidity", "custody"],
      liquidityHorizon: "one-day",
    },
  },
  isReportCandidate: (href) => /fidelity-digital-assets---fidd-reserve-attestation-report/i.test(href),
  reportDateFromCandidate: fiddReportDate,
  prepareIndexHtml: async (html, signal, ctx) => {
    const viewerMatch = html.match(
      /href\s*=\s*"(https:\/\/fwc\.widen\.net\/s\/[a-z0-9]+\/fidelity-digital-assets---fidd-reserve-attestation-report---july26)"/i,
    );
    if (!viewerMatch) {
      throw new Error("fidd-independent-assurance: July 2026 Widen viewer link is missing from the official index");
    }
    const viewerUrl = viewerMatch[1];
    assertWidenHost(viewerUrl, "viewer");
    const response = await fetchTextResponseWithRetry(viewerUrl, signal, 15_000, ctx, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0 Pharos reserve verifier",
      },
      maxRetries: 0,
    });
    assertWidenHost(response.finalUrl, "viewer response");
    const viewerHtml = response.body;
    const downloadAnchor = viewerHtml.match(/<a\b[^>]*\bid="download"[^>]*\bhref\s*=\s*"([^"]+)"/i);
    if (!downloadAnchor) {
      throw new Error("fidd-independent-assurance: download link is missing from the Widen viewer page");
    }
    const absolute = new URL(downloadAnchor[1].replace(/&amp;/g, "&"), viewerUrl).href;
    assertWidenHost(absolute, "download");
    return viewerHtml.replace(downloadAnchor[0], downloadAnchor[0].replace(downloadAnchor[1], absolute));
  },
};

export async function fetchFiddIndependentAssuranceReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const params = parseLiveReserveAdapterParams("fidd-independent-assurance", config.params) as
    LiveReserveAdapterParamsByKey["fidd-independent-assurance"];
  return fetchIndependentAssuranceReserves(coin, config, signal, FIDD_INDEPENDENT_ASSURANCE_PROFILE, params, ctx);
}
