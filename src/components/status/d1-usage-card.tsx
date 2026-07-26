import { formatElapsedSeconds } from "@shared/lib/format";
import type { D1UsageSummary, StatusSectionError } from "@shared/types";
import { StatTile } from "@/components/stat-tile";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusCardEmptyState } from "@/components/status/page-primitives";

function formatBytes(value: number | null): string {
  if (value == null || !Number.isFinite(value) || value < 0) return "—";
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let scaled = value;
  let unitIndex = -1;
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }
  return `${scaled.toFixed(scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function formatCount(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString();
}

function formatGrowth(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "Collecting";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${formatBytes(value)}/day`;
}

function formatCapacityForecast(capacity: NonNullable<D1UsageSummary["capacity"]>): {
  value: string;
  subtext: string;
} {
  if (capacity.daysUntilExhaustion != null) {
    return {
      value: `${capacity.daysUntilExhaustion.toLocaleString()} days`,
      subtext: capacity.nextThresholdAt != null && capacity.nextThresholdPercent != null
        ? `${capacity.nextThresholdPercent}% near ${new Date(capacity.nextThresholdAt * 1000).toLocaleDateString()}`
        : "Projected time to the 10 GB limit",
    };
  }
  if (capacity.forecastBasis === "non-growing") {
    return {
      value: "No growth",
      subtext: `Flat or shrinking over ${capacity.forecastSpanHours.toLocaleString()}h`,
    };
  }
  return {
    value: "Collecting",
    subtext: `${capacity.sampleCount.toLocaleString()} samples across ${capacity.forecastSpanHours.toLocaleString()}h`,
  };
}

export function D1UsageCard({
  summary,
  error,
  nowSeconds,
}: {
  summary: D1UsageSummary | null;
  error?: StatusSectionError;
  nowSeconds: number;
}) {
  if (!summary) {
    return (
      <StatusCardEmptyState title="D1 Usage">
        {error
          ? `D1 usage loader failed: ${error.message}`
          : "Live D1 metrics are unavailable until the Cloudflare admin bindings are configured."}
      </StatusCardEmptyState>
    );
  }

  const checkedAgeSeconds = Math.max(0, nowSeconds - summary.checkedAt);
  const capacityForecast = summary.capacity ? formatCapacityForecast(summary.capacity) : null;
  const growthWindows = summary.capacity?.growthWindows ?? [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-3">
          <CardTitle as="h3" className="text-base">D1 Usage</CardTitle>
          <span className="text-xs text-muted-foreground">
            checked {formatElapsedSeconds(checkedAgeSeconds)} ago
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3">
          <StatTile
            label="Database Size"
            value={formatBytes(summary.databaseSizeBytes)}
            subtext={summary.capacity
              ? `${summary.capacity.utilizationPercent}% used · ${summary.capacity.thresholdState}`
              : summary.numTables != null
                ? `${formatCount(summary.numTables)} tables`
                : undefined}
          />
          {summary.capacity && capacityForecast ? (
            <StatTile
              label="Capacity Forecast"
              value={capacityForecast.value}
              subtext={capacityForecast.subtext}
            />
          ) : null}
          {growthWindows.map((window) => (
            <StatTile
              key={window.window}
              label={`${window.window} D1 Growth`}
              value={formatGrowth(window.growthBytesPerDay)}
              subtext={`${window.sampleCount.toLocaleString()} samples · ${window.spanHours.toLocaleString()}h span${summary.capacity?.conservativeWindow === window.window ? " · runway basis" : ""}`}
            />
          ))}
          <StatTile
            label="Rows Read (24h)"
            value={formatCount(summary.rowsRead24h)}
            subtext={`${formatCount(summary.readQueries24h)} read queries`}
          />
          <StatTile
            label="Rows Written (24h)"
            value={formatCount(summary.rowsWritten24h)}
            subtext={`${formatCount(summary.writeQueries24h)} write queries`}
          />
          <StatTile
            label="Replication"
            value={summary.readReplicationMode ?? "—"}
            subtext={summary.region ?? undefined}
          />
        </div>

        <div className="space-y-1 text-xs text-muted-foreground">
          <div>
            Database: {summary.databaseName ?? "unknown"} · {summary.databaseId}
          </div>
          {summary.capacity && summary.numTables != null ? (
            <div>
              Tables: {formatCount(summary.numTables)} · capacity observed {formatElapsedSeconds(Math.max(0, nowSeconds - summary.capacity.observedAt))} ago
            </div>
          ) : null}
          <div>
            Window: {new Date(summary.windowStart * 1000).toLocaleString()} to {new Date(summary.windowEnd * 1000).toLocaleString()}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
