"use client";

import { ChevronRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { BACKING_LABELS_SHORT } from "@shared/lib/classification";
import { formatCompactUsd, formatSignedPercent } from "@shared/lib/format";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ChainStablecoin } from "@/hooks/use-chains";
import { trendColor } from "@/lib/chain-ui";
import { logosById } from "@/lib/logos";
import { buildStablecoinUrl } from "@/lib/urls";
import { cn } from "@/lib/utils";

export function StablecoinTable({
  coins,
  backingFilter,
}: {
  coins: ChainStablecoin[];
  backingFilter: string | null;
}) {
  const router = useRouter();

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
              {coins.map((coin, index) => (
                <TableRow
                  key={coin.id}
                  role="link"
                  aria-label={`${coin.name} (${coin.symbol}) — ${formatCompactUsd(coin.supplyOnChain)} on chain`}
                  className="group cursor-pointer transition-colors hover:bg-muted/40"
                  onClick={() => router.push(buildStablecoinUrl(coin.id))}
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      router.push(buildStablecoinUrl(coin.id));
                    }
                  }}
                >
                  <TableCell className="tabular-nums text-muted-foreground">{index + 1}</TableCell>
                  <TableCell>
                    <span className="flex items-center gap-2 font-medium group-hover:text-primary">
                      <StablecoinLogo src={logosById[coin.id]} name={coin.name} size={24} />
                      <span className="hidden sm:inline">{coin.name}</span>
                      <span className="text-muted-foreground">({coin.symbol})</span>
                      <ChevronRight className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-50" />
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{formatCompactUsd(coin.supplyOnChain)}</TableCell>
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
                    {formatSignedPercent(coin.change7dPct * 100, 2)}
                  </TableCell>
                  <TableCell className={cn("text-right font-mono tabular-nums", trendColor(coin.change30dPct))}>
                    {formatSignedPercent(coin.change30dPct * 100, 2)}
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
