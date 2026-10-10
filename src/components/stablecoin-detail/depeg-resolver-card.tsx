"use client";

import { StablecoinDepegResolverRows } from "@/components/depeg-resolver-row-card-parts";
import { QueryStateNotice } from "@/components/query-state-notice";
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
  const usableRows = rows.length > 0 && (!degraded || resolver.data?._meta?.degradedReason === "stale-cache");
  const unavailable = !usableRows && (resolver.error != null || degraded);

  if (!unavailable && !usableRows) return null;
  return (
    <div className="space-y-3">
      {unavailable || (resolver.error != null && usableRows) ? (
        <section aria-label="Depeg Duration Resolver availability" className="space-y-2">
          <QueryStateNotice
            state={usableRows ? "stale-with-data" : "unavailable"}
            label="Depeg Duration Resolver"
            onRetry={() => void resolver.refetch()}
          />
          {degraded ? (
            <p className="text-xs text-muted-foreground">
              Snapshot reason: {resolver.data?._meta?.degradedReason ?? "unavailable"}
            </p>
          ) : null}
        </section>
      ) : null}
      <StablecoinDepegResolverRows stablecoinId={stablecoinId} data={resolver.data} logoSrc={logoSrc} />
    </div>
  );
}
