import { STATUS_CACHE_RATIO_THRESHOLDS } from "@shared/lib/status-thresholds";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatElapsedSeconds } from "@shared/lib/format";

interface CacheFreshnessTableProps {
  caches: Record<string, { ageSeconds: number | null; maxAge: number; healthy: boolean }>;
}

export function CacheFreshnessTable({ caches }: CacheFreshnessTableProps) {
  const sorted = Object.entries(caches).sort(([, a], [, b]) => {
    const ratioA = a.ageSeconds != null ? a.ageSeconds / a.maxAge : Infinity;
    const ratioB = b.ageSeconds != null ? b.ageSeconds / b.maxAge : Infinity;
    return ratioB - ratioA;
  });

  const describeBand = (ageSeconds: number | null, maxAge: number) => {
    if (ageSeconds == null) {
      return {
        label: "missing",
        ratio: null,
        className: "bg-muted text-muted-foreground",
      };
    }

    const ratio = ageSeconds / maxAge;
    if (ratio > STATUS_CACHE_RATIO_THRESHOLDS.stale) {
      return {
        label: `stale (>${STATUS_CACHE_RATIO_THRESHOLDS.stale.toFixed(2)}x)`,
        ratio,
        className: "bg-red-500/15 text-red-700 dark:text-red-400",
      };
    }
    if (ratio > STATUS_CACHE_RATIO_THRESHOLDS.degraded) {
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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Cache Freshness</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="mb-3 text-xs text-muted-foreground">
          Availability uses cache ratio thresholds of {">"}{STATUS_CACHE_RATIO_THRESHOLDS.degraded.toFixed(2)}x (degraded) and {">"}{STATUS_CACHE_RATIO_THRESHOLDS.stale.toFixed(2)}x (stale).
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th scope="col" className="pb-2 font-medium">Cache Key</th>
                <th scope="col" className="pb-2 font-medium">Age</th>
                <th scope="col" className="pb-2 font-medium">Max Age</th>
                <th scope="col" className="pb-2 font-medium">Ratio</th>
                <th scope="col" className="pb-2 font-medium">Band</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(([key, cache]) => {
                const band = describeBand(cache.ageSeconds, cache.maxAge);
                return (
                  <tr key={key} className="border-b last:border-0">
                    <td className="py-2 font-mono text-xs">{key}</td>
                    <td className="py-2">{cache.ageSeconds != null ? formatElapsedSeconds(cache.ageSeconds) : "—"}</td>
                    <td className="py-2">{formatElapsedSeconds(cache.maxAge)}</td>
                    <td className="py-2 font-mono text-xs">
                      {band.ratio != null ? `${band.ratio.toFixed(2)}x` : "—"}
                    </td>
                    <td className="py-2">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${band.className}`}>
                        {band.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
