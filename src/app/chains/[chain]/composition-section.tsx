"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { formatCompactUsd } from "@shared/lib/format";
import type { ChainDetailCoin } from "@shared/types/chains";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { logosById } from "@/lib/logos";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { cn } from "@/lib/utils";
import type { ChainRouteViewModel } from "./view-model";

function CompositionBlock({
  coin,
  percentage,
  shouldSpan,
}: {
  coin: ChainDetailCoin;
  percentage: number;
  shouldSpan: boolean;
}) {
  const logoSize = shouldSpan ? 44 : percentage > 0.15 ? 32 : 24;

  return (
    <Link
      href={buildStablecoinUrl(coin.id)}
      className={cn(
        "pharos-focus-ring group relative flex flex-col items-center justify-center rounded-xl border p-3 text-center transition-all duration-200",
        "bg-muted/30 hover:bg-muted/50",
        "hover:border-primary/40",
        "hover:-translate-y-0.5",
        shouldSpan && "min-h-[100px]",
      )}
      style={{
        gridColumn: shouldSpan ? "span 2" : undefined,
      }}
      title={`${coin.name} (${coin.symbol}) - ${(percentage * 100).toFixed(1)}% - Click to view details`}
    >
      <StablecoinLogo src={logosById[coin.id]} name={coin.name} size={logoSize} />
      <span className={cn("mt-1.5 font-semibold", shouldSpan ? "text-base" : "text-sm")}>{coin.symbol}</span>
      <span className={cn("text-muted-foreground", shouldSpan && "text-sm")}>
        {(percentage * 100).toFixed(1)}%
      </span>
      <span className="font-mono text-xs opacity-70 transition-opacity group-hover:opacity-100">
        {formatCompactUsd(coin.supplyUsd)}
      </span>
      <div className="absolute right-2 top-2 flex items-center gap-1 -translate-x-1 opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100">
        <span className="text-xs font-medium text-primary/70">View</span>
        <ChevronRight className={cn("text-primary/60", shouldSpan ? "h-5 w-5" : "h-4 w-4")} />
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
  coins: ChainDetailCoin[];
}) {
  const [showTooltip, setShowTooltip] = useState(false);
  const percentage = totalUsd > 0 ? (total / totalUsd) * 100 : 0;
  const previewCoins = coins.slice(0, 5);
  const remainingCount = Math.max(0, coins.length - 5);
  const tooltipId = "others-tooltip";

  return (
    <div
      className={cn(
        "pharos-focus-ring group relative flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 bg-muted/20 p-3 text-center transition-all duration-200",
        "hover:bg-muted/30 hover:border-border/80 focus-within:bg-muted/30 focus-within:border-border/80",
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
      <span className="font-mono text-xs opacity-70 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        {formatCompactUsd(total)}
      </span>

      {showTooltip && (
        <div id={tooltipId} role="tooltip" className="absolute bottom-full left-1/2 z-50 mb-2 w-48 -translate-x-1/2 rounded-lg border border-border/60 bg-popover p-3 shadow-lg">
          <p className="mb-2 text-xs font-medium text-foreground">Other stablecoins</p>
          <div className="space-y-1">
            {previewCoins.map((coin) => (
              <div key={coin.id} className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5">
                  <StablecoinLogo src={logosById[coin.id]} name={coin.name} size={14} />
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

export function CompositionSection({ model }: { model: ChainRouteViewModel }) {
  const { totalUsd, compositionLayout } = model;
  const { displayCoins, rest, restTotal, cols, rows } = compositionLayout;
  const showOthers = rest.length > 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="pharos-kicker">Stablecoin Composition</CardTitle>
      </CardHeader>
      <CardContent>
        <div
          className={cn(
            "grid gap-2",
            cols === 2 && "grid-cols-2",
            cols === 3 && "grid-cols-3",
            cols === 4 && "grid-cols-2 sm:grid-cols-4",
          )}
          style={{
            gridAutoRows: "minmax(100px, 1fr)",
            minHeight: rows === 1 ? "120px" : rows === 2 ? "220px" : "320px",
          }}
        >
          {displayCoins.map((coin) => {
            const shouldSpan = coin.chainShare > 0.35 && cols >= 3;
            return (
              <CompositionBlock
                key={coin.id}
                coin={coin}
                percentage={coin.chainShare}
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

        {displayCoins.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 border-t border-border/40 pt-3">
            {displayCoins.slice(0, 5).map((coin) => (
              <Link
                key={coin.id}
                href={buildStablecoinUrl(coin.id)}
                className="pharos-focus-ring inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                <StablecoinLogo src={logosById[coin.id]} name={coin.name} size={16} />
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
