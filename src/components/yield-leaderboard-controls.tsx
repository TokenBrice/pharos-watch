"use client";

import { useId, useState } from "react";
import { ChevronDown, Search, Star, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useYieldWatchlist } from "@/hooks/use-yield-watchlist";
import {
  labelYieldFilterOption,
  type YieldFilterOption,
  type YieldPresetKey,
  type YieldRiskBudgetKey,
  type YieldViewModel,
} from "@/lib/yield-view-model";
import { cn } from "@/lib/utils";

interface YieldLeaderboardControlsProps {
  viewModel: YieldViewModel;
  onFilterChange: (key: string, value: string) => void;
  onClearFilters: () => void;
  onApplyPreset: (presetKey: YieldPresetKey) => void;
  onApplyRiskBudget: (key: YieldRiskBudgetKey) => void;
}

interface ActiveFilterSummary {
  key: string;
  label: string;
}

function findOptionLabel<T extends string>(
  options: ReadonlyArray<YieldFilterOption<T>>,
  value: T | string,
): string {
  return options.find((option) => option.value === value)?.label ?? String(value);
}

function getActiveFilterSummaries(viewModel: YieldViewModel): ActiveFilterSummary[] {
  const { filters, options } = viewModel;
  const summaries: ActiveFilterSummary[] = [];

  if (filters.yieldType !== "all") {
    summaries.push({
      key: "yieldType",
      label: `Type: ${findOptionLabel(options.yieldType, filters.yieldType)}`,
    });
  }
  if (filters.warnings !== "all") {
    summaries.push({
      key: "warnings",
      label: findOptionLabel(options.warnings, filters.warnings),
    });
  }
  if (filters.watchlist === "only") {
    summaries.push({ key: "watchlist", label: "Watching only" });
  }
  if (filters.minSafety !== null) {
    summaries.push({
      key: "minSafety",
      label: findOptionLabel(options.minSafety, String(filters.minSafety)),
    });
  }
  if (filters.minTvl !== null) {
    summaries.push({
      key: "minTvl",
      label: findOptionLabel(options.minTvl, String(filters.minTvl)),
    });
  }
  if (filters.depth !== "all") {
    summaries.push({
      key: "depth",
      label: `Depth: ${findOptionLabel(options.depth, filters.depth)}`,
    });
  }
  if (filters.sourceChanged !== "all") {
    summaries.push({
      key: "sourceChanged",
      label: findOptionLabel(options.sourceChanged, filters.sourceChanged),
    });
  }
  if (filters.sourceConfidence !== "all") {
    summaries.push({
      key: "sourceConfidence",
      label: `Confidence: ${findOptionLabel(options.sourceConfidence, filters.sourceConfidence)}`,
    });
  }
  if (filters.benchmark !== "all") {
    summaries.push({
      key: "benchmark",
      label: `Benchmark: ${findOptionLabel(options.benchmark, filters.benchmark)}`,
    });
  }
  if (filters.opportunity !== "all") {
    summaries.push({
      key: "opportunity",
      label: findOptionLabel(options.opportunity, filters.opportunity),
    });
  }

  return summaries;
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string; count: number }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex min-w-[138px] flex-1 flex-col gap-1 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground sm:max-w-[180px]">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="pharos-focus-ring min-h-11 rounded-lg border border-border/70 bg-background/70 px-2 py-2 text-sm normal-case tracking-normal text-foreground sm:min-h-8 sm:py-1.5"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {labelYieldFilterOption(option)}
          </option>
        ))}
      </select>
    </label>
  );
}

function CurrencyTab({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "pharos-focus-ring min-h-9 shrink-0 rounded-full border px-3 text-xs font-medium transition-colors sm:min-h-8",
        active
          ? "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300"
          : "border-border/70 bg-background/60 text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <span>{label}</span>
      <span
        className={cn(
          "ml-1.5 font-mono text-[10px] tabular-nums",
          active ? "text-sky-700/80 dark:text-sky-300/80" : "text-muted-foreground/80",
        )}
      >
        {count}
      </span>
    </button>
  );
}

