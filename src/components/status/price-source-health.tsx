"use client";

import {
  getHighConfidenceTileSeverity,
  getLowConfidenceTileSeverity,
  getMissingPriceTileSeverity,
} from "@shared/lib/status-thresholds";
import {
  PRICE_SOURCE_HEALTH_BUCKET_KEYS,
  getPriceSourceHealthBucketShortLabel,
} from "@shared/lib/pricing-sources";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { PriceSourceHealth, StatusSectionError } from "@shared/types";
import { formatElapsedSeconds } from "@shared/lib/format";
import { StatusCardEmptyState } from "@/components/status/page-primitives";

function MetricCard({ label, value, pct, severity }: { label: string; value: number; pct: string; severity: string }) {
  const colors: Record<string, string> = {
    green: "text-emerald-600 dark:text-emerald-400",
    amber: "text-amber-600 dark:text-amber-400",
    red: "text-red-600 dark:text-red-400",
    neutral: "text-muted-foreground",
  };
  return (
    <div className="rounded-lg border border-border/50 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`pharos-numeric text-2xl font-bold ${colors[severity] ?? ""}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{pct}</div>
    </div>
  );
}

export function PriceSourceHealthCard({
  health,
  error,
  nowSeconds,
}: {
  health: PriceSourceHealth | null;
  error?: StatusSectionError;
  nowSeconds: number;
}) {
  if (!health) {
    return (
      <StatusCardEmptyState title="Price Source Health">
        {error ? `Price source health loader failed: ${error.message}` : "No price source data available yet."}
      </StatusCardEmptyState>
    );
  }

  const {
    confidenceDistribution: cd,
    sourceDistribution: sd,
    totalAssets,
    confidenceMarketCapUsd: cdValue,
    pricedMarketCapUsd: pricedValue,
    acknowledgedMissingCount,
  } = health.active ?? health;
  const pct = (n: number) => totalAssets > 0 ? `${((n / totalAssets) * 100).toFixed(1)}%` : "—";
  // Accepted single-source prices are not failed consensus. Confidence colors
  // measure priced-value exposure; legacy snapshots remain explicitly neutral.
  const valueShare = (n: number | undefined) =>
    typeof n === "number" && typeof pricedValue === "number" && pricedValue > 0 ? (n / pricedValue) * 100 : null;
  const valuePct = (n: number | undefined) => {
    const share = valueShare(n);
    return share == null ? null : `${share.toFixed(1)}% of value`;
  };
  const lastSyncAgeSeconds = Math.max(0, nowSeconds - health.lastSync);

  const metrics: { label: string; key: keyof typeof cd; severity: string; pctText: string }[] = [
    {
      label: "High",
      key: "high",
      severity: getHighConfidenceTileSeverity(valueShare(cdValue?.high)),
      pctText: valuePct(cdValue?.high) ?? pct(cd.high),
    },
    {
      label: "Single",
      key: "single-source",
      severity: "neutral",
      pctText: valuePct(cdValue?.["single-source"]) ?? pct(cd["single-source"]),
    },
    {
      label: "Low",
      key: "low",
      severity: getLowConfidenceTileSeverity(valueShare(cdValue?.low)),
      pctText: valuePct(cdValue?.low) ?? pct(cd.low),
    },
    {
      label: "Fallback",
      key: "fallback",
      severity: "neutral",
      pctText: valuePct(cdValue?.fallback) ?? pct(cd.fallback),
    },
  ];

  // Acknowledged price-gap reviews stay visible as raw missing rows but do not
  // drive the Missing tile; an expired review counts again on the next sync.
  const acknowledged = typeof acknowledgedMissingCount === "number"
    ? Math.max(0, Math.min(acknowledgedMissingCount, sd.missing))
    : 0;
  const unacknowledgedMissing = sd.missing - acknowledged;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle as="h3" className="text-base">Price Source Health</CardTitle>
          <span className="text-xs text-muted-foreground">
            {totalAssets} {health.active ? "active assets" : "cached assets"} · synced {formatElapsedSeconds(lastSyncAgeSeconds)} ago
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {metrics.map((m) => (
            <MetricCard
              key={m.key}
              label={m.label}
              value={cd[m.key]}
              pct={m.pctText}
              severity={m.severity}
            />
          ))}
          <MetricCard
            label="Missing"
            value={unacknowledgedMissing}
            pct={acknowledged > 0
              ? `${pct(unacknowledgedMissing)} · ${acknowledged} acknowledged`
              : pct(unacknowledgedMissing)}
            severity={getMissingPriceTileSeverity(unacknowledgedMissing)}
          />
        </div>

        {health.active && (
          <p className="text-xs text-muted-foreground">
            Full cache: {health.totalAssets} rows · {health.sourceDistribution.missing} missing · {health.confidenceDistribution.high} high · {health.confidenceDistribution["single-source"]} single · {health.confidenceDistribution.low} low · {health.confidenceDistribution.fallback} fallback. Includes upstream assets outside the active catalog.
          </p>
        )}

        <div className="text-xs text-muted-foreground">
          <span className="font-medium">Sources:</span>{" "}
          {PRICE_SOURCE_HEALTH_BUCKET_KEYS
            .filter((key) => key !== "missing")
            .map((key) => `${getPriceSourceHealthBucketShortLabel(key)} ${sd[key] ?? 0}`)
            .join(" · ")}
        </div>
      </CardContent>
    </Card>
  );
}
