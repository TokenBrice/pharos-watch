"use client";

import Link from "next/link";
import { ScoreBadgeWrapper } from "@/components/score-badge-wrapper";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { getInfrastructureLabel } from "@shared/lib/infrastructure";
import { getSafetyGradeMetadata } from "@/lib/report-card-ui";
import type { Infrastructure } from "@shared/types";
import type { V9ConsumerCard } from "@/lib/safety-score-v9-consumers";
import type { StablecoinClientMeta } from "@shared/lib/stablecoins/client-registry";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { logosById } from "@/lib/logos";

export function InfrastructureBadge({ value }: { value: Infrastructure }) {
  const label = getInfrastructureLabel(value);

  // Neutral chip: infrastructure is categorical identity, which structure and
  // the mono value carry — not a saturated hue (Semantic-Color Rule).
  return (
    <div className="inline-flex max-w-full min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0 rounded-full border border-border/60 bg-muted/40 px-2.5 py-0.5 text-2xs">
      <span className="pharos-label shrink-0">
        Infrastructure
      </span>
      <span className="min-w-0 break-words text-2xs font-semibold text-foreground/80">{label}</span>
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
  read = "settled",
  mobile = false,
}: {
  reportCard: V9ConsumerCard | null;
  /**
   * The report-card read behind the grade (see `RailSafetySummary`): a first
   * fetch in flight is a neutral placeholder and a failed read says so, so
   * neither looks like the settled "—" of an unscored coin.
   */
  read?: "settled" | "pending" | "failed";
  mobile?: boolean;
}) {
  const letterClass = mobile ? "text-3xl" : "text-5xl";
  const scoreClass = mobile ? "text-xs" : "text-base";
  // One track for every read state: late scores cannot squeeze the coin name.
  const trackClass = mobile
    ? "flex min-h-10 w-32 shrink-0 flex-wrap items-baseline justify-end gap-x-1.5 gap-y-1"
    : "flex min-h-14 w-48 shrink-0 flex-wrap items-baseline justify-end gap-x-1.5 gap-y-1";

  if (!reportCard && read === "pending") {
    return (
      <div className={trackClass} role="status" aria-label="Loading Safety Score" data-safety-grade-track>
        <span aria-hidden="true" className={`block animate-pulse rounded-md bg-muted motion-reduce:animate-none ${mobile ? "h-8 w-16" : "h-12 w-24"}`} />
      </div>
    );
  }

  if (!reportCard && read === "failed") {
    return (
      <div className={trackClass} data-safety-state="unavailable" data-safety-grade-track>
        <span className="text-right text-xs font-semibold leading-tight text-muted-foreground">Grade unavailable</span>
      </div>
    );
  }

  if (!reportCard) {
    return (
      <div className={trackClass} data-safety-grade-track>
        <span className={`pharos-numeric font-extrabold leading-none text-muted-foreground ${letterClass}`}>—</span>
      </div>
    );
  }

  // The grade block never shrinks and sits beside the identity column, so it
  // carries only the grade and score.
  return (
    <div className={trackClass} data-safety-grade-track>
      <ScoreBadgeWrapper topic="safetyScore" variant="tooltip-only">
        <span
          className={reportCard.grade === null
            ? "text-right text-xs font-semibold leading-tight text-muted-foreground"
            : `pharos-numeric font-extrabold leading-none tracking-tight ${letterClass} ${getSafetyGradeMetadata(reportCard.grade).pulse.accentClassName}`}
        >
          {reportCard.grade === null ? "Pipeline gap" : reportCard.grade}
        </span>
      </ScoreBadgeWrapper>
      {reportCard.score !== null && (
        <span className={`whitespace-nowrap font-mono text-muted-foreground ${scoreClass}`}>
          · {reportCard.score}/100
        </span>
      )}
    </div>
  );
}


export function HeroVariantChip({
  variantParent,
  variantChipClass,
  mobile = false,
}: {
  variantParent?: StablecoinClientMeta | null;
  variantChipClass?: string | null;
  mobile?: boolean;
}) {
  const logos = logosById;
  if (!variantParent || !variantChipClass) return null;
  return (
    <Link
      href={buildStablecoinUrl(variantParent.id)}
      aria-label={`Variant of ${variantParent.name} — wraps ${variantParent.symbol}`}
      className={`pharos-focus-ring inline-flex items-center gap-1.5 rounded-full border font-semibold ${variantChipClass} ${
        mobile ? "mt-1 px-2 py-1 text-2xs" : "px-3 py-1 text-xs"
      }`}
    >
      <StablecoinLogo src={logos?.[variantParent.id]} name={variantParent.name} size={mobile ? 14 : 16} />
      <span>Wraps {variantParent.symbol}</span>
      <span aria-hidden>→</span>
    </Link>
  );
}
