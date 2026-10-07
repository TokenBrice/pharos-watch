import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";
import type {
  MechanismFlowLoop,
  MechanismFlowStep,
  MechanismFlowTemplate,
  WrapperLayer,
} from "./mechanism-template";

/**
 * The Mechanism module's flow: the resolved template as real DOM text, so
 * every glyph stays at body sizes (≥ 12 px) at any width instead of scaling
 * down with an SVG viewBox. Steps stack vertically in a narrow container and
 * run as one row of tracks from `@3xl` (48 rem) up; the return or carry loop
 * draws as a bracket under the row and reads as a caption when stacked.
 *
 * Wrappers draw the parent's flow, grouped under the parent's name, followed
 * by the wrapper layer as a fourth track.
 */

/** Gutter between step tracks in the row layout; matches `@3xl:gap-x-10`. */
const TRACK_GAP_REM = 2.5;
const TRACK_COUNT = 3;

/**
 * Centre of track `index` in the three-track row, from the row's left edge:
 * each track is `(100% - 2 gutters) / 3` wide and starts `index` tracks and
 * gutters in.
 */
function trackCenter(index: number): string {
  const fraction = (2 * index + 1) / (2 * TRACK_COUNT);
  const offsetRem = index * TRACK_GAP_REM - (TRACK_COUNT - 1) * TRACK_GAP_REM * fraction;
  return `calc(${Number((fraction * 100).toFixed(4))}% + ${Number(offsetRem.toFixed(4))}rem)`;
}

const DANGER_COLOR = "var(--severity-severe)";

const FRAGILE_FILL: CSSProperties = {
  backgroundColor: `color-mix(in oklch, ${DANGER_COLOR} 6%, transparent)`,
};

function Connector({ dashed }: { dashed: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-7 items-center justify-center text-muted-foreground/70 @3xl:absolute @3xl:inset-y-0 @3xl:right-full @3xl:h-auto @3xl:w-10"
    >
      <svg viewBox="0 0 10 20" width="10" height="20" className="@3xl:-rotate-90">
        <line x1="5" y1="1" x2="5" y2="15" stroke="currentColor" strokeWidth="1.25" strokeDasharray={dashed ? "3 3" : undefined} />
        <polyline
          points="1.5,13.5 5,18.5 8.5,13.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

function StepCard({
  step,
  number,
  accentColor,
  fragile = false,
  wrapper = false,
}: {
  step: MechanismFlowStep;
  number: number;
  /**
   * Archetype accent for the step number; wrapper layers stay neutral. The
   * light-theme accents sit at OKLCH L 0.65–0.75 (about 2:1 on the card), so
   * the numeral mixes the accent half-way toward the foreground: ≥ 4.5:1 in
   * both themes, still read as the archetype hue. Fill and border keep the
   * pure accent; they are decoration, not text.
   */
  accentColor?: string;
  fragile?: boolean;
  wrapper?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-1 items-start gap-3 rounded-lg border px-3.5 py-3",
        wrapper ? "border-foreground/25 bg-muted/30" : "bg-background/40",
        !wrapper && (fragile ? "border-dashed border-border" : "border-border/70"),
      )}
      style={fragile ? FRAGILE_FILL : undefined}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-md border font-mono text-xs font-semibold tabular-nums",
          !accentColor && "border-border text-muted-foreground",
        )}
        style={
          accentColor
            ? {
                color: `color-mix(in oklab, ${accentColor} 50%, var(--foreground))`,
                borderColor: `color-mix(in oklab, ${accentColor} 45%, transparent)`,
                backgroundColor: `color-mix(in oklab, ${accentColor} 12%, transparent)`,
              }
            : undefined
        }
      >
        {String(number).padStart(2, "0")}
      </span>
      <span className="min-w-0 pt-0.5">
        <span className="block text-pretty text-sm font-semibold leading-snug text-foreground">{step.label}</span>
        {step.subtitle ? (
          <span className="mt-0.5 block text-pretty text-xs leading-snug text-muted-foreground">{step.subtitle}</span>
        ) : null}
      </span>
    </div>
  );
}

