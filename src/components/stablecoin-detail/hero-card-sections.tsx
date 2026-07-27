"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeftRight, BadgeCheck, Flag, Rocket } from "lucide-react";
import { ShareButton } from "@/components/share-button";
import type { Infrastructure, SafetyScoreV9CurrentCard, StablecoinData, StablecoinMeta } from "@shared/types";
import type { StablecoinClientMeta } from "@shared/lib/stablecoins/client-registry";
import type { StablecoinVerdict } from "@shared/lib/stablecoin-verdict";
import type { HeroCardViewModel } from "@/lib/stablecoin-detail-view-model";
import { buildPegLandingUrl } from "@/lib/peg-landing";
import { buildBackingTaxonomyUrl, buildGovernanceTaxonomyUrl } from "@/lib/stablecoin-taxonomy-urls";
import { isHeroVerdictEnabled } from "@/lib/feature-flags";
import { HeroMobileIdentityDetails, HeroMobileIdentity, HeroVerdict, SafetyGradeHero } from "./hero-card-identity";
import {
  HERO_CHIP_BACKING_LABELS,
  HERO_CHIP_GOVERNANCE_LABELS,
  HERO_CHIP_PEG_LABELS,
} from "@shared/lib/classification";
import {
  HeroCompactMarketCapCell,
  HeroCompactPriceCell,
  HeroCompactSupplyCell,
  HeroCompactTertiaryCell,
  HeroMarketCapCard,
  HeroPriceCard,
  HeroSupplyCard,
  HeroTertiaryMetrics,
} from "./hero-card-metrics";
import type { HeroSignalRailItem, HeroTertiaryMetricConfig } from "./hero-card-metrics";
import { RecentBlacklistBanner } from "./recent-blacklist-banner";
export type { HeroSignalRailItem, HeroTertiaryMetricConfig } from "./hero-card-metrics";

function formatChipLaunchDate(value: string | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function HeroCompactChip({ href, children }: { href?: string | null; children: ReactNode }) {
  const className =
    "pharos-focus-ring inline-flex h-5 items-center rounded-full bg-muted/70 px-2.5 text-xs font-medium leading-none text-foreground/80 transition-colors hover:bg-muted";
  if (!href) return <span className={className}>{children}</span>;
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}

function HeroDesktopChipRail({ coin, verdict }: { coin: StablecoinMeta; verdict: StablecoinVerdict }) {
  const showVerdict = isHeroVerdictEnabled() && verdict.archetype !== "uncategorized";
  const launchDate = formatChipLaunchDate(coin.launchDate);
  const pegLabel = HERO_CHIP_PEG_LABELS[coin.flags.pegCurrency];
  const backingLabel = HERO_CHIP_BACKING_LABELS[coin.flags.backing];
  const governanceLabel = HERO_CHIP_GOVERNANCE_LABELS[coin.flags.governance];

  return (
    <div className="flex min-h-10 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border/40 px-5 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {showVerdict ? (
          <span
            id={`hero-verdict-${coin.id}`}
            data-archetype={verdict.archetype}
            className="inline-flex h-5 items-center gap-1 rounded-full bg-sky-500/15 px-2.5 text-xs font-medium leading-none text-sky-700 dark:text-sky-300"
          >
            <BadgeCheck aria-hidden="true" className="h-3 w-3" />
            {verdict.label}
          </span>
        ) : null}
        <HeroCompactChip href={buildPegLandingUrl(coin.flags.pegCurrency)}>{pegLabel}</HeroCompactChip>
        <HeroCompactChip href={buildBackingTaxonomyUrl(coin.flags.backing)}>{backingLabel}</HeroCompactChip>
        <HeroCompactChip href={buildGovernanceTaxonomyUrl(coin.flags.governance)}>{governanceLabel}</HeroCompactChip>
      </div>
      {launchDate ? (
        <span className="-my-2 -mr-5 inline-flex h-10 items-center gap-1.5 border-l border-border/40 px-4 text-xs font-medium text-muted-foreground">
          <Rocket aria-hidden="true" className="h-3.5 w-3.5" />
          {launchDate}
        </span>
      ) : null}
    </div>
  );
}

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
        <button
          type="button"
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
  reportCard: SafetyScoreV9CurrentCard | null;
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
      <HeroMobileIdentityDetails coin={coin} infrastructures={infrastructures} includeClassification={false} />

      <HeroVerdict coinId={coin.id} verdict={verdict} />

      <div className="mt-4 grid grid-cols-2 gap-3">
        <HeroPriceCard coin={coin} coinData={coinData} price={price} mobile />
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
  verdict,
  price,
  market,
  tertiaryMetrics,
}: HeroSectionBaseProps & {
  signalRailItems: HeroSignalRailItem[];
  tertiaryMetrics: HeroTertiaryMetricConfig[];
}) {
  // The fourth slot preserves the live 30d excess-vs-T-bill metric even though
  // the visual chrome now matches the compact reference dossier.
  const excessMetric = tertiaryMetrics.find((metric) => metric.key === "excess-yield");

  return (
    <div className="hidden lg:block">
      <HeroDesktopChipRail coin={coin} verdict={verdict} />
      <div className={`grid lg:grid-cols-3 ${excessMetric ? "xl:grid-cols-4" : ""}`}>
        <HeroCompactPriceCell coin={coin} coinData={coinData} price={price} />
        <HeroCompactMarketCapCell
          coin={coin}
          coinData={coinData}
          mcap={market.mcap}
          safePrevDay={market.safePrevDay}
          prevDayTrendClass={market.prevDayTrendClass}
        />
        <HeroCompactSupplyCell
          supply={market.supply}
          coinSymbol={coin.symbol}
          mcap={market.mcap}
          safePrevWeek={market.safePrevWeek}
          prevWeekTrendClass={market.prevWeekTrendClass}
          hasPrevMonth={market.hasPrevMonth}
          safePrevMonth={market.safePrevMonth}
          prevMonthTrendClass={market.prevMonthTrendClass}
        />
        {excessMetric ? <HeroCompactTertiaryCell metric={excessMetric} /> : null}
      </div>
    </div>
  );
}
