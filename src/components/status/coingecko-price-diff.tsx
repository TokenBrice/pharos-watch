"use client";

import { formatElapsedSeconds } from "@shared/lib/format";
import type { CoinGeckoPriceDiff, StatusSectionError } from "@shared/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusCardEmptyState } from "@/components/status/page-primitives";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";

function formatUsdPrice(value: number): string {
  if (value >= 1000) {
    return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  }
  if (value >= 1) {
    return `$${value.toFixed(4)}`;
  }
  if (value >= 0.01) {
    return `$${value.toFixed(6)}`;
  }
  return `$${value.toExponential(2)}`;
}

function formatConfidenceLabel(value: string | null): string {
  if (!value) return "No confidence tag";
  if (value === "single-source") return "Single source";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function getDiffBadgeClass(diffPct: number): string {
  if (diffPct >= 20) {
    return SEVERITY_TONE_CLASS.alert.pill;
  }
  if (diffPct >= 10) {
    return SEVERITY_TONE_CLASS.watch.pill;
  }
  return "border-orange-500/40 bg-orange-500/10 text-orange-700 dark:text-orange-400";
}

export function CoinGeckoPriceDiffCard({
  summary,
  error,
  nowSeconds,
}: {
  summary: CoinGeckoPriceDiff | null;
  error?: StatusSectionError;
  nowSeconds: number;
}) {
  if (!summary) {
    return (
      <StatusCardEmptyState title="CoinGecko Price Drift">
        {error ? `CoinGecko comparison loader failed: ${error.message}` : "CoinGecko comparison is not available yet."}
      </StatusCardEmptyState>
    );
  }

  const comparisonAgeSeconds = Math.max(0, nowSeconds - summary.checkedAt);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <CardTitle as="h3" className="text-base">CoinGecko Price Drift</CardTitle>
            <p className="text-xs text-muted-foreground">
              Tracked coins with a live CoinGecko price more than {summary.thresholdPct}% away from the Pharos reported price.
            </p>
          </div>
          <span className="text-xs text-muted-foreground">
            {summary.mismatchedCount} flagged · {summary.comparedCoins}/{summary.trackedWithGeckoId} comparable · checked{" "}
            {formatElapsedSeconds(comparisonAgeSeconds)} ago
          </span>
        </div>
      </CardHeader>
      <CardContent>
        {summary.rows.length > 0 ? (
          <div className="space-y-2">
            {summary.rows.map((row) => (
              <div
                key={row.stablecoinId}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 p-3"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono tabular-nums text-sm font-medium text-foreground">{row.symbol}</span>
                    <span className="truncate text-sm text-muted-foreground">{row.name}</span>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>Pharos {formatUsdPrice(row.ourPrice)}</span>
                    <span>CoinGecko {formatUsdPrice(row.coinGeckoPrice)}</span>
                    <span>Source {row.priceSource}</span>
                    <span>{formatConfidenceLabel(row.priceConfidence)}</span>
                  </div>
                </div>
                <span
                  className={`rounded-full border px-2.5 py-1 pharos-numeric text-[11px] font-medium ${getDiffBadgeClass(row.diffPct)}`}
                >
                  {row.diffPct.toFixed(2)}%
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-border/60 p-3 text-sm text-muted-foreground">
            No tracked CoinGecko-covered tokens are beyond {summary.thresholdPct}% right now.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
