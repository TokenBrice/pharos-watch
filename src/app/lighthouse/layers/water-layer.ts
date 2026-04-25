import { HARBOR_PALETTE } from "../systems/palette";
import type { DrawableLayer, FrameState } from "../systems/scene-render";

export function buildWaterLayer(): DrawableLayer {
  return {
    draw(ctx, frame: FrameState) {
      // Base wash (so we never see canvas clear color through the scanlines)
      ctx.fillStyle = HARBOR_PALETTE.deep_sea_2;
      ctx.fillRect(0, Math.floor(frame.height * 0.45), frame.width, frame.height);

      const amp = frame.scene.sea.amplitudePx;
      const rows = 16;
      const rowH = Math.ceil((frame.height * 0.55) / rows);
      const y0 = Math.floor(frame.height * 0.45);
      const t = frame.reducedMotion ? 0 : frame.t;

      for (let r = 0; r < rows; r++) {
        const y = y0 + r * rowH;
        const swell = Math.sin(t * 0.3 + r * 0.7) * 1.5 * amp;
        const chop = Math.sin(t * 1.4 + r * 1.1) * 0.6 * amp;
        const ripple = Math.sin(t * 3.2 + r * 2.3) * 0.3 * amp;
        const dy = frame.reducedMotion ? 0 : Math.round(swell + chop + ripple);
        const tint = r > rows * 0.6 ? HARBOR_PALETTE.deep_sea_1 : HARBOR_PALETTE.deep_sea_2;
        ctx.fillStyle = tint;
        ctx.globalAlpha = 0.55;
        ctx.fillRect(0, y + dy, frame.width, rowH);
      }
      ctx.globalAlpha = 1;

      // Foam intensity at shoreline (visible even under reduced-motion — uses amplitude)
      const foamY = y0 - 1;
      ctx.fillStyle = HARBOR_PALETTE.foam_white;
      ctx.globalAlpha = Math.min(0.4, 0.08 + amp * 0.05);
      ctx.fillRect(0, foamY, frame.width, 1);
      ctx.globalAlpha = 1;
    },
  };
}
