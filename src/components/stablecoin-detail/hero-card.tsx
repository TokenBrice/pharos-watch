"use client";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { MethodologyHint, MethodologyLabel } from "@/components/methodology-hint";
import { ExternalLink } from "lucide-react";
import { THREAT_BAND_COLORS } from "@shared/lib/classification";
import type {
  HeroBlacklistDisplay,
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

interface HeroCardProps {
  model: HeroCardViewModel;
  onOpenFeedback: () => void;
}

function isBlacklistDisplay(display: HeroTertiaryMetricViewModel["display"]): display is HeroBlacklistDisplay {
  return "status" in display;
}

function isDewsDisplay(display: HeroTertiaryMetricViewModel["display"]): display is HeroDewsDisplay {
  return "band" in display;
}

function renderMetricValue(metric: HeroTertiaryMetricViewModel): React.ReactNode {
  const display = metric.display;

  if (isBlacklistDisplay(display) && display.status === "dilutable" && display.source) {
    return (
      <a
        href={display.source.url}
        target="_blank"
        rel="noreferrer"
        className="pharos-focus-ring inline-flex items-center gap-1 rounded-sm underline-offset-2 hover:underline"
        title={display.source.label}
        aria-label={`Dilutable source: ${display.source.label}`}
      >
        {display.value}
        <ExternalLink className="h-3.5 w-3.5" aria-hidden />
      </a>
    );
  }

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

  return (
    <Card className="rounded-xl gap-0">
      <HeroCardHeader
        coinId={header.coinId}
        coinName={header.coinName}
        compareHref={header.compareHref}
        benchmarkSymbol={header.benchmarkSymbol}
        onOpenFeedback={onOpenFeedback}
      />
      <HeroCardMobileSection
        coin={coin}
        coinData={coinData}
        logoSrc={logoSrc}
        reportCard={reportCard}
        verdict={verdict}
        variantParent={variantParent}
        variantChipClass={variantChipClass}
        infrastructures={infrastructures}
        pegRef={price.pegRef}
        gaugeDeviationBps={price.gaugeDeviationBps}
        deviationBps={price.deviationBps}
        isNavToken={price.isNavToken}
        limitedDepegCoverageNote={price.limitedDepegCoverageNote}
        mcap={market.mcap}
        supply={market.supply}
        safePrevDay={market.safePrevDay}
        prevDayTrendClass={market.prevDayTrendClass}
        safePrevWeek={market.safePrevWeek}
        prevWeekTrendClass={market.prevWeekTrendClass}
        hasPrevMonth={market.hasPrevMonth}
        safePrevMonth={market.safePrevMonth}
        prevMonthTrendClass={market.prevMonthTrendClass}
        tertiaryMetrics={tertiaryMetrics}
        chainCount={chainCount}
        earlyPegScore={peg.earlyPegScore}
        trackingSpanDays={peg.trackingSpanDays}
        activeDepeg={peg.activeDepeg}
      />
      <HeroCardDesktopSection
        coin={coin}
        coinData={coinData}
        logoSrc={logoSrc}
        reportCard={reportCard}
        verdict={verdict}
        variantParent={variantParent}
        variantChipClass={variantChipClass}
        infrastructures={infrastructures}
        pegRef={price.pegRef}
        gaugeDeviationBps={price.gaugeDeviationBps}
        deviationBps={price.deviationBps}
        isNavToken={price.isNavToken}
        limitedDepegCoverageNote={price.limitedDepegCoverageNote}
        mcap={market.mcap}
        supply={market.supply}
        safePrevDay={market.safePrevDay}
        prevDayTrendClass={market.prevDayTrendClass}
        safePrevWeek={market.safePrevWeek}
        prevWeekTrendClass={market.prevWeekTrendClass}
        hasPrevMonth={market.hasPrevMonth}
        safePrevMonth={market.safePrevMonth}
        prevMonthTrendClass={market.prevMonthTrendClass}
        signalRailItems={signalRailItems}
        tertiaryMetrics={desktopTertiaryMetrics}
        chainCount={chainCount}
        earlyPegScore={peg.earlyPegScore}
        trackingSpanDays={peg.trackingSpanDays}
        activeDepeg={peg.activeDepeg}
      />
    </Card>
  );
}
