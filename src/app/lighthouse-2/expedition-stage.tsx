"use client";

import type { CSSProperties, KeyboardEvent } from "react";
import { Anchor, CloudLightning, Compass, Map, ShipWheel } from "lucide-react";
import {
  lighthouse2ModuleLabel,
  type Lighthouse2AltPegIsland,
  type Lighthouse2ChainVessel,
  type Lighthouse2DewsBuoy,
  type Lighthouse2Model,
  type Lighthouse2Module,
  type Lighthouse2ModuleId,
  type Lighthouse2Point,
} from "./nautical-model";
import { Lighthouse2A11yLedger } from "./lighthouse-2-a11y-ledger";
import "./expedition-stage.css";

const MODULE_ICONS: Record<Lighthouse2ModuleId, typeof ShipWheel> = {
  chains: Anchor,
  psi: Compass,
  dews: CloudLightning,
  "alt-pegs": Map,
};

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function handleSvgKey(event: KeyboardEvent<SVGGElement>, callback: () => void) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  callback();
}

function beamPath(origin: Lighthouse2Point, target: Lighthouse2Point): string {
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  const spread = Math.max(48, Math.min(118, length * 0.13));
  const nx = (-dy / length) * spread;
  const ny = (dx / length) * spread;
  return `M ${origin.x} ${origin.y} L ${target.x + nx} ${target.y + ny} L ${target.x - nx} ${target.y - ny} Z`;
}

function islandPath(cx: number, cy: number, rx: number, ry: number): string {
  return `M ${cx - rx} ${cy} C ${cx - rx * 0.62} ${cy - ry * 0.62} ${cx - rx * 0.2} ${cy - ry * 0.82} ${cx} ${cy - ry * 0.48} C ${cx + rx * 0.2} ${cy - ry * 0.82} ${cx + rx * 0.68} ${cy - ry * 0.52} ${cx + rx} ${cy} C ${cx + rx * 0.58} ${cy + ry * 0.52} ${cx - rx * 0.58} ${cy + ry * 0.58} ${cx - rx} ${cy} Z`;
}

function Atmosphere({ model }: { model: Lighthouse2Model }) {
  const { width, height } = model.stage.viewBox;
  return (
    <g aria-hidden="true" className="lh2-atmosphere">
      <rect width={width} height={height} fill="url(#lh2-sea)" />
      <path
        className="lh2-vellum"
        d="M 112 104 C 336 46 660 76 870 58 C 1110 38 1376 72 1512 148 C 1468 304 1502 524 1456 764 C 1184 826 874 796 654 832 C 392 874 196 806 88 706 C 134 520 72 294 112 104 Z"
      />
      {Array.from({ length: 10 }).map((_, index) => (
        <path
          key={index}
          className="lh2-chart-contour"
          d={`M ${80 + index * 154} ${152 + (index % 3) * 28} C ${220 + index * 96} ${90 + (index % 4) * 42} ${480 + index * 68} ${220 + (index % 5) * 18} ${650 + index * 76} ${160 + (index % 4) * 36}`}
        />
      ))}
      <g transform="translate(180 188)" className="lh2-compass-rose">
        <circle r="62" />
        {Array.from({ length: 16 }).map((_, index) => (
          <line key={index} x1="0" y1="-20" x2="0" y2="-62" transform={`rotate(${index * 22.5})`} />
        ))}
      </g>
      <path
        className="lh2-ink-route"
        d="M 184 650 C 390 522 572 720 790 614 C 948 536 1066 624 1220 564 C 1342 514 1442 570 1518 642"
      />
    </g>
  );
}

