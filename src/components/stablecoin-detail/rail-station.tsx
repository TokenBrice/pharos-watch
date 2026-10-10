import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Shared parts of the drawn station rails (`MintAuthorityRail`,
 * `RedemptionRouteRail`, and any later source → stage → consumer path): a
 * kicker over each station, bordered station chips, and the arrows between
 * them. Every rail stays a `role="img"` with its own `aria-label`, so these
 * parts are presentational and carry no accessible names of their own.
 */

/** The ≤ 3-word kicker above a station ("Issuer", "Access", "Sources"). */
export function StationLabel({ children }: { children: string }) {
  return (
    <span className="text-[11px] font-medium uppercase leading-tight tracking-[0.12em] text-muted-foreground">
      {children}
    </span>
  );
}

function HorizontalArrowHead() {
  return (
    <>
      <span className="h-px w-full bg-border" />
      <span className="border-y-4 border-l-[5px] border-border border-y-transparent" />
    </>
  );
}

function VerticalArrowHead() {
  return (
    <>
      <span className="h-full w-px bg-border" />
      <span className="border-x-4 border-t-[5px] border-border border-x-transparent" />
    </>
  );
}

export type RailArrowOrientation = "horizontal" | "responsive" | "container";

const RESPONSIVE_ARROW_CLASSES = {
  container: {
    unlabelled: "@xl/rail:mt-1 @xl/rail:min-w-6 @xl/rail:flex-1",
    labelled: "flex items-center gap-2 @xl/rail:min-w-6 @xl/rail:flex-1 @xl/rail:flex-col @xl/rail:items-center @xl/rail:gap-0.5",
    horizontal: "@xl/rail:flex",
    vertical: "@xl/rail:hidden",
  },
  responsive: {
    unlabelled: "sm:min-w-6 sm:flex-1",
    labelled: "flex items-center gap-2 sm:min-w-6 sm:flex-1 sm:flex-col sm:items-center sm:gap-0.5",
    horizontal: "sm:flex",
    vertical: "sm:hidden",
  },
} as const;

/**
 * Mono caps are reserved for pure figures: a label with no letters ("≤ 24",
 * "1-7") keeps the mono treatment. Any label containing a letter ("1-7 days",
 * "Atomic", "Same day") reads as sentence-case sans, so one rail never mixes
 * the two cases for the same kind of fact.
 */
export function isMonoArrowLabel(label: string): boolean {
  return !/\p{L}/u.test(label);
}

/**
 * The connector between two stations.
 *
 * - `horizontal` (default): always drawn left → right, for rails that swap to
 *   a fallback layout below `sm`. An optional label (settlement, cadence)
 *   sits above the shaft.
 * - `responsive`: drawn downward below `sm` and left → right from `sm`, for
 *   rails that stack their stations on phones. A label sits beside the
 *   downward arrow and above the shaft from `sm`.
 * - `container`: the same two drawings keyed on the rail's own width instead
 *   of the viewport, for rails that live in tiles as well as full-width
 *   modules. Drawn downward until the nearest `@container/rail` ancestor is
 *   36rem (`@xl`) wide, then left → right. The caller flips its station row
 *   at the same `@xl/rail` threshold.
 */
export function RailArrow({
  label,
  orientation = "horizontal",
}: {
  label?: string;
  orientation?: RailArrowOrientation;
}) {
  const labelNode = label ? (
    <span
      className={cn(
        "whitespace-nowrap text-[11px] text-muted-foreground",
        isMonoArrowLabel(label) ? "font-mono uppercase tracking-[0.08em]" : "font-medium",
      )}
    >
      {label}
    </span>
  ) : null;

  if (orientation !== "horizontal") {
    const classes = RESPONSIVE_ARROW_CLASSES[orientation];
    if (labelNode == null) {
      return (
        <div aria-hidden="true" className={classes.unlabelled}>
          <div className={cn("hidden items-center", classes.horizontal)}>
            <HorizontalArrowHead />
          </div>
          <div className={cn("ml-4 flex h-4 flex-col items-center", classes.vertical)}>
            <VerticalArrowHead />
          </div>
        </div>
      );
    }
    return (
      <div className={classes.labelled}>
        <div aria-hidden="true" className={cn("ml-4 flex h-4 flex-col items-center", classes.vertical)}>
          <VerticalArrowHead />
        </div>
        {labelNode}
        <div aria-hidden="true" className={cn("hidden w-full items-center", classes.horizontal)}>
          <HorizontalArrowHead />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-w-8 flex-1 flex-col items-center gap-0.5">
      {labelNode}
      <div aria-hidden="true" className="flex w-full items-center">
        <HorizontalArrowHead />
      </div>
    </div>
  );
}

/**
 * Chip treatment of a station: `default` is an intermediate stage, `terminal`
 * the rail's end state (tinted, as the mint rail's supply chip), and `unknown`
 * an undisclosed or unestablished stage (dashed, muted) — never a blank chip.
 */
export type RailStationTone = "default" | "terminal" | "unknown";

const STATION_CHIP_TONE_CLASS: Record<RailStationTone, string> = {
  default: "border-border/60 text-foreground",
  terminal: "border-border/60 bg-muted/20 text-foreground",
  unknown: "border-dashed border-muted-foreground/50 text-muted-foreground",
};

/**
 * One bordered station chip. Names stay sentence case in the sans face:
 * mono capitals are reserved for figures and short enums.
 *
 * By default a name too long for its station truncates (fixed-width rails).
 * `wrap` lets it break onto further lines instead, for rails whose stations
 * reflow with their container and must never hide part of a name.
 */
export function RailStationChip({
  children,
  icon: Icon,
  title,
  tone = "default",
  wrap = false,
}: {
  children: ReactNode;
  icon?: LucideIcon;
  title?: string;
  tone?: RailStationTone;
  wrap?: boolean;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex w-fit min-w-0 max-w-full gap-1.5 rounded-md border px-2.5 py-1.5",
        wrap ? "items-start" : "items-center",
        STATION_CHIP_TONE_CLASS[tone],
      )}
    >
      {Icon ? (
        <Icon aria-hidden="true" className={cn("h-3 w-3 shrink-0 text-muted-foreground", wrap && "mt-0.5")} />
      ) : null}
      <span className={cn("text-xs font-medium", wrap ? "min-w-0 break-words leading-snug" : "truncate")}>
        {children}
      </span>
    </span>
  );
}

/**
 * A labelled station: kicker, one chip per value (several sources wrap), and
 * an optional caption line under the chips.
 */
export function RailStation({
  label,
  value,
  icon,
  title,
  tone,
  caption,
  wrap,
  className,
}: {
  label: string;
  /** One chip, or one chip per entry when the station holds several sources. */
  value: string | readonly string[];
  /** Glyph drawn inside each chip. */
  icon?: LucideIcon;
  /** Hover text for each chip, e.g. the untruncated name. */
  title?: string;
  tone?: RailStationTone;
  caption?: ReactNode;
  /** Chip names wrap instead of truncating (see `RailStationChip`). */
  wrap?: boolean;
  className?: string;
}) {
  const values = typeof value === "string" ? [value] : value;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <StationLabel>{label}</StationLabel>
      <span className="flex min-w-0 flex-wrap items-center gap-1">
        {values.map((entry, index) => (
          <RailStationChip key={`${index}:${entry}`} icon={icon} title={title} tone={tone} wrap={wrap}>
            {entry}
          </RailStationChip>
        ))}
      </span>
      {caption != null ? (
        <span className="text-[11px] leading-snug text-muted-foreground">{caption}</span>
      ) : null}
    </div>
  );
}
