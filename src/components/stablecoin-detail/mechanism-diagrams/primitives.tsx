import type { ReactNode } from "react";

export type DiagramTone = "default" | "warning" | "danger";

interface DiagramStepProps {
  x: number;
  y?: number;
  label?: string;
  subtitle?: string;
  width?: number;
  height?: number;
  callout?: string;
  stepNumber?: number;
  accentColor?: string;
  dashedBorder?: boolean;
  /**
   * Visual risk weight applied to the step background. `"danger"` adds a faint
   * warm-tinted fill and a stronger dash pattern, used by the algorithmic
   * archetype so its fragility reads at a glance.
   */
  tone?: DiagramTone;
  children?: ReactNode;
}

function fillForTone(tone: DiagramTone): string {
  if (tone === "danger") {
    return "color-mix(in oklch, var(--severity-severe) 8%, var(--card))";
  }
  if (tone === "warning") {
    return "color-mix(in oklch, var(--severity-mild) 8%, var(--card))";
  }
  return "var(--card)";
}

function dashPatternForTone(tone: DiagramTone): string {
  return tone === "danger" ? "5 3" : "3 3";
}

/**
 * Light-theme mechanism accents sit at OKLCH L 0.64–0.75 (~2:1 on light cards),
 * so step numerals mix the accent half-way toward `--foreground` for >= 4.5:1
 * legibility in both themes while retaining the archetype hue.
 */
function stepNumberFill(accentColor?: string): string {
  return accentColor
    ? `color-mix(in oklab, ${accentColor} 50%, var(--foreground))`
    : "var(--text-tertiary)";
}

export function DiagramStep({
  x,
  y = 30,
  label,
  subtitle,
  width = 150,
  height = 60,
  callout,
  stepNumber,
  accentColor,
  dashedBorder = false,
  tone = "default",
  children,
}: DiagramStepProps) {
  return (
    <g transform={`translate(${x}, ${y})`}>
      <rect
        x={0}
        y={0}
        width={width}
        height={height}
        rx={6}
        fill={fillForTone(tone)}
        stroke="var(--border-default)"
        strokeWidth={1}
        strokeDasharray={dashedBorder ? dashPatternForTone(tone) : undefined}
      />
      {stepNumber !== undefined ? (
        <text
          x={9}
          y={13}
          fontSize={8}
          fontWeight={700}
          letterSpacing="0.12em"
          fill={stepNumberFill(accentColor)}
          style={{
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          }}
        >
          {String(stepNumber).padStart(2, "0")}
        </text>
      ) : null}
      {children ? (
        children
      ) : (
        <>
          {label ? (
            <text
              x={width / 2}
              y={subtitle ? 28 : height / 2 + 4}
              textAnchor="middle"
              fontSize={13}
              fontWeight={600}
              fill="currentColor"
            >
              {label}
            </text>
          ) : null}
          {subtitle ? (
            <text
              x={width / 2}
              y={46}
              textAnchor="middle"
              fontSize={10}
              fill="var(--text-secondary)"
            >
              {subtitle}
            </text>
          ) : null}
        </>
      )}
      {callout ? (
        <text
          x={width / 2}
          y={height + 14}
          textAnchor="middle"
          fontSize={10}
          fontStyle="italic"
          fill="var(--text-tertiary)"
        >
          {callout}
        </text>
      ) : null}
    </g>
  );
}

interface DiagramArrowProps {
  x: number;
  y?: number;
  label?: string;
  width?: number;
  direction?: "right" | "down";
  dashed?: boolean;
  tone?: "default" | "danger";
}

export function DiagramArrow({
  x,
  y = 60,
  label,
  width = 50,
  direction = "right",
  dashed = false,
  tone = "default",
}: DiagramArrowProps) {
  const stroke =
    tone === "danger" ? "var(--severity-severe)" : "var(--text-tertiary)";
  const strokeDasharray = dashed ? "4 3" : undefined;

  if (direction === "down") {
    const tipY = width;
    const baseY = width - 11;
    return (
      <g transform={`translate(${x}, ${y})`}>
        <line
          x1={0}
          y1={0}
          x2={0}
          y2={baseY}
          stroke={stroke}
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeDasharray={strokeDasharray}
        />
        <polygon
          points={`-5.5,${baseY} 5.5,${baseY} 0,${tipY}`}
          fill={stroke}
        />
        {label ? (
          <text
            x={9}
            y={width / 2 + 3}
            fontSize={10}
            fill="var(--text-secondary)"
          >
            {label}
          </text>
        ) : null}
      </g>
    );
  }

  const tipX = width;
  const baseX = width - 11;
  return (
    <g transform={`translate(${x}, ${y})`}>
      <line
        x1={0}
        y1={0}
        x2={baseX}
        y2={0}
        stroke={stroke}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeDasharray={strokeDasharray}
      />
      <polygon
        points={`${baseX},-5.5 ${tipX},0 ${baseX},5.5`}
        fill={stroke}
      />
      {label ? (
        <text
          x={width / 2}
          y={-8}
          textAnchor="middle"
          fontSize={9}
          fill="var(--text-secondary)"
        >
          {label}
        </text>
      ) : null}
    </g>
  );
}

