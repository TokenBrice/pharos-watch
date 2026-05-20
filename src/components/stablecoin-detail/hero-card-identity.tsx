"use client";

import Link from "next/link";
import { Snowflake } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { BluechipHeaderBadge } from "@/components/bluechip-header-badge";
import { ScoreBadgeWrapper } from "@/components/score-badge-wrapper";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import {
  BACKING_LABELS,
  GOVERNANCE_LABELS,
  PEG_LABELS,
  PEG_LABELS_SHORT,
  getMechanismArchetypeCtaNoun,
  getMechanismArchetypeLabel,
  getMechanismExplainerPath,
  resolveMechanismArchetype,
} from "@shared/lib/classification";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { pegCurrencySymbol } from "@shared/lib/format";
import { getInfrastructureLabel } from "@shared/lib/infrastructure";
import { REPORT_CARD_GRADE_COLORS } from "@shared/lib/report-cards";
import { BLACKLIST_STABLECOINS } from "@shared/types/market";
import type {
  Infrastructure,
  ReportCard,
  StablecoinMeta,
} from "@shared/types";
import type { StablecoinVerdict } from "@shared/lib/stablecoin-verdict";
import { getFreezableLabel } from "@/lib/blacklist-status";
import { buildPegLandingUrl } from "@/lib/peg-landing";
import {
  buildBackingTaxonomyUrl,
  buildGovernanceTaxonomyUrl,
} from "@/lib/stablecoin-taxonomy";
import { buildStablecoinUrl } from "@/lib/urls";
import { useLogos } from "@/hooks/use-logos";
import { isHeroVerdictEnabled } from "@/lib/feature-flags";
import { VerdictPill } from "@/components/stablecoin-detail/verdict-pill";

function MechanismChip({ coin }: { coin: StablecoinMeta }) {
  const archetype = resolveMechanismArchetype(coin, TRACKED_META_BY_ID);
  if (!archetype) return null;
  return (
    <Link
      href={getMechanismExplainerPath(archetype)}
      aria-label={`Learn how ${getMechanismArchetypeCtaNoun(archetype)} stablecoins work`}
      className="pharos-focus-ring inline-flex min-h-6 items-center rounded-full border border-border/50 bg-muted/30 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground"
    >
      {getMechanismArchetypeLabel(archetype)}
    </Link>
  );
}

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

const GOVERNANCE_SENTENCE_LABELS: Record<StablecoinMeta["flags"]["governance"], string> = {
  centralized: "centralized",
  "centralized-dependent": "CeFi-dependent",
  decentralized: "decentralized",
};

const BACKING_SENTENCE_LABELS: Record<StablecoinMeta["flags"]["backing"], string> = {
  "rwa-backed": "RWA-backed",
  "crypto-backed": "Crypto-backed",
  algorithmic: "algorithmic",
};

