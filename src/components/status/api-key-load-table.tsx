import { formatCompactCount, formatPercent } from "@shared/lib/format";
import type { ApiRequestAttributionResponse } from "@shared/types";
import { StatTile } from "@/components/stat-tile";
import { DataTableShell } from "@/components/data-table-shell";
import { TableCell, TableRow } from "@/components/table";
import { apiKeyStatusBadgeClassName, getApiKeyStatus } from "./api-key-status";
import { StatusPill } from "./severity-pill";
import { AttributionBadge, AttributionPanel } from "./attribution-panel";
import { defineStatusColumns, STATUS_PANEL_SHELL_CLASS } from "@/components/status/page-primitives";
import { cn } from "@/lib/utils";

const API_KEY_LOAD_COLUMNS = defineStatusColumns([
  ["key", "Key"], ["class", "Class"], ["requests", "Requests"], ["keyed-share", "Keyed Share"],
  ["public-api-share", "Public API Share"], ["rate-limit", "Rate Limit"], ["status", "Status"],
]);

function trafficClassBadgeClassName(trafficClass: "external" | "site"): string {
  return trafficClass === "site"
    ? "bg-sky-500/15 text-sky-700 dark:text-sky-300"
    : "bg-amber-500/15 text-amber-700 dark:text-amber-300";
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
          <code className="rounded bg-background/60 px-1 py-0.5 font-mono tabular-nums text-[0.92em] text-foreground">
            api.pharos.watch
          </code>{" "}
          lane. Excludes{" "}
          <code className="rounded bg-background/60 px-1 py-0.5 font-mono tabular-nums text-[0.92em] text-foreground">
            /_site-data/*
          </code>
          , the{" "}
          <code className="rounded bg-background/60 px-1 py-0.5 font-mono tabular-nums text-[0.92em] text-foreground">
            site-api
          </code>{" "}
          lane, and admin/telegram-webhook routes.
        </>
      }
      badges={
        summary ? (
          <>
            <AttributionBadge tone="sky">Keyed {formatPercent(summary.keyedSharePct, 1)}</AttributionBadge>
            <AttributionBadge>
              {formatCompactCount(summary.keyedRequests)} / {formatCompactCount(summary.totalRequests)} public-api
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
      {summary == null ? null : summary.keyedRequests <= 0 || apiKeys.length === 0 ? (
        <div className="rounded-lg border border-border/60 p-4 text-sm text-muted-foreground">
          No authenticated API-key load recorded in this window.
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <StatTile variant="tile" label="Keyed Requests" value={formatCompactCount(summary.keyedRequests)} />
            <StatTile variant="tile" label="Unkeyed Public API" value={formatCompactCount(summary.unkeyedRequests)} />
            <StatTile variant="tile" label="Keys In Window" value={formatCompactCount(summary.totalKeys)} />
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
                      {formatPercent(row.shareOfTotalPublicApiRequestsPct, 1)}
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
    </AttributionPanel>
  );
}