interface DiagramReturnArrowProps {
  fromX: number;
  toX: number;
  topY: number;
  peakY: number;
  label?: string;
  tone?: "default" | "danger";
  dashed?: boolean;
  /** When set, strokeWidth used for the curve (default 1.75). Use ~1.2 for light variants. */
  strokeWidth?: number;
}

export function DiagramReturnArrow({
  fromX,
  toX,
  topY,
  peakY,
  label,
  tone = "default",
  dashed = false,
  strokeWidth = 1.75,
}: DiagramReturnArrowProps) {
  const stroke =
    tone === "danger" ? "var(--severity-severe)" : "var(--text-tertiary)";
  const strokeDasharray = dashed ? "4 3" : undefined;
  const midX = (fromX + toX) / 2;
  const arrowBaseY = topY + 11;
  return (
    <g>
      <path
        d={`M ${fromX} ${topY} C ${fromX} ${peakY} ${toX} ${peakY} ${toX} ${arrowBaseY}`}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={strokeDasharray}
      />
      <polygon
        points={`${toX - 5.5},${arrowBaseY} ${toX + 5.5},${arrowBaseY} ${toX},${topY}`}
        fill={stroke}
      />
      {label ? (
        <text
          x={midX}
          y={topY + 18}
          textAnchor="middle"
          fontSize={10}
          fontWeight={600}
          fill={tone === "danger" ? "var(--severity-severe)" : "var(--text-secondary)"}
        >
          {label}
        </text>
      ) : null}
    </g>
  );
}

interface DiagramLoopArrowProps {
  fromX: number;
  toX: number;
  baseY: number;
  peakY: number;
  label?: string;
  labelY?: number;
}

export function DiagramLoopArrow({
  fromX,
  toX,
  baseY,
  peakY,
  label,
  labelY,
}: DiagramLoopArrowProps) {
  const midX = (fromX + toX) / 2;
  const arrowTipX = toX;
  const arrowBaseX = toX - 11;
  return (
    <g>
      <path
        d={`M ${fromX} ${baseY} Q ${midX} ${peakY} ${arrowBaseX} ${baseY}`}
        fill="none"
        stroke="var(--text-tertiary)"
        strokeWidth={1.75}
        strokeLinecap="round"
      />
      <polygon
        points={`${arrowBaseX},${baseY - 5.5} ${arrowTipX},${baseY} ${arrowBaseX},${baseY + 5.5}`}
        fill="var(--text-tertiary)"
      />
      {label ? (
        <text
          x={midX}
          y={labelY ?? peakY + (baseY - peakY) / 2}
          textAnchor="middle"
          fontSize={9}
          fontStyle="italic"
          fill="var(--text-tertiary)"
        >
          {label}
        </text>
      ) : null}
    </g>
  );
}

export interface MechanismDiagramStep {
  label: string;
  subtitle?: string;
  /** Accent color for the mobile ribbon and step number. Optional. */
  accentColor?: string;
  /** Pass through the algorithmic dashed-border treatment to mobile. */
  dashedBorder?: boolean;
  /** Pass through step fill tone (e.g. `"danger"` on algorithmic) to mobile. */
  tone?: DiagramTone;
  /** Step number to render in the mobile fallback. */
  stepNumber?: number;
}

export interface MechanismDiagramReturnLoop {
  label: string;
  tone?: Extract<DiagramTone, "default" | "danger">;
  dashed?: boolean;
}

interface MechanismDiagramShellProps {
  ariaLabel: string;
  description: string;
  desktopHeight?: number;
  steps: ReadonlyArray<MechanismDiagramStep>;
  /**
   * Optional return/carry loop caption rendered inside the mobile-stacked SVG
   * so mobile readers see the same exit or stress loop as desktop readers.
   */
  returnLoop?: MechanismDiagramReturnLoop;
  /**
   * Optional italic footnote rendered beneath both desktop and mobile SVGs.
   * Used by each archetype to anchor its local stress path or dated precedent.
   */
  stressFootnote?: string;
  children: ReactNode;
}

