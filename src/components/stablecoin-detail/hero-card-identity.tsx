"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { BluechipHeaderBadge } from "@/components/bluechip-header-badge";
import { ScoreBadgeWrapper } from "@/components/score-badge-wrapper";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { STABLECOIN_DETAIL_IDENTITY_LOGO_SIZE } from "@/components/stablecoin-detail/constants";
import {
  BACKING_LABELS,
  GOVERNANCE_LABELS,
  GOVERNANCE_PROSE_LABELS,
  HERO_CHIP_BACKING_LABELS,
  HERO_CHIP_GOVERNANCE_LABELS,
  HERO_CHIP_PEG_LABELS,
  PEG_LABELS,
  PEG_LABELS_SHORT,
  PEG_METADATA,
} from "@shared/lib/classification";
import { pegCurrencySymbol } from "@shared/lib/format";
import { getInfrastructureLabel } from "@shared/lib/infrastructure";
import { getSafetyGradeMetadata } from "@/lib/report-card-ui";
import type {
  Infrastructure,
  StablecoinMeta,
} from "@shared/types";
import type { V9ConsumerCard } from "@/lib/safety-score-v9-consumers";
import type { StablecoinClientMeta } from "@shared/lib/stablecoins/client-registry";
import type { StablecoinVerdict } from "@shared/lib/stablecoin-verdict";
import { buildPegLandingUrl } from "@/lib/peg-landing";
import {
  buildBackingTaxonomyUrl,
  buildGovernanceTaxonomyUrl,
} from "@/lib/stablecoin-taxonomy-urls";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { useLogos } from "@/hooks/use-logos";
import { isHeroVerdictEnabled } from "@/lib/feature-flags";
import { VerdictPill } from "@/components/stablecoin-detail/verdict-pill";

function shouldShowVerdict(verdict: StablecoinVerdict): boolean {
  return isHeroVerdictEnabled() && verdict.archetype !== "uncategorized";
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

  // Neutral chip: infrastructure is categorical identity, which structure and
  // the mono value carry — not a saturated hue (Semantic-Color Rule).
  return (
    <div className="inline-flex max-w-full min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0 rounded-full border border-border/60 bg-muted/40 px-2.5 py-0.5 text-[11px]">
      <span className="shrink-0 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Infrastructure
      </span>
      <span className="min-w-0 break-words font-mono text-[11px] font-semibold text-foreground/80">{label}</span>
    </div>
  );
}

// Sentence-segment form of the backing labels, used inline in the hero
// classification line. Intentionally distinct from the shared BACKING_LABELS
// (full names) and BACKING_LABELS_SHORT (acronyms) in
// shared/lib/classification/domain.ts, which remains the canonical BackingType
// list. The Record<…> annotation enforces exhaustiveness, so a new backing type
// in domain.ts will fail to compile here until a sentence form is added.
const BACKING_SENTENCE_LABELS: Record<StablecoinMeta["flags"]["backing"], string> = {
  "rwa-backed": "RWA-backed",
  "crypto-backed": "Crypto-backed",
  algorithmic: "algorithmic",
};

