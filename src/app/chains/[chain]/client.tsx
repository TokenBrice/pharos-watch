"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useChains, useChainStablecoins, type ChainStablecoin } from "@/hooks/use-chains";
import { CHAIN_META } from "@shared/lib/chains";
import { BACKING_LABELS_SHORT } from "@shared/lib/classification";
import {
  QUALITY_WEIGHT,
  CHAIN_ENVIRONMENT_WEIGHT,
  CONCENTRATION_WEIGHT,
  PEG_STABILITY_WEIGHT,
  BACKING_DIVERSITY_WEIGHT,
} from "@shared/lib/chain-health";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatChainUsd, formatRatioPct, HEALTH_BADGE_CLASSES, HEALTH_TEXT_CLASSES, trendColor } from "@/lib/chain-ui";
import { ChainTypeBadge } from "@/components/chain-type-badge";
import { buildStablecoinUrl } from "@/lib/urls";
import { MethodologyLabel, MethodologyHint, MethodologyCardActions } from "@/components/methodology-hint";
import type { ChainSummary } from "@shared/types/chains";
import { TrendingUp, TrendingDown, Minus, ChevronRight, Info, CheckCircle2, AlertCircle, AlertTriangle, XCircle } from "lucide-react";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import logos from "../../../../data/logos.json";

const BACKING_BAR_COLORS: Record<string, string> = {
  "rwa-backed": "bg-sky-500",
  "crypto-backed": "bg-violet-500",
  algorithmic: "bg-amber-500",
  other: "bg-zinc-400",
};

const BACKING_FILTER_COLORS: Record<string, string> = {
  "rwa-backed": "bg-sky-500/15 text-sky-700 dark:text-sky-400 border-sky-500/30 hover:bg-sky-500/20",
  "crypto-backed": "bg-violet-500/15 text-violet-700 dark:text-violet-400 border-violet-500/30 hover:bg-violet-500/20",
  algorithmic: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30 hover:bg-amber-500/20",
  other: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-400 border-zinc-500/30 hover:bg-zinc-500/20",
};


function getScoreColorClass(score: number): string {
  if (score >= 80) return "bg-emerald-500";
  if (score >= 60) return "bg-amber-500";
  if (score >= 40) return "bg-orange-500";
  return "bg-red-500";
}

function getScoreTextClass(score: number): string {
  if (score >= 80) return "text-emerald-600 dark:text-emerald-400";
  if (score >= 60) return "text-amber-600 dark:text-amber-400";
  if (score >= 40) return "text-orange-600 dark:text-orange-400";
  return "text-red-600 dark:text-red-400";
}

function ScoreIcon({ score }: { score: number }) {
  if (score >= 80) return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />;
  if (score >= 60) return <AlertCircle className="h-3.5 w-3.5 text-amber-500" aria-hidden="true" />;
  if (score >= 40) return <AlertTriangle className="h-3.5 w-3.5 text-orange-500" aria-hidden="true" />;
  return <XCircle className="h-3.5 w-3.5 text-red-500" aria-hidden="true" />;
}

function FactorGauge({
  label,
  score,
  methodologyKey,
}: {
  label: string;
  score: number | null;
  methodologyKey?: "chainHealthQuality" | "chainHealthEnvironment" | "chainHealthConcentration" | "chainHealthPegStability" | "chainHealthBackingDiversity";
}) {
  const hasScore = score != null;
  const colorClass = hasScore ? getScoreColorClass(score) : "bg-muted-foreground/30";
  const textClass = hasScore ? getScoreTextClass(score) : "text-muted-foreground";
  
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-1.5">
          {hasScore && <ScoreIcon score={score} />}
          {methodologyKey ? (
            <MethodologyLabel topic={methodologyKey} className="text-xs">
              <span className="pharos-kicker cursor-help">{label}</span>
            </MethodologyLabel>
          ) : (
            <span className="pharos-kicker">{label}</span>
          )}
        </div>
        <span className={cn("font-mono font-medium", textClass)}>{hasScore ? score : "--"}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        {hasScore && (
          <div 
            className={cn("h-full rounded-full transition-all duration-500", colorClass)} 
            style={{ width: `${score}%` }} 
          />
        )}
      </div>
    </div>
  );
}

