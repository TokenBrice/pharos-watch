import type { DrawableLayer, FrameState } from "../systems/scene-render";
import { drawBoat } from "../sprites/boat-sprite";
import type { SceneBoat } from "../systems/scene-data";

interface BoatPlacement {
  boat: SceneBoat;
  baseX: number;
  baseY: number;
  phase: number;
}

export interface BoatLayerAPI extends DrawableLayer {
  upsertBoat(boat: SceneBoat, screen: { x: number; y: number }): void;
  removeBoat(coinId: string): void;
  pruneExcept(ids: Set<string>): void;
  positionFor(coinId: string): { x: number; y: number } | null;
  count(): number;
}

export function buildBoatLayer(): BoatLayerAPI {
  const map = new Map<string, BoatPlacement>();

  return {
    upsertBoat(boat, screen) {
      const existing = map.get(boat.coinId);
      if (existing) {
        existing.boat = boat;
        existing.baseX = screen.x;
        existing.baseY = screen.y;
        return;
      }
      map.set(boat.coinId, {
        boat,
        baseX: screen.x,
        baseY: screen.y,
        phase: hashPhase(boat.coinId),
      });
    },
    removeBoat(coinId) {
      map.delete(coinId);
    },
    pruneExcept(ids) {
      for (const id of map.keys()) if (!ids.has(id)) map.delete(id);
    },
    positionFor(coinId) {
      const e = map.get(coinId);
      return e ? { x: e.baseX, y: e.baseY } : null;
    },
    count() {
      return map.size;
    },
    draw(ctx, frame: FrameState) {
      const t = frame.reducedMotion ? 0 : frame.t * 1.0;
      // Painter's order — sort by Y so boats further south paint on top
      const sorted = Array.from(map.values()).sort((a, b) => a.baseY - b.baseY);
      for (const e of sorted) {
        const dy = frame.reducedMotion ? 0 : Math.round(Math.sin(t + e.phase));
        drawBoat(ctx, Math.round(e.baseX), Math.round(e.baseY + dy), {
          style: e.boat.style,
          size: e.boat.hullSize,
          pennantHex: e.boat.pennantHex,
          auraHex: null,
        });
      }
    },
  };
}

/** FNV-1a hash → [0, 2π) phase offset so two boats with different ids never bob in lockstep. */
function hashPhase(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) / 0xffffffff) * Math.PI * 2;
}
