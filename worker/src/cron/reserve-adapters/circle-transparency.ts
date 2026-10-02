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
  bankCategory?: "sifi" | "other";
}

const CIRCLE_ABSOLUTE_MODE_MAX_RELATIVE_DIFF = 0.03;
const CIRCLE_PERCENT_MODE_TOLERANCE_PCT = 2;

const USDC_SLICES: CircleSliceConfig[] = [
  { attr: "data-usdc-months", label: "<3-Month U.S. Treasuries", sourceKey: "circle:usdc:treasuries-under-3m" },
  { attr: "data-usdc-cash", label: "Cash at Regulated Financial Institutions", sourceKey: "circle:usdc:bank-deposits", bankCategory: "sifi" },
  { attr: "data-usdc-in-circulation", label: "Cash at Regulated Financial Institutions", sourceKey: "circle:usdc:bank-deposits", bankCategory: "other" },
  { attr: "data-usdc-us-treasuries", label: "Overnight Reverse Treasury Repo", sourceKey: "circle:usdc:overnight-reverse-treasury-repo" },
];

const EURC_SLICES: CircleSliceConfig[] = [
  { attr: "data-eurocoin-tokens", label: "Cash at Regulated Financial Institutions", sourceKey: "circle:eurc:bank-deposits", bankCategory: "other" },
  { attr: "data-eurocoin-cash", label: "Cash at Regulated Financial Institutions", sourceKey: "circle:eurc:bank-deposits", bankCategory: "sifi" },
];

function extractAttrValue(html: string, attr: string): number | null {
  // Match data-attr="value" or data-attr='value' with optional whitespace around "=".
  // Numeric value must be a clean non-negative decimal: digits with at most one
  // decimal section. Rejects "4.7.18" or stray dots that parseFloat would
  // silently truncate to a wrong slice value.
  // eslint-disable-next-line security/detect-non-literal-regexp -- attr is selected from adapter-owned config constants.
  const re = new RegExp(`${attr}\\s*=\\s*["'](\\d+(?:\\.\\d+)?)["']`, "i");
  const m = html.match(re);
  if (!m) return null;
  const val = parseFloat(m[1]);
  return Number.isFinite(val) && val >= 0 ? val : null;
}

function extractReserveCanvas(html: string, coinType: string): string {
  // Both identities are captured independently on Circle's transparency page.
  const canvasId = coinType === "eurc" ? "eurocoin_chartjs_canvas" : "usdc_chartjs_canvas";
  // eslint-disable-next-line security/detect-non-literal-regexp -- canvasId is adapter-owned and escaped.
  const re = new RegExp(`<[^>]*\\sid\\s*=\\s*["']${escapeRegExp(canvasId)}["'][^>]*>`, "gi");
  const tags = html.match(re);
  if (tags?.length !== 1 || !/^<canvas\b/i.test(tags[0])) {
    throw htmlLayoutChangedError("circle-transparency", `missing or ambiguous reserve canvas for ${coinType}`);
  }
  return tags[0];
}

function extractDisplayAmount(html: string, coinType: string): number | null {
  const displayId = coinType === "eurc" ? "euro-in-circulation" : "usdc-in-circulation";
  const tag = extractTagById(html, displayId);
  return tag ? extractAttrValue(tag, "data-point") : null;
}

function extractReserveSectionHtml(html: string, coinType: string): string | null {
  const displayId = coinType === "eurc" ? "euro-in-circulation" : "usdc-in-circulation";
  const escapedId = escapeRegExp(displayId);
  // Circle places the disclosure near the circulation total, not on the
  // composition canvas. Keep the reviewed ±1500-character date window.
  // eslint-disable-next-line security/detect-non-literal-regexp -- displayId is escaped before interpolation.
  const anchorRe = new RegExp(`\\sid\\s*=\\s*["']${escapedId}["']`, "i");
  return extractAnchorWindow(html, anchorRe, 1_500);
}

