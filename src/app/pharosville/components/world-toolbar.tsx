"use client";

import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, LocateFixed, Minus, Plus, RotateCcw, X } from "lucide-react";
import type { PharosVilleWorld } from "../systems/world-types";
import type { ScreenPoint } from "../systems/projection";

export interface WorldToolbarProps {
  world: PharosVilleWorld;
  headingId?: string;
  ledgerVisible?: boolean;
  selectedDetailId?: string | null;
  selectedDetailLabel?: string | null;
  zoomLabel?: string;
  onClearSelection?: () => void;
  onFollowSelected?: () => void;
  onPan?: (delta: ScreenPoint) => void;
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
  selectedDetailLabel,
  zoomLabel = "100%",
  onClearSelection,
  onFollowSelected,
  onPan,
  onResetView,
  onToggleLedger,
  onZoomIn,
  onZoomOut,
}: WorldToolbarProps) {
  const entityCount = 1
    + world.areas.length
    + world.docks.length
    + world.ships.length
    + world.shipClusters.length
    + world.graves.length;

  return (
    <div
      className="pharosville-world-toolbar"
      role="toolbar"
      aria-labelledby={headingId}
      data-testid="pharosville-world-toolbar"
    >
      <h2 id={headingId} className="sr-only">
        World toolbar
      </h2>
      <div className="pharosville-world-toolbar__group" role="group" aria-label="Zoom controls">
        <button type="button" onClick={onZoomOut} disabled={!onZoomOut} aria-label="Zoom out" title="Zoom out">
          <Minus aria-hidden="true" size={16} />
        </button>
        <output aria-label="Current zoom">{zoomLabel}</output>
        <button type="button" onClick={onZoomIn} disabled={!onZoomIn} aria-label="Zoom in" title="Zoom in">
          <Plus aria-hidden="true" size={16} />
        </button>
      </div>
      <div className="pharosville-world-toolbar__group" role="group" aria-label="Pan controls">
        <button type="button" onClick={() => onPan?.({ x: 0, y: 32 })} disabled={!onPan} aria-label="Pan north" title="Pan north">
          <ArrowUp aria-hidden="true" size={16} />
        </button>
        <button type="button" onClick={() => onPan?.({ x: -32, y: 0 })} disabled={!onPan} aria-label="Pan east" title="Pan east">
          <ArrowRight aria-hidden="true" size={16} />
        </button>
        <button type="button" onClick={() => onPan?.({ x: 0, y: -32 })} disabled={!onPan} aria-label="Pan south" title="Pan south">
          <ArrowDown aria-hidden="true" size={16} />
        </button>
        <button type="button" onClick={() => onPan?.({ x: 32, y: 0 })} disabled={!onPan} aria-label="Pan west" title="Pan west">
          <ArrowLeft aria-hidden="true" size={16} />
        </button>
      </div>
      <div className="pharosville-world-toolbar__group" role="group" aria-label="Selection controls">
        <button type="button" onClick={onResetView} disabled={!onResetView} aria-label="Reset view" title="Reset view">
          <RotateCcw aria-hidden="true" size={16} />
        </button>
        <button type="button" onClick={onFollowSelected} disabled={!onFollowSelected} aria-label="Follow selected" title="Follow selected">
          <LocateFixed aria-hidden="true" size={16} />
        </button>
        <button type="button" onClick={onClearSelection} disabled={!onClearSelection || !selectedDetailId} aria-label="Clear selection" title="Clear selection">
          <X aria-hidden="true" size={16} />
        </button>
      </div>
      {onToggleLedger && (
        <button
          className="pharosville-world-toolbar__ledger-button"
          type="button"
          aria-pressed={ledgerVisible}
          onClick={onToggleLedger}
        >
          Ledger
        </button>
      )}
      <div className="pharosville-world-toolbar__status">
        <output aria-live="polite" aria-label="Map entity count">
          {entityCount} entities
        </output>
        {selectedDetailId && (
          <output aria-live="polite" aria-label="Selected detail">
            {selectedDetailLabel ?? selectedDetailId}
          </output>
        )}
      </div>
    </div>
  );
}
