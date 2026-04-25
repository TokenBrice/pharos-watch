import type { CSSProperties } from "react";
import type { LighthouseCinematicModel } from "../cinematic-model";

const BAFFLE_ANGLES = Array.from({ length: 24 }, (_, index) => index * 15);
const GUIDE_RINGS = [54, 82, 112, 142];

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function PsiLensIslandLayer({ model }: { model: LighthouseCinematicModel }) {
  const island = model.stage.modules.lens;
  const active = island.isActive;
  const scoreRatio = clampUnit((model.lens.score ?? 58) / 100);
  const apertureRadius = 28 + scoreRatio * 20;
  const glassRadius = 44 + scoreRatio * 12;
  const ringReach = 114 + (model.lens.beamReachPct / 100) * 24;
  const refractedSpan = 94 + model.lens.beamReachPct * 0.78;
  const coreOpacity = 0.2 + model.lens.beamOpacity * 0.54;
  const layerStyle = {
    "--lh-lens-color": model.lens.colorHex,
    "--lh-lens-sweep-duration": `${model.lens.sweepDurationSec}s`,
  } as CSSProperties;

  return (
    <g
      className={active ? "lh-psi-lens-island-layer lh-psi-lens-island-layer--active" : "lh-psi-lens-island-layer"}
      style={layerStyle}
    >
      <g
        className="lh-psi-lens-machine"
        transform={`translate(${island.x} ${island.y - 28})`}
        role="img"
        tabIndex={0}
        aria-label={island.ariaLabel}
      >
        <ellipse
          className="lh-psi-lens-ground-glow"
          cx="0"
          cy="72"
          rx="178"
          ry="46"
          opacity={0.12 + scoreRatio * 0.18}
        />
        <path
          className="lh-psi-lens-platform"
          d="M -182 42 C -128 9 -62 -2 0 4 C 70 -4 136 12 184 42 C 138 80 -126 82 -182 42 Z"
        />
        <path className="lh-psi-optical-rail" d="M -164 -30 C -102 -52 102 -52 164 -30" />
        <path className="lh-psi-optical-rail lh-psi-optical-rail--lower" d="M -154 34 C -92 57 92 57 154 34" />
        <rect className="lh-psi-lens-yoke" x="-144" y="-58" width="38" height="116" rx="8" />
        <rect className="lh-psi-lens-yoke" x="106" y="-58" width="38" height="116" rx="8" />
        <circle className="lh-psi-hover-ring" r={ringReach + 18} fill="none" />

        <g className="lh-psi-refraction-field" opacity={0.2 + model.lens.beamOpacity * 0.52}>
          <path
            className="lh-psi-sample-beam"
            d={`M ${-refractedSpan} -44 C -112 -36 -76 -22 ${-apertureRadius} -10`}
          />
          <path
            className="lh-psi-sample-beam lh-psi-sample-beam--lower"
            d={`M ${-refractedSpan + 16} 48 C -106 34 -72 22 ${-apertureRadius} 12`}
          />
          <path className="lh-psi-refracted-ray" d={`M ${apertureRadius} -18 C 72 -42 116 -58 ${refractedSpan} -70`} />
          <path
            className="lh-psi-refracted-ray lh-psi-refracted-ray--middle"
            d={`M ${apertureRadius} 0 C 82 -2 118 3 ${refractedSpan + 18} -8`}
          />
          <path
            className="lh-psi-refracted-ray lh-psi-refracted-ray--lower"
            d={`M ${apertureRadius} 18 C 76 38 124 56 ${refractedSpan - 6} 70`}
          />
        </g>

        <g className="lh-psi-rotor">
          {GUIDE_RINGS.map((ring, index) => (
            <circle
              key={ring}
              className={
                index === GUIDE_RINGS.length - 1 ? "lh-psi-lens-ring lh-psi-lens-ring--outer" : "lh-psi-lens-ring"
              }
              r={ring + scoreRatio * (index + 1) * 1.5}
              fill="none"
            />
          ))}
          {BAFFLE_ANGLES.map((angle, index) => (
            <rect
              key={angle}
              className="lh-psi-baffle"
              x={index % 2 === 0 ? -3 : -2.2}
              y={-ringReach - 8}
              width={index % 2 === 0 ? 6 : 4.4}
              height={index % 3 === 0 ? 28 : 20}
              rx="2.2"
              transform={`rotate(${angle})`}
            />
          ))}
        </g>

        <g className="lh-psi-facet-array">
          {model.lens.facets.map((facet, index) => {
            const rayStart = apertureRadius - 2;
            const rayEnd = apertureRadius + facet.length + 34;
            const mirrorY = -glassRadius - 24 - facet.value * 0.18;
            return (
              <g
                key={facet.id}
                className="lh-psi-facet"
                transform={`rotate(${facet.angleDeg})`}
                style={
                  {
                    "--lh-facet-delay": `${index * -0.72}s`,
                    "--lh-facet-opacity": facet.opacity,
                  } as CSSProperties
                }
              >
                <path
                  className="lh-psi-facet-glow"
                  d={`M -12 ${-rayStart} C -6 ${-rayStart - 18} 4 ${-rayEnd + 18} 14 ${-rayEnd}`}
                  strokeWidth={8 + facet.value * 0.04}
                />
                <line
                  className="lh-psi-facet-ray"
                  x1="0"
                  y1={-rayStart}
                  x2="0"
                  y2={-rayEnd}
                  strokeWidth={1.8 + facet.value * 0.035}
                />
                <polygon
                  className="lh-psi-facet-mirror"
                  points={`-15 ${mirrorY} 15 ${mirrorY} 24 ${mirrorY + 17} 0 ${mirrorY + 31} -24 ${mirrorY + 17}`}
                />
              </g>
            );
          })}
        </g>

        <g className="lh-psi-prism-stack">
          <path className="lh-psi-prism-shadow" d="M -56 -32 L 0 -64 L 56 -32 L 56 32 L 0 64 L -56 32 Z" />
          <path
            className="lh-psi-prism-glass"
            d="M -52 -30 L 0 -60 L 52 -30 L 52 30 L 0 60 L -52 30 Z"
            opacity={0.32 + model.lens.beamOpacity * 0.22}
          />
          <path className="lh-psi-prism-cut" d="M -52 -30 L 0 0 L -52 30" />
          <path className="lh-psi-prism-cut" d="M 52 -30 L 0 0 L 52 30" />
          <path className="lh-psi-prism-cut lh-psi-prism-cut--vertical" d="M 0 -60 L 0 60" />
          <circle className="lh-psi-aperture" r={apertureRadius} opacity={0.18 + model.lens.beamOpacity * 0.34} />
          <circle className="lh-psi-core" r={10 + scoreRatio * 7} opacity={coreOpacity} />
        </g>
      </g>
    </g>
  );
}
