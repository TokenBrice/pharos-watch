"use client";

import { OpsStatusChip } from "@/components/ops-status-chip";
import type { LiquidityStatsData } from "@/components/liquidity-stats-types";
import type { ApiMeta } from "@/lib/api";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { formatDateTimeLocale } from "@shared/lib/format";
import { FRESHNESS_RATIOS } from "@shared/lib/status-thresholds";
import { formatLiquidityWarningMessage } from "./model";

/** Ops state for the hero beam: the API warning or an unpublished global depth. */
export function LiquidityStatusChip({ meta, stats }: { meta: ApiMeta | null | undefined; stats: LiquidityStatsData }) {
  if (stats.totalTvlUnavailableReason != null) {
    return (
      <OpsStatusChip label="Depth unavailable" reasonCodes={[stats.totalTvlUnavailableReason]}>
        <p>No global DEX depth is published for this snapshot, so the figure shows a dash rather than a total.</p>
      </OpsStatusChip>
    );
  }
  if (!meta || (!meta.warning && meta.status !== "degraded" && meta.status !== "stale")) return null;
  const warnCodes = (meta.warning?.match(/\b\d{3}(?= - )/g) ?? []).map((code) => `warn-${code}`);
  // HTTP 110 ("Response is stale") names the state, whatever the age tier says.
  const stale = meta.status === "stale" || warnCodes.includes("warn-110");
  // Header-derived meta carries no budget; the endpoint's own authority does (R3/R5).
  const freshBudgetSec = "freshBudgetSec" in meta && meta.freshBudgetSec != null
    ? meta.freshBudgetSec
    : API_FRESHNESS_MAX_AGE_SEC.dexLiquidity * FRESHNESS_RATIOS.FRESH;
  return (
    <OpsStatusChip
      label={stale ? "Stale data" : meta.warning ? "Data warning" : "Delayed data"}
      reasonCodes={[`api-${meta.status}`, ...warnCodes]}
    >
      {meta.warning ? <p>{formatLiquidityWarningMessage(meta.warning)}.</p> : null}
      <p className="text-muted-foreground">
        {meta.updatedAt != null ? `Snapshot as of ${formatDateTimeLocale(meta.updatedAt)}; ` : "Snapshot time unknown; "}
        fresh budget {Math.round(freshBudgetSec / 3600)}h.
      </p>
    </OpsStatusChip>
  );
}
