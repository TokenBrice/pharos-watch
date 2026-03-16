"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useChains } from "@/hooks/use-chains";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { HealthBand } from "@shared/types/chains";

type SortKey = "totalUsd" | "healthScore" | "change24hPct" | "change7dPct" | "change30dPct" | "stablecoinCount" | "dominanceShare";
type SortDir = "asc" | "desc";

type ColumnId = "health" | "supply" | "change24hPct" | "change7dPct" | "change30dPct" | "dominanceShare" | "stablecoinCount" | "dominantStablecoin";

const DEFAULT_COLUMNS: ColumnId[] = ["health", "supply", "change7dPct", "dominanceShare"];
const ALL_COLUMNS: { id: ColumnId; label: string }[] = [
  { id: "health", label: "Health" },
  { id: "supply", label: "Supply" },
  { id: "change24hPct", label: "24h %" },
  { id: "change7dPct", label: "7d %" },
  { id: "change30dPct", label: "30d %" },
  { id: "dominanceShare", label: "Global Share" },
  { id: "stablecoinCount", label: "Stablecoins" },
  { id: "dominantStablecoin", label: "Dominant" },
];

const HEALTH_BAND_COLORS: Record<HealthBand, string> = {
  robust: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  healthy: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  mixed: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  fragile: "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  concentrated: "bg-red-500/15 text-red-700 dark:text-red-400",
};

function formatUsd(value: number): string {
  if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

function formatPct(value: number): string {
  const pct = value * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="px-4 py-3">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-lg font-bold tracking-tight">{value}</p>
      </CardContent>
    </Card>
  );
}

function HealthBadge({ score, band }: { score: number | null; band: HealthBand | null }) {
  if (score == null || band == null) {
    return <span className="text-xs text-muted-foreground">--</span>;
  }
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", HEALTH_BAND_COLORS[band])}>
      {score}
      <span className="hidden sm:inline capitalize">{band}</span>
    </span>
  );
}

