"use client";

import { useEffect, useState } from "react";
import { IntentLink } from "@/components/intent-link";
import { ArrowLeftRight, ArrowRight, Bell, BookOpen, Flag } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { MethodologyHint, MethodologyLabel } from "@/components/methodology-hint";
import { ShareButton } from "@/components/share-button";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { StablecoinIdentityTransition } from "@/components/view-transitions";
import { STABLECOIN_DETAIL_IDENTITY_LOGO_SIZE } from "@/components/stablecoin-detail/constants";
import { formatDataHealthTimestamp } from "@/lib/data-health";
import { useHydrated } from "@/hooks/use-hydrated";
import { formatRelativeAgeSeconds } from "@shared/lib/relative-time";
import { formatShortDate } from "@shared/lib/format";
import { isActiveStablecoinMeta } from "@shared/lib/stablecoins/status";
import { buildSafetyVerdictLine } from "@/lib/stablecoin-detail-hero-metrics";
import { cn } from "@/lib/utils";
import type { HeroCardViewModel, HeroTertiaryMetricViewModel } from "@/lib/stablecoin-detail-view-model";
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

interface HeroCardProps {
  model: HeroCardViewModel;
  /**
   * The mechanism's own headline figure (a CDP's collateral ratio), read from
   * the Backing KPI. It takes the fourth hero cell for coins without native yield.
   */
  keyMetric?: HeroTertiaryMetricConfig | null;
}

/**
 * The fourth hero figure is chosen by what the coin is, never a fixed slot:
 * native yield vs T-bill for yield-bearing and NAV tokens; otherwise the
 * mechanism's headline (collateral ratio); otherwise 1Y vs USD for non-dollar
 * pegs; otherwise the live depeg warning. "30d Excess" on a coin that pays no
 * yield (it measured a third-party venue) is never shown in the hero.
 */
function resolveFourthMetric(
  model: HeroCardViewModel,
  metrics: HeroTertiaryMetricConfig[],
  keyMetric: HeroTertiaryMetricConfig | null,
): HeroTertiaryMetricConfig | null {
  const nativeYield = model.coin.flags.yieldBearing === true || model.coin.flags.navToken === true;
  const excess = metrics.find((metric) => metric.key === "excess-yield");
  if (nativeYield && excess) return excess;
  if (keyMetric) return keyMetric;
  return metrics.find((metric) => metric.key === "performance-vs-usd")
    ?? metrics.find((metric) => metric.key === "dews")
    ?? null;
}

function renderMetricValue(metric: HeroTertiaryMetricViewModel): React.ReactNode {
  // A first read in flight holds the value's line box without claiming "unavailable".
  if (metric.display.pending) {
    return (
      <span
        aria-hidden="true"
        className="inline-block h-[0.85em] w-[2.5em] animate-pulse rounded-md bg-muted align-middle motion-reduce:animate-none"
      />
    );
  }
  // The DEWS band prints as a word in its band tone, like every other figure.
  return metric.display.value;
}

// The mobile metric tiles carry the help affordance as an inline glyph sized
// to the 24px minimum tap target rather than the full-size circular button; a
// label too long for a narrow tile truncates, never wraps.
const MOBILE_HINT_BUTTON_CLASS =
  "h-6 w-6 border-transparent bg-transparent text-muted-foreground hover:border-transparent hover:bg-transparent hover:text-foreground dark:text-muted-foreground";

function renderMetricLabel(metric: HeroTertiaryMetricViewModel, mobile = false): React.ReactNode {
  const label = mobile ? (metric.mobileLabel ?? metric.label) : metric.label;
  if (!metric.methodologyTopic) return label;
  if (!mobile) return <MethodologyLabel topic={metric.methodologyTopic}>{label}</MethodologyLabel>;
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="truncate">{label}</span>
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
  };
}

/**
 * The ShareButton (the row's one menu trigger) is an outline Button with its
 * own drop shadow and surface; beside the hero's pill actions it takes their
 * border, surface, ink, padding and flat elevation, so the row reads as one set.
 */
const SHARE_BUTTON_MATCH_CLASS =
  "[&>[aria-haspopup=menu]]:border-border/70 [&>[aria-haspopup=menu]]:bg-card [&>[aria-haspopup=menu]]:px-3 [&>[aria-haspopup=menu]]:text-foreground/85 [&>[aria-haspopup=menu]]:shadow-none";

/**
 * The dossier's one identity header, at every width: logo, ticker and name
 * (plus the variant chip), the one-line description and, below `xl`, the
 * captioned grade with its one-line reason; then the labelled actions
 * (Alerts · Compare · Share) and the quiet Report-a-data-issue control. No
 * external rating sits beside the Pharos grade. At `xl` the summary rail
 * owns the grade. Rendered by the detail page above the content/rail grid
 * (not inside HeroCard) so the rail top-aligns with the card.
 */
