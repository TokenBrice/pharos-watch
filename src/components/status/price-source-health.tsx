"use client";

import { STATUS_PRICE_CONFIDENCE_BANDS } from "@shared/lib/status-thresholds";
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
    green: "text-green-600 dark:text-green-400",
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

function confidenceSeverity(label: string, value: number, total: number): string {
  if (label === "High") {
    const pct = total > 0 ? (value / total) * 100 : 0;
    return pct > STATUS_PRICE_CONFIDENCE_BANDS.highPctGreen ? "green" : pct > STATUS_PRICE_CONFIDENCE_BANDS.highPctAmber ? "amber" : "red";
  }
  if (label === "Missing") return value === 0 ? "green" : value <= STATUS_PRICE_CONFIDENCE_BANDS.missingCountAmber ? "amber" : "red";
  if (label === "Low") return value <= STATUS_PRICE_CONFIDENCE_BANDS.lowCountAmber ? "neutral" : value <= STATUS_PRICE_CONFIDENCE_BANDS.lowCountRed ? "amber" : "red";
  return "neutral";
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

  const { confidenceDistribution: cd, sourceDistribution: sd, totalAssets } = health;
  const pct = (n: number) => totalAssets > 0 ? `${((n / totalAssets) * 100).toFixed(1)}%` : "—";
  const lastSyncAgeSeconds = Math.max(0, nowSeconds - health.lastSync);

  const metrics: { label: string; key: keyof typeof cd }[] = [
    { label: "High", key: "high" },
    { label: "Single", key: "single-source" },
    { label: "Low", key: "low" },
    { label: "Fallback", key: "fallback" },
  ];

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle as="h3" className="text-base">Price Source Health</CardTitle>
          <span className="text-xs text-muted-foreground">
            {totalAssets} assets · synced {formatElapsedSeconds(lastSyncAgeSeconds)} ago
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
              pct={pct(cd[m.key])}
              severity={confidenceSeverity(m.label, cd[m.key], totalAssets)}
            />
          ))}
          <MetricCard
            label="Missing"
            value={sd.missing}
            pct={pct(sd.missing)}
            severity={confidenceSeverity("Missing", sd.missing, totalAssets)}
          />
        </div>

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
