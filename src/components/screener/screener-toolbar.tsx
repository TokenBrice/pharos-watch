"use client";

import { useCallback, useId } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Button } from "@/components/ui/button";
import { getSafetyGradeBadgeClassName } from "@/lib/report-card-ui";
import {
  BLACKLISTABLE_VALUES,
  PEG_VALUES,
  SAFETY_GRADE_VALUES,
  SCREENER_FILTER_DEFAULTS,
  hasActiveFilters,
  type BlacklistableValue,
  type ScreenerFilters,
} from "@/app/screener/screener-filters";
import {
  GOVERNANCE_LABELS_SHORT,
  MECHANISM_ARCHETYPE_LABELS,
  PEG_METADATA,
} from "@shared/lib/classification";
import { GOVERNANCE_TYPE_VALUES, MECHANISM_ARCHETYPE_VALUES, STABLECOIN_STATUS_VALUES } from "@shared/types/core";
import type { GovernanceType, MechanismArchetype, PegCurrency, StablecoinStatus } from "@shared/types";

const LIFECYCLE_LABELS: Record<StablecoinStatus, string> = {
  active: "Active",
  "pre-launch": "Pre-launch",
  frozen: "Frozen",
};

const BLACKLISTABLE_LABELS: Record<BlacklistableValue, string> = {
  yes: "Yes",
  no: "No",
  possible: "Possible",
  dilutable: "Dilutable",
};

interface ScreenerToolbarProps {
  filters: ScreenerFilters;
  matchSummary: string;
  activeFilterCount: number;
  onChange: (next: ScreenerFilters) => void;
  onReset: () => void;
  rightSlot?: React.ReactNode;
}