/**
 * Neutral provenance for the dossier: when the detail snapshot was produced. Never
 * colored; material staleness is the page's public health banner, not this stamp.
 * A designed daily-history fallback names its day instead of an age: it is a daily
 * snapshot, not a refresh that ran hours ago (ADR-42).
 */
function HeroUpdatedStamp({ updatedAtMs, dailySnapshot = false, className }: {
  updatedAtMs: number;
  dailySnapshot?: boolean;
  className?: string;
}) {
  const hydrated = useHydrated();
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  if (updatedAtMs <= 0) return null;
  // Keep the stamp's row while the relative age awaits the reader's clock.
  const text = dailySnapshot
    ? `Daily snapshot of ${formatShortDate(new Date(updatedAtMs), { utc: true })}`
    : `Updated ${hydrated ? formatRelativeAgeSeconds((nowMs - updatedAtMs) / 1000, { nowLabel: "just now" }) : "—"}`;
  return (
    <p className={cn("text-xs text-muted-foreground", className)} title={formatDataHealthTimestamp(updatedAtMs)}>
      {text}
    </p>
  );
}

export function HeroIdentityHeader({
  heading,
  model,
  onOpenFeedback,
  gradeRead = "settled",
  updatedAtMs = 0,
  dailySnapshot = false,
  hasSummary = false,
}: {
  /** The page's h1 text: `{name} ({SYMBOL})`, or the name alone when they match. */
  heading?: string;
  model: HeroCardViewModel;
  onOpenFeedback: () => void;
  /** The report-card read behind the mobile grade: placeholder while pending, "Grade unavailable" on failure. */
  gradeRead?: "settled" | "pending" | "failed";
  /** Detail snapshot generation (ms); 0 hides the stamp. */
  updatedAtMs?: number;
  /** The generation is the designed daily-history fallback; the stamp names its day. */
  dailySnapshot?: boolean;
  /**
   * An editorial summary follows the hero and opens with the same sentence, so
   * on a phone the one-liner yields its two lines to the metrics.
   */
  hasSummary?: boolean;
}) {
  const { coin, logoSrc, header, reportCard, verdict, variantParent, variantChipClass } = model;
  const verdictId = model.state || isHeroVerdictShown(verdict) ? `hero-verdict-${coin.id}` : null;
  const verdictLine = buildSafetyVerdictLine(reportCard);
  // Labelled actions: what a holder does next (alerts, compare, share), then
  // the quiet report-issue control. Resource links live in Key links.
  // One row at every width: only the compare label gives way (truncates).
  const labelledActionClass =
    "pharos-focus-ring inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-card px-3 text-sm font-medium text-foreground/85 transition-colors hover:border-border hover:bg-muted/60 hover:text-foreground lg:min-h-9 lg:rounded-md";
  const iconActionClass =
    "pharos-focus-ring inline-flex size-11 shrink-0 items-center justify-center rounded-full border border-border/70 bg-card text-muted-foreground transition-colors hover:border-border hover:bg-muted/60 hover:text-foreground lg:size-9 lg:rounded-md";

  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
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
          {/* From sm the variant chip shares the name's row; below it the chip
              takes its own row, so the name never breaks letter by letter. */}
          {variantParent && variantChipClass ? (
            <div className="hidden min-w-0 sm:flex">
              <HeroVariantChip variantParent={variantParent} variantChipClass={variantChipClass} />
            </div>
          ) : null}
          {/* Below xl the summary rail is absent, so the grade sits beside the name. */}
          <div className="ml-auto shrink-0 self-stretch xl:hidden">
            <SafetyGradeHero reportCard={reportCard} savedGrade={model.savedGrade} read={gradeRead} mobile />
          </div>
        </div>
        {variantParent && variantChipClass ? (
          <div className="sm:hidden">
            <HeroVariantChip variantParent={variantParent} variantChipClass={variantChipClass} mobile />
          </div>
        ) : null}
        {coin.oneLiner ? (
          <p
            className={cn(
              "mt-2 text-pretty text-sm leading-relaxed text-muted-foreground",
              hasSummary && "hidden sm:block",
            )}
          >
            {coin.oneLiner}
          </p>
        ) : null}
        {verdictLine ? (
          // The grade's reason, beside it wherever the rail is absent. Inline
          // text with the separator bound by no-break spaces, so a wrap never
          // leaves it at a line's end or start.
          <p className="mt-2 text-sm leading-snug xl:hidden" data-safety-verdict-line>
            <span className="font-medium text-foreground">{verdictLine.lead}</span>
            <span aria-hidden="true" className="text-muted-foreground/60">{"\u00a0·\u00a0"}</span>
            <span className="text-muted-foreground">{verdictLine.detail}</span>
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col gap-2 lg:items-end">
        <div className={cn("flex items-center gap-2", SHARE_BUTTON_MATCH_CLASS)}>
          {isActiveStablecoinMeta(coin) ? (
            <IntentLink
              href="/pharoswatchbot/#getting-started"
              className={labelledActionClass}
              aria-label={`Alerts: get Telegram alerts for ${coin.symbol} depegs and risk changes`}
            >
              <Bell className="size-4" aria-hidden="true" />
              <span>Alerts</span>
            </IntentLink>
          ) : null}
          <IntentLink
            href={header.compareHref}
            className={cn(labelledActionClass, "min-w-0 shrink")}
            aria-label={header.benchmarkSymbol ? `Compare ${coin.symbol} vs ${header.benchmarkSymbol}` : `Compare ${coin.symbol}`}
          >
            <ArrowLeftRight className="size-4 shrink-0" aria-hidden="true" />
            <span className="truncate">{header.benchmarkSymbol ? `vs ${header.benchmarkSymbol}` : "Compare"}</span>
          </IntentLink>
          <ShareButton stablecoinId={header.coinId} label="Share" datedScorecard={reportCard?.ratingStatus === "rated"} />
          <button
            type="button"
            onClick={onOpenFeedback}
            className={iconActionClass}
            aria-label="Report a data issue"
            title="Report a data issue"
          >
            <Flag className="size-4" aria-hidden="true" />
          </button>
        </div>
        <HeroUpdatedStamp updatedAtMs={updatedAtMs} dailySnapshot={dailySnapshot} className="lg:text-right" />
      </div>
    </div>
  );
}

function HeroCaseStudyCallout({ callout }: { callout: NonNullable<HeroCardViewModel["caseStudyCallout"]> }) {
  return (
    // One row at every width: on a phone the label stacks over a title of at
    // most two lines; from sm the title truncates to one.
    <IntentLink
      href={callout.href}
      aria-label={`Read the case study: ${callout.title} (outcome: ${callout.outcomeLabel})`}
      className="pharos-focus-ring group flex items-center gap-3 rounded-b-xl border-t border-border/60 bg-muted/25 px-4 py-3 transition-colors hover:bg-muted/45 sm:px-5"
    >
      <span className="flex min-w-0 flex-1 items-center gap-2.5">
        <BookOpen aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-2.5">
          <span className="pharos-label shrink-0">Case study</span>
          <span aria-hidden="true" className="hidden h-3 w-px shrink-0 bg-border sm:block" />
          <span className="line-clamp-2 min-w-0 text-sm font-medium leading-snug text-foreground sm:line-clamp-1">{callout.title}</span>
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
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

export function HeroCard({ model, keyMetric = null }: HeroCardProps) {
  const {
    coin,
    coinData,
    verdict,
    price,
    market,
    peg,
  } = model;
  // A tile without a reading (no DEWS signal, no peg for a NAV token, no
  // scored liquidity) is left out rather than shown as a dash; the grid lays
  // out the real tiles only.
  const allMetrics = model.tertiaryMetrics
    .filter((metric) => metric.display.pending || metric.display.value !== "—")
    .map(toMetricConfig);
  const fourth = resolveFourthMetric(model, allMetrics, keyMetric);
  // Signals first (DEWS, Peg, Liquidity), then the coin's fourth figure.
  const signalKeys = new Set(["dews", "peg-score", "liquidity"]);
  const tertiaryMetrics = [
    ...allMetrics.filter((metric) => signalKeys.has(metric.key)),
    ...(fourth && !signalKeys.has(fourth.key) ? [fourth] : []),
  ];
  const sectionBaseProps: HeroSectionBaseProps = {
    coin,
    coinData,
    price,
    market,
    peg,
  };

  return (
    <Card className="pharos-card-shell gap-0 py-0">
      <HeroChipRail coin={coin} verdict={verdict} state={model.state} />
      <HeroCardMobileSection {...sectionBaseProps} tertiaryMetrics={tertiaryMetrics} />
      <HeroCardDesktopSection
        {...sectionBaseProps}
        fourthMetric={fourth}
      />
      <HeroPassportStrip items={model.passportItems} pendingKeys={model.passportPendingKeys} compactDesktop />
      {model.caseStudyCallout ? <HeroCaseStudyCallout callout={model.caseStudyCallout} /> : null}
    </Card>
  );
}
