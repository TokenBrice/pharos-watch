"use client";

import { Eye, Map, Radar, ScrollText } from "lucide-react";
import type { LighthouseMode } from "../cinematic-model";

export function StageControlsLayer({
  mode,
  ledgerOpen,
  onModeChange,
  onToggleLedger,
}: {
  mode: LighthouseMode;
  ledgerOpen: boolean;
  onModeChange: (mode: LighthouseMode) => void;
  onToggleLedger: () => void;
}) {
  return (
    <div className="lh-stage-controls" aria-label="Lighthouse display controls">
      <button
        type="button"
        className={mode === "watch" ? "lh-stage-control lh-stage-control--active pharos-focus-ring" : "lh-stage-control pharos-focus-ring"}
        aria-label="Watch mode"
        aria-pressed={mode === "watch"}
        onClick={() => onModeChange("watch")}
      >
        <Eye className="size-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        className={mode === "radar" ? "lh-stage-control lh-stage-control--active pharos-focus-ring" : "lh-stage-control pharos-focus-ring"}
        aria-label="Radar mode"
        aria-pressed={mode === "radar"}
        onClick={() => onModeChange("radar")}
      >
        <Radar className="size-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        className={mode === "atlas" ? "lh-stage-control lh-stage-control--active pharos-focus-ring" : "lh-stage-control pharos-focus-ring"}
        aria-label="Atlas mode"
        aria-pressed={mode === "atlas"}
        onClick={() => onModeChange("atlas")}
      >
        <Map className="size-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        className={ledgerOpen ? "lh-stage-control lh-stage-control--active pharos-focus-ring" : "lh-stage-control pharos-focus-ring"}
        aria-label="Toggle data ledger"
        aria-pressed={ledgerOpen}
        onClick={onToggleLedger}
      >
        <ScrollText className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
