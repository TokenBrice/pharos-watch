"use client";

import { useState } from "react";
import Image from "next/image";
import { ChevronDown, CircleCheck, Maximize2, RefreshCw, TriangleAlert, XIcon } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { DetailModuleCard } from "@/components/stablecoin-detail/module-title";
import { MethodologyLabel } from "@/components/methodology-hint";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
import { RailCard, RailStamp } from "@/components/stablecoin-detail/rail-card";
import { DETAIL_HEADER_ICON_BUTTON_CLASS } from "@/components/stablecoin-detail/section-title-class";
import { PROTOCOL_LOGOS } from "@/lib/dex-display-constants";
import type { PegSummaryCoin } from "@shared/types/peg";
import type { DetailQuote } from "@/lib/stablecoin-detail-view-model-types";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { cn } from "@/lib/utils";
import { useHydrated } from "@/hooks/use-hydrated";
import { PRICE_TRANSPARENCY_SOURCE_KEYS, getPricingSourceLabel } from "@shared/lib/pricing-sources";
import { isPricingSourceProtocolOverride } from "@shared/lib/pricing-source-registry";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { CONFIDENCE_LEVEL_COLORS, ORACLE_BRAND_SWATCH_CLASSES } from "@shared/lib/classification";
import { formatCurrency, formatUsdPriceAdaptive, timeAgo } from "@shared/lib/format";
import { normalizePegType } from "@shared/lib/peg-rates";
import { getPegTaxonomyByCurrency, getPegTaxonomyByType } from "@shared/lib/peg-taxonomy";
import { isCurrentDeviationHeld, referenceAdmissionNote, resolvePriceObservedAtSec } from "@/lib/current-peg";
import { resolvePriceTransparencySourceStatus, type SourceStatus } from "./price-transparency-status";

interface PriceTransparencyCardProps {
  coinData: Pick<DetailQuote, "price" | "priceSource" | "priceConfidence" | "priceUpdatedAt" | "priceObservedAt" | "priceObservedAtMode" | "nominalPriceReference" | "pegType">;
  /** Null when neither the peg row nor the admitted summary was read: unread provenance, not zero sources. */
  consensusSources: string[] | null;
  agreeSources: string[] | null;
  dexPriceCheck?: PegSummaryCoin["dexPriceCheck"];
  /**
   * The hero's peg unit (`coin.flags.pegCurrency`) and USD-per-unit reference.
   * With both, a non-dollar peg reads in its own unit first, like the hero
   * ("CHF 0.9979"), with the USD observation beside it.
   */
  pegCurrency?: string;
  pegRef?: number | null;
  /** A NAV token's DEX check reads against its own NAV, never a peg reference market. */
  navToken?: boolean;
}

interface SourceInfo {
  key: string;
  status: SourceStatus;
  label: string;
}

/**
 * Inline facts separated by a dot that never ends or starts a wrapped line:
 * each later item draws its dot in the gap before it, and the row clips the
 * dot of whichever item opens a line (padding keeps focus rings unclipped).
 */
const DOT_SEPARATED_ROW_CLASS =
  "-mx-1 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 overflow-x-clip px-1 [&>*+*]:relative [&>*+*]:before:absolute [&>*+*]:before:-left-2.5 [&>*+*]:before:text-muted-foreground/60 [&>*+*]:before:content-['·']";

/** Pharos aims for at least this many independent price sources per coin. */
const SOURCE_DEPTH_TARGET = 3;

/**
 * Clocked DEX checks compare quotes directly. Legacy checks compare peg
 * deviations (`agrees` in shared/lib/current-peg-observations.ts).
 * ponytail: display copy of that literal; import it once it is exported.
 */
const DEX_AGREEMENT_THRESHOLD_LABEL = "0.5%";

const CONFIDENCE_PHRASES: Record<string, string> = {
  high: "High confidence",
  "single-source": "Single source",
  low: "Low confidence",
  fallback: "Fallback price",
};

/** A price unit: an ISO code or `$`, and the USD value of one unit (null: USD itself). */
interface PriceUnit {
  code: string;
  usdPerUnit: number | null;
}

const USD_UNIT: PriceUnit = { code: "USD", usdPerUnit: null };

/**
 * The hero's unit rule (`formatHeroNativePrice`): a non-dollar peg with a
 * usable reference reads natively; commodity and dollar pegs read in `$`.
 * Without the hero's peg inputs a non-USD peg keeps an explicit `USD` prefix,
 * never a bare `$` that reads as a 12% gap beside a native hero price.
 */
