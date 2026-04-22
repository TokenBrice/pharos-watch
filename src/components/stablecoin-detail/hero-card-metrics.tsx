"use client";

import Link from "next/link";
import {
  formatCurrency,
  formatNativePrice,
  formatPegDeviation,
  formatPercentChange,
  formatSupply,
} from "@shared/lib/format";
import type {
  Infrastructure,
  StablecoinData,
  StablecoinMeta,
} from "@shared/types";
import { PegGauge } from "@/components/peg-gauge";
import { confidenceClass } from "@/lib/confidence";
import { deviationColorClass } from "@/lib/severity-colors";
import { InfrastructureBadge } from "./hero-card-identity";

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

function MetricChip({
  label,
  value,
  subValue,
  colorClass = "text-foreground",
  accentClass,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  subValue?: string;
  colorClass?: string;
  accentClass?: string;
}) {
  const isEmpty = value === "—";

  return (
    <div
      className={`flex items-center gap-2 rounded-lg border border-border/40 bg-background/40 px-2.5 py-1.5 ${accentClass ?? ""}`}
    >
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span
        className={`text-base font-bold font-mono ${colorClass}`}
        aria-hidden={isEmpty ? "true" : undefined}
      >
        {value}
      </span>
      {isEmpty && <span className="sr-only">data unavailable</span>}
      {subValue && <span className="text-xs text-muted-foreground">{subValue}</span>}
    </div>
  );
}

export function HeroTertiaryMetrics({
  metrics,
  chainCount,
  infrastructures,
  earlyPegScore,
  trackingSpanDays,
  activeDepeg,
  mobile = false,
}: {
  metrics: HeroTertiaryMetricConfig[];
  chainCount: number;
  infrastructures: Infrastructure[];
  earlyPegScore: boolean;
  trackingSpanDays: number;
  activeDepeg: boolean;
  mobile?: boolean;
}) {
  return (
    <>
      <div className={mobile ? "mt-3 flex flex-wrap gap-2" : "flex flex-wrap items-center gap-3"}>
        {metrics.map((metric) => (
          <MetricChip
            key={metric.key}
            label={mobile ? (metric.mobileLabel ?? metric.label) : metric.label}
            value={metric.value}
            subValue={metric.subValue}
            colorClass={metric.colorClass}
            accentClass={metric.accentClass}
          />
        ))}
        {mobile ? (
          <div className="flex items-center gap-1 rounded-lg border border-border/40 bg-background/30 px-2.5 py-1.5">
            <span className="text-[11px] text-muted-foreground">{chainCount} chains</span>
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-lg border border-border/40 bg-background/30 px-3 py-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Chains
            </span>
            <span className="text-base font-bold font-mono">{chainCount}</span>
          </div>
        )}
        {infrastructures.map((value) => (
          <InfrastructureBadge key={value} value={value} />
        ))}
        {!mobile && earlyPegScore && (
          <span className="text-xs text-amber-600 dark:text-amber-400">
            Early peg score · {trackingSpanDays}d tracked
          </span>
        )}
      </div>

      {activeDepeg && (
        <div
          className={
            mobile
              ? "mt-3 rounded-lg border border-red-500/20 bg-red-500/8 px-3 py-2 text-xs text-red-700 dark:text-red-400"
              : "rounded-lg border border-red-500/20 bg-red-500/8 px-4 py-2.5 text-sm text-red-700 dark:text-red-400"
          }
        >
          {mobile ? "Active depeg detected" : "Active depeg detected — view details in Depeg History"}
        </div>
      )}
    </>
  );
}

export function HeroSignalsRail({ items }: { items: HeroSignalRailItem[] }) {
  return (
    <nav aria-label="Hero signals" className="flex flex-col gap-1.5">
      {items.map((item, idx) => (
        <Link
          key={item.key}
          href={item.href}
          className={`pharos-focus-ring group flex items-baseline justify-between gap-3 rounded-lg border border-border/60 bg-background/45 px-3 py-2 transition-colors hover:border-border hover:bg-background/70 ${
            idx === 0 ? "py-2.5" : ""
          }`}
        >
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {item.label}
          </span>
          <span className="flex items-baseline gap-1.5">
            <span
              className={`font-mono tabular-nums ${
                idx === 0 ? "text-base font-extrabold" : "text-sm font-semibold"
              } ${item.colorClass}`}
              aria-hidden={item.primary === "—" ? "true" : undefined}
            >
              {item.primary}
            </span>
            {item.primary === "—" && <span className="sr-only">data unavailable</span>}
            {item.secondary ? (
              <span className="font-mono text-[10px] text-muted-foreground">{item.secondary}</span>
            ) : null}
          </span>
        </Link>
      ))}
    </nav>
  );
}

