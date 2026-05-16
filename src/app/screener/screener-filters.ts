/**
 * Pure filter primitives for the Pharos Screener.
 *
 * URL params are flat and human-friendly (e.g. `?pegscore-min=80&mechanism=cdp,fiat-cash`).
 * Encoding/decoding goes through W1-F's URL codec in `src/lib/url-state.ts`.
 *
 * This module owns:
 *   - The `ScreenerFilters` shape.
 *   - The `SCREENER_URL_SCHEMA` codec schema.
 *   - `applyFilters()`, the pure filter pipeline applied to merged rows.
 *
 * Jurisdiction is not on the slim client-registry (only on the fat
 * server-side `StablecoinMeta`). Deferred to v2 per brief escalation rule.
 */
import type { UrlStateSchema } from "@/lib/url-state";
import { MECHANISM_ARCHETYPE_VALUES, STABLECOIN_STATUS_VALUES } from "@shared/types/core";
import { PEG_METADATA } from "@shared/lib/classification";
import type { MechanismArchetype, PegCurrency, StablecoinStatus } from "@shared/types";

export const PEG_VALUES = Object.keys(PEG_METADATA) as readonly PegCurrency[];

/**
 * Blacklistability buckets. Maps to the tri-state `canBeBlacklisted` field on
 * the stablecoin meta (boolean | "possible" | "dilutable") with friendlier
 * URL keys.
 *   - "yes"        → canBeBlacklisted === true  (issuer can freeze tokens)
 *   - "no"         → canBeBlacklisted === false (no privileged freeze path)
 *   - "possible"   → canBeBlacklisted === "possible"  (implementation-dependent)
 *   - "dilutable"  → canBeBlacklisted === "dilutable" (issuer can dilute via mint)
 */
export const BLACKLISTABLE_VALUES = ["yes", "no", "possible", "dilutable"] as const;
export type BlacklistableValue = (typeof BLACKLISTABLE_VALUES)[number];

export interface ScreenerFilters {
  pegScoreMin: number;
  pegScoreMax: number;
  dewsMin: number;
  dewsMax: number;
  liquidityMin: number;
  liquidityMax: number;
  supplyMin: number;
  supplyMax: number;
  mechanisms: readonly MechanismArchetype[];
  pegs: readonly PegCurrency[];
  lifecycle: readonly StablecoinStatus[];
  blacklistable: readonly BlacklistableValue[];
}

/** Default scalar ranges. A value at the bound counts as "no filter". */
export const SCREENER_FILTER_DEFAULTS: ScreenerFilters = {
  pegScoreMin: 0,
  pegScoreMax: 100,
  dewsMin: 0,
  dewsMax: 100,
  liquidityMin: 0,
  liquidityMax: 100,
  supplyMin: 0,
  supplyMax: 0,
  mechanisms: [],
  pegs: [],
  lifecycle: [],
  blacklistable: [],
};

/**
 * URL state schema consumed by W1-F's `decodeState` / `encodeState`.
 * Flat per-param keys — no nested groups, no fancy query builder.
 */
export const SCREENER_URL_SCHEMA: UrlStateSchema<ScreenerFilters> = {
  pegScoreMin: {
    kind: "boundedNumber",
    defaultValue: SCREENER_FILTER_DEFAULTS.pegScoreMin,
    min: 0,
    max: 100,
  },
  pegScoreMax: {
    kind: "boundedNumber",
    defaultValue: SCREENER_FILTER_DEFAULTS.pegScoreMax,
    min: 0,
    max: 100,
  },
  dewsMin: {
    kind: "boundedNumber",
    defaultValue: SCREENER_FILTER_DEFAULTS.dewsMin,
    min: 0,
    max: 100,
  },
  dewsMax: {
    kind: "boundedNumber",
    defaultValue: SCREENER_FILTER_DEFAULTS.dewsMax,
    min: 0,
    max: 100,
  },
  liquidityMin: {
    kind: "boundedNumber",
    defaultValue: SCREENER_FILTER_DEFAULTS.liquidityMin,
    min: 0,
    max: 100,
  },
  liquidityMax: {
    kind: "boundedNumber",
    defaultValue: SCREENER_FILTER_DEFAULTS.liquidityMax,
    min: 0,
    max: 100,
  },
  supplyMin: {
    kind: "boundedNumber",
    defaultValue: SCREENER_FILTER_DEFAULTS.supplyMin,
    min: 0,
  },
  supplyMax: {
    kind: "boundedNumber",
    defaultValue: SCREENER_FILTER_DEFAULTS.supplyMax,
    min: 0,
  },
  mechanisms: {
    kind: "enumList",
    defaultValue: SCREENER_FILTER_DEFAULTS.mechanisms,
    allowedValues: MECHANISM_ARCHETYPE_VALUES,
  },
  pegs: {
    kind: "enumList",
    defaultValue: SCREENER_FILTER_DEFAULTS.pegs,
    allowedValues: PEG_VALUES,
  },
  lifecycle: {
    kind: "enumList",
    defaultValue: SCREENER_FILTER_DEFAULTS.lifecycle,
    allowedValues: STABLECOIN_STATUS_VALUES,
  },
  blacklistable: {
    kind: "enumList",
    defaultValue: SCREENER_FILTER_DEFAULTS.blacklistable,
    allowedValues: BLACKLISTABLE_VALUES,
  },
};

