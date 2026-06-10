"use client";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { MethodologyLabel } from "@/components/methodology-hint";
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
  type HeroTertiaryMetricConfig,
} from "./hero-card-sections";
import { HeroPassportStrip } from "./hero-passport-strip";

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
    header,
    price,
    market,
    peg,
  } = model;
  const tertiaryMetrics = model.tertiaryMetrics.map(toMetricConfig);
  const desktopTertiaryMetrics = model.desktopTertiaryMetrics.map(toMetricConfig);
  const signalRailItems = model.signalRailItems;
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
    pegReferenceUnavailable: price.pegReferenceUnavailable,
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
      <HeroPassportStrip items={model.passportItems} />
    </Card>
  );
}
