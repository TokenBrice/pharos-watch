"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { PriceSourceHealth, ShadowComparisonResult } from "@shared/types";
import { useState } from "react";

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
    return pct > 85 ? "green" : pct > 70 ? "amber" : "red";
  }
  if (label === "Missing") return value === 0 ? "green" : value <= 3 ? "amber" : "red";
  if (label === "Low") return value <= 5 ? "neutral" : value <= 10 ? "amber" : "red";
  return "neutral";
}

export function PriceSourceHealthCard({
  health,
  shadowComparison,
}: {
  health: PriceSourceHealth | null;
  shadowComparison?: ShadowComparisonResult | null;
}) {
  const [showDivergences, setShowDivergences] = useState(false);
  const [showShadow, setShowShadow] = useState(false);

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

  const { confidenceDistribution: cd, sourceDistribution: sd, divergences, totalAssets } = health;
  const pct = (n: number) => totalAssets > 0 ? `${((n / totalAssets) * 100).toFixed(1)}%` : "—";

  const metrics: { label: string; key: keyof typeof cd }[] = [
    { label: "High", key: "high" },
    { label: "Single", key: "single-source" },
    { label: "Low", key: "low" },
  ];

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Price Source Health</CardTitle>
          <span className="text-xs text-muted-foreground">{totalAssets} assets</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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
          CG+DL {sd["defillama+coingecko"]} · CG-only {sd.coingecko} · DL {sd.defillama} · Contract {sd["defillama-contract"]} · CMC {sd.coinmarketcap} · DexScreener {sd.dexscreener} · Cached {sd.cached}
        </div>

        {divergences.length > 0 && (
          <div>
            <button
              onClick={() => setShowDivergences(!showDivergences)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              {showDivergences ? "▾" : "▸"} {divergences.length} divergence{divergences.length !== 1 ? "s" : ""}
            </button>
            {showDivergences && (
              <div className="mt-1 space-y-1">
                {divergences.map((d) => (
                  <div key={d.id} className="font-mono text-xs text-muted-foreground">
                    {d.symbol}: CG ${d.cgPrice.toFixed(4)} vs DL ${d.dlPrice.toFixed(4)} ({d.bps} bps)
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {shadowComparison && (
          <div>
            <button
              onClick={() => setShowShadow(!showShadow)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              {showShadow ? "▾" : "▸"} Shadow Pipeline {shadowComparison.cgAvailable ? "" : "(CG unavailable)"}
            </button>
            {showShadow && (
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div className="rounded-md border border-border/50 p-2">
                  <div className="text-[10px] text-muted-foreground">Mean</div>
                  <div className="font-mono text-sm">{shadowComparison.meanDivergenceBps} bps</div>
                </div>
                <div className="rounded-md border border-border/50 p-2">
                  <div className="text-[10px] text-muted-foreground">P95</div>
                  <div className="font-mono text-sm">{shadowComparison.p95DivergenceBps} bps</div>
                </div>
                <div className="rounded-md border border-border/50 p-2">
                  <div className="text-[10px] text-muted-foreground">Max</div>
                  <div className="font-mono text-sm">{shadowComparison.maxDivergenceBps} bps</div>
                </div>
                <div className="rounded-md border border-border/50 p-2">
                  <div className="text-[10px] text-muted-foreground">Coverage</div>
                  <div className="font-mono text-sm">+{shadowComparison.coverageGained} / -{shadowComparison.coverageLost}</div>
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
