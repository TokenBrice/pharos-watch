"use client";

import Link from "next/link";
import { useHomepageSnapshot } from "@/hooks/api-hooks";
import { deriveDataHealth } from "@/lib/data-health";
import { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";
import { PSI_BAND_CLASSES, isConditionBand } from "@shared/lib/classification";
import { useHomepageEvidence } from "@/lib/homepage-evidence";

const ITEM_CLASS =
  "pharos-focus-ring inline-flex items-baseline gap-1.5 rounded-sm underline-offset-4 hover:text-foreground hover:underline";

function titleCaseBand(band: string): string {
  return band.charAt(0) + band.slice(1).toLowerCase();
}

/** Compact lanes preserve the same displayed PSI and confirmed non-NAV census. */
export function HomeMarketStateLine({ nowMs }: { nowMs?: number }): React.JSX.Element {
  const query = useHomepageSnapshot();
  const evidence = useHomepageEvidence(query.data, nowMs);
  const psiLane = evidence.data?.psi;
  const incidentLane = evidence.data?.incidents;
  const psi = psiLane?.data ?? null;
  const psiHealth = deriveDataHealth({
    ...DATA_HEALTH_PRESETS.stabilityIndex,
    dataUpdatedAt: query.dataUpdatedAt,
    hasData: psi !== null,
    error: query.error,
    meta: psiLane?.meta,
  }, nowMs);
  const psiCurrent = psi !== null && psiHealth.state === "fresh";
  const activeDepegCount = incidentLane?.data?.activeDepegCount ?? null;

  const psiBandClass = psi && psiCurrent && isConditionBand(psi.band)
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
          </>
        ) : (
          <span className="text-foreground">{query.isLoading ? "…" : "—"}</span>
        )}
      </Link>
      <span aria-hidden="true">·</span>
      <Link href="/depeg/" className={ITEM_CLASS}>
        {activeDepegCount !== null ? (
          <>
            <span className="pharos-numeric font-medium text-foreground">{activeDepegCount}</span>
            <span>{activeDepegCount === 1 ? "coin with an open confirmed incident" : "coins with open confirmed incidents"}</span>
          </>
        ) : (
          <>
            <span>Active depegs</span>
            <span className="text-foreground">{query.isLoading ? "…" : "—"}</span>
          </>
        )}
      </Link>
    </div>
  );
}
