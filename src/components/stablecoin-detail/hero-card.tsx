"use client";

import { useEffect, useState, type ReactNode } from "react";
import { IntentLink } from "@/components/intent-link";
import {
  ArrowLeftRight,
  ArrowRight,
  ArrowUpRight,
  Bell,
  BookOpen,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Flag,
  MoreHorizontal,
  Plus,
  Smartphone,
  Star,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MethodologyHint, MethodologyLabel } from "@/components/methodology-hint";
import { ShareButton } from "@/components/share-button";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { StablecoinIdentityTransition } from "@/components/view-transitions";
import { STABLECOIN_DETAIL_IDENTITY_LOGO_SIZE } from "@/components/stablecoin-detail/constants";
import { copyText } from "@/lib/clipboard";
import { buildComparePrefillUrl } from "@/lib/compare-links";
import { formatDataHealthTimestamp } from "@/lib/data-health";
import { buildPortfolioCoinsHref, encodePortfolioHoldings } from "@/lib/portfolio-codec";
import { useHydrated } from "@/hooks/use-hydrated";
import { usePortfolio } from "@/hooks/use-portfolio";
import { useWatchlist } from "@/hooks/use-watchlist";
import { formatRelativeAgeSeconds } from "@shared/lib/relative-time";
import { formatCurrency, formatShortDate } from "@shared/lib/format";
import { isBlacklistTrackedStablecoinId } from "@shared/lib/blacklist-contract-specs";
import { isActiveStablecoinMeta } from "@shared/lib/stablecoins/status";
import { isClientTokenizedFundId } from "@shared/lib/stablecoins/aggregate-client-registry";
import { CLIENT_TRACKED_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import { isTelegramReservedTargetToken } from "@shared/lib/telegram-command-vocabulary";
import { formatCoinPayload } from "@shared/lib/telegram-mini-app-payloads";
import { PHAROSWATCHBOT_BOT_URL } from "@/lib/telegram-route-constants";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { hasStaticYieldWorkbench } from "@shared/lib/yield-auto-lending";
import { buildSafetyVerdictLine } from "@/lib/stablecoin-detail-hero-metrics";
import type { HeroPassportItemViewModel } from "@/lib/stablecoin-detail-passport";
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
  /**
   * Static reviewed redeemability access model computed server-side so the
   * passport renders immediately while the live redemption lane settles.
   */
  initialRedeemability?: HeroPassportItemViewModel | null;
}

/**
 * The fourth hero figure is chosen by what the coin is, never a fixed slot:
 * 1Y vs USD for non-dollar pegs; otherwise native yield vs T-bill for
 * yield-bearing and NAV tokens; otherwise the mechanism's headline (collateral
 * ratio); otherwise the live depeg warning (hidden at `xl` where the right rail
 * owns DEWS so the desktop hero stays a clean 3-column grid). "30d Excess" on a
 * coin that pays no yield (it measured a third-party venue) is never shown in
 * the hero.
 */
function resolveFourthMetric(
  model: HeroCardViewModel,
  metrics: HeroTertiaryMetricConfig[],
  keyMetric: HeroTertiaryMetricConfig | null,
): HeroTertiaryMetricConfig | null {
  // A non-dollar peg's year against USD outranks its mechanism figure, which the
  // xl rail's Backing KPI still states.
  const performanceVsUsd = metrics.find((metric) => metric.key === "performance-vs-usd");
  if (performanceVsUsd) return performanceVsUsd;
  const nativeYield = model.coin.flags.yieldBearing === true || model.coin.flags.navToken === true;
  const excess = metrics.find((metric) => metric.key === "excess-yield");
  if (nativeYield && excess) return excess;
  if (keyMetric) return keyMetric;
  return metrics.find((metric) => metric.key === "dews") ?? null;
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
    // At xl the right rail's RailSafetySummary already displays DEWS, so the
    // desktop hero collapses cleanly to its 3-column market grid instead of
    // repeating DEWS in the same fold.
    ...(metric.key === "dews" ? { railTwin: true } : {}),
  };
}

const PORTFOLIO_PRESET_AMOUNTS = [1_000, 10_000, 50_000] as const;

