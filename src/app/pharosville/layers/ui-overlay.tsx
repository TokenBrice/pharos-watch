import type { SceneData } from "../systems/scene-data";

export interface UIOverlayProps {
  scene: SceneData;
  /** Canvas-space x/y per harbour id; the orchestrator passes this in. */
  positions: ReadonlyMap<string, { x: number; y: number }>;
  /** Optional click handler; tooltips/selection are wired in a future PR. */
  onSelectHarbor?: (id: string) => void;
}

export function UIOverlay({ scene, positions, onSelectHarbor }: UIOverlayProps) {
  return (
    <div className="harbor-overlay" aria-label="Harbour labels">
      {scene.harbors.map((h) => {
        const p = positions.get(h.id);
        if (!p) return null;
        return (
          <button
            key={h.id}
            type="button"
            className="harbor-overlay__label"
            style={{ left: `${p.x}px`, top: `${p.y - 30}px` }}
            data-harbor-id={h.id}
            onClick={() => onSelectHarbor?.(h.id)}
          >
            {h.name}
          </button>
        );
      })}
    </div>
  );
}
