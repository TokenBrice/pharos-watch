"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { MethodologyLabel } from "@/components/methodology-hint";
import type { PegSummaryCoin, StablecoinData } from "@shared/types";
import { cn } from "@/lib/utils";
import {
  PRICE_TRANSPARENCY_SOURCE_KEYS,
  getPricingSourceLabel,
} from "@shared/lib/pricing-sources";
import { isPricingSourceProtocolOverride } from "@shared/lib/pricing-source-registry";
import { CONFIDENCE_LEVEL_COLORS } from "@shared/lib/classification";
import { timeAgo } from "@shared/lib/format";
import { resolvePriceTransparencySourceStatus, type SourceStatus } from "./price-transparency-status";

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

function formatSourceDepthTargetLabel(sourceCount: number): string {
  return sourceCount >= 3 ? "3+/3" : `${sourceCount}/3`;
}

type RenderedSourceStatus = Exclude<SourceStatus, "not-applicable">;

const SOURCE_CHIP_STYLES: Record<RenderedSourceStatus, { wrap: string; label: string; badge: string; text: string }> = {
  used: {
    wrap: "border-emerald-500/20 bg-emerald-500/[0.03]",
    label: "font-medium",
    badge: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
    text: "Used",
  },
  available: {
    wrap: "border-border",
    label: "font-medium text-muted-foreground",
    badge: "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/20",
    text: "Available",
  },
  "no-data": {
    wrap: "border-border/60",
    label: "font-medium text-muted-foreground/70",
    badge: "bg-muted/40 text-muted-foreground border-border/40",
    text: "No feed",
  },
};

const SOURCE_DOT_CLASSES: Record<RenderedSourceStatus, string> = {
  used: "bg-emerald-500",
  available: "bg-sky-400",
  "no-data": "bg-muted-foreground/40",
};

function SourceChip({
  label,
  status,
  compact = false,
}: {
  label: string;
  status: RenderedSourceStatus;
  compact?: boolean;
}) {
  const style = SOURCE_CHIP_STYLES[status];
  if (compact) {
    // Rail rendering (Figma coin template): source name + status square dot;
    // the legend beneath the grid decodes the colors.
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-border/50 bg-background/30 px-2.5 py-1.5 text-sm">
        <span className={cn("min-w-0 truncate", style.label)} title={label}>{label}</span>
        <span
          className={cn("h-2 w-2 shrink-0 rounded-[2px]", SOURCE_DOT_CLASSES[status])}
          role="img"
          aria-label={style.text}
        />
      </div>
    );
  }
  return (
    <div className={cn("flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm", style.wrap)}>
      <span className={cn("min-w-0 truncate", style.label)} title={label}>{label}</span>
      <Badge variant="outline" className={cn("shrink-0 text-[11px]", style.badge)}>
        {style.text}
      </Badge>
    </div>
  );
}