export interface ScreenerRow {
  id: string;
  name: string;
  symbol: string;
  /** Lifecycle bucket: defaults to "active" when meta.status is absent. */
  lifecycle: StablecoinStatus;
  /** Mechanism archetype from the slim client registry (may be undefined). */
  mechanism: MechanismArchetype | null;
  /** Peg currency from `StablecoinClientMeta.flags`. */
  peg: PegCurrency;
  /** USD circulating supply summed from peg buckets (0 if unavailable). */
  supplyUsd: number;
  /** PegScore from peg-summary (0–100). null = unrated. */
  pegScore: number | null;
  /** DEWS stress score (0–100). null = unrated. */
  dewsScore: number | null;
  /** DEX Liquidity Score (0–100). null = unrated. */
  liquidityScore: number | null;
  /** Safety grade from report-cards. null = unrated. */
  safetyGrade: string | null;
  /** Safety overall score (0–100). null = unrated. */
  safetyScore: number | null;
  /** Blacklistability bucket. null = unspecified (no per-coin override). */
  blacklistable: BlacklistableValue | null;
}

export type ScreenerSortKey =
  | "name"
  | "supply"
  | "pegScore"
  | "dewsScore"
  | "liquidityScore"
  | "safetyScore";

export type ScreenerSortDirection = "asc" | "desc";

function compareValues(
  a: number | null | undefined,
  b: number | null | undefined,
  direction: ScreenerSortDirection,
): number {
  const aMissing = a == null;
  const bMissing = b == null;
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  return direction === "asc" ? a - b : b - a;
}

function compareStrings(a: string, b: string, direction: ScreenerSortDirection): number {
  const cmp = a.localeCompare(b);
  return direction === "asc" ? cmp : -cmp;
}

export function sortScreenerRows(
  rows: readonly ScreenerRow[],
  sortKey: ScreenerSortKey,
  sortDirection: ScreenerSortDirection,
): ScreenerRow[] {
  const copy = [...rows];
  copy.sort((a, b) => {
    switch (sortKey) {
      case "name":
        return compareStrings(a.symbol || a.name, b.symbol || b.name, sortDirection);
      case "supply":
        return compareValues(a.supplyUsd, b.supplyUsd, sortDirection);
      case "pegScore":
        return compareValues(a.pegScore, b.pegScore, sortDirection);
      case "dewsScore":
        return compareValues(a.dewsScore, b.dewsScore, sortDirection);
      case "liquidityScore":
        return compareValues(a.liquidityScore, b.liquidityScore, sortDirection);
      case "safetyScore":
        return compareValues(a.safetyScore, b.safetyScore, sortDirection);
      default:
        return 0;
    }
  });
  return copy;
}

export interface ScreenerScoreFilterLoadingState {
  pegLoading: boolean;
  pegHasData: boolean;
  dewsLoading: boolean;
  dewsHasData: boolean;
  liquidityLoading: boolean;
  liquidityHasData: boolean;
}

export function hasLoadingScoreFilterData(
  filters: ScreenerFilters,
  state: ScreenerScoreFilterLoadingState,
): boolean {
  const pegScoreActive =
    filters.pegScoreMin > SCREENER_FILTER_DEFAULTS.pegScoreMin ||
    filters.pegScoreMax < SCREENER_FILTER_DEFAULTS.pegScoreMax;
  const dewsActive =
    filters.dewsMin > SCREENER_FILTER_DEFAULTS.dewsMin ||
    filters.dewsMax < SCREENER_FILTER_DEFAULTS.dewsMax;
  const liquidityActive =
    filters.liquidityMin > SCREENER_FILTER_DEFAULTS.liquidityMin ||
    filters.liquidityMax < SCREENER_FILTER_DEFAULTS.liquidityMax;

  return (
    (pegScoreActive && state.pegLoading && !state.pegHasData) ||
    (dewsActive && state.dewsLoading && !state.dewsHasData) ||
    (liquidityActive && state.liquidityLoading && !state.liquidityHasData)
  );
}

