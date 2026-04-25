import type { CSSProperties } from "react";
import type { LighthouseCinematicModel, LighthousePoint } from "../cinematic-model";

const TOWER_SCALE = 0.86;
const LENS_LOCAL_Y = -226;

const TOWER_BODY_PATH = "M -90 96 C -77 34 -67 -52 -53 -138 L 53 -138 C 67 -52 77 34 90 96 Z";

const STONE_COURSES = [
  { y: -112, x1: -48, x2: 48 },
  { y: -84, x1: -55, x2: 55 },
  { y: -56, x1: -61, x2: 61 },
  { y: -28, x1: -67, x2: 67 },
  { y: 0, x1: -72, x2: 72 },
  { y: 28, x1: -78, x2: 78 },
  { y: 56, x1: -83, x2: 83 },
] as const;

const STONE_SEAMS = [
  { x: -28, y1: -130, y2: -112 },
  { x: 24, y1: -112, y2: -84 },
  { x: -36, y1: -84, y2: -56 },
  { x: 5, y1: -56, y2: -28 },
  { x: 42, y1: -28, y2: 0 },
  { x: -18, y1: 0, y2: 28 },
  { x: 25, y1: 28, y2: 56 },
  { x: -47, y1: 56, y2: 90 },
] as const;

const GALLERY_POSTS = [-58, -36, -14, 14, 36, 58] as const;
const LANTERN_MULLIONS = [-36, -18, 0, 18, 36] as const;

function beamGeometry(
  origin: LighthousePoint,
  target: LighthousePoint,
  reachPct: number,
  spreadBase: number,
  spreadRange: number,
) {
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const reach = Math.max(0.4, Math.min(1, reachPct / 100));
  const safeDistance = Math.max(1, Math.hypot(dx, dy));
  const end = {
    x: origin.x + dx * reach,
    y: origin.y + dy * reach,
  };
  const normal = {
    x: -dy,
    y: dx,
  };
  const spread = spreadBase + reach * spreadRange;
  const nx = (normal.x / safeDistance) * spread;
  const ny = (normal.y / safeDistance) * spread;
  return { dx, dy, end, nx, ny, reach };
}

function beamPath(origin: LighthousePoint, target: LighthousePoint, reachPct: number, spreadBase: number, spreadRange: number): string {
  const { end, nx, ny } = beamGeometry(origin, target, reachPct, spreadBase, spreadRange);
  return `M ${origin.x} ${origin.y} L ${end.x + nx} ${end.y + ny} L ${end.x - nx} ${end.y - ny} Z`;
}

function beamEdgePath(
  origin: LighthousePoint,
  target: LighthousePoint,
  reachPct: number,
  side: -1 | 1,
  spreadBase: number,
  spreadRange: number,
): string {
  const { dx, dy, end, nx, ny, reach } = beamGeometry(origin, target, reachPct, spreadBase, spreadRange);
  const edge = {
    x: end.x + nx * side,
    y: end.y + ny * side,
  };
  const c1 = {
    x: origin.x + dx * reach * 0.22 + nx * side * 0.12,
    y: origin.y + dy * reach * 0.22 + ny * side * 0.12,
  };
  const c2 = {
    x: origin.x + dx * reach * 0.72 + nx * side * 0.84,
    y: origin.y + dy * reach * 0.72 + ny * side * 0.84,
  };
  return `M ${origin.x} ${origin.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${edge.x} ${edge.y}`;
}

