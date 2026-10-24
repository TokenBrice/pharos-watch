"use client";

import { QueryErrorNotice } from "@/components/query-error-notice";
import { StaleDataBanner, type StaleQuery } from "@/components/stale-data-banner";
import type { UseQueryResult } from "@tanstack/react-query";
import type { YieldAdapterManifestResponse } from "@shared/types";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { cn } from "@/lib/utils";
import type { YieldRankingsSummaryResponse } from "@shared/types/yield-summary";

interface YieldDataHealthProps {
  dataUpdatedAt: number;
  error: unknown;
  hasData: boolean;
  meta: StaleQuery["meta"];
  adapterManifestQuery: UseQueryResult<YieldAdapterManifestResponse, Error>;
}

export function YieldDataHealth({ dataUpdatedAt, error, hasData, meta, adapterManifestQuery }: YieldDataHealthProps) {
  const { data: adapterManifest, error: adapterError, refetch } = adapterManifestQuery;
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

/** Safety-hydration fallbacks and degradation are operator signal (Telegram, /status); withheld values render as missing. */
const OPERATOR_ONLY_WARNING_CODES: ReadonlySet<string> = new Set([
  "yield-safety-hydration-stale",
  "yield-safety-hydration-degraded",
]);

export function YieldApiWarnings({ warnings }: { warnings: YieldRankingsSummaryResponse["warnings"] }) {
  const visible = (warnings ?? []).filter((warning) => !OPERATOR_ONLY_WARNING_CODES.has(warning.code));
  if (visible.length === 0) return null;

  return (
    <section aria-label="Yield API warnings" className="space-y-2">
      {visible.map((warning) => (
        <div
          key={`${warning.code}:${warning.message}`}
          className={cn("rounded-xl border px-4 py-3 text-sm text-state-warn-ink", SEVERITY_TONE_CLASS.watch.banner)}
        >
          <p className="font-medium">{warning.message}</p>
          {warning.reasons && warning.reasons.length > 0 ? (
            <p className="mt-1 text-xs text-state-warn-strong">{warning.reasons.join(", ")}</p>
          ) : null}
        </div>
      ))}
    </section>
  );
}
