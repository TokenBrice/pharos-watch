"use client";

import { OpsStatusChip } from "@/components/ops-status-chip";
import type { ApiMeta } from "@/lib/api";
import { deriveDataHealth, isPublicWarning } from "@/lib/data-health";
import { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";
import { useFreshnessBoundary } from "@/hooks/use-freshness-boundary";
import { formatElapsedSeconds } from "@shared/lib/format";
import { FRESHNESS_RATIOS } from "@shared/lib/status-thresholds";

/**
 * A materially stale `/api/chains` supply generation shows as a hero chip (on `/chains/` and chain profiles), never a
 * body callout, and ages at its producer budgets without another fetch. Degraded reads and non-fresh report-card
 * dependencies are operator signal only (ADR-42); held Chain Health explains itself as NR beside the values.
 */
export function ChainsFreshnessChip({ meta, dataUpdatedAt = 0 }: { meta: ApiMeta | null | undefined; dataUpdatedAt?: number }) {
  const input = { ...DATA_HEALTH_PRESETS.chains, meta, dataUpdatedAt, hasData: meta != null };
  const nowMs = useFreshnessBoundary([input], meta != null);
  // Absent metadata is the route's loading or no-data state, which owns unavailability.
  if (!meta) return null;
  const health = deriveDataHealth(input, nowMs ?? dataUpdatedAt);
  if (!isPublicWarning(health) || health.state !== "stale") return null;
  // Header-derived meta carries no budget; the endpoint's own authority does (R3/R5).
  const staleAfterSec = "degradedBudgetSec" in meta && meta.degradedBudgetSec != null
    ? meta.degradedBudgetSec
    : (input.staleTime / 1000) * FRESHNESS_RATIOS.DEGRADED;
  return (
    <OpsStatusChip label="Stale data" reasonCodes={[`api-${meta.status}`, `health-${health.state}`]}>
      <p>{health.message}</p>
      {health.dataUpdatedAt > 0 && health.ageMs != null ? (
        <p className="text-muted-foreground">
          Supply snapshot as of{" "}
          <time dateTime={new Date(health.dataUpdatedAt).toISOString()}>
            {new Date(health.dataUpdatedAt).toISOString().slice(0, 16).replace("T", " ")} UTC
          </time>
          , {formatElapsedSeconds(health.ageMs / 1000)} old; stale after {formatElapsedSeconds(staleAfterSec)}.
        </p>
      ) : null}
    </OpsStatusChip>
  );
}
