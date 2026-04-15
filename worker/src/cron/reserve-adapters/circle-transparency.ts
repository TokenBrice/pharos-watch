import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchPrimaryHtmlInput,
  htmlLayoutChangedError,
  parseTimestampLikeToUnixSeconds,
  slicesFromPercentages,
  slicesFromValues,
  unverifiedFreshnessMetadata,
  verifiedFreshnessMetadata,
} from "./helpers";

interface CircleSliceConfig {
  attr: string;
  label: string;
}

const CIRCLE_ABSOLUTE_MODE_MAX_RELATIVE_DIFF = 0.03;
const CIRCLE_PERCENT_MODE_TOLERANCE_PCT = 2;

const USDC_SLICES: CircleSliceConfig[] = [
  { attr: "data-usdc-us-treasuries", label: "<3-Month U.S. Treasuries" },
  { attr: "data-usdc-months", label: "Deposits at Systemically Important Institutions" },
  { attr: "data-usdc-cash", label: "Other Bank Deposits" },
  { attr: "data-usdc-in-circulation", label: "Overnight Reverse Treasury Repo" },
];

const EURC_SLICES: CircleSliceConfig[] = [
  { attr: "data-eurocoin-cash", label: "Other Bank Deposits" },
  { attr: "data-eurocoin-tokens", label: "Deposits at Systemically Important Institutions" },
];

function extractAttrValue(html: string, attr: string): number | null {
  // Match data-attr="value" or data-attr='value' with optional whitespace around "=".
  // eslint-disable-next-line security/detect-non-literal-regexp -- attr is selected from adapter-owned config constants.
  const re = new RegExp(`${attr}\\s*=\\s*["']([\\d.]+)["']`, "i");
  const m = html.match(re);
  if (!m) return null;
  const val = parseFloat(m[1]);
  return Number.isFinite(val) && val > 0 ? val : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractTagById(html: string, id: string): string | null {
  const escapedId = escapeRegExp(id);
  // eslint-disable-next-line security/detect-non-literal-regexp -- id is selected from adapter-owned constants and escaped before interpolation.
  const re = new RegExp(`<[^>]*\\sid\\s*=\\s*["']${escapedId}["'][^>]*>`, "i");
  return html.match(re)?.[0] ?? null;
}

function extractDisplayAmount(html: string, coinType: string): number | null {
  const displayId = coinType === "eurc" ? "euro-in-circulation" : "usdc-in-circulation";
  const tag = extractTagById(html, displayId);
  return tag ? extractAttrValue(tag, "data-point") : null;
}

function extractDisclosureTimestamp(html: string): number | null {
  const match = html.match(/\bAs of\s+([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})\b/i);
  return parseTimestampLikeToUnixSeconds(match?.[1]);
}

export function adaptCircleTransparency(html: string, coinType: string): AdapterResult {
  const sliceConfigs = coinType === "eurc" ? EURC_SLICES : USDC_SLICES;
  const missingAttrs: string[] = [];

  const entries: Array<{ name: string; value: number; risk: "very-low" }> = [];

  for (const cfg of sliceConfigs) {
    const val = extractAttrValue(html, cfg.attr);
    if (val == null) {
      missingAttrs.push(cfg.attr);
      continue;
    }
    entries.push({ name: cfg.label, value: val, risk: "very-low" });
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
  const sourceTimestamp = extractDisclosureTimestamp(html);

  const slices = useAbsoluteValues
    ? slicesFromValues(
      entries.map((entry) => ({
        name: entry.name,
        value: entry.value,
        risk: entry.risk,
      })),
      1,
    )
    : slicesFromPercentages(
      entries.map((entry) => ({
        name: entry.name,
        pct: entry.value,
        risk: entry.risk,
      })),
      { context: `Circle ${coinType.toUpperCase()} reserve composition` },
    );

  return {
    slices,
    metadata: {
      coinType,
      sliceCount: entries.length,
      expectedSliceCount: sliceConfigs.length,
      ...(sourceTimestamp != null
        ? verifiedFreshnessMetadata(sourceTimestamp)
        : unverifiedFreshnessMetadata(
            "html-disclosure",
            "Circle reserve page does not expose a parseable upstream disclosure timestamp in the adapter payload",
          )),
      valueMode: useAbsoluteValues ? "absolute" : "percentage",
      rawValueSum,
      ...(displayAmount != null ? { displayAmount } : {}),
      ...(displayAmountRelativeDiff != null ? { displayAmountRelativeDiff } : {}),
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
