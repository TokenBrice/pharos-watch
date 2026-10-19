import { formatCompactCount, formatPercent } from "@shared/lib/format";
import type { ApiRequestAttributionResponse } from "@pharos/contracts/request-source";
import { StatTile } from "@/components/stat-tile";
import { DataTableShell } from "@/components/data-table-shell";
import { TableCell, TableRow } from "@/components/table";
import { apiKeyStatusBadgeClassName, getApiKeyStatus } from "./api-key-status";
import { StatusPill } from "./severity-pill";
import { AttributionBadge, AttributionMeasurementNote, AttributionPanel, formatAttributionValue } from "./attribution-panel";
import { defineStatusColumns, STATUS_PANEL_SHELL_CLASS } from "@/components/status/page-primitives";
import { cn } from "@/lib/utils";

const API_KEY_LOAD_COLUMNS = defineStatusColumns([
  ["key", "Key"], ["class", "Class"], ["requests", "Requests"], ["keyed-share", "Keyed Share"],
  ["public-api-share", "Public API Share"], ["rate-limit", "Rate Limit"], ["status", "Status"],
]);

function trafficClassBadgeClassName(trafficClass: "external" | "site"): string {
  return trafficClass === "site"
    ? "bg-state-info-solid/15 text-state-info-bright"
    : "bg-state-warn-solid/15 text-state-warn-bright";
}

export function ApiKeyLoadTable({
  stats,
  error,
  isLoading,
}: {
  stats: ApiRequestAttributionResponse | null | undefined;
  error?: string | null;
  isLoading?: boolean;
}) {
  const summary = stats?.keyedPublicApi ?? null;
  const apiKeys = stats?.apiKeys ?? [];
  const nowSeconds = stats?.generatedAt ?? 0;
  const windowHours = stats ? Math.round(stats.window.durationSec / 3600) : null;

  return (
    <AttributionPanel
      title="API Key Load"
      windowHours={windowHours}
      description={
        <>
          Authenticated API-key requests on the public{" "}
          <code className="rounded-sm bg-background/60 px-1 py-0.5 font-mono tabular-nums text-[0.92em] text-foreground">
            api.pharos.watch
          </code>{" "}
          lane. Excludes{" "}
          <code className="rounded-sm bg-background/60 px-1 py-0.5 font-mono tabular-nums text-[0.92em] text-foreground">
            /_site-data/*
          </code>
          , the{" "}
          <code className="rounded-sm bg-background/60 px-1 py-0.5 font-mono tabular-nums text-[0.92em] text-foreground">
            site-api
          </code>{" "}
          lane, and admin/telegram-webhook routes.
        </>
      }
      badges={
        summary ? (
          <>
            <AttributionBadge tone="sky">Keyed {formatAttributionValue(summary.keyedSharePct, summary.measurement.keyedSharePct, true)}</AttributionBadge>
            <AttributionBadge>
              {formatCompactCount(summary.keyedRequests)} recorded / {formatAttributionValue(summary.totalRequests, summary.measurement.totalRequests)} public-api
              requests
            </AttributionBadge>
          </>
        ) : null
      }
      error={error}
      isLoading={isLoading}
      hasData={summary != null}
      loadingLabel="Loading API key load..."
      emptyLabel="No keyed public API data yet."
    >
      {summary == null ? null : (
        <div className="space-y-3">
          <AttributionMeasurementNote measurement={summary.measurement.totalRequests} />
          <p className="text-xs text-muted-foreground">
            Per-key counts and keyed shares are recorded, unsampled. Public API shares use recorded keyed plus directly estimated unkeyed demand; this denominator can differ from the Worker lane estimate.
          </p>
          {summary.keyedRequests <= 0 || apiKeys.length === 0 ? (
        <div className="rounded-lg border border-border/60 p-4 text-sm text-muted-foreground">
          No authenticated API-key load recorded in this window.
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <StatTile variant="tile" label="Keyed requests" value={formatCompactCount(summary.keyedRequests)} />
            <StatTile variant="tile" label="Unkeyed public API" value={formatAttributionValue(summary.unkeyedRequests, summary.measurement.unkeyedRequests)} />
            <StatTile variant="tile" label="Keys in window" value={formatCompactCount(summary.totalKeys)} />
          </div>

          {summary.truncated ? (
            <div className={cn("rounded-lg px-3 py-2 text-xs text-muted-foreground", STATUS_PANEL_SHELL_CLASS)}>
              Showing the top {stats?.window.apiKeyLimit ?? apiKeys.length} keys by volume.{" "}
              {formatCompactCount(summary.omittedKeys)} more key{summary.omittedKeys === 1 ? "" : "s"} account for{" "}
              {formatCompactCount(summary.omittedRequests)} additional keyed requests in this window.
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              {formatCompactCount(summary.returnedKeys)} key{summary.returnedKeys === 1 ? "" : "s"} recorded in this
              window.
            </div>
          )}

          <DataTableShell
            tableId="api-key-load"
            testId="api-key-load-table"
            columns={API_KEY_LOAD_COLUMNS}
            chrome="content"
            density="compact"
            tableClassName="min-w-[760px]"
            tableProps={{ "aria-label": "API key load" }}
            headerClassName=""
            headerRowClassName="border-b text-left text-muted-foreground"
          >
            {apiKeys.map((row) => {
                const status = getApiKeyStatus(row, nowSeconds);
                return (
                  <TableRow key={row.apiKeyId} className="border-b last:border-0">
                    <TableCell className="py-2 align-top">
                      <div className="font-medium text-foreground">{row.name}</div>
                      <div className="mt-1 font-mono tabular-nums text-xs text-muted-foreground">{row.maskedToken}</div>
                    </TableCell>
                    <TableCell className="py-2 align-top">
                      <StatusPill className={trafficClassBadgeClassName(row.trafficClass)}>
                        {row.trafficClass}
                      </StatusPill>
                    </TableCell>
                    <TableCell className="py-2 align-top pharos-numeric text-foreground">
                      {formatCompactCount(row.requestCount)}
                    </TableCell>
                    <TableCell className="py-2 align-top pharos-numeric text-foreground">
                      {formatPercent(row.shareOfKeyedRequestsPct, 1)}
                    </TableCell>
                    <TableCell className="py-2 align-top pharos-numeric text-foreground">
                      {formatAttributionValue(row.shareOfTotalPublicApiRequestsPct, row.measurement.shareOfTotalPublicApiRequestsPct, true)}
                    </TableCell>
                    <TableCell className="py-2 align-top pharos-numeric text-muted-foreground">
                      {formatCompactCount(row.rateLimitPerMinute)}/min
                    </TableCell>
                    <TableCell className="py-2 align-top">
                      <StatusPill className={apiKeyStatusBadgeClassName(status)}>
                        {status}
                      </StatusPill>
                    </TableCell>
                  </TableRow>
                );
              })}
          </DataTableShell>
        </div>
          )}
        </div>
      )}
    </AttributionPanel>
  );
}
