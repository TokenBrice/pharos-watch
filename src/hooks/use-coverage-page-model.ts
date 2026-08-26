"use client";

import { useMemo } from "react";
import { useCoverageMatrixModel } from "@/hooks/use-coverage-matrix-model";
import { logosById } from "@/lib/logos";
import { buildDataCoverageModel } from "@/lib/safety-score-data-coverage";
import { useCoverageFilters } from "@/hooks/use-coverage-filters";

export function useCoveragePageModel() {
  const logos = logosById;
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
