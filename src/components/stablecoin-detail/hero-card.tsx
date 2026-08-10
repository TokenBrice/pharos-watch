"use client";

import Link from "next/link";
import { ArrowLeftRight, ArrowRight, BookOpen, ExternalLink, FileText, Flag, Globe, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { MethodologyLabel } from "@/components/methodology-hint";
import { ShareButton } from "@/components/share-button";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { STABLECOIN_DETAIL_IDENTITY_LOGO_SIZE } from "@/components/stablecoin-detail/constants";
import { THREAT_BAND_STYLES } from "@shared/lib/classification";
import type { HeroCardViewModel, HeroTertiaryMetricViewModel } from "@/lib/stablecoin-detail-view-model";
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
        className={`px-2 py-0.5 text-xs font-semibold tracking-tight ${THREAT_BAND_STYLES[display.band].cls}`}
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

function linkIconFor(label: string) {
  const normalized = label.toLowerCase();
  if (normalized.includes("website")) return Globe;
  if (normalized.includes("twitter") || normalized === "x") return X;
  if (normalized.includes("doc")) return FileText;
  return ExternalLink;
}

export function HeroDesktopIdentityToolbar({
  model,
  onOpenFeedback,
}: {
  model: HeroCardViewModel;
  onOpenFeedback: () => void;
}) {
  const { coin, logoSrc, header } = model;
  const links = (coin.links ?? []).slice(0, 3);
  const actionClass =
    "pharos-focus-ring inline-flex size-8 items-center justify-center rounded-md border border-border/60 bg-card text-muted-foreground transition-colors hover:border-border hover:bg-muted/60 hover:text-foreground";

  // Figma coin template: avatar + mono ticker eyebrow above the H1, and the
  // action cluster grouped as [resource links] · divider · [compare/flag/share].
  // Rendered by the detail page above the content/rail grid (not inside
  // HeroCard) so the summary rail top-aligns with the hero card.
  return (
    <div className="hidden items-start justify-between gap-5 lg:flex">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-3">
          <StablecoinLogo src={logoSrc} name={coin.name} size={STABLECOIN_DETAIL_IDENTITY_LOGO_SIZE} />
          <span className="shrink-0 font-mono text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {coin.symbol}
          </span>
          <h2 className="pharos-page-title min-w-0 truncate text-2xl leading-none tracking-normal">{coin.name}</h2>
        </div>
        {coin.oneLiner ? (
          <p className="mt-2 max-w-none text-sm leading-relaxed text-muted-foreground">{coin.oneLiner}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 pt-1">
        {links.map((link) => {
          const Icon = linkIconFor(link.label);
          return (
            <a
              key={link.url}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className={actionClass}
              aria-label={link.label}
              title={link.label}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          );
        })}
        {links.length > 0 ? <span aria-hidden="true" className="mx-1 h-4 w-px bg-border/60" /> : null}
        <Link
          href={header.compareHref}
          className={actionClass}
          aria-label={header.benchmarkSymbol ? `Compare vs ${header.benchmarkSymbol}` : "Compare"}
          title={header.benchmarkSymbol ? `Compare vs ${header.benchmarkSymbol}` : "Compare"}
        >
          <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
        <button
          type="button"
          onClick={onOpenFeedback}
          className={actionClass}
          aria-label="Report issue"
          title="Report issue"
        >
          <Flag className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <ShareButton ogPath={`/api/og/stablecoin/${header.coinId}`} label="Share" iconOnly />
      </div>
    </div>
  );
}

function HeroCaseStudyCallout({ callout }: { callout: NonNullable<HeroCardViewModel["caseStudyCallout"]> }) {
  return (
    <Link
      href={callout.href}
      aria-label={`Read the case study: ${callout.title} (outcome: ${callout.outcomeLabel})`}
      className="pharos-focus-ring group flex flex-col gap-2 rounded-b-xl border-t border-border/60 bg-muted/25 px-4 py-3 transition-colors hover:bg-muted/45 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:px-5"
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <BookOpen aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="pharos-kicker shrink-0">Case study</span>
        <span aria-hidden="true" className="hidden h-3 w-px shrink-0 bg-border sm:block" />
        <span className="min-w-0 text-sm font-medium leading-snug text-foreground sm:truncate">{callout.title}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2 pl-6 sm:pl-0">
        <Badge
          variant="outline"
          className={`px-1.5 py-0 text-[10px] font-semibold uppercase tracking-wide ${callout.outcomeChipClass}`}
        >
          {callout.outcomeLabel}
        </Badge>
        <ArrowRight
          aria-hidden="true"
          className="h-4 w-4 text-muted-foreground transition-all group-hover:translate-x-0.5 group-hover:text-foreground motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
        />
      </span>
    </Link>
  );
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
    <Card className="pharos-card-shell gap-0 py-0">
      <div className="lg:hidden">
        <HeroCardHeader
          coinId={header.coinId}
          compareHref={header.compareHref}
          benchmarkSymbol={header.benchmarkSymbol}
          onOpenFeedback={onOpenFeedback}
        />
      </div>
      <HeroCardMobileSection {...sectionBaseProps} tertiaryMetrics={tertiaryMetrics} />
      <HeroCardDesktopSection
        {...sectionBaseProps}
        signalRailItems={signalRailItems}
        tertiaryMetrics={desktopTertiaryMetrics}
      />
      <HeroPassportStrip items={model.passportItems} compactDesktop />
      {model.caseStudyCallout ? <HeroCaseStudyCallout callout={model.caseStudyCallout} /> : null}
    </Card>
  );
}
