"use client";

import { useId } from "react";
import { HEALTH_HEX_FILL } from "@/lib/chain-ui";
import { cn } from "@/lib/utils";
import { formatCompactUsd, formatPercent, formatPercentFromRatio, formatSignedPercent } from "@shared/lib/format";
import type { LighthouseSceneModel, LighthouseShipRow } from "./view-model";
import "./lighthouse-scene.css";

const SCENE_WIDTH = 1360;
const SCENE_HEIGHT = 640;
const LENS_X = 262;
const LENS_Y = 276;
const HORIZON_START_X = 512;
const HORIZON_END_X = 1132;
const HORIZON_Y = 354;

interface ProjectedHarbor extends LighthouseShipRow {
  sceneX: number;
  sceneY: number;
  signalHeight: number;
  dockWidth: number;
}

function healthColor(band: LighthouseShipRow["healthBand"]): string {
  if (!band) return "oklch(0.58 0.03 250)";
  return HEALTH_HEX_FILL[band];
}

function projectHarbors(ships: readonly LighthouseShipRow[]): ProjectedHarbor[] {
  const span = Math.max(1, ships.length - 1);
  return ships.map((ship, index) => {
    const sharePressure = Math.max(0, Math.min(1, ship.sharePct / 50));
    const concentration = Math.max(0, Math.min(1, ship.dominantSharePct / 100));
    const waveOffset = index % 2 === 0 ? -8 : 14;

    return {
      ...ship,
      sceneX: Math.round(HORIZON_START_X + ((HORIZON_END_X - HORIZON_START_X) / span) * index),
      sceneY: HORIZON_Y + waveOffset,
      signalHeight: 38 + Math.round(sharePressure * 76),
      dockWidth: 66 + Math.round(concentration * 78),
    };
  });
}

function CargoMarks({ count, color, dockWidth }: { count: number; color: string; dockWidth: number }) {
  const spacing = dockWidth / Math.max(1, count + 1);
  return (
    <g aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => (
        <rect
          key={index}
          x={-dockWidth / 2 + spacing * (index + 1) - 4}
          y={-10 - (index % 2) * 4}
          width="8"
          height="8"
          rx="2"
          fill={color}
          opacity={index === 0 ? 0.94 : 0.68}
        />
      ))}
    </g>
  );
}

function WakeTrace({ harbor }: { harbor: ProjectedHarbor }) {
  if (harbor.wakeDirection === 0) return null;
  const sign = harbor.wakeDirection > 0 ? -1 : 1;
  const length = 38 + Math.abs(harbor.wakeLength) * 150;
  return (
    <path
      d={`M ${-sign * 30} 30 C ${-sign * 52} 36 ${-sign * length} 30 ${-sign * (length + 30)} 38`}
      className="lh-harbor-wake"
      fill="none"
      stroke="oklch(0.76 0.06 205 / 0.42)"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    />
  );
}

