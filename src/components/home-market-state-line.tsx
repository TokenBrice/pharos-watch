"use client";

import Link from "next/link";
import { useMemo } from "react";
import { usePegSummary, useStabilityIndex } from "@/hooks/api-hooks";
import { deriveDataHealth } from "@/lib/data-health";
import { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";
import { usePsiBeaconState } from "@/hooks/use-psi-beacon-state";
import { ACTIVE_STABLECOIN_ID_SET } from "@/lib/stablecoin-static-data";
import { selectActiveDepegCoins } from "@shared/lib/active-depegs";
import { PSI_BAND_CLASSES, isConditionBand } from "@shared/lib/classification";
import { getDisplayedPsi } from "@shared/lib/psi-view-model";

const ITEM_CLASS =
  "pharos-focus-ring inline-flex items-baseline gap-1.5 rounded-sm underline-offset-4 hover:text-foreground hover:underline";

function titleCaseBand(band: string): string {
  return band.charAt(0) + band.slice(1).toLowerCase();
}

/**
 * One-line "is anything wrong right now?" answer under the homepage h1. It
 * reuses the PSI query the global regime bar already holds and the peg-summary
 * census the Active Depegs card counts, so it adds no new data source.
 * Unavailable or non-fresh inputs say so rather than reading as calm.
 */
export function HomeMarketStateLine(): React.JSX.Element {
  const psiQuery = useStabilityIndex();
  const pegQuery = usePegSummary();

  const current = psiQuery.data?.current ?? null;
  const psi = current ? getDisplayedPsi(current) : null;
  // Same generation-aware freshness as the regime bar: an old sample re-served
  // in a fresh response must not read as current.
  const psiBeacon = usePsiBeaconState({
    current,
    meta: psiQuery.meta,
    dataUpdatedAt: psiQuery.dataUpdatedAt,
    error: psiQuery.error,
    isLoading: psiQuery.isLoading,
  });
  const psiStateLabel = psiBeacon.isCurrent ? null : (psiBeacon.health?.state ?? "unavailable");

  const pegCoins = pegQuery.data?.coins;
  const activeDepegCount = useMemo(
    () => (pegCoins ? selectActiveDepegCoins(pegCoins, ACTIVE_STABLECOIN_ID_SET).length : null),
    [pegCoins],
  );
  const pegHealth = deriveDataHealth({
    ...DATA_HEALTH_PRESETS.pegSummary,
    dataUpdatedAt: pegQuery.dataUpdatedAt,
    hasData: pegCoins !== undefined,
    error: pegQuery.error,
    meta: pegQuery.meta,
  });

  const psiBandClass = psi && psiBeacon.isCurrent && isConditionBand(psi.band)
    ? PSI_BAND_CLASSES[psi.band]
    : "text-foreground";

  return (
    <div
      role="group"
      aria-label="Market state right now"
      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-muted-foreground"
    >
      <Link href="/stability-index/" className={ITEM_CLASS}>
        <span>PSI</span>
        {psi ? (
          <>
            <span className={`font-medium ${psiBandClass}`}>{titleCaseBand(psi.band)}</span>
            <span className="pharos-numeric text-foreground">{psi.score.toFixed(1)}</span>
            {psiStateLabel ? <span className="text-xs">({psiStateLabel})</span> : null}
          </>
        ) : (
          <span className="text-foreground">{psiQuery.isLoading ? "…" : "unavailable"}</span>
        )}
      </Link>
      <span aria-hidden="true">·</span>
      <Link href="/depeg/" className={ITEM_CLASS}>
        {activeDepegCount !== null ? (
          <>
            <span className="pharos-numeric font-medium text-foreground">{activeDepegCount}</span>
            <span>active {activeDepegCount === 1 ? "depeg" : "depegs"}</span>
            {pegHealth.state !== "fresh" ? <span className="text-xs">({pegHealth.state})</span> : null}
          </>
        ) : (
          <>
            <span>Active depegs</span>
            <span className="text-foreground">{pegQuery.isLoading ? "…" : "unavailable"}</span>
          </>
        )}
      </Link>
    </div>
  );
}
