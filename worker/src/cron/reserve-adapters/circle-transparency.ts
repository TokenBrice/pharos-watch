import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import {
  escapeRegExp,
  extractAnchorWindow,
  extractTagById,
  fetchPrimaryHtmlInput,
  freshnessMetadataFromTimestamp,
  htmlLayoutChangedError,
  parseTimestampLikeToUnixSeconds,
  reserveInfoWarning,
  slicesFromPercentages,
  slicesFromValues,
} from "./helpers";
import { buildDocumentedRedemptionTelemetry } from "./redemption";

interface CircleSliceConfig {
  attr: string;
  label: string;
  sourceKey: string;
}

const CIRCLE_ABSOLUTE_MODE_MAX_RELATIVE_DIFF = 0.03;
const CIRCLE_PERCENT_MODE_TOLERANCE_PCT = 2;

const USDC_SLICES: CircleSliceConfig[] = [
  { attr: "data-usdc-us-treasuries", label: "<3-Month U.S. Treasuries", sourceKey: "circle:usdc:treasuries-under-3m" },
  { attr: "data-usdc-months", label: "Deposits at Systemically Important Institutions", sourceKey: "circle:usdc:sifi-deposits" },
  { attr: "data-usdc-cash", label: "Other Bank Deposits", sourceKey: "circle:usdc:other-bank-deposits" },
  { attr: "data-usdc-in-circulation", label: "Overnight Reverse Treasury Repo", sourceKey: "circle:usdc:overnight-reverse-treasury-repo" },
];

const EURC_SLICES: CircleSliceConfig[] = [
  { attr: "data-eurocoin-cash", label: "Other Bank Deposits", sourceKey: "circle:eurc:other-bank-deposits" },
  { attr: "data-eurocoin-tokens", label: "Deposits at Systemically Important Institutions", sourceKey: "circle:eurc:sifi-deposits" },
];

function extractAttrValue(html: string, attr: string): number | null {
  // Match data-attr="value" or data-attr='value' with optional whitespace around "=".
  // Numeric value must be a clean positive decimal: digits with at most one
  // decimal section. Rejects "4.7.18" or stray dots that parseFloat would
  // silently truncate to a wrong slice value.
  // eslint-disable-next-line security/detect-non-literal-regexp -- attr is selected from adapter-owned config constants.
  const re = new RegExp(`${attr}\\s*=\\s*["'](\\d+(?:\\.\\d+)?)["']`, "i");
  const m = html.match(re);
  if (!m) return null;
  const val = parseFloat(m[1]);
  return Number.isFinite(val) && val > 0 ? val : null;
}

function extractDisplayAmount(html: string, coinType: string): number | null {
  const displayId = coinType === "eurc" ? "euro-in-circulation" : "usdc-in-circulation";
  const tag = extractTagById(html, displayId);
  return tag ? extractAttrValue(tag, "data-point") : null;
}

function extractReserveSectionHtml(html: string, coinType: string): string | null {
  const canvasId = coinType === "eurc" ? "euro-in-circulation" : "usdc-in-circulation";
  const escapedId = escapeRegExp(canvasId);
  // Capture the HTML window immediately surrounding the reserve canvas element
  // (id=<canvasId>) so the "As of" lookup matches the disclosure date attached
  // to the reserve block, not some other page-level "As of" banner. Circle's
  // reserve disclosure places the date adjacent to the chart; a ±1500-char
  // window is more than enough without reaching unrelated site chrome.
  // eslint-disable-next-line security/detect-non-literal-regexp -- canvasId is escaped before interpolation.
  const anchorRe = new RegExp(`id\\s*=\\s*["']${escapedId}["']`, "i");
  return extractAnchorWindow(html, anchorRe, 1_500);
}

