"use client";

import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { BACKING_LABELS_SHORT } from "@shared/lib/classification";
import { formatCompactUsdOrSubDollar, formatSignedPercent } from "@shared/lib/format";
import type { CoinState } from "@shared/lib/coin-state";
import { CoinStateChip } from "@/components/coin-state-chip";
import { ControlPillToggle } from "@/components/control-pill-toggle";
import { FilterSearchInput } from "@/components/filter-search-input";
import { InteractiveTableRow } from "@/components/interactive-table-row";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import {
  TableBody,
  TableCaption,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ChainDetailCoin } from "@shared/types/chains";
import { deltaColor, formatChainShare } from "@/lib/chain-ui";
import { getLogoSrc, logosById } from "@/lib/logos";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { cn } from "@/lib/utils";

type ChainCoinTriageFilter = "all" | "top-share" | "growing" | "shrinking";

const CHAIN_COIN_TRIAGE_OPTIONS: readonly { value: ChainCoinTriageFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "top-share", label: "Top share (5%+)" },
  { value: "growing", label: "Growing 7d" },
  { value: "shrinking", label: "Shrinking 7d" },
];

function matchesChainCoinTriage(coin: ChainDetailCoin, triage: ChainCoinTriageFilter): boolean {
  if (triage === "all") return true;
  if (triage === "top-share") return coin.chainShare >= 0.05;
  if (triage === "growing") return coin.change7dPct != null && coin.change7dPct > 0.005;
  return coin.change7dPct != null && coin.change7dPct < -0.005;
}

export function StablecoinTable({
  coins,
  backingFilter,
  coinStates,
}: {
  coins: ChainDetailCoin[];
  backingFilter: string | null;
  /** Each coin's exceptional states (`useCoinStates`); the row shows the highest one. */
  coinStates?: ReadonlyMap<string, readonly CoinState[]>;
}) {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");
  const [triageFilter, setTriageFilter] = useState<ChainCoinTriageFilter>("all");
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const hasLocalFilters = normalizedQuery.length > 0 || triageFilter !== "all";

  const visibleCoins = useMemo(
    () =>
      coins.filter((coin) => {
        if (!matchesChainCoinTriage(coin, triageFilter)) return false;
        if (!normalizedQuery) return true;
        return (
          coin.name.toLowerCase().includes(normalizedQuery) ||
          coin.symbol.toLowerCase().includes(normalizedQuery) ||
          coin.id.toLowerCase().includes(normalizedQuery)
        );
      }),
    [coins, normalizedQuery, triageFilter],
  );

  const clearLocalFilters = () => {
    setSearchQuery("");
    setTriageFilter("all");
  };

  if (coins.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="pharos-label">All stablecoins</CardTitle>
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
    <TableFrame
      tableId="chain-detail-stablecoins"
      testId="chain-detail-stablecoins-table"
      chrome="content"
      density="compact"
      stickyHeader
      stickyMode="page"
      className="text-card-foreground"
      topSlot={
        <div className="space-y-3 border-b border-border/50 px-4 py-3.5">
          <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="pharos-label">
              All Stablecoins
              {backingFilter && (
                <span className="ml-2 text-xs font-normal normal-case text-muted-foreground">
                  ({BACKING_LABELS_SHORT[backingFilter as keyof typeof BACKING_LABELS_SHORT] ?? backingFilter})
                </span>
              )}
            </CardTitle>
            <div className="flex items-center gap-2">
              <FilterSearchInput
                value={searchQuery}
                onValueChange={setSearchQuery}
                placeholder="Search stablecoins..."
                ariaLabel="Search stablecoins on this chain"
                className="relative w-full sm:w-48"
                inputClassName="h-11 pl-8 text-xs md:h-8"
              />
              {hasLocalFilters ? (
                <button
                  type="button"
                  onClick={clearLocalFilters}
                  className="pharos-focus-ring shrink-0 min-h-11 rounded-sm text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline md:min-h-8"
                >
                  Clear
                </button>
              ) : null}
            </div>
          </div>
          <ControlPillToggle
            ariaLabel="Filter chain stablecoins"
            options={CHAIN_COIN_TRIAGE_OPTIONS}
            value={triageFilter}
            onChange={setTriageFilter}
            className="flex flex-wrap gap-1.5"
            buttonClassName="min-h-11 md:min-h-8"
          />
        </div>
      }
      tableClassName="w-full text-sm"
      viewportProps={{
        mobileScrollHint: false,
        scrollShadow: false,
        compactBottomPadding: false,
      }}
    >
      <TableCaption className="sr-only">Stablecoins deployed on this chain</TableCaption>
      <TableHeader>
        <TableRow rowIntent="static" className="bg-card">
          <TableHead className="w-10">#</TableHead>
          <TableHead>Stablecoin</TableHead>
          <TableHead className="text-right">Supply on Chain</TableHead>
          <TableHead className="text-right">Chain share</TableHead>
          <TableHead className="text-right">7d</TableHead>
          <TableHead className="text-right">30d</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {visibleCoins.length === 0 ? (
          <TableRow rowIntent="static">
            <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
              <span className="flex flex-col items-center gap-3">
                <span>No stablecoins match the current filter.</span>
                <button
                  type="button"
                  onClick={clearLocalFilters}
                  className="pharos-focus-ring rounded-full border border-border/60 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                >
                  Clear filters
                </button>
              </span>
            </TableCell>
          </TableRow>
        ) : (
          visibleCoins.map((coin, index) => (
            <InteractiveTableRow
              key={coin.id}
              className="group transition-colors hover:bg-muted/40"
              onActivate={() => router.push(buildStablecoinUrl(coin.id))}
            >
              <TableCell className="tabular-nums text-muted-foreground">{index + 1}</TableCell>
              <TableCell>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Link
                    href={buildStablecoinUrl(coin.id)}
                    prefetch={false}
                    aria-label={`${coin.name} (${coin.symbol}) — ${formatCompactUsdOrSubDollar(coin.supplyUsd)} on chain`}
                    className="pharos-focus-ring flex items-center gap-2 rounded-md font-medium group-hover:text-primary"
                  >
                    <StablecoinLogo src={getLogoSrc(logosById, coin.id)} name={coin.name} size={24} />
                    <span className="hidden sm:inline">{coin.name}</span>
                    <span className="text-muted-foreground">({coin.symbol})</span>
                    <ChevronRight className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-50" />
                  </Link>
                  {coinStates?.get(coin.id)?.slice(0, 1).map((state) => <CoinStateChip key={state.kind} state={state} />)}
                </div>
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">{formatCompactUsdOrSubDollar(coin.supplyUsd)}</TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-2">
                  <div className="h-1.5 w-12 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary/60"
                      style={{ width: `${Math.min(100, coin.chainShare * 100)}%` }}
                    />
                  </div>
                  <span className="w-10 text-right font-mono text-xs tabular-nums text-muted-foreground">
                    {formatChainShare(coin.chainShare)}
                  </span>
                </div>
              </TableCell>
              <TableCell className={cn("text-right font-mono tabular-nums", deltaColor(coin.change7dPct))}>
                {coin.change7dPct == null ? "—" : formatSignedPercent(coin.change7dPct * 100, 2)}
              </TableCell>
              <TableCell className={cn("text-right font-mono tabular-nums", deltaColor(coin.change30dPct))}>
                {coin.change30dPct == null ? "—" : formatSignedPercent(coin.change30dPct * 100, 2)}
              </TableCell>
            </InteractiveTableRow>
          ))
        )}
      </TableBody>
    </TableFrame>
  );
}
