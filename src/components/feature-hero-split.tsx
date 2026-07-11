import { CardExpandButton } from "@/components/home-alt-mini-cards/pulse-card-header";

/**
 * Shared interior-page hero shell, modeled on the locked homepage `HomeAltHero`
 * composition (DESIGN.md §5 "Homepage Composition"). A single flat
 * `pharos-card-shell` split into a frost-blue "One Beam" headline figure on the
 * left and a drawn metaphor / live chart on the right, separated by hairline
 * dividers. Consumed by the Markets-tab pages (liquidity, alt-pegs, yield,
 * upcoming). The homepage hero stays its own bespoke component — this does not
 * replace it.
 *
 * The route `<h1>` continues to come from `FeaturePageShell`; render this as the
 * first child inside the shell, not as a title replacement.
 */

const DEFAULT_BEAM_VALUE_CLASS =
  "pharos-numeric text-[2.1rem] font-semibold leading-none tracking-tight text-frost-blue sm:text-[2.45rem]";

export interface FeatureHeroSplitProps {
  /** Small muted label above the beam figure (e.g. "Aggregate DEX Depth"). */
  beamLabel: React.ReactNode;
  /** The frost-blue headline figure — caller pre-formats the value. */
  beamValue: React.ReactNode;
  /** Override the default frost numeric recipe (rarely needed). */
  beamValueClassName?: string;
  /** Optional `title` tooltip on the beam label (e.g. shadow-asset note). */
  beamTitle?: string;
  /** Corner module-jump button. Omit to hide. */
  expand?: { href: string; label: string };
  /** Lower-left kicker eyebrow over the sub-metrics. */
  subKicker?: React.ReactNode;
  /** Lower-left sub-metric content (mono rows, deltas, coverage, etc.). */
  sub?: React.ReactNode;
  /** Right slot: the drawn metaphor (inline SVG) or staged live chart. */
  children: React.ReactNode;
  /** Accessible group label for the hero card. */
  ariaLabel?: string;
  /** Put the decision summary before the visual on narrow screens. */
  mobileSubBeforeVisual?: boolean;
}

export function FeatureHeroSplit({
  beamLabel,
  beamValue,
  beamValueClassName,
  beamTitle,
  expand,
  subKicker,
  sub,
  children,
  ariaLabel,
  mobileSubBeforeVisual = false,
}: FeatureHeroSplitProps): React.JSX.Element {
  const hasSub = subKicker != null || sub != null;
  return (
    <div
      className="pharos-card-shell relative grid grid-cols-1 overflow-hidden lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:grid-rows-[auto_1fr]"
      role="group"
      aria-label={ariaLabel}
    >
      <div className="border-b border-border/50 p-5 sm:p-6 lg:border-b-0 lg:border-r lg:p-7">
        <div className="space-y-2.5">
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm font-medium text-muted-foreground" title={beamTitle}>
              {beamLabel}
            </p>
            {expand ? <CardExpandButton href={expand.href} expandLabel={expand.label} className="-mr-2" /> : null}
          </div>
          <p className={beamValueClassName ?? DEFAULT_BEAM_VALUE_CLASS}>{beamValue}</p>
        </div>
      </div>

      <div
        className={`${mobileSubBeforeVisual ? "order-3" : ""} border-b border-border/50 lg:order-none lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:border-b-0`}
      >
        {children}
      </div>

      {hasSub ? (
        <div
          className={`${mobileSubBeforeVisual ? "order-2" : ""} space-y-2 p-5 sm:p-6 lg:order-none lg:col-start-1 lg:border-r lg:border-t lg:border-border/50 lg:p-7`}
        >
          {subKicker ? <p className="pharos-kicker">{subKicker}</p> : null}
          {sub}
        </div>
      ) : null}
    </div>
  );
}
