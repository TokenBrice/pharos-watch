"use client";

import Link from "next/link";
import { Snowflake } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { BluechipHeaderBadge } from "@/components/bluechip-header-badge";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import {
  BACKING_LABELS,
  GOVERNANCE_LABELS,
  PEG_LABELS,
  PEG_LABELS_SHORT,
} from "@shared/lib/classification";
import { pegCurrencySymbol } from "@shared/lib/format";
import { getInfrastructureLabel } from "@shared/lib/infrastructure";
import { REPORT_CARD_GRADE_COLORS } from "@shared/lib/report-cards";
import { BLACKLIST_STABLECOINS } from "@shared/types/market";
import type {
  Infrastructure,
  ReportCard,
  StablecoinMeta,
} from "@shared/types";
import { getFreezableLabel } from "@/lib/blacklist-status";
import { buildPegLandingUrl } from "@/lib/peg-landing";
import {
  buildBackingTaxonomyUrl,
  buildGovernanceTaxonomyUrl,
} from "@/lib/stablecoin-taxonomy";
import { buildStablecoinUrl } from "@/lib/urls";
import { useLogos } from "@/hooks/use-logos";
import { isHeroVerdictEnabled } from "@/lib/feature-flags";

function HeroTagList({ tags }: { tags: readonly string[] | undefined }) {
  if (!tags || tags.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
        >
          {tag}
        </span>
      ))}
    </div>
  );
}

function InfrastructureBadge({ value }: { value: Infrastructure }) {
  const label = getInfrastructureLabel(value);
  const isM0 = value === "m0";
  const colorClass = isM0
    ? "text-violet-700 dark:text-violet-400"
    : "text-frost-blue";
  const borderClass = isM0
    ? "border-violet-500/30 bg-violet-500/10"
    : "border-frost-blue/30 bg-frost-blue/10";

  return (
    <div className={`flex items-center gap-2 rounded-full border ${borderClass} px-2.5 py-0.5 text-[11px]`}>
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Infrastructure
      </span>
      <span className={`text-[11px] font-semibold font-mono ${colorClass}`}>{label}</span>
    </div>
  );
}

function HeroClassificationLine({
  coin,
  infrastructures,
}: {
  coin: StablecoinMeta;
  infrastructures: Infrastructure[];
}) {
  const pegHref = buildPegLandingUrl(coin.flags.pegCurrency);
  const governanceHref = buildGovernanceTaxonomyUrl(coin.flags.governance);
  const backingHref = buildBackingTaxonomyUrl(coin.flags.backing);
  const governanceLabel = GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance;
  const backingLabel = BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing;
  const pegLabel = PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency;

  const pillClass =
    "pharos-focus-ring inline-flex items-center rounded-full border border-border/50 bg-background/60 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground";

  const showPegBadge =
    coin.flags.pegCurrency !== "USD"
    && coin.flags.pegCurrency !== "VAR"
    && coin.flags.pegCurrency !== "OTHER"
    && coin.flags.pegCurrency !== "GOLD"
    && coin.flags.pegCurrency !== "SILVER";

  return (
    <p className="flex flex-wrap items-center gap-1.5">
      <Link
        href={governanceHref}
        className={pillClass}
        aria-label={`Browse ${governanceLabel} stablecoins`}
      >
        {governanceLabel}
      </Link>
      <Link
        href={backingHref}
        className={pillClass}
        aria-label={`Browse ${backingLabel} stablecoins`}
      >
        {backingLabel}
      </Link>
      {pegHref ? (
        <Link href={pegHref} className={pillClass} aria-label={`Browse ${pegLabel} stablecoins`}>
          {pegLabel}
        </Link>
      ) : (
        <span className={pillClass}>{pegLabel}</span>
      )}
      {showPegBadge && (
        <span
          aria-label={`Pegged to ${PEG_LABELS[coin.flags.pegCurrency] ?? coin.flags.pegCurrency} — tracks 1.00 ${coin.flags.pegCurrency}`}
          className="inline-flex items-center rounded-full border border-purple-500/30 bg-purple-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-purple-700 dark:text-purple-300"
        >
          Tracks {pegCurrencySymbol(coin.flags.pegCurrency)}1.00
        </span>
      )}
      {infrastructures.map((value) => (
        <InfrastructureBadge key={value} value={value} />
      ))}
    </p>
  );
}

