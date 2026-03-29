"use client";

import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { StaleDataBanner } from "@/components/stale-data-banner";
import {
  CoverageFeatureSnapshotCard,
  CoverageMatrixCard,
  CoveragePricingSourcesCard,
} from "./coverage-page-sections";
import { useCoveragePageModel } from "./use-coverage-page-model";

export default function CoveragePageClient() {
  const model = useCoveragePageModel();

  return (
    <SectionErrorBoundary name="Coverage">
      <div className="space-y-6">
        <StaleDataBanner queries={model.staleQueries} />
        <CoverageFeatureSnapshotCard
          featureSummaries={model.featureSummaries}
          widestFeature={model.widestFeature}
          narrowestFeature={model.narrowestFeature}
          mostConcentratedFeature={model.mostConcentratedFeature}
          totalRows={model.rows.length}
        />
        <CoveragePricingSourcesCard
          pricingSources={model.pricingSources}
          authoritativeSources={model.authoritativeSources}
        />
        <CoverageMatrixCard {...model} />
      </div>
    </SectionErrorBoundary>
  );
}
