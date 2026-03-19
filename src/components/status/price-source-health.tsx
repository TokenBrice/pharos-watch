"use client";

import { STATUS_PRICE_CONFIDENCE_BANDS } from "@shared/lib/status-thresholds";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { PriceSourceHealth } from "@shared/types";
import { formatElapsedSeconds } from "@shared/lib/format";

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
      <div className={`font-mono text-2xl font-bold ${colors[severity] ?? ""}`}>{value}</div>
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
  nowSeconds,
}: {
  health: PriceSourceHealth | null;
  nowSeconds: number;
}) {
  if (!health) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Price Source Health</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No price source data available yet.</p>
        </CardContent>
      </Card>
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
          <CardTitle className="text-base">Price Source Health</CardTitle>
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
          CG+DL-list {sd["coingecko+defillama-list"]} · CG {sd.coingecko} · DL {sd.defillama} · DL-list {sd["defillama-list"]} · Protocol {sd["protocol-redeem"]} · Contract {sd["defillama-contract"]} · CMC {sd.coinmarketcap} · Jupiter {sd.jupiter} · DexScreener {sd.dexscreener} · Pyth {sd.pyth} · Binance {sd.binance} · Kraken {sd.kraken} · Bitstamp {sd.bitstamp} · Coinbase {sd.coinbase} · RedStone {sd.redstone} · Curve {sd["curve-onchain"]} · DEX {sd["dex-promoted"]} · GT {sd.geckoterminal} · Pool {sd["pool-tvl-weighted"]} · Cached {sd.cached}
        </div>
      </CardContent>
    </Card>
  );
}
