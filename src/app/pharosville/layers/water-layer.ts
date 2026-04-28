import { HARBOR_PALETTE } from "../systems/palette";
import type { DrawableLayer, FrameState } from "../systems/scene-render";
import { mulberry32 } from "../systems/rng";

interface MoonpathDot {
  dx: number;
  dy: number;
  phase: number;
}

export function buildWaterLayer(): DrawableLayer {
  let cachedW = 0;
  let cachedH = 0;
  let moonpath: MoonpathDot[] = [];

  const ensureMoonpath = (w: number, h: number) => {
    if (w === cachedW && h === cachedH) return;
    cachedW = w;
    cachedH = h;
    const rng = mulberry32(0xb007beef);
    moonpath = [];
    for (let i = 0; i < 16; i++) {
      moonpath.push({
        dx: Math.floor((rng() - 0.5) * 14),
        dy: Math.floor(4 + rng() * 76),
        phase: rng() * Math.PI * 2,
      });
    }
  };

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

      // Moonpath glitter column directly below the moon (sky-layer renders moon at
      // (width * 0.18, height * 0.16)). Sits OVER scanlines as wave highlight, UNDER foam.
      ensureMoonpath(frame.width, frame.height);
      const moonX = Math.floor(frame.width * 0.18);
      ctx.fillStyle = HARBOR_PALETTE.moonlight;
      for (const g of moonpath) {
        const a = frame.reducedMotion
          ? 0.7
          : 0.4 + 0.6 * Math.abs(Math.sin(t * 0.8 + g.phase));
        ctx.globalAlpha = a;
        ctx.fillRect(moonX + g.dx, y0 + g.dy, 1, 1);
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
