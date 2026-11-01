"use client";

import { type ReactNode, useId, useState } from "react";
import { AlertTriangle, ChevronDown, Search, Star, X } from "lucide-react";
import {
  getActiveFilterSummaries,
  type YieldPresetKey,
  type YieldViewModel,
} from "@/lib/yield-view-model";
import { cn } from "@/lib/utils";

interface YieldLeaderboardControlsProps {
  viewModel: YieldViewModel;
  /** Whether the URL carries an explicit filter param; the landing band alone is not resettable. */
  hasExplicitFilterParams: boolean;
  onFilterChange: (key: string, value: string) => void;
  onClearFilters: () => void;
  onApplyPreset: (presetKey: YieldPresetKey) => void;
}

// Pill primitive shared by every yield filter control. Frost stays out of
// controls: active reads as the near-black control-ink fill from the design
// system, at-rest is muted-on-translucent. `aria-pressed` + adjacent
// label/count text are load-bearing for the controls tests.
function ChipButton({
  label,
  count,
  active,
  onClick,
  title,
  ariaPressed,
  dataActive,
  leadingIcon,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
  title?: string;
  ariaPressed?: boolean;
  dataActive?: boolean;
  leadingIcon?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={ariaPressed ?? active}
      {...(dataActive !== undefined ? { "data-active": String(dataActive) } : {})}
      className={cn(
        "pharos-control-pill pharos-focus-ring shrink-0 gap-1",
        active && "pharos-control-pill-active",
      )}
    >
      {leadingIcon}
      <span>{label}</span>
      {count !== undefined ? (
        <span
          className={cn(
            "pharos-numeric text-3xs",
            active ? "opacity-80" : "opacity-70",
          )}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

function FilterFacet({
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
    <div className="flex min-w-[160px] flex-col gap-1.5">
      <span className="pharos-label">
        {label}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => {
          const active = option.value === value;
          return (
            <ChipButton
              key={option.value}
              label={option.label}
              count={option.count}
              active={active}
              onClick={() => onChange(option.value)}
            />
          );
        })}
      </div>
    </div>
  );
}

function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5">
      <span className="pharos-label">
        {label}
      </span>
      <div className="flex flex-wrap items-start gap-x-6 gap-y-4">{children}</div>
    </div>
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
      className="pharos-control-pill pharos-focus-ring gap-1 text-foreground"
    >
      <span>{label}</span>
      <X aria-hidden="true" className="h-3 w-3 text-muted-foreground" />
      <span className="sr-only">Clear filter</span>
    </button>
  );
}

