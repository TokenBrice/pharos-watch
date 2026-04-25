"use client";

import type { LighthouseCinematicModel, LighthouseMode } from "./cinematic-model";
import { AtmosphereLayer } from "./layers/atmosphere-layer";
import { AltPegProjectionLayer } from "./layers/alt-peg-projection-layer";
import { DewsRadarLayer } from "./layers/dews-radar-layer";
import { HarborFleetLayer } from "./layers/harbor-fleet-layer";
import { PharosTowerLayer } from "./layers/pharos-tower-layer";
import { StageControlsLayer } from "./layers/stage-controls-layer";
import { LighthouseA11yLedger } from "./lighthouse-a11y-ledger";
import "./lighthouse-stage.css";

export function LighthouseStage({
  model,
  ledgerOpen,
  onModeChange,
  onToggleLedger,
  onSelectHarbor,
  onPreviewHarbor,
  onPreviewEnd,
}: {
  model: LighthouseCinematicModel;
  ledgerOpen: boolean;
  onModeChange: (mode: LighthouseMode) => void;
  onToggleLedger: () => void;
  onSelectHarbor: (id: string) => void;
  onPreviewHarbor?: (id: string) => void;
  onPreviewEnd?: () => void;
}) {
  return (
    <section className="lh-cinematic-experience" aria-labelledby="lighthouse-heading">
      <div className="lh-stage-frame" data-mode={model.stage.mode} data-testid="lighthouse-cinematic-stage">
        <svg
          className="lh-stage-svg"
          viewBox={`0 0 ${model.stage.viewBox.width} ${model.stage.viewBox.height}`}
          role="img"
          aria-label={model.stage.sceneLabel}
          preserveAspectRatio="xMidYMid meet"
          data-testid="lighthouse-stage-svg"
          data-mode={model.stage.mode}
          data-selected-id={model.stage.selectedHarborId ?? ""}
        >
          <defs>
            <linearGradient id="lh-night-sky" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="oklch(0.105 0.034 248)" />
              <stop offset="58%" stopColor="oklch(0.065 0.032 244)" />
              <stop offset="100%" stopColor="oklch(0.034 0.024 236)" />
            </linearGradient>
            <linearGradient id="lh-cinematic-water" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="oklch(0.13 0.052 218)" />
              <stop offset="100%" stopColor="oklch(0.045 0.034 232)" />
            </linearGradient>
            <linearGradient id="lh-main-beam-gradient" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="var(--lh-lens-color, #f8d77a)" stopOpacity="0.7" />
              <stop offset="54%" stopColor="var(--lh-lens-color, #f8d77a)" stopOpacity="0.27" />
              <stop offset="100%" stopColor="var(--lh-lens-color, #f8d77a)" stopOpacity="0.02" />
            </linearGradient>
            <linearGradient id="lh-stone-gradient" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="oklch(0.58 0.025 78)" />
              <stop offset="48%" stopColor="oklch(0.82 0.034 82)" />
              <stop offset="100%" stopColor="oklch(0.44 0.025 76)" />
            </linearGradient>
            <linearGradient id="lh-ship-hull" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="oklch(0.34 0.09 52)" />
              <stop offset="100%" stopColor="oklch(0.16 0.05 40)" />
            </linearGradient>
            <linearGradient id="lh-sail-gradient" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="oklch(0.96 0.03 86 / 0.86)" />
              <stop offset="70%" stopColor="oklch(0.72 0.04 235 / 0.62)" />
              <stop offset="100%" stopColor="oklch(0.45 0.04 235 / 0.36)" />
            </linearGradient>
            <radialGradient id="lh-radar-wake" cx="0" cy="0" r="230" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="var(--lh-radar-color, #22c55e)" stopOpacity="0.18" />
              <stop offset="100%" stopColor="var(--lh-radar-color, #22c55e)" stopOpacity="0" />
            </radialGradient>
            <pattern id="lh-sea-grid" width="56" height="28" patternUnits="userSpaceOnUse">
              <path d="M 0 27 H 56" stroke="oklch(0.54 0.08 205 / 0.11)" strokeWidth="1" />
              <path d="M 28 0 V 28" stroke="oklch(0.54 0.08 205 / 0.06)" strokeWidth="1" />
            </pattern>
          </defs>
          <AtmosphereLayer model={model} />
          <AltPegProjectionLayer model={model} />
          <DewsRadarLayer model={model} />
          <PharosTowerLayer model={model} />
          <HarborFleetLayer
            harbors={model.harbors.visible}
            tail={model.harbors.tail}
            onSelect={onSelectHarbor}
            onPreview={onPreviewHarbor}
            onPreviewEnd={onPreviewEnd}
          />
        </svg>
        <StageControlsLayer
          mode={model.stage.mode}
          ledgerOpen={ledgerOpen}
          onModeChange={onModeChange}
          onToggleLedger={onToggleLedger}
        />
      </div>
      <LighthouseA11yLedger model={model} visible={ledgerOpen} />
    </section>
  );
}
