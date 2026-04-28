import { HARBOR_PALETTE } from "../systems/palette";
import type { DrawableLayer, FrameState } from "../systems/scene-render";
import { mulberry32 } from "../systems/rng";

interface Star {
  x: number;
  y: number;
  size: 1 | 2;
  baseAlpha: number;
  twinkle: boolean;
  phase: number;
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
    // Density-scaled count: roughly 1 star per 3500 px² in the upper 55% of the canvas.
    const starCount = Math.max(40, Math.floor((w * h * 0.55) / 3500));
    for (let i = 0; i < starCount; i++) {
      const tier = rng();
      const size: 1 | 2 = tier > 0.95 ? 2 : 1; // 5% hero stars
      const baseAlpha = tier > 0.7 ? 0.85 : 0.45 + rng() * 0.3;
      const twinkle = rng() < 0.12; // 12% twinkle
      const phase = rng() * Math.PI * 2;
      stars.push({
        x: Math.floor(rng() * w),
        y: Math.floor(rng() * h * 0.55),
        size,
        baseAlpha,
        twinkle,
        phase,
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
      const t = frame.reducedMotion ? 0 : frame.t;
      for (const s of stars) {
        const a = s.twinkle
          ? s.baseAlpha * (0.6 + 0.4 * Math.sin(t * 1.5 + s.phase))
          : s.baseAlpha;
        ctx.globalAlpha = a;
        ctx.fillRect(s.x, s.y, s.size, s.size);
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
