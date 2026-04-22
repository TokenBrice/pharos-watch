"use client";

import Link from "next/link";
import { ArrowLeftRight, Flag } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { BluechipHeaderBadge } from "@/components/bluechip-header-badge";
import { Breadcrumb } from "@/components/breadcrumb";
import { PegGauge } from "@/components/peg-gauge";
import { ShareButton } from "@/components/share-button";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import {
  BACKING_LABELS,
  GOVERNANCE_LABELS,
  PEG_LABELS_SHORT,
} from "@shared/lib/classification";
import {
  formatCurrency,
  formatNativePrice,
  formatPegDeviation,
  formatPercentChange,
  formatSupply,
} from "@shared/lib/format";
import { getInfrastructureLabel } from "@shared/lib/infrastructure";
import { REPORT_CARD_GRADE_COLORS } from "@shared/lib/report-cards";
import type {
  Infrastructure,
  ReportCard,
  StablecoinData,
  StablecoinMeta,
} from "@shared/types";
import { confidenceClass } from "@/lib/confidence";
import { buildPegLandingUrl } from "@/lib/peg-landing";
import { deviationColorClass } from "@/lib/severity-colors";
import {
  buildBackingTaxonomyUrl,
  buildGovernanceTaxonomyUrl,
} from "@/lib/stablecoin-taxonomy";
import { buildStablecoinUrl } from "@/lib/urls";

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

function HeroTagList({ tags }: { tags: readonly string[] | undefined }) {
  if (!tags || tags.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
        >
          {tag}
        </span>
      ))}
    </div>
  );
}

function InfrastructureBadge({ value }: { value: Infrastructure }) {
  const label = getInfrastructureLabel(value);
  const isM0 = value === "m0";
  const colorClass = isM0
    ? "text-violet-700 dark:text-violet-400"
    : "text-frost-blue";
  const borderClass = isM0
    ? "border-violet-500/30 bg-violet-500/10"
    : "border-frost-blue/30 bg-frost-blue/10";

  return (
    <div className={`flex items-center gap-2 rounded-lg border ${borderClass} px-2.5 py-1.5`}>
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Infrastructure
      </span>
      <span className={`text-base font-bold font-mono ${colorClass}`}>{label}</span>
    </div>
  );
}

function InfrastructureChip({ value }: { value: Infrastructure }) {
  const label = getInfrastructureLabel(value);
  const isM0 = value === "m0";
  const className = isM0
    ? "inline-flex items-center rounded-full border border-violet-500/30 bg-violet-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-violet-700 dark:text-violet-400"
    : "inline-flex items-center rounded-full border border-frost-blue/30 bg-frost-blue/10 px-2.5 py-0.5 text-[11px] font-semibold text-frost-blue";

  return <span className={className}>{label}</span>;
}

