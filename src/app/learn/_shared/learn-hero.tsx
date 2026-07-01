import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Restrained header-band hero for the Learn hub surfaces (Mechanisms, Glossary,
 * Case Studies). A flat `pharos-card-shell` band that lights a single neutral
 * "One Beam" magnitude in frost (DESIGN.md §2 "One Beam Rule") beside a stack of
 * muted sub-metrics — no bespoke drawn metaphor, no split dead-space.
 *
 * This is intentionally lighter than `FeatureHeroSplit` (the Markets-tab shell):
 * the Learn pages are Category-C editorial surfaces where a metaphor is not
 * forced. The route `<h1>` still comes from the page shell; render this as the
 * first child, not a title replacement. The optional `children` slot renders
 * full-width beneath the band (a reused metaphor, distribution bar, or semantic
 * sub-bar); pages whose headline figure is directional/semantic should opt out
 * of the frost beam entirely rather than recolor a graded value.
 */

const DEFAULT_BEAM_VALUE_CLASS =
  "pharos-numeric text-[2.1rem] font-semibold leading-none tracking-tight text-frost-blue tabular-nums sm:text-[2.45rem]";

export interface LearnHeroProps {
  /** Muted label above the beam figure (e.g. "Active coins tracked"). */
  beamLabel: ReactNode;
  /** The frost-blue "One Beam" headline figure — caller pre-formats the value. */
  beamValue: ReactNode;
  /** Override the default frost numeric recipe (rarely needed). */
  beamValueClassName?: string;
  /** Kicker eyebrow over the right-hand sub-metrics. */
  subKicker?: ReactNode;
  /** Right-hand sub-metric content (mono rows, coverage, spread, etc.). */
  sub?: ReactNode;
  /** Optional full-width slot beneath the band (reused metaphor / bar). */
  children?: ReactNode;
  /** Accessible group label for the hero card. */
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
      role="group"
      aria-label={ariaLabel}
    >
      <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-end sm:justify-between sm:gap-8 sm:p-6">
        <div className="space-y-2">
          <p className="text-sm font-medium text-muted-foreground">{beamLabel}</p>
          <p className={beamValueClassName ?? DEFAULT_BEAM_VALUE_CLASS}>{beamValue}</p>
        </div>
        {hasSub ? (
          <div className="space-y-2 sm:min-w-[14rem] sm:text-right">
            {subKicker ? <p className="pharos-kicker">{subKicker}</p> : null}
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
