import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import { fetchPrimaryHtmlInput, htmlLayoutChangedError } from "./helpers";
import { adaptAttestationPdfIndex } from "./attestation-pdf-index";
import { buildDocumentedRedemptionTelemetry } from "./redemption";


export function adaptUsdhNativeMarkets(html: string): AdapterResult {
  const result = adaptAttestationPdfIndex(html, {
    slices: [{
      name: "Reviewed attestation reserves (cash / T-Bills / custody)",
      pct: 100,
      risk: "low",
    }],
    linkMatch: String.raw`/attestations/\d{4}_[a-z]+[.]pdf`,
  });
  const metadata = result.metadata ?? {};
  const sourceTimestamp = result.metadata?.sourceTimestamp;
  if (sourceTimestamp == null) {
    throw htmlLayoutChangedError(
      "usdh-native-markets",
      "no /attestations/YYYY_<month>.pdf link found in HTML",
    );
  }
  const attestationPeriod = typeof metadata.reportPeriod === "string" ? metadata.reportPeriod : undefined;
  const attestationPdfPath = typeof metadata.reportPdfPath === "string" ? metadata.reportPdfPath : undefined;
  return {
    slices: result.slices,
    metadata: {
      ...(attestationPeriod ? { attestationPeriod } : {}),
      ...(attestationPdfPath ? { attestationPdfPath } : {}),
      sourceTimestamp,
      freshnessMode: sourceTimestamp != null ? "verified" : "unverified",
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
