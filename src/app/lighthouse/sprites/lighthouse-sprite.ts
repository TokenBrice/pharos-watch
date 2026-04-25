import { HARBOR_PALETTE } from "../systems/palette";

export const LIGHTHOUSE_GEOM = {
  base:    { w: 48, h: 24 },
  shaft:   { w: 36, h: 64 },
  gallery: { w: 44, h: 8  },
  lantern: { w: 32, h: 36 },
  cap:     { w: 36, h: 60 },
};

export interface LighthouseDrawState {
  beamRotationRad: number;
  beamColorHex: string;
  beamAlpha: number;
  lanternAlpha: number;
}

const BEAM_LEN = 300;
const BEAM_HALF_SPREAD = 70;

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
  ctx.fillRect(ax - 24, baseTop, 48, LIGHTHOUSE_GEOM.base.h);
  ctx.fillStyle = HARBOR_PALETTE.stone_mid;
  ctx.fillRect(ax - 24, baseTop, 48, 8);

  // Shaft — vertical stones, lit windows
  ctx.fillStyle = HARBOR_PALETTE.stone_mid;
  ctx.fillRect(ax - 18, shaftTop, 36, LIGHTHOUSE_GEOM.shaft.h);
  ctx.strokeStyle = HARBOR_PALETTE.stone_dark;
  ctx.lineWidth = 1;
  for (let y = shaftTop + 12; y < shaftTop + LIGHTHOUSE_GEOM.shaft.h; y += 12) {
    ctx.beginPath(); ctx.moveTo(ax - 18, y); ctx.lineTo(ax + 18, y); ctx.stroke();
  }
  ctx.fillStyle = HARBOR_PALETTE.lantern_warm;
  ctx.fillRect(ax - 2, shaftTop + 16, 4, 6);
  ctx.fillRect(ax - 2, shaftTop + 36, 4, 6);

  // Gallery deck
  ctx.fillStyle = HARBOR_PALETTE.iron_dark;
  ctx.fillRect(ax - 22, galleryTop, 44, LIGHTHOUSE_GEOM.gallery.h);

  // Lantern room — iron shell + warm interior + 4 fresnel pane lines
  ctx.fillStyle = HARBOR_PALETTE.iron_dark;
  ctx.fillRect(ax - 16, lanternTop, 32, LIGHTHOUSE_GEOM.lantern.h);
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = HARBOR_PALETTE.lantern_warm;
  ctx.fillRect(ax - 14, lanternTop + 2, 28, 32);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = HARBOR_PALETTE.iron_dark;
  for (let x = -14; x < 14; x += 8) {
    ctx.beginPath();
    ctx.moveTo(ax + x + 4, lanternTop + 2);
    ctx.lineTo(ax + x + 4, lanternTop + 34);
    ctx.stroke();
  }

  // Cap — triangular roof + weathervane
  ctx.fillStyle = HARBOR_PALETTE.stone_dark;
  ctx.beginPath();
  ctx.moveTo(ax - 18, capTop + 8);
  ctx.lineTo(ax,      capTop - 8);
  ctx.lineTo(ax + 18, capTop + 8);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = HARBOR_PALETTE.iron_dark;
  ctx.beginPath(); ctx.moveTo(ax, capTop - 8); ctx.lineTo(ax, capTop - 24); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(ax - 6, capTop - 20); ctx.lineTo(ax + 6, capTop - 20); ctx.stroke();

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
  ctx.beginPath(); ctx.arc(lanternCx, lanternCy, 8, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = HARBOR_PALETTE.lantern_warm;
  ctx.globalAlpha = 0.35 * s.lanternAlpha;
  ctx.beginPath(); ctx.arc(lanternCx, lanternCy, 16, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;
}
