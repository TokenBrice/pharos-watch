import { STATUS_CACHE_RATIO_THRESHOLDS } from "@shared/lib/status-thresholds";
import type { CacheStatus } from "@shared/types";
import { formatElapsedSeconds } from "@shared/lib/format";
import { getCacheFreshnessRatio, getCacheFreshnessStatus } from "@shared/lib/cache-health";

interface CacheFreshnessTableProps {
  caches: Record<string, CacheStatus>;
}

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
        className: "bg-red-500/15 text-red-700 dark:text-red-400",
      };
    }
    if (status === "degraded") {
      return {
        label: `degraded (>${STATUS_CACHE_RATIO_THRESHOLDS.degraded.toFixed(2)}x)`,
        ratio,
        className: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
      };
    }
    return {
      label: "ok",
      ratio,
      className: "bg-green-500/15 text-green-700 dark:text-green-400",
    };
  };

  const describeSource = (cache: CacheStatus): string => {
    if (cache.sourceStatus === "none") return "No upstream source timestamp";
    if (cache.sourceAgeSeconds == null || !cache.sourceStatus) return "No upstream source sample";
    return `${cache.sourceStatus} · ${formatElapsedSeconds(cache.sourceAgeSeconds)}`;
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
    const noteParts = [
      cache.warning,
      cache.consecutiveFallbackRuns != null && cache.consecutiveFallbackRuns > 0
        ? `${cache.consecutiveFallbackRuns} fallback run(s)`
        : null,
    ].filter((part): part is string => !!part);

    return (
      <tr key={key} className="border-b last:border-0">
        <td className="py-2 align-top">
          <div className="font-mono text-xs">{key}</div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            target {formatElapsedSeconds(cache.maxAge)}
          </div>
        </td>
        <td className="py-2 align-top">
          <div>{cache.ageSeconds != null ? formatElapsedSeconds(cache.ageSeconds) : "—"}</div>
          <div className="mt-1 font-mono text-xs text-muted-foreground">
            {band.ratio != null ? `${band.ratio.toFixed(2)}x` : "—"}
          </div>
        </td>
        <td className="py-2 align-top">{describeSource(cache)}</td>
        <td className="py-2 align-top">
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
              modeLabel === "cached-fallback"
                ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                : "bg-muted text-muted-foreground"
            }`}
          >
            {modeLabel}
          </span>
        </td>
        <td className="py-2 align-top">
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${band.className}`}>
            {band.label}
          </span>
        </td>
        <td className="py-2 align-top text-xs leading-relaxed text-muted-foreground">
          {noteParts.length > 0 ? noteParts.join(" · ") : "No extra warning"}
        </td>
      </tr>
    );
  };

  const tableHead = (
    <thead>
      <tr className="border-b text-left text-muted-foreground">
        <th scope="col" className="pb-2 font-medium">Lane</th>
        <th scope="col" className="pb-2 font-medium">Cache</th>
        <th scope="col" className="pb-2 font-medium">Source</th>
        <th scope="col" className="pb-2 font-medium">Mode</th>
        <th scope="col" className="pb-2 font-medium">Band</th>
        <th scope="col" className="pb-2 font-medium">Actionable Note</th>
      </tr>
    </thead>
  );

  return (
    <article className="rounded-[1.35rem] border border-black/7 bg-[linear-gradient(180deg,oklch(0.995_0.004_248_/_0.96),oklch(0.972_0.01_248_/_0.99))] p-5 shadow-[inset_0_1px_0_oklch(1_0_0_/0.72),0_16px_36px_oklch(0_0_0_/0.08)] dark:border-white/10 dark:bg-[linear-gradient(180deg,oklch(0.16_0.014_248_/_0.78),oklch(0.12_0.01_248_/_0.9))] dark:shadow-[0_16px_36px_oklch(0_0_0_/0.12)]">
      <h3 className="text-base font-semibold tracking-tight text-foreground">Cache Freshness</h3>
      <div className="mt-4">
        <div className="mb-3 text-xs text-muted-foreground">
          Availability uses cache ratio thresholds of {">"}{STATUS_CACHE_RATIO_THRESHOLDS.degraded.toFixed(2)}x (degraded) and {">"}{STATUS_CACHE_RATIO_THRESHOLDS.stale.toFixed(2)}x (stale).
        </div>
        <div className="overflow-x-auto">
          {unhealthy.length > 0 && (
            <table className="w-full text-sm">
              {tableHead}
              <tbody>{unhealthy.map(renderRow)}</tbody>
            </table>
          )}
          {ok.length > 0 && (
            <details className={unhealthy.length > 0 ? "mt-4" : undefined}>
              <summary className="cursor-pointer text-sm text-muted-foreground">
                {ok.length} healthy cache{ok.length !== 1 ? "s" : ""}
              </summary>
              <table className="mt-2 w-full text-sm">
                {unhealthy.length === 0 && tableHead}
                <tbody>{ok.map(renderRow)}</tbody>
              </table>
            </details>
          )}
        </div>
      </div>
    </article>
  );
}
