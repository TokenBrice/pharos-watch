import type { CSSProperties, KeyboardEvent } from "react";
import type { LighthouseCinematicModel, LighthouseModuleId, LighthouseModuleIsland } from "../cinematic-model";

function bridgePath(from: { x: number; y: number }, island: LighthouseModuleIsland): string {
  const controlY = Math.min(from.y, island.target.y) - 70;
  return `M ${from.x} ${from.y} C ${(from.x + island.target.x) / 2} ${controlY} ${(from.x + island.target.x) / 2} ${controlY} ${island.target.x} ${island.target.y}`;
}

function islandMassPath(island: LighthouseModuleIsland): string {
  const left = island.x - island.rx;
  const right = island.x + island.rx;
  const top = island.y - island.ry * 0.36;
  const bottom = island.y + island.ry * 0.54;
  return `M ${left} ${island.y} C ${left + island.rx * 0.22} ${top} ${island.x - island.rx * 0.28} ${top - 16} ${island.x} ${top} C ${island.x + island.rx * 0.28} ${top - 16} ${right - island.rx * 0.18} ${top + 6} ${right} ${island.y} C ${right - island.rx * 0.18} ${bottom} ${left + island.rx * 0.2} ${bottom} ${left} ${island.y} Z`;
}

export function ModuleIslandBaseLayer({
  model,
  onPreviewModule,
  onPreviewModuleEnd,
  onSelectModule,
}: {
  model: LighthouseCinematicModel;
  onPreviewModule?: (id: LighthouseModuleId) => void;
  onPreviewModuleEnd?: () => void;
  onSelectModule?: (id: LighthouseModuleId) => void;
}) {
  const bridgeOrigin = {
    x: model.stage.lighthouse.x,
    y: model.stage.lighthouse.y - 160,
  };
  const modules = Object.values(model.stage.modules);
  const handleKeyDown = (event: KeyboardEvent<SVGGElement>, id: LighthouseModuleId) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelectModule?.(id);
  };

  return (
    <g className="lh-module-island-base-layer">
      {modules.map((island) => (
        <g
          key={island.id}
          className={island.isActive ? "lh-module-bridge-set lh-module-bridge-set--active" : "lh-module-bridge-set"}
          style={{ "--lh-module-color": island.colorHex } as CSSProperties}
        >
          <path className="lh-module-bridge" d={bridgePath(bridgeOrigin, island)} fill="none" />
        </g>
      ))}
      {modules.map((island) => (
        <g
          key={island.id}
          className={island.isActive ? "lh-module-island lh-module-island--active" : "lh-module-island"}
          data-module-id={island.id}
          role="button"
          tabIndex={0}
          aria-label={island.ariaLabel}
          aria-pressed={island.isActive}
          onPointerEnter={() => onPreviewModule?.(island.id)}
          onPointerLeave={onPreviewModuleEnd}
          onFocus={() => onPreviewModule?.(island.id)}
          onBlur={onPreviewModuleEnd}
          onClick={() => onSelectModule?.(island.id)}
          onKeyDown={(event) => handleKeyDown(event, island.id)}
          style={{ "--lh-module-color": island.colorHex } as CSSProperties}
        >
          <rect
            className="lh-module-hit-area"
            x={island.bounds.x}
            y={island.bounds.y}
            width={island.bounds.width}
            height={island.bounds.height}
            rx="28"
          />
          <rect
            className="lh-module-block"
            x={island.bounds.x}
            y={island.bounds.y}
            width={island.bounds.width}
            height={island.bounds.height}
            rx="20"
          />
          <ellipse cx={island.x} cy={island.y + island.ry * 0.52} rx={island.rx * 0.88} ry={island.ry * 0.28} fill="oklch(0.01 0.012 240 / 0.4)" />
          <ellipse className="lh-module-glow" cx={island.x} cy={island.y - island.ry * 0.05} rx={island.rx * 0.98} ry={island.ry * 0.7} fill="var(--lh-module-color)" />
          <path className="lh-module-mass" d={islandMassPath(island)} />
          <path
            className="lh-module-rim"
            d={`M ${island.x - island.rx * 0.72} ${island.y - island.ry * 0.06} C ${island.x - island.rx * 0.28} ${island.y - island.ry * 0.34} ${island.x + island.rx * 0.32} ${island.y - island.ry * 0.3} ${island.x + island.rx * 0.74} ${island.y - island.ry * 0.04}`}
            fill="none"
          />
        </g>
      ))}
    </g>
  );
}
