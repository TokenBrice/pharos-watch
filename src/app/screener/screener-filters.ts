/**
 * Pure filter primitives for the Pharos Screener.
 *
 * URL params are flat and human-friendly (e.g. `?dewsMin=40&mechanisms=cdp,fiat-cash`).
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
import { createTableComparator } from "@/lib/table-comparator";
import {
  MINT_AUTHORITY_FILTER_VALUES,
  MINT_AUTHORITY_SCORE_FILTER_VALUES,
  resolveMintAuthorityStatusKind,
  type MintAuthorityScoreFilterValue,
  type MintAuthorityStatusKind,
} from "@/lib/mint-authority-display";
import type { UrlStateSchema } from "@/lib/url-state";
import {
  GOVERNANCE_TYPE_VALUES,
  MECHANISM_ARCHETYPE_VALUES,
  STABLECOIN_STATUS_VALUES,
} from "@shared/types/stablecoin-taxonomy";
import { PEG_METADATA } from "@shared/lib/classification";
import type { MintAuthorityCoverageSummary } from "@shared/types/stablecoin-client-meta";
import type { PegCurrency, ReportCardGrade } from "@shared/types";
import type {
  GovernanceType,
  MechanismArchetype,
  StablecoinStatus,
} from "@shared/types/stablecoin-taxonomy";

export const PEG_VALUES = Object.keys(PEG_METADATA) as readonly PegCurrency[];
export const SAFETY_GRADE_VALUES = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D", "F", "NR"] as const satisfies readonly ReportCardGrade[];

/**
 * Blacklistability buckets. Maps to the tri-state `canBeBlacklisted` field on
 * the stablecoin meta (boolean | "possible") with friendlier
 * URL keys.
 *   - "yes"        → canBeBlacklisted === true  (issuer can freeze tokens)
 *   - "no"         → canBeBlacklisted === false (no privileged freeze path)
 *   - "possible"   → canBeBlacklisted === "possible"  (implementation-dependent)
 */
export const BLACKLISTABLE_VALUES = ["yes", "no", "possible"] as const;
export type BlacklistableValue = (typeof BLACKLISTABLE_VALUES)[number];

export interface ScreenerFilters {
  dewsMin: number;
  dewsMax: number;
  supplyMin: number;
  supplyMax: number;
  safetyGrades: readonly ReportCardGrade[];
  safetyPegStabilityMin: number;
  safetyLiquidityMin: number;
  safetyResilienceMin: number;
  safetyDecentralizationMin: number;
  safetyDependencyRiskMin: number;
  types: readonly GovernanceType[];
  mechanisms: readonly MechanismArchetype[];
  pegs: readonly PegCurrency[];
  lifecycle: readonly StablecoinStatus[];
  blacklistable: readonly BlacklistableValue[];
  mintAuthority: readonly MintAuthorityStatusKind[];
  mintAuthorityScoreMin: number;
  mintAuthorityScores: readonly MintAuthorityScoreFilterValue[];
}

/** Default scalar ranges. A value at the bound counts as "no filter". */
export const SCREENER_FILTER_DEFAULTS: ScreenerFilters = {
  dewsMin: 0,
  dewsMax: 100,
  supplyMin: 0,
  supplyMax: 0,
  safetyGrades: [],
  safetyPegStabilityMin: 0,
  safetyLiquidityMin: 0,
  safetyResilienceMin: 0,
  safetyDecentralizationMin: 0,
  safetyDependencyRiskMin: 0,
  types: [],
  mechanisms: [],
  pegs: [],
  lifecycle: [],
  blacklistable: [],
  mintAuthority: [],
  mintAuthorityScoreMin: 0,
  mintAuthorityScores: [],
};

/**
 * URL state schema consumed by W1-F's `decodeState` / `encodeState`.
 * Flat per-param keys — no nested groups, no fancy query builder.
 */
