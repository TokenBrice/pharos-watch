import type { CSSProperties } from "react";
import type { LighthouseCinematicModel } from "../cinematic-model";

const RINGS = [52, 96, 142, 188, 232];

export function DewsRadarLayer({
  model,
}: {
  model: LighthouseCinematicModel;
}) {
  const active = model.stage.mode === "radar";
  const color = model.radar.highestColorHex;
  return (
    <g
      className={active ? "lh-dews-radar-layer lh-dews-radar-layer--active" : "lh-dews-radar-layer"}
      style={{
        "--lh-radar-color": color,
        "--lh-radar-sweep-duration": `${model.radar.sweepDurationSec}s`,
      } as CSSProperties}
      aria-hidden="true"
    >
      <g transform="translate(720 318)">
        {RINGS.map((ring) => (
          <circle key={ring} cx="0" cy="0" r={ring} fill="none" stroke={color} strokeOpacity="0.22" strokeWidth="1" strokeDasharray="5 8" />
        ))}
        {Array.from({ length: 8 }).map((_, index) => (
          <line
            key={index}
            x1="0"
            y1="-12"
            x2="0"
            y2="-232"
            transform={`rotate(${index * 45})`}
            stroke="oklch(0.78 0.055 205 / 0.16)"
            strokeWidth="1"
          />
        ))}
        <g className="lh-radar-sweep">
          <path d="M 0 0 L 0 -232 A 232 232 0 0 1 164 -164 Z" fill="url(#lh-radar-wake)" />
          <line x1="0" y1="0" x2="232" y2="0" stroke={color} strokeOpacity="0.72" strokeWidth="1.8" strokeLinecap="round" />
        </g>
        <circle cx="0" cy="0" r="34" fill={color} opacity="0.13" stroke={color} strokeOpacity="0.3" />
      </g>
      {Array.from({ length: Math.round(model.radar.calmDensity * 26) }).map((_, index) => (
        <circle
          key={index}
          cx={210 + ((index * 71) % 1040)}
          cy={198 + ((index * 43) % 220)}
          r="1.8"
          fill="oklch(0.78 0.04 205 / 0.28)"
        />
      ))}
      {model.radar.elevated.map((mark) => (
        <g key={mark.id} className="lh-dews-blip" transform={`translate(${mark.x} ${mark.y})`}>
          <circle r={mark.radius + 9} fill={mark.colorHex} opacity="0.13" />
          <circle r={mark.radius} fill={mark.colorHex} opacity="0.9" />
        </g>
      ))}
    </g>
  );
}
