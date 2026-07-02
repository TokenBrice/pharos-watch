"use client";

import Link from "next/link";
import { ArrowRight, BookOpen } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { MethodologyLabel } from "@/components/methodology-hint";
import { THREAT_BAND_COLORS } from "@shared/lib/classification";
import type {
  HeroCardViewModel,
  HeroTertiaryMetricViewModel,
} from "@/lib/stablecoin-detail-view-model";
import type { HeroDewsDisplay } from "@/lib/stablecoin-detail-hero-metrics";
import {
  HeroCardDesktopSection,
  HeroCardHeader,
  HeroCardMobileSection,
  type HeroSectionBaseProps,
  type HeroTertiaryMetricConfig,
} from "./hero-card-sections";
import { HeroPassportStrip } from "./hero-passport-strip";

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
    price,
    market,
    peg,
  };

  return (
    <Card className="pharos-card-shell gap-0">
      <HeroCardHeader
        coinId={header.coinId}
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
      {model.caseStudyCallout ? (
        <Link
          href={model.caseStudyCallout.href}
          aria-label={`Read the case study: ${model.caseStudyCallout.title} (outcome: ${model.caseStudyCallout.outcomeLabel})`}
          className="pharos-focus-ring group -mb-4 flex items-center gap-2.5 rounded-b-xl border-t border-border/60 bg-muted/30 px-4 py-2.5 transition-colors hover:bg-muted/50 sm:gap-3 sm:px-5"
        >
          <BookOpen aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="pharos-kicker shrink-0">Case study</span>
          <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {model.caseStudyCallout.title}
          </span>
          <Badge
            variant="outline"
            className={`shrink-0 px-1.5 py-0 text-[10px] font-semibold uppercase tracking-wide ${model.caseStudyCallout.outcomeChipClass}`}
          >
            {model.caseStudyCallout.outcomeLabel}
          </Badge>
          <ArrowRight
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-muted-foreground transition-all group-hover:translate-x-0.5 group-hover:text-foreground motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
          />
        </Link>
      ) : null}
    </Card>
  );
}
