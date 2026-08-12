"use client";

import { useCallback, useId } from "react";
import { Button } from "@/components/ui/button";
import { useJustEntered } from "@/hooks/use-just-entered";
import { getSafetyGradeBadgeClassName } from "@/lib/report-card-ui";
import {
  BLACKLISTABLE_VALUES,
  PEG_VALUES,
  SAFETY_EVIDENCE_VALUES,
  SAFETY_GRADE_VALUES,
  SCREENER_LIFECYCLE_VALUES,
  SCREENER_FILTER_DEFAULTS,
  hasActiveFilters,
  type BlacklistableValue,
  type SafetyEvidenceValue,
  type ScreenerFilters,
} from "@/app/screener/screener-filters";
import {
  MINT_AUTHORITY_FILTER_VALUES,
  MINT_AUTHORITY_SCORE_FILTER_CONFIG,
  MINT_AUTHORITY_SCORE_FILTER_VALUES,
  MINT_AUTHORITY_STATUS_CONFIG,
  type MintAuthorityScoreFilterValue,
  type MintAuthorityStatusKind,
} from "@/lib/mint-authority-display";
import {
  GOVERNANCE_LABELS_SHORT,
  MECHANISM_ARCHETYPE_LABELS,
  PEG_METADATA,
} from "@shared/lib/classification";
import { CUSTODY_MODEL_VALUES, GOVERNANCE_TYPE_VALUES, MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";
import type { CustodyModel, GovernanceType, MechanismArchetype, PegCurrency, StablecoinStatus } from "@shared/types";

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

const SAFETY_EVIDENCE_LABELS: Record<SafetyEvidenceValue, string> = {
  strong: "Strong",
  adequate: "Adequate",
  limited: "Limited",
  nr: "NR",
};

const CUSTODY_MODEL_LABELS: Record<CustodyModel, string> = {
  onchain: "On-chain",
  "institutional-top": "Top-tier institution",
  "institutional-regulated": "Regulated institution",
  "institutional-unregulated": "Unregulated institution",
  "institutional-sanctioned": "Sanctioned institution",
  cex: "Exchange",
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

function toggleFilterValue<V>(current: readonly V[], value: V): V[] {
  return current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value];
}

interface ScreenerToolbarProps {
  filters: ScreenerFilters;
  matchingRows: number;
  totalRows: number;
  activeFilterCount: number;
  onChange: (next: ScreenerFilters) => void;
  onReset: () => void;
  rightSlot?: React.ReactNode;
}

export function ScreenerToolbar({
  filters,
  matchingRows,
  totalRows,
  activeFilterCount,
  onChange,
  onReset,
  rightSlot,
}: ScreenerToolbarProps) {
  const groupId = useId();
  const update = useCallback(
    <K extends keyof ScreenerFilters>(key: K, value: ScreenerFilters[K]) => {
      onChange({ ...filters, [key]: value });
    },
    [filters, onChange],
  );

  // M8 — track chip additions per group so newly-active filters spring in
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
  const justEnteredPegs = useJustEntered(filters.pegs);

  const active = hasActiveFilters(filters);
  const filterCountLabel = `${activeFilterCount.toLocaleString()} ${activeFilterCount === 1 ? "filter" : "filters"} applied`;

  return (
    <div className="pharos-card-shell space-y-3 p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0" aria-live="polite">
          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            {/* One Beam: the live matched-coin count is the page's single frost figure. */}
            <span className="pharos-numeric text-2xl font-semibold leading-none text-frost-blue">
              {matchingRows.toLocaleString("en-US")}
            </span>
            <span className="text-sm font-medium text-muted-foreground">
              of <span className="pharos-numeric text-foreground">{totalRows.toLocaleString("en-US")}</span> tracked{" "}
              {active ? "matching" : "— pre-launch and frozen included"}
            </span>
          </p>
          <p className="pharos-meta mt-0.5">{filterCountLabel}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {rightSlot}
          <Button
            variant="ghost"
            size="sm"
            onClick={onReset}
            disabled={!active}
          >
            Reset filters
          </Button>
        </div>
      </div>

      {filters.coins.length > 0 ? (
        <p className="rounded-md border border-frost-blue/25 bg-frost-blue/5 px-3 py-2 text-sm text-foreground">
          Showing the exact {filters.coins.length}-coin Picker shortlist. Reset filters to restore the full universe.
        </p>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.35fr)_minmax(12rem,0.8fr)_minmax(12rem,0.8fr)_minmax(14rem,1fr)]">
        <div className="space-y-2">
          <span className="pharos-kicker" id={`${groupId}-safety-grades`}>
            Safety Grade
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
                  className={`pharos-focus-ring pharos-control-pill px-2.5 py-1 font-semibold ${getSafetyGradeBadgeClassName(grade)} ${isActive ? "opacity-100 ring-1 ring-inset ring-current brightness-110" : "opacity-70"} ${justEnteredSafety.has(grade) ? "pharos-chip-animate-in" : ""}`}
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
          label="V9 Mint Component"
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

      <div className="grid gap-3 md:grid-cols-3">
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
          label="Economic Control"
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
          label="PegScore"
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
          kicker="V9 Evidence"
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
          kicker="Mint Authority Route"
          options={MINT_AUTHORITY_OPTIONS}
          selected={filters.mintAuthority}
          justEntered={justEnteredMintAuthority}
          onChange={(next) => update("mintAuthority", next)}
        />
        <FilterPillGroup
          kicker="V9 Mint Component"
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
      <span className="pharos-kicker" id={labelId}>
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
              className={`pharos-focus-ring pharos-control-pill px-2.5 py-1${
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
      <span className="pharos-kicker" id={`${id}-label`}>
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
