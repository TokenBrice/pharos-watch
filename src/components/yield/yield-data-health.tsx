"use client";

import { QueryErrorNotice } from "@/components/query-error-notice";
import { StaleDataBanner, type StaleQuery } from "@/components/stale-data-banner";
import { useYieldAdapterManifest } from "@/hooks/api-hooks";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { cn } from "@/lib/utils";
import type { YieldRankingsSummaryResponse } from "@shared/types/yield-summary";

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

export function YieldApiWarnings({ warnings }: { warnings: YieldRankingsSummaryResponse["warnings"] }) {
  if (!warnings || warnings.length === 0) return null;

  return (
    <section aria-label="Yield API warnings" className="space-y-2">
      {warnings.map((warning) =>
        // A publish-time snapshot fallback keeps the page fully populated, so it
        // reads as a neutral freshness note rather than an amber degradation.
        warning.code === "yield-safety-hydration-stale" ? (
          <div
            key={`${warning.code}:${warning.message}`}
            className={cn("rounded-xl border px-4 py-3 text-sm text-muted-foreground", SEVERITY_TONE_CLASS.neutral.banner)}
          >
            <p className="font-medium">{warning.message}</p>
            {warning.reasons && warning.reasons.length > 0 ? (
              <p className="mt-1 text-xs text-muted-foreground/80">{warning.reasons.join(", ")}</p>
            ) : null}
          </div>
        ) : (
        <div
          key={`${warning.code}:${warning.message}`}
          className={cn("rounded-xl border px-4 py-3 text-sm text-amber-950 dark:text-amber-100", SEVERITY_TONE_CLASS.watch.banner)}
        >
          <p className="font-medium">{warning.message}</p>
          {warning.reasons && warning.reasons.length > 0 ? (
            <p className="mt-1 text-xs text-amber-900/80 dark:text-amber-100/80">{warning.reasons.join(", ")}</p>
          ) : null}
        </div>
        ),
      )}
    </section>
  );
}
