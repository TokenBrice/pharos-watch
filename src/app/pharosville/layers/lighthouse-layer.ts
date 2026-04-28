import { drawLighthouse } from "../sprites/lighthouse-sprite";
import type { DrawableLayer, FrameState } from "../systems/scene-render";

export interface LighthouseLayerAPI extends DrawableLayer {
  setAnchor(x: number, y: number): void;
  anchor(): { x: number; y: number };
}

export function buildLighthouseLayer(): LighthouseLayerAPI {
  let ax = 0;
  let ay = 0;
  return {
    setAnchor(x, y) { ax = x; ay = y; },
    anchor() { return { x: ax, y: ay }; },
    draw(ctx, frame: FrameState) {
      drawLighthouse(ctx, ax, ay, {
        beamRotationRad: frame.beam.rotationRad,
        beamColorHex: frame.beam.colorHex,
        beamAlpha: frame.beam.alpha,
        lanternAlpha: frame.lantern.alpha,
      });
    },
  };
}
