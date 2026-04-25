import { HARBOR_PALETTE } from "../systems/palette";

export const LIGHTHOUSE_GEOM = {
  base:    { w: 24, h: 12 },
  shaft:   { w: 18, h: 32 },
  gallery: { w: 22, h: 4  },
  lantern: { w: 16, h: 18 },
  cap:     { w: 18, h: 30 },
};

export interface LighthouseDrawState {
  beamRotationRad: number;
  beamColorHex: string;
  beamAlpha: number;
  lanternAlpha: number;
}

const BEAM_LEN = 200;
const BEAM_HALF_SPREAD = 50;

/**
 * Draws the lighthouse sprite anchored at the waterline center (ax, ay).
 * The beam rotates around the lantern; the lantern halo sits on top of the cap.
 */
export function drawLighthouse(
  ctx: CanvasRenderingContext2D,
  ax: number,
  ay: number,
  s: LighthouseDrawState,
): void {
  const baseTop    = ay - LIGHTHOUSE_GEOM.base.h;
  const shaftTop   = baseTop - LIGHTHOUSE_GEOM.shaft.h;
  const galleryTop = shaftTop - LIGHTHOUSE_GEOM.gallery.h;
  const lanternTop = galleryTop - LIGHTHOUSE_GEOM.lantern.h;
  const capTop     = lanternTop - 4;

  // Base — stone block + lighter top stripe
  ctx.fillStyle = HARBOR_PALETTE.stone_dark;
  ctx.fillRect(ax - 12, baseTop, 24, LIGHTHOUSE_GEOM.base.h);
  ctx.fillStyle = HARBOR_PALETTE.stone_mid;
  ctx.fillRect(ax - 12, baseTop, 24, 4);

  // Shaft — vertical stones, lit windows
  ctx.fillStyle = HARBOR_PALETTE.stone_mid;
  ctx.fillRect(ax - 9, shaftTop, 18, LIGHTHOUSE_GEOM.shaft.h);
  ctx.strokeStyle = HARBOR_PALETTE.stone_dark;
  ctx.lineWidth = 1;
  for (let y = shaftTop + 6; y < shaftTop + LIGHTHOUSE_GEOM.shaft.h; y += 6) {
    ctx.beginPath(); ctx.moveTo(ax - 9, y); ctx.lineTo(ax + 9, y); ctx.stroke();
  }
  ctx.fillStyle = HARBOR_PALETTE.lantern_warm;
  ctx.fillRect(ax - 1, shaftTop + 8, 2, 3);
  ctx.fillRect(ax - 1, shaftTop + 18, 2, 3);

  // Gallery deck
  ctx.fillStyle = HARBOR_PALETTE.iron_dark;
  ctx.fillRect(ax - 11, galleryTop, 22, LIGHTHOUSE_GEOM.gallery.h);

  // Lantern room — iron shell + warm interior + 4 fresnel pane lines
  ctx.fillStyle = HARBOR_PALETTE.iron_dark;
  ctx.fillRect(ax - 8, lanternTop, 16, LIGHTHOUSE_GEOM.lantern.h);
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = HARBOR_PALETTE.lantern_warm;
  ctx.fillRect(ax - 7, lanternTop + 1, 14, 16);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = HARBOR_PALETTE.iron_dark;
  for (let x = -7; x < 7; x += 4) {
    ctx.beginPath();
    ctx.moveTo(ax + x + 2, lanternTop + 1);
    ctx.lineTo(ax + x + 2, lanternTop + 17);
    ctx.stroke();
  }

  // Cap — triangular roof + weathervane
  ctx.fillStyle = HARBOR_PALETTE.stone_dark;
  ctx.beginPath();
  ctx.moveTo(ax - 9, capTop + 4);
  ctx.lineTo(ax,     capTop - 4);
  ctx.lineTo(ax + 9, capTop + 4);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = HARBOR_PALETTE.iron_dark;
  ctx.beginPath(); ctx.moveTo(ax, capTop - 4); ctx.lineTo(ax, capTop - 12); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(ax - 3, capTop - 10); ctx.lineTo(ax + 3, capTop - 10); ctx.stroke();

  // Beam — rotated triangle around the lantern center; tweened by GSAP each frame
  const lanternCx = ax;
  const lanternCy = lanternTop + Math.floor(LIGHTHOUSE_GEOM.lantern.h / 2);
  ctx.save();
  ctx.translate(lanternCx, lanternCy);
  ctx.rotate(s.beamRotationRad);
  ctx.fillStyle = s.beamColorHex;
  ctx.globalAlpha = s.beamAlpha;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(BEAM_LEN, -BEAM_HALF_SPREAD);
  ctx.lineTo(BEAM_LEN, BEAM_HALF_SPREAD);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.restore();

  // Lantern halo (always upright; alpha tweened by GSAP at a different rhythm than the beam)
  ctx.fillStyle = HARBOR_PALETTE.lantern_glow;
  ctx.globalAlpha = s.lanternAlpha;
  ctx.beginPath(); ctx.arc(lanternCx, lanternCy, 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = HARBOR_PALETTE.lantern_warm;
  ctx.globalAlpha = 0.35 * s.lanternAlpha;
  ctx.beginPath(); ctx.arc(lanternCx, lanternCy, 8, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;
}
