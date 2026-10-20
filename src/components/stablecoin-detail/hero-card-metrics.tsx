"use client";

import { FigureLeadText } from "./figure-lead-text";
import {
  formatBps,
  formatCurrency,
  formatNativePrice,
  formatPercentChange,
  formatSupply,
  pegCurrencySymbol,
} from "@shared/lib/format";
import type { StablecoinMeta } from "@shared/types";
import type { DetailQuote } from "@/lib/stablecoin-detail-view-model-types";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import type { HeroCardViewModel } from "@/lib/stablecoin-detail-view-model";
import { confidenceClass } from "@/lib/confidence";
import { deviationColorClass } from "@/lib/severity-colors";
import { DIRECTION_TONE_CLASSES } from "@shared/lib/classification";

/** Label class shared by every hero metric cell — one casing across breakpoints. */
const HERO_METRIC_LABEL_CLASS = "text-sm font-medium text-muted-foreground";

/**
 * Hero price string. Several peg symbols have no glyph in the mono face — CHF's
 * `₣` renders as a broken box — so any non-dollar peg carries its ISO code as a
 * prefix instead of its symbol. Dollar-denominated pegs keep `$`.
 */
export function formatHeroNativePrice(
  usdPrice: number | null | undefined,
  pegCurrency: string,
  pegRef: number | null,
  decimals?: number,
): string {
  const formatted = formatNativePrice(usdPrice, pegCurrency, pegRef, decimals);
  const symbol = pegCurrencySymbol(pegCurrency);
  if (symbol === "$" || !formatted.startsWith(symbol)) return formatted;
  return `${pegCurrency} ${formatted.slice(symbol.length)}`;
}

export interface HeroTertiaryMetricConfig {
  key: string;
  label: React.ReactNode;
  mobileLabel?: React.ReactNode;
  value: React.ReactNode;
  subValue?: string;
  colorClass?: string;
  accentClass?: string;
}

export interface HeroSignalRailItem {
  key: string;
  label: string;
  primary: string;
  secondary: string | null;
  href: string;
  colorClass: string;
}
export type HeroSupplyFields = Pick<HeroCardViewModel["market"], "supply" | "supplyTrend">;

type HeroMetricVariant = "cell" | "card";

function formatTrendPercent(current: number | null, previous: number | null): string {
  return current == null || previous == null ? "—" : formatPercentChange(current, previous);
}

function formatSupplyRestoredAsOf(coinData?: Pick<DetailQuote, "supplyRestored" | "supplyObservedAt">): string | null {
  return coinData?.supplyRestored === true && coinData.supplyObservedAt != null
    ? new Date(coinData.supplyObservedAt * 1000).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      })
    : null;
}

function SupplyRestoredNotice({ coinData, className }: { coinData?: Pick<DetailQuote, "supplyRestored" | "supplyObservedAt">; className: string }) {
  if (coinData?.supplyRestored !== true) return null;
  const supplyRestoredAsOf = formatSupplyRestoredAsOf(coinData);
  return <p className={className}>Stale supply{supplyRestoredAsOf ? ` · as of ${supplyRestoredAsOf}` : ""}</p>;
}

function CompactMetricCell({
  label,
  children,
  subline,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  subline?: React.ReactNode;
}) {
  return (
    <div className="min-h-[8.25rem] border-b border-border/40 px-5 py-5 last:border-b-0 sm:px-6 lg:border-b-0 lg:border-r lg:last:border-r-0">
      <p className={HERO_METRIC_LABEL_CLASS}>{label}</p>
      <div className="mt-3">{children}</div>
      {subline ? <div className="pharos-label mt-2">{subline}</div> : null}
    </div>
  );
}

function formatPriceReferenceLine({
  deviationBps,
  pegReferenceUnavailable,
  isNavToken,
}: {
  deviationBps: number | null;
  pegReferenceUnavailable: boolean;
  isNavToken: boolean;
}): string {
  if (pegReferenceUnavailable) return "Peg reference unavailable";
  if (isNavToken) return "NAV token — no fixed peg";
  return deviationBps == null ? "N/A" : formatBps(deviationBps);
}

