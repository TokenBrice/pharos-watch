import { formatCompactCount, formatPercent } from "@shared/lib/format";
import type { ApiRequestAttributionResponse } from "@shared/types";
import { apiKeyStatusBadgeClassName, getApiKeyStatus } from "./api-key-status";

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
    <article className="rounded-xl border border-border/50 bg-card/60 p-5 dark:bg-card/30">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold tracking-tight text-foreground">API Key Load</h3>
            {windowHours != null ? (
              <span className="rounded-full border border-border/60 bg-background/50 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {windowHours}h window
              </span>
            ) : null}
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Authenticated API-key requests on the public
            {" "}
            <code className="rounded bg-background/60 px-1 py-0.5 font-mono text-[0.92em] text-foreground">api.pharos.watch</code>
            {" "}
            lane. Excludes
            {" "}
            <code className="rounded bg-background/60 px-1 py-0.5 font-mono text-[0.92em] text-foreground">/_site-data/*</code>
            , the
            {" "}
            <code className="rounded bg-background/60 px-1 py-0.5 font-mono text-[0.92em] text-foreground">site-api</code>
            {" "}
            lane, and admin/telegram-webhook routes.
          </p>
        </div>
        {summary ? (
          <div className="flex flex-wrap gap-2">
            <span className="rounded-full border border-sky-500/25 bg-sky-500/10 px-2.5 py-1 text-[11px] font-medium text-sky-700 dark:text-sky-300">
              Keyed {formatPercent(summary.keyedSharePct, 1)}
            </span>
            <span className="rounded-full border border-border/60 bg-background/50 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
              {formatCompactCount(summary.keyedRequests)} / {formatCompactCount(summary.totalRequests)} public-api requests
            </span>
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          {error}
        </div>
      ) : isLoading && !stats ? (
        <div className="mt-4 text-sm text-muted-foreground">Loading API key load...</div>
      ) : !summary ? (
        <div className="mt-4 text-sm text-muted-foreground">No keyed public API data yet.</div>
      ) : summary.keyedRequests <= 0 || apiKeys.length === 0 ? (
        <div className="mt-4 rounded-lg border border-border/60 p-4 text-sm text-muted-foreground">
          No authenticated API-key load recorded in this window.
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-border/60 bg-background/45 p-3">
              <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Keyed Requests</div>
              <div className="mt-1 font-mono text-xl font-semibold text-foreground">{formatCompactCount(summary.keyedRequests)}</div>
            </div>
            <div className="rounded-xl border border-border/60 bg-background/45 p-3">
              <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Unkeyed Public API</div>
              <div className="mt-1 font-mono text-xl font-semibold text-foreground">{formatCompactCount(summary.unkeyedRequests)}</div>
            </div>
            <div className="rounded-xl border border-border/60 bg-background/45 p-3">
              <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Keys In Window</div>
              <div className="mt-1 font-mono text-xl font-semibold text-foreground">{formatCompactCount(summary.totalKeys)}</div>
            </div>
          </div>

          {summary.truncated ? (
            <div className="rounded-lg border border-border/60 bg-background/35 px-3 py-2 text-xs text-muted-foreground">
              Showing the top {stats?.window.apiKeyLimit ?? apiKeys.length} keys by volume. {formatCompactCount(summary.omittedKeys)} more key{summary.omittedKeys === 1 ? "" : "s"} account for {formatCompactCount(summary.omittedRequests)} additional keyed requests in this window.
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              {formatCompactCount(summary.returnedKeys)} key{summary.returnedKeys === 1 ? "" : "s"} recorded in this window.
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th scope="col" className="pb-2 font-medium">Key</th>
                  <th scope="col" className="pb-2 font-medium">Class</th>
                  <th scope="col" className="pb-2 font-medium">Requests</th>
                  <th scope="col" className="pb-2 font-medium">Keyed Share</th>
                  <th scope="col" className="pb-2 font-medium">Public API Share</th>
                  <th scope="col" className="pb-2 font-medium">Rate Limit</th>
                  <th scope="col" className="pb-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {apiKeys.map((row) => {
                  const status = getApiKeyStatus(row, nowSeconds);
                  return (
                    <tr key={row.apiKeyId} className="border-b last:border-0">
                      <td className="py-2 align-top">
                        <div className="font-medium text-foreground">{row.name}</div>
                        <div className="mt-1 font-mono text-xs text-muted-foreground">{row.maskedToken}</div>
                      </td>
                      <td className="py-2 align-top">
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${trafficClassBadgeClassName(row.trafficClass)}`}>
                          {row.trafficClass}
                        </span>
                      </td>
                      <td className="py-2 align-top font-mono text-foreground">{formatCompactCount(row.requestCount)}</td>
                      <td className="py-2 align-top font-mono text-foreground">{formatPercent(row.shareOfKeyedRequestsPct, 1)}</td>
                      <td className="py-2 align-top font-mono text-foreground">{formatPercent(row.shareOfTotalPublicApiRequestsPct, 1)}</td>
                      <td className="py-2 align-top font-mono text-muted-foreground">{formatCompactCount(row.rateLimitPerMinute)}/min</td>
                      <td className="py-2 align-top">
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${apiKeyStatusBadgeClassName(status)}`}>
                          {status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </article>
  );
}
