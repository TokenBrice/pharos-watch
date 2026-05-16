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
    return true;
  });
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
    filters.lifecycle.length > 0
  );
}
