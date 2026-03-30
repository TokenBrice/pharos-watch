"use client";

import { useMemo } from "react";
import { X } from "lucide-react";
import { useDexLiquidity, usePegSummary, useReportCards } from "@/hooks/api-hooks";
import { useLogos } from "@/hooks/use-logos";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { StablecoinTable } from "@/components/stablecoin-table";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buildPegSummaryCoinMap, buildReportCardMap } from "@/lib/stablecoin-lookups";
import {
  BLACKLIST_STATUS_BUCKET_DESCRIPTIONS,
  BLACKLIST_STATUS_BUCKET_LABELS,
  filterStablecoinsByBlacklistStatus,
  type BlacklistStatusBucketKey,
} from "@/lib/blacklist-status-buckets";
import { derivePegRates } from "@shared/lib/peg-rates";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";

interface BlacklistStatusDrilldownProps {
  status: BlacklistStatusBucketKey;
  onClear: () => void;
}

export function BlacklistStatusDrilldown({ status, onClear }: BlacklistStatusDrilldownProps) {
  const { data: stablecoinsData, isLoading } = useStablecoins();
  const { data: logos } = useLogos();
  const { data: pegSummaryData } = usePegSummary();
  const { data: dexLiquidity } = useDexLiquidity();
  const { data: reportCardsData } = useReportCards();

  const reportCardMap = useMemo(() => buildReportCardMap(reportCardsData?.cards), [reportCardsData?.cards]);
  const pegScores = useMemo(() => buildPegSummaryCoinMap(pegSummaryData?.coins), [pegSummaryData?.coins]);

  const { rates: pegRates } = useMemo(
    () => derivePegRates(stablecoinsData?.peggedAssets ?? [], TRACKED_META_BY_ID, stablecoinsData?.fxFallbackRates),
    [stablecoinsData],
  );

  const filteredStablecoins = useMemo(
    () => filterStablecoinsByBlacklistStatus(stablecoinsData?.peggedAssets, status, reportCardMap),
    [stablecoinsData?.peggedAssets, status, reportCardMap],
  );

  return (
    <section id="blacklist-status-drilldown" aria-label={`${BLACKLIST_STATUS_BUCKET_LABELS[status]} stablecoins`}>
      <Card className="rounded-xl animate-in fade-in duration-300">
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1">
              <CardTitle as="h2" className="pharos-kicker">Status Drilldown</CardTitle>
              <p className="text-sm text-foreground">
                Stablecoins with blacklistable status:{" "}
                <span className="font-medium">{BLACKLIST_STATUS_BUCKET_LABELS[status]}</span>
              </p>
              <p className="text-sm text-muted-foreground">{BLACKLIST_STATUS_BUCKET_DESCRIPTIONS[status]}</p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 gap-1.5 self-start sm:min-h-8"
              onClick={onClear}
            >
              <X className="h-3.5 w-3.5" />
              Clear selection
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <StablecoinTable
            data={filteredStablecoins}
            isLoading={isLoading}
            activeFilters={[]}
            logos={logos}
            pegRates={pegRates}
            pegScores={pegScores}
            dexLiquidity={dexLiquidity ?? undefined}
            reportCards={reportCardMap}
          />
        </CardContent>
      </Card>
    </section>
  );
}
