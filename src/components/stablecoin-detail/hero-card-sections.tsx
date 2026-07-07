"use client";

import Link from "next/link";
import { ArrowLeftRight, Flag } from "lucide-react";
import { ShareButton } from "@/components/share-button";
import type {
  Infrastructure,
  ReportCard,
  StablecoinData,
  StablecoinMeta,
} from "@shared/types";
import type { StablecoinClientMeta } from "@shared/lib/stablecoins/client-registry";
import type { StablecoinVerdict } from "@shared/lib/stablecoin-verdict";
import type { HeroCardViewModel } from "@/lib/stablecoin-detail-view-model";
import {
  HeroDesktopIdentity,
  HeroMobileIdentityDetails,
  HeroMobileIdentity,
  HeroVerdict,
  SafetyGradeHero,
} from "./hero-card-identity";
import {
  HeroMarketCapCard,
  HeroPriceCard,
  HeroSignalsRail,
  HeroSupplyCard,
  HeroTertiaryMetrics,
} from "./hero-card-metrics";
import type { HeroSignalRailItem, HeroTertiaryMetricConfig } from "./hero-card-metrics";
import { RecentBlacklistBanner } from "./recent-blacklist-banner";
export type {
  HeroSignalRailItem,
  HeroTertiaryMetricConfig,
} from "./hero-card-metrics";

export function HeroCardHeader({
  coinId,
  compareHref,
  benchmarkSymbol,
  onOpenFeedback,
}: {
  coinId: string;
  compareHref: string;
  benchmarkSymbol: string | null;
  onOpenFeedback: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/30 px-4 pb-2.5 pt-3 sm:px-5">
      <div className="flex items-center gap-1.5">
        <button type="button"
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

export interface HeroSectionBaseProps {
  coin: StablecoinMeta;
  coinData: StablecoinData;
  logoSrc?: string;
  reportCard: ReportCard | null;
  verdict: StablecoinVerdict;
  variantParent?: StablecoinClientMeta | null;
  variantChipClass?: string | null;
  infrastructures: Infrastructure[];
  price: HeroCardViewModel["price"];
  market: HeroCardViewModel["market"];
  peg: HeroCardViewModel["peg"];
}

export function HeroCardMobileSection({
  coin,
  coinData,
  logoSrc,
  verdict,
  reportCard,
  variantParent,
  variantChipClass,
  infrastructures,
  price,
  market,
  peg,
  tertiaryMetrics,
}: HeroSectionBaseProps & {
  tertiaryMetrics: HeroTertiaryMetricConfig[];
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
          verdict={verdict}
          condensed
        />
        <div className="self-stretch">
          <SafetyGradeHero reportCard={reportCard} mobile />
        </div>
      </div>
      <HeroMobileIdentityDetails
        coin={coin}
        infrastructures={infrastructures}
        includeClassification={false}
      />

      <HeroVerdict coinId={coin.id} verdict={verdict} />

      <div className="mt-4 grid grid-cols-2 gap-3">
        <HeroPriceCard
          coin={coin}
          coinData={coinData}
          price={price}
          mobile
        />
        <HeroMarketCapCard
          coin={coin}
          coinData={coinData}
          mcap={market.mcap}
          safePrevDay={market.safePrevDay}
          prevDayTrendClass={market.prevDayTrendClass}
          mobile
        />
      </div>

      <HeroSupplyCard
        supply={market.supply}
        coinSymbol={coin.symbol}
        mcap={market.mcap}
        safePrevWeek={market.safePrevWeek}
        prevWeekTrendClass={market.prevWeekTrendClass}
        hasPrevMonth={market.hasPrevMonth}
        safePrevMonth={market.safePrevMonth}
        prevMonthTrendClass={market.prevMonthTrendClass}
        mobile
      />

      <HeroTertiaryMetrics
        metrics={tertiaryMetrics}
        earlyPegScore={peg.earlyPegScore}
        trackingSpanDays={peg.trackingSpanDays}
        activeDepeg={peg.activeDepeg}
        mobile
        trailing={<RecentBlacklistBanner symbol={coin.symbol} coinStatus={coin.status} />}
      />
    </div>
  );
}

export function HeroCardDesktopSection({
  coin,
  coinData,
  logoSrc,
  verdict,
  variantParent,
  variantChipClass,
  infrastructures,
  price,
  market,
  peg,
  signalRailItems,
  tertiaryMetrics,
}: HeroSectionBaseProps & {
  signalRailItems: HeroSignalRailItem[];
  tertiaryMetrics: HeroTertiaryMetricConfig[];
}) {
  return (
    <div className="hidden px-5 pb-3.5 pt-5 lg:block">
      <div className="flex gap-6">
        <div className="min-w-0 flex-1">
          <HeroDesktopIdentity
            coin={coin}
            logoSrc={logoSrc}
            variantParent={variantParent}
            variantChipClass={variantChipClass}
            infrastructures={infrastructures}
            verdict={verdict}
          />

          <div className="mt-5 grid grid-cols-3 gap-4">
            <HeroPriceCard
              coin={coin}
              coinData={coinData}
              price={price}
            />
            <HeroMarketCapCard
              coin={coin}
              coinData={coinData}
              mcap={market.mcap}
              safePrevDay={market.safePrevDay}
              prevDayTrendClass={market.prevDayTrendClass}
            />
            <HeroSupplyCard
              supply={market.supply}
              coinSymbol={coin.symbol}
              mcap={market.mcap}
              safePrevWeek={market.safePrevWeek}
              prevWeekTrendClass={market.prevWeekTrendClass}
              hasPrevMonth={market.hasPrevMonth}
              safePrevMonth={market.safePrevMonth}
              prevMonthTrendClass={market.prevMonthTrendClass}
            />
          </div>

          <div className="mt-3">
            <HeroTertiaryMetrics
              metrics={tertiaryMetrics}
              earlyPegScore={peg.earlyPegScore}
              trackingSpanDays={peg.trackingSpanDays}
              activeDepeg={peg.activeDepeg}
              trailing={<RecentBlacklistBanner symbol={coin.symbol} coinStatus={coin.status} />}
            />
          </div>
        </div>

        {/* At xl+ the detail right rail renders the safety summary card
            (Figma coin template), so the inline copy CSS-hides there. */}
        <div className="w-56 shrink-0 xl:hidden">
          <HeroSignalsRail items={signalRailItems} />
        </div>
      </div>
    </div>
  );
}
