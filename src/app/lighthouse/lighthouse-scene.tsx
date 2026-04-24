"use client";

import { useId } from "react";
import { HEALTH_HEX_FILL } from "@/lib/chain-ui";
import { PSI_HEX_COLORS, type ConditionBand } from "@shared/lib/psi-colors";
import { formatCompactUsd, formatPercent, formatSignedPercent } from "@shared/lib/format";
import { cn } from "@/lib/utils";
import type { LighthouseSceneModel, LighthouseShipRow } from "./view-model";
import "./lighthouse-scene.css";

const SCENE_WIDTH = 1360;
const SCENE_HEIGHT = 520;
const BEAM_LENGTH = 1040;

function healthColor(band: LighthouseShipRow["healthBand"]): string {
  if (!band) return "oklch(0.58 0.03 250)";
  return HEALTH_HEX_FILL[band];
}

function watchColor(band: string | null): string {
  if (!band) return "#f59e0b";
  return PSI_HEX_COLORS[band as ConditionBand] ?? "#f59e0b";
}

function ShipCargo({ count, color }: { count: number; color: string }) {
  return (
    <g aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => (
        <circle key={index} cx={-22 + index * 14} cy={-3} r="3.2" fill={color} opacity={index === 0 ? 0.95 : 0.72} />
      ))}
    </g>
  );
}

