"use client";

import { useEffect, useState } from "react";
import { IntentLink } from "@/components/intent-link";
import { ArrowLeftRight, ArrowRight, BookOpen, Flag } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { MethodologyHint, MethodologyLabel } from "@/components/methodology-hint";
import { ShareButton } from "@/components/share-button";
import { BluechipHeaderBadge } from "@/components/bluechip-header-badge";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { StablecoinIdentityTransition } from "@/components/view-transitions";
import { STABLECOIN_DETAIL_IDENTITY_LOGO_SIZE } from "@/components/stablecoin-detail/constants";
import { formatDataHealthTimestamp } from "@/lib/data-health";
import { useHydrated } from "@/hooks/use-hydrated";
import { formatRelativeAgeSeconds } from "@shared/lib/relative-time";
import { cn } from "@/lib/utils";
import { THREAT_BAND_STYLES } from "@shared/lib/classification";
import type { HeroCardViewModel, HeroTertiaryMetricViewModel } from "@/lib/stablecoin-detail-view-model";
import type { HeroDewsDisplay } from "@/lib/stablecoin-detail-hero-metrics";
import {
  HeroCardDesktopSection,
  HeroCardMobileSection,
  HeroChipRail,
  isHeroVerdictShown,
  type HeroSectionBaseProps,
  type HeroTertiaryMetricConfig,
} from "./hero-card-sections";
import { HeroVariantChip, SafetyGradeHero } from "./hero-card-identity";
import { HeroPassportStrip } from "./hero-passport-strip";
import { linkIconFor } from "./link-icon";

interface HeroCardProps {
  model: HeroCardViewModel;
}

function isDewsDisplay(display: HeroTertiaryMetricViewModel["display"]): display is HeroDewsDisplay {
  return "band" in display;
}