function extractDisclosureTimestamp(
  html: string,
  coinType: string,
  warnings: LiveReserveWarning[],
): number | null {
  const section = extractReserveSectionHtml(html, coinType) ?? html;
  const match = section.match(/\bAs of\s+([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})\b/i);
  const sectionTimestamp = parseTimestampLikeToUnixSeconds(match?.[1]);
  if (sectionTimestamp != null) return sectionTimestamp;

  const globalMatches = [...html.matchAll(/\bAs of\s+([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})\b/gi)]
    .map((globalMatch) => parseTimestampLikeToUnixSeconds(globalMatch[1]))
    .filter((timestamp): timestamp is number => timestamp != null);
  const uniqueTimestamps = new Set(globalMatches);
  if (uniqueTimestamps.size === 1) return globalMatches[0];
  if (uniqueTimestamps.size >= 2) {
    warnings.push(reserveInfoWarning(
      "circle-disclosure-timestamp-ambiguous",
      `Circle ${coinType.toUpperCase()} reserve page exposes ${uniqueTimestamps.size} distinct "As of" dates ` +
        "outside the disclosure window; freshness downgraded to unverified until the layout is reviewed.",
    ));
  }
  return null;
}

export function adaptCircleTransparency(html: string, coinType: string): AdapterResult {
  const sliceConfigs = coinType === "eurc" ? EURC_SLICES : USDC_SLICES;
  const missingAttrs: string[] = [];
  const warnings: LiveReserveWarning[] = [];

  const entries: Array<{ sourceKey: string; name: string; value: number; risk: "very-low" }> = [];

  for (const cfg of sliceConfigs) {
    const val = extractAttrValue(html, cfg.attr);
    if (val == null) {
      missingAttrs.push(cfg.attr);
      continue;
    }
    entries.push({ sourceKey: cfg.sourceKey, name: cfg.label, value: val, risk: "very-low" });
  }

  if (missingAttrs.length > 0) {
    throw htmlLayoutChangedError(
      "circle-transparency",
      `missing reserve attributes for ${coinType}: ${missingAttrs.join(", ")}`,
    );
  }

  const rawValueSum = entries.reduce((sum, entry) => sum + entry.value, 0);
  const displayAmount = extractDisplayAmount(html, coinType);
  const displayAmountRelativeDiff = displayAmount != null && displayAmount > 0
    ? Math.abs(rawValueSum - displayAmount) / Math.max(rawValueSum, displayAmount)
    : null;
  const looksLikePercentages = Math.abs(rawValueSum - 100) <= CIRCLE_PERCENT_MODE_TOLERANCE_PCT;
  const useAbsoluteValues = !looksLikePercentages
    && displayAmountRelativeDiff != null
    && displayAmountRelativeDiff <= CIRCLE_ABSOLUTE_MODE_MAX_RELATIVE_DIFF;
  const sourceTimestamp = extractDisclosureTimestamp(html, coinType, warnings);

  const slices = useAbsoluteValues
    ? slicesFromValues(
      entries.map((entry) => ({
        sourceKey: entry.sourceKey,
        name: entry.name,
        value: entry.value,
        risk: entry.risk,
      })),
      1,
    )
    : slicesFromPercentages(
      entries.map((entry) => ({
        sourceKey: entry.sourceKey,
        name: entry.name,
        pct: entry.value,
        risk: entry.risk,
      })),
      { context: `Circle ${coinType.toUpperCase()} reserve composition` },
    );

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      coinType,
      sliceCount: entries.length,
      expectedSliceCount: sliceConfigs.length,
      ...freshnessMetadataFromTimestamp(
        sourceTimestamp,
        "html-disclosure",
        "Circle reserve page does not expose a parseable upstream disclosure timestamp in the adapter payload",
      ),
      valueMode: useAbsoluteValues ? "absolute" : "percentage",
      rawValueSum,
      ...(displayAmount != null ? { displayAmount } : {}),
      ...(displayAmountRelativeDiff != null ? { displayAmountRelativeDiff } : {}),
      redemption: buildDocumentedRedemptionTelemetry(sourceTimestamp, { holderEligibility: "verified-customer" }),
    },
  };
}

export async function fetchCircleReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const html = await fetchPrimaryHtmlInput(config, "circle-transparency", signal, ctx);
  const { coinType } = parseLiveReserveAdapterParams("circle-transparency", config.params);
  return adaptCircleTransparency(html, coinType);
}
