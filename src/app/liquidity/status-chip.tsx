"use client";

import { OpsStatusChip } from "@/components/ops-status-chip";
import type { LiquidityStatsData } from "@/components/liquidity-stats-types";
import type { ApiMeta } from "@/lib/api";
import { deriveDataHealth } from "@/lib/data-health";
import { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";
import { useFreshnessBoundary } from "@/hooks/use-freshness-boundary";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { formatDateTimeLocale } from "@shared/lib/format";
import { FRESHNESS_RATIOS } from "@shared/lib/status-thresholds";
import { formatLiquidityWarningMessage } from "./model";

/** Ops state for the hero beam, aging the served generation without another fetch. */
export function LiquidityStatusChip({
  meta,
  stats,
  dataUpdatedAt = 0,
  error,
}: {
  meta: ApiMeta | null | undefined;
  stats: LiquidityStatsData;
  dataUpdatedAt?: number;
  error?: unknown;
}) {
  const input = { ...DATA_HEALTH_PRESETS.dexLiquidity, meta, dataUpdatedAt, error, hasData: true };
  const nowMs = useFreshnessBoundary([input]);
  const health = deriveDataHealth(input, nowMs ?? dataUpdatedAt);
  if (stats.totalTvlUnavailableReason != null) {
    return (
      <OpsStatusChip label="Depth unavailable" reasonCodes={[stats.totalTvlUnavailableReason]}>
        <p>No global DEX depth is published for this snapshot, so the figure shows a dash rather than a total.</p>
      </OpsStatusChip>
    );
  }
  if (health.state === "fresh") return null;
  const warnCodes = (meta?.warning?.match(/\b\d{3}(?= - )/g) ?? []).map((code) => `warn-${code}`);
  // HTTP 110 ("Response is stale") names the state, whatever the age tier says.
  const stale = health.state === "stale" || warnCodes.includes("warn-110");
  // Header-derived meta carries no budget; the endpoint's own authority does (R3/R5).
  const freshBudgetSec = meta && "freshBudgetSec" in meta && meta.freshBudgetSec != null
    ? meta.freshBudgetSec
    : API_FRESHNESS_MAX_AGE_SEC.dexLiquidity * FRESHNESS_RATIOS.FRESH;
  return (
    <OpsStatusChip
      label={health.state === "unavailable" ? "Data unavailable" : stale ? "Stale data" : error ? "Refresh failed" : health.degradationReason === "source" ? "Data warning" : "Delayed data"}
      reasonCodes={[`api-${meta?.status ?? "unknown"}`, `health-${health.state}`, ...warnCodes]}
    >
      <p>{health.message}</p>
      {meta?.warning ? <p>{formatLiquidityWarningMessage(meta.warning)}.</p> : null}
      <p className="text-muted-foreground">
        {health.dataUpdatedAt > 0 ? <>Snapshot as of <time dateTime={new Date(health.dataUpdatedAt).toISOString()}>{formatDateTimeLocale(health.dataUpdatedAt / 1000)}</time>; </> : "Snapshot time unknown; "}
        fresh budget {Math.round(freshBudgetSec / 3600)}h.
      </p>
    </OpsStatusChip>
  );
}
