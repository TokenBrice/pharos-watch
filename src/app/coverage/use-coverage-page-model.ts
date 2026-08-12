"use client";

import { useMemo } from "react";
import { useCoverageMatrixModel } from "@/hooks/use-coverage-matrix-model";
import { useLogos } from "@/hooks/use-logos";
import { buildDataCoverageModel } from "@/app/safety-scores/data-coverage-view-model";
import { useCoverageFilters } from "./use-coverage-filters";

export function useCoveragePageModel() {
  const { data: logos } = useLogos();
  const {
    rows,
    safetyScoreResponse,
    featureSummaries,
    sourceDepthProgress,
    pricingSources,
    authoritativeSources,
    widestFeature,
    narrowestFeature,
    mostConcentratedFeature,
    isInitialDataLoading,
    isStablecoinDataUnavailable,
    unavailableFeatures,
    dataUpdatedAt,
    staleQueries,
  } = useCoverageMatrixModel();
  const safetyScoreDataCoverage = useMemo(
    () => buildDataCoverageModel(safetyScoreResponse),
    [safetyScoreResponse],
  );

  const filters = useCoverageFilters(rows);

  function resetFilters() {
    filters.setSearch("");
    filters.setFilter("all");
  }

  return {
    logos,
    rows,
    safetyScoreResponse,
    safetyScoreDataCoverage,
    featureSummaries,
    sourceDepthProgress,
    pricingSources,
    authoritativeSources,
    widestFeature,
    narrowestFeature,
    mostConcentratedFeature,
    isInitialDataLoading,
    isStablecoinDataUnavailable,
    unavailableFeatures,
    dataUpdatedAt,
    staleQueries,
    ...filters,
    resetFilters,
  };
}