function ProjectedHarborTarget({
  harbor,
  selected,
  onSelect,
  onPreview,
  onPreviewEnd,
}: {
  harbor: ProjectedHarbor;
  selected: boolean;
  onSelect: (id: string) => void;
  onPreview?: (id: string) => void;
  onPreviewEnd?: () => void;
}) {
  const color = healthColor(harbor.healthBand);
  const signalRadius = selected ? 18 : 14;

  return (
    <g
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${harbor.name}, ${formatCompactUsd(harbor.totalUsd)}, ${formatPercent(harbor.sharePct, 1)} of supply, ${harbor.healthBand ?? "unrated"} harbor, dominant cargo ${harbor.dominantSymbol} ${formatPercent(harbor.dominantSharePct, 1)}, ${formatSignedPercent(harbor.change7dPct * 100, 1)} over 7d`}
      className={cn("lh-harbor-target", selected && "lh-harbor-target--selected")}
      data-testid={`lighthouse-ship-${harbor.id}`}
      onPointerEnter={() => onPreview?.(harbor.id)}
      onPointerLeave={() => onPreviewEnd?.()}
      onFocus={() => onPreview?.(harbor.id)}
      onBlur={() => onPreviewEnd?.()}
      onClick={() => onSelect(harbor.id)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onSelect(harbor.id);
      }}
      transform={`translate(${harbor.sceneX} ${harbor.sceneY})`}
    >
      <title>{`${harbor.name}: ${formatCompactUsd(harbor.totalUsd)} supply, ${formatSignedPercent(harbor.change7dPct * 100, 1)} 7d`}</title>
      <rect
        className="lh-harbor-focus-ring"
        x={-harbor.dockWidth / 2 - 22}
        y={-harbor.signalHeight - 58}
        width={harbor.dockWidth + 44}
        height={harbor.signalHeight + 112}
        rx="18"
        fill="none"
        stroke={color}
        strokeWidth="2"
      />
      <WakeTrace harbor={harbor} />
      <path
        className="lh-harbor-reflection"
        d={`M ${-harbor.dockWidth * 0.42} 38 C ${-harbor.dockWidth * 0.12} 46 ${harbor.dockWidth * 0.12} 45 ${harbor.dockWidth * 0.42} 38`}
        fill="none"
        stroke={color}
        strokeWidth="2"
        opacity="0.28"
      />
      <rect
        x={-harbor.dockWidth / 2}
        y="4"
        width={harbor.dockWidth}
        height="18"
        rx="5"
        fill="oklch(0.17 0.03 42)"
        stroke="oklch(0.92 0.07 70 / 0.24)"
        strokeWidth="1"
      />
      <path
        d={`M ${-harbor.dockWidth * 0.42} 4 L ${-harbor.dockWidth * 0.2} -12 L ${harbor.dockWidth * 0.34} -12 L ${harbor.dockWidth * 0.48} 4 Z`}
        fill="oklch(0.12 0.025 248)"
        stroke={color}
        strokeOpacity="0.38"
        strokeWidth="1"
      />
      <CargoMarks count={harbor.cargoCount} color={color} dockWidth={harbor.dockWidth} />
      <line
        x1="0"
        y1="-10"
        x2="0"
        y2={-harbor.signalHeight}
        stroke="oklch(0.9 0.02 250 / 0.62)"
        strokeWidth="2"
      />
      <path
        className="lh-harbor-pennant"
        d={`M 0 ${-harbor.signalHeight + 4} L ${harbor.pennantWidth} ${-harbor.signalHeight + 12} L 0 ${-harbor.signalHeight + 22} Z`}
        fill={color}
        opacity="0.74"
      />
      <circle
        className="lh-harbor-signal"
        cx="0"
        cy={-harbor.signalHeight - 16}
        r={signalRadius}
        fill="oklch(0.04 0.025 248 / 0.88)"
        stroke={color}
        strokeWidth={selected ? 2.6 : 2}
      />
      {harbor.logoPath ? (
        <image
          href={harbor.logoPath}
          x={-10}
          y={-harbor.signalHeight - 26}
          width="20"
          height="20"
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
        />
      ) : (
        <circle cx="0" cy={-harbor.signalHeight - 16} r="5" fill={color} aria-hidden="true" />
      )}
      <text x="0" y="54" textAnchor="middle" className="lh-harbor-label" aria-hidden="true">
        {harbor.name}
      </text>
      <text x="0" y="70" textAnchor="middle" className="lh-harbor-subtitle" aria-hidden="true">
        {formatPercent(harbor.sharePct, 1)}
      </text>
    </g>
  );
}

function LensAssembly({ glowId, watchBand }: { glowId: string; watchBand: string | null }) {
  const label = watchBand ? `${watchBand} light` : "chain-data light";
  return (
    <g className="lh-lens-assembly" aria-label={label}>
      <ellipse cx={LENS_X} cy="516" rx="168" ry="32" fill="oklch(0.02 0.01 248 / 0.48)" aria-hidden="true" />
      <path
        d="M 126 496 C 156 430 174 360 184 284 C 192 220 214 162 262 120 C 310 162 332 220 340 284 C 350 360 368 430 398 496 Z"
        fill="oklch(0.12 0.026 248 / 0.88)"
        stroke="oklch(0.7 0.08 80 / 0.22)"
        strokeWidth="1.4"
      />
      <circle cx={LENS_X} cy={LENS_Y} r="122" fill={`url(#${glowId})`} stroke="oklch(0.95 0.1 86 / 0.3)" />
      <circle cx={LENS_X} cy={LENS_Y} r="94" fill="none" stroke="oklch(0.94 0.09 88 / 0.42)" strokeWidth="1.5" />
      <circle cx={LENS_X} cy={LENS_Y} r="63" fill="none" stroke="oklch(0.98 0.08 91 / 0.46)" strokeWidth="1.2" />
      <circle cx={LENS_X} cy={LENS_Y} r="28" fill="oklch(0.97 0.11 88 / 0.84)" />
      {Array.from({ length: 11 }).map((_, index) => {
        const angle = -62 + index * 12.4;
        return (
          <line
            key={index}
            x1={LENS_X}
            y1={LENS_Y - 108}
            x2={LENS_X}
            y2={LENS_Y + 108}
            transform={`rotate(${angle} ${LENS_X} ${LENS_Y})`}
            stroke="oklch(1 0.02 92 / 0.18)"
            strokeWidth="1.2"
          />
        );
      })}
      <path
        className="lh-lens-sweep"
        d="M 262 150 A 126 126 0 0 1 384 276"
        fill="none"
        stroke="oklch(1 0.1 90 / 0.42)"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <rect x="164" y="418" width="196" height="20" rx="5" fill="oklch(0.18 0.035 58)" />
      <rect x="186" y="438" width="152" height="68" rx="9" fill="oklch(0.11 0.024 248)" />
    </g>
  );
}

function BeamPath({ selectedHarbor }: { selectedHarbor: ProjectedHarbor | null }) {
  const targetX = selectedHarbor?.sceneX ?? 980;
  const targetY = selectedHarbor ? selectedHarbor.sceneY - selectedHarbor.signalHeight - 18 : 300;
  const upperX = targetX + 124;
  const lowerX = targetX + 78;
  const upperY = targetY - 62;
  const lowerY = targetY + 80;

  return (
    <g className="lh-projection-beam" data-testid="lighthouse-beam" aria-hidden="true">
      <path
        d={`M ${LENS_X + 24} ${LENS_Y - 22} C 432 202 548 190 ${upperX} ${upperY} L ${lowerX} ${lowerY} C 556 372 420 352 ${LENS_X + 20} ${LENS_Y + 24} Z`}
        fill="url(#lh-beam-gradient)"
      />
      <path
        d={`M ${LENS_X + 34} ${LENS_Y + 4} C 488 272 664 254 ${targetX} ${targetY + 18}`}
        fill="none"
        stroke="oklch(1 0.1 88 / 0.32)"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </g>
  );
}

function SceneStars() {
  const stars = [
    [458, 76, 1.1],
    [552, 112, 0.8],
    [650, 82, 1.4],
    [732, 132, 0.9],
    [854, 66, 1.1],
    [932, 118, 0.8],
    [1068, 86, 1.2],
    [1192, 146, 0.9],
    [1260, 78, 1.1],
  ];
  return (
    <g className="lh-stars" aria-hidden="true">
      {stars.map(([x, y, r], index) => (
        <circle key={index} cx={x} cy={y} r={r} fill="oklch(0.98 0 0 / 0.88)" />
      ))}
    </g>
  );
}

function TailFleet({ model }: { model: LighthouseSceneModel }) {
  if (!model.tailFleet) return null;
  return (
    <g className="lh-tail-fleet" aria-hidden="true">
      {Array.from({ length: 9 }).map((_, index) => (
        <circle key={index} cx={1192 + index * 14} cy={336 + (index % 3) * 5} r="2.3" fill="oklch(0.72 0.04 205 / 0.45)" />
      ))}
      <text x="1190" y="374" className="lh-map-annotation">
        {model.tailFleet.label} / {formatPercentFromRatio(model.tailFleet.remainingSharePct, 1)}
      </text>
    </g>
  );
}

function SelectedReadout({ selectedHarbor }: { selectedHarbor: ProjectedHarbor | null }) {
  if (!selectedHarbor) return null;
  return (
    <div className="lh-stage-readout" data-testid="lighthouse-selected-manifest">
      <div className="lh-readout-identity">
        <span
          className="lh-readout-signal"
          style={{ backgroundColor: healthColor(selectedHarbor.healthBand) }}
          aria-hidden="true"
        />
        <div>
          <p className="pharos-kicker">Inspected Harbor</p>
          <p className="lh-readout-title">{selectedHarbor.name}</p>
        </div>
      </div>
      <div className="lh-readout-grid">
        <div>
          <span>Supply</span>
          <strong>{formatCompactUsd(selectedHarbor.totalUsd)}</strong>
        </div>
        <div>
          <span>Tracked Share</span>
          <strong>{formatPercent(selectedHarbor.sharePct, 1)}</strong>
        </div>
        <div>
          <span>Dominant Cargo</span>
          <strong>
            {selectedHarbor.dominantSymbol} {formatPercent(selectedHarbor.dominantSharePct, 1)}
          </strong>
        </div>
        <div>
          <span>7d Wake</span>
          <strong>{formatSignedPercent(selectedHarbor.change7dPct * 100, 1)}</strong>
        </div>
      </div>
    </div>
  );
}

export function LighthouseScene({
  model,
  className,
  onSelect,
  onPreview,
  onPreviewEnd,
  showSelectedManifest = true,
}: {
  model: LighthouseSceneModel;
  className?: string;
  onSelect: (id: string) => void;
  onPreview?: (id: string) => void;
  onPreviewEnd?: () => void;
  showSelectedManifest?: boolean;
}) {
  const lensGlowId = useId();
  const harbors = projectHarbors(model.ships);
  const selectedHarbor =
    harbors.find((harbor) => harbor.id === model.selectedId) ?? harbors.find((harbor) => harbor.isSelected) ?? harbors[0] ?? null;

  return (
    <section className={cn("lh-scene-shell", className)}>
      <div className="lh-cinematic-stage">
        <svg
          className="lh-scene"
          viewBox={`0 0 ${SCENE_WIDTH} ${SCENE_HEIGHT}`}
          role="img"
          aria-label={model.sceneSummary}
          preserveAspectRatio="xMidYMid meet"
          data-testid="lighthouse-scene"
          data-selected-id={model.selectedId ?? ""}
          data-watch-band={model.watchBand ?? ""}
          data-fleet-band={model.fleetBand}
        >
          <defs>
            <radialGradient id={lensGlowId} cx="50%" cy="50%" r="60%">
              <stop offset="0%" stopColor="oklch(1 0.14 90 / 0.78)" />
              <stop offset="58%" stopColor="oklch(0.84 0.08 93 / 0.18)" />
              <stop offset="100%" stopColor="oklch(0.08 0.02 248 / 0.2)" />
            </radialGradient>
            <linearGradient id="lh-sky-gradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="oklch(0.11 0.034 248)" />
              <stop offset="56%" stopColor="oklch(0.075 0.032 244)" />
              <stop offset="100%" stopColor="oklch(0.045 0.026 235)" />
            </linearGradient>
            <linearGradient id="lh-water-gradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="oklch(0.13 0.055 222)" />
              <stop offset="100%" stopColor="oklch(0.048 0.036 232)" />
            </linearGradient>
            <linearGradient id="lh-beam-gradient" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="oklch(1 0.13 88 / 0.54)" />
              <stop offset="52%" stopColor="oklch(0.96 0.1 88 / 0.28)" />
              <stop offset="100%" stopColor="oklch(0.98 0.08 88 / 0.04)" />
            </linearGradient>
            <pattern id="lh-sea-grid" width="46" height="22" patternUnits="userSpaceOnUse">
              <path d="M 0 21 H 46" stroke="oklch(0.55 0.07 205 / 0.1)" strokeWidth="1" />
              <path d="M 22 0 V 22" stroke="oklch(0.55 0.07 205 / 0.05)" strokeWidth="1" />
            </pattern>
          </defs>

          <rect x="0" y="0" width={SCENE_WIDTH} height={SCENE_HEIGHT} fill="url(#lh-sky-gradient)" aria-hidden="true" />
          <SceneStars />
          <path
            className={cn("lh-fog-bank", model.fleetBand === "fog" && "lh-fog-bank--heavy")}
            d="M 420 302 C 560 268 694 302 836 278 C 976 256 1094 278 1284 248 L 1360 248 L 1360 422 L 420 422 Z"
            fill="oklch(0.8 0.02 250 / 0.08)"
            aria-hidden="true"
          />
          <rect x="0" y="404" width={SCENE_WIDTH} height={SCENE_HEIGHT - 404} fill="url(#lh-water-gradient)" aria-hidden="true" />
          <rect x="0" y="404" width={SCENE_WIDTH} height={SCENE_HEIGHT - 404} fill="url(#lh-sea-grid)" aria-hidden="true" />
          <path
            className="lh-horizon-line"
            d="M 408 402 C 552 392 650 410 792 397 C 940 384 1062 398 1266 386"
            fill="none"
            stroke="oklch(0.62 0.08 205 / 0.32)"
            strokeWidth="1.4"
            aria-hidden="true"
          />

          <BeamPath selectedHarbor={selectedHarbor} />
          <LensAssembly glowId={lensGlowId} watchBand={model.watchBand} />
          <TailFleet model={model} />

          {harbors.map((harbor) => (
            <ProjectedHarborTarget
              key={harbor.id}
              harbor={harbor}
              selected={harbor.id === selectedHarbor?.id}
              onSelect={onSelect}
              onPreview={onPreview}
              onPreviewEnd={onPreviewEnd}
            />
          ))}

          <g className="lh-scene-map-labels" aria-hidden="true">
            <text x="74" y="92" className="lh-map-kicker">
              Watch State
            </text>
            <text x="74" y="116" className="lh-map-value">
              {model.watchLabel}
            </text>
            <text x="74" y="146" className="lh-map-annotation">
              {model.sceneSubtitle}
            </text>
            <text x="74" y="552" className="lh-map-kicker">
              Fleet
            </text>
            <text x="74" y="576" className="lh-map-value">
              {model.visibleShipCount} visible / {model.chainCount} chains
            </text>
          </g>
        </svg>

        {showSelectedManifest ? <SelectedReadout selectedHarbor={selectedHarbor} /> : null}
      </div>

      <div className="lh-scene-caption">
        <div>
          <p className="pharos-kicker">Night Watch</p>
          <p className="text-sm text-muted-foreground">{model.sceneSubtitle}</p>
        </div>
        <div className="lh-scene-caption__metrics">
          <div>
            <span className="pharos-kicker">Fleet</span>
            <p className="font-mono text-sm font-semibold text-foreground">{model.visibleShipCount} signals</p>
          </div>
          <div>
            <span className="pharos-kicker">Light Source</span>
            <p className="font-mono text-sm font-semibold text-foreground">{model.watchLabel}</p>
          </div>
          <div>
            <span className="pharos-kicker">Largest Harbor</span>
            <p className="font-mono text-sm font-semibold text-foreground">{model.largestHarbor ?? "-"}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
