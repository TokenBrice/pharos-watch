"use client";

import { OpsStatusChip } from "@/components/ops-status-chip";
import type { ApiMeta } from "@/lib/api";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { formatElapsedSeconds } from "@shared/lib/format";
import { FRESHNESS_RATIOS } from "@shared/lib/status-thresholds";

/**
 * Degraded or stale `/api/chains` reads as a hero chip (on `/chains/` and chain profiles), never a body callout. A non-fresh report-card dependency names itself,
 * because it alone is why every chain's Chain Health is NR while supply and shares still publish.
 */
export function ChainsFreshnessChip({ meta }: { meta: ApiMeta | null | undefined }) {
  if (!meta || (meta.status === "fresh" && !meta.warning)) return null;
  const reportCards = meta.dependencies?.reportCards;
  const healthHeld = reportCards != null && reportCards.status !== "fresh";
  const stale = meta.status === "stale";
  // Header-derived meta carries no budget; the endpoint's own authority does (R3/R5).
  const freshBudgetSec = "freshBudgetSec" in meta && meta.freshBudgetSec != null
    ? meta.freshBudgetSec
    : API_FRESHNESS_MAX_AGE_SEC.chains * FRESHNESS_RATIOS.FRESH;
  return (
    <OpsStatusChip
      label={
        healthHeld
          ? `Chain Health inputs ${reportCards.status === "stale" || reportCards.status === "unavailable" ? reportCards.status : "delayed"}`
          : stale ? "Stale data" : "Delayed data"
      }
      reasonCodes={[
        `api-${meta.status}`,
        ...(healthHeld ? [`report-cards-${reportCards.status}`, ...(reportCards.reason ? [reportCards.reason] : [])] : []),
      ]}
    >
      {healthHeld ? (
        <p>
          Safety Score inputs are {reportCards.status}
          {reportCards.ageSeconds != null ? ` (${formatElapsedSeconds(reportCards.ageSeconds)} old)` : ""}, so Chain Health is
          not rated (NR) until a fresh publication lands.
        </p>
      ) : null}
      {meta.warning ? <p>{meta.warning}</p> : null}
      <p className="text-muted-foreground">
        {meta.updatedAt != null ? `Supply snapshot ${formatElapsedSeconds(meta.ageSeconds ?? 0)} old` : "Snapshot time unknown"}; fresh
        budget {Math.round(freshBudgetSec / 60)} min.
      </p>
    </OpsStatusChip>
  );
}