function RiskBudgetSlider({
  stops,
  onSelect,
}: {
  stops: YieldViewModel["riskBudget"]["stops"];
  onSelect: (key: YieldRiskBudgetKey) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Risk budget"
      className="flex flex-col gap-2 rounded-xl border border-border/70 bg-background/40 px-3 py-3"
    >
      <div className="flex items-baseline justify-between">
        <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          Risk budget
        </p>
        <p className="text-[10px] text-muted-foreground">Conservative → Aggressive</p>
      </div>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {stops.map((stop) => (
          <button
            key={stop.key}
            type="button"
            onClick={() => onSelect(stop.key)}
            aria-pressed={stop.active}
            data-active={stop.active}
            title={stop.description}
            className={cn(
              "pharos-focus-ring flex min-h-11 flex-col items-center justify-center rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors sm:min-h-10",
              stop.active
                ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90"
                : "border-border/70 bg-background/60 text-foreground hover:bg-muted",
            )}
          >
            <span>{stop.label}</span>
            <span
              className={cn(
                "font-mono text-[10px] tabular-nums",
                stop.active ? "text-primary-foreground/80" : "text-muted-foreground",
              )}
            >
              {stop.count}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function PresetChip({
  label,
  description,
  count,
  active,
  onClick,
}: {
  label: string;
  description: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onClick}
      aria-pressed={active}
      title={description}
      className={cn(
        "h-auto whitespace-normal rounded-full px-3 py-1.5 text-xs font-medium",
        active
          ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
          : "text-foreground",
      )}
    >
      <span>{label}</span>
      <span
        className={cn(
          "ml-1 font-mono text-[10px] tabular-nums",
          active ? "text-primary-foreground/80" : "text-muted-foreground",
        )}
      >
        {count}
      </span>
    </Button>
  );
}

function WatchingPresetChip({
  count,
  active,
  onClick,
}: {
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  const disabled = count === 0;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      aria-disabled={disabled}
      aria-pressed={active}
      data-active={active}
      title={
        disabled
          ? "Star yields on the leaderboard to follow them here"
          : "Show only yields you are watching"
      }
      className={cn(
        "h-auto whitespace-normal rounded-full px-3 py-1.5 text-xs font-medium",
        active
          ? "border-amber-500 bg-amber-500 text-white hover:bg-amber-500/90 hover:text-white"
          : "text-foreground",
        disabled && "cursor-not-allowed opacity-60 hover:bg-transparent hover:text-muted-foreground",
      )}
    >
      <Star
        aria-hidden="true"
        className={cn("h-3 w-3", active ? "fill-white" : "fill-none")}
      />
      <span>Watching</span>
      <span
        className={cn(
          "ml-1 font-mono text-[10px] tabular-nums",
          active ? "text-white/80" : "text-muted-foreground",
        )}
      >
        {count}
      </span>
    </Button>
  );
}

function ActiveFilterPill({
  label,
  onClear,
}: {
  label: string;
  onClear: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClear}
      className="pharos-focus-ring inline-flex min-h-8 items-center gap-1 rounded-full border border-border/70 bg-muted px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/70"
    >
      <span>{label}</span>
      <X aria-hidden="true" className="h-3 w-3 text-muted-foreground" />
      <span className="sr-only">Clear filter</span>
    </button>
  );
}

export function YieldLeaderboardControls({
  viewModel,
  onFilterChange,
  onClearFilters,
  onApplyPreset,
  onApplyRiskBudget,
}: YieldLeaderboardControlsProps) {
  const { filters, options, presets, riskBudget } = viewModel;
  const panelId = useId();
  const currencyTabsId = useId();
  const yieldTypeTabsId = useId();
  const [showFilters, setShowFilters] = useState(false);
  const yieldTypeTabs = options.yieldType.filter((option) => option.count > 0);
  const { ids: watchlistIds } = useYieldWatchlist();
  const watchlistActive = filters.watchlist === "only";

  const activeFilterSummaries = getActiveFilterSummaries(viewModel);
  const activeFilterCount = activeFilterSummaries.length;
  const hasResettableState =
    activeFilterCount > 0 ||
    filters.peg !== "all" ||
    filters.q !== "" ||
    filters.trending !== "all";
  const filtersToggleLabel =
    activeFilterCount > 0 ? `Filters (${activeFilterCount} active)` : "Filters";

  return (
    <div className="space-y-3 rounded-xl border border-border/70 bg-card/80 px-3 py-3">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="relative w-full md:max-w-sm">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={filters.q}
            onChange={(event) => onFilterChange("q", event.target.value)}
            placeholder="Search stablecoin..."
            className="pharos-focus-ring min-h-11 w-full rounded-full border border-border/70 bg-background/70 py-2 pl-8 pr-3 text-sm text-foreground placeholder:text-muted-foreground outline-none sm:min-h-9 sm:py-1.5"
          />
        </div>

        {hasResettableState ? (
          <button
            type="button"
            onClick={onClearFilters}
            className="pharos-focus-ring self-start rounded-full border border-border/70 px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:self-center md:py-1.5"
          >
            Reset
          </button>
        ) : null}
      </div>

      {options.currencyTabs.length > 1 ? (
        <>
          <label className="sr-only" htmlFor={currencyTabsId}>
            Filter by currency
          </label>
          <select
            id={currencyTabsId}
            value={options.currencyTabs.some((option) => option.value === filters.peg) ? filters.peg : "all"}
            onChange={(event) => onFilterChange("peg", event.target.value)}
            className="pharos-focus-ring min-h-11 w-full rounded-lg border border-border/70 bg-background/70 px-2 py-2 text-sm text-foreground sm:hidden"
          >
            {options.currencyTabs.map((option) => (
              <option key={option.value} value={option.value}>
                {`${option.label} (${option.count})`}
              </option>
            ))}
          </select>
          <div
            role="tablist"
            aria-label="Filter by currency"
            className="-mx-1 hidden flex-nowrap items-center gap-1.5 overflow-x-auto px-1 pb-1 sm:flex md:flex-wrap md:overflow-visible md:pb-0"
          >
            {options.currencyTabs.map((option) => (
              <CurrencyTab
                key={option.value}
                label={option.label}
                count={option.count}
                active={filters.peg === option.value}
                onClick={() => onFilterChange("peg", option.value)}
              />
            ))}
          </div>
        </>
      ) : null}

      {yieldTypeTabs.length > 1 ? (
        <div className="border-b border-border/70 pb-3">
          <label className="sr-only" htmlFor={yieldTypeTabsId}>
            Filter by yield type
          </label>
          <select
            id={yieldTypeTabsId}
            value={yieldTypeTabs.some((option) => option.value === filters.yieldType) ? filters.yieldType : "all"}
            onChange={(event) => onFilterChange("yieldType", event.target.value)}
            className="pharos-focus-ring min-h-11 w-full rounded-lg border border-border/70 bg-background/70 px-2 py-2 text-sm text-foreground sm:hidden"
          >
            {yieldTypeTabs.map((option) => (
              <option key={option.value} value={option.value}>
                {`${option.label} (${option.count})`}
              </option>
            ))}
          </select>
          <div
            role="tablist"
            aria-label="Filter by yield type"
            className="-mx-1 hidden flex-nowrap items-center gap-1.5 overflow-x-auto px-1 pb-1 sm:flex md:flex-wrap md:overflow-visible md:pb-0"
          >
            {yieldTypeTabs.map((option) => (
              <CurrencyTab
                key={option.value}
                label={option.label}
                count={option.count}
                active={filters.yieldType === option.value}
                onClick={() => onFilterChange("yieldType", option.value)}
              />
            ))}
          </div>
        </div>
      ) : null}

      <RiskBudgetSlider stops={riskBudget.stops} onSelect={onApplyRiskBudget} />

      <div className="-mx-1 flex flex-nowrap items-center gap-2 overflow-x-auto px-1 pb-1 md:flex-wrap md:overflow-visible md:pb-0">
        <WatchingPresetChip
          count={watchlistIds.size}
          active={watchlistActive}
          onClick={() => onFilterChange("watchlist", watchlistActive ? "all" : "only")}
        />
        {presets.map((preset) => (
          <PresetChip
            key={preset.key}
            label={preset.label}
            description={preset.description}
            count={preset.count}
            active={preset.active}
            onClick={() => onApplyPreset(preset.key)}
          />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setShowFilters((value) => !value)}
          aria-expanded={showFilters}
          aria-controls={panelId}
          className="text-xs font-medium"
        >
          {filtersToggleLabel}
          <ChevronDown
            aria-hidden="true"
            className={cn("h-3.5 w-3.5 transition-transform", showFilters ? "rotate-180" : "rotate-0")}
          />
        </Button>
        {!showFilters
          ? activeFilterSummaries.map((summary) => (
              <ActiveFilterPill
                key={summary.key}
                label={summary.label}
                onClear={() => onFilterChange(summary.key, "all")}
              />
            ))
          : null}
      </div>

      {showFilters ? (
        <div id={panelId} className="flex flex-wrap items-end gap-2">
          <FilterSelect
            label="Type"
            value={filters.yieldType}
            options={options.yieldType}
            onChange={(value) => onFilterChange("yieldType", value)}
          />
          <FilterSelect
            label="Warnings"
            value={filters.warnings}
            options={options.warnings}
            onChange={(value) => onFilterChange("warnings", value)}
          />
          <FilterSelect
            label="Safety"
            value={filters.minSafety === null ? "all" : String(filters.minSafety)}
            options={options.minSafety}
            onChange={(value) => onFilterChange("minSafety", value)}
          />
          <FilterSelect
            label="TVL"
            value={filters.minTvl === null ? "all" : String(filters.minTvl)}
            options={options.minTvl}
            onChange={(value) => onFilterChange("minTvl", value)}
          />
          <FilterSelect
            label="Depth"
            value={filters.depth}
            options={options.depth}
            onChange={(value) => onFilterChange("depth", value)}
          />
          <FilterSelect
            label="Source changed"
            value={filters.sourceChanged}
            options={options.sourceChanged}
            onChange={(value) => onFilterChange("sourceChanged", value)}
          />
          <FilterSelect
            label="Confidence"
            value={filters.sourceConfidence}
            options={options.sourceConfidence}
            onChange={(value) => onFilterChange("sourceConfidence", value)}
          />
          <FilterSelect
            label="Benchmark"
            value={filters.benchmark}
            options={options.benchmark}
            onChange={(value) => onFilterChange("benchmark", value)}
          />
          <FilterSelect
            label="Opportunity"
            value={filters.opportunity}
            options={options.opportunity}
            onChange={(value) => onFilterChange("opportunity", value)}
          />
        </div>
      ) : null}
    </div>
  );
}