export function ChainsLeaderboardClient() {
  const { data, isLoading, isError } = useChains();
  const [sortKey, setSortKey] = useState<SortKey>("totalUsd");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [visibleColumns, setVisibleColumns] = useState<Set<ColumnId>>(new Set(DEFAULT_COLUMNS));

  function toggleColumn(col: ColumnId) {
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col);
      else next.add(col);
      return next;
    });
  }

  const isVisible = (col: ColumnId) => visibleColumns.has(col);

  const sorted = useMemo(() => {
    if (!data?.chains) return [];
    return [...data.chains].sort((a, b) => {
      const av = a[sortKey] ?? -Infinity;
      const bv = b[sortKey] ?? -Infinity;
      return sortDir === "desc" ? (bv as number) - (av as number) : (av as number) - (bv as number);
    });
  }, [data, sortKey, sortDir]);

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  if (isLoading) {
    return <div className="flex items-center justify-center py-20 text-muted-foreground">Loading chain data...</div>;
  }
  if (isError || !data) {
    return <div className="flex items-center justify-center py-20 text-destructive">Failed to load chain data.</div>;
  }

  const topHealthChain = [...data.chains].sort((a, b) => (b.healthScore ?? -1) - (a.healthScore ?? -1))[0];

  return (
    <div className="space-y-6">
      {/* KPI Strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label="Total Stablecoin Supply" value={formatUsd(data.globalTotalUsd)} />
        <KpiCard label="Active Chains" value={String(data.chains.length)} />
        <KpiCard label="Top Chain Dominance" value={data.chains[0] ? `${data.chains[0].name} ${(data.chains[0].dominanceShare * 100).toFixed(1)}%` : "--"} />
        <KpiCard label="Healthiest Chain" value={topHealthChain?.healthScore != null ? `${topHealthChain.name} (${topHealthChain.healthScore})` : "--"} />
      </div>

      {/* Column toggle */}
      <div className="flex justify-end">
        <div className="flex flex-wrap gap-1.5">
          {ALL_COLUMNS.map((col) => (
            <button
              key={col.id}
              onClick={() => toggleColumn(col.id)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                isVisible(col.id)
                  ? "border-primary/30 bg-primary/10 text-foreground"
                  : "border-border/60 bg-background text-muted-foreground hover:bg-muted/40",
              )}
            >
              {col.label}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-left text-xs font-medium text-muted-foreground">
              <th className="px-3 py-2 w-10">#</th>
              <th className="px-3 py-2">Chain</th>
              {isVisible("health") && <th className="px-3 py-2 cursor-pointer select-none" onClick={() => handleSort("healthScore")}>Health</th>}
              {isVisible("supply") && <th className="px-3 py-2 text-right cursor-pointer select-none" onClick={() => handleSort("totalUsd")}>Supply</th>}
              {isVisible("change24hPct") && <th className="px-3 py-2 text-right cursor-pointer select-none" onClick={() => handleSort("change24hPct")}>24h</th>}
              {isVisible("change7dPct") && <th className="px-3 py-2 text-right cursor-pointer select-none" onClick={() => handleSort("change7dPct")}>7d</th>}
              {isVisible("change30dPct") && <th className="px-3 py-2 text-right cursor-pointer select-none" onClick={() => handleSort("change30dPct")}>30d</th>}
              {isVisible("dominanceShare") && <th className="px-3 py-2 text-right cursor-pointer select-none" onClick={() => handleSort("dominanceShare")}>Global Share</th>}
              {isVisible("stablecoinCount") && <th className="px-3 py-2 text-right cursor-pointer select-none" onClick={() => handleSort("stablecoinCount")}>Stablecoins</th>}
              {isVisible("dominantStablecoin") && <th className="px-3 py-2">Dominant</th>}
            </tr>
          </thead>
          <tbody>
            {sorted.map((chain, i) => (
              <tr key={chain.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                <td className="px-3 py-2.5 text-muted-foreground">{i + 1}</td>
                <td className="px-3 py-2.5">
                  <Link href={`/chains/${chain.id}/`} className="flex items-center gap-2 hover:underline">
                    <Image src={chain.logoPath} alt="" width={20} height={20} className="rounded-full" />
                    <span className="font-medium">{chain.name}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">{chain.type}</span>
                  </Link>
                </td>
                {isVisible("health") && (
                  <td className="px-3 py-2.5"><HealthBadge score={chain.healthScore} band={chain.healthBand} /></td>
                )}
                {isVisible("supply") && (
                  <td className="px-3 py-2.5 text-right font-mono">{formatUsd(chain.totalUsd)}</td>
                )}
                {isVisible("change24hPct") && (
                  <td className={cn("px-3 py-2.5 text-right font-mono", chain.change24hPct >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>
                    {formatPct(chain.change24hPct)}
                  </td>
                )}
                {isVisible("change7dPct") && (
                  <td className={cn("px-3 py-2.5 text-right font-mono", chain.change7dPct >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>
                    {formatPct(chain.change7dPct)}
                  </td>
                )}
                {isVisible("change30dPct") && (
                  <td className={cn("px-3 py-2.5 text-right font-mono", chain.change30dPct >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>
                    {formatPct(chain.change30dPct)}
                  </td>
                )}
                {isVisible("dominanceShare") && (
                  <td className="px-3 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-primary/60" style={{ width: `${Math.min(100, chain.dominanceShare * 100)}%` }} />
                      </div>
                      <span className="text-xs font-mono text-muted-foreground w-10 text-right">{(chain.dominanceShare * 100).toFixed(1)}%</span>
                    </div>
                  </td>
                )}
                {isVisible("stablecoinCount") && (
                  <td className="px-3 py-2.5 text-right font-mono">{chain.stablecoinCount}</td>
                )}
                {isVisible("dominantStablecoin") && (
                  <td className="px-3 py-2.5 text-sm">
                    {chain.dominantStablecoin.symbol} ({(chain.dominantStablecoin.share * 100).toFixed(0)}%)
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
