"use client";

import { useCallback, useId, useState } from "react";
import { ChevronDown, SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FilterSearchInput } from "@/components/filter-search-input";
import { useJustEntered } from "@/hooks/use-just-entered";
import type { TablePaginationProps } from "@/components/table-pagination";
import { getSafetyGradeBadgeClassName } from "@/lib/report-card-ui";
import {
  BLACKLISTABLE_VALUES,
  PEG_VALUES,
  SAFETY_EVIDENCE_VALUES,
  SAFETY_GRADE_VALUES,
  SCREENER_LIFECYCLE_VALUES,
  SCREENER_FILTER_DEFAULTS,
  SCREENER_STATE_VALUES,
  hasActiveFilters,
  type BlacklistableValue,
  type SafetyEvidenceValue,
  type ScreenerFilters,
  type ScreenerStateValue,
} from "@/lib/screener-filters";
import {
  COIN_STATE_LABELS,
  CUSTODY_MODEL_LABELS,
  ECONOMIC_CONTROL_LABEL,
  GOVERNANCE_LABELS_SHORT,
  MECHANISM_ARCHETYPE_LABELS,
  MINT_AUTHORITY_FILTER_VALUES,
  MINT_AUTHORITY_SCORE_FILTER_CONFIG,
  MINT_AUTHORITY_SCORE_FILTER_VALUES,
  MINT_AUTHORITY_STATUS_CONFIG,
  PEG_METADATA,
  SAFETY_EVIDENCE_LABELS,
  THREAT_BAND_LABELS,
  type MintAuthorityScoreFilterValue,
  type MintAuthorityStatusKind,
} from "@shared/lib/classification";
import { DEADLINE_HORIZON_DAYS } from "@shared/lib/coin-state";
import { CUSTODY_MODEL_VALUES, type CustodyModel } from "@shared/types/custody";
import type { ReportCardGrade } from "@shared/types/report-card-grade";
import {
  GOVERNANCE_TYPE_VALUES,
  MECHANISM_ARCHETYPE_VALUES,
  type GovernanceType,
  type MechanismArchetype,
  type StablecoinStatus,
} from "@shared/types/stablecoin-taxonomy";
import type { PegCurrency } from "@shared/types/core";

const LIFECYCLE_LABELS: Record<StablecoinStatus, string> = {
  active: "Active",
  "pre-launch": "Pre-launch",
  quarantined: "Quarantined",
  delisted: "Delisted",
  frozen: "Frozen",
};

const BLACKLISTABLE_LABELS: Record<BlacklistableValue, string> = {
  yes: "Yes",
  no: "No",
  possible: "Possible",
};

type FilterPillOption<V extends string> = { value: V; label: string; title?: string };

const TYPE_OPTIONS: readonly FilterPillOption<GovernanceType>[] = GOVERNANCE_TYPE_VALUES.map(
  (value) => ({ value, label: GOVERNANCE_LABELS_SHORT[value] }),
);
const MECHANISM_OPTIONS: readonly FilterPillOption<MechanismArchetype>[] =
  MECHANISM_ARCHETYPE_VALUES.map((value) => ({ value, label: MECHANISM_ARCHETYPE_LABELS[value] }));
const BLACKLISTABLE_OPTIONS: readonly FilterPillOption<BlacklistableValue>[] =
  BLACKLISTABLE_VALUES.map((value) => ({ value, label: BLACKLISTABLE_LABELS[value] }));
const LIFECYCLE_OPTIONS: readonly FilterPillOption<StablecoinStatus>[] =
  SCREENER_LIFECYCLE_VALUES.map((value) => ({ value, label: LIFECYCLE_LABELS[value] }));
const STATE_OPTIONS: readonly FilterPillOption<ScreenerStateValue>[] = SCREENER_STATE_VALUES.map((value) => ({
  value,
  // The DEWS pill matches a band floor, not any reading, so its visible label names the floor.
  label: value === "dews" ? `${COIN_STATE_LABELS.dews} ${THREAT_BAND_LABELS.ALERT}+` : COIN_STATE_LABELS[value],
  title: value === "dews" ? `DEWS ${THREAT_BAND_LABELS.ALERT} or worse`
    : value === "deadline" ? `Holder deadline within ${DEADLINE_HORIZON_DAYS} days, or recently passed` : undefined,
}));
const MINT_AUTHORITY_OPTIONS: readonly FilterPillOption<MintAuthorityStatusKind>[] =
  MINT_AUTHORITY_FILTER_VALUES.map((value) => ({
    value,
    label: MINT_AUTHORITY_STATUS_CONFIG[value].label,
    title: MINT_AUTHORITY_STATUS_CONFIG[value].detail,
  }));
