import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchPrimaryHtmlInput,
  htmlLayoutChangedError,
  parseTimestampLikeToUnixSeconds,
  unverifiedFreshnessMetadata,
  verifiedFreshnessMetadata,
} from "./helpers";

const MONTH_INDEX: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

const MONTH_LABEL = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

interface AttestationLink {
  year: number;
  monthIndex: number;
  pdfPath: string;
}

/**
 * Collect every `/attestations/YYYY_<month>.pdf` link on the reserves page
 * and pick the one with the highest (year, monthIndex). USDH lists
 * attestations chronologically inside year accordions — filename order is
 * the authoritative recency signal, so we sort regardless of DOM order.
 */
function findLatestAttestationLink(html: string): AttestationLink | null {
  const re = /\/attestations\/(\d{4})_([a-z]+)\.pdf/gi;
  let latest: AttestationLink | null = null;
  for (const match of html.matchAll(re)) {
    const year = Number.parseInt(match[1], 10);
    const monthName = match[2].toLowerCase();
    const monthIndex = MONTH_INDEX[monthName];
    if (!Number.isFinite(year) || monthIndex == null) continue;
    const entry: AttestationLink = { year, monthIndex, pdfPath: match[0] };
    if (
      !latest
      || entry.year > latest.year
      || (entry.year === latest.year && entry.monthIndex > latest.monthIndex)
    ) {
      latest = entry;
    }
  }
  return latest;
}

function lastDayOfMonthLabel(year: number, monthIndex: number): string {
  // Date.UTC with day 0 of the NEXT month == last day of the requested month.
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return `${MONTH_LABEL[monthIndex]} ${lastDay}, ${year}`;
}

export function adaptUsdhNativeMarkets(html: string): AdapterResult {
  const latest = findLatestAttestationLink(html);
  if (!latest) {
    throw htmlLayoutChangedError(
      "usdh-native-markets",
      "no /attestations/YYYY_<month>.pdf link found in HTML",
    );
  }

  const asOfLabel = lastDayOfMonthLabel(latest.year, latest.monthIndex);
  const sourceTimestamp = parseTimestampLikeToUnixSeconds(asOfLabel);
  const attestationPeriod = `${MONTH_LABEL[latest.monthIndex]} ${latest.year}`;

  return {
    slices: [
      {
        name: "Reviewed attestation reserves (cash / T-Bills / custody)",
        pct: 100,
        risk: "low",
      },
    ],
    metadata: {
      attestationPeriod,
      attestationPdfPath: latest.pdfPath,
      ...(sourceTimestamp != null
        ? verifiedFreshnessMetadata(sourceTimestamp)
        : unverifiedFreshnessMetadata(
            "html-disclosure",
            "USDH reserves page did not expose a parseable attestation month",
          )),
      redemption: {
        capacityKind: "documented-bound" as const,
        freshnessKind: sourceTimestamp != null ? "verified-source-timestamp" as const : "unverified" as const,
        ...(sourceTimestamp != null ? { sourceTimestamp } : {}),
        routeStatus: "unknown" as const,
        holderEligibility: "verified-customer",
      },
    },
  };
}

export async function fetchUsdhNativeMarketsReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const html = await fetchPrimaryHtmlInput(config, "usdh-native-markets", signal, ctx);
  return adaptUsdhNativeMarkets(html);
}