export function HeroPriceMetric({
  variant,
  coin,
  coinData,
  price: { pegRef, deviationBps, pegReferenceUnavailable, isNavToken, limitedDepegCoverageNote },
}: HeroPriceMetricProps & { variant: HeroMetricVariant }) {
  const observed = isObservedPrice(coinData) && typeof coinData.price === "number"
    && Number.isFinite(coinData.price) && coinData.price > 0;
  const price = formatHeroNativePrice(observed ? coinData.price : null, coin.flags.pegCurrency ?? "USD", pegRef);
  // A frozen archive's price is its last observation, not a live peg reading.
  const frozenAt = coin.status === "frozen" ? coin.frozenAt ?? null : null;
  const referenceLine = !observed
    ? "Observed price unavailable"
    : frozenAt
      ? `Last observed · ${frozenAt}`
      : formatPriceReferenceLine({ deviationBps, pegReferenceUnavailable, isNavToken });
  const referenceClass = !observed || pegReferenceUnavailable || frozenAt
    ? "text-muted-foreground"
    : isNavToken
      ? DIRECTION_TONE_CLASSES.up
      : deviationBps == null
        ? "text-muted-foreground"
        : deviationColorClass(Math.abs(deviationBps));

  if (variant === "cell") {
    return (
      <CompactMetricCell
        label={`Price${coin.flags.pegCurrency !== "USD" ? ` (${coin.flags.pegCurrency})` : ""}`}
        subline={<span className={referenceClass}><FigureLeadText text={referenceLine} /></span>}
      >
        <p
          className={`pharos-numeric text-[2rem] font-semibold leading-none tracking-tight ${confidenceClass(observed ? coinData.priceConfidence : null)}`}
        >
          {price}
        </p>
        {limitedDepegCoverageNote ? (
          <p className="mt-2 max-w-[24ch] text-2xs leading-snug text-state-warn">
            {limitedDepegCoverageNote}
          </p>
        ) : null}
      </CompactMetricCell>
    );
  }

  return (
    <div className="min-h-36 min-w-0 rounded-xl border border-border/60 bg-background/45 px-3 py-2.5">
      <p className={HERO_METRIC_LABEL_CLASS}>
        Price{coin.flags.pegCurrency !== "USD" ? ` (${coin.flags.pegCurrency})` : ""}
      </p>
      <p className={`break-words font-extrabold pharos-numeric tracking-tight ${confidenceClass(observed ? coinData.priceConfidence : null)} text-xl`}>
        {price}
      </p>
      <p className={`mt-1 min-h-12 text-xs ${referenceClass}`}>{referenceLine}</p>
      {limitedDepegCoverageNote ? (
        <p className="mt-1 text-2xs text-state-warn">{limitedDepegCoverageNote}</p>
      ) : null}
    </div>
  );
}

interface HeroMarketCapMetricProps {
  variant: HeroMetricVariant;
  coin: StablecoinMeta;
  coinData?: Pick<DetailQuote, "supplyRestored" | "supplyObservedAt">;
  mcap: number | null;
  safePrevDay: number | null;
  prevDayTrendClass: string;
}

function HeroMarketCapMetric({
  variant,
  coin,
  coinData,
  mcap,
  safePrevDay,
  prevDayTrendClass,
}: HeroMarketCapMetricProps) {
  if (variant === "cell") {
    return (
      <CompactMetricCell
        label="Market Cap"
        subline={
          <span className={`pharos-numeric ${prevDayTrendClass}`}>
            {formatTrendPercent(mcap, safePrevDay)} <span className="text-muted-foreground">24H</span>
          </span>
        }
      >
        <p className="pharos-numeric text-[2rem] font-semibold leading-none tracking-tight">{mcap != null ? formatCurrency(mcap) : "—"}</p>
        {coin.flags.pegCurrency !== "USD" ? (
          <p className="mt-2 text-2xs text-muted-foreground">USD-normalized</p>
        ) : null}
        <SupplyRestoredNotice coinData={coinData} className="mt-2 text-2xs text-state-warn" />
      </CompactMetricCell>
    );
  }

  return (
    <div className="min-h-36 min-w-0 rounded-xl border border-border/60 bg-background/45 px-3 py-2.5">
      <p className={HERO_METRIC_LABEL_CLASS}>Market Cap</p>
      <p className="font-bold pharos-numeric tracking-tight text-lg">{mcap != null ? formatCurrency(mcap) : "—"}</p>
      {coin.flags.pegCurrency !== "USD" && <p className="mt-0.5 text-2xs text-muted-foreground">USD-normalized</p>}
      <SupplyRestoredNotice coinData={coinData} className="mt-0.5 text-2xs text-state-warn" />
      <p className={`mt-1 text-xs pharos-numeric ${prevDayTrendClass}`}>
        {formatTrendPercent(mcap, safePrevDay)} <span className="text-muted-foreground">24h</span>
      </p>
    </div>
  );
}

