import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Restrained header-band hero for the Learn hub surfaces (Mechanisms, Case
 * Studies). A flat `pharos-card-shell` band carrying one neutral-ink "One Beam"
 * figure (`DESIGN.md §5`) beside a stack of supporting sub-metrics — no bespoke
 * drawn metaphor, no split dead-space.
 *
 * Intentionally lighter than `FeatureHeroSplit`: Learn hubs are editorial
 * surfaces where a metaphor is not forced. The route `<h1>` still comes from
 * `LearnPageShell`; render this as the first child, not a title replacement.
 * The optional `children` slot renders full-width beneath the band (such as a
 * proportional distribution bar).
 */

export interface LearnHeroProps {
  /** Label above the headline figure (e.g. "Active coins by mechanism"). */
  beamLabel: ReactNode;
  /** The neutral-ink One Beam headline figure — caller pre-formats the value. */
  beamValue: ReactNode;
  /** Override the default `.pharos-hero-kpi` numeric recipe (rarely needed). */
  beamValueClassName?: string;
  /** Kicker label over the right-hand sub-metrics. */
  subKicker?: ReactNode;
  /** Right-hand sub-metric content (counts, outcomes, spread, etc.). */
  sub?: ReactNode;
  /** Optional full-width slot beneath the band (proportional breakdown bar). */
  children?: ReactNode;
  /** Accessible landmark label for the hero card. */
  ariaLabel?: string;
  className?: string;
}

export function LearnHero({
  beamLabel,
  beamValue,
  beamValueClassName,
  subKicker,
  sub,
  children,
  ariaLabel,
  className,
}: LearnHeroProps): React.JSX.Element {
  const hasSub = subKicker != null || sub != null;
  return (
    <section
      className={cn("pharos-card-shell overflow-hidden", className)}
      aria-label={ariaLabel}
    >
      <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-end sm:justify-between sm:gap-8 sm:p-6">
        <div className="space-y-2">
          <p className="pharos-label">{beamLabel}</p>
          <p className={beamValueClassName ?? "pharos-hero-kpi"}>{beamValue}</p>
        </div>
        {hasSub ? (
          <div className="space-y-2 sm:min-w-[14rem] sm:text-right">
            {subKicker ? <p className="pharos-label">{subKicker}</p> : null}
            {sub}
          </div>
        ) : null}
      </div>
      {children ? (
        <div className="border-t border-border/50 p-5 sm:p-6">{children}</div>
      ) : null}
    </section>
  );
}
