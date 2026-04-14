"use client";

import { useCoverageMatrixModel } from "@/hooks/use-coverage-matrix-model";
import { useLogos } from "@/hooks/use-logos";
import { useCoverageFilters } from "./use-coverage-filters";

export function useCoveragePageModel() {
  const { data: logos } = useLogos();
  const {
    rows,
    featureSummaries,
    pricingSources,
    authoritativeSources,
    widestFeature,
    narrowestFeature,
    mostConcentratedFeature,
    isInitialDataLoading,
    isStablecoinDataUnavailable,
    unavailableFeatures,
    staleQueries,
  } = useCoverageMatrixModel();

  const filters = useCoverageFilters(rows);

  function resetFilters() {
    filters.setSearch("");
    filters.setFilter("all");
  }

  return {
    logos,
    rows,
    featureSummaries,
    pricingSources,
    authoritativeSources,
    widestFeature,
    narrowestFeature,
    mostConcentratedFeature,
    isInitialDataLoading,
    isStablecoinDataUnavailable,
    unavailableFeatures,
    staleQueries,
    ...filters,
    resetFilters,
  };
}
