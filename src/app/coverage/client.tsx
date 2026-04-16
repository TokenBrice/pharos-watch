"use client";

import { ChevronDown } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StaleDataBanner } from "@/components/stale-data-banner";
import {
  CoverageFeatureSnapshotCard,
  CoverageMatrixCard,
  CoverageMatrixDataStateCard,
  CoveragePricingSourcesCard,
} from "./coverage-page-sections";
import { useCoveragePageModel } from "./use-coverage-page-model";
import { COVERAGE_FAQ_ITEMS } from "./page";

export default function CoveragePageClient() {
  const model = useCoveragePageModel();

  return (
    <div className="space-y-6">
      <StaleDataBanner queries={model.staleQueries} />
      {model.isInitialDataLoading || model.isStablecoinDataUnavailable ? (
        <CoverageMatrixDataStateCard state={model.isStablecoinDataUnavailable ? "error" : "loading"} />
      ) : (
        <>
          <CoverageFeatureSnapshotCard
            featureSummaries={model.featureSummaries}
            widestFeature={model.widestFeature}
            narrowestFeature={model.narrowestFeature}
            mostConcentratedFeature={model.mostConcentratedFeature}
          />
          <CoveragePricingSourcesCard
            pricingSources={model.pricingSources}
            authoritativeSources={model.authoritativeSources}
          />
          <CoverageMatrixCard {...model} />
        </>
      )}

      <Card className="pharos-card-shell rounded-[1.45rem] p-5 sm:p-6">
        <CardHeader className="pb-2">
          <p className="pharos-kicker">Frequently Asked</p>
          <CardTitle className="leading-none font-semibold">Coverage FAQ</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {COVERAGE_FAQ_ITEMS.map((item, i) => (
            <details key={i} className="group rounded-lg border border-border/50 bg-background/40">
              <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-foreground select-none flex items-center justify-between">
                {item.q}
                <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
              </summary>
              <div className="px-4 pb-3 text-sm text-muted-foreground leading-relaxed">{item.a}</div>
            </details>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
