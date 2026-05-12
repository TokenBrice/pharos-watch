import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchPrimaryHtmlInput,
  htmlLayoutChangedError,
  parseTimestampLikeToUnixSeconds,
  reserveDegradedWarning,
  slicesFromPercentages,
  verifiedFreshnessMetadata,
} from "./helpers";

const ADAPTER_KEY = "quantoz-transparency";
const MIN_RESERVE_RATIO_PCT = 99.5;

function stripTags(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#xA0;|\u00a0/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function parseLocalizedNumber(raw: string): number | null {
  const cleaned = raw
    .replace(/[€$£,\s]/g, (char) => (char === "," ? "," : ""))
    .replace(/[^\d.,-]/g, "");
  if (!cleaned) return null;
  const dotCount = (cleaned.match(/\./g) ?? []).length;
  const normalized = cleaned.includes(",")
    ? cleaned.replace(/\./g, "").replace(",", ".")
    : dotCount > 1
      ? cleaned.replace(/\./g, "")
    : cleaned.replace(/,/g, "");
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractQuantozTimestamp(html: string): number {
  const match = html.match(/\bUPDATED:\s*([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,\s*(\d{4})\b/i);
  const timestamp = parseTimestampLikeToUnixSeconds(match ? `${match[1]} ${match[2]}, ${match[3]}` : undefined);
  if (timestamp == null) {
    throw htmlLayoutChangedError(ADAPTER_KEY, "missing or unreadable update timestamp");
  }
  return timestamp;
}

function extractTokenRow(html: string, token: string): string {
  const tableStart = html.indexOf("Reserve Status Overview");
  if (tableStart < 0) {
    throw htmlLayoutChangedError(ADAPTER_KEY, "missing reserve status table");
  }
  const table = html.slice(tableStart);
  const tokenIndex = table.indexOf(`>${token}<`);
  if (tokenIndex < 0) {
    throw htmlLayoutChangedError(ADAPTER_KEY, `missing ${token} reserve row`);
  }
  const rowStart = table.lastIndexOf('<div role="row"', tokenIndex);
  if (rowStart < 0) {
    throw htmlLayoutChangedError(ADAPTER_KEY, `missing ${token} row start`);
  }
  const nextRow = table.indexOf('<div role="row"', tokenIndex + token.length);
  return table.slice(rowStart, nextRow < 0 ? table.length : nextRow);
}

export function adaptQuantozTransparency(html: string, token: string): AdapterResult {
  const sourceTimestamp = extractQuantozTimestamp(html);
  const rowText = stripTags(extractTokenRow(html, token));
  const supplyMatch = rowText.match(/[€$]\s*[\d.,]+/);
  const percentValues = rowText
    .split("%")
    .slice(0, -1)
    .map((segment) => parseLocalizedNumber(segment.trim().split(/\s+/).pop() ?? ""))
    .filter((value): value is number => value != null);

  const totalSupply = supplyMatch ? parseLocalizedNumber(supplyMatch[0]) : null;
  const [reserveRatioPct, cashPct, governmentBondPct] = percentValues;

  if (totalSupply == null || reserveRatioPct == null || cashPct == null || governmentBondPct == null) {
    throw htmlLayoutChangedError(ADAPTER_KEY, `missing ${token} supply, reserve ratio, or allocation values`);
  }

  const warnings: LiveReserveWarning[] = [];
  if (reserveRatioPct < MIN_RESERVE_RATIO_PCT) {
    warnings.push(reserveDegradedWarning(
      "reserve-undercollateralized",
      `Quantoz ${token} reserve ratio is ${reserveRatioPct.toFixed(2)}%`,
    ));
  }

  return {
    slices: slicesFromPercentages([
      { name: "Cash deposits at Tier 1 European banks", pct: cashPct, risk: "very-low" },
      { name: "Government bonds (Netherlands, Germany, and US)", pct: governmentBondPct, risk: "very-low" },
    ], { context: `Quantoz ${token} reserve allocation` }),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      token,
      totalSupply,
      reserveRatioPct,
      cashPct,
      governmentBondPct,
      ...verifiedFreshnessMetadata(sourceTimestamp),
    },
  };
}

export async function fetchQuantozTransparencyReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const html = await fetchPrimaryHtmlInput(config, ADAPTER_KEY, signal, ctx);
  const { token } = parseLiveReserveAdapterParams(ADAPTER_KEY, config.params);
  return adaptQuantozTransparency(html, token);
}
