import {
  FRESHNESS_RATIOS,
  getCacheRatioThresholds,
  STATUS_CACHE_RATIO_THRESHOLDS,
} from "@shared/lib/status-thresholds";
import { PUBLIC_COMPONENT_OUTAGE_GRACE_MULTIPLIER } from "@shared/lib/public-health";
import type { CacheStatus } from "@shared/types";
import { formatElapsedSeconds } from "@shared/lib/format";
import { getCacheFreshnessRatio, getCacheFreshnessStatus } from "@shared/lib/cache-health";
import { PrioritySplitTable } from "./priority-split-table";
import { TableCell, TableRow } from "@/components/table";
import { StatusPill } from "./severity-pill";
import { PublicSignalCard } from "./public-signal-card";
import { OPERATIONAL_PILL_CLASS } from "@/lib/status/dashboard-presentation";
import { ComponentStatePill, defineStatusColumns } from "./page-primitives";
import { getAgeBandState } from "@/lib/status/public-status";
import type { PublicComponentState } from "@shared/types";

interface CacheFreshnessTableProps {
  caches: Record<string, CacheStatus>;
}

const CACHE_FRESHNESS_COLUMNS = defineStatusColumns([
  ["lane", "Lane"], ["provider", "Provider"], ["producer", "Producer"], ["cache", "Cache"],
  ["endpoint-basis", "Endpoint basis"], ["source", "Source"], ["mode", "Mode"], ["band", "Band"],
  ["note", "Note"],
]);

