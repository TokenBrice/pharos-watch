"use client";

import { useCallback, useDeferredValue, useMemo } from "react";
import { StaleDataBanner } from "@/components/stale-data-banner";
import {
  CoverageFeatureSnapshotCard,
  CoverageMatrixCard,
  CoverageMatrixDataStateCard,
  CoveragePricingSourcesCard,
  CoverageSafetyScoreDataCard,
} from "@/components/coverage/coverage-page-sections";
import {
  COVERAGE_MATRIX_URL_SCHEMA,
  filterCoverageMatrixRows,
  hasCoverageMatrixFilters,
  type CoverageMatrixFilterKey,
  type CoverageMatrixSortKey,
} from "@/components/coverage/coverage-matrix-controls";
import { useCoveragePageModel } from "@/hooks/use-coverage-page-model";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { useUrlState } from "@/hooks/use-url-state";

export default function CoveragePageClient() {
  const model = useCoveragePageModel();
  const prefersReducedMotion = usePrefersReducedMotion();
  const { state: matrixUrlState, patchState: patchMatrixUrlState } = useUrlState(COVERAGE_MATRIX_URL_SCHEMA);
  const deferredSearch = useDeferredValue(model.search);

  const setFilter = useCallback(
    (next: CoverageMatrixFilterKey) => patchMatrixUrlState({ filter: next }),
    [patchMatrixUrlState],
  );
  const handleSnapshotFilter = useCallback(
    (next: CoverageMatrixFilterKey) => {
      patchMatrixUrlState({ filter: next });
      const matrixSection = document.getElementById("coverage-matrix");
      if (!matrixSection) return;
      matrixSection.scrollIntoView({
        behavior: prefersReducedMotion ? "auto" : "smooth",
        block: "start",
      });
    },
    [patchMatrixUrlState, prefersReducedMotion],
  );
  const setSort = useCallback(
    (next: CoverageMatrixSortKey) => patchMatrixUrlState({ sort: next }),
    [patchMatrixUrlState],
  );
  const filteredRows = useMemo(
    () => filterCoverageMatrixRows(model.rows, matrixUrlState.filter, matrixUrlState.sort, deferredSearch),
    [deferredSearch, matrixUrlState.filter, matrixUrlState.sort, model.rows],
  );
  const hasActiveFilters = hasCoverageMatrixFilters(matrixUrlState.filter, model.search);
  const resetFilters = useCallback(() => {
    model.setSearch("");
    patchMatrixUrlState({ filter: "all" });
  }, [model, patchMatrixUrlState]);

  return (
    <div className="space-y-6">
      <StaleDataBanner queries={model.staleQueries} />
      {model.isInitialDataLoading || model.isStablecoinDataUnavailable ? (
        <CoverageMatrixDataStateCard state={model.isStablecoinDataUnavailable ? "error" : "loading"} />
      ) : (
        <>
          <CoverageFeatureSnapshotCard {...model} onFilterFeature={handleSnapshotFilter} />
          <CoverageSafetyScoreDataCard safetyScoreDataCoverage={model.safetyScoreDataCoverage} />
          <CoveragePricingSourcesCard
            pricingSources={model.pricingSources}
            authoritativeSources={model.authoritativeSources}
          />
          <CoverageMatrixCard
            logos={model.logos}
            rows={model.rows}
            filter={matrixUrlState.filter}
            setFilter={setFilter}
            sort={matrixUrlState.sort}
            setSort={setSort}
            search={model.search}
            setSearch={model.setSearch}
            filteredRows={filteredRows}
            hasActiveFilters={hasActiveFilters}
            resetFilters={resetFilters}
            unavailableFeatures={model.unavailableFeatures}
            dataAsOfMs={model.dataAsOfMs}
          />
        </>
      )}
    </div>
  );
}
