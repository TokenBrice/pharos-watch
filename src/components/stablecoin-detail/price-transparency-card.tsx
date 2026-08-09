"use client";

import { useState } from "react";
import Image from "next/image";
import { CheckCircle2, ChevronDown, Maximize2, RefreshCw, XIcon } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import {
  DETAIL_MODULE_BODY_CLASS,
  DETAIL_MODULE_HEADER_CLASS,
  DETAIL_MODULE_SHELL_CLASS,
  DETAIL_MODULE_TITLE_CLASS,
} from "@/components/stablecoin-detail/section-title-class";
import { MethodologyLabel } from "@/components/methodology-hint";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
import { RailCard, RailStamp } from "@/components/stablecoin-detail/rail-card";
import { PROTOCOL_LOGOS } from "@/lib/dex-display-constants";
import type { PegSummaryCoin, StablecoinData } from "@shared/types";
import { cn } from "@/lib/utils";
import { PRICE_TRANSPARENCY_SOURCE_KEYS, getPricingSourceLabel } from "@shared/lib/pricing-sources";
import { isPricingSourceProtocolOverride } from "@shared/lib/pricing-source-registry";
import { CONFIDENCE_LEVEL_COLORS } from "@shared/lib/classification";
import { formatCurrency, timeAgo } from "@shared/lib/format";
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

function formatCompactUpdatedAt(epochSec: number | null | undefined): string | null {
  if (epochSec == null) return null;
  return timeAgo(epochSec).replace(/\s+ago$/u, "");
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

const INTERNAL_SOURCE_LOGO = "/icons/icon-maskable-source.svg";

const SOURCE_LOGO_PATHS: Record<string, string> = {
  coingecko: "/price-sources/coingecko.png",
  "coingecko-low-volume": "/price-sources/coingecko.png",
  "coingecko-native-implied": "/price-sources/coingecko.png",
  "coingecko-mirror": "/price-sources/coingecko.png",
  "coingecko-onchain-address": "/price-sources/coingecko.png",
  "cg-ticker": "/price-sources/coingecko.png",
  defillama: "/price-sources/defillama.png",
  "defillama-list": "/price-sources/defillama.png",
  "defillama-contract": "/price-sources/defillama.png",
  geckoterminal: "/price-sources/geckoterminal.png",
  pyth: "/price-sources/pyth.png",
  binance: "/price-sources/binance.svg",
  kraken: "/price-sources/kraken.png",
  bitstamp: "/price-sources/bitstamp.png",
  coinbase: "/price-sources/coinbase.svg",
  redstone: "/price-sources/redstone.svg",
  "curve-onchain": PROTOCOL_LOGOS.curve,
  "curve-oracle": PROTOCOL_LOGOS.curve,
  "chainlink-nav": "/price-sources/chainlink.svg",
  "superstate-liquidity": "/price-sources/superstate.png",
  "dex-promoted": "/price-sources/dexscreener.png",
  "fluid-dex": PROTOCOL_LOGOS.fluid,
  "balancer-dex": PROTOCOL_LOGOS.balancer,
  "curve-dex": PROTOCOL_LOGOS.curve,
  "uniswap-v3-dex": PROTOCOL_LOGOS["uniswap-v3"],
  "uniswap-v3-exact": PROTOCOL_LOGOS["uniswap-v3"],
  "uniswap-v4-dex": PROTOCOL_LOGOS["uniswap-v4"],
  "raydium-dex": PROTOCOL_LOGOS.raydium,
  "orca-dex": PROTOCOL_LOGOS.orca,
  "meteora-dex": PROTOCOL_LOGOS.meteora,
  "pancakeswap-dex": PROTOCOL_LOGOS.pancakeswap,
  "aerodrome-dex": PROTOCOL_LOGOS.aerodrome,
  "velodrome-dex": PROTOCOL_LOGOS.velodrome,
  jupiter: "/price-sources/jupiter.png",
  coinmarketcap: "/price-sources/coinmarketcap.svg",
  "dexscreener-exact": "/price-sources/dexscreener.png",
  "dexscreener-address": "/price-sources/dexscreener.png",
  "dexscreener-search": "/price-sources/dexscreener.png",
  "dexpaprika-address": "/price-sources/dexpaprika.png",
  "alchemy-address": "/price-sources/alchemy.svg",
  "moralis-address": "/price-sources/moralis.png",
  "birdeye-address": "/price-sources/birdeye.png",
  "protocol-redeem": INTERNAL_SOURCE_LOGO,
  "protocol-redemption": INTERNAL_SOURCE_LOGO,
  "zephyr-scanner": "/logos/zsd-zephyr-protocol.png",
  "pool-tvl-weighted": "/price-sources/dexscreener.png",
  cached: INTERNAL_SOURCE_LOGO,
};

const SOURCE_LOGO_WELL_CLASSES: Record<string, string> = {
  redstone: "bg-zinc-950",
};

function SourceLogo({ sourceKey, compact = false }: { sourceKey: string; compact?: boolean }) {
  const src = SOURCE_LOGO_PATHS[sourceKey] ?? INTERNAL_SOURCE_LOGO;
  const sizeClass = compact ? "h-5 w-5" : "h-6 w-6";
  const imageSize = compact ? 16 : 18;

  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-border/50 p-0.5",
        SOURCE_LOGO_WELL_CLASSES[sourceKey] ?? "bg-white",
        sizeClass,
      )}
    >
      <Image
        src={src}
        alt=""
        width={imageSize}
        height={imageSize}
        className="h-full w-full rounded-full object-contain"
        aria-hidden="true"
      />
    </span>
  );
}

