"use client";

import type { PharosVilleWorld } from "../systems/world-types";

export interface WorldToolbarProps {
  world: PharosVilleWorld;
  headingId?: string;
  ledgerVisible?: boolean;
  selectedDetailId?: string | null;
  zoomLabel?: string;
  onResetView?: () => void;
  onToggleLedger?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
}

export function WorldToolbar({
  world,
  headingId = "pharosville-world-toolbar-title",
  ledgerVisible = false,
  selectedDetailId,
  zoomLabel = "100%",
  onResetView,
  onToggleLedger,
  onZoomIn,
  onZoomOut,
}: WorldToolbarProps) {
  const entityCount = 1 + world.docks.length + world.ships.length + world.shipClusters.length + world.graves.length;

  return (
    <div role="toolbar" aria-labelledby={headingId} data-testid="pharosville-world-toolbar">
      <h2 id={headingId} className="sr-only">
        World toolbar
      </h2>
      <button type="button" onClick={onZoomOut} disabled={!onZoomOut} aria-label="Zoom out">
        -
      </button>
      <output aria-label="Current zoom">{zoomLabel}</output>
      <button type="button" onClick={onZoomIn} disabled={!onZoomIn} aria-label="Zoom in">
        +
      </button>
      <button type="button" onClick={onResetView} disabled={!onResetView}>
        Reset view
      </button>
      <button type="button" aria-pressed={ledgerVisible} onClick={onToggleLedger} disabled={!onToggleLedger}>
        Ledger
      </button>
      <output aria-live="polite" aria-label="Map entity count">
        {entityCount} entities
      </output>
      {selectedDetailId && (
        <output aria-live="polite" aria-label="Selected detail">
          {selectedDetailId}
        </output>
      )}
    </div>
  );
}
