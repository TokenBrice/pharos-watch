"use client";

import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { formatCurrency } from "@/lib/format";
import { computeGovernanceBreakdown } from "@/lib/supply";
import type { StablecoinData } from "@/lib/types";
import { GOVERNANCE_TIER_COLORS } from "@/lib/classification";

interface GovernanceDominanceProps {
  data: StablecoinData[] | undefined;
  isLoading?: boolean;
}

export function GovernanceChart({ data, isLoading }: GovernanceDominanceProps) {
  const stats = useMemo(() => {
    if (!data) return null;
    const gov = computeGovernanceBreakdown(data);
    if (gov.total === 0) return null;
    return {
      centralized: gov.centralizedMcap,
      dependent: gov.dependentMcap,
      decentralized: gov.decentralizedMcap,
      total: gov.total,
      cefiPct: gov.cefiPct,
      depPct: gov.depPct,
      defiPct: gov.defiPct,
    };
  }, [data]);

  if (!stats) {
    if (isLoading) {
      return (
        <Card className="rounded-xl">
          <CardHeader>
            <CardTitle as="h2">Stablecoin by Type</CardTitle>
          </CardHeader>
          <CardContent>
            <ChartSkeleton className="h-[140px]" variant="bars" />
          </CardContent>
        </Card>
      );
    }
    return null;
  }

  const tiers = [
    { label: "Centralized", pct: stats.cefiPct, mcap: stats.centralized, ...GOVERNANCE_TIER_COLORS.centralized },
    { label: "CeFi-Dependent", pct: stats.depPct, mcap: stats.dependent, ...GOVERNANCE_TIER_COLORS["centralized-dependent"] },
    { label: "Decentralized", pct: stats.defiPct, mcap: stats.decentralized, ...GOVERNANCE_TIER_COLORS.decentralized },
  ];

  return (
    <Card className="rounded-xl">
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
