import { formatTvlOption, matchesYieldPeg, matchesYieldSearch } from "@/lib/yield-view-model-helpers";
import type { YieldRowFacet, YieldViewModelOptions } from "@/lib/yield-view-model-types";
import {
  DEFAULT_FILTERS,
  type YieldFilterOption,
  type YieldViewModelFilters,
} from "@/lib/yield-view-config";

function describeOption<T extends string>(
  options: ReadonlyArray<YieldFilterOption<T>>,
  value: T | string,
): string {
  return options.find((option) => option.value === value)?.label ?? String(value);
}

export interface YieldFilterAxisDescriptor {
  key: keyof YieldViewModelFilters;
  isActive: (filters: YieldViewModelFilters) => boolean;
  matches: (facet: YieldRowFacet, filters: YieldViewModelFilters) => boolean;
  describeRelax: (filters: YieldViewModelFilters, options: YieldViewModelOptions) => string;
  relaxTargetValue: string | null;
  describeActive?: (filters: YieldViewModelFilters, options: YieldViewModelOptions) => string;
}

export const YIELD_FILTER_AXIS_REGISTRY: readonly YieldFilterAxisDescriptor[] = [
  {
    key: "yieldType",
    isActive: (filters) => filters.yieldType !== DEFAULT_FILTERS.yieldType,
    matches: (facet, filters) => filters.yieldType === "all" || facet.row.yieldType === filters.yieldType,
    describeRelax: (filters, options) => `Drop type filter (${describeOption(options.yieldType, filters.yieldType)})`,
    relaxTargetValue: null,
    describeActive: (filters, options) => `Type: ${describeOption(options.yieldType, filters.yieldType)}`,
  },
  {
    key: "warnings",
    isActive: (filters) => filters.warnings !== DEFAULT_FILTERS.warnings,
    matches: (facet, filters) => {
      if (filters.warnings === "hide") return !facet.hasWarning;
      if (filters.warnings === "only") return facet.hasWarning;
      return true;
    },
    describeRelax: (filters, options) => `Drop warnings filter (${describeOption(options.warnings, filters.warnings)})`,
    relaxTargetValue: null,
    describeActive: (filters, options) => describeOption(options.warnings, filters.warnings),
  },
  {
    key: "watchlist",
    isActive: (filters) => filters.watchlist !== DEFAULT_FILTERS.watchlist,
    matches: (facet, filters) => filters.watchlist !== "only" || facet.inWatchlist,
    describeRelax: () => "Drop watchlist-only filter",
    relaxTargetValue: null,
    describeActive: () => "Watching only",
  },
  {
    key: "attention",
    isActive: (filters) => filters.attention !== DEFAULT_FILTERS.attention,
    matches: (facet, filters) => filters.attention !== "watchlist" || facet.needsWatchlistAttention,
    describeRelax: () => "Drop watchlist-attention filter",
    relaxTargetValue: null,
    describeActive: () => "Watching needs attention",
  },
  {
    key: "minSafety",
    isActive: (filters) => filters.minSafety !== DEFAULT_FILTERS.minSafety,
    matches: (facet, filters) => filters.minSafety === null
      || (facet.row.safetyScore !== null && facet.row.safetyScore >= filters.minSafety),
    describeRelax: (filters) => `Drop ${filters.minSafety}+ safety floor`,
    relaxTargetValue: null,
    describeActive: (filters, options) => describeOption(options.minSafety, String(filters.minSafety)),
  },
  {
    key: "minTvl",
    isActive: (filters) => filters.minTvl !== DEFAULT_FILTERS.minTvl,
    matches: (facet, filters) => filters.minTvl === null
      || (facet.row.sourceTvlUsd !== null && facet.row.sourceTvlUsd >= filters.minTvl),
    describeRelax: (filters) => `Drop ${formatTvlOption(filters.minTvl!)} TVL floor`,
    relaxTargetValue: null,
    describeActive: (filters, options) => describeOption(options.minTvl, String(filters.minTvl)),
  },
  {
    key: "depth",
    isActive: (filters) => filters.depth !== DEFAULT_FILTERS.depth,
    matches: (facet, filters) => {
      if (filters.depth === "all") return true;
      if (filters.depth === "hide-thin") return facet.sourceDepthLens !== "thin";
      return facet.sourceDepthLens === filters.depth;
    },
    describeRelax: (filters, options) => `Drop depth filter (${describeOption(options.depth, filters.depth)})`,
    relaxTargetValue: null,
    describeActive: (filters, options) => `Depth: ${describeOption(options.depth, filters.depth)}`,
  },
  {
    key: "sourceChanged",
    isActive: (filters) => filters.sourceChanged !== DEFAULT_FILTERS.sourceChanged,
    matches: (facet, filters) => {
      if (filters.sourceChanged === "only") return facet.sourceChanged;
      if (filters.sourceChanged === "none") return !facet.sourceChanged;
      return true;
    },
    describeRelax: (filters, options) => `Drop source-changed filter (${describeOption(options.sourceChanged, filters.sourceChanged)})`,
    relaxTargetValue: null,
    describeActive: (filters, options) => describeOption(options.sourceChanged, filters.sourceChanged),
  },
  {
    key: "sourcePosture",
    isActive: (filters) => filters.sourcePosture !== DEFAULT_FILTERS.sourcePosture,
    matches: (facet, filters) => {
      if (filters.sourcePosture === "all") return true;
      if (filters.sourcePosture === "clean") return facet.sourcePosture === "clean";
      if (filters.sourcePosture === "watch") {
        return facet.sourcePosture === "clean" || facet.sourcePosture === "watch";
      }
      if (filters.sourcePosture === "watch-only") return facet.sourcePosture === "watch";
      return facet.sourcePosture === "speculative";
    },
    describeRelax: (filters, options) => `Drop source posture filter (${describeOption(options.sourcePosture, filters.sourcePosture)})`,
    relaxTargetValue: null,
    describeActive: (filters, options) => `Source: ${describeOption(options.sourcePosture, filters.sourcePosture)}`,
  },
  {
    key: "sourceConfidence",
    isActive: (filters) => filters.sourceConfidence !== DEFAULT_FILTERS.sourceConfidence,
    matches: (facet, filters) => filters.sourceConfidence === "all"
      || facet.confidenceTier === filters.sourceConfidence,
    describeRelax: (filters, options) => `Drop confidence filter (${describeOption(options.sourceConfidence, filters.sourceConfidence)})`,
    relaxTargetValue: null,
    describeActive: (filters, options) => `Confidence: ${describeOption(options.sourceConfidence, filters.sourceConfidence)}`,
  },
  {
    key: "benchmark",
    isActive: (filters) => filters.benchmark !== DEFAULT_FILTERS.benchmark,
    matches: (facet, filters) => filters.benchmark === "all" || facet.benchmarkKey === filters.benchmark,
    describeRelax: (filters, options) => `Drop benchmark filter (${describeOption(options.benchmark, filters.benchmark)})`,
    relaxTargetValue: null,
    describeActive: (filters, options) => `Benchmark: ${describeOption(options.benchmark, filters.benchmark)}`,
  },
  {
    key: "opportunity",
    isActive: (filters) => filters.opportunity !== DEFAULT_FILTERS.opportunity,
    matches: (facet, filters) => filters.opportunity === "all" || facet.opportunity === filters.opportunity,
    describeRelax: (filters, options) => `Drop opportunity filter (${describeOption(options.opportunity, filters.opportunity)})`,
    relaxTargetValue: null,
    describeActive: (filters, options) => describeOption(options.opportunity, filters.opportunity),
  },
  {
    key: "peg",
    isActive: (filters) => filters.peg !== DEFAULT_FILTERS.peg,
    matches: (facet, filters) => matchesYieldPeg(facet.peg, filters.peg),
    describeRelax: (filters, options) => `Drop peg filter (${describeOption(options.peg, filters.peg)})`,
    relaxTargetValue: null,
  },
  {
    key: "q",
    isActive: (filters) => filters.q !== DEFAULT_FILTERS.q,
    matches: (facet, filters) => matchesYieldSearch(facet.row, filters.q),
    describeRelax: (filters) => `Clear search "${filters.q}"`,
    relaxTargetValue: null,
  },
  {
    key: "trending",
    isActive: (filters) => filters.trending !== DEFAULT_FILTERS.trending,
    matches: (facet, filters) => filters.trending !== "rising" || facet.isRising,
    describeRelax: () => "Drop trending filter",
    relaxTargetValue: null,
  },
];