function LighthouseShip({
  ship,
  selected,
  onSelect,
}: {
  ship: LighthouseShipRow;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const hullFill = healthColor(ship.healthBand);
  const sailFill = ship.healthBand ? `${hullFill}cc` : "oklch(0.82 0.02 250 / 0.85)";
  const beamColor = selected ? watchColor(ship.healthBand ?? null) : "oklch(0.95 0.11 92 / 0.9)";

  return (
    <g
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${ship.name}, ${formatCompactUsd(ship.totalUsd)}, ${formatPercent(ship.sharePct, 1)} of supply, ${ship.healthBand ?? "unrated"} harbor, ${formatSignedPercent(ship.change7dPct * 100, 1)} over 7d`}
      className={cn("lh-ship-target", selected && "lh-ship-target-selected")}
      data-testid={`lighthouse-ship-${ship.id}`}
      onClick={() => onSelect(ship.id)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onSelect(ship.id);
      }}
      transform={`translate(${ship.centerX} ${ship.deckY})`}
    >
      <title>{`${ship.name}: ${formatCompactUsd(ship.totalUsd)} supply, ${formatSignedPercent(ship.change7dPct * 100, 1)} 7d`}</title>

      <ellipse className="lh-ship-shadow" cx="0" cy="18" rx={ship.hullWidth * 0.56} ry="10" />
      <rect
        className="lh-ship-focus-ring"
        x={-ship.hullWidth * 0.5 - 14}
        y={-ship.mastHeight - 26}
        width={ship.hullWidth + 28}
        height={ship.mastHeight + 56}
        rx="20"
        fill="none"
        stroke={beamColor}
        strokeWidth="2"
        opacity="0.34"
      />

      <path
        className="lh-hull"
        d={`M ${-ship.hullWidth / 2} 12
            Q ${-ship.hullWidth / 2 + 14} ${ship.hullHeight - 2} ${-ship.hullWidth / 2 + 30} ${ship.hullHeight - 2}
            L ${ship.hullWidth / 2 - 20} ${ship.hullHeight - 2}
            Q ${ship.hullWidth / 2 - 6} ${ship.hullHeight - 2} ${ship.hullWidth / 2} ${ship.hullHeight - 16}
            L ${ship.hullWidth / 2 - 12} 0
            L ${-ship.hullWidth / 2 + 14} 0
            Z`}
        fill={hullFill}
        stroke="oklch(0.12 0.02 250 / 0.45)"
        strokeWidth="1"
      />
      <rect
        x={-ship.hullWidth * 0.34}
        y={-2}
        width={ship.hullWidth * 0.68}
        height="5"
        rx="2.5"
        fill="oklch(1 0 0 / 0.28)"
      />
      <line x1="0" y1="0" x2="0" y2={-ship.mastHeight} stroke="oklch(0.92 0.02 250 / 0.7)" strokeWidth="3" />

      <path
        className="lh-sail"
        d={`M 0 ${-ship.mastHeight + 4} L ${ship.hullWidth * 0.28} ${-ship.mastHeight + 22} L 0 ${-ship.mastHeight + 40} Z`}
        fill={sailFill}
      />
      <path
        className="lh-sail lh-sail-secondary"
        d={`M 0 ${-ship.mastHeight + 18} L ${-ship.hullWidth * 0.22} ${-ship.mastHeight + 34} L 0 ${-ship.mastHeight + 48} Z`}
        fill="oklch(0.96 0.03 250 / 0.72)"
      />

      <circle
        cx="0"
        cy={-ship.mastHeight + 18}
        r="16"
        fill="oklch(0.05 0.03 248 / 0.72)"
        stroke={beamColor}
        strokeWidth="2"
      />
      {ship.logoPath ? (
        <image
          href={ship.logoPath}
          x={-11}
          y={-ship.mastHeight + 7}
          width="22"
          height="22"
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
        />
      ) : (
        <circle cx="0" cy={-ship.mastHeight + 18} r="5" fill={beamColor} aria-hidden="true" />
      )}

      <ShipCargo count={ship.cargoCount} color={beamColor} />

      <g aria-hidden="true">
        {Array.from({ length: ship.draftLayers }).map((_, index) => (
          <line
            key={index}
            x1={-ship.hullWidth * 0.24 + index * 10}
            y1={ship.hullHeight + 2 + index * 6}
            x2={ship.hullWidth * 0.22 - index * 8}
            y2={ship.hullHeight + 2 + index * 6}
            stroke="oklch(0.72 0.03 248 / 0.55)"
            strokeWidth="1"
          />
        ))}
      </g>

      {ship.wakeDirection !== 0 ? (
        <path
          d={
            ship.wakeDirection > 0
              ? `M ${-ship.hullWidth / 2 - 8} ${ship.hullHeight + 12}
                 C ${-ship.hullWidth / 2 - 24 - Math.abs(ship.wakeLength) * 38} ${ship.hullHeight + 12}
                 ${-ship.hullWidth / 2 - 42 - Math.abs(ship.wakeLength) * 38} ${ship.hullHeight + 8}
                 ${-ship.hullWidth / 2 - 64 - Math.abs(ship.wakeLength) * 58} ${ship.hullHeight + 8}`
              : `M ${ship.hullWidth / 2 + 8} ${ship.hullHeight + 12}
                 C ${ship.hullWidth / 2 + 24 + Math.abs(ship.wakeLength) * 38} ${ship.hullHeight + 12}
                 ${ship.hullWidth / 2 + 42 + Math.abs(ship.wakeLength) * 38} ${ship.hullHeight + 8}
                 ${ship.hullWidth / 2 + 64 + Math.abs(ship.wakeLength) * 58} ${ship.hullHeight + 8}`
          }
          fill="none"
          stroke="oklch(0.78 0.05 196 / 0.45)"
          strokeWidth="2"
          strokeLinecap="round"
          className="lh-wake"
        />
      ) : null}

      <text x="0" y="46" textAnchor="middle" className="lh-ship-label" aria-hidden="true">
        {ship.name}
      </text>
      <text x="0" y="62" textAnchor="middle" className="lh-ship-subtitle" aria-hidden="true">
        {formatPercent(ship.sharePct, 1)} of supply
      </text>
      <text x="0" y="78" textAnchor="middle" className="lh-ship-subtitle" aria-hidden="true">
        {formatSignedPercent(ship.change7dPct * 100, 1)} 7d
      </text>
    </g>
  );
}

function LighthouseTower({
  lighthouseX,
  lighthouseY,
  targetX,
  targetY,
  watchBand,
  selectedShipBand,
}: {
  lighthouseX: number;
  lighthouseY: number;
  targetX: number;
  targetY: number;
  watchBand: string | null;
  selectedShipBand: LighthouseShipRow["healthBand"];
}) {
  const beamAngle = Math.atan2(targetY - lighthouseY, targetX - lighthouseX) * (180 / Math.PI);
  const flameColor = watchColor(watchBand);

  return (
    <g aria-hidden="true">
      <path
        d={`M ${lighthouseX - 66} 394
          Q ${lighthouseX - 46} 356 ${lighthouseX - 28} 350
          Q ${lighthouseX - 16} 344 ${lighthouseX + 2} 346
          Q ${lighthouseX + 18} 348 ${lighthouseX + 38} 357
          Q ${lighthouseX + 58} 366 ${lighthouseX + 70} 394 Z`}
        fill="oklch(0.09 0.02 248)"
      />
      <path
        d={`M ${lighthouseX - 44} 396 Q ${lighthouseX - 18} 368 ${lighthouseX + 8} 364 Q ${lighthouseX + 34} 360 ${lighthouseX + 58} 396 Z`}
        fill="oklch(0.14 0.02 248)"
      />

      <g
        className="lh-beam"
        transform={`translate(${lighthouseX} ${lighthouseY}) rotate(${beamAngle})`}
        data-testid="lighthouse-beam"
      >
        <path d={`M 0 0 L ${-BEAM_LENGTH} -92 L ${-BEAM_LENGTH} 92 Z`} fill="oklch(0.98 0.11 92 / 0.72)" />
      </g>

      <g>
        <rect
          x={lighthouseX - 18}
          y={lighthouseY + 18}
          width="36"
          height="138"
          rx="8"
          fill="url(#lh-lighthouse-stone)"
          stroke="oklch(0.18 0.02 58)"
          strokeWidth="1"
        />
        <rect x={lighthouseX - 25} y={lighthouseY + 6} width="50" height="18" rx="5" fill="oklch(0.93 0.04 58)" />
        <rect x={lighthouseX - 12} y={lighthouseY + 42} width="24" height="18" rx="4" fill="oklch(0.86 0.03 58)" />
        <rect x={lighthouseX - 15} y={lighthouseY - 20} width="30" height="40" rx="8" fill="oklch(0.94 0.04 58)" />
        <circle cx={lighthouseX} cy={lighthouseY - 38} r="22" fill="oklch(0.95 0.12 35 / 0.2)" />
        <circle cx={lighthouseX} cy={lighthouseY - 38} r="8" fill={flameColor} />
        <path
          d={`M ${lighthouseX - 6} ${lighthouseY - 34} L ${lighthouseX} ${lighthouseY - 54} L ${lighthouseX + 6} ${lighthouseY - 34} Z`}
          fill="oklch(1 0.15 78)"
          opacity="0.9"
        />
        <rect x={lighthouseX - 5} y={lighthouseY - 60} width="10" height="18" rx="3" fill="oklch(0.55 0.06 58)" />
        <path
          d={`M ${lighthouseX - 8} ${lighthouseY - 68} Q ${lighthouseX} ${lighthouseY - 84} ${lighthouseX + 8} ${lighthouseY - 68}`}
          fill="none"
          stroke="oklch(0.45 0.03 58)"
          strokeWidth="2"
        />
      </g>

      {selectedShipBand ? (
        <circle
          cx={lighthouseX}
          cy={lighthouseY - 38}
          r="30"
          fill="none"
          stroke={flameColor}
          strokeWidth="1.5"
          opacity="0.5"
        />
      ) : null}
    </g>
  );
}

export function LighthouseScene({
  model,
  className,
  onSelect,
}: {
  model: LighthouseSceneModel;
  className?: string;
  onSelect: (id: string) => void;
}) {
  const lighthouseStoneId = useId();
  const selectedShip = model.selectedShip ?? model.ships[0] ?? null;
  const beamTargetX = selectedShip ? selectedShip.centerX : model.lighthouseX - 260;
  const beamTargetY = selectedShip ? selectedShip.deckY - selectedShip.mastHeight * 0.86 : model.waterlineY - 96;

  return (
    <section className={cn("lh-scene-shell", className)}>
      <div className="lh-scene-frame">
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
            <linearGradient id={lighthouseStoneId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="oklch(0.95 0.03 58)" />
              <stop offset="100%" stopColor="oklch(0.78 0.03 58)" />
            </linearGradient>
            <linearGradient id="lh-sky-gradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="oklch(0.13 0.03 248)" />
              <stop offset="100%" stopColor="oklch(0.08 0.03 248)" />
            </linearGradient>
            <linearGradient id="lh-water-gradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="oklch(0.11 0.05 226)" />
              <stop offset="100%" stopColor="oklch(0.05 0.04 230)" />
            </linearGradient>
          </defs>

          <rect x="0" y="0" width={SCENE_WIDTH} height={SCENE_HEIGHT} fill="url(#lh-sky-gradient)" aria-hidden="true" />
          <g aria-hidden="true" className={cn("lh-fog-wash", model.fleetBand === "fog" && "lh-fog-wash--heavy")}>
            <rect x="0" y="0" width={SCENE_WIDTH} height="260" fill="oklch(0.85 0.02 250 / 0.04)" />
          </g>
          <g aria-hidden="true" className="lh-stars">
            {[
              [42, 42, 1.2],
              [138, 74, 0.9],
              [240, 28, 1.1],
              [332, 64, 0.8],
              [410, 24, 1],
              [628, 56, 0.9],
              [774, 40, 0.8],
              [958, 68, 1],
            ].map(([x, y, r], index) => (
              <circle key={index} cx={x} cy={y} r={r} fill="oklch(0.98 0 0)" opacity="0.85" />
            ))}
          </g>

          <rect
            x="0"
            y={model.waterlineY}
            width={SCENE_WIDTH}
            height={SCENE_HEIGHT - model.waterlineY}
            fill="url(#lh-water-gradient)"
            aria-hidden="true"
          />
          <path
            d={`M 0 ${model.waterlineY} C 120 ${model.waterlineY - 2}, 240 ${model.waterlineY + 4}, 360 ${model.waterlineY} S 600 ${model.waterlineY - 4}, 760 ${model.waterlineY} S 1020 ${model.waterlineY + 3}, 1360 ${model.waterlineY - 1}`}
            fill="none"
            stroke="oklch(0.6 0.08 198 / 0.28)"
            strokeWidth="1.5"
            aria-hidden="true"
            className="lh-waterline"
          />

          {model.tailFleet ? (
            <g aria-hidden="true" className="lh-tail-fleet">
              <g transform="translate(74 318)">
                <ellipse cx="0" cy="14" rx="38" ry="10" fill="oklch(0.25 0.02 248 / 0.38)" />
                <path d="M -28 12 Q 0 -14 28 12 Q 0 22 -28 12 Z" fill="oklch(0.52 0.02 248 / 0.42)" />
                <text x="0" y="44" textAnchor="middle" className="lh-ship-subtitle">
                  {model.tailFleet.label}
                </text>
                <text x="0" y="60" textAnchor="middle" className="lh-ship-subtitle">
                  {formatCompactUsd(model.tailFleet.remainingUsd)} ·{" "}
                  {formatPercent(model.tailFleet.remainingSharePct, 1)}
                </text>
              </g>
            </g>
          ) : null}

          <LighthouseTower
            lighthouseX={model.lighthouseX}
            lighthouseY={model.lighthouseY}
            targetX={beamTargetX}
            targetY={beamTargetY}
            watchBand={model.watchBand}
            selectedShipBand={selectedShip?.healthBand ?? null}
          />

          {model.ships.map((ship) => (
            <LighthouseShip key={ship.id} ship={ship} selected={ship.id === model.selectedId} onSelect={onSelect} />
          ))}
        </svg>
      </div>

      <div className="lh-scene-caption">
        <div>
          <p className="pharos-kicker">Night Watch</p>
          <p className="text-sm text-muted-foreground">{model.sceneSubtitle}</p>
        </div>
        <div className="lh-scene-caption__metrics">
          <div>
            <span className="pharos-kicker">Fleet</span>
            <p className="font-mono text-sm font-semibold text-foreground">{model.visibleShipCount} visible</p>
          </div>
          <div>
            <span className="pharos-kicker">Watch</span>
            <p className="font-mono text-sm font-semibold text-foreground">{model.watchLabel}</p>
          </div>
          <div>
            <span className="pharos-kicker">Largest Harbor</span>
            <p className="font-mono text-sm font-semibold text-foreground">{model.largestHarbor ?? "—"}</p>
          </div>
        </div>
      </div>

      {selectedShip ? (
        <div className="lh-selected-manifest" data-testid="lighthouse-selected-manifest">
          <div className="space-y-1">
            <p className="pharos-kicker">Selected Harbor</p>
            <p className="text-base font-semibold text-foreground">{selectedShip.name}</p>
            <p className="text-sm text-muted-foreground">
              {formatCompactUsd(selectedShip.totalUsd)} supply · {formatPercent(selectedShip.sharePct, 1)} of tracked
              supply · {selectedShip.healthBand ?? "unrated"}
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="lh-manifest-pill">
              <span className="pharos-kicker">Dominant Cargo</span>
              <p className="font-mono text-sm font-semibold text-foreground">
                {selectedShip.dominantSymbol} · {formatPercent(selectedShip.dominantSharePct, 1)}
              </p>
            </div>
            <div className="lh-manifest-pill">
              <span className="pharos-kicker">Wake</span>
              <p className="font-mono text-sm font-semibold text-foreground">
                {formatSignedPercent(selectedShip.change7dPct * 100, 1)}
              </p>
            </div>
            <div className="lh-manifest-pill">
              <span className="pharos-kicker">Cargo Marks</span>
              <p className="font-mono text-sm font-semibold text-foreground">{selectedShip.cargoCount}</p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Ship hull width follows chain supply, the beam marks the currently inspected harbor, and the manifest below
            keeps the scene grounded in the data.
          </p>
        </div>
      ) : null}
    </section>
  );
}
