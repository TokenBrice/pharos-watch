/**
 * Filter-context breadcrumb summaries (W6-A / I3).
 *
 * Each helper takes the surface's active filter state (already decoded from
 * URL) and returns a compact human-readable string like
 * "USD · CeFi · DEWS<35". `null` means no filters are active — the chrome
 * breadcrumb should suppress the trailing crumb in that case.
 */
import {
  GOVERNANCE_LABELS_SHORT,
  MECHANISM_ARCHETYPE_LABELS,
  PEG_LABELS_SHORT,
  getMechanismArchetypeLabel,
} from "@shared/lib/classification";
import type { PegCurrency } from "@shared/types";
import type { ScreenerFilters } from "@/app/screener/screener-filters";
import type { YieldActiveFilterSummary } from "@/lib/yield-view-model";

const SUMMARY_SEPARATOR = " · ";
/** Hard cap on enum-list expansion before collapsing to `+N more`. */
const MAX_ENUM_LIST = 3;

function joinNonEmpty(parts: readonly string[]): string | null {
  const cleaned = parts.filter((part) => part.length > 0);
  return cleaned.length === 0 ? null : cleaned.join(SUMMARY_SEPARATOR);
}

/**
 * Collapse an enum-list into `A · B · C +Nmore`. Returns "" for empty input.
 */
function summarizeEnumList(values: readonly string[]): string {
  if (values.length === 0) return "";
  if (values.length <= MAX_ENUM_LIST) return values.join(SUMMARY_SEPARATOR);
  const visible = values.slice(0, MAX_ENUM_LIST);
  const remainder = values.length - MAX_ENUM_LIST;
  return `${visible.join(SUMMARY_SEPARATOR)} +${remainder} more`;
}

function formatRange(label: string, min: number, max: number, hardMax: number): string | null {
  if (min <= 0 && max >= hardMax) return null;
  if (min <= 0) return `${label}<${Math.round(max)}`;
  if (max >= hardMax) return `${label}>${Math.round(min)}`;
  return `${label} ${Math.round(min)}-${Math.round(max)}`;
}

function formatMinimum(label: string, value: number): string | null {
  if (value <= 0) return null;
  return `${label}≥${Math.round(value)}`;
}

// ---------------------------------------------------------------------------
// Screener
// ---------------------------------------------------------------------------

export function summarizeScreenerFilters(filters: ScreenerFilters): string | null {
  const parts: string[] = [];

  // Peg currencies → "USD" or "EUR · GBP"
  if (filters.pegs.length > 0) {
    const labels = filters.pegs.map((peg) => PEG_LABELS_SHORT[peg as PegCurrency] ?? peg);
    parts.push(summarizeEnumList(labels));
  }

  // Governance → "CeFi", "DeFi · Hybrid"
  if (filters.types.length > 0) {
    const labels = filters.types.map((type) => GOVERNANCE_LABELS_SHORT[type] ?? type);
    parts.push(summarizeEnumList(labels));
  }

  // Mechanism archetypes → first 2-3, then "+N more"
  if (filters.mechanisms.length > 0) {
    const labels = filters.mechanisms.map((mech) => MECHANISM_ARCHETYPE_LABELS[mech] ?? mech);
    parts.push(summarizeEnumList(labels));
  }

  // Safety grades → "A+ · A"
  if (filters.safetyGrades.length > 0) {
    parts.push(summarizeEnumList(filters.safetyGrades.map(String)));
  }

  // Lifecycle pills
  if (filters.lifecycle.length > 0) {
    parts.push(summarizeEnumList(filters.lifecycle.map(String)));
  }

  // Blacklistability buckets
  if (filters.blacklistable.length > 0) {
    parts.push(summarizeEnumList(filters.blacklistable.map(String)));
  }

  // Numeric thresholds
  const dewsRange = formatRange("DEWS", filters.dewsMin, filters.dewsMax, 100);
  if (dewsRange) parts.push(dewsRange);
  const supplyRange = formatRange("Supply", filters.supplyMin, filters.supplyMax || Infinity, Infinity);
  if (supplyRange) parts.push(supplyRange);

  const safetyMin = formatMinimum("Safety", filters.safetyPegStabilityMin);
  if (safetyMin) parts.push(safetyMin);
  const liqMin = formatMinimum("Liq", filters.safetyLiquidityMin);
  if (liqMin) parts.push(liqMin);
  const resMin = formatMinimum("Res", filters.safetyResilienceMin);
  if (resMin) parts.push(resMin);
  const decMin = formatMinimum("Dec", filters.safetyDecentralizationMin);
  if (decMin) parts.push(decMin);
  const depMin = formatMinimum("Dep", filters.safetyDependencyRiskMin);
  if (depMin) parts.push(depMin);

  return joinNonEmpty(parts);
}

// ---------------------------------------------------------------------------
// Yield
// ---------------------------------------------------------------------------

/**
 * `yield/client.tsx` already computes `getActiveFilterSummaries(viewModel)`
 * which returns rich `{ key, label }` rows; we simply consume the labels and
 * cap them at the same enum-list threshold as the other surfaces.
 */
export function summarizeYieldFilters(active: readonly YieldActiveFilterSummary[]): string | null {
  if (active.length === 0) return null;
  return summarizeEnumList(active.map((entry) => entry.label));
}

// ---------------------------------------------------------------------------
// Liquidity
// ---------------------------------------------------------------------------

export interface LiquidityFilterState {
  /** Peg filter value: `"all"` means no filter. */
  peg: PegCurrency | "all";
  /** Trimmed search query; empty string means no filter. */
  query: string;
}

export function summarizeLiquidityFilters(filters: LiquidityFilterState): string | null {
  const parts: string[] = [];
  if (filters.peg !== "all") {
    parts.push(PEG_LABELS_SHORT[filters.peg] ?? filters.peg);
  }
  if (filters.query.length > 0) {
    parts.push(`"${filters.query}"`);
  }
  return joinNonEmpty(parts);
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

export interface CompareFilterState {
  /** Selected coin symbols, in slot order, with empty slots dropped. */
  selectedSymbols: readonly string[];
  /** Time range option, e.g. `"30d"`; `"all"` is treated as no filter. */
  range: string;
}

export function summarizeCompareFilters(filters: CompareFilterState): string | null {
  const parts: string[] = [];
  if (filters.selectedSymbols.length > 0) {
    if (filters.selectedSymbols.length <= MAX_ENUM_LIST) {
      parts.push(filters.selectedSymbols.join(" vs "));
    } else {
      const visible = filters.selectedSymbols.slice(0, MAX_ENUM_LIST);
      const remainder = filters.selectedSymbols.length - MAX_ENUM_LIST;
      parts.push(`${visible.join(" vs ")} +${remainder} more`);
    }
  }
  if (filters.range && filters.range !== "all") {
    parts.push(filters.range);
  }
  return joinNonEmpty(parts);
}

// Re-export common label helpers that consumers might want, so tracker pages
// don't need to import them separately when building filter summaries.
export { getMechanismArchetypeLabel };
