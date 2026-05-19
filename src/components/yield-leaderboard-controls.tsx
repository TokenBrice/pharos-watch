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

const RISK_BUDGET_STYLES: Record<
  YieldRiskBudgetKey,
  { dot: string; dotBorder: string; trackFill: string; text: string; activeCount: string }
> = {
  conservative: {
    dot: "bg-emerald-500",
    dotBorder: "border-emerald-500",
    trackFill: "bg-emerald-500/70",
    text: "text-emerald-700 dark:text-emerald-300",
    activeCount: "text-emerald-700/80 dark:text-emerald-300/80",
  },
  balanced: {
    dot: "bg-sky-500",
    dotBorder: "border-sky-500",
    trackFill: "bg-sky-500/70",
    text: "text-sky-700 dark:text-sky-300",
    activeCount: "text-sky-700/80 dark:text-sky-300/80",
  },
  opportunistic: {
    dot: "bg-amber-500",
    dotBorder: "border-amber-500",
    trackFill: "bg-amber-500/70",
    text: "text-amber-700 dark:text-amber-300",
    activeCount: "text-amber-700/80 dark:text-amber-300/80",
  },
  aggressive: {
    dot: "bg-orange-600",
    dotBorder: "border-orange-600",
    trackFill: "bg-orange-600/70",
    text: "text-orange-700 dark:text-orange-300",
    activeCount: "text-orange-700/80 dark:text-orange-300/80",
  },
};

function RiskBudgetSlider({
  stops,
  onSelect,
}: {
  stops: YieldViewModel["riskBudget"]["stops"];
  onSelect: (key: YieldRiskBudgetKey) => void;
}) {
  const activeIndex = stops.findIndex((stop) => stop.active);
  const activeStop = activeIndex >= 0 ? stops[activeIndex] : null;
  const activeStyle = activeStop ? RISK_BUDGET_STYLES[activeStop.key] : null;
  const stopCount = stops.length;
  // WHY: track endpoints sit at the dot centers, which are inset by half the dot
  // width (10px). Fill progresses from the first dot to the active dot.
  const fillPercentage = stopCount <= 1 || activeIndex < 0 ? 0 : (activeIndex / (stopCount - 1)) * 100;
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
      <div className="relative px-2.5 pt-3 pb-1">
        {/* Background track — runs through the center of the dot row */}
        <div
          aria-hidden="true"
          className="absolute left-[1.125rem] right-[1.125rem] top-[1.375rem] h-1 -translate-y-1/2 rounded-full bg-border/60"
        />
        {/* Colored fill from the first dot up to the active dot */}
        {activeStyle ? (
          <div
            aria-hidden="true"
            className={cn(
              "absolute left-[1.125rem] top-[1.375rem] h-1 -translate-y-1/2 rounded-full transition-all",
              activeStyle.trackFill,
            )}
            style={{ width: `calc((100% - 2.25rem) * ${fillPercentage / 100})` }}
          />
        ) : null}
        <div className="relative flex justify-between">
          {stops.map((stop) => {
            const style = RISK_BUDGET_STYLES[stop.key];
            return (
              <button
                key={stop.key}
                type="button"
                onClick={() => onSelect(stop.key)}
                aria-pressed={stop.active}
                data-active={stop.active}
                title={stop.description}
                className={cn(
                  "pharos-focus-ring group inline-flex flex-col items-center gap-1 rounded-md px-1 py-0.5 transition-colors",
                  stop.active ? style.text : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "inline-flex h-5 w-5 items-center justify-center rounded-full border-2 bg-background transition-all group-hover:scale-110",
                    stop.active ? style.dotBorder : "border-border/70 group-hover:border-foreground",
                  )}
                >
                  <span className={cn("h-2.5 w-2.5 rounded-full", stop.active ? style.dot : "bg-transparent")} />
                </span>
                <span className={cn("text-[11px]", stop.active ? "font-semibold" : "font-medium")}>
                  {stop.label}
                </span>
                <span
                  className={cn(
                    "font-mono text-[10px] tabular-nums",
                    stop.active ? style.activeCount : "text-muted-foreground/80",
                  )}
                >
                  {stop.count}
                </span>
              </button>
            );
          })}
        </div>
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
