"use client";

import { Search } from "lucide-react";
import { labelYieldFilterOption, type YieldViewModel } from "@/lib/yield-view-model";
import { cn } from "@/lib/utils";

interface YieldLeaderboardControlsProps {
  viewModel: YieldViewModel;
  onFilterChange: (key: string, value: string) => void;
  onClearFilters: () => void;
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
        className="pharos-focus-ring min-h-10 rounded-lg border border-border/70 bg-background/70 px-2 py-2 text-sm normal-case tracking-normal text-foreground sm:min-h-8 sm:py-1.5"
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

function FilterPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "pharos-focus-ring min-h-10 rounded-full border px-3 text-xs font-medium transition-colors sm:min-h-8",
        active
          ? "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300"
          : "border-border/70 bg-background/60 text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

export function YieldLeaderboardControls({
  viewModel,
  onFilterChange,
  onClearFilters,
}: YieldLeaderboardControlsProps) {
  const { filters, options } = viewModel;
  const hasActiveFilters = Object.values(viewModel.normalizedParams).some((value) => value !== null);

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

        <div className="flex flex-wrap items-center gap-2 md:justify-end">
          {options.peg.length > 1
            ? options.peg.map((option) => (
                <FilterPill
                  key={option.value}
                  label={labelYieldFilterOption(option)}
                  active={filters.peg === option.value}
                  onClick={() => onFilterChange("peg", option.value)}
                />
              ))
            : null}
          {hasActiveFilters ? (
            <button
              type="button"
              onClick={onClearFilters}
              className="pharos-focus-ring min-h-10 rounded-full border border-border/70 px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:min-h-8"
            >
              Reset
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-2">
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
    </div>
  );
}