export const SCREENER_URL_SCHEMA: UrlStateSchema<ScreenerFilters> = {
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
  safetyGrades: {
    kind: "enumList",
    defaultValue: SCREENER_FILTER_DEFAULTS.safetyGrades,
    allowedValues: SAFETY_GRADE_VALUES,
  },
  safetyPegStabilityMin: {
    kind: "boundedNumber",
    defaultValue: SCREENER_FILTER_DEFAULTS.safetyPegStabilityMin,
    min: 0,
    max: 100,
  },
  safetyLiquidityMin: {
    kind: "boundedNumber",
    defaultValue: SCREENER_FILTER_DEFAULTS.safetyLiquidityMin,
    min: 0,
    max: 100,
  },
  safetyResilienceMin: {
    kind: "boundedNumber",
    defaultValue: SCREENER_FILTER_DEFAULTS.safetyResilienceMin,
    min: 0,
    max: 100,
  },
  safetyDecentralizationMin: {
    kind: "boundedNumber",
    defaultValue: SCREENER_FILTER_DEFAULTS.safetyDecentralizationMin,
    min: 0,
    max: 100,
  },
  safetyDependencyRiskMin: {
    kind: "boundedNumber",
    defaultValue: SCREENER_FILTER_DEFAULTS.safetyDependencyRiskMin,
    min: 0,
    max: 100,
  },
  types: {
    kind: "enumList",
    defaultValue: SCREENER_FILTER_DEFAULTS.types,
    allowedValues: GOVERNANCE_TYPE_VALUES,
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
  mintAuthority: {
    kind: "enumList",
    defaultValue: SCREENER_FILTER_DEFAULTS.mintAuthority,
    allowedValues: MINT_AUTHORITY_FILTER_VALUES,
  },
  mintAuthorityScoreMin: {
    kind: "boundedNumber",
    defaultValue: SCREENER_FILTER_DEFAULTS.mintAuthorityScoreMin,
    min: 0,
    max: 100,
  },
  mintAuthorityScores: {
    kind: "enumList",
    defaultValue: SCREENER_FILTER_DEFAULTS.mintAuthorityScores,
    allowedValues: MINT_AUTHORITY_SCORE_FILTER_VALUES,
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
  /** Governance type from `StablecoinClientMeta.flags`. */
  type: GovernanceType;
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
  safetyGrade: ReportCardGrade | null;
  /** Safety overall score (0–100). null = unrated. */
  safetyScore: number | null;
  safetyPegStabilityScore: number | null;
  safetyLiquidityScore: number | null;
  safetyResilienceScore: number | null;
  safetyDecentralizationScore: number | null;
  safetyDependencyRiskScore: number | null;
  /** Blacklistability bucket. null = unspecified (no per-coin override). */
  blacklistable: BlacklistableValue | null;
  /** Curated mint-authority review bucket. "unknown" = no compact review. */
  mintAuthority: MintAuthorityStatusKind;
  /** Standalone Mint Authority Score (0-100). null = not rated. */
  mintAuthorityScore: number | null;
  /** Score band bucket, or "nr" when unrated. */
  mintAuthorityScoreBand: MintAuthorityScoreFilterValue;
  mintAuthorityScoreLabel: string;
  mintAuthorityScoreBandLabel: string;
  mintAuthorityScoreBadgeClassName: string;
  mintAuthorityScoreDetail: string;
  /** Compact peg-deviation samples for the desktop 30d peg sparkline. */
  pegDeviationSeries?: ReadonlyArray<number | null>;
  /** Compact supply samples for the desktop 30d supply sparkline. */
  supplySeries?: ReadonlyArray<number | null>;
}

export type ScreenerSortKey =
  | "name"
  | "supply"
  | "pegScore"
  | "dewsScore"
  | "liquidityScore"
  | "safetyScore"
  | "mintAuthorityScore";

export type ScreenerSortDirection = "asc" | "desc";

const compareScreenerRows = createTableComparator<ScreenerSortKey, ScreenerRow>({
  name: (row) => row.symbol || row.name,
  supply: (row) => row.supplyUsd,
  pegScore: (row) => row.pegScore,
  dewsScore: (row) => row.dewsScore,
  liquidityScore: (row) => row.liquidityScore,
  safetyScore: (row) => row.safetyScore,
  mintAuthorityScore: (row) => row.mintAuthorityScore,
});

export function sortScreenerRows(
  rows: readonly ScreenerRow[],
  sortKey: ScreenerSortKey,
  sortDirection: ScreenerSortDirection,
): ScreenerRow[] {
  const copy = [...rows];
  copy.sort((a, b) => compareScreenerRows(a, b, { key: sortKey, direction: sortDirection }));
  return copy;
}

export interface ScreenerScoreFilterLoadingState {
  dewsLoading: boolean;
  dewsHasData: boolean;
  reportLoading: boolean;
  reportHasData: boolean;
}

function isScoreRangeActive(minValue: number, maxValue: number): boolean {
  return minValue > 0 || maxValue < 100;
}

function isSupplyRangeActive(minValue: number, maxValue: number): boolean {
  return minValue > 0 || maxValue > 0;
}

function passesRange(
  value: number | null | undefined,
  minValue: number,
  maxValue: number,
  active: boolean,
): boolean {
  if (!active) return true;
  if (value == null) return false;
  return (minValue > 0 ? value > minValue : value >= minValue) && value <= maxValue;
}

function passesMinimum(value: number | null | undefined, minValue: number): boolean {
  if (minValue <= 0) return true;
  return value != null && value > minValue;
}

export function hasLoadingScoreFilterData(
  filters: ScreenerFilters,
  state: ScreenerScoreFilterLoadingState,
): boolean {
  const dewsActive = isScoreRangeActive(filters.dewsMin, filters.dewsMax);
  const reportActive =
    filters.safetyGrades.length > 0 ||
    filters.safetyPegStabilityMin > 0 ||
    filters.safetyLiquidityMin > 0 ||
    filters.safetyResilienceMin > 0 ||
    filters.safetyDecentralizationMin > 0 ||
    filters.safetyDependencyRiskMin > 0;

  return (
    (dewsActive && state.dewsLoading && !state.dewsHasData) ||
    (reportActive && state.reportLoading && !state.reportHasData)
  );
}

/**
 * Apply scalar ranges and multi-select filters. Pure: no React, no
 * URL access. Rows missing a score do NOT pass that score's range filter
 * UNLESS the range matches the schema default (i.e. user has not narrowed
 * the range, so we don't want to hide unrated coins).
 */
export function applyFilters(rows: readonly ScreenerRow[], filters: ScreenerFilters): ScreenerRow[] {
  const dewsActive = isScoreRangeActive(filters.dewsMin, filters.dewsMax);
  const supplyActive = isSupplyRangeActive(filters.supplyMin, filters.supplyMax);

  const safetyGradeSet = filters.safetyGrades.length > 0 ? new Set(filters.safetyGrades) : null;
  const mechanismSet = filters.mechanisms.length > 0 ? new Set(filters.mechanisms) : null;
  const typeSet = filters.types.length > 0 ? new Set(filters.types) : null;
  const pegSet = filters.pegs.length > 0 ? new Set(filters.pegs) : null;
  const lifecycleSet = filters.lifecycle.length > 0 ? new Set(filters.lifecycle) : null;
  const blacklistableSet = filters.blacklistable.length > 0 ? new Set(filters.blacklistable) : null;
  const mintAuthoritySet = filters.mintAuthority.length > 0 ? new Set(filters.mintAuthority) : null;
  const mintAuthorityScoreSet = filters.mintAuthorityScores.length > 0 ? new Set(filters.mintAuthorityScores) : null;

  return rows.filter((row) => {
    if (!passesRange(row.dewsScore, filters.dewsMin, filters.dewsMax, dewsActive)) return false;
    if (!passesRange(row.supplyUsd, filters.supplyMin, filters.supplyMax || Infinity, supplyActive)) return false;
    if (safetyGradeSet) {
      if (!row.safetyGrade || !safetyGradeSet.has(row.safetyGrade)) return false;
    }
    if (!passesMinimum(row.safetyPegStabilityScore, filters.safetyPegStabilityMin)) return false;
    if (!passesMinimum(row.safetyLiquidityScore, filters.safetyLiquidityMin)) return false;
    if (!passesMinimum(row.safetyResilienceScore, filters.safetyResilienceMin)) return false;
    if (!passesMinimum(row.safetyDecentralizationScore, filters.safetyDecentralizationMin)) return false;
    if (!passesMinimum(row.safetyDependencyRiskScore, filters.safetyDependencyRiskMin)) return false;
    if (mechanismSet) {
      if (!row.mechanism || !mechanismSet.has(row.mechanism)) return false;
    }
    if (typeSet && !typeSet.has(row.type)) return false;
    if (pegSet && !pegSet.has(row.peg)) return false;
    if (lifecycleSet && !lifecycleSet.has(row.lifecycle)) return false;
    if (blacklistableSet) {
      if (!row.blacklistable || !blacklistableSet.has(row.blacklistable)) return false;
    }
    if (mintAuthoritySet && !mintAuthoritySet.has(row.mintAuthority)) return false;
    if (!passesMinimum(row.mintAuthorityScore, filters.mintAuthorityScoreMin)) return false;
    if (mintAuthorityScoreSet && !mintAuthorityScoreSet.has(row.mintAuthorityScoreBand)) return false;
    return true;
  });
}

/**
 * Singular deep-link aliases supported on `/screener/`.
 *
 * The screener's canonical URL contract uses plural enum-list keys (`mechanisms`,
 * `lifecycle`). Legacy inbound links may still use the shorter singular
 * `mechanism=<slug>` and singular `lifecycle=<single-status>` forms; accept them
 * and normalize them in place.
 *
 * When `mechanism` is present and `lifecycle` is unset, this also pins
 * `lifecycle=active` so deep-linked views don't surface pre-launch or frozen
 * coins by accident.
 *
 * Returns `true` when at least one alias was consumed (i.e. the URL needs to be
 * rewritten to the canonical form).
 */
export function normalizeScreenerDeepLinkAliases(params: URLSearchParams): boolean {
  let changed = false;

  const mechanismAlias = params.get("mechanism");
  if (mechanismAlias && !params.has("mechanisms")) {
    const trimmed = mechanismAlias.trim();
    if ((MECHANISM_ARCHETYPE_VALUES as readonly string[]).includes(trimmed)) {
      params.set("mechanisms", trimmed);
      changed = true;
    }
  }
  if (params.has("mechanism")) {
    params.delete("mechanism");
    changed = true;
  }

  // Singular `lifecycle=<single-status>` is itself the canonical key
  // (the existing schema reads it as an enumList delimited by ","), so the
  // only normalization needed is the "pin lifecycle=active" default when
  // arriving via a `mechanism` deep-link without an explicit lifecycle.
  if (mechanismAlias && !params.has("lifecycle")) {
    params.set("lifecycle", "active");
    changed = true;
  }

  return changed;
}

/** Project the meta `canBeBlacklisted` tri-state to the screener bucket. */
export function projectBlacklistable(value: boolean | "possible" | undefined): BlacklistableValue | null {
  if (value === true) return "yes";
  if (value === false) return "no";
  if (value === "possible") return value;
  return null;
}

export function projectMintAuthority(
  summary?: MintAuthorityCoverageSummary | null,
): MintAuthorityStatusKind {
  return resolveMintAuthorityStatusKind(summary);
}

/** Detects whether any filter is non-default. Used for the "Reset" CTA. */
export function hasActiveFilters(filters: ScreenerFilters): boolean {
  return (
    countActiveScreenerFilters(filters) > 0
  );
}

/** Counts visible active constraints for summary UI. Ranges count once; selected pills count individually. */
export function countActiveScreenerFilters(filters: ScreenerFilters): number {
  let count = 0;
  if (isScoreRangeActive(filters.dewsMin, filters.dewsMax)) {
    count += 1;
  }
  if (isSupplyRangeActive(filters.supplyMin, filters.supplyMax)) {
    count += 1;
  }
  count += filters.safetyGrades.length;
  if (filters.safetyPegStabilityMin > 0) {
    count += 1;
  }
  if (filters.safetyLiquidityMin > 0) {
    count += 1;
  }
  if (filters.safetyResilienceMin > 0) {
    count += 1;
  }
  if (filters.safetyDecentralizationMin > 0) {
    count += 1;
  }
  if (filters.safetyDependencyRiskMin > 0) {
    count += 1;
  }
  if (filters.mintAuthorityScoreMin > 0) {
    count += 1;
  }
  count += filters.types.length;
  count += filters.mechanisms.length;
  count += filters.pegs.length;
  count += filters.lifecycle.length;
  count += filters.blacklistable.length;
  count += filters.mintAuthority.length;
  count += filters.mintAuthorityScores.length;
  return count;
}
