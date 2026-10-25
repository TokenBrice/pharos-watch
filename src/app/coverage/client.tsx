"use client";

import { StaleDataBanner } from "@/components/stale-data-banner";
import {
  CoverageFeatureSnapshotCard,
  CoverageMatrixCard,
  CoverageMatrixDataStateCard,
  CoveragePricingSourcesCard,
  CoverageSafetyScoreDataCard,
} from "@/components/coverage/coverage-page-sections";
import { useCoveragePageModel } from "@/hooks/use-coverage-page-model";

export default function CoveragePageClient() {
  const model = useCoveragePageModel();

  return (
    <div className="space-y-6">
      <StaleDataBanner queries={model.staleQueries} />
      {model.isInitialDataLoading || model.isStablecoinDataUnavailable ? (
        <CoverageMatrixDataStateCard state={model.isStablecoinDataUnavailable ? "error" : "loading"} />
      ) : (
        <>
          <CoverageFeatureSnapshotCard {...model} />
          <CoverageSafetyScoreDataCard safetyScoreDataCoverage={model.safetyScoreDataCoverage} />
          <CoveragePricingSourcesCard
            pricingSources={model.pricingSources}
            authoritativeSources={model.authoritativeSources}
          />
          <CoverageMatrixCard {...model} />
        </>
      )}
    </div>
  );
}
