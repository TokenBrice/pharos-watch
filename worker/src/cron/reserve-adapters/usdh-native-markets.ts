import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchPrimaryHtmlInput,
  freshnessMetadataFromTimestamp,
  htmlLayoutChangedError,
  parseTimestampLikeToUnixSeconds,
} from "./helpers";
import { buildDocumentedRedemptionTelemetry } from "./redemption";
import { MONTH_INDEX, MONTH_LABEL, lastDayOfMonth } from "./report-date";

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
  const lastDay = lastDayOfMonth(year, monthIndex + 1);
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
      ...freshnessMetadataFromTimestamp(
        sourceTimestamp,
        "html-disclosure",
        "USDH reserves page did not expose a parseable attestation month",
      ),
      redemption: buildDocumentedRedemptionTelemetry(sourceTimestamp, { holderEligibility: "verified-customer" }),
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
