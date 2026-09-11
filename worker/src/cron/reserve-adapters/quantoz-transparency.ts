import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchPrimaryHtmlInput,
  htmlLayoutChangedError,
  parseTimestampLikeToUnixSeconds,
  PCT_SUM_ERROR_TOLERANCE,
  reserveDegradedWarning,
  reserveInfoWarning,
  slicesFromPercentages,
  stripTags,
  verifiedFreshnessMetadata,
} from "./helpers";

const ADAPTER_KEY = "quantoz-transparency";
const MIN_RESERVE_RATIO_PCT = 99.5;
/**
 * The transparency table publishes whole-number percentages (e.g. `33% / 66%`) and no
 * absolute amount per category, so each of the N allocation categories can carry up to
 * half a point of rounding error and a genuine 100% split can still sum to 100 ± N × 0.5.
 * Quantoz shows N = 2, so 99/101 is rounding while anything wider is a real inconsistency
 * in the source: only that wider drift is forwarded to the shared percentage-sum gate as
 * upstream noise.
 */
const INTEGER_PERCENT_ROUNDING_PCT = 0.5;

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

  const allocationPcts = [cashPct, governmentBondPct];
  const publishedAllocationSumPct = cashPct + governmentBondPct;
  const rawSumDeviation = Math.abs(publishedAllocationSumPct - 100);
  const roundingEnvelopePct = allocationPcts.length * INTEGER_PERCENT_ROUNDING_PCT;
  const withinRoundingEnvelope = rawSumDeviation <= roundingEnvelopePct;

  const warnings: LiveReserveWarning[] = [];
  if (reserveRatioPct < MIN_RESERVE_RATIO_PCT) {
    warnings.push(reserveDegradedWarning(
      "reserve-undercollateralized",
      `Quantoz ${token} reserve ratio is ${reserveRatioPct.toFixed(2)}%`,
    ));
  }
  if (withinRoundingEnvelope && rawSumDeviation > 0) {
    warnings.push(reserveInfoWarning(
      "published-percentages-rounded",
      `Quantoz ${token} cash/bond allocation is published as whole-number percentages and sums to `
        + `${publishedAllocationSumPct.toFixed(0)}% (within the ${roundingEnvelopePct.toFixed(1)} point rounding `
        + `envelope for ${allocationPcts.length} categories)`,
    ));
  }

  return {
    // The shared 1.5% default tolerance would reject drift this source can still repair
    // by normalization; the shared percentage-sum gate owns the verdict band instead, so
    // the adapter fails closed only past that gate's own error tolerance.
    slices: slicesFromPercentages([
      { sourceKey: "quantoz-transparency:cash", name: "Cash deposits at Tier 1 European banks", pct: cashPct, risk: "very-low" },
      { sourceKey: "quantoz-transparency:government-bonds", name: "Government bonds (Netherlands, Germany, and US)", pct: governmentBondPct, risk: "very-low" },
    ], { context: `Quantoz ${token} reserve allocation`, tolerancePct: PCT_SUM_ERROR_TOLERANCE }),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      diag: {
        // Upstream drift is forwarded to the shared percentage-sum gate only when it
        // exceeds the rounding envelope this source is known to produce.
        ...(withinRoundingEnvelope ? {} : { rawSumDeviation }),
        roundingEnvelopePct,
        publishedAllocationSumPct,
      },
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