function HeroPortfolioAction({
  coinId,
  coinSymbol,
  triggerClassName,
}: {
  coinId: string;
  coinSymbol: string;
  triggerClassName: string;
}) {
  const hydrated = useHydrated();
  const portfolio = usePortfolio("");
  const [open, setOpen] = useState(false);
  const [amountInput, setAmountInput] = useState("10000");

  const hydratedHoldings = hydrated ? portfolio.holdings : [];
  const existing = hydratedHoldings.find((holding) => holding.coinId === coinId) ?? null;
  const portfolioHref = existing !== null
    ? "/portfolio/"
    : buildPortfolioCoinsHref(
        [coinId],
        hydratedHoldings.length > 0 ? encodePortfolioHoldings(hydratedHoldings) : null,
      );

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (nextOpen) {
      setAmountInput(existing ? String(existing.amount) : "10000");
    }
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = Number(amountInput.replaceAll(",", "").trim());
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    if (existing) portfolio.setAmount(coinId, parsed);
    else portfolio.addCoin(coinId, parsed);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={triggerClassName}
          aria-label={existing ? `Edit ${coinSymbol} in portfolio` : `Add ${coinSymbol} to portfolio`}
        >
          {existing ? (
            <Check className="size-4 shrink-0 text-state-positive" aria-hidden="true" />
          ) : (
            <Plus className="size-4 shrink-0" aria-hidden="true" />
          )}
          <span>{existing ? "In portfolio" : "Portfolio"}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3 p-3.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-foreground">
            {existing ? `${coinSymbol} in portfolio` : `Add ${coinSymbol} to portfolio`}
          </p>
          <IntentLink
            href={portfolioHref}
            className="pharos-focus-ring inline-flex items-center gap-0.5 rounded-sm text-xs font-medium text-brand-accent-text underline-offset-2 hover:underline"
          >
            Open
            <ArrowUpRight className="size-3" aria-hidden="true" />
          </IntentLink>
        </div>
        {existing ? (
          <p className="text-xs text-muted-foreground">
            Current position: <span className="font-mono font-medium tabular-nums text-foreground">{formatCurrency(existing.amount)}</span>
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Track {coinSymbol} in your browser-local portfolio to see weighted safety and collateral exposure.
          </p>
        )}
        <div className="flex flex-wrap gap-1.5">
          {PORTFOLIO_PRESET_AMOUNTS.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setAmountInput(String(preset))}
              className={cn(
                "pharos-focus-ring rounded-md border px-2 py-1 font-mono text-xs tabular-nums transition-colors",
                Number(amountInput) === preset
                  ? "border-border bg-muted text-foreground"
                  : "border-border/60 bg-background text-muted-foreground hover:border-border hover:text-foreground",
              )}
            >
              ${preset >= 1000 ? `${preset / 1000}k` : preset}
            </button>
          ))}
        </div>
        <form onSubmit={handleSubmit} className="space-y-2.5">
          <label className="block space-y-1">
            <span className="pharos-label block">USD amount</span>
            <input
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              value={amountInput}
              onChange={(event) => setAmountInput(event.target.value)}
              aria-label={`${coinSymbol} position in USD`}
              className="pharos-focus-ring h-9 w-full rounded-md border border-border/70 bg-background px-2.5 font-mono text-sm tabular-nums text-foreground"
            />
          </label>
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" className="flex-1">
              {existing ? "Update holding" : "Add to portfolio"}
            </Button>
            {existing ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  portfolio.removeCoin(coinId);
                  setOpen(false);
                }}
              >
                Remove
              </Button>
            ) : null}
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

const HERO_TELEGRAM_TARGET_PATTERN = /^[A-Za-z0-9_-]+$/;
const HERO_SYMBOL_COUNT = new Map<string, number>();
for (const entry of CLIENT_TRACKED_STABLECOINS) {
  const key = entry.symbol.toLowerCase();
  HERO_SYMBOL_COUNT.set(key, (HERO_SYMBOL_COUNT.get(key) ?? 0) + 1);
}

