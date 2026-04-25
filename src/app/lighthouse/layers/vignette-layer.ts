import { paletteRgba, HARBOR_PALETTE } from "../systems/palette";
import type { DrawableLayer, FrameState } from "../systems/scene-render";

const HAZE_HALF_HEIGHT = 4; // ±4 px around the waterline
const VIGNETTE_HEIGHT = 24;

export function buildVignetteLayer(): DrawableLayer {
  return {
    draw(ctx, frame: FrameState) {
      const y0 = Math.floor(frame.height * 0.45);

      // Horizon haze — fog_pale strip centered on the waterline, fading both ways
      const haze = ctx.createLinearGradient(0, y0 - HAZE_HALF_HEIGHT, 0, y0 + HAZE_HALF_HEIGHT);
      haze.addColorStop(0,   paletteRgba("fog_pale", 0));
      haze.addColorStop(0.5, paletteRgba("fog_pale", 0.35));
      haze.addColorStop(1,   paletteRgba("fog_pale", 0));
      ctx.fillStyle = haze;
      ctx.fillRect(0, y0 - HAZE_HALF_HEIGHT, frame.width, HAZE_HALF_HEIGHT * 2);

      // Bottom vignette — deep_sea_2 fade up from the canvas bottom
      const v = ctx.createLinearGradient(0, frame.height - VIGNETTE_HEIGHT, 0, frame.height);
      v.addColorStop(0, paletteRgba("deep_sea_2", 0));
      v.addColorStop(1, HARBOR_PALETTE.deep_sea_2);
      ctx.fillStyle = v;
      ctx.fillRect(0, frame.height - VIGNETTE_HEIGHT, frame.width, VIGNETTE_HEIGHT);
    },
  };
}
