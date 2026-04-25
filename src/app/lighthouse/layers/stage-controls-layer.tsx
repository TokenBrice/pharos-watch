"use client";

import { Aperture, Eye, Map, Maximize2, Radar } from "lucide-react";
import type { LighthouseMode } from "../cinematic-model";

export function StageControlsLayer({
  mode,
  fullscreenOpen = false,
  onModeChange,
  onExpandStage,
}: {
  mode: LighthouseMode;
  fullscreenOpen?: boolean;
  onModeChange: (mode: LighthouseMode) => void;
  onExpandStage?: () => void;
}) {
  return (
    <div className="lh-stage-controls" aria-label="Lighthouse display controls">
      <button
        type="button"
        className={mode === "watch" ? "lh-stage-control lh-stage-control--active pharos-focus-ring" : "lh-stage-control pharos-focus-ring"}
        aria-label="Watch mode"
        aria-pressed={mode === "watch"}
        title="Watch mode"
        onClick={() => onModeChange("watch")}
      >
        <Eye className="size-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        className={mode === "lens" ? "lh-stage-control lh-stage-control--active pharos-focus-ring" : "lh-stage-control pharos-focus-ring"}
        aria-label="Lens mode"
        aria-pressed={mode === "lens"}
        title="Lens mode"
        onClick={() => onModeChange("lens")}
      >
        <Aperture className="size-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        className={mode === "radar" ? "lh-stage-control lh-stage-control--active pharos-focus-ring" : "lh-stage-control pharos-focus-ring"}
        aria-label="Radar mode"
        aria-pressed={mode === "radar"}
        title="Radar mode"
        onClick={() => onModeChange("radar")}
      >
        <Radar className="size-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        className={mode === "atlas" ? "lh-stage-control lh-stage-control--active pharos-focus-ring" : "lh-stage-control pharos-focus-ring"}
        aria-label="Atlas mode"
        aria-pressed={mode === "atlas"}
        title="Atlas mode"
        onClick={() => onModeChange("atlas")}
      >
        <Map className="size-4" aria-hidden="true" />
      </button>
      {onExpandStage ? (
        <button
          type="button"
          className="lh-stage-control pharos-focus-ring"
          aria-label="Expand lighthouse"
          aria-haspopup="dialog"
          aria-expanded={fullscreenOpen}
          title="Expand lighthouse"
          onClick={onExpandStage}
        >
          <Maximize2 className="size-4" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
