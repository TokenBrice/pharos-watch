"use client";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { MethodologyHint, MethodologyLabel } from "@/components/methodology-hint";
import { THREAT_BAND_COLORS } from "@shared/lib/classification";
import type {
  HeroCardViewModel,
  HeroDewsDisplay,
  HeroTertiaryMetricViewModel,
} from "@/lib/stablecoin-detail-view-model";
import {
  HeroCardDesktopSection,
  HeroCardHeader,
  HeroCardMobileSection,
  type HeroSignalRailItem,
  type HeroTertiaryMetricConfig,
} from "./hero-card-sections";

type HeroSectionBaseProps = Omit<Parameters<typeof HeroCardMobileSection>[0], "tertiaryMetrics">;

interface HeroCardProps {
  model: HeroCardViewModel;
  onOpenFeedback: () => void;
}

function isDewsDisplay(display: HeroTertiaryMetricViewModel["display"]): display is HeroDewsDisplay {
  return "band" in display;
}

function renderMetricValue(metric: HeroTertiaryMetricViewModel): React.ReactNode {
  const display = metric.display;

  if (isDewsDisplay(display) && display.band) {
    return (
      <Badge
        variant="outline"
        className={`px-2 py-0.5 text-xs font-semibold tracking-tight ${THREAT_BAND_COLORS[display.band]}`}
      >
        {display.value}
      </Badge>
    );
  }

  return display.value;
}

function renderMetricLabel(metric: HeroTertiaryMetricViewModel, mobile = false): React.ReactNode {
  const label = mobile ? (metric.mobileLabel ?? metric.label) : metric.label;
  if (mobile && metric.key === "blacklistable" && metric.methodologyTopic) {
    return (
      <>
        <span className="sr-only">Freezable</span>
        <MethodologyHint
          topic={metric.methodologyTopic}
          buttonClassName="!h-11 !w-11 !min-h-11 border-frost-blue/35 bg-frost-blue/12 text-frost-blue"
        />
      </>
    );
  }
  if (!metric.methodologyTopic) return label;
  return (
    <MethodologyLabel topic={metric.methodologyTopic} compact={mobile}>
      {label}
    </MethodologyLabel>
  );
}

function toMetricConfig(metric: HeroTertiaryMetricViewModel): HeroTertiaryMetricConfig {
  return {
    key: metric.key,
    label: renderMetricLabel(metric),
    mobileLabel: renderMetricLabel(metric, true),
    value: renderMetricValue(metric),
    subValue: metric.display.sub,
    colorClass: metric.display.color,
    accentClass: metric.accentClass,
  };
}

function toSignalRailItem(item: HeroCardViewModel["signalRailItems"][number]): HeroSignalRailItem {
  return item;
}

export function HeroCard({ model, onOpenFeedback }: HeroCardProps) {
  const {
    coin,
    coinData,
    logoSrc,
    reportCard,
    verdict,
    variantParent,
    variantChipClass,
    infrastructures,
    chainCount,
    header,
    price,
    market,
    peg,
  } = model;
  const tertiaryMetrics = model.tertiaryMetrics.map(toMetricConfig);
  const desktopTertiaryMetrics = model.desktopTertiaryMetrics.map(toMetricConfig);
  const signalRailItems = model.signalRailItems.map(toSignalRailItem);
  const sectionBaseProps: HeroSectionBaseProps = {
    coin,
    coinData,
    logoSrc,
    reportCard,
    verdict,
    variantParent,
    variantChipClass,
    infrastructures,
    pegRef: price.pegRef,
    gaugeDeviationBps: price.gaugeDeviationBps,
    deviationBps: price.deviationBps,
    isNavToken: price.isNavToken,
    limitedDepegCoverageNote: price.limitedDepegCoverageNote,
    mcap: market.mcap,
    supply: market.supply,
    safePrevDay: market.safePrevDay,
    prevDayTrendClass: market.prevDayTrendClass,
    safePrevWeek: market.safePrevWeek,
    prevWeekTrendClass: market.prevWeekTrendClass,
    hasPrevMonth: market.hasPrevMonth,
    safePrevMonth: market.safePrevMonth,
    prevMonthTrendClass: market.prevMonthTrendClass,
    chainCount,
    earlyPegScore: peg.earlyPegScore,
    trackingSpanDays: peg.trackingSpanDays,
    activeDepeg: peg.activeDepeg,
  };

  return (
    <Card className="rounded-xl gap-0">
      <HeroCardHeader
        coinId={header.coinId}
        coinName={header.coinName}
        compareHref={header.compareHref}
        benchmarkSymbol={header.benchmarkSymbol}
        onOpenFeedback={onOpenFeedback}
      />
      <HeroCardMobileSection {...sectionBaseProps} tertiaryMetrics={tertiaryMetrics} />
      <HeroCardDesktopSection
        {...sectionBaseProps}
        signalRailItems={signalRailItems}
        tertiaryMetrics={desktopTertiaryMetrics}
      />
    </Card>
  );
}
