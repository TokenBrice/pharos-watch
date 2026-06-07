"use client";

import { DepegResolverRowCard } from "@/components/depeg-resolver-row-card-parts";
import type { DdrDisplayRow } from "@/components/depeg-resolver-row-card-model";

interface StablecoinDepegResolverRowsProps {
  stablecoinId: string;
  data:
    | {
        _meta?: {
          degraded: boolean;
          degradedReason?: string | null;
        };
        rows: DdrDisplayRow[];
      }
    | undefined;
  logoSrc?: string;
}

export { DepegResolverRowCard };

export function StablecoinDepegResolverRows({ stablecoinId, data, logoSrc }: StablecoinDepegResolverRowsProps) {
  const rows = data?.rows.filter((row) => row.stablecoinId === stablecoinId) ?? [];
  const degraded = data?._meta?.degraded === true;
  const showStaleRows = degraded && data?._meta?.degradedReason === "stale-cache" && rows.length > 0;

  if (!data || (degraded && !showStaleRows) || rows.length === 0) {
    return null;
  }

  const logos = logoSrc ? { [stablecoinId]: logoSrc } : undefined;

  return (
    <section aria-label={`Depeg Duration Resolver for ${rows[0]?.symbol ?? stablecoinId}`} className="space-y-4">
      {showStaleRows ? (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          Resolver snapshot is stale; duration estimates are suppressed until the next refresh.
        </p>
      ) : null}
      <div className="space-y-4">
        {rows.map((row) => (
          <DepegResolverRowCard key={`${row.stablecoinId}:${row.eventId}`} row={row} logos={logos} />
        ))}
      </div>
    </section>
  );
}
