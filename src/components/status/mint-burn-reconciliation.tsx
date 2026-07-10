"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@shared/lib/format";
import { STATUS_RECONCILIATION_THRESHOLDS } from "@shared/lib/status-thresholds";
import type { MintBurnReconciliationSummary, StatusSectionError } from "@shared/types";
import { cn } from "@/lib/utils";
import { StatusCardEmptyState } from "@/components/status/page-primitives";

const COLLAPSED_ROW_COUNT = 6;

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

function statusTileTone(status: "ok" | "warn" | "critical" | "insufficient-source"): string {
  switch (status) {
    case "critical":
      return "border-red-500/25 bg-red-500/[0.045]";
    case "warn":
      return "border-amber-500/25 bg-amber-500/[0.045]";
    case "ok":
      return "border-emerald-500/20 bg-emerald-500/[0.04]";
    default:
      return "border-border/60 bg-background/35";
  }
}

function formatStatusLabel(status: "ok" | "warn" | "critical" | "insufficient-source"): string {
  if (status === "insufficient-source") return "Insufficient source";
  return status;
}

export function MintBurnReconciliationCard({
  summary,
  error,
}: {
  summary: MintBurnReconciliationSummary | null;
  error?: StatusSectionError;
}) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (!summary) {
    return (
      <StatusCardEmptyState title="Mint/Burn Reconciliation">
        {error ? `Mint/burn reconciliation loader failed: ${error.message}` : "No reconciliation signal available yet."}
      </StatusCardEmptyState>
    );
  }

  const canCollapse = summary.rows.length > COLLAPSED_ROW_COUNT;
  const visibleRows = canCollapse && !isExpanded ? summary.rows.slice(0, COLLAPSED_ROW_COUNT) : summary.rows;
  const hiddenCount = summary.rows.length - visibleRows.length;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle as="h3" className="text-base">Mint/Burn Reconciliation</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-lg border border-border/50 p-3">
            <div className="text-xs text-muted-foreground">Compared</div>
            <div className="pharos-numeric text-xl font-semibold">{summary.comparedCoins}</div>
          </div>
          <div className="rounded-lg border border-red-500/20 p-3">
            <div className="text-xs text-muted-foreground">Critical</div>
            <div className="pharos-numeric text-xl font-semibold text-red-700 dark:text-red-300">
              {summary.criticalCount}
            </div>
          </div>
          <div className="rounded-lg border border-amber-500/20 p-3">
            <div className="text-xs text-muted-foreground">Warn</div>
            <div className="pharos-numeric text-xl font-semibold text-amber-700 dark:text-amber-300">
              {summary.warnCount}
            </div>
          </div>
          <div className="rounded-lg border border-border/50 p-3">
            <div className="text-xs text-muted-foreground">Insufficient source</div>
            <div className="pharos-numeric text-xl font-semibold text-muted-foreground">
              {summary.insufficientCount}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-start justify-between gap-3 rounded-[1rem] border border-border/60 bg-background/35 px-4 py-3">
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              Compares 24h configured canonical issuance-chain mint/burn net flow against the stablecoins cache&apos;s
              matching chain-supply delta. Critical:{" "}
              {`>$${(STATUS_RECONCILIATION_THRESHOLDS.criticalAbsoluteUsd / 1e6).toFixed(0)}M or >${(STATUS_RECONCILIATION_THRESHOLDS.criticalRatio * 100).toFixed(0)}%`}
              . Warn:{" "}
              {`>$${(STATUS_RECONCILIATION_THRESHOLDS.warnAbsoluteUsd / 1e6).toFixed(0)}M or >${(STATUS_RECONCILIATION_THRESHOLDS.warnRatio * 100).toFixed(0)}%`}
              .
            </p>
            <div className="text-xs text-muted-foreground">
              Showing {visibleRows.length} of {summary.rows.length} rows, sorted by severity.
            </div>
          </div>
          {canCollapse ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 min-w-[9rem]"
              onClick={() => setIsExpanded((current) => !current)}
            >
              {isExpanded ? "Show fewer" : `See all ${summary.rows.length} assets`}
            </Button>
          ) : null}
        </div>

        <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {visibleRows.map((row) => (
            <div key={row.stablecoinId} className={cn("rounded-[1rem] border p-4", statusTileTone(row.status))}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">{row.symbol}</span>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em]",
                        statusTone(row.status),
                      )}
                    >
                      {formatStatusLabel(row.status)}
                    </span>
                  </div>
                  <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                    Coverage {row.coverageStatus}
                  </div>
                </div>
                <div className="min-w-0 text-right">
                  <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Gap</div>
                  <div className={cn("pharos-numeric text-sm font-semibold", statusTone(row.status))}>
                    {row.absoluteDiffUsd == null ? "—" : formatCurrency(row.absoluteDiffUsd)}
                  </div>
                </div>
              </div>

              <div className="mt-3 grid gap-3 border-t border-border/50 pt-3 text-xs text-muted-foreground sm:grid-cols-3">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.18em]">Flow net 24h</div>
                  <div className="mt-1 pharos-numeric text-foreground">{formatCurrency(row.flowNet24hUsd)}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-[0.18em]">Chain delta 24h</div>
                  <div className="mt-1 pharos-numeric text-foreground">
                    {row.chainSupplyDelta24hUsd == null ? "—" : formatCurrency(row.chainSupplyDelta24hUsd)}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-[0.18em]">Diff ratio</div>
                  <div className="mt-1 pharos-numeric text-foreground">
                    {row.diffRatio == null ? "—" : `${(row.diffRatio * 100).toFixed(1)}%`}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {!isExpanded && hiddenCount > 0 ? (
          <p className="text-xs text-muted-foreground">
            {hiddenCount} lower-priority rows are collapsed behind the disclosure button.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
