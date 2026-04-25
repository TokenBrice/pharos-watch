import type { CSSProperties } from "react";
import type { LighthouseCinematicModel, LighthousePoint } from "../cinematic-model";

function beamPath(origin: LighthousePoint, target: LighthousePoint, reachPct: number): string {
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const reach = Math.max(0.4, Math.min(1, reachPct / 100));
  const end = {
    x: origin.x + dx * reach,
    y: origin.y + dy * reach,
  };
  const normal = {
    x: -dy,
    y: dx,
  };
  const length = Math.max(1, Math.hypot(normal.x, normal.y));
  const spread = 74 + reach * 54;
  const nx = (normal.x / length) * spread;
  const ny = (normal.y / length) * spread;
  return `M ${origin.x} ${origin.y} L ${end.x + nx} ${end.y + ny} L ${end.x - nx} ${end.y - ny} Z`;
}

export function PharosTowerLayer({
  model,
}: {
  model: LighthouseCinematicModel;
}) {
  const lens = { x: model.stage.lighthouse.x, y: model.stage.lighthouse.y - 205 };
  const target = model.stage.activeTarget ?? { x: 1110, y: 486 };
  const color = model.lens.colorHex;

  return (
    <g className="lh-pharos-layer">
      <path
        className="lh-main-beam"
        d={beamPath(lens, target, model.lens.beamReachPct)}
        fill="url(#lh-main-beam-gradient)"
        opacity={model.lens.beamOpacity}
        style={{
          "--lh-lens-color": color,
        } as CSSProperties}
        aria-hidden="true"
      />
      <g
        className="lh-pharos-tower"
        transform={`translate(${model.stage.lighthouse.x} ${model.stage.lighthouse.y})`}
        aria-hidden="true"
        style={{
          "--lh-lens-color": color,
        } as CSSProperties}
      >
        <path
          d="M -190 80 C -126 20 -82 26 -38 0 C 10 -28 54 -12 92 14 C 132 40 166 42 218 82 L 236 112 L -214 112 Z"
          fill="oklch(0.08 0.02 242)"
        />
        <path d="M -150 68 C -84 42 -42 52 0 28 C 42 4 96 34 156 72" fill="none" stroke="oklch(0.56 0.06 205 / 0.24)" strokeWidth="2" />
        <ellipse cx="0" cy="118" rx="250" ry="34" fill="oklch(0.01 0.01 248 / 0.56)" />

        <path
          d="M -62 68 L -42 -106 L 42 -106 L 62 68 Z"
          fill="url(#lh-stone-gradient)"
          stroke="oklch(0.48 0.035 78 / 0.68)"
          strokeWidth="1.2"
        />
        {[-66, -28, 10, 46].map((y) => (
          <line key={y} x1="-49" y1={y} x2="49" y2={y} stroke="oklch(0.42 0.034 82 / 0.42)" strokeWidth="0.7" />
        ))}
        <path d="M -48 68 L -34 88 L 34 88 L 48 68 Z" fill="oklch(0.16 0.028 45)" />
        <rect x="-16" y="32" width="32" height="36" rx="12" fill="oklch(0.03 0.012 245 / 0.8)" />

        <path
          d="M -44 -106 L -34 -160 L 34 -160 L 44 -106 Z"
          fill="url(#lh-stone-gradient)"
          stroke="oklch(0.48 0.035 78 / 0.68)"
          strokeWidth="1.1"
        />
        <path d="M -38 -160 L -30 -188 L 30 -188 L 38 -160 Z" fill="oklch(0.76 0.045 74)" stroke="oklch(0.42 0.035 78)" strokeWidth="1" />
        <g className="lh-lens-prism">
          <circle cx="0" cy="-206" r="42" fill="oklch(0.02 0.014 242 / 0.9)" stroke={color} strokeWidth="3" />
          <circle cx="0" cy="-206" r="28" fill="none" stroke="oklch(1 0.08 88 / 0.42)" strokeWidth="1.2" />
          <circle cx="0" cy="-206" r="13" fill={color} opacity="0.9" />
          {Array.from({ length: 10 }).map((_, index) => (
            <line
              key={index}
              x1="0"
              y1="-238"
              x2="0"
              y2="-174"
              transform={`rotate(${index * 18} 0 -206)`}
              stroke="oklch(1 0.05 88 / 0.18)"
              strokeWidth="1"
            />
          ))}
        </g>
        <path d="M -28 -248 L -18 -286 L 18 -286 L 28 -248 Z" fill="oklch(0.22 0.048 45)" />
        <path className="lh-flame" d="M 0 -292 C -12 -276 -6 -260 0 -254 C 14 -266 13 -282 0 -292 Z" fill={color} />
        <circle cx="0" cy="-266" r="50" fill={color} opacity="0.13" className="lh-lens-halo" />
      </g>
    </g>
  );
}
