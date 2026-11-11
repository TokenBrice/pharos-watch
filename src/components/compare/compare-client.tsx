"use client";

import { useEffect, useState } from "react";
import { logosById } from "@/lib/logos";
import { useCompareSelection } from "@/hooks/use-compare-selection";
import { useCompareDataModel } from "@/hooks/use-compare-data-model";
import { useCompareShareActions } from "@/hooks/use-compare-share-actions";
import { usePreference } from "@/hooks/use-preferences";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { CompareScopeHero } from "@/components/compare/compare-scope-hero";
import { CompareSelectionPanel } from "@/components/compare/compare-selection-panel";
import { CompareResultsPanel } from "@/components/compare/compare-results-panel";
import type { CompareRadarCohort } from "@/lib/compare-data-model-types";

export function CompareClient() {
  const logos = logosById;
  const [nowSeconds, setNowSeconds] = useState<number | null>(null);
  const selection = useCompareSelection();
  const { selectedIds, coinOptions, flowHours, range } = selection;

  const [radarCohort, setRadarCohort] = usePreference<CompareRadarCohort>(
    "pharos-compare-radar-cohort",
    "peg",
    {
      decode: (raw) =>
        raw === "peg" || raw === "mechanism" || raw === "all" ? raw : "peg",
    },
  );

  const data = useCompareDataModel({ selectedIds, flowHours, radarCohort, range });
  const { comparisonCoins, flowUpdatedAt, freshnessQueries, globalError, handleRetry,
    hasPrimaryData, pegRates, radarCards, shareAsOfUpdatedAt } = data;

  const share = useCompareShareActions({
    comparisonCoins,
    logos,
    pegRates,
    radarCards,
    axisOrder: ["backing", "exit", "control"],
    axisLabels: { backing: "Backing", exit: "Exit", control: "Control" },
    asOfUpdatedAt: shareAsOfUpdatedAt,
  });

  // nowSeconds only feeds the "Updated N min ago" flow-staleness label, so the
  // per-minute ticker is only worth running once flow data is present.
  useEffect(() => {
    if (flowUpdatedAt == null) return;
    const updateNow = () => setNowSeconds(Math.floor(Date.now() / 1000));
    updateNow();
    const interval = window.setInterval(updateNow, 60_000);
    return () => window.clearInterval(interval);
  }, [flowUpdatedAt]);

  // A producer clock ahead of the reader's leaves no computable age: print no
  // claim rather than a clamped zero.
  const flowUpdatedMinutes =
    flowUpdatedAt != null && nowSeconds != null && nowSeconds >= flowUpdatedAt
      ? Math.round((nowSeconds - flowUpdatedAt) / 60)
      : null;

  return (
    <div className="space-y-6">
      <QueryFreshnessNotices
        error={globalError}
        hasData={hasPrimaryData}
        onRetry={handleRetry}
        queries={freshnessQueries}
      />
      <CompareScopeHero coinOptions={coinOptions} selectedCount={selectedIds.length} />
      <CompareSelectionPanel selection={selection} share={share} logos={logos} />
      {selectedIds.length >= 2 && (
        <CompareResultsPanel
          data={data}
          selection={selection}
          logos={logos}
          flowUpdatedMinutes={flowUpdatedMinutes}
          radarCohort={radarCohort}
          setRadarCohort={setRadarCohort}
        />
      )}
    </div>
  );
}
