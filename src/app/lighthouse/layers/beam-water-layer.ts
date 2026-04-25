import type { DrawableLayer, FrameState } from "../systems/scene-render";

const BEAM_REACH = 300;     // matches BEAM_LEN in lighthouse-sprite.ts (post-2x scale)
const PATCH_WIDTH = 140;
const PATCH_HEIGHT = 6;

export interface BeamWaterLayerAPI extends DrawableLayer {
  setLighthouseAnchor(x: number, y: number): void;
}

export function buildBeamWaterLayer(): BeamWaterLayerAPI {
  let ax = 0;
  let ay = 0;
  return {
    setLighthouseAnchor(x, y) { ax = x; ay = y; },
    draw(ctx, frame: FrameState) {
      const ang = frame.beam.rotationRad;
      // Beam direction in canvas-Y (positive = pointing down/forward into the water).
      const dirY = Math.sin(ang);
      // Skip when the beam aims at the sky — the air doesn't catch the highlight.
      if (dirY <= 0.15) return;
      // Skip when no anchor is set yet (mount race).
      if (ax === 0 && ay === 0) return;

      const ix = ax + Math.cos(ang) * BEAM_REACH;
      const iy = ay + Math.sin(ang) * BEAM_REACH;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.18 * dirY;          // brighter when beam is more vertical
      ctx.fillStyle = frame.beam.colorHex;     // same color as the beam (PSI band)
      ctx.fillRect(
        Math.round(ix - PATCH_WIDTH / 2),
        Math.round(iy - PATCH_HEIGHT / 2),
        PATCH_WIDTH,
        PATCH_HEIGHT,
      );
      ctx.restore();
    },
  };
}