function resolveHeroAlertTargetToken(coinId: string, coinSymbol: string): string {
  const trimmed = coinSymbol.trim();
  if (
    HERO_TELEGRAM_TARGET_PATTERN.test(trimmed)
    && !isTelegramReservedTargetToken(trimmed)
    && (HERO_SYMBOL_COUNT.get(trimmed.toLowerCase()) ?? 0) === 1
  ) {
    return trimmed;
  }
  return coinId;
}

interface HeroAlertRecommendation {
  command: string;
  description: string;
  ariaLabel: string;
}

function resolveHeroAlertRecommendation({
  coinId,
  coinSymbol,
  tokenizedFund,
  navToken,
  reserveDriftAlertEligible,
}: {
  coinId: string;
  coinSymbol: string;
  tokenizedFund: boolean;
  navToken: boolean;
  reserveDriftAlertEligible: boolean;
}): HeroAlertRecommendation | null {
  const types: Array<"dews" | "depeg" | "safety" | "reserve" | "freeze"> = [];
  if (!navToken) {
    types.push("dews", "depeg");
  }
  if (!tokenizedFund) {
    types.push("safety");
  }
  if ((tokenizedFund || navToken) && reserveDriftAlertEligible) {
    types.push("reserve");
  }
  if (types.length === 0 && isBlacklistTrackedStablecoinId(coinId)) {
    types.push("freeze");
  }
  if (types.length === 0) return null;

  const key = types.join(",");
  let description: string;
  switch (key) {
    case "dews,depeg,safety":
      description = "Get DEWS stress, depeg, and safety grade changes directly in @PharosWatchBot.";
      break;
    case "dews,depeg,reserve":
      description = "Get DEWS stress, depeg, and live reserve-mix drift alerts directly in @PharosWatchBot.";
      break;
    case "dews,depeg":
      description = "Get DEWS stress and depeg alerts directly in @PharosWatchBot.";
      break;
    case "safety,reserve":
      description = "Get safety grade and live reserve-mix drift alerts directly in @PharosWatchBot.";
      break;
    case "safety":
      description = "Get safety grade changes directly in @PharosWatchBot.";
      break;
    case "reserve":
      description = "Get live reserve-mix drift alerts directly in @PharosWatchBot.";
      break;
    default:
      description = "Get issuer freeze and blacklist alerts directly in @PharosWatchBot.";
      break;
  }

  return {
    command: `/subscribe ${types.join(", ")} ${resolveHeroAlertTargetToken(coinId, coinSymbol)}`,
    description,
    ariaLabel: types.includes("depeg")
      ? `Alerts: get Telegram alerts for ${coinSymbol} depegs and risk changes`
      : `Alerts: get Telegram alerts for ${coinSymbol} risk changes`,
  };
}

