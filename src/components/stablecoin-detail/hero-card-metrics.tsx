"use client";

import type { ReactNode } from "react";
import {
  formatCurrency,
  formatNativePrice,
  formatPegDeviation,
  formatPercentChange,
  formatSupply,
} from "@shared/lib/format";
import type { StablecoinData, StablecoinMeta } from "@shared/types";
import type { HeroCardViewModel } from "@/lib/stablecoin-detail-view-model";
import { PegGauge } from "@/components/peg-gauge";
import { MethodologyLinkBadge } from "@/components/methodology-link-badge";
import type { MetricKey } from "@/lib/methodology-anchors";
import { confidenceClass } from "@/lib/confidence";
import { deviationColorClass } from "@/lib/severity-colors";

/**
 * Map a tertiary-metric `key` to a methodology anchor. Metrics without a
 * mapping (e.g. excess-yield, performance-vs-usd, blacklistable) skip the
 * (method) badge — those have their own contextual hint links elsewhere.
 */
const METRIC_TO_METHODOLOGY: Record<string, MetricKey | undefined> = {
  dews: "dews",
  "peg-score": "peg-score",
  liquidity: "liquidity-score",
};

export interface HeroTertiaryMetricConfig {
  key: string;
  label: React.ReactNode;
  mobileLabel?: React.ReactNode;
  value: React.ReactNode;
  subValue?: string;
  colorClass?: string;
  accentClass?: string;
  /** Extra classes on the rendered chip (e.g. xl:hidden when the metric is
   *  promoted to a KPI tile at xl per the Figma coin template). */
  className?: string;
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
      <p className="text-sm font-medium text-muted-foreground">{label}</p>
      <div className="mt-3">{children}</div>
      {subline ? <div className="mt-2 text-xs uppercase tracking-[0.18em] text-muted-foreground">{subline}</div> : null}
    </div>
  );
}

export function HeroCompactPriceCell({
  coin,
  coinData,
  price: { pegRef, deviationBps, pegReferenceUnavailable, isNavToken, limitedDepegCoverageNote },
}: HeroPriceCardProps) {
  const price = formatNativePrice(coinData.price, coin.flags.pegCurrency ?? "USD", pegRef);
  const deviationLabel = pegReferenceUnavailable
    ? "Peg reference unavailable"
    : formatPegDeviation(coinData.price, pegRef).toUpperCase();
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
  metricKey,
  label,
  value,
  subValue,
  colorClass = "text-foreground",
  accentClass,
  mobile = false,
  mobileFull = false,
  mobileHideSub = false,
  className,
}: {
  metricKey?: string;
  label: React.ReactNode;
  value: React.ReactNode;
  subValue?: string;
  colorClass?: string;
  accentClass?: string;
  mobile?: boolean;
  mobileFull?: boolean;
  mobileHideSub?: boolean;
  className?: string;
}) {
  const isEmpty = value === "—";
  const methodologyMetric = metricKey ? METRIC_TO_METHODOLOGY[metricKey] : undefined;

  return (
    // Passive stat chip — deliberately NOT .pharos-control-pill, which is
    // reserved for interactive controls; accentClass stays a data-driven
    // severity border (allowed carve-out).
    <div
      className={`rounded-lg border border-border/60 bg-background/45 ${
        mobile
          ? `flex w-full min-w-0 items-center justify-start gap-1.5 px-2.5 py-1.5 ${mobileFull ? "col-span-2" : ""}`
          : "flex items-center gap-2 px-3 py-2"
      } ${accentClass ?? ""} ${className ?? ""}`}
    >
      {label ? (
        <span
          className={`${mobile ? "text-[10px]" : "text-[11px]"} font-medium uppercase tracking-wider text-muted-foreground`}
        >
          {label}
        </span>
      ) : null}
      <span
        className={`${mobile ? "text-lg" : "text-base"} font-bold pharos-numeric ${colorClass}`}
        aria-hidden={isEmpty ? "true" : undefined}
      >
        {value}
      </span>
      {isEmpty && <span className="sr-only">data unavailable</span>}
      {subValue && !(mobile && mobileHideSub) && (
        <span className={`${mobile ? "min-w-0 truncate text-[11px]" : "text-xs"} text-muted-foreground`}>
          {subValue}
        </span>
      )}
      {methodologyMetric && !isEmpty && !mobile ? <MethodologyLinkBadge metric={methodologyMetric} /> : null}
    </div>
  );
}

