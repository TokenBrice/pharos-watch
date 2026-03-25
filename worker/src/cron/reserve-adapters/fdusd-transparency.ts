import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchTextWithRetry,
  getAdapterTimeout,
  htmlLayoutChangedError,
  parseTimestampLikeToUnixSeconds,
  requireHtmlInput,
  slicesFromPercentages,
} from "./helpers";

const FDUSD_LABEL_MAP: Record<string, string> = {
  "US Treasury Bills": "U.S. Treasury Bills",
  Cash: "Cash",
  "Bank Deposits": "Bank Deposits",
  "Reverse Repos": "Overnight Reverse Repos",
};

function parseFdusdAsOf(html: string): string | null {
  const match = html.match(
    /<div class="chart-date">\s*As of\s*<\/div>\s*<div class="chart-date">\s*([^<]+?)\s*<\/div>/i,
  );
  return match?.[1]?.trim() || null;
}

function parseFdusdEntries(html: string): Array<{ name: string; value: number }> {
  const entries: Array<{ name: string; value: number }> = [];
  const entryRegex =
    /<div role="listitem" class="chart-badge w-dyn-item">[\s\S]*?<div>([^<]+)<\/div>[\s\S]*?<div class="percent-value">([^<]+)<\/div>/gi;

  for (const match of html.matchAll(entryRegex)) {
    const rawName = match[1]?.trim();
    const rawValue = Number.parseFloat(match[2] ?? "");
    if (!rawName || !Number.isFinite(rawValue) || rawValue <= 0) {
      continue;
    }

    entries.push({
      name: FDUSD_LABEL_MAP[rawName] ?? rawName,
      value: rawValue,
    });
  }

  return entries;
}

export function adaptFdusdTransparency(html: string): AdapterResult {
  const entries = parseFdusdEntries(html);
  if (entries.length === 0) {
    throw htmlLayoutChangedError("fdusd-transparency", "no reserve composition entries found in HTML");
  }

  const asOf = parseFdusdAsOf(html);
  const sourceTimestamp = parseTimestampLikeToUnixSeconds(asOf);

  return {
    slices: slicesFromPercentages(
      entries.map((entry) => ({
        name: entry.name,
        pct: entry.value,
        risk: "very-low" as const,
      })),
      { context: "FDUSD reserve composition" },
    ),
    metadata: {
      sliceCount: entries.length,
      ...(asOf ? { asOf } : {}),
      ...(sourceTimestamp != null ? { sourceTimestamp, freshnessMode: "verified" as const } : { freshnessMode: "unverified" as const }),
    },
  };
}

export async function fetchFdusdTransparencyReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireHtmlInput(config.inputs.primary, "fdusd-transparency");
  const html = await fetchTextWithRetry(
    input.url,
    signal,
    getAdapterTimeout(config, 15_000),
    ctx,
  );
  return adaptFdusdTransparency(html);
}