function resolvePriceUnit(pegType: string, pegCurrency?: string, pegRef?: number | null): PriceUnit {
  const taxonomy = getPegTaxonomyByCurrency(pegCurrency);
  if (pegCurrency && taxonomy && taxonomy.symbol !== "$" && pegRef != null && Number.isFinite(pegRef) && pegRef > 0) {
    return { code: pegCurrency, usdPerUnit: pegRef };
  }
  const dollar = normalizePegType(pegType) === "peggedUSD" || taxonomy?.nativePriceUsesUsdSymbol === true;
  return dollar ? { code: "$", usdPerUnit: null } : USD_UNIT;
}

/** Thousands separators and cents from 1,000 up ("$3,844.03"); four decimals below. */
function formatPriceIn(usdPrice: number, unit: PriceUnit): string {
  const value = unit.usdPerUnit == null ? usdPrice : usdPrice / unit.usdPerUnit;
  const digits = Math.abs(value) >= 1000
    ? value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : formatUsdPriceAdaptive(value);
  return unit.code === "$" ? `$${digits}` : `${unit.code} ${digits}`;
}

function formatBpsAsPercent(bps: number): string {
  return `${(Math.abs(bps) / 100).toFixed(2)}%`;
}

function pluralize(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function formatCompactUpdatedAt(epochSec: number | null | undefined): string | null {
  if (epochSec == null) return null;
  return timeAgo(epochSec).replace(/\s+ago$/u, "");
}

type RenderedSourceStatus = Exclude<SourceStatus, "not-applicable">;

/**
 * Source roles read by grouping and shape, never by hue: what set the price,
 * what was also read, and what had no feed are categories, not risk levels.
 */
const SOURCE_STATUS_TEXT: Record<RenderedSourceStatus, string> = {
  used: "Used for price",
  available: "Also checked",
  "no-data": "No feed",
};

const SOURCE_MARK_CLASSES: Record<RenderedSourceStatus, string> = {
  used: "bg-foreground/70",
  available: "border border-muted-foreground/70",
  "no-data": "bg-muted-foreground/25",
};

function SourceMark({ status }: { status: RenderedSourceStatus }) {
  return <span className={cn("h-2 w-2 shrink-0 rounded-xs", SOURCE_MARK_CLASSES[status])} aria-hidden="true" />;
}

/** Source chips shown before the "Show N more sources" toggle in the full card. */
const INLINE_SOURCE_CAP = 5;

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
  "uniswap-v2-exact": PROTOCOL_LOGOS["uniswap-v2"],
  "uniswap-v3-dex": PROTOCOL_LOGOS["uniswap-v3"],
  "uniswap-v3-exact": PROTOCOL_LOGOS["uniswap-v3"],
  "uniswap-v4-dex": PROTOCOL_LOGOS["uniswap-v4"],
  "uniswap-v4-exact": PROTOCOL_LOGOS["uniswap-v4"],
  "raydium-dex": PROTOCOL_LOGOS.raydium,
  "orca-dex": PROTOCOL_LOGOS.orca,
  "meteora-dex": PROTOCOL_LOGOS.meteora,
  "pancakeswap-dex": PROTOCOL_LOGOS.pancakeswap,
  "aerodrome-dex": PROTOCOL_LOGOS.aerodrome,
  "velodrome-dex": PROTOCOL_LOGOS.velodrome,
  "aero-dex": PROTOCOL_LOGOS.aero,
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

function SourceLogo({ sourceKey, compact = false }: { sourceKey: string; compact?: boolean }) {
  const src = SOURCE_LOGO_PATHS[sourceKey] ?? INTERNAL_SOURCE_LOGO;
  const sizeClass = compact ? "h-5 w-5" : "h-6 w-6";
  const imageSize = compact ? 16 : 18;

  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-border/50 p-0.5",
        ORACLE_BRAND_SWATCH_CLASSES[sourceKey] ?? "bg-white",
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

function SourceChip({ sourceKey, label, muted = false }: { sourceKey: string; label: string; muted?: boolean }) {
  // One line per source: a long venue name truncates (full name on hover)
  // instead of growing its row to two lines.
  return (
    <li className="flex min-w-0 items-center gap-2 py-1 text-sm">
      <SourceLogo sourceKey={sourceKey} compact />
      <span className={cn("min-w-0 truncate leading-snug", muted ? "text-muted-foreground" : "text-foreground")} title={label}>
        {label}
      </span>
    </li>
  );
}

/** One labelled group of sources; the heading names the role, so no legend is needed. */
function SourceGroup({
  title,
  sources,
  muted = false,
  layoutClassName,
}: {
  title: string;
  sources: { key: string; label: string }[];
  muted?: boolean;
  layoutClassName: string;
}) {
  if (sources.length === 0) return null;
  return (
    <div>
      <p className="pharos-label">
        {title} <span className="font-mono tabular-nums">({sources.length})</span>
      </p>
      <ul className={cn("mt-1", layoutClassName)} aria-label={title}>
        {sources.map((source) => (
          <SourceChip key={source.key} sourceKey={source.key} label={source.label} muted={muted} />
        ))}
      </ul>
    </div>
  );
}

/**
 * Full source registry dialog: every tracked source for this coin, grouped by
 * role (used for price, also checked, no feed) with a shape key in the footer.
 * Opened from the rail Sources header.
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
          className={DETAIL_HEADER_ICON_BUTTON_CLASS}
        >
          <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </DialogTrigger>
      <DialogContent className="gap-0 p-0 sm:max-w-2xl" showCloseButton={false}>
        <div className="flex items-center justify-between gap-3 border-b border-border/40 py-3 pl-5 pr-4">
          <DialogTitle className="text-sm font-medium text-foreground">Price sources</DialogTitle>
          <div className="flex items-center gap-2">
            {updatedAtLabel ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-2xs font-medium text-muted-foreground">
                <RefreshCw className="h-3 w-3" aria-hidden="true" />
                {updatedAtLabel}
              </span>
            ) : null}
            <DialogClose asChild>
              <button
                type="button"
                aria-label="Close"
                className={DETAIL_HEADER_ICON_BUTTON_CLASS}
              >
                <XIcon className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </DialogClose>
          </div>
        </div>
        <div className="max-h-[60vh] overflow-y-auto px-5 py-3">
          <ul className="grid gap-x-8 sm:grid-cols-2">
            {ordered.map((source) => (
              <li key={source.key} className="flex items-center justify-between gap-3 py-2">
                <span className="flex min-w-0 items-center gap-2.5">
                  <SourceLogo sourceKey={source.key} />
                  <span
                    className={cn(
                      "truncate text-sm",
                      source.status === "used" ? "text-foreground" : "text-muted-foreground",
                    )}
                    title={source.label}
                  >
                    {source.label}
                  </span>
                </span>
                <span className="flex shrink-0 items-center" role="img" aria-label={SOURCE_STATUS_TEXT[source.status]}>
                  <SourceMark status={source.status} />
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 border-t border-border/40 px-5 py-3">
          {(["used", "available", "no-data"] as const).map((status) => (
            <span key={status} className="pharos-label flex items-center gap-1.5">
              <SourceMark status={status} />
              {SOURCE_STATUS_TEXT[status]}
            </span>
          ))}
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
  pegCurrency,
  pegRef,
  navToken = false,
  compact = false,
}: PriceTransparencyCardProps & {
  /**
   * Rail rendering (Figma coin template): grouped source lists sized for the
   * ~22rem column and no `#price-transparency` anchor — the in-flow
   * Liquidity instance owns the id so dual-rendering never duplicates it.
   */
  compact?: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const hydrated = useHydrated();

  const observed = isObservedPrice(coinData);
  const hasNoPrice = !observed || coinData.price == null;
  const unit = resolvePriceUnit(coinData.pegType, pegCurrency, pegRef);
  const nativeUnit = unit.usdPerUnit != null;
  const nominalReference = coinData.nominalPriceReference ?? (
    (coinData.priceObservedAtMode === "nominal_reference" || coinData.priceSource === "protocol-par") && coinData.price != null
      ? { price: coinData.price, source: coinData.priceSource ?? "protocol-par" }
      : null
  );
  const nominalReferenceNote = nominalReference ? (
    <p className="text-sm text-muted-foreground">
      Nominal par reference: {formatPriceIn(nominalReference.price, unit)} ({getPricingSourceLabel(nominalReference.source)}). Not an observed price or a live redemption quote.
    </p>
  ) : null;
  const isProtocolRedeem = observed && isPricingSourceProtocolOverride(coinData.priceSource);
  // Unread provenance cannot say a source was unused: withhold the source lists
  // and the depth count instead of publishing an absent read as zero sources.
  const sourceProvenanceUnread = consensusSources == null || agreeSources == null;
  const knownConsensusSources = consensusSources ?? [];
  const knownAgreeSources = agreeSources ?? [];

  // If the DEX Price Check has data, dex-promoted is available even if it wasn't
  // included in the consensus sources (the consensus pipeline uses a stricter
  // freshness threshold than the UI display tier).
  const effectiveConsensusSources = !observed ? [] :
    dexPriceCheck && !knownConsensusSources.includes("dex-promoted")
      ? [...knownConsensusSources, "dex-promoted"]
      : knownConsensusSources;

  const sources: SourceInfo[] = sourceProvenanceUnread ? [] : PRICE_TRANSPARENCY_SOURCE_KEYS.map((key) => ({
    key,
    status: resolvePriceTransparencySourceStatus(key, observed ? knownAgreeSources : [], effectiveConsensusSources, isProtocolRedeem),
    label: getPricingSourceLabel(key),
  }));

  const usedSources = [
    ...(isProtocolRedeem ? [{ key: "protocol-redemption", label: "Protocol Redemption" }] : []),
    ...sources.filter((s) => s.status === "used"),
  ];
  const availableSources = sources.filter((s) => s.status === "available");
  const noDataCount = sources.filter((s) => s.status === "no-data").length;
  const sourceDepthCount = effectiveConsensusSources.length;
  // The full card opens capped: "also checked" sources beyond the cap sit
  // behind one toggle; registry sources with no feed collapse to a count.
  const inlineAvailableCap = Math.max(0, INLINE_SOURCE_CAP - usedSources.length);
  const visibleAvailableSources = showAll ? availableSources : availableSources.slice(0, inlineAvailableCap);
  const hiddenSourceCount = availableSources.length - visibleAvailableSources.length;

  // --- Derived once; both shells read the same locals ----------------------
  const sourceDepthTone = sourceProvenanceUnread
    ? SEVERITY_TONE_CLASS.neutral
    : sourceDepthCount >= SOURCE_DEPTH_TARGET
      ? SEVERITY_TONE_CLASS.ok
      : sourceDepthCount === SOURCE_DEPTH_TARGET - 1
        ? SEVERITY_TONE_CLASS.caution
        : SEVERITY_TONE_CLASS.neutral;
  const sourceDepthLabel = sourceProvenanceUnread
    ? "Source depth unavailable"
    : sourceDepthCount >= SOURCE_DEPTH_TARGET
      ? `${pluralize(sourceDepthCount, "source")} checked`
      : `${sourceDepthCount} of ${SOURCE_DEPTH_TARGET} target sources`;
  const sourceDepthTitle = `Pharos aims to read at least ${SOURCE_DEPTH_TARGET} independent price sources for each coin.`;
  const agreementLine = hasNoPrice || sourceProvenanceUnread
    ? null
    : isProtocolRedeem
      ? "Set by protocol redemption"
      : usedSources.length === 0
        ? null
        : usedSources.length === 1
          ? `Set by ${usedSources[0]!.label}`
          : `Set by ${usedSources.length} agreeing sources`;
  const dexAgreementTone = dexPriceCheck?.agrees ? SEVERITY_TONE_CLASS.ok.pill : SEVERITY_TONE_CLASS.rose.pill;
  const dexAgreementLabel = dexPriceCheck?.agrees ? "Agrees" : "Disagrees";
  const dexAgreementSentence = dexPriceCheck?.agrees
    ? `DEX price is within ${DEX_AGREEMENT_THRESHOLD_LABEL} of the primary price.`
    : `DEX price differs from the primary price by more than ${DEX_AGREEMENT_THRESHOLD_LABEL}.`;
  // The glyph tracks the verdict. `CircleCheck`/`TriangleAlert` is the house
  // severity glyph vocabulary (`src/components/severity-icon.tsx`).
  const DexAgreementIcon = dexPriceCheck?.agrees ? CircleCheck : TriangleAlert;
  const dexCurrency = navToken ? null : getPegTaxonomyByType(coinData.pegType)?.currency;
  const dexAdmission = navToken ? null : dexPriceCheck?.referenceAdmission;
  const dexObservedAt = resolvePriceObservedAtSec({ priceObservedAt: dexPriceCheck?.observedAtSec });
  const dexReferenceNote = dexAdmission
    ? referenceAdmissionNote(dexAdmission) ?? (dexAdmission.status !== "admitted" || dexAdmission.quoteObservedAtSec !== dexObservedAt
      ? "Reference comparison unavailable" : null)
    : isCurrentDeviationHeld(dexCurrency, dexObservedAt ?? resolvePriceObservedAtSec(coinData), dexPriceCheck?.dexDeviationBps)
      ? "Reference market closed" : null;
  const priceLabel = !hasNoPrice && coinData.price != null ? formatPriceIn(coinData.price, unit) : "N/A";
  const usdPriceLabel = nativeUnit && !hasNoPrice && coinData.price != null ? formatPriceIn(coinData.price, USD_UNIT) : null;
  const confidenceLabel = hasNoPrice
    ? "Observed price unavailable now"
    : coinData.priceConfidence
      ? CONFIDENCE_PHRASES[coinData.priceConfidence] ?? coinData.priceConfidence
      : null;
  const confidenceTone = hasNoPrice
    ? "text-muted-foreground"
    : CONFIDENCE_LEVEL_COLORS[coinData.priceConfidence as keyof typeof CONFIDENCE_LEVEL_COLORS] ?? "text-muted-foreground";
  const dexPriceLabel = dexPriceCheck ? formatPriceIn(dexPriceCheck.dexPrice, dexReferenceNote ? USD_UNIT : unit) : null;
  // Segments never break inside themselves ("0.01% / deviation"); the row's dots never orphan.
  const dexDetail = dexPriceCheck
    ? [
        pluralize(dexPriceCheck.sourcePools, "DEX price source"),
        `${formatCurrency(dexPriceCheck.sourceTvl)} TVL`,
        dexReferenceNote ?? `${formatBpsAsPercent(dexPriceCheck.dexDeviationBps)} from reference`,
      ].map((segment) => (
        <span key={segment} className="whitespace-nowrap">{segment}</span>
      ))
    : null;
  const dexDeviationTitle = "Deviation of the DEX price from the peg (for NAV tokens, from the token's own reference price).";
  const noFeedLine = noDataCount > 0 ? `${pluralize(noDataCount, "other tracked source")} had no feed for this coin.` : null;

  if (compact) {
    const updatedAtLabel = hydrated && !hasNoPrice ? formatCompactUpdatedAt(coinData.priceUpdatedAt) : null;

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
            {priceLabel}
          </p>
          <p className="pharos-label mt-2">
            {usdPriceLabel ? (
              <>
                <span className="font-mono tabular-nums">{usdPriceLabel}</span>
                <span className="px-1.5 text-muted-foreground/45" aria-hidden="true">·</span>
              </>
            ) : null}
            {confidenceLabel ? <span className={confidenceTone}>{confidenceLabel}</span> : null}
          </p>
          {agreementLine || !sourceProvenanceUnread ? (
            <p className="pharos-label mt-1">
              {agreementLine}
              {agreementLine && !sourceProvenanceUnread ? (
                <span className="px-1.5 text-muted-foreground/45" aria-hidden="true">·</span>
              ) : null}
              {!sourceProvenanceUnread ? (
                <span className={sourceDepthTone.text} title={sourceDepthTitle}>{sourceDepthLabel}</span>
              ) : null}
            </p>
          ) : null}
          {nominalReferenceNote ? <div className="mt-2">{nominalReferenceNote}</div> : null}
        </div>

        {observed && dexPriceCheck ? (
          <div className="border-t border-border/50 px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-muted-foreground">DEX check</p>
              <Badge
                variant="outline"
                className={cn("h-5 gap-1 rounded-full px-2 text-2xs font-medium", dexAgreementTone)}
              >
                <DexAgreementIcon className="h-3 w-3" aria-hidden="true" />
                {dexAgreementLabel}
              </Badge>
            </div>
            <p className="mt-2 font-mono text-lg font-semibold leading-none tabular-nums text-foreground">{dexPriceLabel}</p>
            <p className="mt-2 text-xs text-muted-foreground">{dexAgreementSentence}</p>
            <p className={cn("pharos-label mt-1", DOT_SEPARATED_ROW_CLASS)} title={dexDeviationTitle}>{dexDetail}</p>
          </div>
        ) : null}

        {sourceProvenanceUnread ? null : (
          <div className="border-t border-border/50 px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-muted-foreground">Sources</p>
              <SourcesModal
                sources={sources}
                includeProtocolRedeem={isProtocolRedeem}
                updatedAtLabel={hydrated && !hasNoPrice && coinData.priceUpdatedAt != null ? timeAgo(coinData.priceUpdatedAt) : null}
              />
            </div>
            <div className="mt-2 space-y-3">
              <SourceGroup title={SOURCE_STATUS_TEXT.used} sources={usedSources} layoutClassName="grid grid-cols-2 gap-x-4" />
              <SourceGroup title={SOURCE_STATUS_TEXT.available} sources={availableSources} muted layoutClassName="grid grid-cols-2 gap-x-4" />
            </div>
          </div>
        )}
      </RailCard>
    );
  }

  return (
    <DetailModuleCard
      id="price-transparency"
      title={<MethodologyLabel topic="priceTransparency">Price Transparency</MethodologyLabel>}
      bodyClassName="space-y-4"
    >
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className={cn("font-mono text-2xl font-semibold tabular-nums", hasNoPrice && "text-muted-foreground")}>
                {priceLabel}
              </span>
              {usdPriceLabel ? (
                <span className="font-mono text-sm tabular-nums text-muted-foreground">{usdPriceLabel}</span>
              ) : null}
            </div>
            <p className={cn(DOT_SEPARATED_ROW_CLASS, "text-sm text-muted-foreground")}>
              {confidenceLabel ? <span className={cn("font-medium", confidenceTone)}>{confidenceLabel}</span> : null}
              {agreementLine ? <span>{agreementLine}</span> : null}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {!sourceProvenanceUnread ? (
              <Badge variant="outline" className={cn("text-2xs", sourceDepthTone.pill)} title={sourceDepthTitle}>
                {sourceDepthLabel}
              </Badge>
            ) : null}
            {!hasNoPrice ? (
              <span>Updated {!hydrated || coinData.priceUpdatedAt == null ? "\u2014" : timeAgo(coinData.priceUpdatedAt)}</span>
            ) : null}
          </div>
        </div>
        {nominalReferenceNote}

        {/* DEX check: the container stays neutral; the verdict pill alone
            carries tone (and glyph), and the sentence names its threshold. */}
        {observed && dexPriceCheck ? (
          <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-xs font-medium text-muted-foreground">DEX check</span>
              <Badge variant="outline" className={cn("gap-1 text-2xs", dexAgreementTone)}>
                <DexAgreementIcon className="h-3 w-3" aria-hidden="true" />
                {dexAgreementLabel}
              </Badge>
              <span className="text-xs text-muted-foreground">{dexAgreementSentence}</span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-mono font-medium tabular-nums">{dexPriceLabel}</span>
              <span className={cn(DOT_SEPARATED_ROW_CLASS, "text-xs text-muted-foreground")} title={dexDeviationTitle}>{dexDetail}</span>
            </div>
          </div>
        ) : null}

        {sourceProvenanceUnread ? null : (
          <div className="space-y-3">
            {/* In the main column the few sources flow inline: a column grid
                left blank columns on wide cards and a lone last item on phones. */}
            <SourceGroup
              title={SOURCE_STATUS_TEXT.used}
              sources={usedSources}
              layoutClassName="flex flex-wrap gap-x-5"
            />
            <SourceGroup
              title={SOURCE_STATUS_TEXT.available}
              sources={visibleAvailableSources}
              muted
              layoutClassName="flex flex-wrap gap-x-5"
            />
            {hiddenSourceCount > 0 || showAll ? (
              <button
                type="button"
                onClick={() => setShowAll(!showAll)}
                aria-expanded={showAll}
                className="pharos-focus-ring inline-flex min-h-9 items-center gap-1 rounded-md text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronDown
                  aria-hidden="true"
                  className={cn("h-3.5 w-3.5 transition-transform", showAll && "rotate-180")}
                />
                {showAll ? "Show fewer sources" : `Show ${hiddenSourceCount} more checked ${hiddenSourceCount === 1 ? "source" : "sources"}`}
              </button>
            ) : null}
            {noFeedLine ? <p className="text-xs text-muted-foreground">{noFeedLine}</p> : null}
          </div>
        )}

        <EvidenceFooter topic="priceTransparency" />
    </DetailModuleCard>
  );
}
