import { HARBOR_PALETTE } from "../systems/palette";
import { PEG_CHART_COLORS } from "@shared/lib/classification";
import { mulberry32 } from "../systems/rng";
import type { DrawableLayer, FrameState } from "../systems/scene-render";
import type { SceneHorizonCohort } from "../systems/scene-data";

interface CohortPlacement {
  cohort: SceneHorizonCohort;
  x: number; // canvas x, top-left of silhouette
  silhouetteW: number;
  silhouetteH: number;
  jitterY: number;
  pennantHex: string;
}

export function buildHorizonLayer(): DrawableLayer {
  let cachedW = 0;
  let cachedH = 0;
  let cachedCohortIds: string[] = [];
  let placements: CohortPlacement[] = [];

  const ensurePlacements = (frame: FrameState) => {
    const cohorts = frame.scene.horizon.cohorts;
    const ids = cohorts.map((c) => c.id);
    const sameSet =
      ids.length === cachedCohortIds.length && ids.every((id, i) => id === cachedCohortIds[i]);
    if (sameSet && frame.width === cachedW && frame.height === cachedH) return;
    cachedW = frame.width;
    cachedH = frame.height;
    cachedCohortIds = ids;
    const sorted = cohorts.slice().sort((a, b) => b.coinCount - a.coinCount);
    const xMin = frame.width * 0.35;
    const xMax = frame.width * 0.95;
    const usable = Math.max(0, xMax - xMin);
    const rng = mulberry32(0xa17e7e57);
    placements = sorted.map((cohort, i) => {
      const slot = sorted.length > 1 ? i / (sorted.length - 1) : 0.5;
      const baseX = xMin + slot * usable;
      const jitterX = (rng() - 0.5) * 24;
      const jitterY = Math.floor((rng() - 0.5) * 4);
      const silhouetteW = 24 + Math.min(20, cohort.coinCount * 2);
      const silhouetteH = 8 + Math.min(6, Math.floor(cohort.coinCount / 2));
      const pegLookup = (PEG_CHART_COLORS as Record<string, { hex: string } | undefined>)[
        cohort.pegType
      ];
      const pennantHex = pegLookup?.hex ?? HARBOR_PALETTE.fog_pale;
      return {
        cohort,
        x: Math.floor(baseX + jitterX),
        silhouetteW,
        silhouetteH,
        jitterY,
        pennantHex,
      };
    });
  };

  return {
    draw(ctx, frame: FrameState) {
      ensurePlacements(frame);
      if (placements.length === 0) return;
      const y0 = Math.floor(frame.height * 0.45);
      ctx.fillStyle = HARBOR_PALETTE.fog_blue;
      for (const p of placements) {
        // Trapezoid silhouette: top is silhouetteW-4 wide, base is silhouetteW
        const top = y0 - p.silhouetteH + p.jitterY;
        const baseY = y0 + p.jitterY;
        ctx.beginPath();
        ctx.moveTo(p.x + 2, top);
        ctx.lineTo(p.x + p.silhouetteW - 2, top);
        ctx.lineTo(p.x + p.silhouetteW, baseY);
        ctx.lineTo(p.x, baseY);
        ctx.closePath();
        ctx.fill();
      }
      // Pennants — small 2px-wide, 3px-tall flag at top center of each silhouette
      for (const p of placements) {
        const top = y0 - p.silhouetteH + p.jitterY;
        const flagX = p.x + Math.floor(p.silhouetteW / 2);
        ctx.fillStyle = p.pennantHex;
        ctx.fillRect(flagX, top - 4, 2, 3);
        // Flag pole
        ctx.fillStyle = HARBOR_PALETTE.iron_dark;
        ctx.fillRect(flagX, top - 4, 1, p.silhouetteH + 4);
      }
    },
  };
}
