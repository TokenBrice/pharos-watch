import { cn } from "@/lib/utils";

export interface SpectrumBand {
  key: string;
  label: string;
  /**
   * Optional one-word form printed while the spectrum is narrower than 36rem
   * (a ~480 px tile). Labels are never ellipsized: without it, a label that
   * does not fit its segment wraps at its spaces.
   */
  shortLabel?: string;
  /** Track fill when this band is active. Static Tailwind string. */
  fillClass: string;
  /** Label tone when this band is active. Static Tailwind string; must reach AA on the card. */
  textClass: string;
}

/**
 * "You are here" on a module's band scale, drawn instead of written.
 *
 * Two honest modes, matching how the owning score actually works:
 * - `ordinal`: equal segments in published band order with the active band
 *   lit — for scores whose band is a classification, not a score range
 *   (V9 mint posture: the 80/65/50/35 cutoffs were deliberately retired).
 * - `range`: segments sized by real score cutoffs with a marker notched at
 *   the score — only for scores whose tones ARE range-derived (redemption).
 *
 * Labels are 11 px sentence case at full muted contrast, sized to the
 * spectrum's own container: the full label from 36rem, the band's
 * `shortLabel` below it, wrapping at spaces when still too long. Phone
 * widths cannot fit every label, so below `sm` the inactive labels hide
 * (keeping their width) and the active label shows in full, free to run under
 * its empty neighbours and anchored inward at either end of the track.
 */
export function ScoreBandSpectrum({
  bands,
  activeKey,
  mode,
  score,
  cutoffs,
  ariaLabel,
  className,
}: {
  bands: readonly SpectrumBand[];
  activeKey: string;
  mode: "ordinal" | "range";
  /** Range mode only: the score the marker points at (0-100). */
  score?: number | null;
  /** Range mode only: ascending lower bound of each band, same order as `bands` (worst → best, left → right). */
  cutoffs?: readonly number[];
  ariaLabel: string;
  className?: string;
}) {
  const activeIndex = bands.findIndex((band) => band.key === activeKey);
  if (activeIndex === -1) return null;

  const widths =
    mode === "range" && cutoffs && cutoffs.length === bands.length
      ? bands.map((_, index) => {
          const upper = index === bands.length - 1 ? 100 : cutoffs[index + 1]!;
          return Math.max(upper - cutoffs[index]!, 0);
        })
      : bands.map(() => 100 / bands.length);
  const markerLeft =
    mode === "range" && score != null ? Math.min(Math.max(score, 0), 100) : null;

  return (
    <div role="img" aria-label={ariaLabel} className={cn("@container/spectrum w-full min-w-0", className)}>
      <div className="relative py-1">
        <div className="flex gap-1">
          {bands.map((band, index) => (
            <div
              key={band.key}
              style={{ flexGrow: widths[index], flexBasis: 0 }}
              className={cn(
                "h-1.5 min-w-0 rounded-full transition-colors",
                index === activeIndex ? band.fillClass : "bg-muted/70",
              )}
            />
          ))}
        </div>
        {markerLeft != null ? (
          <span
            aria-hidden="true"
            style={{ left: `${markerLeft}%`, top: 0, bottom: 0 }}
            className="absolute w-0.5 -translate-x-1/2 rounded-full bg-foreground"
          />
        ) : null}
      </div>
      {bands.every((band) => band.label === "") ? null : (
      <div className="mt-1 flex gap-1" aria-hidden="true">
        {bands.map((band, index) => {
          const active = index === activeIndex;
          const shortLabel = band.shortLabel && band.shortLabel !== band.label ? band.shortLabel : null;
          return (
            <span
              key={band.key}
              style={{ flexGrow: widths[index], flexBasis: 0 }}
              title={shortLabel ? band.label : undefined}
              className={cn(
                "min-w-0 hyphens-auto break-words text-[11px] font-medium leading-tight sm:text-center",
                active
                  ? cn(
                      "whitespace-nowrap sm:whitespace-normal",
                      index === 0 ? "text-left" : index === bands.length - 1 ? "text-right" : "text-center",
                      band.textClass,
                    )
                  : "invisible text-center text-muted-foreground sm:visible",
              )}
            >
              {shortLabel ? (
                <>
                  <span className="@xl/spectrum:hidden">{shortLabel}</span>
                  <span className="hidden @xl/spectrum:inline">{band.label}</span>
                </>
              ) : band.label}
            </span>
          );
        })}
      </div>
      )}
    </div>
  );
}
