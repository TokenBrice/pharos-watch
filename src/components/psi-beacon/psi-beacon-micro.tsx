/** Track from x=9 to x=39 in the 40×14 glyph: one unit of lit length per 3.33 PSI points. */
const TRACK_X0 = 9;
const TRACK_LENGTH = 30;

/**
 * Inline PSI beacon glyph for the expanded regime bar: a tiny tower and a 0–100
 * track lit to the displayed score. It draws in `currentColor` because the bar's
 * background already carries the band hue; retained data draws as an outline.
 * Decorative: the regime-bar button carries the full label.
 */
export function PsiBeaconMicro({ score, retained }: { score: number; retained: boolean }) {
  const lit = (TRACK_LENGTH * Math.min(100, Math.max(0, score))) / 100;
  return (
    <svg
      viewBox="0 0 40 14"
      width={40}
      height={14}
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
      data-testid="psi-beacon-micro"
      data-state={retained ? "retained" : "current"}
    >
      <path d="M2.2,13L3,6.2H6L6.8,13Z M2.6,5.6H6.4V4.4H2.6Z M3,4L4.5,2.4L6,4Z" fill="currentColor" fillOpacity={0.75} />
      <line x1={TRACK_X0} y1={9.5} x2={TRACK_X0 + TRACK_LENGTH} y2={9.5} stroke="currentColor" strokeOpacity={0.4} strokeWidth={1} />
      <line x1={TRACK_X0 + TRACK_LENGTH} y1={7} x2={TRACK_X0 + TRACK_LENGTH} y2={12} stroke="currentColor" strokeOpacity={0.55} strokeWidth={0.8} />
      {retained ? (
        <rect x={TRACK_X0} y={8} width={lit} height={3} fill="none" stroke="currentColor" strokeWidth={0.8} />
      ) : (
        <rect x={TRACK_X0} y={8} width={lit} height={3} fill="currentColor" />
      )}
    </svg>
  );
}