function SourceChip({
  sourceKey,
  label,
  status,
  compact = false,
}: {
  sourceKey: string;
  label: string;
  status: RenderedSourceStatus;
  compact?: boolean;
}) {
  const style = SOURCE_CHIP_STYLES[status];
  if (compact) {
    // Rail rendering (Figma coin template): source name + status square dot;
    // the legend beneath the grid decodes the colors.
    return (
      <div className="flex min-w-0 items-center justify-between gap-2 py-1.5 text-sm">
        <span className="flex min-w-0 items-center gap-2">
          <SourceLogo sourceKey={sourceKey} compact />
          <span className={cn("min-w-0 truncate", style.label)} title={label}>
            {label}
          </span>
        </span>
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
      <span className={cn("min-w-0 truncate", style.label)} title={label}>
        {label}
      </span>
      <Badge variant="outline" className={cn("shrink-0 text-[11px]", style.badge)}>
        {style.text}
      </Badge>
    </div>
  );
}

function CompactPriceTransparencyCard({
  coinData,
  dexPriceCheck,
  sources,
  usedSources,
  availableSources,
  includeProtocolRedeem,
  sourceDepthCount,
  hasNoPrice,
}: PriceTransparencyCardProps & {
  sources: SourceInfo[];
  usedSources: Array<SourceInfo & { status: "used" }>;
  availableSources: Array<SourceInfo & { status: "available" }>;
  includeProtocolRedeem: boolean;
  sourceDepthCount: number;
  hasNoPrice: boolean;
}) {
  const updatedAtLabel = formatCompactUpdatedAt(coinData.priceUpdatedAt);
  const displayedSources = [
    ...(includeProtocolRedeem
      ? [{ key: "protocol-redemption", label: "Protocol Redemption", status: "used" as const }]
      : []),
    ...usedSources,
    ...availableSources,
  ];

  return (
    <RailCard
      title="Price Transparency"
      ariaLabel="Price transparency"
      trailing={
        updatedAtLabel ? (
          <RailStamp className="gap-1.5">
            <RefreshCw className="h-3 w-3" aria-hidden="true" />
            {updatedAtLabel}
          </RailStamp>
        ) : null
      }
    >
      <div className="px-4 pb-4">
        <p className="font-mono text-[2rem] font-semibold leading-none tracking-normal tabular-nums text-foreground">
          {coinData.price != null ? `$${coinData.price.toFixed(4)}` : "N/A"}
        </p>
        <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
          {hasNoPrice ? "No Consensus" : (coinData.priceConfidence ?? "—").toUpperCase()}
          <span className="px-1.5 text-muted-foreground/45" aria-hidden="true">
            ·
          </span>
          Sources {formatSourceDepthTargetLabel(sourceDepthCount)}
        </p>
      </div>

      {dexPriceCheck ? (
        <div className="border-t border-border/50 px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-muted-foreground">DEX Check</p>
            <Badge
              variant="outline"
              className={cn(
                "h-5 gap-1 rounded-full px-2 text-[11px] font-medium",
                dexPriceCheck.agrees
                  ? "border-emerald-500/20 bg-emerald-500/12 text-emerald-700 dark:text-emerald-400"
                  : "border-rose-500/25 bg-rose-500/12 text-rose-700 dark:text-rose-400",
              )}
            >
              <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
              {dexPriceCheck.agrees ? "Agrees" : "Disagrees"}
            </Badge>
          </div>
          <p className="mt-3 font-mono text-[2rem] font-semibold leading-none tracking-normal tabular-nums text-foreground">
            ${dexPriceCheck.dexPrice.toFixed(4)}
          </p>
          <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
            {formatCurrency(dexPriceCheck.sourceTvl)} TVL
            <span className="px-1.5 text-muted-foreground/45" aria-hidden="true">
              ·
            </span>
            {dexPriceCheck.sourcePools} pools
            <span className="px-1.5 text-muted-foreground/45" aria-hidden="true">
              ·
            </span>
            {Math.abs(dexPriceCheck.dexDeviationBps).toFixed(1)} bps dev
          </p>
        </div>
      ) : null}

      <div className="border-t border-border/50 px-4 py-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-muted-foreground">Sources</p>
          <SourcesModal
            sources={sources}
            includeProtocolRedeem={includeProtocolRedeem}
            updatedAtLabel={coinData.priceUpdatedAt != null ? timeAgo(coinData.priceUpdatedAt) : null}
          />
        </div>
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5">
          {displayedSources.map((source) => (
            <SourceChip key={source.key} sourceKey={source.key} label={source.label} status={source.status} compact />
          ))}
        </div>
      </div>
    </RailCard>
  );
}

/**
 * Full source registry modal (Figma coin template `dark-modal`/`light-modal`
 * frames): "Sources" header with the freshness pill, a two-column list of
 * every source with a status square (used / available / unused), and the
 * three-state legend in the footer. Opened from the rail Sources header.
 */
function SourcesModal({
  sources,
  includeProtocolRedeem,
  updatedAtLabel,
}: {
  sources: SourceInfo[];
  includeProtocolRedeem: boolean;
  updatedAtLabel: string | null;
}) {
  const ordered: { key: string; label: string; status: RenderedSourceStatus }[] = [
    ...(includeProtocolRedeem
      ? [{ key: "protocol-redemption", label: "Protocol Redemption", status: "used" as const }]
      : []),
    ...sources
      .filter((source): source is SourceInfo & { status: RenderedSourceStatus } => source.status !== "not-applicable")
      .sort((a, b) => {
        const rank: Record<RenderedSourceStatus, number> = { used: 0, available: 1, "no-data": 2 };
        return rank[a.status] - rank[b.status];
      }),
  ];

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label="Show all price sources"
          className="pharos-focus-ring flex h-6 w-6 items-center justify-center rounded-md border border-border/60 text-muted-foreground transition-colors hover:text-foreground"
        >
          <Maximize2 className="h-3 w-3" aria-hidden="true" />
        </button>
      </DialogTrigger>
      <DialogContent className="gap-0 p-0 sm:max-w-2xl" showCloseButton={false}>
        <div className="flex items-center justify-between gap-3 border-b border-border/40 py-3 pl-5 pr-4">
          <DialogTitle className="text-sm font-medium text-foreground">Sources</DialogTitle>
          <div className="flex items-center gap-2">
            {updatedAtLabel ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                <RefreshCw className="h-3 w-3" aria-hidden="true" />
                {updatedAtLabel}
              </span>
            ) : null}
            <DialogClose asChild>
              <button
                type="button"
                aria-label="Close"
                className="pharos-focus-ring flex h-6 w-6 items-center justify-center rounded-md border border-border/60 text-muted-foreground transition-colors hover:text-foreground"
              >
                <XIcon className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </DialogClose>
          </div>
        </div>
        <div className="max-h-[60vh] overflow-y-auto px-5 py-3">
          <div className="grid gap-x-8 sm:grid-cols-2">
            {ordered.map((source) => (
              <div key={source.key} className="flex items-center justify-between gap-3 py-2">
                <span className="flex min-w-0 items-center gap-2.5">
                  <SourceLogo sourceKey={source.key} />
                  <span
                    className={cn(
                      "truncate text-sm",
                      source.status === "no-data" ? "text-muted-foreground/70" : "text-foreground",
                    )}
                    title={source.label}
                  >
                    {source.label}
                  </span>
                </span>
                <span
                  className={cn("h-2 w-2 shrink-0 rounded-[2px]", SOURCE_DOT_CLASSES[source.status])}
                  role="img"
                  aria-label={source.status === "no-data" ? "Unused" : SOURCE_CHIP_STYLES[source.status].text}
                />
              </div>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-center gap-3 border-t border-border/40 px-5 py-3">
          <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            <span className="h-2 w-2 rounded-[2px] bg-emerald-500" aria-hidden="true" />
            Used
          </span>
          <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            <span className="h-2 w-2 rounded-[2px] bg-sky-400" aria-hidden="true" />
            Available
          </span>
          <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            <span className="h-2 w-2 rounded-[2px] bg-muted-foreground/40" aria-hidden="true" />
            Unused
          </span>
        </div>
      </DialogContent>
    </Dialog>
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
  const availableSources = sources.filter((s): s is SourceInfo & { status: "available" } => s.status === "available");
  const noDataSources = sources.filter((s): s is SourceInfo & { status: "no-data" } => s.status === "no-data");
  const sourceDepthCount = effectiveConsensusSources.length;
  const sourceDepthTone =
    sourceDepthCount >= 3
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
      : sourceDepthCount === 2
        ? "border-amber-500/32 bg-amber-500/12 text-amber-700 dark:text-amber-300"
        : "border-border/60 bg-muted/40 text-muted-foreground";

  if (compact) {
    return (
      <CompactPriceTransparencyCard
        coinData={coinData}
        consensusSources={consensusSources}
        agreeSources={agreeSources}
        dexPriceCheck={dexPriceCheck}
        sources={sources}
        usedSources={usedSources}
        availableSources={availableSources}
        includeProtocolRedeem={isProtocolRedeem}
        sourceDepthCount={sourceDepthCount}
        hasNoPrice={hasNoPrice}
      />
    );
  }

  return (
    <Card className={DETAIL_MODULE_SHELL_CLASS} id="price-transparency">
      <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>
        <DetailSectionTitle className={DETAIL_MODULE_TITLE_CLASS}>
          <MethodologyLabel topic="pegScore">Price Transparency</MethodologyLabel>
        </DetailSectionTitle>
      </CardHeader>
      <CardContent className={cn(DETAIL_MODULE_BODY_CLASS, "space-y-4")}>
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
              className={cn(
                "text-[11px] uppercase",
                hasNoPrice
                  ? "text-muted-foreground"
                  : (CONFIDENCE_LEVEL_COLORS[coinData.priceConfidence as keyof typeof CONFIDENCE_LEVEL_COLORS] ??
                      "text-muted-foreground"),
              )}
            >
              {hasNoPrice ? "no consensus" : (coinData.priceConfidence ?? "—")}
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
            {!hasNoPrice && (
              <span>· Updated {coinData.priceUpdatedAt == null ? "\u2014" : timeAgo(coinData.priceUpdatedAt)}</span>
            )}
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
                      : "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400",
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
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {isProtocolRedeem ? (
              <SourceChip sourceKey="protocol-redeem" label="Protocol Redemption" status="used" />
            ) : null}

            {/* Used Sources */}
            {usedSources.map((source) => (
              <SourceChip key={source.key} sourceKey={source.key} label={source.label} status={source.status} />
            ))}

            {/* Available Sources */}
            {availableSources.map((source) => (
              <SourceChip key={source.key} sourceKey={source.key} label={source.label} status={source.status} />
            ))}

            {/* Expandable No-Data Sources (full card only; the rail exposes
                them through the Sources modal instead) */}
            {showAll &&
              noDataSources.map((source) => (
                <SourceChip key={source.key} sourceKey={source.key} label={source.label} status={source.status} />
              ))}
          </div>

          {noDataSources.length > 0 && (
            <button
              type="button"
              onClick={() => setShowAll(!showAll)}
              className="pharos-focus-ring flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
            >
              <ChevronDown
                aria-hidden="true"
                className={cn("h-3.5 w-3.5 transition-transform", showAll && "rotate-180")}
              />
              {showAll ? "Show fewer sources" : `Show ${noDataSources.length} more sources`}
            </button>
          )}
        </div>

        <EvidenceFooter topic="pegScore" />
      </CardContent>
    </Card>
  );
}
