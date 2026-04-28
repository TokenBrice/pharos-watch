import { HARBOR_PALETTE } from "../systems/palette";
import type { DrawableLayer, FrameState } from "../systems/scene-render";

export interface Lamp {
  x: number;
  y: number;
  /** True for warm yellow lanterns; false for cool ship/anchor lights. */
  warm: boolean;
  /** Phase offset in radians so lamps don't all flicker in unison. */
  phase: number;
}

export interface LampLayerAPI extends DrawableLayer {
  setLamps(lamps: Lamp[]): void;
  count(): number;
}

export function buildLampLayer(): LampLayerAPI {
  let lamps: Lamp[] = [];
  return {
    draw(ctx, frame: FrameState) {
      const t = frame.reducedMotion ? 0 : frame.t;
      for (const l of lamps) {
        const flicker = frame.reducedMotion ? 1 : 0.85 + 0.15 * Math.sin(t * 4 + l.phase);
        const color = l.warm ? HARBOR_PALETTE.lantern_warm : HARBOR_PALETTE.lantern_cold;
        // Halo
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.18 * flicker;
        ctx.beginPath();
        ctx.arc(l.x, l.y, 6, 0, Math.PI * 2);
        ctx.fill();
        // Hot pixel core
        ctx.globalAlpha = 1;
        ctx.fillRect(l.x - 1, l.y - 1, 2, 2);
      }
      ctx.globalAlpha = 1;
    },
    setLamps(next) {
      lamps = next;
    },
    count() {
      return lamps.length;
    },
  };
}
