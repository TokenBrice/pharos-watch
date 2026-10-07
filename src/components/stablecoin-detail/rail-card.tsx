import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { resolveFactValueStyle } from "@/components/stablecoin-detail/fact-grid";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  DETAIL_MODULE_TITLE_CLASS,
  SECTION_SCROLL_MT,
} from "@/components/stablecoin-detail/section-title-class";

/**
 * The rail-module shell: the card surface plus the one header row every detail
 * module already draws — title on the left, an optional stamp, badge or muted
 * glyph on the right. Extracted from eleven byte-identical copies so the header
 * grammar cannot drift module by module.
 *
 * The body is passed through verbatim: modules keep owning their own padding
 * because several split into `border-t border-border/50 px-4 py-4` bands rather
 * than one padded block.
 */
export function RailCard({
  id,
  title,
  titleAdornment,
  ariaLabel,
  icon: Icon,
  trailing,
  anchorTwin,
  children,
}: {
  /** Anchor id on the section, for a rail card that owns its anchor outright. */
  id?: string;
  title: string;
  /**
   * Rendered immediately after the title — the home for counts.
   * Counts are a property of the thing named, not a status, so they sit with
   * the name rather than competing for the `trailing` slot.
   */
  titleAdornment?: ReactNode;
  /** Accessible name for the section landmark, e.g. "Access posture". */
  ariaLabel: string;
  /** Optional muted glyph rendered before the title. */
  icon?: LucideIcon;
  /**
   * Right-aligned header slot: **status only** (owner ruling 2026-08-11).
   *
   * Not freshness, not counts, not a toggle. A reviewed date or a live stamp
   * belongs in the module footer (`EvidenceFooter`'s own `trailing`); a count
   * belongs in `titleAdornment`. Before this rule the corner carried nine
   * different things and changed meaning between coins on the same card, so a
   * reader could never learn what it meant.
   */
  trailing?: ReactNode;
  /**
   * Anchor id this rail instance stands in for. The in-flow (`xl:hidden`) copy
   * owns the real id; at `xl+` that copy is display-hidden, so a hash jump
   * (`revealAnchorId` in `src/lib/anchor-reveal.ts`) falls back to the
   * visible twin marked here.
   */
  anchorTwin?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className={cn("pharos-card-shell overflow-hidden", id || anchorTwin ? SECTION_SCROLL_MT : undefined)}
      aria-label={ariaLabel}
      {...(anchorTwin ? { "data-anchor-twin": anchorTwin } : {})}
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3.5">
        <div className="flex min-w-0 items-center gap-2">
          {Icon ? <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
          <h2 className={DETAIL_MODULE_TITLE_CLASS}>{title}</h2>
          {titleAdornment}
        </div>
        {trailing}
      </div>
      {children}
    </section>
  );
}

const RAIL_STAMP_CLASS =
  "inline-flex h-6 items-center rounded-full bg-muted/70 px-2 font-mono text-xs font-medium text-muted-foreground";

/**
 * The header stamp chip — the muted mono pill for a status or icon-prefixed
 * label. Counts belong beside the title through `titleAdornment`.
 */
export function RailStamp({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn(RAIL_STAMP_CLASS, className)}>{children}</span>;
}

export interface RailMetricChip {
  label: string;
  toneClass: string;
}

export interface RailMetricSubMetric {
  /** Mono caps sub-label beside a figure: three words at most. */
  label: string;
  value: ReactNode;
  /** What the figure measures; the row tooltip, and read after the label. */
  hint?: string;
}

/**
 * Sub-metric ceiling (plan §7): `METRIC_SPECS` carries at most three metrics
 * per archetype, one of which is the headline.
 */
export const RAIL_METRIC_MAX_SUB_METRICS = 2;

export interface RailMetricCardProps {
  /** Anchor id when this instance owns it (the in-flow twin below `xl`). */
  id?: string;
  /** Anchor id this instance stands in for (the `xl+` rail copy); see `RailCard`. */
  anchorTwin?: string;
  title: string;
  /** Header status chip; the tone class comes from the shared classification helpers. */
  chip?: RailMetricChip | null;
  /** The one headline figure. A worded value ("Not applicable") drops to body type. */
  value: ReactNode;
  /** The headline's basis, always named: "vs supply", "vs VAT debt", "hedge coverage". */
  valueCaption?: string;
  /** Optional gauge drawn under the headline, e.g. `ThresholdGauge`. */
  visual?: ReactNode;
  /** At most `RAIL_METRIC_MAX_SUB_METRICS` rows render; extras belong in `details`. */
  subMetrics?: readonly RailMetricSubMetric[];
  /** Alternate ratios (each with its denominator), protocol facts, gap rationales, sources. */
  details?: ReactNode;
  detailsCount?: number;
  /** Freshness stamp, e.g. `Live · 3h ago` or `Reviewed 2026-07-15`. */
  freshness?: ReactNode;
}

/**
 * The rail metric card (plan §7, §8b): title + status chip, one 2rem mono
 * headline with its basis, an optional gauge, at most two sub-metric rows in
 * the `RailSafetySummary` row grammar, one "Details & sources (N)" fold, and a
 * freshness stamp. Rail density tier (`RailCard` shell).
 *
 * The same card renders in flow below `xl` at tile width (~480 px). Its body
 * queries its own width there: from 24rem the sub-metric rows move beside the
 * headline instead of stacking under it, so a twin tile does not read as a
 * stretched rail card.
 */
export function RailMetricCard({
  id,
  anchorTwin,
  title,
  chip,
  value,
  valueCaption,
  visual,
  subMetrics,
  details,
  detailsCount,
  freshness,
}: RailMetricCardProps) {
  const rows = subMetrics?.slice(0, RAIL_METRIC_MAX_SUB_METRICS) ?? [];
  const headlineIsFigure = resolveFactValueStyle(value) === "figure";

  return (
    <RailCard
      id={id}
      anchorTwin={anchorTwin}
      title={title}
      ariaLabel={title}
      trailing={
        chip ? (
          <Badge variant="outline" className={cn("shrink-0 text-[11px] font-medium", chip.toneClass)}>
            {chip.label}
          </Badge>
        ) : null
      }
    >
      <div className="@container/metric px-4 pb-4">
        <div
          className={cn(rows.length > 0 && "@sm/metric:grid @sm/metric:grid-cols-2 @sm/metric:items-start @sm/metric:gap-x-6")}
        >
          <div className="min-w-0">
            <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span
                className={
                  headlineIsFigure
                    ? "font-mono text-[2rem] font-semibold leading-none tracking-normal tabular-nums text-foreground"
                    : "text-sm font-medium text-foreground"
                }
              >
                {value}
              </span>
              {valueCaption ? <span className="text-xs text-muted-foreground">{valueCaption}</span> : null}
            </p>
            {visual ? <div className="mt-3">{visual}</div> : null}
          </div>
          {rows.length > 0 ? (
            <dl className="mt-3 divide-y divide-border/40 border-t border-border/40 @sm/metric:mt-0 @sm/metric:border-t-0">
              {rows.map((row) => (
                <div
                  key={row.label}
                  title={row.hint}
                  className="flex items-baseline justify-between gap-3 py-2 @sm/metric:first:pt-0"
                >
                  <dt className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                    {row.label}
                    {row.hint ? <span className="sr-only">, {row.hint}</span> : null}
                  </dt>
                  <dd className="pharos-numeric text-sm font-semibold text-foreground">{row.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
        {details ? (
          <ModuleDisclosure label="Details & sources" count={detailsCount} className="mt-3" summaryClassName="text-xs">
            <div className="mt-1 space-y-2 pb-1 text-xs leading-relaxed text-muted-foreground">{details}</div>
          </ModuleDisclosure>
        ) : null}
        {freshness ? (
          <p className="mt-3 border-t border-border/50 pt-3 text-xs text-muted-foreground">{freshness}</p>
        ) : null}
      </div>
    </RailCard>
  );
}