function HeroTertiaryMetrics({
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

function HeroClassificationLine({ coin }: { coin: StablecoinMeta }) {
  const pegHref = buildPegLandingUrl(coin.flags.pegCurrency);
  const governanceHref = buildGovernanceTaxonomyUrl(coin.flags.governance);
  const backingHref = buildBackingTaxonomyUrl(coin.flags.backing);
  const governanceLabel = GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance;
  const backingLabel = BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing;
  const pegLabel = PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency;

  const pillClass =
    "pharos-focus-ring inline-flex items-center rounded-full border border-border/50 bg-background/60 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground";

  return (
    <p className="flex flex-wrap items-center gap-1.5">
      <Link
        href={governanceHref}
        className={pillClass}
        aria-label={`Browse ${governanceLabel} stablecoins`}
      >
        {governanceLabel}
      </Link>
      <Link
        href={backingHref}
        className={pillClass}
        aria-label={`Browse ${backingLabel} stablecoins`}
      >
        {backingLabel}
      </Link>
      {pegHref ? (
        <Link href={pegHref} className={pillClass} aria-label={`Browse ${pegLabel} stablecoins`}>
          {pegLabel}
        </Link>
      ) : (
        <span className={pillClass}>{pegLabel}</span>
      )}
    </p>
  );
}

function HeroSignalsRail({ items }: { items: HeroSignalRailItem[] }) {
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

function SafetyGradeHero({
  reportCard,
  mobile = false,
}: {
  reportCard: ReportCard | null;
  mobile?: boolean;
}) {
  if (!reportCard || reportCard.isDefunct) {
    return (
      <div
        className={`flex flex-col items-center justify-center rounded-xl border border-border/60 bg-background/50 ${
          mobile ? "px-3 py-2" : "px-4 py-3"
        }`}
      >
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Safety
        </span>
        <span className="text-lg font-bold text-muted-foreground">—</span>
      </div>
    );
  }

  const sizeClasses = mobile ? "text-3xl px-3 py-1.5" : "text-5xl px-6 py-3";

  return (
    <div
      className={`flex flex-col items-center justify-center rounded-xl border-2 border-border/60 bg-background/50 ${
        mobile ? "gap-1 px-3 py-2" : "gap-2.5 px-5 py-4"
      }`}
    >
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Safety Grade
      </span>
      <Badge
        variant="outline"
        className={`${sizeClasses} font-extrabold tracking-tight ${REPORT_CARD_GRADE_COLORS[reportCard.overallGrade]}`}
      >
        {reportCard.overallGrade}
      </Badge>
      {reportCard.overallScore !== null && (
        <span
          className={`font-mono tabular-nums tracking-tight text-foreground ${
            mobile ? "text-sm" : "text-lg"
          }`}
        >
          {reportCard.overallScore}
          <span className="text-xs text-muted-foreground">/100</span>
        </span>
      )}
    </div>
  );
}

function HeroVariantChip({
  variantParent,
  variantChipClass,
  mobile = false,
}: {
  variantParent?: StablecoinMeta | null;
  variantChipClass?: string | null;
  mobile?: boolean;
}) {
  if (!variantParent || !variantChipClass) return null;

  return (
    <Link
      href={buildStablecoinUrl(variantParent.id)}
      className={`pharos-focus-ring inline-flex items-center rounded-full border font-semibold ${variantChipClass} ${
        mobile ? "mt-1 px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-[11px]"
      }`}
    >
      Variant of {variantParent.symbol}
    </Link>
  );
}

function HeroMobileIdentity({
  coin,
  logoSrc,
  variantParent,
  variantChipClass,
  infrastructures,
}: {
  coin: StablecoinMeta;
  logoSrc?: string;
  variantParent?: StablecoinMeta | null;
  variantChipClass?: string | null;
  infrastructures: Infrastructure[];
}) {
  return (
    <>
      <StablecoinLogo src={logoSrc} name={coin.name} size={48} />
      <div className="min-w-0 flex-1">
        <h2 className="text-2xl font-black tracking-tighter">{coin.name}</h2>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-sm font-mono text-muted-foreground">{coin.symbol}</span>
          <BluechipHeaderBadge stablecoinId={coin.id} />
        </div>
        <HeroClassificationLine coin={coin} />
        <HeroVariantChip
          variantParent={variantParent}
          variantChipClass={variantChipClass}
          mobile
        />
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {infrastructures.map((value) => (
            <InfrastructureChip key={value} value={value} />
          ))}
          <HeroTagList tags={coin.tags} />
        </div>
      </div>
    </>
  );
}

function HeroDesktopIdentity({
  coin,
  logoSrc,
  variantParent,
  variantChipClass,
  infrastructures,
}: {
  coin: StablecoinMeta;
  logoSrc?: string;
  variantParent?: StablecoinMeta | null;
  variantChipClass?: string | null;
  infrastructures: Infrastructure[];
}) {
  return (
    <div className="flex items-start gap-3">
      <StablecoinLogo src={logoSrc} name={coin.name} size={64} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-3xl font-black tracking-tighter">{coin.name}</h2>
          <span className="text-base font-mono text-muted-foreground/70">{coin.symbol}</span>
          <BluechipHeaderBadge stablecoinId={coin.id} />
        </div>
        <div className="mt-1 flex items-center gap-3">
          <HeroClassificationLine coin={coin} />
        </div>
        {variantParent && variantChipClass ? (
          <div className="mt-1.5">
            <HeroVariantChip
              variantParent={variantParent}
              variantChipClass={variantChipClass}
            />
          </div>
        ) : null}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {infrastructures.map((value) => (
            <InfrastructureChip key={value} value={value} />
          ))}
          <HeroTagList tags={coin.tags} />
        </div>
      </div>
    </div>
  );
}

function HeroPriceCard({
  coin,
  coinData,
  pegRef,
  gaugeDeviationBps,
  deviationBps,
  isNavToken,
  limitedDepegCoverageNote,
  mobile = false,
}: {
  coin: StablecoinMeta;
  coinData: StablecoinData;
  pegRef: number;
  gaugeDeviationBps: number;
  deviationBps: number;
  isNavToken: boolean;
  limitedDepegCoverageNote: string | null;
  mobile?: boolean;
}) {
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

function HeroMarketCapCard({
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

function HeroSupplyCard({
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

export function HeroCardHeader({
  coinId,
  coinName,
  compareHref,
  benchmarkSymbol,
  onOpenFeedback,
}: {
  coinId: string;
  coinName: string;
  compareHref: string;
  benchmarkSymbol: string | null;
  onOpenFeedback: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/30 px-4 pb-2.5 pt-3 sm:px-5">
      <Breadcrumb items={[{ label: "Dashboard", href: "/" }, { label: coinName }]} />

      <div className="flex items-center gap-1.5">
        <button
          onClick={onOpenFeedback}
          className="pharos-focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground lg:min-h-9 lg:rounded-md lg:px-2 lg:py-1"
        >
          <Flag className="h-3 w-3" />
          <span className="hidden sm:inline">Report issue</span>
        </button>
        <Link
          href={compareHref}
          className="pharos-focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground lg:min-h-9 lg:rounded-md lg:px-2 lg:py-1"
        >
          <ArrowLeftRight className="h-3.5 w-3.5" />
          {benchmarkSymbol ? `Compare vs ${benchmarkSymbol}` : "Compare"}
        </Link>
        <ShareButton ogPath={`/api/og/stablecoin/${coinId}`} label="Share" />
      </div>
    </div>
  );
}

export function HeroCardMobileSection({
  coin,
  coinData,
  logoSrc,
  reportCard,
  variantParent,
  variantChipClass,
  infrastructures,
  pegRef,
  gaugeDeviationBps,
  deviationBps,
  isNavToken,
  limitedDepegCoverageNote,
  mcap,
  supply,
  safePrevDay,
  prevDayTrendClass,
  safePrevWeek,
  prevWeekTrendClass,
  hasPrevMonth,
  safePrevMonth,
  prevMonthTrendClass,
  tertiaryMetrics,
  chainCount,
  earlyPegScore,
  trackingSpanDays,
  activeDepeg,
}: {
  coin: StablecoinMeta;
  coinData: StablecoinData;
  logoSrc?: string;
  reportCard: ReportCard | null;
  variantParent?: StablecoinMeta | null;
  variantChipClass?: string | null;
  infrastructures: Infrastructure[];
  pegRef: number;
  gaugeDeviationBps: number;
  deviationBps: number;
  isNavToken: boolean;
  limitedDepegCoverageNote: string | null;
  mcap: number;
  supply: number | null;
  safePrevDay: number | null;
  prevDayTrendClass: string;
  safePrevWeek: number | null;
  prevWeekTrendClass: string;
  hasPrevMonth: boolean;
  safePrevMonth: number | null;
  prevMonthTrendClass: string;
  tertiaryMetrics: HeroTertiaryMetricConfig[];
  chainCount: number;
  earlyPegScore: boolean;
  trackingSpanDays: number;
  activeDepeg: boolean;
}) {
  return (
    <div className="px-4 py-4 sm:px-5 lg:hidden">
      <div className="flex items-start gap-3">
        <HeroMobileIdentity
          coin={coin}
          logoSrc={logoSrc}
          variantParent={variantParent}
          variantChipClass={variantChipClass}
          infrastructures={infrastructures}
        />
        <SafetyGradeHero reportCard={reportCard} mobile />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <HeroPriceCard
          coin={coin}
          coinData={coinData}
          pegRef={pegRef}
          gaugeDeviationBps={gaugeDeviationBps}
          deviationBps={deviationBps}
          isNavToken={isNavToken}
          limitedDepegCoverageNote={limitedDepegCoverageNote}
          mobile
        />
        <HeroMarketCapCard
          mcap={mcap}
          safePrevDay={safePrevDay}
          prevDayTrendClass={prevDayTrendClass}
          mobile
        />
      </div>

      <HeroSupplyCard
        supply={supply}
        coinSymbol={coin.symbol}
        mcap={mcap}
        safePrevWeek={safePrevWeek}
        prevWeekTrendClass={prevWeekTrendClass}
        hasPrevMonth={hasPrevMonth}
        safePrevMonth={safePrevMonth}
        prevMonthTrendClass={prevMonthTrendClass}
        mobile
      />

      <HeroTertiaryMetrics
        metrics={tertiaryMetrics}
        chainCount={chainCount}
        infrastructures={infrastructures}
        earlyPegScore={earlyPegScore}
        trackingSpanDays={trackingSpanDays}
        activeDepeg={activeDepeg}
        mobile
      />
    </div>
  );
}

export function HeroCardDesktopSection({
  coin,
  coinData,
  logoSrc,
  variantParent,
  variantChipClass,
  infrastructures,
  pegRef,
  gaugeDeviationBps,
  deviationBps,
  isNavToken,
  limitedDepegCoverageNote,
  mcap,
  supply,
  safePrevDay,
  prevDayTrendClass,
  safePrevWeek,
  prevWeekTrendClass,
  hasPrevMonth,
  safePrevMonth,
  prevMonthTrendClass,
  signalRailItems,
  tertiaryMetrics,
  chainCount,
  earlyPegScore,
  trackingSpanDays,
  activeDepeg,
}: {
  coin: StablecoinMeta;
  coinData: StablecoinData;
  logoSrc?: string;
  variantParent?: StablecoinMeta | null;
  variantChipClass?: string | null;
  infrastructures: Infrastructure[];
  pegRef: number;
  gaugeDeviationBps: number;
  deviationBps: number;
  isNavToken: boolean;
  limitedDepegCoverageNote: string | null;
  mcap: number;
  supply: number | null;
  safePrevDay: number | null;
  prevDayTrendClass: string;
  safePrevWeek: number | null;
  prevWeekTrendClass: string;
  hasPrevMonth: boolean;
  safePrevMonth: number | null;
  prevMonthTrendClass: string;
  signalRailItems: HeroSignalRailItem[];
  tertiaryMetrics: HeroTertiaryMetricConfig[];
  chainCount: number;
  earlyPegScore: boolean;
  trackingSpanDays: number;
  activeDepeg: boolean;
}) {
  return (
    <div className="hidden px-5 py-5 lg:block">
      <div className="space-y-4">
        <div className="flex gap-6">
          <div className="min-w-0 flex-1">
            <HeroDesktopIdentity
              coin={coin}
              logoSrc={logoSrc}
              variantParent={variantParent}
              variantChipClass={variantChipClass}
              infrastructures={infrastructures}
            />

            <div className="mt-5 grid grid-cols-3 gap-4">
              <HeroPriceCard
                coin={coin}
                coinData={coinData}
                pegRef={pegRef}
                gaugeDeviationBps={gaugeDeviationBps}
                deviationBps={deviationBps}
                isNavToken={isNavToken}
                limitedDepegCoverageNote={limitedDepegCoverageNote}
              />
              <HeroMarketCapCard
                mcap={mcap}
                safePrevDay={safePrevDay}
                prevDayTrendClass={prevDayTrendClass}
              />
              <HeroSupplyCard
                supply={supply}
                coinSymbol={coin.symbol}
                mcap={mcap}
                safePrevWeek={safePrevWeek}
                prevWeekTrendClass={prevWeekTrendClass}
                hasPrevMonth={hasPrevMonth}
                safePrevMonth={safePrevMonth}
                prevMonthTrendClass={prevMonthTrendClass}
              />
            </div>
          </div>

          <div className="w-56 shrink-0">
            <HeroSignalsRail items={signalRailItems} />
          </div>
        </div>

        <HeroTertiaryMetrics
          metrics={tertiaryMetrics}
          chainCount={chainCount}
          infrastructures={infrastructures}
          earlyPegScore={earlyPegScore}
          trackingSpanDays={trackingSpanDays}
          activeDepeg={activeDepeg}
        />
      </div>
    </div>
  );
}
