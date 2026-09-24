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
 * The transparency cards publish whole-number percentages (`Cash 33%`,
 * `Government bonds 66%`) and no absolute amount per category, so each of the N
 * allocation categories can carry up to half a point of rounding error and a
 * genuine 100% split can still sum to 100 ± N × 0.5. Quantoz shows N = 2, so
 * 99/101 is rounding while anything wider is a real inconsistency in the
 * source: only that wider drift is forwarded to the shared percentage-sum gate
 * as upstream noise.
 */
const INTEGER_PERCENT_ROUNDING_PCT = 0.5;
/**
 * The redesigned page (live 2026-09-24) dates the figures in the
 * "Published snapshot <time datetime="…">" heading, replacing the old
 * `UPDATED: Month Dth, YYYY` tagline. Anchoring on the heading label keeps an
 * unrelated `<time>` elsewhere on the page from standing in for the reserve
 * snapshot date.
 */
const SNAPSHOT_TIMESTAMP_RE = /Published snapshot\b[\s\S]{0,200}?<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/i;
const CIRCULATION_LABEL = "Tokens in circulation";
const RESERVE_RATIO_LABEL = "Reserve ratio";
/**
 * Composition categories the adapter maps to reserve slices. The page is
 * expected to publish exactly this set: a card that adds or drops a category
 * fails closed instead of silently omitting backing from the published mix.
 */
const COMPOSITION_LABELS = ["Cash", "Government bonds"] as const;

/**
 * The redesigned cards publish US-formatted numbers (`€4,302,714`,
 * `100.76%`), so grouping commas are stripped and the remaining shape is
 * validated strictly: anything else is a layout change, not a number to guess
 * at.
 */
function parsePublishedNumber(raw: string): number | null {
  const cleaned = stripTags(raw).replace(/[€$£\s]/g, "");
  const [integerPart, fractionPart, ...extra] = cleaned.split(".");
  if (extra.length > 0 || integerPart == null) return null;
  const [leadGroup, ...thousandGroups] = integerPart.replace(/^-/, "").split(",");
  if (!/^\d+$/.test(leadGroup ?? "")) return null;
  if (thousandGroups.length > 0 && (leadGroup!.length > 3 || !thousandGroups.every((group) => /^\d{3}$/.test(group)))) {
    return null;
  }
  if (fractionPart != null && !/^\d+$/.test(fractionPart)) return null;
  const parsed = Number.parseFloat(cleaned.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function extractQuantozTimestamp(html: string): number {
  const match = html.match(SNAPSHOT_TIMESTAMP_RE);
  const timestamp = parseTimestampLikeToUnixSeconds(match?.[1]);
  if (timestamp == null) {
    throw htmlLayoutChangedError(ADAPTER_KEY, "missing or unreadable update timestamp");
  }
  return timestamp;
}

/**
 * `<dt>label</dt><dd>value</dd>` pairs from a token card, read by visible label
 * text so attribute/class churn does not break the extraction. `dt` cells embed
 * icons, so the matcher spans everything between the opening tag and `</dt>`.
 */
function extractDefinedValuePairs(html: string): Array<{ label: string; value: string }> {
  const pairs: Array<{ label: string; value: string }> = [];
  for (const match of html.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi)) {
    pairs.push({ label: stripTags(match[1] ?? ""), value: stripTags(match[2] ?? "") });
  }
  return pairs;
}

/**
 * The token card is the `<article>` whose `<h3>` names the requested token,
 * identified by content rather than by id/class so a styling-only redesign
 * keeps working while a structural change fails closed.
 */
function extractTokenCard(html: string, token: string): string {
  for (const match of html.matchAll(/<article\b[^>]*>[\s\S]*?<\/article>/gi)) {
    const heading = match[0].match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i);
    if (heading && stripTags(heading[1] ?? "").toUpperCase() === token.toUpperCase()) {
      return match[0];
    }
  }
  throw htmlLayoutChangedError(ADAPTER_KEY, `missing ${token} reserve card`);
}

function parseLabeledPercentage(raw: string | null, label: string): number {
  const match = raw?.match(/^([\d.,-]+)\s*%$/);
  const value = match ? parsePublishedNumber(match[1] ?? "") : null;
  if (value == null) {
    throw htmlLayoutChangedError(ADAPTER_KEY, `missing or malformed ${label} column`);
  }
  return value;
}

function parseCompositionPercentages(
  pairs: Array<{ label: string; value: string }>,
): [cashPct: number, governmentBondPct: number] {
  const entries = pairs
    .filter((pair) => pair.label.toLowerCase() !== RESERVE_RATIO_LABEL.toLowerCase())
    .flatMap((pair) => {
      const match = pair.value.match(/^([\d.,-]+)\s*%$/);
      return match ? [{ label: pair.label, pct: parsePublishedNumber(match[1] ?? "") }] : [];
    });
  const labels = entries.map((entry) => entry.label.toLowerCase()).sort();
  const expected = COMPOSITION_LABELS.map((label) => label.toLowerCase()).sort();
  if (labels.length !== expected.length || labels.some((label, index) => label !== expected[index])) {
    throw htmlLayoutChangedError(ADAPTER_KEY, "missing, reordered, or extra reserve-composition percentages");
  }
  const cashPct = entries.find((entry) => entry.label.toLowerCase() === "cash")?.pct;
  const governmentBondPct = entries.find((entry) => entry.label.toLowerCase() === "government bonds")?.pct;
  if (cashPct == null || governmentBondPct == null) {
    throw htmlLayoutChangedError(ADAPTER_KEY, "missing or malformed reserve-composition percentages");
  }
  return [cashPct, governmentBondPct];
}

export function adaptQuantozTransparency(html: string, token: string): AdapterResult {
  const sourceTimestamp = extractQuantozTimestamp(html);
  const card = extractTokenCard(html, token);
  const pairs = extractDefinedValuePairs(card);
  const totalSupply = parsePublishedNumber(
    pairs.find((pair) => pair.label.toLowerCase() === CIRCULATION_LABEL.toLowerCase())?.value ?? "",
  );
  const reserveRatioPct = parseLabeledPercentage(
    pairs.find((pair) => pair.label.toLowerCase() === RESERVE_RATIO_LABEL.toLowerCase())?.value ?? null,
    "reserve ratio",
  );
  const [cashPct, governmentBondPct] = parseCompositionPercentages(pairs);

  if (totalSupply == null) {
    throw htmlLayoutChangedError(ADAPTER_KEY, `missing or malformed ${token} total-supply column`);
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
