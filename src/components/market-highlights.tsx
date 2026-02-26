"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { formatNativePrice, formatPegDeviation } from "@/lib/format";
import { getPegReference } from "@/lib/peg-rates";
import { getCirculatingRaw, getPrevWeekRaw } from "@/lib/supply";
import { TRACKED_IDS, TRACKED_META_BY_ID } from "@/lib/stablecoins";
import type { StablecoinData } from "@/lib/types";

interface MarketHighlightsProps {
  data: StablecoinData[] | undefined;
  logos?: Record<string, string>;
  pegRates?: Record<string, number>;
}

// --- Biggest Depegs ---

function BiggestDepegs({
  data,
  logos,
  pegRates = {},
}: MarketHighlightsProps) {
  const depegs = useMemo(() => {
    if (!data) return [];

    const metaById = TRACKED_META_BY_ID;
    const entries: {
      id: string;
      symbol: string;
      name: string;
      price: number;
      bps: number;
      pegRef: number;
      pegCurrency: string;
    }[] = [];

    for (const coin of data) {
      const meta = metaById.get(coin.id);
      if (!meta) continue;
      // Skip NAV tokens — their price deviates from peg by design (yield accrual)
      if (meta.flags.navToken) continue;
      if (coin.price == null || typeof coin.price !== "number" || isNaN(coin.price)) continue;
      const supply = getCirculatingRaw(coin);
      if (supply < 1_000_000) continue;

      const pegRef = getPegReference(coin.pegType, pegRates, meta.commodityOunces);
      if (pegRef === 0) continue;
      const bps = Math.round(((coin.price / pegRef) - 1) * 10000);

      entries.push({
        id: coin.id,
        symbol: coin.symbol,
        name: coin.name,
        price: coin.price,
        bps,
        pegRef,
        pegCurrency: meta.flags.pegCurrency,
      });
    }

    entries.sort((a, b) => Math.abs(b.bps) - Math.abs(a.bps));
    return entries.slice(0, 5);
  }, [data, pegRates]);

  return (
    <Card className="rounded-xl border-l-[3px] border-l-red-500 hover:border-foreground/20 transition-colors">
      <CardHeader className="pb-2">
        <CardTitle as="h2" className="flex items-center justify-between text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Current Biggest Depegs
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2.5">
        {depegs.length === 0 && (
          <p className="text-xs text-muted-foreground">No data</p>
        )}
        {depegs.map((d) => (
          <Link
            key={d.id}
            href={`/stablecoin/${d.id}`}
            className="flex items-center justify-between gap-2 group"
          >
            <div className="flex items-center gap-2 min-w-0">
              <StablecoinLogo
                src={logos?.[d.id]}
                name={d.name}
                size={20}
              />
              <span className="text-sm font-medium truncate group-hover:underline">
                {d.symbol}
              </span>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className="text-xs text-muted-foreground font-mono">
                {formatNativePrice(d.price, d.pegCurrency, d.pegRef)}
              </span>
              <span
                className={`text-xs font-mono font-semibold ${
                  Math.abs(d.bps) >= 50
                    ? "text-red-500"
                    : Math.abs(d.bps) >= 10
                      ? "text-amber-500"
                      : "text-muted-foreground"
                }`}
              >
                {formatPegDeviation(d.price, d.pegRef)}
              </span>
            </div>
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}

// --- Fastest Movers ---

function FastestMovers({
  data,
  logos,
}: MarketHighlightsProps) {
  const { growers, shrinkers } = useMemo(() => {
    if (!data) return { growers: [], shrinkers: [] };

    const metaIds = TRACKED_IDS;
    const entries: {
      id: string;
      symbol: string;
      name: string;
      pctChange: number;
    }[] = [];

    for (const coin of data) {
      if (!metaIds.has(coin.id)) continue;
      const current = getCirculatingRaw(coin);
      const prev = getPrevWeekRaw(coin);
      if (current < 1_000_000 || prev < 1_000_000) continue;

      const pctChange = ((current - prev) / prev) * 100;
      entries.push({
        id: coin.id,
        symbol: coin.symbol,
        name: coin.name,
        pctChange,
      });
    }

    const sorted = [...entries].sort((a, b) => b.pctChange - a.pctChange);
    return {
      growers: sorted.slice(0, 3),
      shrinkers: sorted.slice(-3).reverse().filter((e) => e.pctChange < 0),
    };
  }, [data]);

  return (
    <Card className="rounded-xl border-l-[3px] border-l-emerald-500 hover:border-foreground/20 transition-colors">
      <CardHeader className="pb-2">
        <CardTitle as="h2" className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Fastest Movers <span className="normal-case font-normal text-muted-foreground">(7d)</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-x-4">
          {/* Growing */}
          <div className="space-y-2.5">
            <p className="text-xs font-semibold text-emerald-500 uppercase tracking-wider">Growing</p>
            {growers.map((g) => (
              <Link
                key={g.id}
                href={`/stablecoin/${g.id}`}
                className="flex items-center justify-between gap-1 group"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <StablecoinLogo
                    src={logos?.[g.id]}
                    name={g.name}
                    size={18}
                  />
                  <span className="text-sm font-medium truncate group-hover:underline">
                    {g.symbol}
                  </span>
                </div>
                <span className="text-xs font-mono font-semibold text-emerald-500 flex-shrink-0">
                  +{g.pctChange.toFixed(1)}%
                </span>
              </Link>
            ))}
          </div>
          {/* Shrinking */}
          <div className="space-y-2.5">
            <p className="text-xs font-semibold text-red-500 uppercase tracking-wider">Shrinking</p>
            {shrinkers.length === 0 && (
              <p className="text-xs text-muted-foreground">None</p>
            )}
            {shrinkers.map((s) => (
              <Link
                key={s.id}
                href={`/stablecoin/${s.id}`}
                className="flex items-center justify-between gap-1 group"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <StablecoinLogo
                    src={logos?.[s.id]}
                    name={s.name}
                    size={18}
                  />
                  <span className="text-sm font-medium truncate group-hover:underline">
                    {s.symbol}
                  </span>
                </div>
                <span className="text-xs font-mono font-semibold text-red-500 flex-shrink-0">
                  {s.pctChange.toFixed(1)}%
                </span>
              </Link>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// --- Combined export ---

export function MarketHighlights({ data, logos, pegRates }: MarketHighlightsProps) {
  if (!data) {
    return (
      <div className="grid gap-5 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Card key={i} className="rounded-xl">
            <CardHeader className="pb-2">
              <Skeleton className="h-3 w-28" />
            </CardHeader>
            <CardContent className="space-y-3">
              {Array.from({ length: 4 }).map((_, j) => (
                <Skeleton key={j} className="h-5 w-full" />
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="grid gap-5 lg:grid-cols-2 animate-in fade-in duration-300">
      <BiggestDepegs data={data} logos={logos} pegRates={pegRates} />
      <FastestMovers data={data} logos={logos} />
    </div>
  );
}