export function CacheFreshnessTable({ caches }: CacheFreshnessTableProps) {
  const sorted = Object.entries(caches).sort(([, a], [, b]) => {
    const ratioA = getCacheFreshnessRatio(a) ?? Infinity;
    const ratioB = getCacheFreshnessRatio(b) ?? Infinity;
    return ratioB - ratioA;
  });

  const describeBand = (cache: CacheStatus, key: string) => {
    const thresholds = getCacheRatioThresholds(key);
    const outageRatio = thresholds.stale * PUBLIC_COMPONENT_OUTAGE_GRACE_MULTIPLIER;
    const thresholdLabel =
      thresholds.degraded !== STATUS_CACHE_RATIO_THRESHOLDS.degraded ||
      thresholds.stale !== STATUS_CACHE_RATIO_THRESHOLDS.stale
        ? `Delayed >${thresholds.degraded.toFixed(2)}x · degraded >${thresholds.stale.toFixed(2)}x · outage >${outageRatio.toFixed(2)}x`
        : null;
    const ratio = getCacheFreshnessRatio(cache);
    // Missing age grades as Degraded, matching the public component projection.
    const state: PublicComponentState = ratio == null
      ? "degraded"
      : getAgeBandState(ratio, thresholds.degraded, thresholds.stale);
    return { state, ratio, thresholdLabel };
  };

  const describeSource = (cache: CacheStatus): string => {
    if (cache.sourceStatus === "none") return "No upstream source timestamp";
    if (cache.sourceAgeSeconds == null || !cache.sourceStatus) return "No upstream source sample";
    return `${cache.sourceStatus} · ${formatElapsedSeconds(cache.sourceAgeSeconds)}`;
  };

  const describeProducer = (cache: CacheStatus): string => {
    const interval =
      cache.producerIntervalSec != null ? `every ${formatElapsedSeconds(cache.producerIntervalSec)}` : null;
    return [cache.producerJob, interval].filter(Boolean).join(" · ") || "—";
  };

  const unhealthy = sorted.filter(([key, cache]) => {
    const status = getCacheFreshnessStatus(cache, key);
    return status === "stale" || status === "degraded";
  });
  const ok = sorted.filter(([key, cache]) => {
    const status = getCacheFreshnessStatus(cache, key);
    return status !== "stale" && status !== "degraded";
  });

  const renderRow = ([key, cache]: [string, CacheStatus]) => {
    const band = describeBand(cache, key);
    const modeLabel = cache.mode ?? "live";
    const budgetsDiffer =
      cache.endpointMaxAge != null && cache.endpointMaxAge !== (cache.availabilityMaxAge ?? cache.maxAge);
    const noteParts = [
      cache.warning,
      budgetsDiffer ? cache.endpointBudgetReason : null,
      budgetsDiffer ? cache.availabilityBudgetReason : null,
      cache.consecutiveFallbackRuns != null && cache.consecutiveFallbackRuns > 0
        ? `${cache.consecutiveFallbackRuns} fallback run(s)`
        : null,
    ].filter((part): part is string => !!part);

    return (
      <TableRow key={key} className="border-b last:border-0">
        <TableCell className="py-2 align-top">
          <div className="font-mono tabular-nums text-xs">{key}</div>
          <div className="mt-1 text-2xs text-muted-foreground">
            availability budget {formatElapsedSeconds(cache.availabilityMaxAge ?? cache.maxAge)}
          </div>
        </TableCell>
        <TableCell className="py-2 align-top text-xs">{cache.upstreamProvider ?? "—"}</TableCell>
        <TableCell className="py-2 align-top text-xs">{describeProducer(cache)}</TableCell>
        <TableCell className="py-2 align-top">
          <div>{cache.ageSeconds != null ? formatElapsedSeconds(cache.ageSeconds) : "—"}</div>
          <div className="mt-1 pharos-numeric text-xs text-muted-foreground">
            {band.ratio != null ? `${band.ratio.toFixed(2)}x` : "—"}
          </div>
        </TableCell>
        <TableCell className="py-2 align-top text-xs">
          {cache.endpointMaxAge != null ? `basis ${formatElapsedSeconds(cache.endpointMaxAge)}` : "—"}
          {cache.endpointMaxAge != null ? (
            <div className="mt-1 text-2xs leading-relaxed text-muted-foreground">
              warning after {formatElapsedSeconds(cache.endpointMaxAge * getCacheRatioThresholds(key).degraded)}
            </div>
          ) : null}
          {budgetsDiffer ? (
            <div className="mt-1 text-2xs leading-relaxed text-muted-foreground">
              endpoint basis differs from availability budget
            </div>
          ) : null}
        </TableCell>
        <TableCell className="py-2 align-top">{describeSource(cache)}</TableCell>
        <TableCell className="py-2 align-top">
          <StatusPill
            className={
              modeLabel === "cached-fallback"
                ? OPERATIONAL_PILL_CLASS.warning
                : OPERATIONAL_PILL_CLASS.unknown
            }
          >
            {modeLabel}
          </StatusPill>
        </TableCell>
        <TableCell className="py-2 align-top">
          <ComponentStatePill state={band.state} />
          {band.ratio == null ? (
            <div className="mt-1 text-xs leading-relaxed text-muted-foreground">Update time unavailable</div>
          ) : null}
          {band.thresholdLabel ? (
            <div className="mt-1 text-2xs leading-relaxed text-muted-foreground">{band.thresholdLabel}</div>
          ) : null}
        </TableCell>
        <TableCell className="py-2 align-top text-xs leading-relaxed text-muted-foreground">
          {noteParts.length > 0 ? noteParts.join(" · ") : "—"}
        </TableCell>
      </TableRow>
    );
  };

  return (
    <PublicSignalCard title="Cache freshness">
      <div>
        <div className="mb-3 text-xs text-muted-foreground">
          Each lane is Delayed past {STATUS_CACHE_RATIO_THRESHOLDS.degraded.toFixed(2)}x its availability budget,
          Degraded past {STATUS_CACHE_RATIO_THRESHOLDS.stale.toFixed(2)}x and an Outage past{" "}
          {(STATUS_CACHE_RATIO_THRESHOLDS.stale * PUBLIC_COMPONENT_OUTAGE_GRACE_MULTIPLIER).toFixed(2)}x. Endpoint
          basis is the max-age used by the X-Data-Age header and _meta; the generic freshness Warning header starts after{" "}
          {FRESHNESS_RATIOS.FRESH.toFixed(0)}x that basis.
        </div>
        <PrioritySplitTable
          primaryRows={unhealthy}
          secondaryRows={ok}
          columns={CACHE_FRESHNESS_COLUMNS}
          idPrefix="cache-freshness"
          primaryAriaLabel="Unhealthy cache freshness"
          secondaryAriaLabel="Healthy cache freshness"
          secondaryNoun="cache"
          renderRow={renderRow}
          primaryTableId="cache-freshness-unhealthy"
          secondaryTableId="cache-freshness-healthy"
          headerRowClassName="border-b text-left text-muted-foreground"
        />
      </div>
    </PublicSignalCard>
  );
}
