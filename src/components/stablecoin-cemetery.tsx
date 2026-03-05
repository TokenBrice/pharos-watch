"use client";

import Image from "next/image";
import { ExternalLink, ChevronDown, ChevronRight } from "lucide-react";
import { CAUSE_META } from "@shared/lib/dead-stablecoins";
import { formatCurrency, formatDeathDate } from "@shared/lib/format";
import type { DeadStablecoin } from "@shared/types";

interface StablecoinCemeteryProps {
  coins: DeadStablecoin[];
  expanded: Set<string>;
  onToggle: (symbol: string) => void;
}

export function StablecoinCemetery({ coins, expanded, onToggle }: StablecoinCemeteryProps) {
  return (
    <div className="rounded-xl border divide-y divide-border">
      {coins.map((coin) => {
        const cause = CAUSE_META[coin.causeOfDeath];
        const isExpanded = expanded.has(coin.symbol);
        const logoUrl = coin.logo ? `/logos/cemetery/${coin.logo}` : undefined;

        return (
          <div key={coin.symbol} id={`obituary-${coin.symbol}`} className="transition-all duration-300">
            {/* Collapsed row — always visible */}
            <button
              type="button"
              className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-muted/30 transition-colors cursor-pointer"
              onClick={() => onToggle(coin.symbol)}
              aria-expanded={isExpanded}
              aria-controls={`autopsy-${coin.symbol}`}
            >
              {/* Logo */}
              <div
                className="rounded-full overflow-hidden bg-muted flex items-center justify-center shrink-0"
                style={{ width: 28, height: 28 }}
              >
                {logoUrl ? (
                  <Image
                    src={logoUrl}
                    alt={coin.symbol}
                    width={28}
                    height={28}
                    className="rounded-full grayscale"
                    unoptimized
                  />
                ) : (
                  <span className="text-xs font-bold text-muted-foreground">
                    {coin.symbol.charAt(0)}
                  </span>
                )}
              </div>

              {/* Name + symbol */}
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <span className="text-sm text-muted-foreground truncate">
                  {coin.name}
                </span>
                <span className="font-semibold line-through decoration-zinc-500 shrink-0">
                  {coin.symbol}
                </span>
              </div>

              {/* Cause badge */}
              <span
                className={`hidden sm:inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium shrink-0 ${cause.textColor} ${cause.borderColor}`}
              >
                {cause.label}
              </span>

              {/* Peak mcap */}
              {coin.peakMcap && (
                <span className="hidden md:inline text-xs font-mono tabular-nums text-muted-foreground/60 shrink-0">
                  {formatCurrency(coin.peakMcap, 1)}
                </span>
              )}

              {/* Death date */}
              <span className="text-xs font-mono tabular-nums text-muted-foreground shrink-0">
                {formatDeathDate(coin.deathDate)}
              </span>

              {/* Chevron */}
              <span className="text-muted-foreground shrink-0">
                {isExpanded
                  ? <ChevronDown className="h-4 w-4" />
                  : <ChevronRight className="h-4 w-4" />
                }
              </span>
            </button>

            {/* Expanded autopsy content */}
            {isExpanded && (
              <div
                id={`autopsy-${coin.symbol}`}
                className="px-4 pb-4 pt-1 space-y-3 border-t border-border/50"
              >
                {/* Cause badge on mobile (hidden on sm+) */}
                <span
                  className={`sm:hidden inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${cause.textColor} ${cause.borderColor}`}
                >
                  {cause.label}
                </span>

                {/* Key facts grid */}
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
                  {coin.peakMcap && (
                    <div>
                      <span className="text-muted-foreground">Peak Mcap: </span>
                      <span className="font-mono tabular-nums">{formatCurrency(coin.peakMcap, 1)}</span>
                    </div>
                  )}
                  <div>
                    <span className="text-muted-foreground">Peg: </span>
                    <span className="font-mono">{coin.pegCurrency}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Death: </span>
                    <span className="font-mono tabular-nums">{formatDeathDate(coin.deathDate)}</span>
                  </div>
                </div>

                {/* Obituary */}
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {coin.obituary}
                </p>

                {/* Source link */}
                <a
                  href={coin.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {coin.sourceLabel}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            )}
          </div>
        );
      })}

      {coins.length === 0 && (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
          No stablecoins match this filter.
        </div>
      )}
    </div>
  );
}
