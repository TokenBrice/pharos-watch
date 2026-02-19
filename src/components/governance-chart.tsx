"use client";

import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/format";
import { getCirculatingRaw } from "@/lib/supply";
import { TRACKED_STABLECOINS } from "@/lib/stablecoins";
import type { StablecoinData } from "@/lib/types";
import { GOVERNANCE_TIER_COLORS } from "@/lib/classification";

interface GovernanceDominanceProps {
  data: StablecoinData[] | undefined;
}

export function GovernanceChart({ data }: GovernanceDominanceProps) {
  const stats = useMemo(() => {
    if (!data) return null;

    const metaById = new Map(TRACKED_STABLECOINS.map((s) => [s.id, s]));

    let centralized = 0;
    let dependent = 0;
    let decentralized = 0;

    for (const coin of data) {
      const meta = metaById.get(coin.id);
      if (!meta) continue;
      const mcap = getCirculatingRaw(coin);
      if (meta.flags.governance === "centralized") centralized += mcap;
      else if (meta.flags.governance === "centralized-dependent") dependent += mcap;
      else decentralized += mcap;
    }

    const total = centralized + dependent + decentralized;
    const cefiPct = total > 0 ? (centralized / total) * 100 : 0;
    const depPct = total > 0 ? (dependent / total) * 100 : 0;
    const defiPct = total > 0 ? (decentralized / total) * 100 : 0;

    return { centralized, dependent, decentralized, total, cefiPct, depPct, defiPct };
  }, [data]);

  if (!stats || stats.total === 0) return null;

  const tiers = [
    { label: "Centralized", pct: stats.cefiPct, mcap: stats.centralized, ...GOVERNANCE_TIER_COLORS.centralized },
    { label: "CeFi-Dependent", pct: stats.depPct, mcap: stats.dependent, ...GOVERNANCE_TIER_COLORS["centralized-dependent"] },
    { label: "Decentralized", pct: stats.defiPct, mcap: stats.decentralized, ...GOVERNANCE_TIER_COLORS.decentralized },
  ];

  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle as="h2">Stablecoin by Type</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="h-3 w-full rounded-full bg-muted overflow-hidden flex">
          <div className="h-full bg-yellow-500" style={{ width: `${stats.cefiPct}%` }} />
          <div className="h-full bg-orange-500" style={{ width: `${stats.depPct}%` }} />
          <div className="h-full bg-green-500" style={{ width: `${stats.defiPct}%` }} />
        </div>

        <div className="space-y-2 pt-1">
          {tiers.map((t) => (
            <div key={t.label} className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2">
                <div className={`h-2.5 w-2.5 rounded-full ${t.bg}`} />
                <span className={`font-medium ${t.text}`}>{t.label}</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="font-bold font-mono">{t.pct.toFixed(1)}%</span>
                <span className="text-muted-foreground text-xs font-mono">{formatCurrency(t.mcap)}</span>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