export function ScreenerToolbar({
  filters,
  matchSummary,
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

  const active = hasActiveFilters(filters);
  const filterCountLabel = `${activeFilterCount.toLocaleString()} ${activeFilterCount === 1 ? "filter" : "filters"} applied`;

  return (
    <div className="space-y-4 rounded-2xl border border-border/60 bg-card/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-base font-semibold text-foreground" aria-live="polite">
          <span>{matchSummary}</span>
          <span className="text-sm font-medium text-muted-foreground">
            {filterCountLabel}
          </span>
        </p>
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

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(12rem,0.8fr)_minmax(14rem,1fr)]">
        <div className="space-y-2">
          <span className="pharos-kicker" id={`${groupId}-safety-grades`}>
            Safety Grade
          </span>
          <ToggleGroup
            type="multiple"
            variant="outline"
            size="sm"
            className="w-full flex-wrap justify-start"
            value={filters.safetyGrades as string[]}
            onValueChange={(v) => update("safetyGrades", v as typeof filters.safetyGrades)}
            aria-labelledby={`${groupId}-safety-grades`}
          >
            {SAFETY_GRADE_VALUES.map((grade) => (
              <ToggleGroupItem
                key={grade}
                value={grade}
                className={`min-h-11 font-semibold sm:min-h-8 ${getSafetyGradeBadgeClassName(grade)}`}
              >
                {grade}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
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
          label="Supply (USD)"
          min={0}
          step={1_000_000}
          minValue={filters.supplyMin}
          onMinChange={(v) => update("supplyMin", v)}
          defaultMin={0}
          placeholder="No threshold"
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <ThresholdField
          label="Peg Stability"
          min={0}
          max={100}
          step={1}
          minValue={filters.safetyPegStabilityMin}
          onMinChange={(v) => update("safetyPegStabilityMin", v)}
          defaultMin={SCREENER_FILTER_DEFAULTS.safetyPegStabilityMin}
        />
        <ThresholdField
          label="Exit Liquidity"
          min={0}
          max={100}
          step={1}
          minValue={filters.safetyLiquidityMin}
          onMinChange={(v) => update("safetyLiquidityMin", v)}
          defaultMin={SCREENER_FILTER_DEFAULTS.safetyLiquidityMin}
        />
        <ThresholdField
          label="Resilience"
          min={0}
          max={100}
          step={1}
          minValue={filters.safetyResilienceMin}
          onMinChange={(v) => update("safetyResilienceMin", v)}
          defaultMin={SCREENER_FILTER_DEFAULTS.safetyResilienceMin}
        />
        <ThresholdField
          label="Decentralization"
          min={0}
          max={100}
          step={1}
          minValue={filters.safetyDecentralizationMin}
          onMinChange={(v) => update("safetyDecentralizationMin", v)}
          defaultMin={SCREENER_FILTER_DEFAULTS.safetyDecentralizationMin}
        />
        <ThresholdField
          label="Dependency Risk"
          min={0}
          max={100}
          step={1}
          minValue={filters.safetyDependencyRiskMin}
          onMinChange={(v) => update("safetyDependencyRiskMin", v)}
          defaultMin={SCREENER_FILTER_DEFAULTS.safetyDependencyRiskMin}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,0.7fr)_minmax(0,1.45fr)_minmax(0,0.95fr)_minmax(0,0.75fr)]">
        <div className="space-y-2">
          <span className="pharos-kicker" id={`${groupId}-types`}>
            Type
          </span>
          <ToggleGroup
            type="multiple"
            variant="outline"
            size="sm"
            className="w-full flex-wrap justify-start"
            value={filters.types as string[]}
            onValueChange={(v) => update("types", v as GovernanceType[])}
            aria-labelledby={`${groupId}-types`}
          >
            {GOVERNANCE_TYPE_VALUES.map((type) => (
              <ToggleGroupItem
                key={type}
                value={type}
                className="min-h-11 sm:min-h-8"
              >
                {GOVERNANCE_LABELS_SHORT[type]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>

        <div className="space-y-2">
          <span className="pharos-kicker" id={`${groupId}-mechanisms`}>
            Mechanism
          </span>
          <ToggleGroup
            type="multiple"
            variant="outline"
            size="sm"
            className="w-full flex-wrap justify-start"
            value={filters.mechanisms as string[]}
            onValueChange={(v) => update("mechanisms", v as MechanismArchetype[])}
            aria-labelledby={`${groupId}-mechanisms`}
          >
            {MECHANISM_ARCHETYPE_VALUES.map((archetype) => (
              <ToggleGroupItem
                key={archetype}
                value={archetype}
                className="min-h-11 sm:min-h-8"
              >
                {MECHANISM_ARCHETYPE_LABELS[archetype]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>

        <div className="space-y-2">
          <span className="pharos-kicker" id={`${groupId}-blacklistable`}>
            Blacklistable
          </span>
          <ToggleGroup
            type="multiple"
            variant="outline"
            size="sm"
            className="w-full flex-wrap justify-start"
            value={filters.blacklistable as string[]}
            onValueChange={(v) => update("blacklistable", v as BlacklistableValue[])}
            aria-labelledby={`${groupId}-blacklistable`}
          >
            {BLACKLISTABLE_VALUES.map((bucket) => (
              <ToggleGroupItem
                key={bucket}
                value={bucket}
                className="min-h-11 sm:min-h-8"
              >
                {BLACKLISTABLE_LABELS[bucket]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>

        <div className="space-y-2">
          <span className="pharos-kicker" id={`${groupId}-lifecycle`}>
            Lifecycle
          </span>
          <ToggleGroup
            type="multiple"
            variant="outline"
            size="sm"
            className="w-full flex-wrap justify-start"
            value={filters.lifecycle as string[]}
            onValueChange={(v) => update("lifecycle", v as StablecoinStatus[])}
            aria-labelledby={`${groupId}-lifecycle`}
          >
            {STABLECOIN_STATUS_VALUES.map((status) => (
              <ToggleGroupItem
                key={status}
                value={status}
                className="min-h-11 sm:min-h-8"
              >
                {LIFECYCLE_LABELS[status]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </div>

      <div className="space-y-2">
        <span className="pharos-kicker" id={`${groupId}-pegs`}>
          Peg
        </span>
        <ToggleGroup
          type="multiple"
          variant="outline"
          size="sm"
          className="w-full flex-wrap justify-start"
          value={filters.pegs as string[]}
          onValueChange={(v) => update("pegs", v as PegCurrency[])}
          aria-labelledby={`${groupId}-pegs`}
        >
          {PEG_VALUES.map((peg) => (
            <ToggleGroupItem
              key={peg}
              value={peg}
              className="min-h-11 sm:min-h-8"
              title={PEG_METADATA[peg].label}
            >
              {PEG_METADATA[peg].filterLabel}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
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
          &gt;
        </span>
        <label htmlFor={inputId} className="sr-only">
          {label} greater than
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
          className="pharos-focus-ring w-full rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm tabular-nums"
        />
      </div>
    </div>
  );
}