export function HeroSupplyMetric({
  variant = "cell",
  supply,
  supplyTrend: { current, safePrevWeek, prevWeekTrendClass, hasPrevMonth, safePrevMonth, prevMonthTrendClass },
  coinSymbol,
}: HeroSupplyFields & { coinSymbol: string; variant?: HeroMetricVariant }) {
  if (variant === "cell") {
    return (
      <CompactMetricCell
        label="Supply"
        subline={
          <span className="pharos-numeric">
            <span className={prevWeekTrendClass}>{formatTrendPercent(current, safePrevWeek)}</span>
            <span className="text-muted-foreground"> 7D</span>
            {hasPrevMonth ? (
              <>
                <span className="text-muted-foreground"> · </span>
                <span className={prevMonthTrendClass}>{formatTrendPercent(current, safePrevMonth)}</span>
                <span className="text-muted-foreground"> 30D</span>
              </>
            ) : null}
          </span>
        }
      >
        <p className="pharos-numeric text-[2rem] font-semibold leading-none tracking-tight">
          {supply != null ? formatSupply(supply) : "—"}{" "}
          <span className="text-sm text-muted-foreground">{coinSymbol}</span>
        </p>
      </CompactMetricCell>
    );
  }

  return (
    <div className="mt-3 min-h-24 rounded-lg border border-border/40 bg-background/30 px-3 py-2">
      <div className="flex min-h-20 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div>
          <p className={HERO_METRIC_LABEL_CLASS}>Supply</p>
          <p className="text-base font-bold pharos-numeric">
            {supply != null ? formatSupply(supply) : "—"}{" "}
            <span className="text-xs text-muted-foreground">{coinSymbol}</span>
          </p>
        </div>
        <div className="text-right">
          <p className={`text-xs pharos-numeric ${prevWeekTrendClass}`}>
            {formatTrendPercent(current, safePrevWeek)} <span className="text-muted-foreground">7d</span>
          </p>
          {hasPrevMonth && (
            <p className={`text-xs pharos-numeric ${prevMonthTrendClass}`}>
              {formatTrendPercent(current, safePrevMonth)} <span className="text-muted-foreground">30d</span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function HeroCompactTertiaryCell({ metric }: { metric: HeroTertiaryMetricConfig }) {
  return (
    <CompactMetricCell
      label={metric.label}
      subline={metric.subValue ? <span><FigureLeadText text={metric.subValue} /></span> : null}
    >
      <p
        className={`pharos-numeric text-[2rem] font-semibold leading-none tracking-tight ${metric.colorClass ?? "text-foreground"}`}
      >
        {metric.value}
      </p>
    </CompactMetricCell>
  );
}
interface HeroMarketMetricGridProps extends HeroPriceMetricProps {
  variant: HeroMetricVariant;
  market: HeroCardViewModel["market"];
  tertiaryMetric?: HeroTertiaryMetricConfig;
  coinData: HeroPriceMetricProps["coinData"] & Pick<DetailQuote, "supplyRestored" | "supplyObservedAt">;
}

export function HeroMarketMetricGrid({
  variant,
  coin,
  coinData,
  price,
  market,
  tertiaryMetric,
}: HeroMarketMetricGridProps) {
  const supplyFields: HeroSupplyFields = { supply: market.supply, supplyTrend: market.supplyTrend };

  if (variant === "card") {
    return (
      <>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <HeroPriceMetric variant="card" coin={coin} coinData={coinData} price={price} />
          <HeroMarketCapMetric
            variant="card"
            coin={coin}
            coinData={coinData}
            mcap={market.mcap}
            safePrevDay={market.safePrevDay}
            prevDayTrendClass={market.prevDayTrendClass}
          />
        </div>
        <HeroSupplyMetric variant="card" coinSymbol={coin.symbol} {...supplyFields} />
      </>
    );
  }

  return (
    <div className={`grid lg:grid-cols-3 ${tertiaryMetric ? "xl:grid-cols-4" : ""}`}>
      <HeroPriceMetric variant="cell" coin={coin} coinData={coinData} price={price} />
      <HeroMarketCapMetric
        variant="cell"
        coin={coin}
        coinData={coinData}
        mcap={market.mcap}
        safePrevDay={market.safePrevDay}
        prevDayTrendClass={market.prevDayTrendClass}
      />
      <HeroSupplyMetric variant="cell" coinSymbol={coin.symbol} {...supplyFields} />
      {tertiaryMetric ? <HeroCompactTertiaryCell metric={tertiaryMetric} /> : null}
    </div>
  );
}

function MetricChip({
  label,
  value,
  subValue,
  colorClass = "text-foreground",
  accentClass,
  mobileHideSub = false,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  subValue?: string;
  colorClass?: string;
  accentClass?: string;
  mobileHideSub?: boolean;
}) {
  const isEmpty = value === "—";

  return (
    // Passive stat chip — deliberately NOT .pharos-control-pill, which is
    // reserved for interactive controls; accentClass stays a data-driven
    // severity border (allowed carve-out).
    <div
      className={`rounded-lg border border-border/60 bg-background/45 grid min-h-20 w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-1.5 gap-y-1 px-2.5 py-1.5 ${accentClass ?? ""}`}
    >
      {label ? (
        <span className="pharos-label">{label}</span>
      ) : null}
      <span
        className={`text-lg font-bold pharos-numeric ${colorClass}`}
        aria-hidden={isEmpty ? "true" : undefined}
      >
        {value}
      </span>
      {isEmpty && <span className="sr-only">data unavailable</span>}
      {subValue && !mobileHideSub && (
        <span className="col-span-2 text-2xs text-muted-foreground">{subValue}</span>
      )}
    </div>
  );
}

export function HeroTertiaryMetrics({
  metrics,
  activeDepeg,
}: {
  metrics: HeroTertiaryMetricConfig[];
  activeDepeg: boolean;
}) {
  const regularMetrics = metrics.filter((metric) => metric.key !== "performance-vs-usd");
  const performanceMetric = metrics.find((metric) => metric.key === "performance-vs-usd");

  return (
    <>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {regularMetrics.map((metric) => (
          <MetricChip
            key={metric.key}
            label={metric.mobileLabel ?? metric.label}
            value={metric.value}
            subValue={metric.subValue}
            colorClass={metric.colorClass}
            accentClass={metric.accentClass}
            mobileHideSub={metric.key === "excess-yield"}
          />
        ))}
      </div>
      {performanceMetric ? (
        <div className="mt-2">
          <MetricChip
            label={performanceMetric.mobileLabel ?? performanceMetric.label}
            value={performanceMetric.value}
            subValue={performanceMetric.subValue}
            colorClass={performanceMetric.colorClass}
            accentClass={performanceMetric.accentClass}
            mobileHideSub
          />
        </div>
      ) : null}

      {activeDepeg && (
        <div className="mt-3 rounded-lg border border-state-danger-solid/20 bg-state-danger-solid/8 px-3 py-2 text-xs text-state-danger">
          Active depeg detected
        </div>
      )}
    </>
  );
}

interface HeroPriceMetricProps {
  coin: StablecoinMeta;
  coinData: Pick<DetailQuote, "price" | "priceSource" | "priceObservedAtMode" | "priceConfidence">;
  price: HeroCardViewModel["price"];
}

