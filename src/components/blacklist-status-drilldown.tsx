"use client";

import { useMemo } from "react";
import { X } from "lucide-react";
import { useDexLiquidity, usePegSummary } from "@/hooks/api-hooks";
import { logosById } from "@/lib/logos";
import { StablecoinTable } from "@/components/stablecoin-table";
import { Button } from "@/components/ui/button";
import { buildStablecoinTableInputs } from "@/lib/stablecoin-table-inputs";
import {
  BLACKLIST_STATUS_BUCKET_DESCRIPTIONS,
  BLACKLIST_STATUS_BUCKET_LABELS,
  filterStablecoinsByBlacklistStatus,
  type BlacklistStatusBucketKey,
} from "@/lib/blacklist-status-buckets";
import type { StablecoinData } from "@shared/types";
import type { V9SafetyTableRow } from "@/lib/safety-score-v9-consumers";

interface BlacklistStatusDrilldownProps {
  status: BlacklistStatusBucketKey;
  stablecoins: StablecoinData[] | undefined;
  fxFallbackRates?: Record<string, number>;
  reportCards: Record<string, V9SafetyTableRow> | undefined;
  onClear: () => void;
}

export function BlacklistStatusDrilldown({
  status,
  stablecoins,
  fxFallbackRates,
  reportCards,
  onClear,
}: BlacklistStatusDrilldownProps) {
  const logos = logosById;
  const { data: pegSummaryData } = usePegSummary();
  const { data: dexLiquidity } = useDexLiquidity();
  const tableInputs = useMemo(
    () =>
      buildStablecoinTableInputs({
        stablecoins,
        fxFallbackRates,
        pegSummaryCoins: pegSummaryData?.coins,
      }),
    [fxFallbackRates, pegSummaryData?.coins, stablecoins],
  );

  const filteredStablecoins = useMemo(
    () => filterStablecoinsByBlacklistStatus(stablecoins, status),
    [stablecoins, status],
  );

  return (
    <section
      id="blacklist-status-drilldown"
      aria-label={`${BLACKLIST_STATUS_BUCKET_LABELS[status]} stablecoins`}
      className="space-y-3 animate-in fade-in duration-300"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h2 className="pharos-kicker">Status Drilldown</h2>
          <p className="text-sm text-foreground">
            Stablecoins with Freezable status:{" "}
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
      <StablecoinTable
        data={filteredStablecoins}
        isLoading={!stablecoins}
        activeFilters={[]}
        logos={logos}
        pegRates={tableInputs.pegRates}
        pegScores={tableInputs.pegScores}
        dexLiquidity={dexLiquidity ?? undefined}
        reportCards={reportCards}
      />
    </section>
  );
}