function ModuleGround({
  modules,
  onPreviewModule,
  onPreviewEnd,
  onSelectModule,
}: {
  modules: Record<Lighthouse2ModuleId, Lighthouse2Module>;
  onPreviewModule?: (id: Lighthouse2ModuleId) => void;
  onPreviewEnd?: () => void;
  onSelectModule?: (id: Lighthouse2ModuleId) => void;
}) {
  return (
    <g className="lh2-module-ground">
      {Object.values(modules).map((moduleZone) => (
        <g
          key={moduleZone.id}
          role="button"
          tabIndex={0}
          data-module-id={moduleZone.id}
          aria-label={moduleZone.ariaLabel}
          aria-pressed={moduleZone.isActive}
          className={classNames("lh2-module-zone", moduleZone.isActive && "lh2-module-zone--active")}
          style={{ "--lh2-module-color": moduleZone.colorHex } as CSSProperties}
          onPointerEnter={() => onPreviewModule?.(moduleZone.id)}
          onPointerLeave={onPreviewEnd}
          onFocus={() => onPreviewModule?.(moduleZone.id)}
          onBlur={onPreviewEnd}
          onClick={() => onSelectModule?.(moduleZone.id)}
          onKeyDown={(event) => handleSvgKey(event, () => onSelectModule?.(moduleZone.id))}
        >
          <ellipse className="lh2-zone-hit" cx={moduleZone.x} cy={moduleZone.y} rx={moduleZone.rx} ry={moduleZone.ry} />
          <path className="lh2-island-shadow" d={islandPath(moduleZone.x, moduleZone.y + moduleZone.ry * 0.24, moduleZone.rx * 0.94, moduleZone.ry * 0.42)} />
          <path className="lh2-island-mass" d={islandPath(moduleZone.x, moduleZone.y, moduleZone.rx, moduleZone.ry)} />
          <path
            className="lh2-island-rim"
            d={`M ${moduleZone.x - moduleZone.rx * 0.74} ${moduleZone.y - moduleZone.ry * 0.08} C ${moduleZone.x - moduleZone.rx * 0.24} ${moduleZone.y - moduleZone.ry * 0.42} ${moduleZone.x + moduleZone.rx * 0.26} ${moduleZone.y - moduleZone.ry * 0.38} ${moduleZone.x + moduleZone.rx * 0.78} ${moduleZone.y - moduleZone.ry * 0.02}`}
          />
        </g>
      ))}
    </g>
  );
}

function BeaconBeam({ model }: { model: Lighthouse2Model }) {
  const origin = { x: model.stage.lighthouse.x, y: model.stage.lighthouse.y - 88 };
  return (
    <g className="lh2-beam" style={{ "--lh2-beam-color": model.stage.activeColorHex } as CSSProperties} aria-hidden="true">
      <path className="lh2-beam-wash" d={beamPath(origin, model.stage.activeTarget)} />
      <path className="lh2-beam-core" d={beamPath(origin, model.stage.activeTarget)} />
      <line
        className="lh2-beam-thread"
        x1={origin.x}
        y1={origin.y}
        x2={model.stage.activeTarget.x}
        y2={model.stage.activeTarget.y}
      />
    </g>
  );
}

function ExpeditionTower({ model }: { model: Lighthouse2Model }) {
  const { x, y } = model.stage.lighthouse;
  return (
    <g className="lh2-tower" transform={`translate(${x} ${y})`} style={{ "--lh2-lamp-color": model.psi.colorHex } as CSSProperties} aria-hidden="true">
      <ellipse className="lh2-rock-shadow" cx="0" cy="118" rx="178" ry="44" />
      <path className="lh2-rock" d="M -154 78 C -94 18 -42 44 -12 14 C 32 -28 82 28 146 76 C 104 126 -110 132 -154 78 Z" />
      <path className="lh2-causeway" d="M -214 128 C -94 102 70 126 220 94" />
      <path className="lh2-tower-body" d="M -46 74 L -30 -96 L 32 -96 L 50 74 Z" />
      <path className="lh2-tower-side" d="M 0 -96 L 32 -96 L 50 74 L 2 74 Z" />
      {[-58, -20, 18, 52].map((lineY) => (
        <path key={lineY} className="lh2-stone-course" d={`M ${-38 + lineY / 30} ${lineY} L ${38 - lineY / 38} ${lineY}`} />
      ))}
      <ellipse className="lh2-gallery" cx="0" cy="-112" rx="62" ry="18" />
      <path className="lh2-lantern" d="M -34 -122 L -24 -172 L 24 -172 L 34 -122 Z" />
      <path className="lh2-lantern-glass" d="M -20 -124 L -14 -160 L 14 -160 L 20 -124 Z" />
      <circle className="lh2-lamp-aura" cx="0" cy="-146" r="44" />
      <circle className="lh2-lamp-core" cx="0" cy="-146" r={model.psi.score == null ? 12 : 10 + Math.round(model.psi.score / 10)} />
      <path className="lh2-roof" d="M -40 -172 L 0 -214 L 40 -172 Z" />
      <line className="lh2-spire" x1="0" y1="-214" x2="0" y2="-246" />
    </g>
  );
}

