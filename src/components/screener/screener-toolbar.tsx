"use client";

import { useCallback, useId } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Button } from "@/components/ui/button";
import {
  BLACKLISTABLE_VALUES,
  PEG_VALUES,
  SCREENER_FILTER_DEFAULTS,
  hasActiveFilters,
  type BlacklistableValue,
  type ScreenerFilters,
} from "@/app/screener/screener-filters";
import {
  MECHANISM_ARCHETYPE_LABELS,
  PEG_METADATA,
} from "@shared/lib/classification";
import { MECHANISM_ARCHETYPE_VALUES, STABLECOIN_STATUS_VALUES } from "@shared/types/core";
import type { MechanismArchetype, PegCurrency, StablecoinStatus } from "@shared/types";

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
  onChange: (next: ScreenerFilters) => void;
  onReset: () => void;
  resultCount: number;
  totalCount: number;
  rightSlot?: React.ReactNode;
}

export function ScreenerToolbar({
  filters,
  onChange,
  onReset,
  resultCount,
  totalCount,
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

  return (
    <div className="space-y-4 rounded-2xl border border-border/60 bg-card/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground" aria-live="polite">
          Showing <span className="font-mono text-foreground">{resultCount}</span>
          {" "}of{" "}
          <span className="font-mono text-foreground">{totalCount}</span> stablecoins.
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

      <div className="grid gap-4 lg:grid-cols-2">
        <RangeField
          label="Peg Score"
          min={0}
          max={100}
          step={1}
          minValue={filters.pegScoreMin}
          maxValue={filters.pegScoreMax}
          onMinChange={(v) => update("pegScoreMin", v)}
          onMaxChange={(v) => update("pegScoreMax", v)}
          defaultMin={SCREENER_FILTER_DEFAULTS.pegScoreMin}
          defaultMax={SCREENER_FILTER_DEFAULTS.pegScoreMax}
        />
        <RangeField
          label="DEWS Stress"
          min={0}
          max={100}
          step={1}
          minValue={filters.dewsMin}
          maxValue={filters.dewsMax}
          onMinChange={(v) => update("dewsMin", v)}
          onMaxChange={(v) => update("dewsMax", v)}
          defaultMin={SCREENER_FILTER_DEFAULTS.dewsMin}
          defaultMax={SCREENER_FILTER_DEFAULTS.dewsMax}
        />
        <RangeField
          label="Liquidity Score"
          min={0}
          max={100}
          step={1}
          minValue={filters.liquidityMin}
          maxValue={filters.liquidityMax}
          onMinChange={(v) => update("liquidityMin", v)}
          onMaxChange={(v) => update("liquidityMax", v)}
          defaultMin={SCREENER_FILTER_DEFAULTS.liquidityMin}
          defaultMax={SCREENER_FILTER_DEFAULTS.liquidityMax}
        />
        <RangeField
          label="Supply (USD)"
          min={0}
          step={1_000_000}
          minValue={filters.supplyMin}
          maxValue={filters.supplyMax}
          onMinChange={(v) => update("supplyMin", v)}
          onMaxChange={(v) => update("supplyMax", v)}
          defaultMin={0}
          defaultMax={0}
          minPlaceholder="0"
          maxPlaceholder="No max"
        />
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
    </div>
  );
}

interface RangeFieldProps {
  label: string;
  min: number;
  max?: number;
  step?: number;
  minValue: number;
  maxValue: number;
  onMinChange: (value: number) => void;
  onMaxChange: (value: number) => void;
  defaultMin: number;
  defaultMax: number;
  minPlaceholder?: string;
  maxPlaceholder?: string;
}

function RangeField({
  label,
  min,
  max,
  step = 1,
  minValue,
  maxValue,
  onMinChange,
  onMaxChange,
  defaultMin,
  defaultMax,
  minPlaceholder,
  maxPlaceholder,
}: RangeFieldProps) {
  const id = useId();
  const minId = `${id}-min`;
  const maxId = `${id}-max`;

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
      <div className="flex items-center gap-2">
        <label htmlFor={minId} className="sr-only">
          {label} minimum
        </label>
        <input
          id={minId}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={step}
          value={minValue || ""}
          placeholder={minPlaceholder ?? String(defaultMin)}
          onChange={(e) => onMinChange(parseValue(e.target.value, defaultMin))}
          className="pharos-focus-ring w-full rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm tabular-nums"
        />
        <span className="text-xs text-muted-foreground" aria-hidden="true">
          –
        </span>
        <label htmlFor={maxId} className="sr-only">
          {label} maximum
        </label>
        <input
          id={maxId}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={step}
          value={maxValue || ""}
          placeholder={maxPlaceholder ?? String(defaultMax)}
          onChange={(e) => onMaxChange(parseValue(e.target.value, defaultMax))}
          className="pharos-focus-ring w-full rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm tabular-nums"
        />
      </div>
    </div>
  );
}
