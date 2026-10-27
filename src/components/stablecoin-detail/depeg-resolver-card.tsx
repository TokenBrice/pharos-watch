"use client";

import { isResolverBookAvailable } from "@/components/depeg-resolver-book-summary";
import { StablecoinDepegResolverRows } from "@/components/depeg-resolver-row-card-parts";
import { QueryStateNotice } from "@/components/query-state-notice";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { useDepegResolver } from "@/hooks/api-hooks";
import { isDepegResolverEnabled } from "@/lib/feature-flags";

interface StablecoinDepegResolverCardProps {
  stablecoinId: string;
  logoSrc?: string;
}

export function StablecoinDepegResolverCard({ stablecoinId, logoSrc }: StablecoinDepegResolverCardProps) {
  const enabled = isDepegResolverEnabled();
  const resolver = useDepegResolver({ enabled });

  if (!enabled) return null;
  const rows = resolver.data?.rows.filter((row) => row.stablecoinId === stablecoinId) ?? [];
  const degraded = resolver.data?._meta?.degraded === true;
  const bookAvailable = isResolverBookAvailable(resolver.data);
  const usableRows = bookAvailable && rows.length > 0;
  // A failed refresh over a retained book is aged by the shared banner, not reported as missing.
  const unavailable = !usableRows && (resolver.data == null ? resolver.error != null : !bookAvailable);

  if (!unavailable && !usableRows) return null;
  return (
    <div className="space-y-3">
      {unavailable ? (
        <section aria-label="Depeg Duration Resolver availability" className="space-y-2">
          <QueryStateNotice
            state="unavailable"
            label="Depeg Duration Resolver"
            onRetry={() => void resolver.refetch()}
          />
          {degraded ? (
            <p className="text-xs text-muted-foreground">
              Snapshot reason: {resolver.data?._meta?.degradedReason ?? "unavailable"}
            </p>
          ) : null}
        </section>
      ) : (
        <StaleDataBanner
          queries={[{
            preset: "depegResolver",
            // The producer clock, never receipt time; header metadata takes precedence when present.
            dataUpdatedAt: (resolver.data?._meta.computedAt ?? 0) * 1000,
            hasData: true,
            error: resolver.error,
            meta: resolver.meta,
          }]}
          onRetry={() => void resolver.refetch()}
        />
      )}
      <StablecoinDepegResolverRows stablecoinId={stablecoinId} data={resolver.data} logoSrc={logoSrc} />
    </div>
  );
}