function ChainHarbors({
  vessels,
  onPreviewMark,
  onPreviewEnd,
  onSelectMark,
}: {
  vessels: Lighthouse2ChainVessel[];
  onPreviewMark?: (id: string, moduleId: Lighthouse2ModuleId) => void;
  onPreviewEnd?: () => void;
  onSelectMark?: (id: string, moduleId: Lighthouse2ModuleId) => void;
}) {
  return (
    <g className="lh2-chain-harbors">
      {vessels.map((vessel, index) => (
        <g
          key={vessel.id}
          role="button"
          tabIndex={0}
          data-mark-id={vessel.id}
          aria-label={vessel.ariaLabel}
          aria-pressed={vessel.isSelected}
          className={classNames("lh2-vessel", vessel.isSelected && "lh2-vessel--selected")}
          transform={`translate(${vessel.x} ${vessel.y})`}
          style={{ "--lh2-mark-color": vessel.colorHex } as CSSProperties}
          onPointerEnter={() => onPreviewMark?.(vessel.id, "chains")}
          onPointerLeave={onPreviewEnd}
          onFocus={() => onPreviewMark?.(vessel.id, "chains")}
          onBlur={onPreviewEnd}
          onClick={() => onSelectMark?.(vessel.id, "chains")}
          onKeyDown={(event) => handleSvgKey(event, () => onSelectMark?.(vessel.id, "chains"))}
        >
          <title>{vessel.ariaLabel}</title>
          <ellipse className="lh2-vessel-hit" rx={vessel.width * 0.62} ry={vessel.height * 1.65} />
          <path className="lh2-vessel-wake" d={`M ${-vessel.width * 0.7} ${22 + (index % 2) * 4} C ${-vessel.width * 1.05} 36 ${-vessel.width * 1.34} 18 ${-vessel.width * 1.74} 34`} />
          <path
            className="lh2-hull"
            d={`M ${-vessel.width / 2} 0 C ${-vessel.width * 0.34} ${vessel.height * 0.88} ${vessel.width * 0.3} ${vessel.height * 0.92} ${vessel.width / 2} 0 C ${vessel.width * 0.22} ${-vessel.height * 0.42} ${-vessel.width * 0.24} ${-vessel.height * 0.42} ${-vessel.width / 2} 0 Z`}
          />
          <path className="lh2-sail" d={`M 0 ${-vessel.height * 0.25} L ${vessel.width * 0.26} ${-vessel.height * 1.82} L ${vessel.width * 0.05} ${-vessel.height * 0.08} Z`} />
          <path className="lh2-flag" d={`M 2 ${-vessel.height * 1.65} L ${Math.min(46, 12 + vessel.sharePct * 0.7)} ${-vessel.height * 1.5} L 2 ${-vessel.height * 1.34} Z`} />
          {Array.from({ length: Math.max(2, Math.min(5, Math.ceil(vessel.stablecoinCount / 12))) }).map((_, cargoIndex) => (
            <circle
              key={cargoIndex}
              className="lh2-cargo-dot"
              cx={-vessel.width * 0.28 + cargoIndex * (vessel.width * 0.15)}
              cy={vessel.height * 0.24 + (cargoIndex % 2) * 3}
              r="3.4"
            />
          ))}
        </g>
      ))}
    </g>
  );
}

function PsiInstrument({ model }: { model: Lighthouse2Model }) {
  const psiModule = model.stage.modules.psi;
  return (
    <g className="lh2-psi-instrument" transform={`translate(${psiModule.x} ${psiModule.y - 4})`} style={{ "--lh2-psi-color": model.psi.colorHex } as CSSProperties} aria-hidden="true">
      <ellipse className="lh2-brass-shadow" cx="0" cy="28" rx="148" ry="54" />
      <circle className="lh2-brass-dial" r="86" />
      <circle className="lh2-dial-face" r="64" />
      {model.psi.componentMarks.map((mark) => (
        <g key={mark.id} transform={`rotate(${mark.angleDeg})`}>
          <line className="lh2-psi-petal" x1="0" y1="-40" x2="0" y2={-mark.radius} strokeWidth={3 + Math.min(6, Math.abs(mark.value) / 18)} />
        </g>
      ))}
      <g transform={`rotate(${model.psi.needleAngleDeg})`}>
        <path className="lh2-needle" d="M -5 10 L 0 -58 L 5 10 Z" />
      </g>
      <circle className="lh2-needle-pin" r="10" />
    </g>
  );
}

