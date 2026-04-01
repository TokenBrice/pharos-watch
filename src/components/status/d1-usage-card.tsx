import { formatElapsedSeconds } from "@shared/lib/format";
import type { D1UsageSummary, StatusSectionError } from "@shared/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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

function Metric({
  label,
  value,
  subtext,
}: {
  label: string;
  value: string;
  subtext?: string;
}) {
  return (
    <div className="rounded-lg border border-border/50 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-mono text-xl font-bold">{value}</div>
      {subtext ? <div className="text-xs text-muted-foreground">{subtext}</div> : null}
    </div>
  );
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
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">D1 Usage</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {error
              ? `D1 usage loader failed: ${error.message}`
              : "Live D1 metrics are unavailable until the Cloudflare admin bindings are configured."}
          </p>
        </CardContent>
      </Card>
    );
  }

  const checkedAgeSeconds = Math.max(0, nowSeconds - summary.checkedAt);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base">D1 Usage</CardTitle>
          <span className="text-xs text-muted-foreground">
            checked {formatElapsedSeconds(checkedAgeSeconds)} ago
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <Metric
            label="Database Size"
            value={formatBytes(summary.databaseSizeBytes)}
            subtext={summary.numTables != null ? `${formatCount(summary.numTables)} tables` : undefined}
          />
          <Metric
            label="Rows Read (24h)"
            value={formatCount(summary.rowsRead24h)}
            subtext={`${formatCount(summary.readQueries24h)} read queries`}
          />
          <Metric
            label="Rows Written (24h)"
            value={formatCount(summary.rowsWritten24h)}
            subtext={`${formatCount(summary.writeQueries24h)} write queries`}
          />
          <Metric
            label="Replication"
            value={summary.readReplicationMode ?? "—"}
            subtext={summary.region ?? undefined}
          />
        </div>

        <div className="space-y-1 text-xs text-muted-foreground">
          <div>
            Database: {summary.databaseName ?? "unknown"} · {summary.databaseId}
          </div>
          <div>
            Window: {new Date(summary.windowStart * 1000).toLocaleString()} to {new Date(summary.windowEnd * 1000).toLocaleString()}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
