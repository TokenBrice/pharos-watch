"use client";

import { QueryErrorNotice } from "@/components/query-error-notice";
import { StaleDataBanner, type StaleQuery } from "@/components/stale-data-banner";
import { useYieldAdapterManifest } from "@/hooks/api-hooks";

interface YieldDataHealthProps {
  dataUpdatedAt: number;
  error: unknown;
  hasData: boolean;
  meta: StaleQuery["meta"];
}

export function YieldDataHealth({ dataUpdatedAt, error, hasData, meta }: YieldDataHealthProps) {
  const { data: adapterManifest, error: adapterError, refetch } = useYieldAdapterManifest();
  return (
    <>
      <StaleDataBanner queries={[{ preset: "yieldRankings", dataUpdatedAt, error, hasData, meta }]} />
      <QueryErrorNotice
        error={adapterError}
        hasData={!!adapterManifest}
        onRetry={() => {
          void refetch();
        }}
      />
    </>
  );
}
