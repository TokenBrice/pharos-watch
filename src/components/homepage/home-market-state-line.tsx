"use client";

import Link from "next/link";
import { useHomepageSnapshot, usePegSummary, useStabilityIndex } from "@/hooks/api-hooks";
import { deriveDataHealth } from "@/lib/data-health";
import { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";
import { PSI_BAND_CLASSES, isConditionBand } from "@shared/lib/classification";
import { getDisplayedPsi } from "@shared/lib/psi-view-model";
import { useHomepageEvidence } from "@/lib/homepage-evidence";

const ITEM_CLASS =
  "pharos-focus-ring inline-flex items-baseline gap-1.5 rounded-sm underline-offset-4 hover:text-foreground hover:underline";

function titleCaseBand(band: string): string {
  return band.charAt(0) + band.slice(1).toLowerCase();
}

/** Compact lanes preserve the same displayed PSI and confirmed non-NAV census. */
export function HomeMarketStateLine({ nowMs }: { nowMs?: number }): React.JSX.Element {
  const query = useHomepageSnapshot();
  // Passive cache fallbacks (enabled: false -> zero extra network fetches):
  // if the compact snapshot fails or omits a lane while Pulse cards below have
  // live data in cache, surface that live reading rather than printing "—".
  const psiFallbackQuery = useStabilityIndex({ enabled: false });
  const pegFallbackQuery = usePegSummary({ enabled: false });
  const evidence = useHomepageEvidence(query.data, nowMs);
  const psiLane = evidence.data?.psi;
  const incidentLane = evidence.data?.incidents;

  const fallbackPsiCurrent = psiFallbackQuery.data?.current ?? null;
  const fallbackDisplayedPsi = fallbackPsiCurrent ? getDisplayedPsi(fallbackPsiCurrent) : null;
  const usingFallbackPsi = psiLane?.data == null && fallbackDisplayedPsi !== null;
  const psi = psiLane?.data ?? (fallbackDisplayedPsi && fallbackPsiCurrent
    ? { score: fallbackDisplayedPsi.score, band: fallbackDisplayedPsi.band, computedAt: fallbackPsiCurrent.computedAt }
    : null);

  const psiHealth = deriveDataHealth({
    ...DATA_HEALTH_PRESETS.stabilityIndex,
    dataUpdatedAt: usingFallbackPsi ? psiFallbackQuery.dataUpdatedAt : query.dataUpdatedAt,
    hasData: psi !== null,
    error: usingFallbackPsi ? psiFallbackQuery.error : query.error,
    meta: usingFallbackPsi ? psiFallbackQuery.meta : psiLane?.meta,
  }, nowMs);
  const psiCurrent = psi !== null && psiHealth.state === "fresh";
  const incidentData = incidentLane?.data ?? pegFallbackQuery.data?.summary ?? null;
  const activeDepegCount = incidentData?.activeDepegCount ?? null;
  const hasIncidentSplit =
    incidentData != null
    && incidentData.recentActiveDepegCount != null
    && incidentData.longRunningActiveDepegCount != null
    && incidentData.recentActiveDepegCount + incidentData.longRunningActiveDepegCount === incidentData.activeDepegCount;
  const recentActiveDepegCount = hasIncidentSplit ? incidentData.recentActiveDepegCount! : null;
  const longRunningActiveDepegCount = hasIncidentSplit ? incidentData.longRunningActiveDepegCount! : null;
  const showIncidentSplit = longRunningActiveDepegCount !== null && longRunningActiveDepegCount > 0;

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
            <span>active {activeDepegCount === 1 ? "depeg" : "depegs"}</span>
            {showIncidentSplit ? (
              <span className="pharos-numeric text-xs text-muted-foreground">
                {recentActiveDepegCount === 0
                  ? "(all >30d)"
                  : `(${recentActiveDepegCount} recent · ${longRunningActiveDepegCount} >30d)`}
              </span>
            ) : null}
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
