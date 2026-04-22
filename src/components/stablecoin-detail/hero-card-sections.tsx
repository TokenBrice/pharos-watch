"use client";

import Link from "next/link";
import { ArrowLeftRight, Flag } from "lucide-react";
import { Breadcrumb } from "@/components/breadcrumb";
import { ShareButton } from "@/components/share-button";
import type {
  Infrastructure,
  ReportCard,
  StablecoinData,
  StablecoinMeta,
} from "@shared/types";
import {
  HeroDesktopIdentity,
  HeroMobileIdentity,
  SafetyGradeHero,
} from "./hero-card-identity";
import {
  HeroMarketCapCard,
  HeroPriceCard,
  HeroSignalsRail,
  HeroSupplyCard,
  HeroTertiaryMetrics,
} from "./hero-card-metrics";
export type {
  HeroSignalRailItem,
  HeroTertiaryMetricConfig,
} from "./hero-card-metrics";

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

interface HeroSectionBaseProps {
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
  chainCount: number;
  earlyPegScore: boolean;
  trackingSpanDays: number;
  activeDepeg: boolean;
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
}: HeroSectionBaseProps & {
  reportCard: ReportCard | null;
  tertiaryMetrics: import("./hero-card-metrics").HeroTertiaryMetricConfig[];
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
}: HeroSectionBaseProps & {
  signalRailItems: import("./hero-card-metrics").HeroSignalRailItem[];
  tertiaryMetrics: import("./hero-card-metrics").HeroTertiaryMetricConfig[];
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
