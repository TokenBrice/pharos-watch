import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchPrimaryHtmlInput,
  htmlLayoutChangedError,
  reserveDegradedWarning,
  verifiedFreshnessMetadata,
} from "./helpers";

const ADAPTER_KEY = "ripple-transparency";
const MIN_RESERVE_RATIO = 0.995;

function parseUsdAmount(raw: string): number | null {
  const match = raw.match(/\$\s*([\d,.]+)\s*([KMB])?/i);
  if (!match) return null;
  const base = Number.parseFloat(match[1].replace(/,/g, ""));
  if (!Number.isFinite(base)) return null;
  const suffix = match[2]?.toUpperCase();
  const multiplier = suffix === "B" ? 1_000_000_000 : suffix === "M" ? 1_000_000 : suffix === "K" ? 1_000 : 1;
  return base * multiplier;
}

function parseMmDdYyyy(raw: string | undefined): number | null {
  const match = raw?.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const month = Number.parseInt(match[1], 10);
  const day = Number.parseInt(match[2], 10);
  const year = Number.parseInt(match[3], 10);
  const timestampMs = Date.UTC(year, month - 1, day);
  const date = new Date(timestampMs);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return Math.floor(timestampMs / 1000);
}

export function adaptRippleTransparency(html: string): AdapterResult {
  const normalized = html.replace(/<!--[\s\S]*?-->/g, " ");
  const balanceStart = normalized.indexOf("Total Circulating RLUSD");
  if (balanceStart < 0) {
    throw htmlLayoutChangedError(ADAPTER_KEY, "missing RLUSD balance block");
  }
  const balanceBlock = normalized.slice(balanceStart, balanceStart + 1_500);
  const circulatingMatch = balanceBlock.match(/Total Circulating RLUSD[\s\S]{0,300}?(\$\s*[\d,.]+\s*[KMB]?)/i);
  const reservesMatch = balanceBlock.match(/RLUSD Reserve Funds[\s\S]{0,300}?(\$\s*[\d,.]+\s*[KMB]?)/i);
  const dateMatch = balanceBlock.match(/\bAs of\s*(\d{1,2}\/\d{1,2}\/\d{4})\b/i);

  const circulatingUsd = parseUsdAmount(circulatingMatch?.[1] ?? "");
  const reservesUsd = parseUsdAmount(reservesMatch?.[1] ?? "");
  const sourceTimestamp = parseMmDdYyyy(dateMatch?.[1]);
  if (circulatingUsd == null || reservesUsd == null || sourceTimestamp == null) {
    throw htmlLayoutChangedError(ADAPTER_KEY, "missing circulating supply, reserve funds, or source date");
  }

  const collateralizationRatio = reservesUsd / circulatingUsd;
  const warnings: LiveReserveWarning[] = [];
  if (collateralizationRatio < MIN_RESERVE_RATIO) {
    warnings.push(reserveDegradedWarning(
      "reserve-undercollateralized",
      `Ripple RLUSD reserves cover ${(collateralizationRatio * 100).toFixed(2)}% of circulating supply`,
    ));
  }

  return {
    slices: [
      {
        name: "U.S. dollars and other cash equivalents",
        pct: 100,
        risk: "very-low",
      },
    ],
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      circulatingUsd,
      reservesUsd,
      collateralizationRatio,
      ...verifiedFreshnessMetadata(sourceTimestamp),
    },
  };
}

export async function fetchRippleTransparencyReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const html = await fetchPrimaryHtmlInput(config, ADAPTER_KEY, signal, ctx);
  return adaptRippleTransparency(html);
}