/** Row-layout bracket under the steps: legs at both step centres, arrowhead into `to`. */
function LoopBracket({ loop }: { loop: MechanismFlowLoop }) {
  const left = trackCenter(Math.min(loop.from, loop.to));
  const right = `calc(100% - ${trackCenter(Math.max(loop.from, loop.to))})`;
  const lineColor = loop.danger ? DANGER_COLOR : "var(--text-tertiary)";
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 hidden h-9 @3xl:block">
      <span
        className="absolute -translate-x-1/2 border-x-[4.5px] border-b-[6px] border-x-transparent"
        style={{ left: trackCenter(loop.to), top: 0, borderBottomColor: lineColor }}
      />
      <span
        className={cn("absolute top-1.5 h-3.5 rounded-b-md border-x border-b", loop.dashed && "border-dashed")}
        style={{ left, right, borderColor: lineColor }}
      />
      <span className="absolute top-5 flex justify-center" style={{ left, right }}>
        <span
          className={cn(
            "-translate-y-1/2 whitespace-nowrap bg-card px-1.5 text-xs font-medium leading-none",
            !loop.danger && "text-muted-foreground",
          )}
          style={loop.danger ? { color: DANGER_COLOR } : undefined}
        >
          {loop.label}
        </span>
      </span>
    </div>
  );
}

/** The loop as text: visible when steps stack, screen-reader-only in the row layout. */
function LoopCaption({ loop }: { loop: MechanismFlowLoop }) {
  return (
    <p
      className={cn("mt-2 text-xs @3xl:sr-only", !loop.danger && "text-muted-foreground")}
      style={loop.danger ? { color: DANGER_COLOR } : undefined}
    >
      <span aria-hidden="true">↺ </span>
      <span className="font-medium">{loop.label}</span>
      <span className="text-muted-foreground">
        {" "}
        · from step {loop.from + 1} to step {loop.to + 1}
      </span>
    </p>
  );
}

function StepList({ template }: { template: MechanismFlowTemplate }) {
  return (
    <div className="flex flex-1 flex-col">
      <div className={cn("relative flex flex-1 flex-col", template.loop && "@3xl:pb-10")}>
        <ol className="grid flex-1 @3xl:grid-cols-3 @3xl:gap-x-10">
          {template.steps.map((step, index) => (
            <li key={step.label} className="relative flex flex-col">
              {index > 0 ? <Connector dashed={template.fragile} /> : null}
              <StepCard step={step} number={index + 1} accentColor={template.accentColor} fragile={template.fragile} />
            </li>
          ))}
        </ol>
        {template.loop ? <LoopBracket loop={template.loop} /> : null}
      </div>
      {template.loop ? <LoopCaption loop={template.loop} /> : null}
    </div>
  );
}

const GROUP_CAPTION_CLASS = "mb-2.5 border-b border-border/50 pb-1.5 text-xs font-medium text-muted-foreground";

export interface MechanismFlowProps {
  /** The coin's flow, or the parent's flow when `wrapper` is set. */
  template: MechanismFlowTemplate;
  /** Wrapper coins: the layer drawn after the parent's flow. */
  wrapper?: WrapperLayer | null;
  /** Trailing slot on the stress line (the explainer link). */
  action?: ReactNode;
}

export function MechanismFlow({ template, wrapper = null, action = null }: MechanismFlowProps) {
  const stressFootnote = wrapper ? wrapper.stressFootnote : template.stressFootnote;
  return (
    <figure className="@container space-y-4">
      <figcaption className="sr-only">
        {wrapper ? `${wrapper.ariaLabel} ${template.description}` : `${template.ariaLabel} ${template.description}`}
      </figcaption>
      {wrapper ? (
        <div className="grid max-w-lg gap-y-3 @3xl:max-w-none @3xl:grid-cols-4 @3xl:gap-x-10">
          <div className="flex min-w-0 flex-col @3xl:col-span-3">
            <p className={GROUP_CAPTION_CLASS}>{wrapper.parentSymbol} mechanism</p>
            <StepList template={template} />
          </div>
          <div className="flex min-w-0 flex-col">
            <p className={GROUP_CAPTION_CLASS}>Wrapper layer</p>
            <ol start={TRACK_COUNT + 1} className={cn("flex flex-1 flex-col", template.loop && "@3xl:pb-10")}>
              <li className="relative flex flex-1 flex-col">
                <Connector dashed={false} />
                <StepCard
                  step={{ label: wrapper.symbol, subtitle: `${wrapper.kind}: ${wrapper.description}` }}
                  number={TRACK_COUNT + 1}
                  wrapper
                />
              </li>
            </ol>
          </div>
        </div>
      ) : (
        <div className="flex max-w-lg flex-col @3xl:max-w-none">
          <StepList template={template} />
        </div>
      )}
      {stressFootnote || action ? (
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          {stressFootnote ? <p className="text-xs italic text-muted-foreground">{stressFootnote}</p> : null}
          {action}
        </div>
      ) : null}
    </figure>
  );
}
