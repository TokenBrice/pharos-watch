import type { LiveReservesConfig, StablecoinMeta } from "@shared/types";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchTextWithRetry,
  getAdapterTimeout,
  requireHtmlInput,
  slicesFromPercentages,
  slicesFromValues,
} from "./helpers";

interface CircleSliceConfig {
  attr: string;
  label: string;
}

const CIRCLE_AMOUNT_MODE_MAX_RELATIVE_DIFF = 0.1;

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
    throw new Error(
      `circle-transparency: missing reserve attributes for ${coinType}: ${missingAttrs.join(", ")}`,
    );
  }

  const rawValueSum = entries.reduce((sum, entry) => sum + entry.value, 0);
  const displayAmount = extractDisplayAmount(html, coinType);
  const useAbsoluteValues = displayAmount != null
    && displayAmount > 0
    && Math.abs(rawValueSum - displayAmount) / Math.max(rawValueSum, displayAmount) <= CIRCLE_AMOUNT_MODE_MAX_RELATIVE_DIFF;

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
      freshnessMode: "unverified",
      valueMode: useAbsoluteValues ? "absolute" : "percentage",
      rawValueSum,
      ...(displayAmount != null ? { displayAmount } : {}),
    },
  };
}

export async function fetchCircleReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireHtmlInput(config.inputs.primary, "circle-transparency");
  const html = await fetchTextWithRetry(
    input.url,
    signal,
    getAdapterTimeout(config, 15_000),
    ctx,
  );
  const params = config.params as Record<string, unknown> | undefined;
  const coinType = String(params?.coinType ?? "usdc");
  if (coinType !== "usdc" && coinType !== "eurc") {
    throw new Error(`circle-transparency: invalid coinType "${coinType}", expected "usdc" or "eurc"`);
  }
  return adaptCircleTransparency(html, coinType);
}