function HeroCard({ chain, chainId }: { chain: ChainSummary; chainId: string }) {
  const meta = CHAIN_META[chainId];
  const hasHealthScore = chain.healthScore != null && chain.healthBand;

  return (
    <Card 
      className="relative overflow-hidden"
      style={{
        background: "linear-gradient(135deg, var(--card) 0%, var(--muted) 100%)",
      }}
    >
      {/* Subtle gradient overlay for featured feel */}
      <div 
        className="pointer-events-none absolute inset-0 opacity-30"
        style={{
          background: hasHealthScore 
            ? `radial-gradient(circle at 90% 10%, ${chain.healthBand === 'robust' ? 'oklch(0.7 0.2 145 / 0.15)' : chain.healthBand === 'healthy' ? 'oklch(0.7 0.15 220 / 0.15)' : chain.healthBand === 'mixed' ? 'oklch(0.75 0.15 85 / 0.15)' : chain.healthBand === 'fragile' ? 'oklch(0.7 0.18 55 / 0.15)' : 'oklch(0.65 0.2 25 / 0.15)'} 0%, transparent 50%)`
            : 'radial-gradient(circle at 90% 10%, oklch(0.7 0.1 220 / 0.1) 0%, transparent 50%)'
        }}
      />
      <CardContent className="relative px-5 py-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          {/* Chain Identity - Enhanced */}
          <div className="flex items-center gap-5">
            {meta && (
              <div className="relative shrink-0">
                <div 
                  className="rounded-2xl border border-border/60 bg-background/90 p-3 shadow-md"
                  style={{
                    background: "linear-gradient(145deg, var(--background) 0%, var(--muted) 100%)",
                  }}
                >
                  <Image
                    src={meta.logoPath}
                    alt=""
                    width={64}
                    height={64}
                    className={`rounded-full${meta.darkInvert ? " dark:invert" : ""}`}
                  />
                </div>
              </div>
            )}
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-3xl font-extrabold tracking-tight">{chain.name}</h2>
                <ChainTypeBadge type={chain.type} />
              </div>
              {hasHealthScore ? (
                <div className="mt-2 flex items-center gap-3">
                  <div 
                    className={cn(
                      "flex h-10 w-10 items-center justify-center rounded-xl text-sm font-bold shadow-sm",
                      HEALTH_BADGE_CLASSES[chain.healthBand!]
                    )}
                    title={`Health Score: ${chain.healthScore}`}
                  >
                    {chain.healthScore}
                  </div>
                  <div className="flex flex-col">
                    <span className={cn("text-sm font-semibold capitalize leading-tight", HEALTH_TEXT_CLASSES[chain.healthBand!])}>
                      {chain.healthBand}
                    </span>
                    <span className="text-xs text-muted-foreground">ecosystem health</span>
                  </div>
                </div>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">Health score unavailable</p>
              )}
            </div>
          </div>

          {/* Metrics Grid - Subordinated with separator */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t pt-4 text-sm sm:grid-cols-3 lg:grid-cols-5 lg:border-t-0 lg:border-l lg:pl-6 lg:pt-0">
            <div>
              <p className="pharos-kicker">Total Supply</p>
              <p className="text-lg font-bold tracking-tight">{formatChainUsd(chain.totalUsd)}</p>
            </div>
            <div>
              <p className="pharos-kicker">Global Share</p>
              <p className="text-lg font-bold tracking-tight">{(chain.dominanceShare * 100).toFixed(1)}%</p>
            </div>
            <TrendMetric label="24h" value={chain.change24hPct} />
            <TrendMetric label="7d" value={chain.change7dPct} />
            <TrendMetric label="30d" value={chain.change30dPct} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function TrendMetric({ label, value }: { label: string; value: number }) {
  const Icon = value > 0.001 ? TrendingUp : value < -0.001 ? TrendingDown : Minus;
  return (
    <div>
      <p className="pharos-kicker">{label}</p>
      <div className="flex items-center gap-1">
        <Icon className={cn("h-3.5 w-3.5", trendColor(value))} aria-hidden="true" />
        <p className={cn("font-mono font-medium", trendColor(value))}>{formatRatioPct(value)}</p>
      </div>
    </div>
  );
}

function HealthBreakdownCard({ chain }: { chain: ChainSummary }) {
  const { healthFactors, healthScore, healthBand } = chain;
  const hasScore = healthScore != null && healthBand;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="pharos-kicker">Chain Health Score</CardTitle>
          <MethodologyHint topic="chainHealth" />
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {hasScore ? (
          <div className="flex items-center gap-4">
            <div
              className={cn(
                "flex h-20 w-20 items-center justify-center rounded-2xl text-3xl font-bold shadow-sm",
                HEALTH_BADGE_CLASSES[healthBand]
              )}
            >
              {healthScore}
            </div>
            <div className="space-y-1">
              <p className={cn("text-lg font-semibold capitalize", HEALTH_TEXT_CLASSES[healthBand])}>{healthBand}</p>
              <p className="max-w-[280px] text-sm text-muted-foreground">
                Composite health across quality, environment, concentration, peg stability, and backing diversity.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-3 rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className="text-sm text-amber-800 dark:text-amber-200">
              Insufficient safety score coverage for a composite health score. Sub-factors are shown below.
            </p>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <FactorGauge
            label={`Quality (${Math.round(QUALITY_WEIGHT * 100)}%)`}
            score={healthFactors.quality}
            methodologyKey="chainHealthQuality"
          />
          <FactorGauge
            label={`Environment (${Math.round(CHAIN_ENVIRONMENT_WEIGHT * 100)}%)`}
            score={healthFactors.chainEnvironment}
            methodologyKey="chainHealthEnvironment"
          />
          <FactorGauge
            label={`Concentration (${Math.round(CONCENTRATION_WEIGHT * 100)}%)`}
            score={healthFactors.concentration}
            methodologyKey="chainHealthConcentration"
          />
          <FactorGauge
            label={`Peg Stability (${Math.round(PEG_STABILITY_WEIGHT * 100)}%)`}
            score={healthFactors.pegStability}
            methodologyKey="chainHealthPegStability"
          />
          <FactorGauge
            label={`Backing Diversity (${Math.round(BACKING_DIVERSITY_WEIGHT * 100)}%)`}
            score={healthFactors.backingDiversity}
            methodologyKey="chainHealthBackingDiversity"
          />
        </div>

        <MethodologyCardActions topic="chainHealth" />
      </CardContent>
    </Card>
  );
}

function CompositionSection({ chainId }: { chainId: string }) {
  const { coins, totalUsd } = useChainStablecoins(chainId);

  // Dynamic layout calculation to fill grid completely with no dead zones
  const layout = useMemo(() => {
    const totalCoins = coins.length;
    if (totalCoins === 0) return { displayCoins: [], rest: [], restTotal: 0, cols: 2, rows: 1 };

    // Determine grid dimensions based on total available coins
    // Goal: fill the grid completely with display coins + optional Others block
    let cols: number;
    let rows: number;
    let maxDisplay: number;

    if (totalCoins <= 3) {
      // Small chains: 2 columns, 1-2 rows
      cols = 2;
      rows = totalCoins <= 2 ? 1 : 2;
      maxDisplay = totalCoins; // Show all, no Others needed
    } else if (totalCoins <= 6) {
      // Medium chains: 3 columns, 2 rows = 6 cells
      cols = 3;
      rows = 2;
      // Reserve 1 cell for Others if we have more than 5 coins
      maxDisplay = totalCoins > 6 ? 5 : totalCoins;
    } else if (totalCoins <= 8) {
      // Larger medium: 4 columns, 2 rows = 8 cells
      cols = 4;
      rows = 2;
      maxDisplay = totalCoins > 8 ? 7 : totalCoins;
    } else if (totalCoins <= 11) {
      // Large chains: 4 columns, 3 rows = 12 cells, but cap at 11 coins + Others
      cols = 4;
      rows = 3;
      maxDisplay = totalCoins > 11 ? 10 : totalCoins;
    } else {
      // Very large chains: 4 columns, 3 rows, show top 11 + Others
      cols = 4;
      rows = 3;
      maxDisplay = 11;
    }

    const needsOthers = totalCoins > maxDisplay;
    // If we need Others, reduce display count by 1 to make room
    const finalDisplayCount = needsOthers ? Math.min(maxDisplay - 1, totalCoins) : totalCoins;
    const actualDisplayCount = Math.min(finalDisplayCount, totalCoins);

    const displayCoins = coins.slice(0, actualDisplayCount);
    const rest = coins.slice(actualDisplayCount);
    const restTotal = rest.reduce((s, c) => s + c.supplyOnChain, 0);

    return { displayCoins, rest, restTotal, cols, rows };
  }, [coins]);

  const { displayCoins, rest, restTotal, cols, rows } = layout;
  const showOthers = rest.length > 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="pharos-kicker">Stablecoin Composition</CardTitle>
      </CardHeader>
      <CardContent>
        {/* Unified Treemap - Full Width, Dynamic Grid */}
        <div
          className={cn(
            "grid gap-2",
            cols === 2 && "grid-cols-2",
            cols === 3 && "grid-cols-3",
            cols === 4 && "grid-cols-2 sm:grid-cols-4"
          )}
          style={{
            gridAutoRows: "minmax(100px, 1fr)",
            minHeight: rows === 1 ? "120px" : rows === 2 ? "220px" : "320px",
          }}
        >
          {displayCoins.map((coin) => {
            const pct = totalUsd > 0 ? coin.supplyOnChain / totalUsd : 0;
            // Only large dominant coins (>35%) span 2 columns in 3+ col layouts
            const shouldSpan = pct > 0.35 && cols >= 3;
            return (
              <CompositionBlock
                key={coin.id}
                coin={coin}
                percentage={pct}
                shouldSpan={shouldSpan}
              />
            );
          })}
          {showOthers && (
            <CompositionOthersBlock
              count={rest.length}
              total={restTotal}
              totalUsd={totalUsd}
              coins={rest}
            />
          )}
        </div>

        {/* Legend - Compact summary of top coins for quick scanning */}
        {displayCoins.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 border-t border-border/40 pt-3">
            {displayCoins.slice(0, 5).map((coin) => (
              <Link
                key={coin.id}
                href={buildStablecoinUrl(coin.id)}
                className="pharos-focus-ring inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                <StablecoinLogo src={(logos as Record<string, string>)[coin.id]} name={coin.name} size={16} />
                <span className="font-medium">{coin.symbol}</span>
                <span className="tabular-nums">{(coin.chainShare * 100).toFixed(1)}%</span>
              </Link>
            ))}
            {rest.length > 0 && (
              <span className="text-xs text-muted-foreground">
                +{rest.length} more
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CompositionBlock({
  coin,
  percentage,
  shouldSpan,
}: {
  coin: ChainStablecoin;
  percentage: number;
  shouldSpan: boolean;
}) {
  const logoSize = shouldSpan ? 44 : percentage > 0.15 ? 32 : 24;

  return (
    <Link
      href={buildStablecoinUrl(coin.id)}
      className={cn(
        "pharos-focus-ring group relative flex flex-col items-center justify-center rounded-xl border p-3 text-center transition-all duration-200",
        "bg-gradient-to-b from-muted/40 to-muted/20 hover:from-muted/60 hover:to-muted/40",
        "hover:border-primary/40 hover:shadow-md hover:shadow-primary/5",
        "hover:-translate-y-0.5",
        shouldSpan && "min-h-[100px]"
      )}
      style={{
        gridColumn: shouldSpan ? "span 2" : undefined,
      }}
      title={`${coin.name} (${coin.symbol}) - ${(percentage * 100).toFixed(1)}% - Click to view details`}
    >
      <StablecoinLogo src={(logos as Record<string, string>)[coin.id]} name={coin.name} size={logoSize} />
      <span className={cn("mt-1.5 font-semibold", shouldSpan ? "text-base" : "text-sm")}>{coin.symbol}</span>
      <span className={cn("text-muted-foreground", shouldSpan && "text-sm")}>
        {(percentage * 100).toFixed(1)}%
      </span>
      <span className="font-mono text-xs transition-opacity opacity-70 group-hover:opacity-100">
        {formatChainUsd(coin.supplyOnChain)}
      </span>
      {/* Enhanced click affordance */}
      <div className="absolute right-2 top-2 flex items-center gap-1 transition-all duration-200 -translate-x-1 opacity-0 group-hover:translate-x-0 group-hover:opacity-100">
        <span className="text-xs font-medium text-primary/70">View</span>
        <ChevronRight
          className={cn(
            "text-primary/60",
            shouldSpan ? "h-5 w-5" : "h-4 w-4"
          )}
        />
      </div>
    </Link>
  );
}

function CompositionOthersBlock({
  count,
  total,
  totalUsd,
  coins,
}: {
  count: number;
  total: number;
  totalUsd: number;
  coins: ChainStablecoin[];
}) {
  const [showTooltip, setShowTooltip] = useState(false);
  const percentage = totalUsd > 0 ? (total / totalUsd) * 100 : 0;

  // Get top 5 coins for the preview
  const previewCoins = coins.slice(0, 5);
  const remainingCount = Math.max(0, coins.length - 5);
  const tooltipId = "others-tooltip";

  return (
    <div
      className={cn(
        "pharos-focus-ring group relative flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 bg-muted/20 p-3 text-center transition-all duration-200",
        "hover:bg-muted/30 hover:border-border/80 focus-within:bg-muted/30 focus-within:border-border/80"
      )}
      tabIndex={0}
      aria-describedby={tooltipId}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
      onFocus={() => setShowTooltip(true)}
      onBlur={() => setShowTooltip(false)}
    >
      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted/60">
        <span className="text-xs font-semibold text-muted-foreground">+{count}</span>
      </div>
      <span className="mt-1 text-sm font-medium text-muted-foreground">Others</span>
      <span className="text-xs text-muted-foreground">{percentage.toFixed(1)}%</span>
      <span className="font-mono text-xs transition-opacity opacity-70 group-hover:opacity-100 group-focus-within:opacity-100">
        {formatChainUsd(total)}
      </span>

      {/* Tooltip with coin preview */}
      {showTooltip && (
        <div id={tooltipId} role="tooltip" className="absolute bottom-full left-1/2 z-50 mb-2 w-48 -translate-x-1/2 rounded-lg border border-border/60 bg-popover p-3 shadow-lg">
          <p className="mb-2 text-xs font-medium text-foreground">Other stablecoins</p>
          <div className="space-y-1">
            {previewCoins.map((coin) => (
              <div key={coin.id} className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5">
                  <StablecoinLogo src={(logos as Record<string, string>)[coin.id]} name={coin.name} size={14} />
                  <span className="text-muted-foreground">{coin.symbol}</span>
                </span>
                <span className="font-mono text-muted-foreground">{(coin.chainShare * 100).toFixed(1)}%</span>
              </div>
            ))}
          </div>
          {remainingCount > 0 && (
            <p className="mt-2 border-t border-border/40 pt-1 text-xs text-muted-foreground">
              +{remainingCount} more coins
            </p>
          )}
          <div className="absolute bottom-0 left-1/2 h-2 w-2 -translate-x-1/2 translate-y-1/2 rotate-45 border-b border-r border-border/60 bg-popover" />
        </div>
      )}
    </div>
  );
}

function BackingBreakdown({
  chainId,
  onFilterChange,
  activeFilter,
}: {
  chainId: string;
  onFilterChange: (filter: string | null) => void;
  activeFilter: string | null;
}) {
  const { coins, totalUsd } = useChainStablecoins(chainId);

  const backingTotals = useMemo(() => {
    const totals: Record<string, number> = { "rwa-backed": 0, "crypto-backed": 0, algorithmic: 0, other: 0 };
    for (const coin of coins) {
      const key = coin.backing && coin.backing in totals ? coin.backing : "other";
      totals[key] += coin.supplyOnChain;
    }
    return totals;
  }, [coins]);

  const hasData = Object.values(backingTotals).some((v) => v > 0);
  if (!hasData) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="pharos-kicker">Supply by Backing Type</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div
          className="flex h-4 w-full overflow-hidden rounded-full"
          role="img"
          aria-label={`Backing breakdown: ${Object.entries(backingTotals).filter(([, a]) => a > 0).map(([type, amount]) => `${BACKING_LABELS_SHORT[type as keyof typeof BACKING_LABELS_SHORT] ?? type} ${(totalUsd > 0 ? (amount / totalUsd) * 100 : 0).toFixed(1)}%`).join(", ")}`}
        >
          {Object.entries(backingTotals).map(([type, amount]) => {
            const pct = totalUsd > 0 ? (amount / totalUsd) * 100 : 0;
            if (pct <= 0) return null;
            return <div key={type} className={cn("h-full", BACKING_BAR_COLORS[type])} style={{ width: `${pct}%` }} />;
          })}
        </div>
        <div className="flex flex-wrap gap-2">
          {/* "All" filter pill */}
          <button
            onClick={() => onFilterChange(null)}
            className={cn(
              "pharos-focus-ring inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
              activeFilter === null 
                ? "border-primary/50 bg-primary/10 text-primary hover:bg-primary/15" 
                : "border-border/60 bg-background hover:bg-muted/50"
            )}
            title={activeFilter === null ? "Showing all stablecoins" : "Click to show all stablecoins"}
          >
            <div className="h-2.5 w-2.5 rounded-full bg-gradient-to-br from-sky-500 via-violet-500 to-amber-500" />
            <span>All</span>
            <span className="font-mono text-muted-foreground">{coins.length}</span>
            {activeFilter === null && <span className="ml-1 text-xs">●</span>}
          </button>
          {Object.entries(backingTotals).map(([type, amount]) => {
            const pct = totalUsd > 0 ? (amount / totalUsd) * 100 : 0;
            if (pct <= 0) return null;
            const isActive = activeFilter === type;
            return (
              <button
                key={type}
                onClick={() => onFilterChange(isActive ? null : type)}
                className={cn(
                  "pharos-focus-ring inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                  isActive ? BACKING_FILTER_COLORS[type] : "border-border/60 bg-background hover:bg-muted/50"
                )}
                title={isActive ? "Click to clear filter" : `Click to filter by ${BACKING_LABELS_SHORT[type as keyof typeof BACKING_LABELS_SHORT] ?? type}`}
              >
                <div className={cn("h-2.5 w-2.5 rounded-full", BACKING_BAR_COLORS[type])} />
                <span>{BACKING_LABELS_SHORT[type as keyof typeof BACKING_LABELS_SHORT] ?? (type === "other" ? "Other" : type)}</span>
                <span className="font-mono text-muted-foreground">{pct.toFixed(1)}%</span>
                {isActive && <span className="ml-1 text-xs">✕</span>}
              </button>
            );
          })}
        </div>
        {activeFilter && (
          <p className="text-xs text-muted-foreground">
            Showing only {BACKING_LABELS_SHORT[activeFilter as keyof typeof BACKING_LABELS_SHORT] ?? activeFilter} stablecoins.{" "}
            <button onClick={() => onFilterChange(null)} className="pharos-focus-ring underline hover:text-foreground">
              Clear filter
            </button>
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function StablecoinTable({
  chainId,
  backingFilter,
}: {
  chainId: string;
  backingFilter: string | null;
}) {
  const router = useRouter();
  const { coins: allCoins } = useChainStablecoins(chainId);

  const coins = useMemo(() => {
    if (!backingFilter) return allCoins;
    return allCoins.filter((c) => (c.backing ?? "other") === backingFilter);
  }, [allCoins, backingFilter]);

  if (coins.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="pharos-kicker">All Stablecoins</CardTitle>
        </CardHeader>
        <CardContent className="py-8">
          <div className="flex flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm text-muted-foreground">No stablecoins match the current filter.</p>
            {backingFilter && (
              <p className="text-xs text-muted-foreground">Try clearing the filter to see all stablecoins.</p>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="pharos-kicker">
          All Stablecoins
          {backingFilter && (
            <span className="ml-2 text-xs font-normal normal-case text-muted-foreground">
              ({BACKING_LABELS_SHORT[backingFilter as keyof typeof BACKING_LABELS_SHORT] ?? backingFilter})
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <TableCaption className="sr-only">Stablecoins deployed on this chain</TableCaption>
            <TableHeader>
              <TableRow className="bg-muted/40">
                <TableHead className="w-10">#</TableHead>
                <TableHead>Stablecoin</TableHead>
                <TableHead className="text-right">Supply on Chain</TableHead>
                <TableHead className="text-right">Chain Share</TableHead>
                <TableHead className="text-right">7d</TableHead>
                <TableHead className="text-right">30d</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {coins.map((coin, i) => (
                <TableRow
                  key={coin.id}
                  role="link"
                  aria-label={`${coin.name} (${coin.symbol}) — ${formatChainUsd(coin.supplyOnChain)} on chain`}
                  className="group cursor-pointer transition-colors hover:bg-muted/40"
                  onClick={() => router.push(buildStablecoinUrl(coin.id))}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      router.push(buildStablecoinUrl(coin.id));
                    }
                  }}
                >
                  <TableCell className="tabular-nums text-muted-foreground">{i + 1}</TableCell>
                  <TableCell>
                    <span className="flex items-center gap-2 font-medium group-hover:text-primary">
                      <StablecoinLogo src={(logos as Record<string, string>)[coin.id]} name={coin.name} size={24} />
                      <span className="hidden sm:inline">{coin.name}</span>
                      <span className="text-muted-foreground">({coin.symbol})</span>
                      <ChevronRight className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-50" />
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{formatChainUsd(coin.supplyOnChain)}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="h-1.5 w-12 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary/60"
                          style={{ width: `${Math.min(100, coin.chainShare * 100)}%` }}
                        />
                      </div>
                      <span className="w-10 text-right font-mono text-xs tabular-nums text-muted-foreground">
                        {(coin.chainShare * 100).toFixed(1)}%
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className={cn("text-right font-mono tabular-nums", trendColor(coin.change7dPct))}>
                    {formatRatioPct(coin.change7dPct)}
                  </TableCell>
                  <TableCell className={cn("text-right font-mono tabular-nums", trendColor(coin.change30dPct))}>
                    {formatRatioPct(coin.change30dPct)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

export function ChainProfileClient({ chainId }: { chainId: string }) {
  const { data, isLoading, isError, error, refetch } = useChains();
  const [backingFilter, setBackingFilter] = useState<string | null>(null);

  const chain = useMemo(() => {
    if (!data?.chains) return null;
    return data.chains.find((c) => c.id === chainId) ?? null;
  }, [data, chainId]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-32 rounded-lg" />
        <Skeleton className="h-72 rounded-lg" />
        <Skeleton className="h-56 rounded-lg" />
      </div>
    );
  }
  if (isError && !data) {
    return <QueryErrorNotice error={error} onRetry={() => { void refetch(); }} />;
  }
  if (!chain) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-20">
        <div className="rounded-full bg-muted p-4">
          <Info className="h-8 w-8 text-muted-foreground" />
        </div>
        <div className="text-center">
          <p className="font-medium">No data available for this chain</p>
          <p className="mt-1 text-sm text-muted-foreground">
            This chain may not be tracked or may have been removed.
          </p>
        </div>
        <Link href="/chains/" className="pharos-focus-ring text-sm text-primary hover:underline">
          View all chains
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <QueryErrorNotice error={error} hasData={!!data?.chains?.length} onRetry={() => { void refetch(); }} />
      <HeroCard chain={chain} chainId={chainId} />
      <HealthBreakdownCard chain={chain} />
      <CompositionSection chainId={chainId} />
      <BackingBreakdown
        chainId={chainId}
        onFilterChange={setBackingFilter}
        activeFilter={backingFilter}
      />
      <StablecoinTable chainId={chainId} backingFilter={backingFilter} />
    </div>
  );
}
