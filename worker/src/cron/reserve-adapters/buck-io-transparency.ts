import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchPrimaryHtmlInput,
  htmlLayoutChangedError,
  parseTimestampLikeToUnixSeconds,
  slicesFromValues,
  unverifiedFreshnessMetadata,
  verifiedFreshnessMetadata,
} from "./helpers";

/**
 * Parse a dollar amount like "$150.00K" / "$1.20M" / "$650.00" into a Number.
 * Returns null for unparseable / non-positive values.
 */
function parseDollarAmount(raw: string): number | null {
  const cleaned = raw.trim().replace(/[$,\s]/g, "");
  // eslint-disable-next-line security/detect-unsafe-regex -- anchored number pattern with a single optional suffix; no ambiguous alternation or backtracking risk.
  const match = cleaned.match(/^([0-9]+(?:\.[0-9]+)?)([KMB])?$/i);
  if (!match) return null;
  const base = Number.parseFloat(match[1]);
  if (!Number.isFinite(base) || base <= 0) return null;
  const suffix = match[2]?.toUpperCase();
  const multiplier = suffix === "K" ? 1_000 : suffix === "M" ? 1_000_000 : suffix === "B" ? 1_000_000_000 : 1;
  return base * multiplier;
}

function extractLabeledAmount(html: string, label: string): number | null {
  // Capture the value <span> immediately following a "<label>" span.
  // The Buck transparency page emits:
  //   <span class="font-light">USDC in reserves</span>
  //   <span class="font-[350] text-black">$150.00K</span>
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // eslint-disable-next-line security/detect-non-literal-regexp -- label is adapter-owned and escaped.
  const re = new RegExp(
    `<span[^>]*>\\s*${escapedLabel}\\s*</span>\\s*<span[^>]*>\\s*([^<]+?)\\s*</span>`,
    "i",
  );
  const match = html.match(re);
  if (!match) return null;
  return parseDollarAmount(match[1]);
}

function extractLabeledText(html: string, label: string): string | null {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // eslint-disable-next-line security/detect-non-literal-regexp -- label is adapter-owned and escaped.
  const re = new RegExp(
    `<span[^>]*>\\s*${escapedLabel}\\s*</span>\\s*<span[^>]*>\\s*([^<]+?)\\s*</span>`,
    "i",
  );
  const match = html.match(re);
  return match?.[1]?.trim() ?? null;
}

export function adaptBuckIoTransparency(html: string): AdapterResult {
  const usdcUsd = extractLabeledAmount(html, "USDC in reserves");
  const strcUsd = extractLabeledAmount(html, "STRC in reserves");

  const missing: string[] = [];
  if (usdcUsd == null) missing.push("USDC in reserves");
  if (strcUsd == null) missing.push("STRC in reserves");
  if (missing.length > 0) {
    throw htmlLayoutChangedError(
      "buck-io-transparency",
      `missing reserve amounts: ${missing.join(", ")}`,
    );
  }

  const lastUpdatedRaw = extractLabeledText(html, "Last updated");
  const sourceTimestamp = parseTimestampLikeToUnixSeconds(lastUpdatedRaw);

  const slices = slicesFromValues([
    {
      name: "USDC liquidity reserve",
      value: usdcUsd as number,
      risk: "low",
      coinId: "usdc-circle",
    },
    {
      name: "Strategy Inc. perpetual preferred stock (STRC, BTC-backed)",
      value: strcUsd as number,
      risk: "medium",
    },
  ]);

  return {
    slices,
    metadata: {
      sliceCount: slices.length,
      ...(lastUpdatedRaw ? { lastUpdated: lastUpdatedRaw } : {}),
      ...(sourceTimestamp != null
        ? verifiedFreshnessMetadata(sourceTimestamp)
        : unverifiedFreshnessMetadata(
            "html-disclosure",
            "Buck transparency page did not expose a parseable 'Last updated' timestamp",
          )),
      redemption: {
        capacityKind: "documented-bound" as const,
        freshnessKind: sourceTimestamp != null ? "verified-source-timestamp" as const : "unverified" as const,
        ...(sourceTimestamp != null ? { sourceTimestamp } : {}),
        routeStatus: "unknown" as const,
        holderEligibility: "verified-customer",
      },
    },
  };
}

export async function fetchBuckIoTransparencyReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const html = await fetchPrimaryHtmlInput(config, "buck-io-transparency", signal, ctx);
  return adaptBuckIoTransparency(html);
}
