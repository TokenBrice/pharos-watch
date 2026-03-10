"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@shared/lib/format";
import type { MintBurnReconciliationSummary } from "@shared/types";
import { cn } from "@/lib/utils";

function statusTone(status: "ok" | "warn" | "critical" | "insufficient-source"): string {
  switch (status) {
    case "critical":
      return "text-red-700 dark:text-red-300";
    case "warn":
      return "text-amber-700 dark:text-amber-300";
    case "ok":
      return "text-emerald-700 dark:text-emerald-300";
    default:
      return "text-muted-foreground";
  }
}

export function MintBurnReconciliationCard({
  summary,
}: {
  summary: MintBurnReconciliationSummary | null;
}) {
  if (!summary) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Mint/Burn Reconciliation</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No reconciliation signal available yet.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Mint/Burn Reconciliation</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-4">
          <div className="rounded-lg border border-border/50 p-3">
            <div className="text-xs text-muted-foreground">Compared</div>
            <div className="font-mono text-xl font-semibold">{summary.comparedCoins}</div>
          </div>
          <div className="rounded-lg border border-red-500/20 p-3">
            <div className="text-xs text-muted-foreground">Critical</div>
            <div className="font-mono text-xl font-semibold text-red-700 dark:text-red-300">{summary.criticalCount}</div>
          </div>
          <div className="rounded-lg border border-amber-500/20 p-3">
            <div className="text-xs text-muted-foreground">Warn</div>
            <div className="font-mono text-xl font-semibold text-amber-700 dark:text-amber-300">{summary.warnCount}</div>
          </div>
          <div className="rounded-lg border border-border/50 p-3">
            <div className="text-xs text-muted-foreground">Insufficient source</div>
            <div className="font-mono text-xl font-semibold text-muted-foreground">{summary.insufficientCount}</div>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          Compares 24h Ethereum mint/burn net flow against the stablecoins cache&apos;s Ethereum chain-supply delta.
          Large gaps point to coverage or upstream chain-distribution mismatches.
        </p>

        <div className="space-y-2">
          {summary.rows.map((row) => (
            <div key={row.stablecoinId} className="rounded-lg border border-border/50 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{row.symbol}</span>
                  <span className={cn("text-xs font-medium uppercase", statusTone(row.status))}>
                    {row.status.replace("-", " ")}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    coverage: {row.coverageStatus}
                  </span>
                </div>
                <div className={cn("font-mono text-sm", statusTone(row.status))}>
                  {row.absoluteDiffUsd == null ? "No chain delta" : formatCurrency(row.absoluteDiffUsd)}
                </div>
              </div>
              <div className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                <div>Flow net 24h: <span className="font-mono">{formatCurrency(row.flowNet24hUsd)}</span></div>
                <div>
                  Chain delta 24h:{" "}
                  <span className="font-mono">
                    {row.chainSupplyDelta24hUsd == null ? "—" : formatCurrency(row.chainSupplyDelta24hUsd)}
                  </span>
                </div>
                <div>
                  Diff ratio:{" "}
                  <span className="font-mono">
                    {row.diffRatio == null ? "—" : `${(row.diffRatio * 100).toFixed(1)}%`}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
