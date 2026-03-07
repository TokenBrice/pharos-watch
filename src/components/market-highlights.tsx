"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { buildStablecoinUrl } from "@/lib/urls";
import { formatNativePrice, formatPegDeviation } from "@shared/lib/format";
import { getPegReference } from "@shared/lib/peg-rates";
import { getCirculatingRaw, getPrevWeekRaw } from "@shared/lib/supply";
import { TRACKED_IDS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { StablecoinData } from "@shared/types";

const SKELETON_COLS = Array.from({ length: 2 }, (_, i) => i);
const SKELETON_ROWS = Array.from({ length: 4 }, (_, i) => i);

interface MarketHighlightsProps {
  data: StablecoinData[] | undefined;
  logos?: Record<string, string>;
  pegRates?: Record<string, number>;
}

const HIGHLIGHT_CARD_CLASS = "pharos-card-shell pharos-interactive-card border-l-[3px] bg-gradient-to-b from-background/35 to-transparent";
const ROW_LINK_CLASS = "pharos-focus-ring group -mx-1 flex min-h-11 items-center justify-between gap-2 rounded-md border border-transparent px-2 py-1.5 transition-[background-color,border-color,color] duration-200 hover:border-border/65 hover:bg-muted/40";

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
    return entries.slice(0, 8);
  }, [data, pegRates]);

  return (
    <Card className={`${HIGHLIGHT_CARD_CLASS} border-l-red-500`}>
      <CardHeader className="pb-2">
        <CardTitle as="h2" className="pharos-kicker flex items-center justify-between">
          Current Biggest Depegs
        </CardTitle>
      </CardHeader>
      <CardContent>
        {depegs.length === 0 && (
          <p className="text-xs text-muted-foreground">All tracked stablecoins are on-peg</p>
        )}
        {depegs.length > 0 && <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
          {depegs.map((d) => (
            <Link
              key={d.id}
              href={buildStablecoinUrl(d.id)}
              className={ROW_LINK_CLASS}
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <StablecoinLogo
                  src={logos?.[d.id]}
                  name={d.name}
                  size={18}
                />
                <span className="truncate text-sm font-medium group-hover:underline group-focus-visible:underline">
                  {d.symbol}
                </span>
                <span className="text-xs text-muted-foreground font-mono sm:hidden">
                  {formatNativePrice(d.price, d.pegCurrency, d.pegRef, 2)}
                </span>
                <span className="text-xs text-muted-foreground font-mono hidden sm:inline">
                  {formatNativePrice(d.price, d.pegCurrency, d.pegRef)}
                </span>
              </div>
              <span
                className={`text-xs font-mono font-semibold flex-shrink-0 ${
                  Math.abs(d.bps) >= 50
                    ? "text-red-700 dark:text-red-400"
                    : Math.abs(d.bps) >= 10
                      ? "text-amber-700 dark:text-amber-400"
                      : "text-muted-foreground"
                }`}
              >
                {formatPegDeviation(d.price, d.pegRef)}
              </span>
            </Link>
          ))}
        </div>}
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
      growers: sorted.slice(0, 4),
      shrinkers: sorted.slice(-4).reverse().filter((e) => e.pctChange < 0),
    };
  }, [data]);

  return (
    <Card className={`${HIGHLIGHT_CARD_CLASS} border-l-emerald-500`}>
      <CardHeader className="pb-2">
        <CardTitle as="h2" className="pharos-kicker">
          Fastest Movers <span className="normal-case font-normal text-muted-foreground">(7d)</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-x-4">
          {/* Growing */}
          <div className="space-y-2.5">
            <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 uppercase tracking-wider">Growing</p>
            {growers.length === 0 && <p className="text-xs text-muted-foreground">None</p>}
            {growers.map((g) => (
              <Link
                key={g.id}
                href={buildStablecoinUrl(g.id)}
                className={`${ROW_LINK_CLASS} gap-1`}
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <StablecoinLogo
                    src={logos?.[g.id]}
                    name={g.name}
                    size={18}
                  />
                  <span className="truncate text-sm font-medium group-hover:underline group-focus-visible:underline">
                    {g.symbol}
                  </span>
                </div>
                <span className="text-xs font-mono font-semibold text-emerald-700 dark:text-emerald-400 flex-shrink-0">
                  +{g.pctChange.toFixed(1)}%
                </span>
              </Link>
            ))}
          </div>
          {/* Shrinking */}
          <div className="space-y-2.5">
            <p className="text-xs font-semibold text-red-700 dark:text-red-400 uppercase tracking-wider">Shrinking</p>
            {shrinkers.length === 0 && (
              <p className="text-xs text-muted-foreground">None</p>
            )}
            {shrinkers.map((s) => (
              <Link
                key={s.id}
                href={buildStablecoinUrl(s.id)}
                className={`${ROW_LINK_CLASS} gap-1`}
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <StablecoinLogo
                    src={logos?.[s.id]}
                    name={s.name}
                    size={18}
                  />
                  <span className="truncate text-sm font-medium group-hover:underline group-focus-visible:underline">
                    {s.symbol}
                  </span>
                </div>
                <span className="text-xs font-mono font-semibold text-red-700 dark:text-red-400 flex-shrink-0">
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
        {SKELETON_COLS.map((i) => (
          <Card key={i} className="pharos-card-shell">
            <CardHeader className="pb-1.5">
              <Skeleton className="h-3 w-28" />
            </CardHeader>
            <CardContent className="space-y-3">
              {SKELETON_ROWS.map((j) => (
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
