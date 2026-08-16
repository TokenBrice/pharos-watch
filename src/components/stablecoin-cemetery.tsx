"use client";

import { memo } from "react";
import Image from "next/image";
import Link from "next/link";
import { ExternalLink, ChevronRight } from "lucide-react";
import { CAUSE_META } from "@shared/lib/dead-stablecoins";
import { CASE_STUDY_CLIENT_BY_CEMETERY_ID } from "@/lib/case-study-client-index";
import type { CemeteryEntry } from "@shared/lib/cemetery-merged";
import { CHAIN_META } from "@shared/lib/chains";
import { buildExplorerUrl } from "@shared/lib/explorer";
import { formatAddress, formatCurrency, formatDeathDate } from "@shared/lib/format";

interface StablecoinCemeteryProps {
  coins: CemeteryEntry[];
  expanded: Set<string>;
  onToggle: (coinId: string) => void;
  highlightedId?: string | null;
}

interface CemeteryObituaryRowProps {
  coin: CemeteryEntry;
  isExpanded: boolean;
  isHighlighted: boolean;
  onToggle: (coinId: string) => void;
}

const CemeteryObituaryRow = memo(function CemeteryObituaryRow({
  coin,
  isExpanded,
  isHighlighted,
  onToggle,
}: CemeteryObituaryRowProps) {
  const cause = CAUSE_META[coin.causeOfDeath];
  const logoUrl = coin.logo
    ? coin.logo.startsWith("/")
      ? coin.logo
      : `/logos/cemetery/${coin.logo}`
    : undefined;

  return (
    <div id={`obituary-${coin.id}`} className={isHighlighted ? "ring-2 ring-primary/50" : undefined}>
      {/* Collapsed row — always visible */}
      <button
        type="button"
        className="pharos-focus-ring w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-muted/30 transition-colors cursor-pointer"
        onClick={() => onToggle(coin.id)}
        aria-expanded={isExpanded}
        aria-controls={`autopsy-${coin.id}`}
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
          <span className="hidden md:inline text-xs pharos-numeric text-muted-foreground/70 shrink-0">
            {formatCurrency(coin.peakMcap, 1)}
          </span>
        )}

        {/* Death date */}
        <span className="text-xs pharos-numeric text-muted-foreground shrink-0">
          {formatDeathDate(coin.deathDate)}
        </span>

        {/* Chevron */}
        <span className="text-muted-foreground shrink-0 transition-transform duration-[220ms] ease-[var(--motion-ease-standard)]" style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}>
          <ChevronRight className="h-4 w-4" />
        </span>
      </button>

      {/* Expanded autopsy content — grid-rows animation */}
      <div
        id={`autopsy-${coin.id}`}
        className="grid transition-[grid-template-rows] duration-[220ms] ease-[var(--motion-ease-standard)]"
        style={{ gridTemplateRows: isExpanded ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <div className="px-4 pb-4 pt-1 space-y-3 border-t border-border/50">
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
                  <span className="pharos-numeric">{formatCurrency(coin.peakMcap, 1)}</span>
                </div>
              )}
              <div>
                <span className="text-muted-foreground">Peg: </span>
                <span className="font-mono">{coin.pegCurrency}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Death: </span>
                <span className="pharos-numeric">{formatDeathDate(coin.deathDate)}</span>
              </div>
            </div>

            {/* Contract addresses */}
            {coin.contracts && coin.contracts.length > 0 && (
              <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
                {coin.contracts.map((c) => {
                  const chain = CHAIN_META[c.chain];
                  const url = buildExplorerUrl({
                    chainKey: c.chain,
                    entityType: "contract",
                    value: c.address,
                  });
                  return (
                    <div key={`${c.chain}-${c.address}`} className="flex items-center gap-1.5">
                      {chain?.logoPath && (
                        <Image
                          src={chain.logoPath}
                          alt={chain?.name ?? c.chain}
                          width={14}
                          height={14}
                          className="rounded-full"
                          unoptimized
                        />
                      )}
                      {url ? (
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="pharos-focus-ring font-mono text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {formatAddress(c.address)}
                        </a>
                      ) : (
                        <span className="font-mono text-muted-foreground">{formatAddress(c.address)}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Obituary */}
            <p className="text-sm text-muted-foreground leading-relaxed">
              {coin.obituary}
            </p>

            {/* Source link + optional archive link */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <a
                href={coin.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="pharos-focus-ring inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {coin.sourceLabel}
                <ExternalLink className="h-3 w-3" />
              </a>
              {coin.archivedDataAvailable ? (
                <Link
                  href={`/stablecoin/${coin.id}/`}
                  className="pharos-focus-ring text-xs text-muted-foreground underline-offset-2 hover:underline hover:text-foreground transition-colors"
                >
                  View archived data →
                </Link>
              ) : null}
              {CASE_STUDY_CLIENT_BY_CEMETERY_ID[coin.id] ? (
                <Link
                  href={`/learn/case-studies/${CASE_STUDY_CLIENT_BY_CEMETERY_ID[coin.id].slug}/`}
                  className="pharos-focus-ring text-xs font-medium text-frost-blue underline-offset-2 hover:underline transition-colors"
                >
                  Read the case study →
                </Link>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

export function StablecoinCemetery({ coins, expanded, onToggle, highlightedId }: StablecoinCemeteryProps) {
  return (
    <div className="rounded-xl border divide-y divide-border">
      {coins.map((coin) => (
        <CemeteryObituaryRow
          key={coin.id}
          coin={coin}
          isExpanded={expanded.has(coin.id)}
          isHighlighted={highlightedId === coin.id}
          onToggle={onToggle}
        />
      ))}

      {coins.length === 0 && (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
          No stablecoins match this filter.
        </div>
      )}
    </div>
  );
}
