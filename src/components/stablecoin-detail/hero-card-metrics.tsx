"use client";

import {
  formatBps,
  formatCurrency,
  formatNativePrice,
  formatPercentChange,
  formatSupply,
  pegCurrencySymbol,
} from "@shared/lib/format";
import type { StablecoinData, StablecoinMeta } from "@shared/types";
import type { HeroCardViewModel } from "@/lib/stablecoin-detail-view-model";
import { confidenceClass } from "@/lib/confidence";
import { deviationColorClass } from "@/lib/severity-colors";

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

function formatTrendPercent(current: number, previous: number | null): string {
  return previous == null ? "—" : formatPercentChange(current, previous);
}

function formatSupplyRestoredAsOf(coinData?: StablecoinData): string | null {
  return coinData?.supplyRestored === true && coinData.supplyObservedAt != null
    ? new Date(coinData.supplyObservedAt * 1000).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      })
    : null;
}

function SupplyRestoredNotice({ coinData, className }: { coinData?: StablecoinData; className: string }) {
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
      {subline ? <div className="mt-2 text-xs uppercase tracking-[0.18em] text-muted-foreground">{subline}</div> : null}
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

export function HeroCompactPriceCell({
  coin,
  coinData,
  price: { pegRef, deviationBps, pegReferenceUnavailable, isNavToken, limitedDepegCoverageNote },
}: HeroPriceCardProps) {
  const price = formatHeroNativePrice(coinData.price, coin.flags.pegCurrency ?? "USD", pegRef);
  const deviationLabel = formatPriceReferenceLine({
    deviationBps,
    pegReferenceUnavailable,
    isNavToken,
  }).toUpperCase();
  return (
    <CompactMetricCell
      label={`Price${coin.flags.pegCurrency !== "USD" ? ` (${coin.flags.pegCurrency})` : ""}`}
      subline={
        <span
          className={
            pegReferenceUnavailable
              ? "text-muted-foreground"
              : isNavToken
                ? "text-green-700 dark:text-green-400"
                : deviationBps == null
                  ? "text-muted-foreground"
                  : deviationColorClass(Math.abs(deviationBps))
          }
        >
          {deviationLabel}
        </span>
      }
    >
      <p
        className={`pharos-numeric text-[2rem] font-semibold leading-none tracking-tight ${confidenceClass(coinData.priceConfidence)}`}
      >
        {price}
      </p>
      {limitedDepegCoverageNote ? (
        <p className="mt-2 max-w-[24ch] text-[11px] leading-snug text-amber-700 dark:text-amber-400">
          {limitedDepegCoverageNote}
        </p>
      ) : null}
    </CompactMetricCell>
  );
}

export function HeroCompactMarketCapCell({
  coin,
  coinData,
  mcap,
  safePrevDay,
  prevDayTrendClass,
}: {
  coin: StablecoinMeta;
  coinData?: StablecoinData;
  mcap: number;
  safePrevDay: number | null;
  prevDayTrendClass: string;
}) {
  return (
    <CompactMetricCell
      label="Market Cap"
      subline={
        <span className={`pharos-numeric ${prevDayTrendClass}`}>
          {formatTrendPercent(mcap, safePrevDay)} <span className="text-muted-foreground">24H</span>
        </span>
      }
    >
      <p className="pharos-numeric text-[2rem] font-semibold leading-none tracking-tight">{formatCurrency(mcap)}</p>
      {coin.flags.pegCurrency !== "USD" ? (
        <p className="mt-2 text-[11px] text-muted-foreground">USD-normalized</p>
      ) : null}
      <SupplyRestoredNotice coinData={coinData} className="mt-2 text-[11px] text-amber-700 dark:text-amber-400" />
    </CompactMetricCell>
  );
}

export function HeroCompactSupplyCell({
  supply,
  coinSymbol,
  mcap,
  safePrevWeek,
  prevWeekTrendClass,
  hasPrevMonth,
  safePrevMonth,
  prevMonthTrendClass,
}: {
  supply: number | null;
  coinSymbol: string;
  mcap: number;
  safePrevWeek: number | null;
  prevWeekTrendClass: string;
  hasPrevMonth: boolean;
  safePrevMonth: number | null;
  prevMonthTrendClass: string;
}) {
  return (
    <CompactMetricCell
      label="Supply"
      subline={
        <span className="pharos-numeric">
          <span className={prevWeekTrendClass}>{formatTrendPercent(mcap, safePrevWeek)}</span>
          <span className="text-muted-foreground"> 7D</span>
          {hasPrevMonth ? (
            <>
              <span className="text-muted-foreground"> · </span>
              <span className={prevMonthTrendClass}>{formatTrendPercent(mcap, safePrevMonth)}</span>
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

export function HeroCompactTertiaryCell({ metric }: { metric: HeroTertiaryMetricConfig }) {
  return (
    <CompactMetricCell
      label={metric.label}
      subline={metric.subValue ? <span>{metric.subValue.toUpperCase()}</span> : null}
    >
      <p
        className={`pharos-numeric text-[2rem] font-semibold leading-none tracking-tight ${metric.colorClass ?? "text-foreground"}`}
      >
        {metric.value}
      </p>
    </CompactMetricCell>
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
      className={`rounded-lg border border-border/60 bg-background/45 flex w-full min-w-0 items-center justify-start gap-1.5 px-2.5 py-1.5 ${accentClass ?? ""}`}
    >
      {label ? (
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
      ) : null}
      <span
        className={`text-lg font-bold pharos-numeric ${colorClass}`}
        aria-hidden={isEmpty ? "true" : undefined}
      >
        {value}
      </span>
      {isEmpty && <span className="sr-only">data unavailable</span>}
      {subValue && !mobileHideSub && (
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">{subValue}</span>
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
        <div className="mt-3 rounded-lg border border-red-500/20 bg-red-500/8 px-3 py-2 text-xs text-red-700 dark:text-red-400">
          Active depeg detected
        </div>
      )}
    </>
  );
}

interface HeroPriceCardProps {
  coin: StablecoinMeta;
  coinData: StablecoinData;
  price: HeroCardViewModel["price"];
}

export function HeroPriceCard({
  coin,
  coinData,
  price: { pegRef, deviationBps, pegReferenceUnavailable, isNavToken, limitedDepegCoverageNote },
}: HeroPriceCardProps) {
  // Full 4-decimal precision on every tier: at 3 decimals a stablecoin price
  // reads as a ~10bps deviation that the peg line right below contradicts.
  const price = formatHeroNativePrice(coinData.price, coin.flags.pegCurrency ?? "USD", pegRef);

  return (
    <div className="rounded-xl border border-border/60 bg-background/45 px-3 py-2.5">
      <p className={HERO_METRIC_LABEL_CLASS}>
        Price{coin.flags.pegCurrency !== "USD" ? ` (${coin.flags.pegCurrency})` : ""}
      </p>
      <p className={`font-extrabold pharos-numeric tracking-tight ${confidenceClass(coinData.priceConfidence)} text-xl`}>
        {price}
      </p>
      <p
        className={`pharos-numeric mt-1 text-xs ${
          pegReferenceUnavailable
            ? "text-muted-foreground"
            : isNavToken
              ? "text-green-700 dark:text-green-400"
              : deviationBps == null
                ? "text-muted-foreground"
                : deviationColorClass(Math.abs(deviationBps))
        }`}
      >
        {formatPriceReferenceLine({ deviationBps, pegReferenceUnavailable, isNavToken })}
      </p>
      {limitedDepegCoverageNote ? (
        <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">{limitedDepegCoverageNote}</p>
      ) : null}
    </div>
  );
}

export function HeroMarketCapCard({
  coin,
  coinData,
  mcap,
  safePrevDay,
  prevDayTrendClass,
}: {
  coin: StablecoinMeta;
  coinData?: StablecoinData;
  mcap: number;
  safePrevDay: number | null;
  prevDayTrendClass: string;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/45 px-3 py-2.5">
      <p className={HERO_METRIC_LABEL_CLASS}>Market Cap</p>
      <p className="font-bold pharos-numeric tracking-tight text-lg">{formatCurrency(mcap)}</p>
      {coin.flags.pegCurrency !== "USD" && <p className="mt-0.5 text-[11px] text-muted-foreground">USD-normalized</p>}
      <SupplyRestoredNotice coinData={coinData} className="mt-0.5 text-[11px] text-amber-700 dark:text-amber-400" />
      <p className={`mt-1 text-xs pharos-numeric ${prevDayTrendClass}`}>
        {formatTrendPercent(mcap, safePrevDay)} <span className="text-muted-foreground">24h</span>
      </p>
    </div>
  );
}

export function HeroSupplyCard({
  supply,
  coinSymbol,
  mcap,
  safePrevWeek,
  prevWeekTrendClass,
  hasPrevMonth,
  safePrevMonth,
  prevMonthTrendClass,
}: {
  supply: number | null;
  coinSymbol: string;
  mcap: number;
  safePrevWeek: number | null;
  prevWeekTrendClass: string;
  hasPrevMonth: boolean;
  safePrevMonth: number | null;
  prevMonthTrendClass: string;
}) {
  return (
    <div className="mt-3 rounded-lg border border-border/40 bg-background/30 px-3 py-2">
      <div className="flex items-center justify-between">
        <div>
          <p className={HERO_METRIC_LABEL_CLASS}>Supply</p>
          <p className="text-base font-bold pharos-numeric">
            {supply != null ? formatSupply(supply) : "—"}{" "}
            <span className="text-xs text-muted-foreground">{coinSymbol}</span>
          </p>
        </div>
        <div className="text-right">
          <p className={`text-xs pharos-numeric ${prevWeekTrendClass}`}>
            {formatTrendPercent(mcap, safePrevWeek)} <span className="text-muted-foreground">7d</span>
          </p>
          {hasPrevMonth && (
            <p className={`text-xs pharos-numeric ${prevMonthTrendClass}`}>
              {formatTrendPercent(mcap, safePrevMonth)} <span className="text-muted-foreground">30d</span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