export function MechanismDiagramShell({
  ariaLabel,
  description,
  desktopHeight = 120,
  steps,
  returnLoop,
  stressFootnote,
  children,
}: MechanismDiagramShellProps) {
  return (
    <div className="w-full max-w-2xl">
      <svg
        viewBox={`0 0 600 ${desktopHeight}`}
        className="hidden sm:block w-full text-foreground"
        role="img"
        aria-label={ariaLabel}
      >
        <desc>{description}</desc>
        {children}
      </svg>
      <MobileStackedDiagram
        steps={steps}
        returnLoop={returnLoop}
        ariaLabel={ariaLabel}
        description={description}
      />
      {stressFootnote ? (
        <p className="mx-auto mt-2.5 max-w-2xl text-center text-xs italic text-muted-foreground">
          {stressFootnote}
        </p>
      ) : null}
    </div>
  );
}

interface MobileStackedDiagramProps {
  steps: ReadonlyArray<MechanismDiagramStep>;
  returnLoop?: MechanismDiagramReturnLoop;
  ariaLabel: string;
  description: string;
}

function MobileStackedDiagram({
  steps,
  returnLoop,
  ariaLabel,
  description,
}: MobileStackedDiagramProps) {
  const stepWidth = 200;
  const stepHeight = 60;
  const ribbonWidth = 3;
  const arrowLength = 28;
  const gap = 8;
  const padX = 10;
  const padY = 10;
  const loopGap = 10;
  const loopHeight = 24;
  const viewWidth = stepWidth + padX * 2;
  const positions = steps.map(
    (_, i) => padY + i * (stepHeight + gap + arrowLength + gap),
  );
  const lastY = positions[positions.length - 1] ?? padY;
  const loopY = lastY + stepHeight + loopGap;
  const viewHeight = returnLoop
    ? loopY + loopHeight + padY
    : lastY + stepHeight + padY;
  const arrowX = padX + stepWidth / 2;

  return (
    <svg
      viewBox={`0 0 ${viewWidth} ${viewHeight}`}
      className="block sm:hidden mx-auto w-full max-w-[260px] text-foreground"
      role="img"
      aria-label={ariaLabel}
    >
      <desc>{description}</desc>
      {steps.map((step, i) => {
        const y = positions[i];
        const accent = step.accentColor;
        const tone = step.tone ?? "default";
        return (
          <g key={`step-${i}`} transform={`translate(${padX}, ${y})`}>
            <rect
              x={0}
              y={0}
              width={stepWidth}
              height={stepHeight}
              rx={6}
              fill={fillForTone(tone)}
              stroke="var(--border-default)"
              strokeWidth={1}
              strokeDasharray={step.dashedBorder ? dashPatternForTone(tone) : undefined}
            />
            {accent ? (
              <rect
                x={0}
                y={0}
                width={ribbonWidth}
                height={stepHeight}
                rx={1.5}
                fill={accent}
              />
            ) : null}
            {step.stepNumber !== undefined ? (
              <text
                x={accent ? ribbonWidth + 7 : 9}
                y={13}
                fontSize={8}
                fontWeight={700}
                letterSpacing="0.12em"
                fill={stepNumberFill(accent)}
                style={{
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                }}
              >
                {String(step.stepNumber).padStart(2, "0")}
              </text>
            ) : null}
            <text
              x={stepWidth / 2}
              y={28}
              textAnchor="middle"
              fontSize={13}
              fontWeight={600}
              fill="currentColor"
            >
              {step.label}
            </text>
            {step.subtitle ? (
              <text
                x={stepWidth / 2}
                y={46}
                textAnchor="middle"
                fontSize={10}
                fill="var(--text-secondary)"
              >
                {step.subtitle}
              </text>
            ) : null}
          </g>
        );
      })}
      {steps.slice(0, -1).map((step, i) => (
        <DiagramArrow
          key={`arrow-${i}`}
          x={arrowX}
          y={positions[i] + stepHeight + gap}
          width={arrowLength}
          direction="down"
          dashed={Boolean(step.dashedBorder)}
        />
      ))}
      {returnLoop ? (
        <g transform={`translate(${padX}, ${loopY})`}>
          <rect
            x={0}
            y={0}
            width={stepWidth}
            height={loopHeight}
            rx={6}
            fill={returnLoop.tone === "danger" ? fillForTone("danger") : "transparent"}
            stroke={
              returnLoop.tone === "danger"
                ? "var(--severity-severe)"
                : "var(--border-default)"
            }
            strokeWidth={1}
            strokeDasharray={
              returnLoop.dashed
                ? returnLoop.tone === "danger"
                  ? "5 3"
                  : "4 3"
                : undefined
            }
          />
          <text
            x={stepWidth / 2}
            y={loopHeight / 2 + 3.5}
            textAnchor="middle"
            fontSize={10}
            fontWeight={600}
            fill={
              returnLoop.tone === "danger"
                ? "var(--severity-severe)"
                : "var(--text-secondary)"
            }
          >
            {`↺ ${returnLoop.label}`}
          </text>
        </g>
      ) : null}
    </svg>
  );
}