export function PriceTransparencyCard({
  coinData,
  consensusSources,
  agreeSources,
  dexPriceCheck,
  compact = false,
}: PriceTransparencyCardProps & {
  /**
   * Rail rendering (Figma coin template): two-up source grid sized for the
   * ~22rem column and no `#price-transparency` anchor — the in-flow
   * Liquidity instance owns the id so dual-rendering never duplicates it.
   */
  compact?: boolean;
}) {
  const [showAll, setShowAll] = useState(false);

  const hasNoPrice = coinData.price == null;
  const isProtocolRedeem = isPricingSourceProtocolOverride(coinData.priceSource);

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
    status: resolvePriceTransparencySourceStatus(key, agreeSources, effectiveConsensusSources, isProtocolRedeem),
    label: getPricingSourceLabel(key),
  }));

  const usedSources = sources.filter((s): s is SourceInfo & { status: "used" } => s.status === "used");
  const availableSources = sources.filter(
    (s): s is SourceInfo & { status: "available" } => s.status === "available",
  );
  const noDataSources = sources.filter((s): s is SourceInfo & { status: "no-data" } => s.status === "no-data");
  const sourceDepthCount = effectiveConsensusSources.length;
  const sourceDepthTone =
    sourceDepthCount >= 3
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
      : sourceDepthCount === 2
        ? "border-amber-500/32 bg-amber-500/12 text-amber-700 dark:text-amber-300"
        : "border-border/60 bg-muted/40 text-muted-foreground";

  return (
    <Card className="pharos-card-shell" id={compact ? undefined : "price-transparency"}>
      <CardHeader className="pb-2">
        <DetailSectionTitle>
          <MethodologyLabel topic="pegScore">Price Transparency</MethodologyLabel>
        </DetailSectionTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary Bar */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-baseline gap-2">
            {coinData.price != null ? (
              <span className="text-2xl font-bold font-mono tabular-nums">${coinData.price.toFixed(4)}</span>
            ) : (
              <span className="text-2xl font-bold font-mono tabular-nums text-muted-foreground">N/A</span>
            )}
            <Badge
              variant="outline"
              className={cn("text-[11px] uppercase", hasNoPrice
                ? "text-muted-foreground"
                : CONFIDENCE_LEVEL_COLORS[coinData.priceConfidence as keyof typeof CONFIDENCE_LEVEL_COLORS] ?? "text-muted-foreground")}
            >
              {hasNoPrice ? "no consensus" : coinData.priceConfidence ?? "—"}
            </Badge>
            <Badge
              variant="outline"
              className={cn("text-[11px] uppercase tabular-nums", sourceDepthTone)}
              title="Candidate source-depth target"
            >
              Sources {formatSourceDepthTargetLabel(sourceDepthCount)}
            </Badge>
          </div>
          <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            {!hasNoPrice && (
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {usedSources.length} used
              </span>
            )}
            {availableSources.length > 0 && (
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-sky-400" />
                {availableSources.length} available
              </span>
            )}
            {!hasNoPrice && <span>· Updated {coinData.priceUpdatedAt == null ? "\u2014" : timeAgo(coinData.priceUpdatedAt)}</span>}
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

        {/* Source Grid - Grouped by Status, 3-up on desktop to use the full width */}
        <div className="space-y-2">
          {compact ? <p className="pharos-kicker">Sources</p> : null}
          <div className={cn("grid gap-2", compact ? "grid-cols-2" : "sm:grid-cols-2 lg:grid-cols-3")}>
            {isProtocolRedeem ? <SourceChip label="Protocol Redemption" status="used" compact={compact} /> : null}

            {/* Used Sources */}
            {usedSources.map((source) => (
              <SourceChip key={source.key} label={source.label} status={source.status} compact={compact} />
            ))}

            {/* Available Sources */}
            {availableSources.map((source) => (
              <SourceChip key={source.key} label={source.label} status={source.status} compact={compact} />
            ))}

            {/* Expandable No-Data Sources */}
            {showAll &&
              noDataSources.map((source) => (
                <SourceChip key={source.key} label={source.label} status={source.status} compact={compact} />
              ))}
          </div>
          {compact ? (
            <div className="flex items-center justify-center gap-3 pt-1">
              <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                <span className="h-2 w-2 rounded-[2px] bg-emerald-500" aria-hidden="true" />
                Used
              </span>
              <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                <span className="h-2 w-2 rounded-[2px] bg-sky-400" aria-hidden="true" />
                Available
              </span>
            </div>
          ) : null}

          {noDataSources.length > 0 && (
            <button type="button"
              onClick={() => setShowAll(!showAll)}
              className="pharos-focus-ring flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
            >
              <ChevronDown aria-hidden="true" className={cn("h-3.5 w-3.5 transition-transform", showAll && "rotate-180")} />
              {showAll ? "Show fewer sources" : `Show ${noDataSources.length} more sources`}
            </button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
