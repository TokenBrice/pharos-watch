"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DETAIL_SECTION_TITLE_CLASS } from "@/components/stablecoin-detail/section-title";
import type { PegSummaryCoin, StablecoinData } from "@shared/types";
import { cn } from "@/lib/utils";
import {
  PRICE_TRANSPARENCY_SOURCE_KEYS,
  getPricingSourceLabel,
} from "@shared/lib/pricing-sources";

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



const CONFIDENCE_COLORS: Record<string, string> = {
  high: "text-emerald-600 dark:text-emerald-400",
  "single-source": "text-amber-600 dark:text-amber-400",
  low: "text-rose-600 dark:text-rose-400",
  fallback: "text-muted-foreground",
};

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

interface SourceInfo {
  key: string;
  status: SourceStatus;
  label: string;
}

export function PriceTransparencyCard({
  coinData,
  consensusSources,
  agreeSources,
  dexPriceCheck,
}: PriceTransparencyCardProps) {
  const [showAll, setShowAll] = useState(false);
  
  if (coinData.price == null) return null;

  const isProtocolRedeem = coinData.priceSource === "protocol-redeem";

  // If the DEX Price Check has data, dex-promoted is available even if it wasn't
  // included in the consensus sources (the consensus pipeline uses a stricter
  // freshness threshold than the UI display tier).
  const effectiveConsensusSources =
    dexPriceCheck && !consensusSources.includes("dex-promoted")
      ? [...consensusSources, "dex-promoted"]
      : consensusSources;

  // Group sources by status
  const sources: SourceInfo[] = PRICE_TRANSPARENCY_SOURCE_KEYS.map((key) => ({
    key,
    status: resolveSourceStatus(key, agreeSources, effectiveConsensusSources, isProtocolRedeem),
    label: getPricingSourceLabel(key),
  }));

  const usedSources = sources.filter((s) => s.status === "used");
  const availableSources = sources.filter((s) => s.status === "available");
  const noDataSources = sources.filter((s) => s.status === "no-data");

  return (
    <Card className="rounded-xl" id="price-transparency">
      <CardHeader className="pb-2">
        <CardTitle as="h2" className={DETAIL_SECTION_TITLE_CLASS}>
          Price Transparency
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary Bar */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono tabular-nums">${coinData.price.toFixed(4)}</span>
            <Badge 
              variant="outline" 
              className={cn("text-[11px] uppercase", CONFIDENCE_COLORS[coinData.priceConfidence ?? ""] ?? "text-muted-foreground")}
            >
              {coinData.priceConfidence ?? "—"}
            </Badge>
          </div>
          <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
              {usedSources.length} used
            </span>
            {availableSources.length > 0 && (
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-sky-400" />
                {availableSources.length} available
              </span>
            )}
            <span>· Updated {formatTimeAgo(coinData.priceUpdatedAt)}</span>
          </div>
        </div>

        {/* DEX Price Check - Elevated */}
        {dexPriceCheck ? (
          <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">DEX Check</span>
                <Badge 
                  variant="outline" 
                  className={cn(
                    "text-[11px]",
                    dexPriceCheck.agrees
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                      : "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400"
                  )}
                >
                  {dexPriceCheck.agrees ? "Agrees" : "Disagrees"}
                </Badge>
              </div>
              <span className="text-xs text-muted-foreground">
                {dexPriceCheck.sourcePools} pools · ${(dexPriceCheck.sourceTvl / 1e6).toFixed(1)}M TVL
              </span>
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="font-mono font-medium">${dexPriceCheck.dexPrice.toFixed(4)}</span>
              <span className="text-xs text-muted-foreground">
                {Math.abs(dexPriceCheck.dexDeviationBps).toFixed(1)} bps deviation
              </span>
            </div>
          </div>
        ) : null}

        {/* Source Grid - Grouped by Status */}
        <div className="rounded-lg border overflow-hidden">
          {isProtocolRedeem ? (
            <div className="flex items-center justify-between border-b px-3 py-2 text-sm bg-emerald-500/5">
              <span className="font-medium">Protocol Redemption</span>
              <Badge variant="outline" className="text-[11px] bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20">
                Used
              </Badge>
            </div>
          ) : null}
          
          {/* Used Sources */}
          {usedSources.map((source) => (
            <div
              key={source.key}
              className="flex items-center justify-between px-3 py-2 text-sm border-b last:border-b-0 bg-emerald-500/[0.02]"
            >
              <span className="font-medium">{source.label}</span>
              <Badge variant="outline" className="text-[11px] bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20">
                Used
              </Badge>
            </div>
          ))}

          {/* Available Sources */}
          {availableSources.map((source) => (
            <div
              key={source.key}
              className="flex items-center justify-between px-3 py-2 text-sm border-b last:border-b-0"
            >
              <span className="font-medium text-muted-foreground">{source.label}</span>
              <Badge variant="outline" className="text-[11px] bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/20">
                Available
              </Badge>
            </div>
          ))}

          {/* Expandable No-Data Sources */}
          {noDataSources.length > 0 && (
            <>
              {showAll && noDataSources.map((source) => (
                <div
                  key={source.key}
                  className="flex items-center justify-between px-3 py-2 text-sm border-b last:border-b-0"
                >
                  <span className="font-medium text-muted-foreground/60">{source.label}</span>
                  <Badge variant="outline" className="text-[11px] bg-muted/40 text-muted-foreground border-border/40">
                    No data
                  </Badge>
                </div>
              ))}
              <button
                onClick={() => setShowAll(!showAll)}
                className="pharos-focus-ring w-full flex items-center justify-center gap-1 px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors rounded-md"
              >
                <ChevronDown aria-hidden="true" className={cn("h-3.5 w-3.5 transition-transform", showAll && "rotate-180")} />
                {showAll ? "Show fewer sources" : `Show ${noDataSources.length} more sources`}
              </button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
