import { HARBOR_PALETTE } from "../systems/palette";
import type { DrawableLayer, FrameState } from "../systems/scene-render";
import { mulberry32 } from "../systems/rng";

interface Star {
  x: number;
  y: number;
  alpha: number;
}

export function buildSkyLayer(): DrawableLayer {
  let cachedW = 0;
  let cachedH = 0;
  let stars: Star[] = [];

  const ensureStars = (w: number, h: number) => {
    if (w === cachedW && h === cachedH) return;
    cachedW = w;
    cachedH = h;
    const rng = mulberry32(0xcafef00d);
    stars = [];
    for (let i = 0; i < 70; i++) {
      stars.push({
        x: Math.floor(rng() * w),
        y: Math.floor(rng() * h * 0.55),
        alpha: 0.5 + rng() * 0.5,
      });
    }
  };

  return {
    draw(ctx, frame: FrameState) {
      ensureStars(frame.width, frame.height);
      // Eight gradient bands
      const stops = [
        HARBOR_PALETTE.sky_night,
        HARBOR_PALETTE.sky_night,
        HARBOR_PALETTE.sky_night,
        HARBOR_PALETTE.sky_horizon,
        HARBOR_PALETTE.sky_horizon,
        HARBOR_PALETTE.fog_blue,
        HARBOR_PALETTE.fog_blue,
        HARBOR_PALETTE.fog_pale,
      ];
      const bandH = Math.ceil(frame.height / stops.length);
      for (let i = 0; i < stops.length; i++) {
        ctx.fillStyle = stops[i];
        ctx.fillRect(0, i * bandH, frame.width, bandH);
      }
      // Stars
      ctx.fillStyle = HARBOR_PALETTE.moonlight;
      for (const s of stars) {
        ctx.globalAlpha = s.alpha;
        ctx.fillRect(s.x, s.y, 1, 1);
      }
      ctx.globalAlpha = 1;
      // Moon
      const mx = Math.floor(frame.width * 0.18);
      const my = Math.floor(frame.height * 0.16);
      ctx.fillStyle = HARBOR_PALETTE.moonlight;
      ctx.beginPath();
      ctx.arc(mx, my, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = HARBOR_PALETTE.lantern_glow;
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.arc(mx - 3, my - 3, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    },
  };
}
