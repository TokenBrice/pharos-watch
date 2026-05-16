import type { ReactNode } from "react";

interface DiagramStepProps {
  x: number;
  y?: number;
  label?: string;
  subtitle?: string;
  width?: number;
  height?: number;
  callout?: string;
  children?: ReactNode;
}

export function DiagramStep({
  x,
  y = 30,
  label,
  subtitle,
  width = 150,
  height = 60,
  callout,
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
        fill="var(--card)"
        stroke="var(--border-default)"
        strokeWidth={1}
      />
      {children ? (
        children
      ) : (
        <>
          {label ? (
            <text
              x={width / 2}
              y={subtitle ? 26 : height / 2 + 4}
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
              y={44}
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
    const baseY = width - 10;
    return (
      <g transform={`translate(${x}, ${y})`}>
        <line
          x1={0}
          y1={0}
          x2={0}
          y2={baseY}
          stroke={stroke}
          strokeWidth={1.5}
          strokeDasharray={strokeDasharray}
        />
        <polygon
          points={`-5,${baseY} 5,${baseY} 0,${tipY}`}
          fill={stroke}
        />
        {label ? (
          <text
            x={8}
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
  const baseX = width - 10;
  return (
    <g transform={`translate(${x}, ${y})`}>
      <line
        x1={0}
        y1={0}
        x2={baseX}
        y2={0}
        stroke={stroke}
        strokeWidth={1.5}
        strokeDasharray={strokeDasharray}
      />
      <polygon
        points={`${baseX},-5 ${tipX},0 ${baseX},5`}
        fill={stroke}
      />
      {label ? (
        <text
          x={width / 2}
          y={-7}
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
}

export function DiagramReturnArrow({
  fromX,
  toX,
  topY,
  peakY,
  label,
  tone = "default",
  dashed = false,
}: DiagramReturnArrowProps) {
  const stroke =
    tone === "danger" ? "var(--severity-severe)" : "var(--text-tertiary)";
  const strokeDasharray = dashed ? "4 3" : undefined;
  const midX = (fromX + toX) / 2;
  const arrowTipX = toX;
  const arrowBaseX = toX + 10;
  return (
    <g>
      <path
        d={`M ${fromX} ${topY} Q ${midX} ${peakY} ${arrowBaseX} ${topY}`}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeDasharray={strokeDasharray}
      />
      <polygon
        points={`${arrowBaseX},${topY - 5} ${arrowTipX},${topY} ${arrowBaseX},${topY + 5}`}
        fill={stroke}
      />
      {label ? (
        <text
          x={midX}
          y={topY + 14}
          textAnchor="middle"
          fontSize={10}
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
}

export function DiagramLoopArrow({
  fromX,
  toX,
  baseY,
  peakY,
  label,
}: DiagramLoopArrowProps) {
  const midX = (fromX + toX) / 2;
  const arrowTipX = toX;
  const arrowBaseX = toX - 10;
  return (
    <g>
      <path
        d={`M ${fromX} ${baseY} Q ${midX} ${peakY} ${arrowBaseX} ${baseY}`}
        fill="none"
        stroke="var(--text-tertiary)"
        strokeWidth={1.5}
      />
      <polygon
        points={`${arrowBaseX},${baseY - 5} ${arrowTipX},${baseY} ${arrowBaseX},${baseY + 5}`}
        fill="var(--text-tertiary)"
      />
      {label ? (
        <text
          x={midX}
          y={peakY + (baseY - peakY) / 2}
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

interface MechanismDiagramShellProps {
  ariaLabel: string;
  description: string;
  desktopHeight?: number;
  steps: ReadonlyArray<{ label: string; subtitle?: string }>;
  children: ReactNode;
}

export function MechanismDiagramShell({
  ariaLabel,
  description,
  desktopHeight = 120,
  steps,
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
        ariaLabel={ariaLabel}
        description={description}
      />
    </div>
  );
}

interface MobileStackedDiagramProps {
  steps: ReadonlyArray<{ label: string; subtitle?: string }>;
  ariaLabel: string;
  description: string;
}

function MobileStackedDiagram({
  steps,
  ariaLabel,
  description,
}: MobileStackedDiagramProps) {
  const stepWidth = 200;
  const stepHeight = 60;
  const arrowLength = 28;
  const gap = 8;
  const padX = 10;
  const padY = 10;
  const viewWidth = stepWidth + padX * 2;
  const positions = steps.map(
    (_, i) => padY + i * (stepHeight + gap + arrowLength + gap),
  );
  const lastY = positions[positions.length - 1] ?? padY;
  const viewHeight = lastY + stepHeight + padY;
  const arrowX = padX + stepWidth / 2;

  return (
    <svg
      viewBox={`0 0 ${viewWidth} ${viewHeight}`}
      className="block sm:hidden mx-auto w-full max-w-[260px] text-foreground"
      role="img"
      aria-label={ariaLabel}
    >
      <desc>{description}</desc>
      {steps.map((step, i) => (
        <DiagramStep
          key={`step-${i}`}
          x={padX}
          y={positions[i]}
          width={stepWidth}
          label={step.label}
          subtitle={step.subtitle}
        />
      ))}
      {steps.slice(0, -1).map((_, i) => (
        <DiagramArrow
          key={`arrow-${i}`}
          x={arrowX}
          y={positions[i] + stepHeight + gap}
          width={arrowLength}
          direction="down"
        />
      ))}
    </svg>
  );
}
