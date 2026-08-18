import { cn } from "@/lib/utils";
import {
  resolveThreeStepConfig,
  type ThreeStepArchetypeDiagramProps,
} from "./three-step-archetype-diagram";

/**
 * Vertical rendition of the three-step mechanism flow for the Peg Stability
 * card (Figma coin template): numbered accent tiles, mono uppercase step
 * labels, downward connectors, and a right-side return bracket (redeem /
 * liquidation loop). DOM-based (not the shared SVG shell) so step boxes can
 * flow with their text at any width; the horizontal SVG diagram remains the
 * renderer for /learn explainers and the inline Key Info section.
 */
export function VerticalThreeStepDiagram({
  archetype,
  symbol,
  steps: overrideSteps,
  stressFootnote,
  navToken,
}: ThreeStepArchetypeDiagramProps) {
  const config = resolveThreeStepConfig(archetype, navToken);
  const steps = config.defaultSteps(symbol).map((step, index) => ({
    label: overrideSteps?.[index]?.label ?? step.label,
    subtitle: overrideSteps?.[index]?.subtitle ?? step.subtitle,
  }));
  const accent = config.accentColor;
  const dashed = config.dashed === true;
  const note = stressFootnote ?? config.stressFootnote;
  const returnArrow = config.returnArrow;
  // Config toX targets the horizontal SVG's x-coordinates: >200 points at the
  // middle step (redeem loops), lower values at the first step (liquidation /
  // collapse loops). Box centers sit near 13% / 50% / 87% of the stack.
  const returnTopPct = returnArrow ? (returnArrow.toX > 200 ? "50%" : "13%") : null;
  const returnDanger = returnArrow?.tone === "danger";

  return (
    <div
      role="img"
      aria-label={config.ariaLabel(symbol)}
      className="flex w-full flex-col items-center"
    >
      <span className="sr-only">{config.description(symbol)}</span>
      <div className={cn("relative w-full max-w-[300px]", returnArrow && "pr-1")} aria-hidden="true">
        {steps.map((step, index) => (
          <div key={step.label} className="flex flex-col items-center">
            {index > 0 ? (
              <svg width="10" height="20" viewBox="0 0 10 20" className="text-muted-foreground/70">
                <line
                  x1="5"
                  y1="0"
                  x2="5"
                  y2="14"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeDasharray={dashed ? "3 3" : undefined}
                />
                <polyline
                  points="1.5,13 5,18.5 8.5,13"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
              </svg>
            ) : null}
            <div
              className={cn(
                "flex w-full items-center gap-3 rounded-lg border bg-background/40 px-3.5 py-2.5",
                dashed ? "border-dashed border-border" : "border-border/70",
              )}
            >
              <span
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border font-mono text-xs font-semibold"
                style={{
                  color: accent,
                  borderColor: `color-mix(in oklab, ${accent} 45%, transparent)`,
                  backgroundColor: `color-mix(in oklab, ${accent} 12%, transparent)`,
                }}
              >
                {index + 1}
              </span>
              <span className="min-w-0">
                <span className="block truncate font-mono text-sm font-semibold uppercase tracking-wide text-foreground">
                  {step.label}
                </span>
                {step.subtitle ? (
                  <span className="block truncate font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                    {step.subtitle}
                  </span>
                ) : null}
              </span>
            </div>
          </div>
        ))}

        {returnArrow && returnTopPct ? (
          <>
            <div
              className={cn(
                "absolute -right-3.5 bottom-[13%] w-3.5 rounded-r-lg border-y border-r",
                returnArrow.dashed && "border-dashed",
                returnDanger ? "border-red-500/60" : "border-border",
              )}
              style={{ top: returnTopPct }}
            />
            <span
              className={cn(
                "absolute -right-2 -translate-y-1/2 border-y-4 border-r-4 border-y-transparent",
                returnDanger ? "border-r-red-500/80" : "border-r-muted-foreground",
              )}
              style={{ top: returnTopPct }}
            />
          </>
        ) : null}
      </div>
      {returnArrow ? (
        <p
          aria-hidden="true"
          className={cn(
            "mt-2 self-end font-mono text-[9px] uppercase tracking-[0.14em]",
            returnDanger ? "text-red-600 dark:text-red-400" : "text-muted-foreground",
          )}
        >
          ↺ {returnArrow.label}
        </p>
      ) : null}
      {note ? (
        <p className="mt-2 text-center text-xs italic text-muted-foreground/80">{note}</p>
      ) : null}
    </div>
  );
}