const MINT_AUTHORITY_SCORE_OPTIONS: readonly FilterPillOption<MintAuthorityScoreFilterValue>[] =
  MINT_AUTHORITY_SCORE_FILTER_VALUES.map((value) => ({
    value,
    label: MINT_AUTHORITY_SCORE_FILTER_CONFIG[value].label,
    title: MINT_AUTHORITY_SCORE_FILTER_CONFIG[value].detail,
  }));
const PEG_OPTIONS: readonly FilterPillOption<PegCurrency>[] = PEG_VALUES.map((value) => ({
  value,
  label: PEG_METADATA[value].filterLabel,
  title: PEG_METADATA[value].label,
}));
const SAFETY_EVIDENCE_OPTIONS: readonly FilterPillOption<SafetyEvidenceValue>[] =
  SAFETY_EVIDENCE_VALUES.map((value) => ({ value, label: SAFETY_EVIDENCE_LABELS[value] }));
const CUSTODY_MODEL_OPTIONS: readonly FilterPillOption<CustodyModel>[] =
  CUSTODY_MODEL_VALUES.map((value) => ({ value, label: CUSTODY_MODEL_LABELS[value] }));

const GRADE_TIER_PRESETS: ReadonlyArray<{ key: string; label: string; grades: readonly ReportCardGrade[] }> = [
  { key: "A", label: "Grade: A-tier", grades: ["A+", "A", "A-"] },
  { key: "B", label: "Grade: B-tier", grades: ["B+", "B", "B-"] },
  { key: "C", label: "Grade: C-tier", grades: ["C+", "C", "C-"] },
  { key: "DF", label: "Grade: D / F", grades: ["D", "F"] },
  { key: "NR", label: "Grade: NR", grades: ["NR"] },
];

const SUPPLY_QUICK_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: "Supply: Any" },
  { value: 10_000_000, label: "Supply ≥ $10M" },
  { value: 100_000_000, label: "Supply ≥ $100M" },
  { value: 1_000_000_000, label: "Supply ≥ $1B" },
  { value: 10_000_000_000, label: "Supply ≥ $10B" },
];

interface QuickPreset {
  id: string;
  label: string;
  isActive: (filters: ScreenerFilters) => boolean;
  toggle: (filters: ScreenerFilters) => ScreenerFilters;
}

function sameValues<T extends string>(left: readonly T[], right: readonly T[]): boolean {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  return right.every((value) => set.has(value));
}

const PRIMARY_PRESETS: readonly QuickPreset[] = [
  {
    id: "a-grade",
    label: "A-grade",
    isActive: (filters) => sameValues(filters.safetyGrades, ["A+", "A", "A-"]),
    toggle: (filters) => ({
      ...filters,
      safetyGrades: sameValues(filters.safetyGrades, ["A+", "A", "A-"]) ? [] : ["A+", "A", "A-"],
    }),
  },
  {
    id: "unfreezable",
    label: "Unfreezable",
    isActive: (filters) => sameValues(filters.blacklistable, ["no"]),
    toggle: (filters) => ({
      ...filters,
      blacklistable: sameValues(filters.blacklistable, ["no"]) ? [] : ["no"],
    }),
  },
  {
    id: "active-alerts",
    label: "Active alerts",
    isActive: (filters) => sameValues(filters.states, ["critical", "depeg", "dews"]),
    toggle: (filters) => ({
      ...filters,
      states: sameValues(filters.states, ["critical", "depeg", "dews"]) ? [] : ["critical", "depeg", "dews"],
    }),
  },
  {
    id: "billion-plus",
    label: "$1B+",
    isActive: (filters) => filters.supplyMin === 1_000_000_000 && filters.supplyMax === 0,
    toggle: (filters) => ({
      ...filters,
      supplyMin: filters.supplyMin === 1_000_000_000 && filters.supplyMax === 0 ? 0 : 1_000_000_000,
      supplyMax: 0,
    }),
  },
];