function StormCompass({
  buoys,
  model,
  onPreviewMark,
  onPreviewEnd,
  onSelectMark,
}: {
  buoys: Lighthouse2DewsBuoy[];
  model: Lighthouse2Model;
  onPreviewMark?: (id: string, moduleId: Lighthouse2ModuleId) => void;
  onPreviewEnd?: () => void;
  onSelectMark?: (id: string, moduleId: Lighthouse2ModuleId) => void;
}) {
  const dewsModule = model.stage.modules.dews;
  return (
    <g className="lh2-storm-compass" style={{ "--lh2-dews-color": model.dews.highestColorHex } as CSSProperties}>
      <g transform={`translate(${dewsModule.x} ${dewsModule.y})`} aria-hidden="true">
        <ellipse className="lh2-brass-shadow" cx="0" cy="52" rx="218" ry="76" />
        <circle className="lh2-storm-dial" r="132" />
        {[42, 76, 108].map((ring) => (
          <circle key={ring} className="lh2-storm-ring" r={ring} />
        ))}
        {Array.from({ length: 12 }).map((_, index) => (
          <line key={index} className="lh2-storm-spoke" x1="0" y1="-26" x2="0" y2="-132" transform={`rotate(${index * 30})`} />
        ))}
        <path className="lh2-storm-front" d="M -112 18 C -74 -58 -6 -82 54 -40 C 96 -10 92 54 18 72 C -36 84 -94 66 -112 18 Z" />
      </g>
      {buoys.map((buoy) => (
        <g
          key={buoy.id}
          role="button"
          tabIndex={0}
          data-mark-id={buoy.id}
          aria-label={buoy.ariaLabel}
          aria-pressed={buoy.isSelected}
          className={classNames("lh2-dews-buoy", buoy.isSelected && "lh2-dews-buoy--selected")}
          transform={`translate(${buoy.x} ${buoy.y})`}
          style={{ "--lh2-mark-color": buoy.colorHex } as CSSProperties}
          onPointerEnter={() => onPreviewMark?.(buoy.id, "dews")}
          onPointerLeave={onPreviewEnd}
          onFocus={() => onPreviewMark?.(buoy.id, "dews")}
          onBlur={onPreviewEnd}
          onClick={() => onSelectMark?.(buoy.id, "dews")}
          onKeyDown={(event) => handleSvgKey(event, () => onSelectMark?.(buoy.id, "dews"))}
        >
          <title>{buoy.ariaLabel}</title>
          <circle className="lh2-buoy-hit" r={buoy.radius + 16} />
          <path className="lh2-buoy-flag" d={`M 0 ${-buoy.radius - 22} L ${buoy.radius + 16} ${-buoy.radius - 10} L 0 ${-buoy.radius + 2} Z`} />
          <circle className="lh2-buoy-core" r={buoy.radius} />
        </g>
      ))}
    </g>
  );
}

function AltPegArchipelago({
  islands,
  onPreviewMark,
  onPreviewEnd,
  onSelectMark,
}: {
  islands: Lighthouse2AltPegIsland[];
  onPreviewMark?: (id: string, moduleId: Lighthouse2ModuleId) => void;
  onPreviewEnd?: () => void;
  onSelectMark?: (id: string, moduleId: Lighthouse2ModuleId) => void;
}) {
  return (
    <g className="lh2-alt-archipelago">
      {islands.map((island, index) => (
        <g
          key={island.id}
          role="button"
          tabIndex={0}
          data-mark-id={island.id}
          aria-label={island.ariaLabel}
          aria-pressed={island.isSelected}
          className={classNames("lh2-alt-island", island.isSelected && "lh2-alt-island--selected")}
          transform={`translate(${island.x} ${island.y})`}
          style={{ "--lh2-mark-color": island.colorHex } as CSSProperties}
          onPointerEnter={() => onPreviewMark?.(island.id, "alt-pegs")}
          onPointerLeave={onPreviewEnd}
          onFocus={() => onPreviewMark?.(island.id, "alt-pegs")}
          onBlur={onPreviewEnd}
          onClick={() => onSelectMark?.(island.id, "alt-pegs")}
          onKeyDown={(event) => handleSvgKey(event, () => onSelectMark?.(island.id, "alt-pegs"))}
        >
          <title>{island.ariaLabel}</title>
          <ellipse className="lh2-alt-hit" rx={island.radius * 1.55} ry={island.radius * 1.15} />
          <path
            className="lh2-alt-land"
            d={islandPath(0, 0, island.radius * 1.1, island.radius * 0.68)}
          />
          <circle className="lh2-alt-seal" cx={island.radius * 0.28} cy={-island.radius * 0.14} r={Math.max(5, island.radius * 0.16)} />
          <path className="lh2-alt-coast" d={`M ${-island.radius * 0.76} ${-island.radius * 0.04} C ${-island.radius * 0.2} ${-island.radius * 0.38} ${island.radius * 0.28} ${-island.radius * 0.34} ${island.radius * 0.76} ${-island.radius * 0.02}`} />
          {index > 0 ? (
            <path className="lh2-alt-route" d={`M ${-island.radius * 2.8} ${-island.radius * 0.5} C ${-island.radius * 1.6} ${-island.radius * 1.1} ${-island.radius * 0.7} ${-island.radius * 0.72} ${0} ${0}`} />
          ) : null}
        </g>
      ))}
    </g>
  );
}

