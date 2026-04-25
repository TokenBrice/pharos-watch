import { HARBOR_PALETTE } from "../systems/palette";
import type { BoatStyle } from "../systems/classification-to-boat";

export const BOAT_DIMENSIONS: Record<BoatStyle, { S: { w: number; h: number }; L: { w: number; h: number } }> = {
  galleon:    { S: { w: 14, h: 20 }, L: { w: 22, h: 30 } },
  brigantine: { S: { w: 13, h: 18 }, L: { w: 20, h: 28 } },
  schooner:   { S: { w: 12, h: 16 }, L: { w: 18, h: 24 } },
  junk:       { S: { w: 13, h: 18 }, L: { w: 20, h: 28 } },
};

export interface BoatDrawProps {
  style: BoatStyle;
  size: "S" | "L";
  pennantHex: string;
  /** When non-null, paints a glowing aura disc beneath the hull (peg-health signal). */
  auraHex: string | null;
}

export const BOAT_SCALE = 2;

/** Draws a boat anchored at the hull base center (ax, ay). */
export function drawBoat(ctx: CanvasRenderingContext2D, ax: number, ay: number, p: BoatDrawProps): void {
  ctx.save();
  ctx.translate(ax, ay);
  ctx.scale(BOAT_SCALE, BOAT_SCALE);
  const dim = BOAT_DIMENSIONS[p.style][p.size];
  const halfW = dim.w / 2;
  // Local coords: x=0 is boat center; y=0 is hull base. Helpers reframed against (0,0).
  const lx = (x: number) => x;
  const ly = (y: number) => y - dim.h;

  // Aura
  if (p.auraHex) {
    ctx.fillStyle = p.auraHex;
    ctx.globalAlpha = 0.22;
    ctx.beginPath();
    ctx.arc(0, -4, halfW + 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Hull (per-style polygon)
  switch (p.style) {
    case "galleon":
      ctx.fillStyle = HARBOR_PALETTE.timber_warm;
      polyFill(ctx, [
        lx(-halfW), ly(dim.h - 4),
        lx(-halfW + 2), ly(dim.h),
        lx(halfW - 2), ly(dim.h),
        lx(halfW), ly(dim.h - 4),
        lx(halfW - 1), ly(dim.h - 8),
        lx(-halfW + 1), ly(dim.h - 8),
      ]);
      ctx.fillStyle = HARBOR_PALETTE.timber_dark;
      ctx.fillRect(lx(-halfW + 1), ly(dim.h - 11), 5, 4);
      ctx.fillStyle = HARBOR_PALETTE.lantern_warm;
      ctx.beginPath(); ctx.arc(lx(-halfW + 3), ly(dim.h - 12), 1, 0, Math.PI * 2); ctx.fill();
      break;
    case "brigantine":
      ctx.fillStyle = HARBOR_PALETTE.timber_mid;
      polyFill(ctx, [
        lx(-halfW + 1), ly(dim.h - 3),
        lx(-halfW + 2), ly(dim.h),
        lx(halfW - 2), ly(dim.h),
        lx(halfW), ly(dim.h - 4),
        lx(halfW - 1), ly(dim.h - 7),
        lx(-halfW), ly(dim.h - 8),
      ]);
      break;
    case "schooner":
      ctx.fillStyle = HARBOR_PALETTE.timber_mid;
      polyFill(ctx, [
        lx(-halfW), ly(dim.h - 2),
        lx(-halfW + 1), ly(dim.h),
        lx(halfW - 1), ly(dim.h),
        lx(halfW), ly(dim.h - 3),
        lx(halfW - 1), ly(dim.h - 6),
        lx(-halfW + 1), ly(dim.h - 6),
      ]);
      break;
    case "junk":
      ctx.fillStyle = HARBOR_PALETTE.timber_dark;
      polyFill(ctx, [
        lx(-halfW), ly(dim.h - 6),
        lx(-halfW + 1), ly(dim.h - 1),
        lx(halfW - 1), ly(dim.h - 1),
        lx(halfW), ly(dim.h - 6),
        lx(halfW - 2), ly(dim.h - 9),
        lx(-halfW + 2), ly(dim.h - 9),
      ]);
      break;
  }

  // Masts + sails
  ctx.strokeStyle = HARBOR_PALETTE.iron_dark;
  ctx.lineWidth = 1;
  if (p.style === "galleon") {
    for (const mx of [-4, 0, 4]) {
      strokeLine(ctx, lx(mx), ly(dim.h - 8), lx(mx), ly(2));
      ctx.fillStyle = HARBOR_PALETTE.foam_white;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(lx(mx - 3), ly(4), 6, 10);
      ctx.globalAlpha = 1;
    }
  } else if (p.style === "brigantine") {
    strokeLine(ctx, lx(-2), ly(dim.h - 7), lx(-2), ly(2));
    ctx.fillStyle = HARBOR_PALETTE.foam_white;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(lx(-5), ly(4), 6, 10);
    strokeLine(ctx, lx(3), ly(dim.h - 7), lx(3), ly(4));
    polyFill(ctx, [lx(3), ly(4), lx(7), ly(12), lx(3), ly(12)]);
    ctx.globalAlpha = 1;
  } else if (p.style === "schooner") {
    const slant = 1;
    strokeLine(ctx, lx(-1 - slant), ly(dim.h - 6), lx(-1), ly(2));
    ctx.fillStyle = HARBOR_PALETTE.sail_teal;
    ctx.globalAlpha = 0.9;
    polyFill(ctx, [lx(-1), ly(2), lx(-5), ly(12), lx(-1), ly(12)]);
    strokeLine(ctx, lx(3 - slant), ly(dim.h - 6), lx(3), ly(4));
    polyFill(ctx, [lx(3), ly(4), lx(7), ly(12), lx(3), ly(12)]);
    ctx.globalAlpha = 1;
  } else if (p.style === "junk") {
    strokeLine(ctx, lx(0), ly(dim.h - 9), lx(0), ly(1));
    ctx.fillStyle = HARBOR_PALETTE.sail_red;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(lx(-5), ly(3), 10, 12);
    ctx.globalAlpha = 1;
    for (let y = 6; y < 14; y += 3) strokeLine(ctx, lx(-5), ly(y), lx(5), ly(y));
  }

  // Pennant — small flag at top of foremast, color from peg-health THREAT_BAND_HEX
  ctx.fillStyle = p.pennantHex;
  ctx.fillRect(lx(2), ly(0), 3, 2);

  ctx.restore();
}

function polyFill(ctx: CanvasRenderingContext2D, pts: number[]): void {
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.closePath();
  ctx.fill();
}

function strokeLine(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
}