function HeroClassificationLine({
  coin,
  infrastructures,
  stackedSegments = false,
}: {
  coin: StablecoinMeta;
  infrastructures: Infrastructure[];
  stackedSegments?: boolean;
}) {
  const pegHref = buildPegLandingUrl(coin.flags.pegCurrency);
  const governanceHref = buildGovernanceTaxonomyUrl(coin.flags.governance);
  const backingHref = buildBackingTaxonomyUrl(coin.flags.backing);
  const governanceFullLabel = GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance;
  const backingFullLabel = BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing;
  const pegShortLabel = PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency;

  const isNonUsdPeg = coin.flags.pegCurrency !== "USD";
  const isAlgorithmic = coin.flags.backing === "algorithmic";
  const isDecentralized = coin.flags.governance === "decentralized";

  const showPegBadge =
    isNonUsdPeg
    && coin.flags.pegCurrency !== "VAR"
    && coin.flags.pegCurrency !== "OTHER"
    && coin.flags.pegCurrency !== "GOLD"
    && coin.flags.pegCurrency !== "SILVER";

  const sentenceSegments: { key: string; label: string; href: string | null; aria: string }[] = [];
  if (!isNonUsdPeg) {
    sentenceSegments.push({
      key: "peg",
      label: "USD-pegged",
      href: pegHref,
      aria: `Browse ${pegShortLabel} stablecoins`,
    });
  }
  if (!isAlgorithmic) {
    sentenceSegments.push({
      key: "backing",
      label: BACKING_SENTENCE_LABELS[coin.flags.backing],
      href: backingHref,
      aria: `Browse ${backingFullLabel} stablecoins`,
    });
  }
  if (!isDecentralized) {
    sentenceSegments.push({
      key: "governance",
      label: GOVERNANCE_SENTENCE_LABELS[coin.flags.governance],
      href: governanceHref,
      aria: `Browse ${governanceFullLabel} stablecoins`,
    });
  }

  const segmentLinkClass =
    "pharos-focus-ring rounded-sm underline-offset-2 transition-colors hover:text-foreground hover:underline";
  const pillClass =
    "pharos-focus-ring inline-flex items-center rounded-full border border-border/50 bg-background/60 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground";
  const sentenceNode =
    sentenceSegments.length > 0 ? (
      stackedSegments ? (
        <span className="flex flex-col items-start leading-relaxed">
          {sentenceSegments.map((segment) => (
            <span key={segment.key} className="block">
              {segment.href ? (
                <Link href={segment.href} className={segmentLinkClass} aria-label={segment.aria}>
                  {segment.label}
                </Link>
              ) : (
                <span>{segment.label}</span>
              )}
            </span>
          ))}
        </span>
      ) : (
        <span className="inline-flex flex-wrap items-baseline">
          {sentenceSegments.map((segment, index) => (
            <span key={segment.key} className="inline">
              {index > 0 && <span aria-hidden>, </span>}
              {segment.href ? (
                <Link href={segment.href} className={segmentLinkClass} aria-label={segment.aria}>
                  {segment.label}
                </Link>
              ) : (
                <span>{segment.label}</span>
              )}
            </span>
          ))}
        </span>
      )
    ) : null;
  const taxonomyNodes = (
    <>
      {isDecentralized && (
        <Link
          href={governanceHref}
          className={pillClass}
          aria-label={`Browse ${governanceFullLabel} stablecoins`}
        >
          Decentralized
        </Link>
      )}
      {isAlgorithmic && (
        <Link
          href={backingHref}
          className={pillClass}
          aria-label={`Browse ${backingFullLabel} stablecoins`}
        >
          Algorithmic
        </Link>
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
    </>
  );

  if (stackedSegments) {
    return (
      <p className="text-xs text-muted-foreground">
        {sentenceNode}
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          {taxonomyNodes}
        </span>
      </p>
    );
  }

  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      {sentenceNode}
      {taxonomyNodes}
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
          mobile ? "h-full min-w-[9rem] px-2.5 py-2.5" : "px-4 py-3"
        }`}
      >
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Safety
        </span>
        <span className="text-lg font-bold text-muted-foreground">—</span>
      </div>
    );
  }

  const sizeClasses = mobile ? "px-3 py-1.5 text-[2rem] leading-none" : "text-5xl px-6 py-3";

  return (
    <div
      className={`flex flex-col items-center rounded-xl border-2 border-border/60 bg-background/50 ${
        mobile
          ? "h-full min-w-[9rem] justify-between gap-2 px-2.5 py-2.5"
          : "justify-center gap-2.5 px-5 py-4"
      }`}
    >
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Safety Grade
      </span>
      <ScoreBadgeWrapper topic="safetyScore" variant="tooltip-only">
        <Badge
          variant="outline"
          className={`${sizeClasses} font-extrabold tracking-tight ${REPORT_CARD_GRADE_COLORS[reportCard.overallGrade]}`}
        >
          {reportCard.overallGrade}
        </Badge>
      </ScoreBadgeWrapper>
      {reportCard.overallScore !== null && (
        <span
          className={`font-mono tabular-nums tracking-tight text-foreground ${
            mobile ? "text-base leading-none" : "text-lg"
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
  verdict: StablecoinVerdict;
}

interface HeroMobileIdentityDetailsProps {
  coin: StablecoinMeta;
  infrastructures: Infrastructure[];
  includeClassification?: boolean;
}

// Exported for unit testing; rendered indirectly via HeroMobileIdentity / HeroDesktopIdentity.
export function FreezablePill({
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
      className={`pharos-focus-ring inline-flex min-h-11 items-center gap-1 rounded-full border px-3 py-2 text-[11px] font-semibold sm:min-h-0 sm:px-2.5 sm:py-0.5 ${toneClass}`}
    >
      <Snowflake className="h-3 w-3" aria-hidden />
      {label}
    </Link>
  );
}

/**
 * Standalone verdict pill. Rendered separately from the identity column so
 * it can span the full hero width on mobile (where the identity row also
 * carries the safety badge). The desktop identity renders its own pill
 * inline next to the heading.
 */
export function HeroVerdict({
  coinId,
  verdict,
}: {
  coinId: string;
  verdict: StablecoinVerdict;
}) {
  if (!isHeroVerdictEnabled()) return null;
  if (verdict.archetype === "uncategorized") return null;
  return (
    <div className="mt-3">
      <VerdictPill id={`hero-verdict-${coinId}`} verdict={verdict} />
    </div>
  );
}

export function HeroMobileIdentity({
  coin,
  logoSrc,
  variantParent,
  variantChipClass,
  infrastructures,
  verdict,
  condensed = false,
}: HeroIdentityProps & { condensed?: boolean }) {
  const heroVerdictEnabled = isHeroVerdictEnabled();
  const showVerdict = heroVerdictEnabled && verdict.archetype !== "uncategorized";
  const verdictId = `hero-verdict-${coin.id}`;
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-start gap-3">
        <div className="shrink-0 pt-10">
          <StablecoinLogo src={logoSrc} name={coin.name} size={48} />
        </div>
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
          </div>
          {condensed ? (
            <div className="mt-1">
              <HeroClassificationLine
                coin={coin}
                infrastructures={infrastructures}
                stackedSegments
              />
            </div>
          ) : null}
        </div>
      </div>

      {!condensed ? <HeroMobileIdentityDetails coin={coin} infrastructures={infrastructures} /> : null}
    </div>
  );
}

export function HeroMobileIdentityDetails({
  coin,
  infrastructures,
  includeClassification = true,
}: HeroMobileIdentityDetailsProps) {
  return (
    <>
      {includeClassification ? (
        <div className="mt-1">
          <HeroClassificationLine
            coin={coin}
            infrastructures={infrastructures}
            stackedSegments
          />
        </div>
      ) : null}
      {coin.oneLiner ? (
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{coin.oneLiner}</p>
      ) : null}
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <MechanismChip coin={coin} />
        <HeroTagList tags={coin.tags} />
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
  verdict,
}: HeroIdentityProps) {
  const heroVerdictEnabled = isHeroVerdictEnabled();
  const showVerdict = heroVerdictEnabled && verdict.archetype !== "uncategorized";
  const verdictId = `hero-verdict-${coin.id}`;
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
        {coin.oneLiner ? (
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{coin.oneLiner}</p>
        ) : null}
        {showVerdict ? (
          <div className="mt-2">
            <VerdictPill id={verdictId} verdict={verdict} />
          </div>
        ) : null}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <MechanismChip coin={coin} />
          <HeroTagList tags={coin.tags} />
        </div>
      </div>
    </div>
  );
}
