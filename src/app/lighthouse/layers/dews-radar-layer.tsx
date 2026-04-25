import type { CSSProperties } from "react";
import { THREAT_BAND_HEX, type ThreatBand } from "@shared/lib/classification";
import type { LighthouseCinematicModel } from "../cinematic-model";

const BAND_RINGS: Array<{ band: ThreatBand; radius: number; startAngle: number }> = [
  { band: "DANGER", radius: 48, startAngle: 318 },
  { band: "WARNING", radius: 78, startAngle: 248 },
  { band: "ALERT", radius: 108, startAngle: 178 },
  { band: "WATCH", radius: 138, startAngle: 108 },
  { band: "CALM", radius: 166, startAngle: 42 },
];

const SPOKE_ANGLES = Array.from({ length: 12 }, (_, index) => index * 30);

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function pointOnCircle(radius: number, angleDeg: number): { x: number; y: number } {
  const radians = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: Number((Math.cos(radians) * radius).toFixed(2)),
    y: Number((Math.sin(radians) * radius).toFixed(2)),
  };
}

function arcPath(radius: number, startAngle: number, sweepAngle: number): string {
  const start = pointOnCircle(radius, startAngle);
  const end = pointOnCircle(radius, startAngle + sweepAngle);
  const largeArcFlag = sweepAngle > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`;
}

function bandArcSweep(count: number, total: number): number {
  if (count <= 0 || total <= 0) return 0;
  return clamp(34 + (count / total) * 262, 42, 306);
}

function bandStrokeWidth(count: number): number {
  return Number(clamp(1.8 + Math.sqrt(Math.max(0, count)) * 1.1, 2.2, 8.2).toFixed(2));
}

function bandArcOpacity(count: number, total: number): number {
  if (count <= 0 || total <= 0) return 0;
  return Number(clamp(0.34 + (count / total) * 1.15, 0.42, 0.9).toFixed(2));
}

export function DewsRadarLayer({
  model,
}: {
  model: LighthouseCinematicModel;
}) {
  const island = model.stage.modules.radar;
  const active = island.isActive;
  const color = model.radar.highestColorHex;
  const totalBandCount = Object.values(model.radar.bandCounts).reduce((sum, count) => sum + count, 0);
  const calmDotCount = Math.round(model.radar.calmDensity * 34);
  const calmDots = Array.from({ length: calmDotCount }, (_, index) => {
    const angle = ((index * 137.508 + 18) * Math.PI) / 180;
    const rx = 176 + (index % 7) * 8;
    const ry = 82 + (index % 5) * 6;
    return {
      x: Math.round(island.x + Math.cos(angle) * rx),
      y: Math.round(island.y - 6 + Math.sin(angle) * ry),
      opacity: Number((0.16 + (index % 4) * 0.035).toFixed(2)),
      delay: `${-(index % 9) * 0.4}s`,
    };
  });
  const elevatedMarks = [...model.radar.elevated].sort((a, b) => a.y - b.y);

  return (
    <g
      className={active ? "lh-dews-radar-layer lh-dews-radar-layer--active" : "lh-dews-radar-layer"}
      style={{
        "--lh-radar-color": color,
        "--lh-radar-sweep-duration": `${model.radar.sweepDurationSec}s`,
      } as CSSProperties}
      aria-hidden="true"
    >
      <ellipse className="lh-radar-hit-zone" cx={island.x} cy={island.y} rx={island.rx * 0.98} ry={island.ry * 0.78} />
      <g className="lh-radar-calm-field">
        {calmDots.map((dot, index) => (
          <circle
            key={index}
            className="lh-radar-calm-dot"
            cx={dot.x}
            cy={dot.y}
            r="1.8"
            fill={THREAT_BAND_HEX.CALM}
            opacity={dot.opacity}
            style={{ "--lh-calm-delay": dot.delay } as CSSProperties}
          />
        ))}
      </g>
      <g className="lh-radar-station" transform={`translate(${island.x} ${island.y})`}>
        <ellipse className="lh-radar-bed-shadow" cx="0" cy="66" rx="224" ry="52" />
        <ellipse className="lh-radar-threat-glow" cx="0" cy="-6" rx="208" ry="126" fill={color} />
        <path className="lh-radar-platform" d="M -158 46 C -118 12 -54 0 0 6 C 64 0 126 13 160 47 C 112 72 50 83 -8 80 C -70 84 -126 72 -158 46 Z" />
        <path className="lh-radar-platform-rim" d="M -128 43 C -82 20 -42 16 0 22 C 44 16 92 21 130 43" />
        <path className="lh-radar-gantry" d="M -70 54 C -34 26 -30 -38 0 -54 C 30 -38 35 26 70 54" />
        <g className="lh-radar-bands" transform="translate(0 -8)">
          {SPOKE_ANGLES.map((angle) => (
            <line
              key={angle}
              className="lh-radar-spoke"
              x1="0"
              y1="-18"
              x2="0"
              y2="-174"
              transform={`rotate(${angle})`}
            />
          ))}
          {BAND_RINGS.map(({ band, radius, startAngle }) => {
            const count = model.radar.bandCounts[band] ?? 0;
            const arcSweep = bandArcSweep(count, totalBandCount);
            const bandColor = THREAT_BAND_HEX[band];
            return (
              <g key={band} className="lh-radar-band" style={{ "--lh-band-color": bandColor } as CSSProperties}>
                <circle
                  className="lh-radar-band-base"
                  cx="0"
                  cy="0"
                  r={radius}
                  fill="none"
                  stroke={bandColor}
                  strokeDasharray={band === "CALM" ? "2 12" : "7 9"}
                />
                {arcSweep > 0 ? (
                  <path
                    className="lh-radar-band-arc"
                    d={arcPath(radius, startAngle, arcSweep)}
                    fill="none"
                    stroke={bandColor}
                    strokeOpacity={bandArcOpacity(count, totalBandCount)}
                    strokeWidth={bandStrokeWidth(count)}
                  />
                ) : null}
              </g>
            );
          })}
          <circle className="lh-radar-bearing" cx="0" cy="0" r="34" />
        </g>
        <g className="lh-radar-sweep" transform="translate(0 -8)">
          <path className="lh-radar-sweep__wake" d="M 0 0 L 0 -166 A 166 166 0 0 1 144 -83 Z" fill="url(#lh-radar-wake)" />
          <path className="lh-radar-sweep__afterglow" d="M 0 0 L 0 -112 A 112 112 0 0 1 99 -52 Z" />
          <line className="lh-radar-sweep__edge" x1="0" y1="0" x2="168" y2="0" />
          <line className="lh-radar-sweep__tail" x1="-24" y1="0" x2="84" y2="0" />
        </g>
        <g className="lh-radar-core" transform="translate(0 -8)">
          <circle className="lh-radar-core__aura" r="42" />
          <circle className="lh-radar-core__ring" r="25" />
          <circle className="lh-radar-core__pin" r="8" />
        </g>
      </g>
      {elevatedMarks.map((mark, index) => {
        const depth = clamp(0.64 + ((mark.y - (island.y - 122)) / 264) * 0.42, 0.62, 1.08);
        const shadowRx = Number((mark.radius * (1.65 + depth)).toFixed(2));
        const shadowRy = Number((mark.radius * 0.42 * depth).toFixed(2));
        return (
          <g
            key={mark.id}
            className={`lh-dews-blip lh-dews-blip--${mark.band.toLowerCase()}`}
            transform={`translate(${mark.x} ${mark.y})`}
            style={{
              "--lh-blip-color": mark.colorHex,
              "--lh-blip-pulse-delay": `${-index * 0.36}s`,
            } as CSSProperties}
          >
            <ellipse className="lh-dews-blip__shadow" cy={mark.radius + 7} rx={shadowRx} ry={shadowRy} />
            <circle className="lh-dews-blip__aura" r={mark.radius + 11 + depth * 5} fill={mark.colorHex} />
            <circle className="lh-dews-blip__ring" r={mark.radius + 4} stroke={mark.colorHex} />
            <circle className="lh-dews-blip__core" r={mark.radius} fill={mark.colorHex} />
            <circle className="lh-dews-blip__glint" cx={-mark.radius * 0.32} cy={-mark.radius * 0.34} r={Math.max(1.6, mark.radius * 0.22)} />
          </g>
        );
      })}
    </g>
  );
}
