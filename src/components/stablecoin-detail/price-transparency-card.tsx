"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DETAIL_SECTION_TITLE_CLASS } from "@/components/stablecoin-detail/section-title";
import type { PegSummaryCoin, StablecoinData } from "@shared/types";
import { cn } from "@/lib/utils";

/** Canonical known sources in display order */
const KNOWN_SOURCES = [
  { key: "coingecko", label: "CoinGecko" },
  { key: "defillama", label: "DefiLlama" },
  { key: "defillama-list", label: "DefiLlama (list)" },
  { key: "geckoterminal", label: "GeckoTerminal" },
  { key: "pyth", label: "Pyth Network" },
  { key: "binance", label: "Binance" },
  { key: "coinbase", label: "Coinbase" },
  { key: "redstone", label: "RedStone" },
  { key: "curve-onchain", label: "Curve on-chain" },
  { key: "curve-oracle", label: "Curve oracle" },
  { key: "dex-promoted", label: "DEX prices" },
  { key: "fluid-dex", label: "Fluid" },
  { key: "balancer-dex", label: "Balancer" },
  { key: "raydium-dex", label: "Raydium" },
  { key: "orca-dex", label: "Orca" },
] as const;

type SourceStatus = "used" | "available" | "no-data" | "not-applicable";

function resolveSourceStatus(
  sourceKey: string,
  agreeSources: string[],
  consensusSources: string[],
  isProtocolRedeem: boolean,
): SourceStatus {
  if (isProtocolRedeem) return "not-applicable";
  if (agreeSources.includes(sourceKey)) return "used";
  if (consensusSources.includes(sourceKey)) return "available";
  return "no-data";
}

const STATUS_CONFIG: Record<SourceStatus, { dot: string; label: string }> = {
  used: { dot: "bg-emerald-500", label: "Used" },
  available: { dot: "bg-sky-400", label: "Available" },
  "no-data": { dot: "bg-muted-foreground/30", label: "No data" },
  "not-applicable": { dot: "bg-muted-foreground/30", label: "Not applicable" },
};

const CONFIDENCE_COLORS: Record<string, string> = {
  high: "text-emerald-600 dark:text-emerald-400",
  "single-source": "text-amber-600 dark:text-amber-400",
  low: "text-rose-600 dark:text-rose-400",
  fallback: "text-muted-foreground",
};

function formatPriceSource(source: string): string {
  const labelMap: Record<string, string> = Object.fromEntries(
    KNOWN_SOURCES.map((s) => [s.key, s.label]),
  );
  return source
    .split("+")
    .map((s) => labelMap[s.trim()] ?? s.trim())
    .join(" + ");
}

function formatTimeAgo(updatedAtSec: number | null | undefined): string {
  if (updatedAtSec == null) return "\u2014";
  const diffSec = Math.floor(Date.now() / 1000) - updatedAtSec;
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

interface PriceTransparencyCardProps {
  coinData: StablecoinData;
  consensusSources: string[];
  agreeSources: string[];
  dexPriceCheck: PegSummaryCoin["dexPriceCheck"];
}

export function PriceTransparencyCard({
  coinData,
  consensusSources,
  agreeSources,
  dexPriceCheck,
}: PriceTransparencyCardProps) {
  if (coinData.price == null) return null;

  const isProtocolRedeem = coinData.priceSource === "protocol-redeem";

  // If the DEX Price Check has data, dex-promoted is available even if it wasn't
  // included in the consensus sources (the consensus pipeline uses a stricter
  // freshness threshold than the UI display tier).
  const effectiveConsensusSources =
    dexPriceCheck && !consensusSources.includes("dex-promoted")
      ? [...consensusSources, "dex-promoted"]
      : consensusSources;

  return (
    <Card className="rounded-xl border-l-[3px] border-l-sky-500">
      <CardHeader className="pb-2">
        <CardTitle as="h2" className={DETAIL_SECTION_TITLE_CLASS}>
          Price Transparency
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Price summary */}
        <div className="space-y-1 text-sm">
          <div className="flex items-baseline gap-2">
            <span className="text-muted-foreground">Current price:</span>
            <span className="font-semibold tabular-nums">${coinData.price.toFixed(4)}</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-muted-foreground">Source:</span>
            <span className="font-medium">
              {isProtocolRedeem ? "Protocol Redemption" : formatPriceSource(coinData.priceSource)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-baseline gap-2">
              <span className="text-muted-foreground">Confidence:</span>
              <span
                className={cn(
                  "text-xs font-semibold uppercase tracking-wider",
                  CONFIDENCE_COLORS[coinData.priceConfidence ?? ""] ?? "text-muted-foreground",
                )}
              >
                {coinData.priceConfidence ?? "\u2014"}
              </span>
            </div>
            <div className="text-xs text-muted-foreground">
              Updated: {formatTimeAgo(coinData.priceUpdatedAt)}
            </div>
          </div>
        </div>

        {/* Source grid - 2-up on desktop */}
        <div className="rounded-lg border overflow-hidden">
          {isProtocolRedeem ? (
            <div className="flex items-center justify-between border-b px-3 py-2 text-sm">
              <span className="font-medium">Protocol Redemption</span>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
                <span className="text-xs text-muted-foreground">Used</span>
              </span>
            </div>
          ) : null}
          <div className="grid grid-cols-1 md:grid-cols-2">
            {KNOWN_SOURCES.map(({ key, label }, index) => {
              const status = resolveSourceStatus(
                key,
                agreeSources,
                effectiveConsensusSources,
                isProtocolRedeem,
              );
              const config = STATUS_CONFIG[status];
              // Don't add a column divider to the last item when it sits alone in the left column
              const isLastAndAlone =
                index === KNOWN_SOURCES.length - 1 && KNOWN_SOURCES.length % 2 === 1;
              return (
                <div
                  key={key}
                  className={cn(
                    "flex items-center justify-between px-3 py-2 text-sm border-b last:border-b-0",
                    !isLastAndAlone && "md:[&:nth-child(odd)]:border-r",
                  )}
                >
                  <span className="font-medium">{label}</span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className={cn("inline-block h-2 w-2 rounded-full", config.dot)} />
                    <span className="text-xs text-muted-foreground">{config.label}</span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* DEX Price Check */}
        {dexPriceCheck ? (
          <div className="space-y-1">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              DEX Price Check
            </div>
            <div className="text-sm">
              <span className="tabular-nums font-medium">
                DEX price: ${dexPriceCheck.dexPrice.toFixed(4)}
              </span>
              {" \u00B7 "}
              <span
                className={cn(
                  "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold",
                  dexPriceCheck.agrees
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                    : "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400",
                )}
              >
                {dexPriceCheck.agrees ? "Agrees" : "Disagrees"}
              </span>
              {" \u00B7 "}
              <span className="text-muted-foreground">
                {dexPriceCheck.sourcePools} pool{dexPriceCheck.sourcePools === 1 ? "" : "s"}
                {" \u00B7 "}${(dexPriceCheck.sourceTvl / 1e6).toFixed(1)}M TVL
                {" \u00B7 "}{Math.abs(dexPriceCheck.dexDeviationBps).toFixed(1)} bps deviation
              </span>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
