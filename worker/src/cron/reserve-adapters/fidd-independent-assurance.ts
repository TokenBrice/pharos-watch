import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import { fetchIndependentAssuranceReserves, type IndependentAssuranceProfile } from "./independent-assurance";
import { fetchTextResponseWithRetry } from "./request";
import { formatValidIsoDate, lastDayOfMonth, monthNumberFromLabel } from "./report-date";
import type { AdapterContext, AdapterResult } from "./types";

const WIDEN_HOST = "fwc.widen.net";

// Fidelity's WAF answers HTTP 403 to crawler user agents that carry no contact
// URI — the shared index UA (browser-shaped) and the neutral
// `Pharos/1.0 (stablecoin analytics)` UA both fail from plain curl — while the
// same signature with a contact URL is served (verified 2026-09-11). Only the
// index fetch overrides the shared UA; fwc.widen.net serves the viewer page and
// the reviewed PDF to the shared UA.
const FIDD_INDEX_USER_AGENT = "Pharos/1.0 (+https://pharos.watch)";

export function fiddReportDate(href: string, text: string): string | null {
  const match = decodeURIComponent(`${href} ${text}`).match(
    /---(january|february|march|april|may|june|july|august|september|october|november|december)((?:19|20)?\d{2})(?:\.pdf)?(?:[?#\s]|$)/i,
  );
  if (!match) return null;
  const month = monthNumberFromLabel(match[1])!;
  const parsedYear = Number(match[2]);
  const year = match[2].length === 2 ? 2000 + parsedYear : parsedYear;
  return formatValidIsoDate(year, month, lastDayOfMonth(year, month)!, 2000);
}

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

export function fiddIndependentAssuranceProfile(
  viewerUrlPattern: string,
): IndependentAssuranceProfile {
  const viewerPattern = new RegExp(viewerUrlPattern, "i");
  return {
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
    indexHeaders: { "User-Agent": FIDD_INDEX_USER_AGENT },
    prepareIndexHtml: async (html, signal, ctx) => {
      const viewerCandidates = Array.from(html.matchAll(/href\s*=\s*"([^"]+)"/gi))
        .map((match) => match[1].replace(/&amp;/g, "&"))
        .filter((href) => viewerPattern.test(href))
        .map((url) => ({ url, date: fiddReportDate(url, "") }))
        .filter((candidate): candidate is { url: string; date: string } => candidate.date != null)
        .sort((a, b) => b.date.localeCompare(a.date));
      const viewer = viewerCandidates[0];
      if (!viewer) {
        throw new Error("fidd-independent-assurance: no dated attestation viewer link found");
      }
      assertWidenHost(viewer.url, "viewer");
      const response = await fetchTextResponseWithRetry(viewer.url, signal, 15_000, ctx, {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "Mozilla/5.0 Pharos reserve verifier",
        },
        maxRetries: 0,
      });
      assertWidenHost(response.finalUrl, "viewer response");
      const downloadAnchor = response.body.match(/<a\b[^>]*\bid="download"[^>]*\bhref\s*=\s*"([^"]+)"/i);
      if (!downloadAnchor) {
        throw new Error("fidd-independent-assurance: download link is missing from the Widen viewer page");
      }
      const absolute = new URL(downloadAnchor[1].replace(/&amp;/g, "&"), viewer.url).href;
      assertWidenHost(absolute, "download");
      return response.body.replace(downloadAnchor[0], downloadAnchor[0].replace(downloadAnchor[1], absolute));
    },
  };
}

export async function fetchFiddIndependentAssuranceReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const params = parseLiveReserveAdapterParams("fidd-independent-assurance", config.params) as
    LiveReserveAdapterParamsByKey["fidd-independent-assurance"];
  const profile = fiddIndependentAssuranceProfile(params.viewerUrlPattern);
  return fetchIndependentAssuranceReserves(coin, config, signal, profile, params, ctx);
}
