"use client";

import Link from "next/link";
import { formatCompactUsd } from "@shared/lib/format";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CHART_PALETTE, CHART_SLATE } from "@/lib/chart-colors";
import { getLogoSrc, logosById } from "@/lib/logos";
import { buildStablecoinUrl } from "@shared/lib/urls";
import type { ChainRouteViewModel } from "./view-model";

export function CompositionSection({ model }: { model: ChainRouteViewModel }) {
  const { totalUsd, compositionLayout } = model;
  const { displayCoins, rest, restTotal } = compositionLayout;
  const othersShare = totalUsd > 0 ? restTotal / totalUsd : 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="pharos-label">Stablecoin composition</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Segment widths are proportional to each coin's share of chain supply. */}
        <div className="flex h-8 w-full gap-px overflow-hidden rounded-lg bg-muted" role="list" aria-label="Share of chain supply by stablecoin">
          {displayCoins.map((coin, index) => (
            <Link
              key={coin.id}
              role="listitem"
              href={buildStablecoinUrl(coin.id)}
              className="pharos-focus-ring h-full min-w-[2px] transition-opacity hover:opacity-80"
              style={{ width: `${coin.chainShare * 100}%`, backgroundColor: CHART_PALETTE[index % CHART_PALETTE.length] }}
              title={`${coin.name} (${coin.symbol}) · ${(coin.chainShare * 100).toFixed(1)}% · ${formatCompactUsd(coin.supplyUsd)}`}
              aria-label={`${coin.name}, ${(coin.chainShare * 100).toFixed(1)}% of chain supply`}
            />
          ))}
          {rest.length > 0 && (
            <div
              role="listitem"
              className="h-full min-w-[2px]"
              style={{ width: `${othersShare * 100}%`, backgroundColor: CHART_SLATE }}
              title={`${rest.length} other stablecoins · ${(othersShare * 100).toFixed(1)}% · ${formatCompactUsd(restTotal)}`}
            />
          )}
        </div>

        <ul className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-4">
          {displayCoins.map((coin, index) => (
            <li key={coin.id}>
              <Link
                href={buildStablecoinUrl(coin.id)}
                className="pharos-focus-ring flex items-center gap-2 rounded-md text-sm hover:text-foreground"
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{ backgroundColor: CHART_PALETTE[index % CHART_PALETTE.length] }}
                  aria-hidden="true"
                />
                <StablecoinLogo src={getLogoSrc(logosById, coin.id)} name={coin.name} size={16} />
                <span className="font-medium">{coin.symbol}</span>
                <span className="pharos-numeric text-xs text-muted-foreground">
                  {(coin.chainShare * 100).toFixed(1)}% · {formatCompactUsd(coin.supplyUsd)}
                </span>
              </Link>
            </li>
          ))}
          {rest.length > 0 && (
            <li className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: CHART_SLATE }} aria-hidden="true" />
              <span className="font-medium">+{rest.length} others</span>
              <span className="pharos-numeric text-xs">
                {(othersShare * 100).toFixed(1)}% · {formatCompactUsd(restTotal)}
              </span>
            </li>
          )}
        </ul>
      </CardContent>
    </Card>
  );
}