function renderMetricValue(metric: HeroTertiaryMetricViewModel): React.ReactNode {
  const display = metric.display;

  // A first read in flight holds the value's line box without claiming "unavailable".
  if (display.pending) {
    return (
      <span
        aria-hidden="true"
        className="inline-block h-[0.85em] w-[2.5em] animate-pulse rounded-md bg-muted align-middle motion-reduce:animate-none"
      />
    );
  }

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

// The mobile metric chips put label, value and sub-line on one line, so the
// help affordance is an inline glyph sized to the 24px minimum tap target
// rather than the full-size circular button, which crowded values into
// truncation.
const MOBILE_HINT_BUTTON_CLASS =
  "h-6 w-6 border-transparent bg-transparent text-muted-foreground hover:border-transparent hover:bg-transparent hover:text-foreground dark:text-muted-foreground";

function renderMetricLabel(metric: HeroTertiaryMetricViewModel, mobile = false): React.ReactNode {
  const label = mobile ? (metric.mobileLabel ?? metric.label) : metric.label;
  if (!metric.methodologyTopic) return label;
  if (!mobile) return <MethodologyLabel topic={metric.methodologyTopic}>{label}</MethodologyLabel>;
  return (
    <span className="inline-flex items-center gap-1">
      <span>{label}</span>
      <MethodologyHint topic={metric.methodologyTopic} buttonClassName={MOBILE_HINT_BUTTON_CLASS} />
    </span>
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

/**
 * The dossier's one identity header, at every width: logo, ticker and name
 * (plus the variant chip), the one-line description, then the action cluster
 * [Bluechip] · [resource links] · [compare/flag/share]. Below `lg` the Safety
 * Score card is far down the scroll, so the grade sits beside the name; at
 * `lg+` the summary rail owns it. Rendered by the detail page above the
 * content/rail grid (not inside HeroCard) so the rail top-aligns with the card.
 */
/**
 * Neutral provenance for the dossier: when the detail snapshot was produced. Never
 * colored; material staleness is the page's public health banner, not this stamp.
 */
function HeroUpdatedStamp({ updatedAtMs, className }: { updatedAtMs: number; className?: string }) {
  const hydrated = useHydrated();
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  if (updatedAtMs <= 0) return null;
  // Keep the stamp's row while the relative age awaits the reader's clock.
  const age = hydrated ? formatRelativeAgeSeconds((nowMs - updatedAtMs) / 1000, { nowLabel: "just now" }) : "—";
  return (
    <p className={cn("text-xs text-muted-foreground", className)} title={formatDataHealthTimestamp(updatedAtMs)}>
      Updated {age}
    </p>
  );
}

export function HeroIdentityHeader({
  heading,
  model,
  onOpenFeedback,
  gradeRead = "settled",
  updatedAtMs = 0,
}: {
  /** The page's h1 text: `{name} ({SYMBOL})`, or the name alone when they match. */
  heading?: string;
  model: HeroCardViewModel;
  onOpenFeedback: () => void;
  /** The report-card read behind the mobile grade: placeholder while pending, "Grade unavailable" on failure. */
  gradeRead?: "settled" | "pending" | "failed";
  /** Detail snapshot generation (ms); 0 hides the stamp. */
  updatedAtMs?: number;
}) {
  const { coin, logoSrc, header, reportCard, verdict, variantParent, variantChipClass } = model;
  const links = (coin.links ?? []).slice(0, 3);
  const verdictId = isHeroVerdictShown(verdict) ? `hero-verdict-${coin.id}` : null;
  // 44px tap targets below lg, the compact 32px cluster at lg+.
  const actionClass =
    "pharos-focus-ring inline-flex size-11 items-center justify-center rounded-md border border-border/60 bg-card text-muted-foreground transition-colors hover:border-border hover:bg-muted/60 hover:text-foreground lg:size-8";

  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between lg:gap-5">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-3">
          {/* Content-sized (no flex-grow) so the morph from a linking row
              lands on the identity itself, not on the full header width. */}
          <StablecoinIdentityTransition id={coin.id}>
            <div className="flex min-w-0 items-center gap-3">
              <StablecoinLogo src={logoSrc} name={coin.name} size={STABLECOIN_DETAIL_IDENTITY_LOGO_SIZE} />
              <div className="flex min-w-0 flex-col gap-1 lg:flex-row lg:items-center lg:gap-3">
                {coin.name.trim().toLowerCase() === coin.symbol.trim().toLowerCase() ? null : (
                  <span className="pharos-label shrink-0">
                    {coin.symbol}
                  </span>
                )}
                <h1
                  className="pharos-page-title min-w-0 break-words text-xl leading-tight tracking-normal sm:text-2xl lg:truncate lg:leading-none"
                  {...(verdictId ? { "aria-describedby": verdictId } : {})}
                >
                  {coin.name}
                  {/* The symbol label sits beside the heading, so the
                      "(SYMBOL)" part of the page heading stays screen-reader only. */}
                  {heading && heading !== coin.name ? <span className="sr-only"> ({coin.symbol})</span> : null}
                </h1>
              </div>
            </div>
          </StablecoinIdentityTransition>
          <HeroVariantChip variantParent={variantParent} variantChipClass={variantChipClass} />
          <div className="ml-auto shrink-0 self-stretch lg:hidden">
            <SafetyGradeHero reportCard={reportCard} savedGrade={model.savedGrade} read={gradeRead} mobile />
          </div>
        </div>
        {coin.oneLiner ? (
          <p className="mt-2 max-w-none text-pretty text-sm leading-relaxed text-muted-foreground">{coin.oneLiner}</p>
        ) : null}
      </div>
      {/* At lg+ the stamp sits bottom-right, level with the one-liner, so it adds no row. */}
      <div className="contents lg:flex lg:shrink-0 lg:flex-col lg:items-end lg:justify-between lg:gap-2 lg:self-stretch">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5 lg:grid-cols-[8rem_auto] lg:pt-1">
          {/* The live badge has its own cell so it cannot move the actions. */}
          <div className="flex min-h-11 min-w-0 items-center gap-1.5 lg:min-h-8">
            <BluechipHeaderBadge stablecoinId={coin.id} />
            <span aria-hidden="true" className="mx-1 hidden h-4 w-px shrink-0 bg-border/60 sm:block sm:first:hidden" />
          </div>
          <div className="flex items-center gap-1.5">
            {links.map((link) => {
              const Icon = linkIconFor(link.label);
              return (
                <a
                  key={link.url}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  // Below sm the in-flow Key Links card carries these, so the
                  // action row stays on one line.
                  className={cn(actionClass, "hidden sm:inline-flex")}
                  aria-label={link.label}
                  title={link.label}
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                </a>
              );
            })}
            {links.length > 0 ? <span aria-hidden="true" className="mx-1 hidden h-4 w-px bg-border/60 sm:block" /> : null}
            <IntentLink
              href={header.compareHref}
              className={actionClass}
              aria-label={header.benchmarkSymbol ? `Compare vs ${header.benchmarkSymbol}` : "Compare"}
              title={header.benchmarkSymbol ? `Compare vs ${header.benchmarkSymbol}` : "Compare"}
            >
              <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden="true" />
            </IntentLink>
            <button
              type="button"
              onClick={onOpenFeedback}
              className={actionClass}
              aria-label="Report issue"
              title="Report issue"
            >
              <Flag className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            {/* Labelled with a full-size target below lg; the compact icon at lg+. */}
            <span className="lg:hidden">
              <ShareButton ogPath={`/api/og/stablecoin/${header.coinId}`} label="Share" />
            </span>
            <span className="hidden lg:flex">
              <ShareButton ogPath={`/api/og/stablecoin/${header.coinId}`} label="Share" iconOnly />
            </span>
          </div>
          <HeroUpdatedStamp updatedAtMs={updatedAtMs} className="col-span-2 text-right lg:hidden" />
        </div>
        <HeroUpdatedStamp updatedAtMs={updatedAtMs} className="hidden lg:block" />
      </div>
    </div>
  );
}

function HeroCaseStudyCallout({ callout }: { callout: NonNullable<HeroCardViewModel["caseStudyCallout"]> }) {
  return (
    <IntentLink
      href={callout.href}
      aria-label={`Read the case study: ${callout.title} (outcome: ${callout.outcomeLabel})`}
      className="pharos-focus-ring group flex flex-col gap-2 rounded-b-xl border-t border-border/60 bg-muted/25 px-4 py-3 transition-colors hover:bg-muted/45 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:px-5"
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <BookOpen aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="pharos-label shrink-0">Case study</span>
        <span aria-hidden="true" className="hidden h-3 w-px shrink-0 bg-border sm:block" />
        <span className="min-w-0 text-sm font-medium leading-snug text-foreground sm:truncate">{callout.title}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2 pl-6 sm:pl-0">
        <Badge
          variant="outline"
          className={`px-1.5 py-0 text-3xs font-semibold uppercase ${callout.outcomeChipClass}`}
        >
          {callout.outcomeLabel}
        </Badge>
        <ArrowRight
          aria-hidden="true"
          className="h-4 w-4 text-muted-foreground transition-all group-hover:translate-x-0.5 group-hover:text-foreground motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
        />
      </span>
    </IntentLink>
  );
}

export function HeroCard({ model }: HeroCardProps) {
  const {
    coin,
    coinData,
    verdict,
    price,
    market,
    peg,
  } = model;
  const tertiaryMetrics = model.tertiaryMetrics.map(toMetricConfig);
  const desktopTertiaryMetrics = model.desktopTertiaryMetrics.map(toMetricConfig);
  const sectionBaseProps: HeroSectionBaseProps = {
    coin,
    coinData,
    price,
    market,
    peg,
  };

  return (
    <Card className="pharos-card-shell gap-0 py-0">
      <HeroChipRail coin={coin} verdict={verdict} />
      <HeroCardMobileSection {...sectionBaseProps} tertiaryMetrics={tertiaryMetrics} />
      <HeroCardDesktopSection
        {...sectionBaseProps}
        tertiaryMetrics={desktopTertiaryMetrics}
      />
      <HeroPassportStrip items={model.passportItems} compactDesktop />
      {model.caseStudyCallout ? <HeroCaseStudyCallout callout={model.caseStudyCallout} /> : null}
    </Card>
  );
}