/**
 * Apply scalar ranges and multi-select filters. Pure: no React, no
 * URL access. Rows missing a score do NOT pass that score's range filter
 * UNLESS the range matches the schema default (i.e. user has not narrowed
 * the range, so we don't want to hide unrated coins).
 */
export function applyFilters(rows: readonly ScreenerRow[], filters: ScreenerFilters): ScreenerRow[] {
  const pegScoreActive =
    filters.pegScoreMin > SCREENER_FILTER_DEFAULTS.pegScoreMin ||
    filters.pegScoreMax < SCREENER_FILTER_DEFAULTS.pegScoreMax;
  const dewsActive =
    filters.dewsMin > SCREENER_FILTER_DEFAULTS.dewsMin ||
    filters.dewsMax < SCREENER_FILTER_DEFAULTS.dewsMax;
  const liquidityActive =
    filters.liquidityMin > SCREENER_FILTER_DEFAULTS.liquidityMin ||
    filters.liquidityMax < SCREENER_FILTER_DEFAULTS.liquidityMax;
  const supplyMinActive = filters.supplyMin > 0;
  const supplyMaxActive = filters.supplyMax > 0;

  const mechanismSet = filters.mechanisms.length > 0 ? new Set(filters.mechanisms) : null;
  const pegSet = filters.pegs.length > 0 ? new Set(filters.pegs) : null;
  const lifecycleSet = filters.lifecycle.length > 0 ? new Set(filters.lifecycle) : null;
  const blacklistableSet = filters.blacklistable.length > 0 ? new Set(filters.blacklistable) : null;

  return rows.filter((row) => {
    if (pegScoreActive) {
      if (row.pegScore == null) return false;
      if (row.pegScore < filters.pegScoreMin) return false;
      if (row.pegScore > filters.pegScoreMax) return false;
    }
    if (dewsActive) {
      if (row.dewsScore == null) return false;
      if (row.dewsScore < filters.dewsMin) return false;
      if (row.dewsScore > filters.dewsMax) return false;
    }
    if (liquidityActive) {
      if (row.liquidityScore == null) return false;
      if (row.liquidityScore < filters.liquidityMin) return false;
      if (row.liquidityScore > filters.liquidityMax) return false;
    }
    if (supplyMinActive && row.supplyUsd < filters.supplyMin) return false;
    if (supplyMaxActive && row.supplyUsd > filters.supplyMax) return false;
    if (mechanismSet) {
      if (!row.mechanism || !mechanismSet.has(row.mechanism)) return false;
    }
    if (pegSet && !pegSet.has(row.peg)) return false;
    if (lifecycleSet && !lifecycleSet.has(row.lifecycle)) return false;
    if (blacklistableSet) {
      if (!row.blacklistable || !blacklistableSet.has(row.blacklistable)) return false;
    }
    return true;
  });
}

/** Project the meta `canBeBlacklisted` tri-state to the screener bucket. */
export function projectBlacklistable(value: boolean | "possible" | "dilutable" | undefined): BlacklistableValue | null {
  if (value === true) return "yes";
  if (value === false) return "no";
  if (value === "possible" || value === "dilutable") return value;
  return null;
}

/** Detects whether any filter is non-default. Used for the "Reset" CTA. */
export function hasActiveFilters(filters: ScreenerFilters): boolean {
  return (
    filters.pegScoreMin !== SCREENER_FILTER_DEFAULTS.pegScoreMin ||
    filters.pegScoreMax !== SCREENER_FILTER_DEFAULTS.pegScoreMax ||
    filters.dewsMin !== SCREENER_FILTER_DEFAULTS.dewsMin ||
    filters.dewsMax !== SCREENER_FILTER_DEFAULTS.dewsMax ||
    filters.liquidityMin !== SCREENER_FILTER_DEFAULTS.liquidityMin ||
    filters.liquidityMax !== SCREENER_FILTER_DEFAULTS.liquidityMax ||
    filters.supplyMin > 0 ||
    filters.supplyMax > 0 ||
    filters.mechanisms.length > 0 ||
    filters.pegs.length > 0 ||
    filters.lifecycle.length > 0 ||
    filters.blacklistable.length > 0
  );
}
