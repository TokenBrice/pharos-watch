import mechanismReviewOverlays from "@shared/data/safety-score-v9/mechanism-review-overlays-v1.json";
import type { MechanismArchetype } from "@shared/types";

/**
 * Build-time extraction of the reviewed backing metrics the CDP collateral rail
 * does not serve. Import this module only from server components: the overlay
 * file is ~1 MB and must never enter a client bundle — pages pass the slim view
 * object below as a prop instead, the same pattern as `mechanism-review.ts`.
 *
 * CDP is deliberately absent: `mechanism-collateralization.ts` already owns that
 * cohort and prefers a live reserve-feed ratio this view has no access to.
 *
 * Per-dimension quality ratings stay internal (owner decision, 2026-07-28), so
 * this view reads `applicability` and never `quality`. The reviewer rationale
 * behind a not-applicable or undisclosed dimension is not part of that ruling —
 * it explains a gap rather than publishing a rating.
 */

export type MechanismBackingUnit = "percent" | "days";

export interface MechanismBackingMetric {
  key: string;
  label: string;
  value: number;
  unit: MechanismBackingUnit;
  /** One-line reading of what the number measures. */
  hint: string;
}

export interface MechanismBackingProtocolFact {
  key: string;
  label: string;
  /** Preformatted: these are protocol-specific units with no shared scale. */
  value: string;
}

export interface MechanismBackingNote {
  key: string;
  label: string;
  /** `not-applicable` is a structural ruling; `unavailable` is an evidence gap. */
  state: "not-applicable" | "unavailable";
  rationale: string;
  sourceUrl: string | null;
}

export interface MechanismBackingView {
  archetype: MechanismArchetype;
  /** ISO date the evidence was pinned. */
  reviewedAt: string;
  /** Leading metric first; empty when every metric was ruled out or unmeasured. */
  metrics: MechanismBackingMetric[];
  /** Protocol-specific figures read straight from the protocol's own state. */
  protocolFacts: MechanismBackingProtocolFact[];
  notes: MechanismBackingNote[];
  sourceLabel: string;
  sourceUrl: string;
}

interface MetricSpec {
  key: string;
  label: string;
  unit: MechanismBackingUnit;
  hint: string;
  /** Overlay values already denominated in percent are not rescaled. */
  alreadyPercent?: boolean;
}

/**
 * Ordered per archetype: the first metric that resolves to a number leads the
 * card. Keys and archetype membership mirror `OVERLAY_ARCHETYPE_METRICS` in
 * `worker/src/lib/safety-score-v9-extension-mechanism.ts`.
 */
const METRIC_SPECS: Partial<Record<MechanismArchetype, readonly MetricSpec[]>> = {
  "synthetic-delta-neutral": [
    {
      key: "hedgeCoverageRatio",
      label: "Hedge coverage",
      unit: "percent",
      hint: "Share of the collateral position covered by an offsetting short hedge.",
    },
    {
      key: "marginBufferPct",
      label: "Margin buffer",
      unit: "percent",
      alreadyPercent: true,
      hint: "Margin held above the maintenance requirement on the hedging venues.",
    },
    {
      key: "lossAbsorptionShare",
      label: "Loss absorption",
      unit: "percent",
      hint: "Capital committed to absorb losses before holders, as a share of supply.",
    },
  ],
  "rwa-credit-fund": [
    {
      key: "weightedAverageMaturityDays",
      label: "Weighted average maturity",
      unit: "days",
      hint: "Average time to maturity across the loan book, weighted by size.",
    },
    {
      key: "valuationCadenceDays",
      label: "Valuation cadence",
      unit: "days",
      hint: "How often the underlying assets are repriced.",
    },
  ],
  algorithmic: [
    {
      key: "exogenousBackingShare",
      label: "Exogenous backing",
      unit: "percent",
      hint: "Share of backing held in assets independent of the protocol's own token.",
    },
    {
      key: "reflexiveBackingShare",
      label: "Reflexive backing",
      unit: "percent",
      hint: "Share of backing that depends on the protocol's own token holding value.",
    },
    {
      key: "contractionCapacityRatio",
      label: "Contraction capacity",
      unit: "percent",
      hint: "Capacity to retire supply during a contraction, as a share of supply.",
    },
  ],
};

interface OverlayComponentShape {
  applicability?: string;
  rationale?: string;
  sourceUrl?: string;
}

interface OverlayEntryShape {
  assetId: string;
  archetype: string;
  reviewedAt: string;
  sources: Array<{ label: string; url: string }>;
  metrics: Record<string, number | null>;
  analogousMetrics?: Record<string, number | null>;
  metricApplicability?: Record<string, { state: string; rationale?: string; sourceUrl?: string }>;
  components?: Record<string, OverlayComponentShape>;
}

const OVERLAYS_BY_ASSET_ID: ReadonlyMap<string, OverlayEntryShape> = new Map(
  (mechanismReviewOverlays.overlays as unknown as OverlayEntryShape[]).map((overlay) => [overlay.assetId, overlay]),
);

/** `custodyContinuity` -> `Custody continuity`. */
function humanizeComponentKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Protocol-fact keys are author-chosen and long-tailed — 200-odd distinct names
 * across 77 assets, most appearing once — so they are humanized rather than
 * mapped. Ticker and acronym segments must survive that pass in upper case, or
 * `hlAccountValueUsd` reads as "Hl account value usd".
 */