export function SafetyGradeHero({
  reportCard,
  mobile = false,
}: {
  reportCard: ReportCard | null;
  mobile?: boolean;
}) {
  if (!reportCard || reportCard.isDefunct) {
    return (
      <div
        className={`flex flex-col items-center justify-center rounded-xl border border-border/60 bg-background/50 ${
          mobile ? "px-3 py-2" : "px-4 py-3"
        }`}
      >
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Safety
        </span>
        <span className="text-lg font-bold text-muted-foreground">—</span>
      </div>
    );
  }

  const sizeClasses = mobile ? "text-3xl px-3 py-1.5" : "text-5xl px-6 py-3";

  return (
    <div
      className={`flex flex-col items-center justify-center rounded-xl border-2 border-border/60 bg-background/50 ${
        mobile ? "gap-1 px-3 py-2" : "gap-2.5 px-5 py-4"
      }`}
    >
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Safety Grade
      </span>
      <Badge
        variant="outline"
        className={`${sizeClasses} font-extrabold tracking-tight ${REPORT_CARD_GRADE_COLORS[reportCard.overallGrade]}`}
      >
        {reportCard.overallGrade}
      </Badge>
      {reportCard.overallScore !== null && (
        <span
          className={`font-mono tabular-nums tracking-tight text-foreground ${
            mobile ? "text-sm" : "text-lg"
          }`}
        >
          {reportCard.overallScore}
          <span className="text-xs text-muted-foreground">/100</span>
        </span>
      )}
    </div>
  );
}

function HeroVariantChip({
  variantParent,
  variantChipClass,
  mobile = false,
}: {
  variantParent?: StablecoinMeta | null;
  variantChipClass?: string | null;
  mobile?: boolean;
}) {
  const { data: logos } = useLogos();
  if (!variantParent || !variantChipClass) return null;
  return (
    <Link
      href={buildStablecoinUrl(variantParent.id)}
      aria-label={`Variant of ${variantParent.name} — wraps ${variantParent.symbol}`}
      className={`pharos-focus-ring inline-flex items-center gap-1.5 rounded-full border font-semibold ${variantChipClass} ${
        mobile ? "mt-1 px-2 py-1 text-[11px]" : "px-3 py-1 text-xs"
      }`}
    >
      <StablecoinLogo src={logos?.[variantParent.id]} name={variantParent.name} size={mobile ? 14 : 16} />
      <span>Wraps {variantParent.symbol}</span>
      <span aria-hidden>→</span>
    </Link>
  );
}

interface HeroIdentityProps {
  coin: StablecoinMeta;
  logoSrc?: string;
  variantParent?: StablecoinMeta | null;
  variantChipClass?: string | null;
  infrastructures: Infrastructure[];
  reportCard?: ReportCard | null;
}