function HeroAlertsAction({
  coinId,
  coinSymbol,
  recommendation,
  triggerClassName,
}: {
  coinId: string;
  coinSymbol: string;
  recommendation: HeroAlertRecommendation;
  triggerClassName: string;
}) {
  const [copied, setCopied] = useState(false);
  const subscribeCommand = recommendation.command;
  const deepLink = `${PHAROSWATCHBOT_BOT_URL}?startapp=${formatCoinPayload(coinId)}`;

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function handleCopy() {
    const result = await copyText(subscribeCommand);
    if (result.ok) setCopied(true);
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={triggerClassName}
          aria-label={recommendation.ariaLabel}
        >
          <Bell className="size-4 shrink-0" aria-hidden="true" />
          <span>Alerts</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3 p-3.5">
        <div className="space-y-1">
          <p className="text-sm font-semibold text-foreground">Telegram alerts for {coinSymbol}</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {recommendation.description}
          </p>
        </div>
        <Button asChild size="sm" className="w-full gap-1.5">
          <a href={deepLink} target="_blank" rel="noopener noreferrer">
            <Smartphone className="size-3.5" aria-hidden="true" />
            <span>Follow {coinSymbol} in Mini App</span>
            <ExternalLink className="size-3.5" aria-hidden="true" />
          </a>
        </Button>
        <div className="space-y-1.5 border-t border-border/55 pt-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="pharos-label">Or paste in chat / group</span>
            <IntentLink
              href="/pharoswatchbot/#getting-started"
              className="pharos-focus-ring rounded-sm text-xs font-medium text-brand-accent-text underline-offset-2 hover:underline"
            >
              Setup guide
            </IntentLink>
          </div>
          <div className="flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 p-2">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-foreground">
              {subscribeCommand}
            </code>
            <button
              type="button"
              onClick={() => void handleCopy()}
              aria-label={copied ? "Copied subscribe command" : "Copy subscribe command"}
              className="pharos-focus-ring inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-border/60 bg-card text-muted-foreground transition-colors hover:border-border hover:text-foreground"
            >
              {copied ? (
                <Check className="size-3.5 text-state-positive" aria-hidden="true" />
              ) : (
                <Copy className="size-3.5" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

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

/**
 * The dossier's one identity header, at every width: logo, ticker and name
 * (plus the variant chip), the one-line description and, below `xl`, the
 * captioned grade with its one-line reason; then the holder action bar
 * (Watch, Portfolio, Alerts, split Compare, optional Yield workbench, Share,
 * overflow menu). No external rating sits beside the Pharos grade. At `xl` the
 * summary rail owns the grade. Rendered by the detail page above the
 * content/rail grid (not inside HeroCard) so the rail top-aligns with the card.
 */
export function HeroIdentityHeader({
  heading,
  model,
  onOpenFeedback,
  gradeRead = "settled",
  updatedAtMs = 0,
  dailySnapshot = false,
  hasSummary = false,
  opsStatusSlot = null,
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
  /** Consolidated secondary refresh-status chip rendered beside the update stamp. */
  opsStatusSlot?: ReactNode;
}) {
  const { coin, logoSrc, header, reportCard, verdict, variantParent, variantChipClass } = model;
  const hydrated = useHydrated();
  const watchlist = useWatchlist();
  const watched = hydrated && watchlist.has(coin.id);
  const activeCoin = isActiveStablecoinMeta(coin);
  const isTokenizedFund = activeCoin && isClientTokenizedFundId(coin.id);
  const reserveDriftAlertEligible = "reserveDriftAlertEligible" in coin && coin.reserveDriftAlertEligible === true;
  const alertRecommendation = activeCoin
    ? resolveHeroAlertRecommendation({
        coinId: coin.id,
        coinSymbol: coin.symbol,
        tokenizedFund: isTokenizedFund,
        navToken: coin.flags.navToken === true,
        reserveDriftAlertEligible,
      })
    : null;
  const showYieldWorkbench = hasStaticYieldWorkbench(coin);
  const verdictId = model.state || isHeroVerdictShown(verdict) ? `hero-verdict-${coin.id}` : null;
  const verdictLine = isTokenizedFund ? null : buildSafetyVerdictLine(reportCard);
  const comparePrefillHref = buildComparePrefillUrl([coin.id]);
  // Holder action pills share one border, surface and height across the bar.
  const labelledActionClass =
    "pharos-focus-ring inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-card px-3 text-sm font-medium text-foreground/85 transition-colors hover:border-border hover:bg-muted/60 hover:text-foreground lg:min-h-9 lg:rounded-md";
  const splitCompareLeadClass =
    "pharos-focus-ring inline-flex min-h-11 min-w-0 shrink items-center gap-1.5 rounded-l-full border border-border/70 bg-card pl-3 pr-2.5 text-sm font-medium text-foreground/85 transition-colors hover:border-border hover:bg-muted/60 hover:text-foreground lg:min-h-9 lg:rounded-l-md";
  const splitCompareCaretClass =
    "pharos-focus-ring inline-flex min-h-11 w-10 shrink-0 items-center justify-center rounded-r-full border border-l-0 border-border/70 bg-card text-muted-foreground transition-colors hover:border-border hover:bg-muted/60 hover:text-foreground lg:min-h-9 lg:w-8 lg:rounded-r-md";
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
            <SafetyGradeHero reportCard={reportCard} savedGrade={model.savedGrade} read={gradeRead} mobile tokenizedFund={isTokenizedFund} />
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
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 lg:justify-end">
          <button
            type="button"
            onClick={() => watchlist.toggle(coin.id)}
            aria-pressed={watched}
            aria-label={watched ? `Remove ${coin.symbol} from watchlist` : `Watch ${coin.symbol}`}
            className={labelledActionClass}
          >
            <Star
              className={cn("size-4 shrink-0", watched && "fill-state-warn-solid text-state-warn-solid")}
              aria-hidden="true"
            />
            <span>{watched ? "Watching" : "Watch"}</span>
          </button>
          {activeCoin ? (
            <HeroPortfolioAction coinId={coin.id} coinSymbol={coin.symbol} triggerClassName={labelledActionClass} />
          ) : null}
          {alertRecommendation ? (
            <HeroAlertsAction
              coinId={coin.id}
              coinSymbol={coin.symbol}
              recommendation={alertRecommendation}
              triggerClassName={labelledActionClass}
            />
          ) : null}
          <div className="inline-flex min-w-0 shrink items-center">
            <IntentLink
              href={header.compareHref}
              className={splitCompareLeadClass}
              aria-label={header.benchmarkSymbol ? `Compare ${coin.symbol} vs ${header.benchmarkSymbol}` : `Compare ${coin.symbol}`}
            >
              <ArrowLeftRight className="size-4 shrink-0" aria-hidden="true" />
              <span className="truncate">{header.benchmarkSymbol ? `vs ${header.benchmarkSymbol}` : "Compare"}</span>
            </IntentLink>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={splitCompareCaretClass}
                  aria-label={`More compare options for ${coin.symbol}`}
                >
                  <ChevronDown className="size-4" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {header.benchmarkSymbol ? (
                  <DropdownMenuItem asChild>
                    <IntentLink href={header.compareHref}>
                      Compare {coin.symbol} vs {header.benchmarkSymbol}
                    </IntentLink>
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem asChild>
                  <IntentLink href={comparePrefillHref}>
                    Live compare with…
                  </IntentLink>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {showYieldWorkbench ? (
            <IntentLink
              href={buildStablecoinUrl(coin.id, "yield/")}
              className={labelledActionClass}
              aria-label={`Open ${coin.symbol} yield workbench`}
            >
              <span>Yield workbench</span>
              <ArrowUpRight className="size-3.5 shrink-0" aria-hidden="true" />
            </IntentLink>
          ) : null}
          <ShareButton stablecoinId={header.coinId} label="Share" datedScorecard={!isTokenizedFund && reportCard?.ratingStatus === "rated"} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={iconActionClass}
                aria-label="More actions"
                title="More actions"
              >
                <MoreHorizontal className="size-4" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onOpenFeedback}>
                <Flag className="size-4" aria-hidden="true" />
                <span>Report a data issue</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {opsStatusSlot || updatedAtMs > 0 ? (
          <div className="flex flex-wrap items-center gap-2 lg:justify-end">
            {opsStatusSlot}
            <HeroUpdatedStamp updatedAtMs={updatedAtMs} dailySnapshot={dailySnapshot} className="lg:text-right" />
          </div>
        ) : null}
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

export function HeroCard({ model, keyMetric = null, initialRedeemability = null }: HeroCardProps) {
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
  const hasLiveRedeemability = model.passportItems.some((item) => item.key === "redeemability");
  const useInitialRedeemability =
    !hasLiveRedeemability && initialRedeemability != null && model.passportPendingKeys.includes("redeemability");
  const passportItems = useInitialRedeemability
    ? model.passportItems.length > 0 && model.passportItems[0]!.key === "mechanism"
      ? [model.passportItems[0]!, initialRedeemability, ...model.passportItems.slice(1)]
      : [initialRedeemability, ...model.passportItems]
    : model.passportItems;
  const passportPendingKeys = useInitialRedeemability
    ? model.passportPendingKeys.filter((key) => key !== "redeemability")
    : model.passportPendingKeys;

  return (
    <Card className="pharos-card-shell gap-0 py-0">
      <HeroChipRail coin={coin} verdict={verdict} state={model.state} />
      <HeroCardMobileSection {...sectionBaseProps} tertiaryMetrics={tertiaryMetrics} />
      <HeroCardDesktopSection
        {...sectionBaseProps}
        fourthMetric={fourth}
      />
      <HeroPassportStrip items={passportItems} pendingKeys={passportPendingKeys} compactDesktop />
      {model.caseStudyCallout ? <HeroCaseStudyCallout callout={model.caseStudyCallout} /> : null}
    </Card>
  );
}
