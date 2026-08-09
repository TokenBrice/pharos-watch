"use client";

import { FaqSection } from "@/components/faq-section";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { SafetyScoreV9StatusNotice } from "@/components/safety-score-v9-status-notice";
import {
  CoverageFeatureSnapshotCard,
  CoverageMatrixCard,
  CoverageMatrixDataStateCard,
  CoveragePricingSourcesCard,
} from "./coverage-page-sections";
import { useCoveragePageModel } from "./use-coverage-page-model";
import { COVERAGE_FAQ_ITEMS } from "./coverage-faq";

export default function CoveragePageClient() {
  const model = useCoveragePageModel();

  return (
    <div className="space-y-6">
      <StaleDataBanner queries={model.staleQueries} />
      <SafetyScoreV9StatusNotice response={model.safetyScoreResponse} />
      {model.isInitialDataLoading || model.isStablecoinDataUnavailable ? (
        <CoverageMatrixDataStateCard state={model.isStablecoinDataUnavailable ? "error" : "loading"} />
      ) : (
        <>
          <CoverageFeatureSnapshotCard {...model} />
          <CoveragePricingSourcesCard
            pricingSources={model.pricingSources}
            authoritativeSources={model.authoritativeSources}
          />
          <CoverageMatrixCard {...model} />
        </>
      )}

      <FaqSection items={COVERAGE_FAQ_ITEMS} title="Coverage FAQ" includeJsonLd />
    </div>
  );
}