function FreezablePill({
  coin,
  reportCard,
}: {
  coin: StablecoinMeta;
  reportCard?: ReportCard | null;
}) {
  if (!reportCard) return null;
  const status = reportCard.rawInputs.canBeBlacklisted;
  const label = status === false ? "Unfreezable" : getFreezableLabel(status);
  if (label === null) return null;
  let ariaLabel: string;
  let toneClass: string;
  switch (status) {
    case true:
      ariaLabel = "Freezable — issuer can freeze, block, or seize balances";
      toneClass = "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400";
      break;
    case "dilutable":
      ariaLabel = "Dilutable — issuer can mint or dilute balances rather than freeze them";
      toneClass = "border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-400";
      break;
    case "possible":
      ariaLabel =
        "Possible freeze — admin surfaces could enable freezing but no active address-level freezing is confirmed";
      toneClass = "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400";
      break;
    case "inherited":
      ariaLabel = "Upstream freeze — freezing is inherited from an upstream issuer or collateral asset";
      toneClass = "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400";
      break;
    case false:
      ariaLabel = "Unfreezable — no issuer-level freeze, block, or seize capability";
      toneClass = "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
      break;
    default:
      return null;
  }
  const href = (BLACKLIST_STABLECOINS as readonly string[]).includes(coin.symbol)
    ? "#blacklist"
    : `/blacklist?coin=${coin.symbol}`;
  return (
    <Link
      href={href}
      aria-label={ariaLabel}
      className={`pharos-focus-ring inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${toneClass}`}
    >
      <Snowflake className="h-3 w-3" aria-hidden />
      {label}
    </Link>
  );
}

export function HeroMobileIdentity({
  coin,
  logoSrc,
  variantParent,
  variantChipClass,
  infrastructures,
  reportCard,
}: HeroIdentityProps) {
  const heroVerdictEnabled = isHeroVerdictEnabled();
  const verdictId = `hero-verdict-${coin.id}`;
  const showVerdict = heroVerdictEnabled && !!coin.oneLiner;
  return (
    <>
      <StablecoinLogo src={logoSrc} name={coin.name} size={48} />
      <div className="min-w-0 flex-1">
        <h2
          className="text-2xl font-black tracking-tighter"
          {...(showVerdict ? { "aria-describedby": verdictId } : {})}
        >
          {coin.name}
        </h2>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-sm font-mono text-muted-foreground">{coin.symbol}</span>
          <BluechipHeaderBadge stablecoinId={coin.id} />
          <HeroVariantChip variantParent={variantParent} variantChipClass={variantChipClass} mobile />
          <FreezablePill coin={coin} reportCard={reportCard} />
        </div>
        <HeroClassificationLine coin={coin} infrastructures={infrastructures} />
        {showVerdict ? (
          <p
            id={verdictId}
            className="mt-2 text-sm italic leading-snug text-foreground/80 max-w-prose"
          >
            {coin.oneLiner}
          </p>
        ) : null}
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <HeroTagList tags={coin.tags} />
        </div>
      </div>
    </>
  );
}

export function HeroDesktopIdentity({
  coin,
  logoSrc,
  variantParent,
  variantChipClass,
  infrastructures,
  reportCard,
}: HeroIdentityProps) {
  const heroVerdictEnabled = isHeroVerdictEnabled();
  const verdictId = `hero-verdict-${coin.id}`;
  const showVerdict = heroVerdictEnabled && !!coin.oneLiner;
  return (
    <div className="flex items-start gap-3">
      <StablecoinLogo src={logoSrc} name={coin.name} size={64} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-3">
          <h2
            className="text-3xl font-black tracking-tighter"
            {...(showVerdict ? { "aria-describedby": verdictId } : {})}
          >
            {coin.name}
          </h2>
          <span className="text-base font-mono text-muted-foreground/70">{coin.symbol}</span>
          <BluechipHeaderBadge stablecoinId={coin.id} />
          <HeroVariantChip variantParent={variantParent} variantChipClass={variantChipClass} />
          <FreezablePill coin={coin} reportCard={reportCard} />
        </div>
        <div className="mt-1 flex items-center gap-3">
          <HeroClassificationLine coin={coin} infrastructures={infrastructures} />
        </div>
        {showVerdict ? (
          <p
            id={verdictId}
            className="mt-2 text-sm italic leading-snug text-foreground/80 max-w-prose"
          >
            {coin.oneLiner}
          </p>
        ) : null}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <HeroTagList tags={coin.tags} />
        </div>
      </div>
    </div>
  );
}
