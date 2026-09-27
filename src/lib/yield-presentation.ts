import type {
  YieldCalculationMode,
  YieldDecisionReasonCode,
  YieldDecisionRejectionReasonCode,
  YieldEvidenceClass,
  YieldOpportunityClass,
  YieldOpportunityCriticalEvidence,
  YieldPysNullReason,
  YieldRankChangeAttribution,
  YieldScoreQualification,
} from "@shared/types";
import { YIELD_RANK_CHANGE_DRIVER_LABELS } from "@/lib/yield-source-presentation";

export const PYS_NULL_REASON_TEXT: Record<YieldPysNullReason, string> = {
  "apy-non-positive": "30d APY ≤ 0",
  "effective-yield-non-positive": "Effective yield ≤ 0 after benchmark",
  "scaling-invalid": "Scaling factor unavailable",
  "missing-inputs": "Missing inputs",
  "source-stale": "Source observation stale",
  "source-freshness-unknown": "Source observation time unavailable",
  "benchmark-stale": "Benchmark stale",
  "safety-unrated": "Safety evidence not rated",
  "opportunity-evidence-missing": "Opportunity risk evidence missing",
};

export const YIELD_CALCULATION_MODE_LABELS: Record<YieldCalculationMode, string> = {
  "direct-read": "Direct read",
  "exchange-rate-math": "Exchange-rate math",
  "market-api": "Market API",
  "benchmark-model": "Benchmark model",
  "price-return": "Price return",
};

export const YIELD_EVIDENCE_CLASS_LABELS: Record<YieldEvidenceClass, string> = {
  "direct-first-party": "Direct first-party",
  "direct-onchain": "Direct onchain",
  "curated-observation": "Curated observation",
  "discovered-observation": "Discovered observation",
  "modeled-proxy": "Modeled proxy",
  fallback: "Fallback evidence",
};

export const YIELD_SCORE_QUALIFICATION_LABELS: Record<YieldScoreQualification, string> = {
  rated: "Rated",
  estimated: "Estimated",
  partial: "Partial evidence",
  NR: "Not rated",
};

export const YIELD_SOURCE_FACT_LABELS = {
  holder: "Holder yield",
  external: "External opportunity",
  estimated: "Estimated",
  changed: "source changed",
  venue: "Venue",
  priceReturn: "Estimated from price appreciation, not a quoted deposit rate.",
  fallbackLink: "View yield opportunities",
  loading: "Loading yield source details…",
  unavailable: "This source is unavailable in the latest ranking snapshot.",
  loadError: "Yield source details could not be refreshed.",
  sheetTitle: "Yield source details",
  heuristicDrivers: "Heuristic movement context, not a causal score decomposition",
} as const;

export function formatYieldDepositExplanation(symbol: string, venue: string, chain: string): string {
  return `APY from depositing ${symbol} with ${venue} on ${chain}; not yield from simply holding ${symbol}.`;
}

export function formatYieldBenchmarkSpread(spread: number, label: string, rate: number | null): string {
  const reference = `${label}${rate != null ? ` (${rate.toFixed(2)}%)` : ""}`;
  return Math.abs(spread) < 0.005
    ? `within displayed precision of ${reference}`
    : `${Math.abs(spread).toFixed(2)} pp ${spread > 0 ? "above" : "below"} ${reference}`;
}

export function formatYieldBenchmarkSpreadChip(spread: number): string {
  const displayed = Math.abs(spread) < 0.005 ? 0 : spread;
  return `${displayed >= 0 ? "+" : ""}${displayed.toFixed(2)} pp vs benchmark`;
}

export function formatYieldDriverContext(key: string, value: number): string {
  const signed = `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
  if (key === "sourceRisk") return `${signed} multiplier change`;
  if (key === "stablecoinSafety") return `${formatSignedPysDelta(value)} total change (heuristic)`;
  return `${signed} rank places (heuristic)`;
}

export function formatEvidenceCompleteness(value: number): string {
  return `${Math.round(Math.min(1, Math.max(0, value)) * 100)}% evidence`;
}

export const YIELD_OPPORTUNITY_CLASS_LABELS: Record<YieldOpportunityClass, string> = {
  lending: "Lending market",
  "fixed-yield": "Fixed yield",
  "structured-tranche": "Structured tranche",
};

export const YIELD_OPPORTUNITY_EVIDENCE_LABELS: Record<YieldOpportunityCriticalEvidence, string> = {
  "venue-review": "venue review",
  "market-size": "market size",
  "market-status": "market status",
};

export function formatSignedPysDelta(delta: number): string {
  if (!Number.isFinite(delta)) return "";
  const rounded = Math.abs(delta) >= 10 ? delta.toFixed(1) : delta.toFixed(2);
  const sign = delta > 0 ? "+" : delta < 0 ? "" : "+";
  return `${sign}${rounded} PYS`;
}

export interface YieldRankChangeChipDisplay {
  arrow: string;
  colorClass: string;
  signedRank: string;
  short: string;
  long: string;
  pysDeltaLabel: string | null;
}

export const YIELD_DECISION_REASON_LABELS: Record<YieldDecisionReasonCode, string> = {
  "best-by-confidence-and-apy": "Best confidence-adjusted yield",
  "deterministic-preferred": "Deterministic source preferred",
  "curated-over-discovered": "Curated source preferred",
  "tier-preference": "Higher source tier",
  "tvl-floor": "Meets TVL floor",
  "freshness-tiebreaker": "Freshness tiebreaker",
  fallback: "Fallback source",
  "no-alternatives": "No retained alternatives",
};

export const YIELD_DECISION_REJECTION_REASON_LABELS: Record<YieldDecisionRejectionReasonCode, string> = {
  thinner: "thinner venue",
  stale: "stale observation",
  "lower-confidence": "lower confidence",
  "rewards-only": "rewards-heavy APY",
  smaller: "smaller venue",
  unspecified: "not selected",
};

// WHY: returns null when the delta is too small to be meaningful (gates leaderboard
// chip render). |pysDelta| >= 1 mirrors the published rank-attribution threshold.
export function buildRankChangeChipDisplay(
  attribution: YieldRankChangeAttribution | null | undefined,
): YieldRankChangeChipDisplay | null {
  if (!attribution) return null;
  const { rankDelta, pysDelta, primaryDriver } = attribution;
  if (rankDelta == null || primaryDriver == null || Math.abs(pysDelta ?? 0) < 1) return null;
  const driver = YIELD_RANK_CHANGE_DRIVER_LABELS[primaryDriver];
  if (!driver) return null;
  const arrow = rankDelta > 0 ? "▲" : rankDelta < 0 ? "▼" : "■";
  const colorClass =
    rankDelta > 0
      ? "text-emerald-700 dark:text-emerald-400"
      : rankDelta < 0
        ? "text-red-700 dark:text-red-400"
        : "text-muted-foreground";
  const signedRank = rankDelta > 0 ? `+${rankDelta}` : rankDelta < 0 ? `-${Math.abs(rankDelta)}` : "0";
  return {
    arrow,
    colorClass,
    signedRank,
    short: driver.short,
    long: driver.long,
    pysDeltaLabel: pysDelta != null ? formatSignedPysDelta(pysDelta) : null,
  };
}
