"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TreasuryStableExposureTable } from "@/components/treasury-stable-exposure-table";
import { useTreasuryStableExposure } from "@/hooks/use-treasury-stable-exposure";
import { useLogos } from "@/hooks/use-logos";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { StaleDataBanner } from "@/components/stale-data-banner";

import { Landmark } from "lucide-react";

export function TreasuriesClient() {
  const {
    data: treasuryData,
    isLoading,
    dataUpdatedAt: treasuryUpdatedAt,
    error: treasuryError,
    refetch: refetchTreasury,
    meta: treasuryMeta,
  } = useTreasuryStableExposure();
  const { data: logos } = useLogos();

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-full rounded-xl" />
        <Skeleton className="h-[500px] w-full rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
        <StaleDataBanner
          queries={[
            {
              label: "Treasury stable exposure",
              dataUpdatedAt: treasuryUpdatedAt,
              staleTime: 24 * 60 * 60 * 1000,
              error: treasuryError,
              hasData: !!treasuryData?.entities?.length,
              meta: treasuryMeta,
            },
          ]}
        />
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Landmark className="h-5 w-5 text-primary/80 shrink-0" />
              <CardTitle className="pharos-kicker">Protocol Treasury Stable Exposure</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 pt-0">
            <QueryErrorNotice
              error={treasuryError}
              hasData={!!treasuryData?.entities?.length}
              onRetry={() => {
                void refetchTreasury();
              }}
            />
            {treasuryData?.entities?.length ? (
              <TreasuryStableExposureTable data={treasuryData} logos={logos} />
            ) : (
              <p className="text-sm text-muted-foreground">
                Treasury rankings will appear here once the daily treasury snapshot is available.
              </p>
            )}
          </CardContent>
        </Card>
    </div>
  );
}
