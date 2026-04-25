import type { CSSProperties, KeyboardEvent } from "react";
import type { LighthouseHarborMark, LighthouseTailMark } from "../cinematic-model";

function Wake({ harbor }: { harbor: LighthouseHarborMark }) {
  if (harbor.wakeDirection === 0) return null;
  const sign = harbor.wakeDirection > 0 ? -1 : 1;
  const length = 42 + Math.abs(harbor.wakeLength) * 146;
  return (
    <path
      className="lh-harbor-wake"
      d={`M ${-sign * 36} 32 C ${-sign * 70} 46 ${-sign * length} 34 ${-sign * (length + 38)} 48`}
      fill="none"
      stroke={harbor.wakeDirection > 0 ? "oklch(0.72 0.15 155 / 0.46)" : "oklch(0.7 0.16 30 / 0.44)"}
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    />
  );
}

function HarborMark({
  harbor,
  onSelect,
  onPreview,
  onPreviewEnd,
}: {
  harbor: LighthouseHarborMark;
  onSelect: (id: string) => void;
  onPreview?: (id: string) => void;
  onPreviewEnd?: () => void;
}) {
  const handleKeyDown = (event: KeyboardEvent<SVGGElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelect(harbor.id);
  };
  const hullW = harbor.hullWidth;
  const hullH = harbor.hullHeight;

  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={harbor.ariaLabel}
      aria-pressed={harbor.isSelected}
      data-harbor-id={harbor.id}
      data-testid={`lighthouse-harbor-${harbor.id}`}
      className={harbor.isSelected ? "lh-harbor-mark lh-harbor-mark--selected" : "lh-harbor-mark"}
      transform={`translate(${harbor.x} ${harbor.y})`}
      onClick={() => onSelect(harbor.id)}
      onKeyDown={handleKeyDown}
      onPointerEnter={() => onPreview?.(harbor.id)}
      onPointerLeave={() => onPreviewEnd?.()}
      onFocus={() => onPreview?.(harbor.id)}
      onBlur={() => onPreviewEnd?.()}
      style={{
        "--lh-harbor-color": harbor.healthColorHex,
      } as CSSProperties}
    >
      <title>{harbor.ariaLabel}</title>
      <rect x={-hullW / 2 - 32} y={-harbor.mastHeight - 42} width={hullW + 64} height={harbor.mastHeight + 114} rx="18" fill="transparent" />
      <Wake harbor={harbor} />
      <ellipse cx="0" cy="46" rx={Math.max(28, hullW * 0.55)} ry="10" fill={harbor.healthColorHex} opacity="0.15" className="lh-harbor-reflection" />
      <path
        d={`M ${-hullW / 2} 2 L ${hullW / 2 - 12} 2 Q ${hullW / 2 + 10} ${hullH * 0.34} ${hullW / 2 - 4} ${hullH} L ${-hullW / 2 + 12} ${hullH} Q ${-hullW / 2 - 12} ${hullH * 0.54} ${-hullW / 2} 2 Z`}
        fill="url(#lh-ship-hull)"
        stroke={harbor.healthColorHex}
        strokeOpacity="0.48"
        strokeWidth="1.2"
      />
      {Array.from({ length: harbor.cargoCount }).map((_, index) => {
        const spacing = hullW / (harbor.cargoCount + 1);
        return (
          <rect
            key={index}
            x={-hullW / 2 + spacing * (index + 1) - 5}
            y={-11 - (index % 2) * 5}
            width="10"
            height="10"
            rx="2"
            fill={harbor.healthColorHex}
            opacity={index === 0 ? 0.9 : 0.58}
          />
        );
      })}
      <line x1="0" y1="0" x2="0" y2={-harbor.mastHeight} stroke="oklch(0.91 0.025 250 / 0.72)" strokeWidth="2" />
      <path
        d={`M 0 ${-harbor.mastHeight + 10} L ${harbor.pennantWidth} ${-harbor.mastHeight + 20} L 0 ${-harbor.mastHeight + 32} Z`}
        fill={harbor.healthColorHex}
        opacity="0.82"
        className="lh-harbor-pennant"
      />
      <path
        d={`M 0 -14 C ${-hullW * 0.2} -44 ${-hullW * 0.18} ${-harbor.mastHeight + 28} 0 ${-harbor.mastHeight + 42} C ${hullW * 0.22} ${-harbor.mastHeight + 22} ${hullW * 0.28} -40 0 -14 Z`}
        fill="url(#lh-sail-gradient)"
        opacity="0.76"
      />
      <circle cx="0" cy={-harbor.mastHeight - 17} r={harbor.isSelected ? 18 : 14} fill="oklch(0.025 0.018 245 / 0.9)" stroke={harbor.healthColorHex} strokeWidth={harbor.isSelected ? 3 : 2} className="lh-harbor-signal" />
      <image href={harbor.logoPath} x="-10" y={-harbor.mastHeight - 27} width="20" height="20" preserveAspectRatio="xMidYMid meet" aria-hidden="true" />
      {Array.from({ length: harbor.draftLayers }).map((_, index) => (
        <path
          key={index}
          d={`M ${-hullW * 0.42} ${hullH + 8 + index * 8} C ${-hullW * 0.14} ${hullH + 14 + index * 8} ${hullW * 0.12} ${hullH + 12 + index * 8} ${hullW * 0.42} ${hullH + 8 + index * 8}`}
          fill="none"
          stroke={harbor.healthColorHex}
          strokeOpacity={0.18 + index * 0.06}
          strokeWidth="1"
        />
      ))}
    </g>
  );
}

function TailFleet({ tail }: { tail: LighthouseTailMark | null }) {
  if (!tail) return null;
  return (
    <g className="lh-tail-fleet" aria-label={tail.ariaLabel}>
      <title>{tail.ariaLabel}</title>
      {tail.lights.map((light, index) => (
        <circle key={index} cx={light.x} cy={light.y} r="3" fill="oklch(0.75 0.05 205 / 0.5)" />
      ))}
    </g>
  );
}

export function HarborFleetLayer({
  harbors,
  tail,
  onSelect,
  onPreview,
  onPreviewEnd,
}: {
  harbors: LighthouseHarborMark[];
  tail: LighthouseTailMark | null;
  onSelect: (id: string) => void;
  onPreview?: (id: string) => void;
  onPreviewEnd?: () => void;
}) {
  return (
    <g className="lh-harbor-fleet-layer">
      <TailFleet tail={tail} />
      {harbors.map((harbor) => (
        <HarborMark
          key={harbor.id}
          harbor={harbor}
          onSelect={onSelect}
          onPreview={onPreview}
          onPreviewEnd={onPreviewEnd}
        />
      ))}
    </g>
  );
}
