interface DiagramStepProps {
  x: number;
  label: string;
  subtitle?: string;
  width?: number;
}

export function DiagramStep({ x, label, subtitle, width = 150 }: DiagramStepProps) {
  return (
    <g transform={`translate(${x}, 30)`}>
      <rect
        x={0}
        y={0}
        width={width}
        height={60}
        rx={6}
        fill="currentColor"
        fillOpacity={0.05}
        stroke="currentColor"
        strokeOpacity={0.2}
        strokeWidth={1}
      />
      <text
        x={width / 2}
        y={26}
        textAnchor="middle"
        fontSize={13}
        fontWeight={600}
        fill="currentColor"
      >
        {label}
      </text>
      {subtitle ? (
        <text
          x={width / 2}
          y={44}
          textAnchor="middle"
          fontSize={10}
          fill="currentColor"
          fillOpacity={0.6}
        >
          {subtitle}
        </text>
      ) : null}
    </g>
  );
}

interface DiagramArrowProps {
  x: number;
  label?: string;
  width?: number;
}

export function DiagramArrow({ x, label, width = 40 }: DiagramArrowProps) {
  return (
    <g transform={`translate(${x}, 60)`}>
      <line
        x1={0}
        y1={0}
        x2={width - 8}
        y2={0}
        stroke="currentColor"
        strokeOpacity={0.4}
        strokeWidth={1.5}
      />
      <polygon
        points={`${width - 8},-4 ${width},0 ${width - 8},4`}
        fill="currentColor"
        fillOpacity={0.4}
      />
      {label ? (
        <text
          x={width / 2}
          y={-6}
          textAnchor="middle"
          fontSize={9}
          fill="currentColor"
          fillOpacity={0.55}
        >
          {label}
        </text>
      ) : null}
    </g>
  );
}