export function YieldLeaderboardControls({
  viewModel,
  hasExplicitFilterParams,
  onFilterChange,
  onClearFilters,
  onApplyPreset,
}: YieldLeaderboardControlsProps) {
  const { filters, options, presets } = viewModel;
  const panelId = useId();
  const [showFilters, setShowFilters] = useState(false);
  const yieldTypeTabs = options.yieldType.filter((option) => option.count > 0);
  // Counts come from the stacked view model, so a chip never promises rows its
  // click cannot produce (the landing band hides warning rows).
  const watchlistCount = options.watchlist.find((option) => option.value === "only")?.count ?? 0;
  const watchlistActive = filters.watchlist === "only";
  const attentionPreset = presets.find((preset) => preset.key === "watchlist-warnings");
  const attentionCount = attentionPreset?.count ?? 0;
  const attentionActive = attentionPreset?.active ?? false;
  const showWatching = watchlistCount > 0 || watchlistActive;
  // The gated icon chip above already applies this preset; rendering the preset
  // chip too would put two identical controls in the same views row.
  const visiblePresets = presets.filter((preset) => preset.key !== "watchlist-warnings");

  const activeFilterSummaries = getActiveFilterSummaries(viewModel);
  const activeFilterCount = activeFilterSummaries.length;
  const filtersToggleLabel =
    activeFilterCount > 0 ? `Filters (${activeFilterCount} active)` : "Filters";
  const activePreset = presets.find((preset) => preset.active);

  return (
    <div className="space-y-3 border-b border-border/60 pb-4">
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

        <button
          type="button"
          onClick={() => setShowFilters((value) => !value)}
          aria-expanded={showFilters}
          aria-controls={panelId}
          className={cn(
            "pharos-control-pill pharos-focus-ring gap-1.5",
            showFilters && "pharos-control-pill-active",
          )}
        >
          <span>{filtersToggleLabel}</span>
          <ChevronDown
            aria-hidden="true"
            className={cn("h-3.5 w-3.5 transition-transform", showFilters ? "rotate-180" : "rotate-0")}
          />
        </button>

        {!showFilters
          ? activeFilterSummaries.map((summary) => (
              <ActiveFilterPill
                key={summary.key}
                label={summary.label}
                onClear={() => onFilterChange(summary.key, "all")}
              />
            ))
          : null}

        {hasExplicitFilterParams ? (
          <button
            type="button"
            onClick={onClearFilters}
            className="pharos-control-pill pharos-focus-ring ml-auto text-muted-foreground"
          >
            Reset
          </button>
        ) : null}
      </div>

      {options.currencyTabs.length > 1 || yieldTypeTabs.length > 1 ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {options.currencyTabs.length > 1 ? (
            <div
              role="group"
              aria-label="Filter by currency"
              className="flex flex-wrap items-center gap-1.5"
            >
              {options.currencyTabs.map((option) => (
                <ChipButton
                  key={option.value}
                  label={option.label}
                  count={option.count}
                  active={filters.peg === option.value}
                  onClick={() => onFilterChange("peg", option.value)}
                />
              ))}
            </div>
          ) : null}

          {options.currencyTabs.length > 1 && yieldTypeTabs.length > 1 ? (
            <div aria-hidden="true" className="hidden h-6 w-px bg-border/60 sm:block" />
          ) : null}

          {yieldTypeTabs.length > 1 ? (
            <div
              role="group"
              aria-label="Filter by yield type"
              className="flex flex-wrap items-center gap-1.5"
            >
              {yieldTypeTabs.map((option) => (
                <ChipButton
                  key={option.value}
                  label={option.label}
                  count={option.count}
                  active={filters.yieldType === option.value}
                  onClick={() => onFilterChange("yieldType", option.value)}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="-mx-1 flex flex-wrap items-center gap-x-1.5 gap-y-1.5 px-1">
        <span className="mr-1 pharos-label">
          Views
        </span>
        {showWatching ? (
          <>
            <ChipButton
              label="Watching"
              count={watchlistCount}
              active={watchlistActive}
              ariaPressed={watchlistActive}
              dataActive={watchlistActive}
              title="Show only yields you are watching"
              onClick={() => onFilterChange("watchlist", watchlistActive ? "all" : "only")}
              leadingIcon={
                <Star
                  aria-hidden="true"
                  className={cn("h-3 w-3", watchlistActive ? "fill-state-warn-solid text-state-warn-solid" : "fill-none")}
                />
              }
            />
            <ChipButton
              label="Needs attention"
              count={attentionCount}
              active={attentionActive}
              ariaPressed={attentionActive}
              dataActive={attentionActive}
              title="Show watched yields with warnings or source changes"
              onClick={() => onApplyPreset("watchlist-warnings")}
              leadingIcon={
                <AlertTriangle
                  aria-hidden="true"
                  className={cn("h-3 w-3", attentionActive ? "fill-state-warn-solid text-state-warn-solid" : "fill-none")}
                />
              }
            />
          </>
        ) : null}
        {visiblePresets.map((preset) => (
          <ChipButton
            key={preset.key}
            label={preset.label}
            count={preset.count}
            active={preset.active}
            title={preset.description}
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
        <div id={panelId} className="flex flex-col gap-5 pt-1">
          <FilterGroup label="Safety & risk">
            <FilterFacet
              label="Warnings"
              value={filters.warnings}
              options={options.warnings}
              onChange={(value) => onFilterChange("warnings", value)}
            />
            <FilterFacet
              label="Safety"
              value={filters.minSafety === null ? "all" : String(filters.minSafety)}
              options={options.minSafety}
              onChange={(value) => onFilterChange("minSafety", value)}
            />
            <FilterFacet
              label="Depth"
              value={filters.depth}
              options={options.depth}
              onChange={(value) => onFilterChange("depth", value)}
            />
          </FilterGroup>
          <FilterGroup label="Source quality">
            <FilterFacet
              label="Confidence"
              value={filters.sourceConfidence}
              options={options.sourceConfidence}
              onChange={(value) => onFilterChange("sourceConfidence", value)}
            />
            <FilterFacet
              label="Source changed"
              value={filters.sourceChanged}
              options={options.sourceChanged}
              onChange={(value) => onFilterChange("sourceChanged", value)}
            />
            <FilterFacet
              label="Posture"
              value={filters.sourcePosture}
              options={options.sourcePosture}
              onChange={(value) => onFilterChange("sourcePosture", value)}
            />
          </FilterGroup>
          <FilterGroup label="Yield framing">
            <FilterFacet
              label="TVL"
              value={filters.minTvl === null ? "all" : String(filters.minTvl)}
              options={options.minTvl}
              onChange={(value) => onFilterChange("minTvl", value)}
            />
            <FilterFacet
              label="Benchmark"
              value={filters.benchmark}
              options={options.benchmark}
              onChange={(value) => onFilterChange("benchmark", value)}
            />
            <FilterFacet
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
