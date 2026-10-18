import { CardExpandButton } from "@/components/home-alt-mini-cards/pulse-card-header";

/**
 * Shared interior-page hero shell, modeled on the locked homepage `HomeAltHero`
 * composition (DESIGN.md §5 "Homepage Composition"). A single flat
 * `pharos-card-shell` split into a neutral headline figure (answer KPI plus its
 * universe chip) on the left and a drawn metaphor / live chart on the right, separated by hairline
 * dividers. Consumed by the Markets-tab pages (liquidity, alt-pegs, yield,
 * upcoming). The homepage hero stays its own bespoke component — this does not
 * replace it.
 *
 * The route `<h1>` continues to come from `FeaturePageShell`; render this as the
 * first child inside the shell, not as a title replacement.
 */

/**
 * The rail-page hero KPI recipe, shared by heroes that do not use this split
 * shell (FreezeWatch, Depeg). Neutral ink: a hero figure takes color only from
 * a semantic scale in `shared/lib/classification.ts` (grade, severity, regime),
 * never from the frost brand accent.
 */
export const HERO_KPI_VALUE_CLASS =
  "pharos-numeric text-[2.1rem] font-semibold leading-none tracking-tight text-foreground sm:text-[2.45rem]";

export interface FeatureHeroSplitProps {
  /** Small muted label above the beam figure (e.g. "Aggregate DEX Depth"). */
  beamLabel: React.ReactNode;
  /** The headline figure (neutral ink) — caller pre-formats the value. */
  beamValue: React.ReactNode;
  /** Override the default numeric recipe (rarely needed). */
  beamValueClassName?: string;
  /** Denominator chip under the figure (`UniverseChip`), naming what it counts. */
  universe?: React.ReactNode;
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
  /**
   * Optional full-width rail under both columns, separated by a hairline. For
   * secondary context that belongs to the hero but must not compete with the
   * beam (coverage counts, provenance, evaluated inputs).
   */
  footer?: React.ReactNode;
  /** Accessible group label for the hero card. */
  ariaLabel?: string;
  /** Put the decision summary before the visual on narrow screens. */
  mobileSubBeforeVisual?: boolean;
  /**
   * Ops/partial state beside the beam label (`OpsStatusChip`), never a body
   * callout. When the beam itself is computed on partial inputs, the beam label
   * says so too; the chip carries the reason and budget.
   */
  status?: React.ReactNode;
  /**
   * `split` (default): beam left, visual right. `stacked`: beam and sub-metrics
   * share a full-width top row and the visual spans the width beneath, for
   * scenes that need more than the split column (FreezeWatch's shape).
   */
  layout?: "split" | "stacked";
}

/**
 * One label/value row for a hero's sub-metrics. Wraps rather than truncates: a
 * partial-coverage detail must never erase the "Known" qualifier from its label.
 */
export function HeroMetricRow({
  label,
  value,
  detail,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  detail?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2">
      <span className="min-w-0 text-sm text-muted-foreground">{label}</span>
      <span className="ml-auto text-right">
        <span className="pharos-numeric text-sm font-semibold text-foreground">{value}</span>
        {detail ? <span className="ml-2 text-2xs text-muted-foreground">{detail}</span> : null}
      </span>
    </div>
  );
}

export function FeatureHeroSplit({
  beamLabel,
  beamValue,
  beamValueClassName,
  beamTitle,
  universe,
  expand,
  subKicker,
  sub,
  children,
  footer,
  ariaLabel,
  mobileSubBeforeVisual = false,
  status,
  layout = "split",
}: FeatureHeroSplitProps): React.JSX.Element {
  const hasSub = subKicker != null || sub != null;
  const beamBlock = (
    <div className="space-y-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <p className="text-sm font-medium text-muted-foreground" title={beamTitle}>
            {beamLabel}
          </p>
          {status}
        </div>
        {expand ? <CardExpandButton href={expand.href} expandLabel={expand.label} className="-mr-2" /> : null}
      </div>
      <p className={beamValueClassName ?? HERO_KPI_VALUE_CLASS}>{beamValue}</p>
      {universe ? <div>{universe}</div> : null}
    </div>
  );

  if (layout === "stacked") {
    return (
      <div className="pharos-card-shell relative overflow-hidden" role="group" aria-label={ariaLabel}>
        <div className="grid grid-cols-1 gap-5 border-b border-border/50 p-5 sm:p-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-8 lg:p-7">
          {beamBlock}
          {hasSub ? (
            <div className="space-y-2 lg:self-end">
              {subKicker ? <p className="pharos-label">{subKicker}</p> : null}
              {sub}
            </div>
          ) : null}
        </div>
        <div>{children}</div>
        {footer ? <div className="border-t border-border/50 p-5 sm:p-6 lg:px-7 lg:py-5">{footer}</div> : null}
      </div>
    );
  }

  return (
    // The third row is `auto`, so it collapses to zero height when no footer is
    // passed and the two-row composition is unchanged for existing consumers.
    <div
      className="pharos-card-shell relative grid grid-cols-1 overflow-hidden lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:grid-rows-[auto_1fr_auto]"
      role="group"
      aria-label={ariaLabel}
    >
      <div className="border-b border-border/50 p-5 sm:p-6 lg:border-b-0 lg:border-r lg:p-7">{beamBlock}</div>

      <div
        className={`${mobileSubBeforeVisual ? "order-3" : ""} border-b border-border/50 lg:order-none lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:border-b-0`}
      >
        {children}
      </div>

      {hasSub ? (
        <div
          className={`${mobileSubBeforeVisual ? "order-2" : ""} space-y-2 p-5 sm:p-6 lg:order-none lg:col-start-1 lg:border-r lg:border-t lg:border-border/50 lg:p-7`}
        >
          {subKicker ? <p className="pharos-label">{subKicker}</p> : null}
          {sub}
        </div>
      ) : null}

      {footer ? (
        <div className="order-last border-t border-border/50 p-5 sm:p-6 lg:order-none lg:col-span-2 lg:col-start-1 lg:row-start-3 lg:px-7 lg:py-5">
          {footer}
        </div>
      ) : null}
    </div>
  );
}