interface HeroPriceCardProps {
  coin: StablecoinMeta;
  coinData: StablecoinData;
  pegRef: number;
  gaugeDeviationBps: number;
  deviationBps: number;
  isNavToken: boolean;
  limitedDepegCoverageNote: string | null;
  mobile?: boolean;
}

export function HeroPriceCard({
  coin,
  coinData,
  pegRef,
  gaugeDeviationBps,
  deviationBps,
  isNavToken,
  limitedDepegCoverageNote,
  mobile = false,
}: HeroPriceCardProps) {
  const showGauge = coinData.price != null && pegRef > 0;
  const price = mobile
    ? formatNativePrice(
        coinData.price != null ? Math.floor(coinData.price * 1000) / 1000 : coinData.price,
        coin.flags.pegCurrency ?? "USD",
        pegRef,
        3,
      )
    : formatNativePrice(coinData.price, coin.flags.pegCurrency ?? "USD", pegRef);

  return (
    <div
      className={
        mobile
          ? "rounded-xl border border-border/60 bg-background/45 px-3 py-2.5"
          : "rounded-xl border border-border/60 bg-background/45 px-4 py-3"
      }
    >
      <div className={`flex items-center ${mobile ? "gap-2" : "gap-3"}`}>
        {showGauge && (
          <PegGauge deviationBps={gaugeDeviationBps} className={mobile ? "w-12" : "w-16 xl:w-20"} />
        )}
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Price
          </p>
          <p
            className={`font-extrabold font-mono tracking-tight ${confidenceClass(coinData.priceConfidence)} ${
              mobile ? "text-xl" : "text-2xl xl:text-3xl"
            }`}
          >
            {price}
          </p>
          <p
            className={`font-mono ${mobile ? "mt-1 text-xs" : "mt-0.5 text-xs"} ${
              isNavToken
                ? "text-green-700 dark:text-green-400"
                : deviationColorClass(Math.abs(deviationBps))
            }`}
          >
            {formatPegDeviation(coinData.price, pegRef)}
          </p>
          {limitedDepegCoverageNote ? (
            <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
              {limitedDepegCoverageNote}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function HeroMarketCapCard({
  mcap,
  safePrevDay,
  prevDayTrendClass,
  mobile = false,
}: {
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
          : "rounded-xl border border-border/60 bg-background/45 px-4 py-3"
      }
    >
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Market Cap
      </p>
      <p className={`font-bold font-mono tracking-tight ${mobile ? "text-lg" : "text-2xl"}`}>
        {formatCurrency(mcap)}
      </p>
      <p className={`mt-1 text-xs font-mono ${prevDayTrendClass}`}>
        {safePrevDay == null ? "—" : formatPercentChange(mcap, safePrevDay)}{" "}
        <span className="text-muted-foreground">24h</span>
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
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Supply
            </p>
            <p className="text-base font-bold font-mono">
              {supply != null ? formatSupply(supply) : "—"}{" "}
              <span className="text-xs text-muted-foreground">{coinSymbol}</span>
            </p>
          </div>
          <div className="text-right">
            <p className={`text-xs font-mono ${prevWeekTrendClass}`}>
              {safePrevWeek == null ? "—" : formatPercentChange(mcap, safePrevWeek)}{" "}
              <span className="text-muted-foreground">7d</span>
            </p>
            {hasPrevMonth && (
              <p className={`text-xs font-mono ${prevMonthTrendClass}`}>
                {safePrevMonth == null ? "—" : formatPercentChange(mcap, safePrevMonth)}{" "}
                <span className="text-muted-foreground">30d</span>
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border/60 bg-background/45 px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Supply
      </p>
      <p className="text-2xl font-bold font-mono tracking-tight">
        {supply != null ? formatSupply(supply) : "—"}{" "}
        <span className="text-sm text-muted-foreground">{coinSymbol}</span>
      </p>
      <p className="mt-1 whitespace-nowrap text-xs font-mono">
        <span className={prevWeekTrendClass}>
          {safePrevWeek == null ? "—" : formatPercentChange(mcap, safePrevWeek)}
        </span>
        <span className="text-muted-foreground"> 7d</span>
        {hasPrevMonth && (
          <>
            <span className="text-muted-foreground"> · </span>
            <span className={prevMonthTrendClass}>
              {safePrevMonth == null ? "—" : formatPercentChange(mcap, safePrevMonth)}
            </span>
            <span className="text-muted-foreground"> 30d</span>
          </>
        )}
      </p>
    </div>
  );
}