function toggleFilterValue<V>(current: readonly V[], value: V): V[] {
  return current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value];
}

function resolveGradeSelectValue(grades: readonly ReportCardGrade[]): string {
  if (grades.length === 0) return "";
  const match = GRADE_TIER_PRESETS.find((tier) => sameValues(grades, tier.grades));
  return match ? match.key : "__custom__";
}

interface ScreenerToolbarProps {
  filters: ScreenerFilters;
  searchQuery?: string;
  onSearchChange?: (value: string) => void;
  matchingRows: number;
  totalRows: number;
  fundCount?: number;
  dataState: NonNullable<TablePaginationProps["dataState"]>;
  activeFilterCount: number;
  onChange: (next: ScreenerFilters) => void;
  onReset: () => void;
  rightSlot?: React.ReactNode;
}

const COMPACT_SELECT_CLASS =
  "pharos-focus-ring min-h-11 rounded-full border border-border bg-background px-3 py-1 text-xs font-medium text-foreground transition-colors hover:border-foreground/30 sm:min-h-8";

export function ScreenerToolbar({
  filters,
  searchQuery = "",
  onSearchChange,
  matchingRows,
  totalRows,
  fundCount = 0,
  dataState,
  activeFilterCount,
  onChange,
  onReset,
  rightSlot,
}: ScreenerToolbarProps) {
  const groupId = useId();
  const filtersId = `${groupId}-filters`;
  const pickerShortlist = filters.coins.length > 0;
  // Collapsed by default on both mobile and desktop so real table rows sit above
  // the 900px desktop fold and mobile skips the 18-control wall.
  const [showAllFilters, setShowAllFilters] = useState(false);

  const update = useCallback(
    <K extends keyof ScreenerFilters>(key: K, value: ScreenerFilters[K]) => {
      // A URL can carry a ceiling with no control of its own. When the visible
      // floor passes a non-default ceiling, clear that ceiling in the same
      // update instead of leaving a contradictory hidden bound.
      if (key === "dewsMin" && typeof value === "number" && filters.dewsMax !== SCREENER_FILTER_DEFAULTS.dewsMax && value > filters.dewsMax) {
        onChange({ ...filters, dewsMin: value, dewsMax: SCREENER_FILTER_DEFAULTS.dewsMax });
        return;
      }
      if (key === "supplyMin" && typeof value === "number" && filters.supplyMax !== SCREENER_FILTER_DEFAULTS.supplyMax && value > filters.supplyMax) {
        onChange({ ...filters, supplyMin: value, supplyMax: SCREENER_FILTER_DEFAULTS.supplyMax });
        return;
      }
      onChange({ ...filters, [key]: value });
    },
    [filters, onChange],
  );

  // M8: track chip additions per group so newly-active filters spring in
  // via `pharos-chip-animate-in`. Set clears after the keyframe completes.
  const justEnteredSafety = useJustEntered(filters.safetyGrades);
  const justEnteredEvidence = useJustEntered(filters.safetyEvidence);
  const justEnteredCustody = useJustEntered(filters.custodyModels);
  const justEnteredTypes = useJustEntered(filters.types);
  const justEnteredMechanisms = useJustEntered(filters.mechanisms);
  const justEnteredBlacklistable = useJustEntered(filters.blacklistable);
  const justEnteredMintAuthority = useJustEntered(filters.mintAuthority);
  const justEnteredMintAuthorityScores = useJustEntered(filters.mintAuthorityScores);
  const justEnteredLifecycle = useJustEntered(filters.lifecycle);
  const justEnteredStates = useJustEntered(filters.states);
  const justEnteredPegs = useJustEntered(filters.pegs);

  const hasSearch = searchQuery.trim().length > 0;
  const active = hasActiveFilters(filters) || hasSearch;
  const filterCountLabel = `${activeFilterCount.toLocaleString()} ${activeFilterCount === 1 ? "filter" : "filters"} applied`;
  const gradeSelectValue = resolveGradeSelectValue(filters.safetyGrades);
  const mechanismSelectValue =
    filters.mechanisms.length === 0 ? "" : filters.mechanisms.length === 1 ? filters.mechanisms[0]! : "__custom__";
  const pegSelectValue =
    filters.pegs.length === 0 ? "" : filters.pegs.length === 1 ? filters.pegs[0]! : "__custom__";
  const supplyPresetMatch = SUPPLY_QUICK_OPTIONS.some((option) => option.value === filters.supplyMin && filters.supplyMax === 0);
  const supplySelectValue = supplyPresetMatch ? String(filters.supplyMin) : "__custom__";

  return (
    <div className="pharos-card-shell space-y-2.5 p-3 sm:px-4 sm:py-3">
      {/* Row 0: Live match count + Export + Reset */}
      <div className="grid items-center gap-2 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0" aria-live="polite">
          {dataState === "ready" ? (
            <p className="flex min-h-12 flex-wrap items-baseline gap-x-2 gap-y-0.5 lg:min-h-8">
              <span className="pharos-numeric text-2xl font-semibold leading-none text-foreground">
                {matchingRows.toLocaleString("en-US")}
              </span>
              <span className="text-sm font-medium text-muted-foreground">
                of <span className="pharos-numeric text-foreground">{totalRows.toLocaleString("en-US")}</span>{" "}
                screenable coins{" "}
                {active ? "matching" : "(pre-launch and frozen included; tokenized funds excluded)"}
              </span>
            </p>
          ) : (
            <p className="min-h-12 text-sm text-muted-foreground lg:min-h-8">
              {dataState === "loading" ? "Loading screener inputs…" : "Screener counts unavailable."}
            </p>
          )}
          <p className="pharos-meta mt-0.5">{filterCountLabel}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:justify-self-end">
          {rightSlot}
          <Button
            variant="ghost"
            size="sm"
            onClick={onReset}
            disabled={!active}
            className="min-h-11 sm:min-h-8"
          >
            Reset filters
          </Button>
        </div>
      </div>

      {pickerShortlist ? (
        <p className="rounded-md border border-frost-blue/25 bg-frost-blue/5 px-3 py-2 text-sm text-foreground">
          Showing an exact {filters.coins.length}-coin selection. Reset filters to restore the full universe.
        </p>
      ) : null}

      {/* Row 1: Compact 1-row Primary Bar */}
      <div className="flex flex-wrap items-center gap-2">
        <FilterSearchInput
          value={searchQuery}
          onValueChange={(value) => onSearchChange?.(value)}
          placeholder="Search coin..."
          ariaLabel="Search stablecoins by name or ticker"
          className="relative w-full sm:w-48 sm:min-w-[180px] lg:w-52"
          inputClassName="h-11 pl-8 pr-3 text-xs sm:h-8"
        />

        {/* 1-click preset pills */}
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Quick presets">
          {PRIMARY_PRESETS.map((preset) => {
            const isPressed = preset.isActive(filters);
            return (
              <button
                key={preset.id}
                type="button"
                aria-pressed={isPressed}
                onClick={() => onChange(preset.toggle(filters))}
                className={`pharos-focus-ring pharos-control-pill min-h-11 whitespace-nowrap px-2.5 py-1 text-xs sm:min-h-8${
                  isPressed ? " pharos-control-pill-active" : ""
                }`}
              >
                {preset.label}
              </button>
            );
          })}
          <button
            type="button"
            aria-pressed={filters.includeFunds}
            title="Include tracked tokenized funds (not stablecoins) in screener results"
            onClick={() => update("includeFunds", !filters.includeFunds)}
            className={`pharos-focus-ring pharos-control-pill min-h-11 gap-1 whitespace-nowrap px-2.5 py-1 text-xs sm:min-h-8${
              filters.includeFunds ? " pharos-control-pill-active" : ""
            }`}
          >
            <span>Include tokenized funds</span>
            {fundCount > 0 ? (
              <span className="pharos-numeric text-3xs opacity-75">{fundCount}</span>
            ) : null}
          </button>
        </div>

        {/* Compact Grade / Mechanism / Peg / Supply chips */}
        <div className="flex flex-wrap items-center gap-1.5">
          <select
            aria-label="Filter by safety grade tier"
            value={gradeSelectValue}
            onChange={(event) => {
              const next = event.target.value;
              if (!next) {
                update("safetyGrades", []);
                return;
              }
              const tier = GRADE_TIER_PRESETS.find((entry) => entry.key === next);
              if (tier) update("safetyGrades", [...tier.grades]);
            }}
            className={COMPACT_SELECT_CLASS}
          >
            <option value="">Grade: Any</option>
            {GRADE_TIER_PRESETS.map((tier) => (
              <option key={tier.key} value={tier.key}>
                {tier.label}
              </option>
            ))}
            {gradeSelectValue === "__custom__" ? (
              <option value="__custom__">Grade ({filters.safetyGrades.length})</option>
            ) : null}
          </select>

          <select
            aria-label="Filter by mechanism"
            value={mechanismSelectValue}
            onChange={(event) => {
              const next = event.target.value as MechanismArchetype | "";
              update("mechanisms", next ? [next] : []);
            }}
            className={COMPACT_SELECT_CLASS}
          >
            <option value="">Mechanism: Any</option>
            {MECHANISM_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            {mechanismSelectValue === "__custom__" ? (
              <option value="__custom__">Mechanism ({filters.mechanisms.length})</option>
            ) : null}
          </select>

          <select
            aria-label="Filter by peg currency"
            value={pegSelectValue}
            onChange={(event) => {
              const next = event.target.value as PegCurrency | "";
              update("pegs", next ? [next] : []);
            }}
            className={COMPACT_SELECT_CLASS}
          >
            <option value="">Peg: Any</option>
            {PEG_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                Peg: {option.label}
              </option>
            ))}
            {pegSelectValue === "__custom__" ? (
              <option value="__custom__">Peg ({filters.pegs.length})</option>
            ) : null}
          </select>

          <select
            aria-label="Filter by minimum supply"
            value={supplySelectValue}
            onChange={(event) => {
              const parsed = Number(event.target.value);
              if (Number.isFinite(parsed)) update("supplyMin", parsed);
            }}
            className={COMPACT_SELECT_CLASS}
          >
            {SUPPLY_QUICK_OPTIONS.map((option) => (
              <option key={option.value} value={String(option.value)}>
                {option.label}
              </option>
            ))}
            {supplySelectValue === "__custom__" ? (
              <option value="__custom__">Supply: Custom</option>
            ) : null}
          </select>
        </div>

        {/* Expandable All filters disclosure trigger */}
        <button
          type="button"
          aria-expanded={showAllFilters}
          aria-controls={filtersId}
          onClick={() => setShowAllFilters((open) => !open)}
          className={`pharos-focus-ring pharos-control-pill ml-auto inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap px-3 py-1 text-xs font-medium sm:min-h-8${
            showAllFilters || activeFilterCount > 0 ? " pharos-control-pill-active" : ""
          }`}
        >
          <SlidersHorizontal className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            All filters
            {activeFilterCount > 0 ? ` (${activeFilterCount} active)` : ""}
          </span>
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 transition-transform motion-reduce:transition-none${
              showAllFilters ? " rotate-180" : ""
            }`}
            aria-hidden="true"
          />
        </button>
      </div>

      {/* Active filter summary strip when drawer is collapsed */}
      {!showAllFilters && hasSearch ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => onSearchChange?.("")}
            className="pharos-focus-ring inline-flex min-h-8 items-center gap-1 rounded-full border border-border bg-muted/40 px-2.5 py-0.5 text-xs text-foreground hover:bg-muted"
          >
            <span>Search: {searchQuery.trim()}</span>
            <X className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {/* Expandable full 18-control filter drawer (collapsed by default on mobile & desktop) */}
      <div id={filtersId} className={showAllFilters ? "space-y-3 border-t border-border/50 pt-3" : "hidden"}>
        <FilterPillGroup
          kicker="Exceptional state"
          options={STATE_OPTIONS}
          selected={filters.states}
          justEntered={justEnteredStates}
          onChange={(next) => update("states", next)}
        />

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1.35fr)_minmax(12rem,0.8fr)_minmax(12rem,0.8fr)_minmax(14rem,1fr)]">
          <div className="space-y-2">
            <span className="pharos-label" id={`${groupId}-safety-grades`}>
              Safety grade
            </span>
            {/* Grade pills keep the semantic green→red ramp (a data-driven
                indicator), so they use the pill shape + focus ring but their own
                grade color instead of the neutral control-pill-active fill. */}
            <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby={`${groupId}-safety-grades`}>
              {SAFETY_GRADE_VALUES.map((grade) => {
                const isActive = filters.safetyGrades.includes(grade);
                return (
                  <button
                    key={grade}
                    type="button"
                    aria-pressed={isActive}
                    onClick={() => update("safetyGrades", toggleFilterValue(filters.safetyGrades, grade))}
                    className={`pharos-focus-ring pharos-control-pill whitespace-nowrap px-2.5 py-1 font-semibold ${getSafetyGradeBadgeClassName(grade)} ${isActive ? "opacity-100 ring-1 ring-inset ring-current brightness-110" : "opacity-70"} ${justEnteredSafety.has(grade) ? "pharos-chip-animate-in" : ""}`}
                  >
                    {grade}
                  </button>
                );
              })}
            </div>
          </div>
          <ThresholdField
            label="DEWS Stress"
            min={0}
            max={100}
            step={1}
            minValue={filters.dewsMin}
            onMinChange={(v) => update("dewsMin", v)}
            defaultMin={SCREENER_FILTER_DEFAULTS.dewsMin}
          />
          <ThresholdField
            label="Mint Control"
            min={0}
            max={100}
            step={1}
            minValue={filters.mintAuthorityScoreMin}
            onMinChange={(v) => update("mintAuthorityScoreMin", v)}
            defaultMin={SCREENER_FILTER_DEFAULTS.mintAuthorityScoreMin}
          />
          <ThresholdField
            label="Supply (USD)"
            min={0}
            step={1_000_000}
            minValue={filters.supplyMin}
            onMinChange={(v) => update("supplyMin", v)}
            defaultMin={0}
            placeholder="No threshold"
          />
        </div>

        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <ThresholdField
            label="Safety Score"
            min={0}
            max={100}
            step={1}
            minValue={filters.safetyScoreMin}
            onMinChange={(v) => update("safetyScoreMin", v)}
            defaultMin={SCREENER_FILTER_DEFAULTS.safetyScoreMin}
          />
          <ThresholdField
            label="Backing"
            min={0}
            max={100}
            step={1}
            minValue={filters.safetyBackingMin}
            onMinChange={(v) => update("safetyBackingMin", v)}
            defaultMin={SCREENER_FILTER_DEFAULTS.safetyBackingMin}
          />
          <ThresholdField
            label="Exit"
            min={0}
            max={100}
            step={1}
            minValue={filters.safetyExitMin}
            onMinChange={(v) => update("safetyExitMin", v)}
            defaultMin={SCREENER_FILTER_DEFAULTS.safetyExitMin}
          />
          <ThresholdField
            label={ECONOMIC_CONTROL_LABEL}
            min={0}
            max={100}
            step={1}
            minValue={filters.safetyControlMin}
            onMinChange={(v) => update("safetyControlMin", v)}
            defaultMin={SCREENER_FILTER_DEFAULTS.safetyControlMin}
          />
        </div>

        <div className="grid gap-3 lg:grid-cols-[minmax(10rem,0.6fr)_minmax(10rem,0.6fr)_minmax(14rem,0.8fr)_minmax(20rem,1.4fr)]">
          <ThresholdField
            label="Peg Score"
            min={0}
            max={100}
            step={1}
            minValue={filters.pegScoreMin}
            onMinChange={(v) => update("pegScoreMin", v)}
            defaultMin={SCREENER_FILTER_DEFAULTS.pegScoreMin}
          />
          <ThresholdField
            label="Liquidity Score"
            min={0}
            max={100}
            step={1}
            minValue={filters.liquidityScoreMin}
            onMinChange={(v) => update("liquidityScoreMin", v)}
            defaultMin={SCREENER_FILTER_DEFAULTS.liquidityScoreMin}
          />
          <FilterPillGroup
            kicker="Safety evidence"
            options={SAFETY_EVIDENCE_OPTIONS}
            selected={filters.safetyEvidence}
            justEntered={justEnteredEvidence}
            onChange={(next) => update("safetyEvidence", next)}
          />
          <FilterPillGroup
            kicker="Custody Model"
            options={CUSTODY_MODEL_OPTIONS}
            selected={filters.custodyModels}
            justEntered={justEnteredCustody}
            onChange={(next) => update("custodyModels", next)}
          />
        </div>

        <div className="grid gap-3 lg:grid-cols-[minmax(0,0.7fr)_minmax(0,1.45fr)_minmax(0,0.95fr)_minmax(0,0.75fr)]">
          <FilterPillGroup
            kicker="Type"
            options={TYPE_OPTIONS}
            selected={filters.types}
            justEntered={justEnteredTypes}
            onChange={(next) => update("types", next)}
          />
          <FilterPillGroup
            kicker="Mechanism"
            options={MECHANISM_OPTIONS}
            selected={filters.mechanisms}
            justEntered={justEnteredMechanisms}
            onChange={(next) => update("mechanisms", next)}
          />
          <FilterPillGroup
            kicker="Blacklistable"
            options={BLACKLISTABLE_OPTIONS}
            selected={filters.blacklistable}
            justEntered={justEnteredBlacklistable}
            onChange={(next) => update("blacklistable", next)}
          />
          <FilterPillGroup
            kicker="Lifecycle"
            options={LIFECYCLE_OPTIONS}
            selected={filters.lifecycle}
            justEntered={justEnteredLifecycle}
            onChange={(next) => update("lifecycle", next)}
          />
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          <FilterPillGroup
            kicker="Mint authority route"
            options={MINT_AUTHORITY_OPTIONS}
            selected={filters.mintAuthority}
            justEntered={justEnteredMintAuthority}
            onChange={(next) => update("mintAuthority", next)}
          />
          <FilterPillGroup
            kicker="Mint Control posture"
            options={MINT_AUTHORITY_SCORE_OPTIONS}
            selected={filters.mintAuthorityScores}
            justEntered={justEnteredMintAuthorityScores}
            onChange={(next) => update("mintAuthorityScores", next)}
          />
        </div>

        <FilterPillGroup
          kicker="Peg"
          options={PEG_OPTIONS}
          selected={filters.pegs}
          justEntered={justEnteredPegs}
          onChange={(next) => update("pegs", next)}
        />
      </div>
    </div>
  );
}

interface FilterPillGroupProps<V extends string> {
  kicker: string;
  options: readonly FilterPillOption<V>[];
  selected: readonly V[];
  justEntered: ReadonlySet<V>;
  onChange: (next: V[]) => void;
}

function FilterPillGroup<V extends string>({
  kicker,
  options,
  selected,
  justEntered,
  onChange,
}: FilterPillGroupProps<V>) {
  const labelId = useId();
  return (
    <div className="space-y-2">
      <span className="pharos-label" id={labelId}>
        {kicker}
      </span>
      <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby={labelId}>
        {options.map((option) => {
          const isActive = selected.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={isActive}
              title={option.title}
              onClick={() => onChange(toggleFilterValue(selected, option.value))}
              className={`pharos-focus-ring pharos-control-pill whitespace-nowrap px-2.5 py-1${
                isActive ? " pharos-control-pill-active" : ""
              }${justEntered.has(option.value) ? " pharos-chip-animate-in" : ""}`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface ThresholdFieldProps {
  label: string;
  min: number;
  max?: number;
  step?: number;
  minValue: number;
  onMinChange: (value: number) => void;
  defaultMin: number;
  placeholder?: string;
}

function ThresholdField({
  label,
  min,
  max,
  step = 1,
  minValue,
  onMinChange,
  defaultMin,
  placeholder,
}: ThresholdFieldProps) {
  const id = useId();
  const inputId = `${id}-threshold`;

  const parseValue = useCallback(
    (raw: string, fallback: number): number => {
      if (raw === "") return fallback;
      const next = Number(raw);
      if (!Number.isFinite(next)) return fallback;
      if (max != null && next > max) return max;
      if (next < min) return min;
      return next;
    },
    [max, min],
  );

  return (
    <div className="space-y-2">
      <span className="pharos-label" id={`${id}-label`}>
        {label}
      </span>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
        <span className="rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm font-semibold text-muted-foreground" aria-hidden="true">
          ≥
        </span>
        <label htmlFor={inputId} className="sr-only">
          {label} greater than or equal to
        </label>
        <input
          id={inputId}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={step}
          value={minValue || ""}
          placeholder={placeholder ?? String(defaultMin)}
          onChange={(e) => onMinChange(parseValue(e.target.value, defaultMin))}
          className="pharos-focus-ring min-h-11 w-full rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm pharos-numeric sm:min-h-9"
        />
      </div>
    </div>
  );
}
