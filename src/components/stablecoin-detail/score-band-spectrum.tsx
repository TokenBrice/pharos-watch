import { cn } from "@/lib/utils";

export interface SpectrumBand {
  key: string;
  label: string;
  /** Track fill when this band is active. Static Tailwind string. */
  fillClass: string;
  /** Label tone when this band is active. Static Tailwind string. */
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
 * Inactive band labels hide below `sm`; the active label always shows.
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
    <div role="img" aria-label={ariaLabel} className={cn("min-w-0", className)}>
      <div className="relative">
        <div className="flex gap-1">
          {bands.map((band, index) => (
            <div
              key={band.key}
              style={{ width: `${widths[index]}%` }}
              className={cn(
                "h-1.5 rounded-full transition-colors",
                index === activeIndex ? band.fillClass : "bg-muted/70",
              )}
            />
          ))}
        </div>
        {markerLeft != null ? (
          <span
            aria-hidden="true"
            style={{ left: `${markerLeft}%` }}
            className="absolute -top-1 h-3.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
          />
        ) : null}
      </div>
      {bands.every((band) => band.label === "") ? null : (
      <div className="mt-1 flex gap-1" aria-hidden="true">
        {bands.map((band, index) => (
          <span
            key={band.key}
            style={{ width: `${widths[index]}%` }}
            className={cn(
              "truncate text-center text-[9px] font-medium uppercase leading-tight tracking-[0.08em]",
              index === activeIndex ? band.textClass : "invisible text-muted-foreground/60 sm:visible",
            )}
          >
            {band.label}
          </span>
        ))}
      </div>
      )}
    </div>
  );
}
