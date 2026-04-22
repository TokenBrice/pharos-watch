"use client";

import { useMemo } from "react";
import { X } from "lucide-react";
import { useDexLiquidity, usePegSummary } from "@/hooks/api-hooks";
import { useLogos } from "@/hooks/use-logos";
import { StablecoinTable } from "@/components/stablecoin-table";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buildPegSummaryCoinMap } from "@/lib/stablecoin-lookups";
import {
  BLACKLIST_STATUS_BUCKET_DESCRIPTIONS,
  BLACKLIST_STATUS_BUCKET_LABELS,
  filterStablecoinsByBlacklistStatus,
  type BlacklistStatusBucketKey,
} from "@/lib/blacklist-status-buckets";
import { derivePegRates } from "@shared/lib/peg-rates";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { ReportCard, StablecoinData } from "@shared/types";

interface BlacklistStatusDrilldownProps {
  status: BlacklistStatusBucketKey;
  stablecoins: StablecoinData[] | undefined;
  fxFallbackRates?: Record<string, number>;
  reportCards: Record<string, ReportCard> | undefined;
  onClear: () => void;
}

export function BlacklistStatusDrilldown({
  status,
  stablecoins,
  fxFallbackRates,
  reportCards,
  onClear,
}: BlacklistStatusDrilldownProps) {
  const { data: logos } = useLogos();
  const { data: pegSummaryData } = usePegSummary();
  const { data: dexLiquidity } = useDexLiquidity();
  const pegScores = useMemo(() => buildPegSummaryCoinMap(pegSummaryData?.coins), [pegSummaryData?.coins]);

  const { rates: pegRates } = useMemo(
    () => derivePegRates(stablecoins ?? [], TRACKED_META_BY_ID, fxFallbackRates),
    [fxFallbackRates, stablecoins],
  );

  const filteredStablecoins = useMemo(
    () => filterStablecoinsByBlacklistStatus(stablecoins, status, reportCards),
    [stablecoins, status, reportCards],
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
            isLoading={!stablecoins}
            activeFilters={[]}
            logos={logos}
            pegRates={pegRates}
            pegScores={pegScores}
            dexLiquidity={dexLiquidity ?? undefined}
            reportCards={reportCards}
          />
        </CardContent>
      </Card>
    </section>
  );
}