export function HeroTertiaryMetrics({
  metrics,
  earlyPegScore,
  trackingSpanDays,
  activeDepeg,
  mobile = false,
  trailing,
}: {
  metrics: HeroTertiaryMetricConfig[];
  earlyPegScore: boolean;
  trackingSpanDays: number;
  activeDepeg: boolean;
  mobile?: boolean;
  trailing?: ReactNode;
}) {
  if (mobile) {
    const regularMetrics = metrics.filter((metric) => metric.key !== "performance-vs-usd");
    const performanceMetric = metrics.find((metric) => metric.key === "performance-vs-usd");

    return (
      <>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {regularMetrics.map((metric) => (
            <MetricChip
              key={metric.key}
              metricKey={metric.key}
              label={metric.mobileLabel ?? metric.label}
              value={metric.value}
              subValue={metric.subValue}
              colorClass={metric.colorClass}
              accentClass={metric.accentClass}
              mobile
              mobileHideSub={metric.key === "excess-yield"}
            />
          ))}
        </div>
        {performanceMetric ? (
          <div className="mt-2">
            <MetricChip
              metricKey={performanceMetric.key}
              label={performanceMetric.mobileLabel ?? performanceMetric.label}
              value={performanceMetric.value}
              subValue={performanceMetric.subValue}
              colorClass={performanceMetric.colorClass}
              accentClass={performanceMetric.accentClass}
              mobile
              mobileHideSub
            />
          </div>
        ) : null}
        {trailing ? <div className="mt-2 flex flex-wrap items-center gap-2">{trailing}</div> : null}

        {activeDepeg && (
          <div className="mt-3 rounded-lg border border-red-500/20 bg-red-500/8 px-3 py-2 text-xs text-red-700 dark:text-red-400">
            Active depeg detected
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        {metrics.map((metric) => (
          <MetricChip
            key={metric.key}
            metricKey={metric.key}
            label={metric.label}
            value={metric.value}
            subValue={metric.subValue}
            colorClass={metric.colorClass}
            accentClass={metric.accentClass}
            className={metric.className}
          />
        ))}
        {trailing}
        {earlyPegScore && (
          <span className="text-xs text-amber-600 dark:text-amber-400">
            Early peg score · {trackingSpanDays}d tracked
          </span>
        )}
      </div>

      {activeDepeg && (
        <div className="mt-3 rounded-lg border border-red-500/20 bg-red-500/8 px-4 py-2.5 text-sm text-red-700 dark:text-red-400">
          Active depeg detected — view details in Depeg History
        </div>
      )}
    </>
  );
}

interface HeroPriceCardProps {
  coin: StablecoinMeta;
  coinData: StablecoinData;
  price: HeroCardViewModel["price"];
  mobile?: boolean;
}

export function HeroPriceCard({
  coin,
  coinData,
  price: { pegRef, gaugeDeviationBps, deviationBps, pegReferenceUnavailable, isNavToken, limitedDepegCoverageNote },
  mobile = false,
}: HeroPriceCardProps) {
  const showGauge = coinData.price != null && pegRef > 0 && !pegReferenceUnavailable;
  // Full 4-decimal precision on every tier: at 3 decimals a stablecoin price
  // reads as a ~10bps deviation that the peg line right below contradicts.
  const price = formatNativePrice(coinData.price, coin.flags.pegCurrency ?? "USD", pegRef);

  return (
    <div
      className={
        mobile
          ? "rounded-xl border border-border/60 bg-background/45 px-3 py-2.5"
          : "rounded-xl bg-background/30 px-4 py-3"
      }
    >
      <div className={`flex items-center ${mobile ? "gap-2" : "gap-3"}`}>
        {showGauge && <PegGauge deviationBps={gaugeDeviationBps} className={mobile ? "w-12" : "w-16 xl:w-20"} />}
        <div>
          <p className="pharos-kicker">Price{coin.flags.pegCurrency !== "USD" ? ` (${coin.flags.pegCurrency})` : ""}</p>
          <p
            className={`font-extrabold pharos-numeric tracking-tight ${confidenceClass(coinData.priceConfidence)} ${
              mobile ? "text-xl" : "text-2xl xl:text-3xl"
            }`}
          >
            {price}
          </p>
          <p
            className={`pharos-numeric ${mobile ? "mt-1 text-xs" : "mt-0.5 text-xs"} ${
              pegReferenceUnavailable
                ? "text-muted-foreground"
                : isNavToken
                  ? "text-green-700 dark:text-green-400"
                  : deviationColorClass(Math.abs(deviationBps))
            }`}
          >
            {pegReferenceUnavailable ? "Peg reference unavailable" : formatPegDeviation(coinData.price, pegRef)}
          </p>
          {limitedDepegCoverageNote ? (
            <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">{limitedDepegCoverageNote}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function HeroMarketCapCard({
  coin,
  coinData,
  mcap,
  safePrevDay,
  prevDayTrendClass,
  mobile = false,
}: {
  coin: StablecoinMeta;
  coinData?: StablecoinData;
  mcap: number;
  safePrevDay: number | null;
  prevDayTrendClass: string;
  mobile?: boolean;
}) {
  return (
    <div
      className={
        mobile
          ? "rounded-xl border border-border/60 bg-background/45 px-3 py-2.5"
          : "rounded-xl bg-background/30 px-4 py-3"
      }
    >
      <p className="pharos-kicker">Market Cap</p>
      <p className={`font-bold pharos-numeric tracking-tight ${mobile ? "text-lg" : "text-2xl"}`}>
        {formatCurrency(mcap)}
      </p>
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
  mobile = false,
}: {
  supply: number | null;
  coinSymbol: string;
  mcap: number;
  safePrevWeek: number | null;
  prevWeekTrendClass: string;
  hasPrevMonth: boolean;
  safePrevMonth: number | null;
  prevMonthTrendClass: string;
  mobile?: boolean;
}) {
  if (mobile) {
    return (
      <div className="mt-3 rounded-lg border border-border/40 bg-background/30 px-3 py-2">
        <div className="flex items-center justify-between">
          <div>
            <p className="pharos-kicker">Supply</p>
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

  return (
    <div className="rounded-xl bg-background/30 px-4 py-3">
      <p className="pharos-kicker">Supply</p>
      <p className="text-2xl font-bold pharos-numeric tracking-tight">
        {supply != null ? formatSupply(supply) : "—"}{" "}
        <span className="text-sm text-muted-foreground">{coinSymbol}</span>
      </p>
      <p className="mt-1 whitespace-nowrap text-xs pharos-numeric">
        <span className={prevWeekTrendClass}>{formatTrendPercent(mcap, safePrevWeek)}</span>
        <span className="text-muted-foreground"> 7d</span>
        {hasPrevMonth && (
          <>
            <span className="text-muted-foreground"> · </span>
            <span className={prevMonthTrendClass}>{formatTrendPercent(mcap, safePrevMonth)}</span>
            <span className="text-muted-foreground"> 30d</span>
          </>
        )}
      </p>
    </div>
  );
}
