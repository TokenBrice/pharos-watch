"use client";

import { type ReactNode, useId, useState } from "react";
import { ChevronDown, Search, Star, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWatchlist } from "@/hooks/use-watchlist";
import {
  getActiveFilterSummaries,
  labelYieldFilterOption,
  type YieldPresetKey,
  type YieldViewModel,
} from "@/lib/yield-view-model";
import { cn } from "@/lib/utils";

interface YieldLeaderboardControlsProps {
  viewModel: YieldViewModel;
  onFilterChange: (key: string, value: string) => void;
  onClearFilters: () => void;
  onApplyPreset: (presetKey: YieldPresetKey) => void;
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

function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">
        {label}
      </span>
      <div className="flex flex-wrap items-end gap-2">{children}</div>
    </div>
  );
}

type FilterTabTone =
  | "brand"
  | "neutral"
  | "emerald"
  | "sky"
  | "orange"
  | "purple"
  | "cyan"
  | "amber"
  | "rose";

// Selected/unselected variants per tone. Classes must be static strings so
// Tailwind's purge can see them.
const TONE_STYLES: Record<FilterTabTone, { active: string; inactive: string }> = {
  brand: {
    active: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    inactive: "border-border/70 bg-background/60 text-muted-foreground hover:bg-muted hover:text-foreground",
  },
  neutral: {
    active: "border-foreground/40 bg-foreground/10 text-foreground font-semibold",
    inactive: "border-border/70 bg-background/60 text-muted-foreground hover:bg-muted hover:text-foreground",
  },
  emerald: {
    active: "border-emerald-500/60 bg-emerald-500/20 text-emerald-700 dark:text-emerald-200 font-semibold",
    inactive: "border-emerald-500/25 bg-emerald-500/5 text-emerald-700/80 hover:bg-emerald-500/10 dark:text-emerald-400/90",
  },
  sky: {
    active: "border-sky-500/60 bg-sky-500/20 text-sky-700 dark:text-sky-200 font-semibold",
    inactive: "border-sky-500/25 bg-sky-500/5 text-sky-700/80 hover:bg-sky-500/10 dark:text-sky-400/90",
  },
  orange: {
    active: "border-orange-500/60 bg-orange-500/20 text-orange-700 dark:text-orange-200 font-semibold",
    inactive: "border-orange-500/25 bg-orange-500/5 text-orange-700/80 hover:bg-orange-500/10 dark:text-orange-400/90",
  },
  purple: {
    active: "border-purple-500/60 bg-purple-500/20 text-purple-700 dark:text-purple-200 font-semibold",
    inactive: "border-purple-500/25 bg-purple-500/5 text-purple-700/80 hover:bg-purple-500/10 dark:text-purple-400/90",
  },
  cyan: {
    active: "border-cyan-500/60 bg-cyan-500/20 text-cyan-700 dark:text-cyan-200 font-semibold",
    inactive: "border-cyan-500/25 bg-cyan-500/5 text-cyan-700/80 hover:bg-cyan-500/10 dark:text-cyan-400/90",
  },
  amber: {
    active: "border-amber-500/60 bg-amber-500/20 text-amber-700 dark:text-amber-200 font-semibold",
    inactive: "border-amber-500/25 bg-amber-500/5 text-amber-700/80 hover:bg-amber-500/10 dark:text-amber-400/90",
  },
  rose: {
    active: "border-rose-500/60 bg-rose-500/20 text-rose-700 dark:text-rose-200 font-semibold",
    inactive: "border-rose-500/25 bg-rose-500/5 text-rose-700/80 hover:bg-rose-500/10 dark:text-rose-400/90",
  },
};

// Mirrors YIELD_TYPE_STYLES in shared/lib/classification/badges.ts so each
// yield-type tab wears the same hue as its badge elsewhere in the app.
const YIELD_TYPE_TONE: Record<string, FilterTabTone> = {
  "nav-appreciation": "emerald",
  "lending-opportunity": "sky",
  "fixed-yield": "brand",
  "lending-vault": "orange",
  "governance-set": "orange",
  rebase: "purple",
  "fee-sharing": "cyan",
  "lp-receipt": "amber",
  "structured-tranche": "rose",
};

function FilterTab({
  label,
  count,
  active,
  onClick,
  tone = "brand",
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  tone?: FilterTabTone;
}) {
  const variant = TONE_STYLES[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "pharos-focus-ring min-h-9 shrink-0 rounded-full border px-3 text-xs font-medium transition-colors sm:min-h-8",
        active ? variant.active : variant.inactive,
      )}
    >
      <span>{label}</span>
      <span className="ml-1.5 font-mono text-[10px] tabular-nums opacity-70">{count}</span>
    </button>
  );
}