const FACT_ACRONYMS = new Set([
  // Units and role acronyms.
  "usd", "eur", "nav", "tvl", "apr", "apy", "lp", "psm", "gsm", "hsm", "dex", "mev", "cex", "cme",
  "fx", "ltv", "mcr", "scr", "vat", "vow", "erc", "amm", "ntt", "ccip", "hl", "bsc", "aa", "jr", "sr",
  // Asset and protocol tickers that appear in authored fact keys. Extracted
  // from the overlay rather than guessed; a ticker missing here degrades to
  // title case, which reads oddly but never wrong.
  "usdc", "usdt", "usde", "usds", "usdh", "usdp", "usg", "usn", "usx", "dai", "gho", "mim", "dola",
  "bold", "btc", "eth", "weth", "wbtc", "sol", "ada", "sui", "zsd", "zys", "fusd", "yusd", "xtusd",
  "savusd", "luausd", "lua", "wxt", "uscc", "ustb", "fxsp", "sirs", "djed", "shen", "crvusd",
  "usdxl", "usdt0", "apxusd", "nxusd", "cusd", "iusd", "pht", "gigahdx",
]);

function humanizeFactKey(key: string): string {
  // `formatFactValue` already renders these units into the value, so leaving
  // them on the label prints "Supply debt divergence pct — 2.04%".
  const words = key
    .replace(/(Usd|USD|Pct|Days)$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean);
  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (FACT_ACRONYMS.has(lower)) return lower.toUpperCase();
      if (index === 0) return word.charAt(0).toUpperCase() + word.slice(1);
      return lower;
    })
    .join(" ");
}

function formatFactValue(key: string, value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (/(Usd|USD)$/.test(key)) {
    // Sign leads the currency mark: "-$9.7M", never "$-9.7M".
    const sign = value < 0 ? "-" : "";
    const size = Math.abs(value);
    if (size >= 1_000_000_000) return `${sign}$${(size / 1_000_000_000).toFixed(2)}B`;
    if (size >= 1_000_000) return `${sign}$${(size / 1_000_000).toFixed(1)}M`;
    if (size >= 1_000) return `${sign}$${(size / 1_000).toFixed(1)}K`;
    return `${sign}$${size.toFixed(2)}`;
  }
  if (/(Share|Pct)$/.test(key)) {
    const pct = /Pct$/.test(key) ? value : value * 100;
    return `${pct < 1 ? pct.toFixed(2) : pct.toFixed(1)}%`;
  }
  if (/Days$/.test(key)) return `${value < 10 ? value.toFixed(1) : Math.round(value)}d`;
  if (/Count$/.test(key)) return Math.round(value).toLocaleString("en-US");
  if (Math.abs(value) >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return Math.round(value).toLocaleString("en-US");
  return value < 10 ? value.toFixed(3).replace(/\.?0+$/, "") : value.toFixed(1);
}

/** A rail column cannot carry eleven rows; the longest tails are truncated. */
const MAX_PROTOCOL_FACTS = 6;

function noteState(state: string | undefined): MechanismBackingNote["state"] | null {
  if (state === "not-applicable") return "not-applicable";
  if (state === "unavailable") return "unavailable";
  return null;
}

export function buildMechanismBackingView(assetId: string): MechanismBackingView | null {
  const overlay = OVERLAYS_BY_ASSET_ID.get(assetId);
  if (!overlay) return null;
  const source = overlay.sources[0];
  if (!source) return null;

  const archetype = overlay.archetype as MechanismArchetype;
  const metrics: MechanismBackingMetric[] = [];
  for (const spec of METRIC_SPECS[archetype] ?? []) {
    const raw = overlay.metrics[spec.key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    metrics.push({
      key: spec.key,
      label: spec.label,
      value: spec.unit === "percent" && !spec.alreadyPercent ? raw * 100 : raw,
      unit: spec.unit,
      hint: spec.hint,
    });
  }

  const protocolFacts: MechanismBackingProtocolFact[] = [];
  for (const [key, raw] of Object.entries(overlay.analogousMetrics ?? {})) {
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    if (protocolFacts.length >= MAX_PROTOCOL_FACTS) break;
    protocolFacts.push({ key, label: humanizeFactKey(key), value: formatFactValue(key, raw) });
  }

  const notes: MechanismBackingNote[] = [];
  for (const [key, applicability] of Object.entries(overlay.metricApplicability ?? {})) {
    const state = noteState(applicability.state);
    if (state === null || !applicability.rationale) continue;
    const spec = (METRIC_SPECS[archetype] ?? []).find((candidate) => candidate.key === key);
    notes.push({
      key: `metric:${key}`,
      label: spec?.label ?? humanizeComponentKey(key),
      state,
      rationale: applicability.rationale,
      sourceUrl: applicability.sourceUrl ?? null,
    });
  }
  for (const [key, component] of Object.entries(overlay.components ?? {})) {
    const state = noteState(component.applicability);
    if (state === null || !component.rationale) continue;
    notes.push({
      key: `component:${key}`,
      label: humanizeComponentKey(key),
      state,
      rationale: component.rationale,
      sourceUrl: component.sourceUrl ?? null,
    });
  }

  // Nothing to add beyond what the review panel and collateral rail already say.
  if (metrics.length === 0 && protocolFacts.length === 0 && notes.length === 0) return null;

  return {
    archetype,
    reviewedAt: overlay.reviewedAt,
    metrics,
    protocolFacts,
    notes,
    sourceLabel: source.label,
    sourceUrl: source.url,
  };
}