export function PharosTowerLayer({
  model,
}: {
  model: LighthouseCinematicModel;
}) {
  const lens = { x: model.stage.lighthouse.x, y: model.stage.lighthouse.y + LENS_LOCAL_Y * TOWER_SCALE };
  const target = model.stage.activeTarget ?? { x: 1110, y: 486 };
  const color = model.lens.colorHex;
  const layerStyle = {
    "--lh-lens-color": color,
    "--lh-beam-opacity": model.lens.beamOpacity,
  } as CSSProperties;

  return (
    <g className="lh-pharos-layer" style={layerStyle}>
      <defs>
        <clipPath id="lh-tower-body-clip">
          <path d={TOWER_BODY_PATH} />
        </clipPath>
        <linearGradient id="lh-beam-spill-gradient" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--lh-lens-color, #f8d77a)" stopOpacity="0.62" />
          <stop offset="34%" stopColor="var(--lh-lens-color, #f8d77a)" stopOpacity="0.18" />
          <stop offset="100%" stopColor="var(--lh-lens-color, #f8d77a)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="lh-beam-body-gradient" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--lh-lens-color, #f8d77a)" stopOpacity="0.74" />
          <stop offset="46%" stopColor="var(--lh-lens-color, #f8d77a)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--lh-lens-color, #f8d77a)" stopOpacity="0.015" />
        </linearGradient>
        <linearGradient id="lh-beam-core-gradient" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="oklch(1 0.042 88)" stopOpacity="0.92" />
          <stop offset="24%" stopColor="var(--lh-lens-color, #f8d77a)" stopOpacity="0.72" />
          <stop offset="100%" stopColor="var(--lh-lens-color, #f8d77a)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="lh-tower-glass-gradient" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="oklch(0.95 0.045 90 / 0.5)" />
          <stop offset="42%" stopColor="var(--lh-lens-color, #f8d77a)" stopOpacity="0.34" />
          <stop offset="100%" stopColor="oklch(0.16 0.04 235 / 0.88)" />
        </linearGradient>
        <radialGradient id="lh-lantern-aura" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--lh-lens-color, #f8d77a)" stopOpacity="0.42" />
          <stop offset="58%" stopColor="var(--lh-lens-color, #f8d77a)" stopOpacity="0.13" />
          <stop offset="100%" stopColor="var(--lh-lens-color, #f8d77a)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <g className="lh-beam-assembly" aria-hidden="true">
        <path
          className="lh-beam-spill"
          d={beamPath(lens, target, model.lens.beamReachPct, 132, 146)}
          fill="url(#lh-beam-spill-gradient)"
        />
        <path
          className="lh-main-beam"
          d={beamPath(lens, target, model.lens.beamReachPct, 76, 76)}
          fill="url(#lh-beam-body-gradient)"
        />
        <path
          className="lh-beam-core"
          d={beamPath(lens, target, model.lens.beamReachPct, 22, 34)}
          fill="url(#lh-beam-core-gradient)"
        />
        <path
          className="lh-beam-edge lh-beam-edge--upper"
          d={beamEdgePath(lens, target, model.lens.beamReachPct, 1, 82, 86)}
          fill="none"
        />
        <path
          className="lh-beam-edge lh-beam-edge--lower"
          d={beamEdgePath(lens, target, model.lens.beamReachPct, -1, 82, 86)}
          fill="none"
        />
      </g>
      <g
        className="lh-pharos-tower"
        transform={`translate(${model.stage.lighthouse.x} ${model.stage.lighthouse.y}) scale(${TOWER_SCALE})`}
        aria-hidden="true"
      >
        <path
          className="lh-pharos-rock lh-pharos-rock--back"
          d="M -258 72 C -184 4 -124 18 -70 -22 C -17 -62 46 -46 91 -10 C 146 34 192 18 260 84 L 286 124 L -284 124 Z"
        />
        <path
          className="lh-pharos-rock lh-pharos-rock--face"
          d="M -214 78 C -151 32 -106 42 -64 7 C -18 -31 30 -25 68 3 C 120 42 157 36 214 84 L 232 112 L -232 112 Z"
        />
        <path className="lh-pharos-rock-ridge" d="M -166 64 C -92 31 -52 42 -2 10 C 48 -22 103 31 170 70" fill="none" />
        <ellipse className="lh-tower-cast-shadow" cx="0" cy="126" rx="300" ry="38" />

        <path className="lh-tower-backlight" d="M -116 88 C -92 -10 -75 -95 -52 -158 L 52 -158 C 75 -95 92 -10 116 88 Z" />
        <path className="lh-tower-plinth-shadow" d="M -102 84 L -78 112 L 78 112 L 102 84 Z" />
        <path className="lh-tower-plinth" d="M -86 74 L -67 99 L 67 99 L 86 74 Z" />
        <path className="lh-tower-body" d={TOWER_BODY_PATH} />
        <g clipPath="url(#lh-tower-body-clip)">
          <path className="lh-tower-side-shadow lh-tower-side-shadow--left" d="M -90 96 C -74 15 -63 -75 -53 -138 L -12 -138 C -31 -64 -40 17 -38 96 Z" />
          <path className="lh-tower-side-shadow lh-tower-side-shadow--right" d="M 18 -138 L 53 -138 C 66 -52 77 34 90 96 L 44 96 C 39 12 31 -68 18 -138 Z" />
          <path className="lh-tower-core-light" d="M -15 -130 C -22 -66 -18 22 -12 92 L 18 92 C 20 22 15 -66 8 -130 Z" />
          {STONE_COURSES.map((course) => (
            <line key={course.y} className="lh-tower-course" x1={course.x1} y1={course.y} x2={course.x2} y2={course.y} />
          ))}
          {STONE_SEAMS.map((seam) => (
            <line key={`${seam.x}-${seam.y1}`} className="lh-tower-seam" x1={seam.x} y1={seam.y1} x2={seam.x} y2={seam.y2} />
          ))}
        </g>
        <path className="lh-tower-outline" d={TOWER_BODY_PATH} />
        <rect className="lh-tower-door-glow" x="-23" y="32" width="46" height="55" rx="21" />
        <rect className="lh-tower-door" x="-18" y="36" width="36" height="52" rx="17" />
        <path className="lh-tower-window" d="M -13 -42 C -13 -60 -7 -70 0 -70 C 7 -70 13 -60 13 -42 L 13 -24 L -13 -24 Z" />

        <path className="lh-gallery-shadow" d="M -92 -136 L 92 -136 L 72 -116 L -72 -116 Z" />
        <path
          className="lh-gallery-deck"
          d="M -86 -146 L 86 -146 L 68 -126 L -68 -126 Z"
        />
        <g className="lh-gallery-rail">
          <line x1="-74" y1="-160" x2="74" y2="-160" />
          <line x1="-79" y1="-146" x2="79" y2="-146" />
          {GALLERY_POSTS.map((x) => (
            <line key={x} x1={x} y1="-163" x2={x} y2="-132" />
          ))}
        </g>

        <ellipse className="lh-lantern-aura" cx="0" cy={LENS_LOCAL_Y} rx="118" ry="96" />
        <path className="lh-lantern-glass" d="M -58 -222 L -44 -276 L 44 -276 L 58 -222 Z" />
        <path className="lh-lantern-glass-shade" d="M -58 -222 L -44 -276 L -2 -276 L -8 -222 Z" />
        <g className="lh-lantern-mullions">
          {LANTERN_MULLIONS.map((x) => (
            <line key={x} x1={x * 0.72} y1="-273" x2={x} y2="-224" />
          ))}
          <line x1="-53" y1="-246" x2="53" y2="-246" />
        </g>
        <g transform={`translate(0 ${LENS_LOCAL_Y})`}>
          <g className="lh-lens-prism">
            <path className="lh-optic-sweep" d="M 0 -4 L 78 -18 C 94 -7 94 7 78 18 L 0 4 Z" />
            <circle className="lh-optic-outer" r="44" />
            <circle className="lh-optic-ring" r="31" />
            <path className="lh-optic-prism" d="M 0 -26 L 22 0 L 0 26 L -22 0 Z" />
            <circle className="lh-optic-core" r="11" />
            {Array.from({ length: 12 }).map((_, index) => (
              <line
                key={index}
                className="lh-optic-rib"
                x1="0"
                y1="-39"
                x2="0"
                y2="-55"
                transform={`rotate(${index * 30})`}
              />
            ))}
          </g>
        </g>
        <path className="lh-lantern-cap" d="M -62 -276 L 0 -323 L 62 -276 Z" />
        <path className="lh-lantern-roof-ridge" d="M -42 -280 L 0 -312 L 42 -280" fill="none" />
        <line className="lh-lantern-spire" x1="0" y1="-323" x2="0" y2="-354" />
        <path className="lh-flame" d="M 0 -364 C -13 -345 -8 -328 0 -320 C 15 -334 15 -351 0 -364 Z" />
        <circle cx="0" cy={LENS_LOCAL_Y - 20} r="74" className="lh-lens-halo" />
      </g>
    </g>
  );
}