function ViewLink({
  label,
  description,
  count,
  active,
  onClick,
  leadingIcon,
  dataActive,
}: {
  label: string;
  description: string;
  count: number;
  active: boolean;
  onClick: () => void;
  leadingIcon?: ReactNode;
  dataActive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={description}
      {...(dataActive !== undefined ? { "data-active": String(dataActive) } : {})}
      className={cn(
        "pharos-focus-ring inline-flex min-h-8 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-foreground/10 text-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {leadingIcon}
      <span>{label}</span>
      <span
        className={cn(
          "font-mono text-[10px] tabular-nums",
          active ? "text-foreground/70" : "text-muted-foreground/70",
        )}
      >
        {count}
      </span>
    </button>
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
}: YieldLeaderboardControlsProps) {
  const { filters, options, presets } = viewModel;
  const panelId = useId();
  const currencyTabsId = useId();
  const yieldTypeTabsId = useId();
  const [showFilters, setShowFilters] = useState(false);
  const yieldTypeTabs = options.yieldType.filter((option) => option.count > 0);
  const { idSet: watchlistIds } = useWatchlist();
  const watchlistActive = filters.watchlist === "only";
  const showWatching = watchlistIds.size > 0;

  const activeFilterSummaries = getActiveFilterSummaries(viewModel);
  const activeFilterCount = activeFilterSummaries.length;
  const hasResettableState =
    activeFilterCount > 0 ||
    filters.peg !== "all" ||
    filters.q !== "" ||
    filters.trending !== "all";
  const filtersToggleLabel =
    activeFilterCount > 0 ? `Filters (${activeFilterCount} active)` : "Filters";
  const activePreset = presets.find((preset) => preset.active);

  return (
    <div className="space-y-3 border-b border-border/60 pb-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full min-w-[200px] flex-1 sm:max-w-md">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input
            type="search"
            aria-label="Search yield opportunities"
            value={filters.q}
            onChange={(event) => onFilterChange("q", event.target.value)}
            placeholder="Search stablecoin..."
            className="pharos-focus-ring min-h-11 w-full rounded-full border border-border/70 bg-background/70 py-2 pl-8 pr-3 text-sm text-foreground placeholder:text-muted-foreground outline-none sm:min-h-9 sm:py-1.5"
          />
        </div>

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

        {hasResettableState ? (
          <button
            type="button"
            onClick={onClearFilters}
            className="pharos-focus-ring ml-auto rounded-full border border-border/70 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            Reset
          </button>
        ) : null}
      </div>

      {options.currencyTabs.length > 1 || yieldTypeTabs.length > 1 ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
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
                role="group"
                aria-label="Filter by currency"
                className="hidden flex-wrap items-center gap-1.5 sm:flex"
              >
                {options.currencyTabs.map((option) => (
                  <FilterTab
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

          {options.currencyTabs.length > 1 && yieldTypeTabs.length > 1 ? (
            <div aria-hidden="true" className="hidden h-6 w-px bg-border/60 sm:block" />
          ) : null}

          {yieldTypeTabs.length > 1 ? (
            <>
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
                role="group"
                aria-label="Filter by yield type"
                className="hidden flex-wrap items-center gap-1.5 sm:flex"
              >
                {yieldTypeTabs.map((option) => {
                  const tone: FilterTabTone =
                    option.value === "all" ? "neutral" : (YIELD_TYPE_TONE[option.value] ?? "neutral");
                  return (
                    <FilterTab
                      key={option.value}
                      label={option.label}
                      count={option.count}
                      active={filters.yieldType === option.value}
                      onClick={() => onFilterChange("yieldType", option.value)}
                      tone={tone}
                    />
                  );
                })}
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="-mx-1 flex flex-wrap items-center gap-x-1 gap-y-1 px-1">
        <span className="mr-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">
          Views
        </span>
        {showWatching ? (
          <ViewLink
            label="Watching"
            description="Show only yields you are watching"
            count={watchlistIds.size}
            active={watchlistActive}
            dataActive={watchlistActive}
            onClick={() => onFilterChange("watchlist", watchlistActive ? "all" : "only")}
            leadingIcon={
              <Star
                aria-hidden="true"
                className={cn("h-3 w-3", watchlistActive ? "fill-amber-500 text-amber-500" : "fill-none")}
              />
            }
          />
        ) : null}
        {presets.map((preset) => (
          <ViewLink
            key={preset.key}
            label={preset.label}
            description={preset.description}
            count={preset.count}
            active={preset.active}
            onClick={() => onApplyPreset(preset.key)}
          />
        ))}
      </div>

      {activePreset ? (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{activePreset.label}:</span>{" "}
          {activePreset.description}
        </p>
      ) : null}

      {showFilters ? (
        <div id={panelId} className="flex flex-wrap items-start gap-x-6 gap-y-4 pt-1">
          <FilterGroup label="Safety & risk">
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
              label="Depth"
              value={filters.depth}
              options={options.depth}
              onChange={(value) => onFilterChange("depth", value)}
            />
          </FilterGroup>
          <FilterGroup label="Source quality">
            <FilterSelect
              label="Confidence"
              value={filters.sourceConfidence}
              options={options.sourceConfidence}
              onChange={(value) => onFilterChange("sourceConfidence", value)}
            />
            <FilterSelect
              label="Source changed"
              value={filters.sourceChanged}
              options={options.sourceChanged}
              onChange={(value) => onFilterChange("sourceChanged", value)}
            />
            <FilterSelect
              label="Posture"
              value={filters.sourcePosture}
              options={options.sourcePosture}
              onChange={(value) => onFilterChange("sourcePosture", value)}
            />
          </FilterGroup>
          <FilterGroup label="Yield framing">
            <FilterSelect
              label="TVL"
              value={filters.minTvl === null ? "all" : String(filters.minTvl)}
              options={options.minTvl}
              onChange={(value) => onFilterChange("minTvl", value)}
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
          </FilterGroup>
        </div>
      ) : null}
    </div>
  );
}
