"use client";

import type { LighthouseCinematicModel, LighthouseMode, LighthouseModuleId } from "./cinematic-model";
import { AtmosphereLayer } from "./layers/atmosphere-layer";
import { AltPegProjectionLayer } from "./layers/alt-peg-projection-layer";
import { DewsRadarLayer } from "./layers/dews-radar-layer";
import { HarborFleetLayer } from "./layers/harbor-fleet-layer";
import { ModuleIslandBaseLayer } from "./layers/module-island-base-layer";
import { PharosTowerLayer } from "./layers/pharos-tower-layer";
import { PsiLensIslandLayer } from "./layers/psi-lens-island-layer";
import { StageControlsLayer } from "./layers/stage-controls-layer";
import { LighthouseA11yLedger } from "./lighthouse-a11y-ledger";
import "./lighthouse-stage.css";

export function LighthouseStage({
  model,
  variant = "inline",
  ariaLabelledBy = "lighthouse-heading",
  ariaLabel,
  fullscreenOpen = false,
  onModeChange,
  onExpandStage,
  onPreviewModule,
  onPreviewModuleEnd,
  onSelectModule,
  onSelectHarbor,
  onPreviewHarbor,
  onPreviewEnd,
}: {
  model: LighthouseCinematicModel;
  variant?: "inline" | "fullscreen";
  ariaLabelledBy?: string;
  ariaLabel?: string;
  fullscreenOpen?: boolean;
  onModeChange: (mode: LighthouseMode) => void;
  onExpandStage?: () => void;
  onPreviewModule?: (id: LighthouseModuleId) => void;
  onPreviewModuleEnd?: () => void;
  onSelectModule?: (id: LighthouseModuleId) => void;
  onSelectHarbor: (id: string) => void;
  onPreviewHarbor?: (id: string) => void;
  onPreviewEnd?: () => void;
}) {
  const sectionLabelProps = ariaLabel ? { "aria-label": ariaLabel } : { "aria-labelledby": ariaLabelledBy };

  return (
    <section
      className={variant === "fullscreen" ? "lh-cinematic-experience lh-cinematic-experience--fullscreen" : "lh-cinematic-experience"}
      {...sectionLabelProps}
    >
      <div
        className={variant === "fullscreen" ? "lh-stage-frame lh-stage-frame--fullscreen" : "lh-stage-frame"}
        data-mode={model.stage.mode}
        data-testid="lighthouse-cinematic-stage"
      >
        <svg
          className="lh-stage-svg"
          viewBox={`0 0 ${model.stage.viewBox.width} ${model.stage.viewBox.height}`}
          role="img"
          aria-label={model.stage.sceneLabel}
          preserveAspectRatio="none"
          data-testid="lighthouse-stage-svg"
          data-mode={model.stage.mode}
          data-active-module-id={model.stage.activeModuleId}
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
          <ModuleIslandBaseLayer
            model={model}
            onPreviewModule={onPreviewModule}
            onPreviewModuleEnd={onPreviewModuleEnd}
            onSelectModule={onSelectModule}
          />
          <AltPegProjectionLayer model={model} />
          <DewsRadarLayer model={model} />
          <PsiLensIslandLayer model={model} />
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
          fullscreenOpen={fullscreenOpen}
          onModeChange={onModeChange}
          onExpandStage={onExpandStage}
        />
      </div>
      <LighthouseA11yLedger model={model} />
    </section>
  );
}