function extractDisclosureTimestamp(
  html: string,
  coinType: string,
  warnings: LiveReserveWarning[],
): number | null {
  const section = extractReserveSectionHtml(html, coinType);
  // A missing anchor must not turn the first page-wide date into a local date.
  for (const candidate of section == null ? [html] : [section, html]) {
    const timestamps = [...candidate.matchAll(/\bAs of\s+([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})\b/gi)]
      .map((match) => parseTimestampLikeToUnixSeconds(match[1]))
      .filter((timestamp): timestamp is number => timestamp != null);
    const uniqueTimestamps = new Set(timestamps);
    if (uniqueTimestamps.size === 1) return timestamps[0];
    if (uniqueTimestamps.size >= 2) {
      warnings.push(reserveInfoWarning(
        "circle-disclosure-timestamp-ambiguous",
        `Circle ${coinType.toUpperCase()} reserve page exposes ${uniqueTimestamps.size} distinct "As of" dates ` +
          `${candidate === section ? "inside the disclosure window" : "at page level"}; ` +
          "freshness downgraded to unverified until the layout is reviewed.",
      ));
      return null;
    }
  }
  return null;
}

export function adaptCircleTransparency(html: string, coinType: string): AdapterResult {
  const sliceConfigs = coinType === "eurc" ? EURC_SLICES : USDC_SLICES;
  const canvas = extractReserveCanvas(html, coinType);
  const missingAttrs: string[] = [];
  const warnings: LiveReserveWarning[] = [];

  const entries: Array<{ sourceKey: string; name: string; value: number; risk: "very-low" }> = [];

  const bankDepositBreakdown = {
    sourceKey: `circle:${coinType}:bank-deposits`,
    unit: coinType === "eurc" ? "EUR-million" : "USD-billion",
    sifi: 0,
    other: 0,
  };
  for (const cfg of sliceConfigs) {
    const val = extractAttrValue(canvas, cfg.attr);
    if (val == null) {
      missingAttrs.push(cfg.attr);
      continue;
    }
    // A disclosure row may legitimately read zero (e.g. no overnight repo
    // exposure); it is a valid parse and is simply omitted from the slices
    // below rather than treated as a missing attribute.
    if (cfg.bankCategory) {
      bankDepositBreakdown[cfg.bankCategory] = val;
      continue;
    }
    if (val === 0) continue;
    entries.push({ sourceKey: cfg.sourceKey, name: cfg.label, value: val, risk: "very-low" });
  }

  if (missingAttrs.length > 0) {
    throw htmlLayoutChangedError(
      "circle-transparency",
      `missing reserve attributes for ${coinType}: ${missingAttrs.join(", ")}`,
    );
  }

  // The examination discloses aggregate bank cash, not institution shares.
  // Keep the weekly split contextual and join one conservative bank domain.
  const bankValue = bankDepositBreakdown.sifi + bankDepositBreakdown.other;
  if (bankValue > 0) {
    entries.push({
      sourceKey: bankDepositBreakdown.sourceKey,
      name: "Cash at Regulated Financial Institutions",
      value: bankValue,
      risk: "very-low",
    });
  }

  const rawValueSum = entries.reduce((sum, entry) => sum + entry.value, 0);
  if (!(rawValueSum > 0)) {
    throw htmlLayoutChangedError(
      "circle-transparency",
      `all reserve attributes for ${coinType} are zero`,
    );
  }
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
      diag: {
        rawSumDeviation: useAbsoluteValues ? 0 : Math.abs(rawValueSum - 100),
        sliceCount: entries.length,
        expectedSliceCount: coinType === "eurc" ? 1 : 3,
        valueMode: useAbsoluteValues ? "absolute" : "percentage",
        rawValueSum,
      },
      coinType,
      bankDepositBreakdown,
      ...freshnessMetadataFromTimestamp(
        sourceTimestamp,
        "html-disclosure",
        "Circle reserve page does not expose a parseable upstream disclosure timestamp in the adapter payload",
      ),
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