function StageControls({
  activeModuleId,
  onSelectModule,
}: {
  activeModuleId: Lighthouse2ModuleId;
  onSelectModule?: (id: Lighthouse2ModuleId) => void;
}) {
  const modules: Lighthouse2ModuleId[] = ["chains", "psi", "dews", "alt-pegs"];
  return (
    <div className="lh2-controls" aria-label="Lighthouse 2 display controls">
      {modules.map((id) => {
        const Icon = MODULE_ICONS[id];
        return (
          <button
            key={id}
            type="button"
            className={classNames("lh2-control pharos-focus-ring", activeModuleId === id && "lh2-control--active")}
            aria-label={lighthouse2ModuleLabel(id)}
            aria-pressed={activeModuleId === id}
            title={lighthouse2ModuleLabel(id)}
            onClick={() => onSelectModule?.(id)}
          >
            <Icon className="size-4" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}

export function Lighthouse2ExpeditionStage({
  model,
  onPreviewModule,
  onPreviewEnd,
  onSelectModule,
  onPreviewMark,
  onSelectMark,
}: {
  model: Lighthouse2Model;
  onPreviewModule?: (id: Lighthouse2ModuleId) => void;
  onPreviewEnd?: () => void;
  onSelectModule?: (id: Lighthouse2ModuleId) => void;
  onPreviewMark?: (id: string, moduleId: Lighthouse2ModuleId) => void;
  onSelectMark?: (id: string, moduleId: Lighthouse2ModuleId) => void;
}) {
  return (
    <section className="lh2-expedition" aria-labelledby="lighthouse-2-heading">
      <div className="lh2-frame" data-active-module-id={model.stage.activeModuleId} data-testid="lighthouse-2-stage">
        <svg
          className="lh2-svg"
          viewBox={`0 0 ${model.stage.viewBox.width} ${model.stage.viewBox.height}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={model.stage.sceneLabel}
          data-testid="lighthouse-2-svg"
        >
          <defs>
            <radialGradient id="lh2-sea" cx="50%" cy="48%" r="76%">
              <stop offset="0%" stopColor="oklch(0.19 0.046 203)" />
              <stop offset="58%" stopColor="oklch(0.1 0.04 214)" />
              <stop offset="100%" stopColor="oklch(0.045 0.03 228)" />
            </radialGradient>
            <linearGradient id="lh2-brass" x1="0" x2="1">
              <stop offset="0%" stopColor="oklch(0.46 0.08 75)" />
              <stop offset="52%" stopColor="oklch(0.77 0.11 83)" />
              <stop offset="100%" stopColor="oklch(0.38 0.07 68)" />
            </linearGradient>
            <linearGradient id="lh2-stone" x1="0" x2="1">
              <stop offset="0%" stopColor="oklch(0.38 0.025 83)" />
              <stop offset="48%" stopColor="oklch(0.74 0.035 86)" />
              <stop offset="100%" stopColor="oklch(0.31 0.022 78)" />
            </linearGradient>
            <linearGradient id="lh2-sail" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="oklch(0.91 0.045 82 / 0.94)" />
              <stop offset="100%" stopColor="oklch(0.52 0.052 216 / 0.58)" />
            </linearGradient>
          </defs>
          <Atmosphere model={model} />
          <ModuleGround
            modules={model.stage.modules}
            onPreviewModule={onPreviewModule}
            onPreviewEnd={onPreviewEnd}
            onSelectModule={onSelectModule}
          />
          <BeaconBeam model={model} />
          <PsiInstrument model={model} />
          <StormCompass
            buoys={model.dews.buoys}
            model={model}
            onPreviewMark={onPreviewMark}
            onPreviewEnd={onPreviewEnd}
            onSelectMark={onSelectMark}
          />
          <AltPegArchipelago
            islands={model.altPegs.islands}
            onPreviewMark={onPreviewMark}
            onPreviewEnd={onPreviewEnd}
            onSelectMark={onSelectMark}
          />
          <ChainHarbors
            vessels={model.chains.vessels}
            onPreviewMark={onPreviewMark}
            onPreviewEnd={onPreviewEnd}
            onSelectMark={onSelectMark}
          />
          <ExpeditionTower model={model} />
        </svg>
        <StageControls activeModuleId={model.stage.activeModuleId} onSelectModule={onSelectModule} />
      </div>
      <Lighthouse2A11yLedger model={model} />
    </section>
  );
}
