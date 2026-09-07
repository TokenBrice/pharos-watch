import { FRESHNESS_RATIOS, STATUS_CACHE_RATIO_THRESHOLDS } from "@shared/lib/status-thresholds";
import type { CacheStatus } from "@shared/types";
import { formatElapsedSeconds } from "@shared/lib/format";
import { getCacheFreshnessRatio, getCacheFreshnessStatus } from "@shared/lib/cache-health";
import { PrioritySplitTable } from "./priority-split-table";
import { TableCell, TableRow } from "@/components/table";
import { StatusPill } from "./severity-pill";
import { PublicSignalCard } from "./public-signal-card";
import { OPERATIONAL_PILL_CLASS } from "@/lib/status/dashboard-presentation";
import { defineStatusColumns } from "./page-primitives";

interface CacheFreshnessTableProps {
  caches: Record<string, CacheStatus>;
}

const CACHE_FRESHNESS_COLUMNS = defineStatusColumns([
  ["lane", "Lane"], ["provider", "Provider"], ["producer", "Producer"], ["cache", "Cache"],
  ["endpoint-basis", "Endpoint Basis"], ["source", "Source"], ["mode", "Mode"], ["band", "Band"],
  ["note", "Actionable Note"],
]);

export function CacheFreshnessTable({ caches }: CacheFreshnessTableProps) {
  const sorted = Object.entries(caches).sort(([, a], [, b]) => {
    const ratioA = getCacheFreshnessRatio(a) ?? Infinity;
    const ratioB = getCacheFreshnessRatio(b) ?? Infinity;
    return ratioB - ratioA;
  });

  const describeBand = (cache: CacheStatus) => {
    const { ageSeconds } = cache;
    if (ageSeconds == null) {
      return {
        label: "missing",
        ratio: null,
        className: "bg-muted text-muted-foreground",
      };
    }

    const ratio = getCacheFreshnessRatio(cache);
    const status = getCacheFreshnessStatus(cache);
    if (status === "stale") {
      return {
        label: `stale (>${STATUS_CACHE_RATIO_THRESHOLDS.stale.toFixed(2)}x)`,
        ratio,
        className: OPERATIONAL_PILL_CLASS.error,
      };
    }
    if (status === "degraded") {
      return {
        label: `degraded (>${STATUS_CACHE_RATIO_THRESHOLDS.degraded.toFixed(2)}x)`,
        ratio,
        className: OPERATIONAL_PILL_CLASS.warning,
      };
    }
    return {
      label: "ok",
      ratio,
      className: OPERATIONAL_PILL_CLASS.ok,
    };
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

  const unhealthy = sorted.filter(([, cache]) => {
    const status = getCacheFreshnessStatus(cache);
    return status === "stale" || status === "degraded";
  });
  const ok = sorted.filter(([, cache]) => {
    const status = getCacheFreshnessStatus(cache);
    return status !== "stale" && status !== "degraded";
  });

  const renderRow = ([key, cache]: [string, CacheStatus]) => {
    const band = describeBand(cache);
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
          <div className="mt-1 text-[11px] text-muted-foreground">
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
            <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              warning after {formatElapsedSeconds(cache.endpointMaxAge * FRESHNESS_RATIOS.FRESH)}
            </div>
          ) : null}
          {budgetsDiffer ? (
            <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
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
          <StatusPill className={band.className}>{band.label}</StatusPill>
        </TableCell>
        <TableCell className="py-2 align-top text-xs leading-relaxed text-muted-foreground">
          {noteParts.length > 0 ? noteParts.join(" · ") : "No extra warning"}
        </TableCell>
      </TableRow>
    );
  };

  return (
    <PublicSignalCard title="Cache Freshness">
      <div>
        <div className="mb-3 text-xs text-muted-foreground">
          Availability uses ratio thresholds of {">"}
          {STATUS_CACHE_RATIO_THRESHOLDS.degraded.toFixed(2)}x (degraded) and {">"}
          {STATUS_CACHE_RATIO_THRESHOLDS.stale.toFixed(2)}x (stale) against each lane availability budget. Endpoint
          basis is the max-age used by `X-Data-Age` / `_meta`; generic freshness `Warning` starts after{" "}
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