function HeroClassificationLine({
  coin,
  infrastructures,
  stackedSegments = false,
  trailing,
}: {
  coin: StablecoinMeta;
  infrastructures: Infrastructure[];
  stackedSegments?: boolean;
  /** Stacked (mobile) only: shares the chip row so it wraps as one flow. */
  trailing?: ReactNode;
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

  // Stacked (mobile) renders these as chips, so each segment carries both its
  // sentence form and the desktop chip rail's label — same axis, same wording
  // across breakpoints.
  const sentenceSegments: { key: string; label: string; chipLabel: string; href: string | null; aria: string }[] = [];
  if (!isNonUsdPeg) {
    sentenceSegments.push({
      key: "peg",
      label: "USD-pegged",
      chipLabel: HERO_CHIP_PEG_LABELS[coin.flags.pegCurrency],
      href: pegHref,
      aria: `Browse ${pegShortLabel} stablecoins`,
    });
  }
  if (!isAlgorithmic) {
    sentenceSegments.push({
      key: "backing",
      label: BACKING_SENTENCE_LABELS[coin.flags.backing],
      chipLabel: HERO_CHIP_BACKING_LABELS[coin.flags.backing],
      href: backingHref,
      aria: `Browse ${backingFullLabel} stablecoins`,
    });
  }
  if (!isDecentralized) {
    sentenceSegments.push({
      key: "governance",
      label: GOVERNANCE_PROSE_LABELS[coin.flags.governance],
      chipLabel: HERO_CHIP_GOVERNANCE_LABELS[coin.flags.governance],
      href: governanceHref,
      aria: `Browse ${governanceFullLabel} stablecoins`,
    });
  }

  const segmentLinkClass =
    "pharos-focus-ring rounded-sm underline-offset-2 transition-colors hover:text-foreground hover:underline";
  const pillClass =
    "pharos-focus-ring inline-flex items-center rounded-full border border-border/50 bg-background/60 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground";
  const segmentChipNodes = sentenceSegments.map((segment) =>
    segment.href ? (
      <Link key={segment.key} href={segment.href} className={pillClass} aria-label={segment.aria}>
        {segment.chipLabel}
      </Link>
    ) : (
      <span key={segment.key} className={pillClass}>
        {segment.chipLabel}
      </span>
    ),
  );
  const sentenceNode =
    sentenceSegments.length > 0 ? (
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
          className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${PEG_METADATA[coin.flags.pegCurrency].badge.cls}`}
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
      <div className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {segmentChipNodes}
        {taxonomyNodes}
        {trailing}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      {sentenceNode}
      {taxonomyNodes}
    </div>
  );
}

/**
 * Hero grade, in the same form as the desktop summary rail (RailSafetySummary):
 * a bare band-colored letter followed by `· 87/100`. Deliberately not a boxed,
 * captioned, tinted pill — the page carries one grade presentation.
 */
export function SafetyGradeHero({
  reportCard,
  mobile = false,
}: {
  reportCard: V9ConsumerCard | null;
  mobile?: boolean;
}) {
  const letterClass = mobile ? "text-3xl" : "text-5xl";
  const scoreClass = mobile ? "text-xs" : "text-base";

  if (!reportCard) {
    return (
      <div className="flex h-full shrink-0 items-baseline justify-end gap-1.5">
        <span className={`pharos-numeric font-extrabold leading-none text-muted-foreground ${letterClass}`}>—</span>
      </div>
    );
  }

  return (
    <div className="flex h-full shrink-0 items-baseline justify-end gap-1.5">
      <ScoreBadgeWrapper topic="safetyScore" variant="tooltip-only">
        <span
          className={`pharos-numeric font-extrabold leading-none tracking-tight ${letterClass} ${
            getSafetyGradeMetadata(reportCard.grade).pulse.accentClassName
          }`}
        >
          {reportCard.grade}
        </span>
      </ScoreBadgeWrapper>
      {reportCard.score !== null && (
        <span className={`font-mono text-muted-foreground ${scoreClass}`}>
          · {reportCard.score}/100
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
  variantParent?: StablecoinClientMeta | null;
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
  variantParent?: StablecoinClientMeta | null;
  variantChipClass?: string | null;
  infrastructures: Infrastructure[];
  verdict: StablecoinVerdict;
}

interface HeroMobileIdentityDetailsProps {
  coin: StablecoinMeta;
  infrastructures: Infrastructure[];
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
  if (!shouldShowVerdict(verdict)) return null;
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
  const showVerdict = shouldShowVerdict(verdict);
  const verdictId = `hero-verdict-${coin.id}`;
  return (
    <div className="min-w-0 flex-1">
      {/* The 56px mark centers on the name + ticker pair, which is all this
          column now carries — the classification and Bluechip rows sit below. */}
      <div className="flex items-center gap-3">
        <div className="shrink-0">
          <StablecoinLogo
            src={logoSrc}
            name={coin.name}
            size={STABLECOIN_DETAIL_IDENTITY_LOGO_SIZE}
          />
        </div>
        <div className="min-w-0 flex-1">
          <h2
            // The grade now sits inline to the right rather than in its own
            // boxed column, so at 390 the title steps down a size to clear it;
            // break-words is the last-resort guard for a longer single word.
            className="pharos-page-title break-words text-xl sm:text-2xl"
            {...(showVerdict ? { "aria-describedby": verdictId } : {})}
          >
            {coin.name}
          </h2>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-sm font-mono text-muted-foreground">{coin.symbol}</span>
            <HeroVariantChip variantParent={variantParent} variantChipClass={variantChipClass} mobile />
          </div>
        </div>
      </div>

      {!condensed ? <HeroMobileIdentityDetails coin={coin} infrastructures={infrastructures} /> : null}
    </div>
  );
}

export function HeroMobileIdentityDetails({
  coin,
  infrastructures,
}: HeroMobileIdentityDetailsProps) {
  return (
    <>
      {/* Full card width, not the identity column beside the logo and grade —
          the classification chips fit on one line there, and the Bluechip badge
          shares the row so it wraps as one flow instead of claiming its own. */}
      <div className="mt-1">
        <HeroClassificationLine
          coin={coin}
          infrastructures={infrastructures}
          stackedSegments
          trailing={<BluechipHeaderBadge stablecoinId={coin.id} />}
        />
      </div>
      {coin.oneLiner ? (
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{coin.oneLiner}</p>
      ) : null}
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
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
  verdict,
}: HeroIdentityProps) {
  const showVerdict = shouldShowVerdict(verdict);
  const verdictId = `hero-verdict-${coin.id}`;
  return (
    <div className="flex items-center gap-4">
      <div className="shrink-0">
        <StablecoinLogo src={logoSrc} name={coin.name} size={76} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-3">
          <h2
            className="pharos-page-title text-3xl"
            {...(showVerdict ? { "aria-describedby": verdictId } : {})}
          >
            {coin.name}
          </h2>
          <span className="text-base font-mono text-muted-foreground/70">{coin.symbol}</span>
          <BluechipHeaderBadge stablecoinId={coin.id} />
          <HeroVariantChip variantParent={variantParent} variantChipClass={variantChipClass} />
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
          <HeroTagList tags={coin.tags} />
        </div>
      </div>
    </div>
  );
}
