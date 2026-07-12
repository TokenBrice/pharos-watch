import { CLIENT_TRACKED_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import { isPreLaunchStablecoinMeta } from "@shared/lib/stablecoins/status";
import type { LaunchPhase } from "@shared/types";
import type { StablecoinClientMeta } from "@shared/types/stablecoin-client-meta";
import { dateScore } from "@/lib/pre-launch";

export type HorizonPreLaunchCoin = StablecoinClientMeta & { launchPhase: LaunchPhase };

export const HORIZON_PHASE_ORDER: readonly LaunchPhase[] = [
  "announced",
  "testnet",
  "auditing",
  "beta",
  "launching-soon",
];

export const HORIZON_PHASE_SHORT_LABELS: Record<LaunchPhase, string> = {
  announced: "Announced",
  testnet: "Testnet",
  auditing: "Auditing",
  beta: "Beta",
  "launching-soon": "Launching",
};

export const HORIZON_PHASE_FIELD_CLASSES: Record<LaunchPhase, string> = {
  announced: "border-amber-500/35 bg-amber-500/[0.05] dark:border-amber-400/35 dark:bg-amber-400/[0.07]",
  testnet: "border-indigo-500/35 bg-indigo-500/[0.05] dark:border-indigo-400/35 dark:bg-indigo-400/[0.07]",
  auditing: "border-violet-500/35 bg-violet-500/[0.05] dark:border-violet-400/35 dark:bg-violet-400/[0.07]",
  beta: "border-emerald-500/35 bg-emerald-500/[0.05] dark:border-emerald-400/35 dark:bg-emerald-400/[0.07]",
  "launching-soon": "border-sky-500/45 bg-sky-500/[0.07] dark:border-sky-400/45 dark:bg-sky-400/[0.09]",
};

export interface HorizonPoint {
  x: number;
  y: number;
}

export interface HorizonPackedDots {
  pts: HorizonPoint[];
  /** Field radius (cluster extent + breathing room). */
  fieldR: number;
}

export interface HorizonPhaseLayout extends HorizonPackedDots {
  /** Coins beyond the visible dots, summarised by a "+N" pill (0 when all fit). */
  hidden: number;
}

export const HORIZON_CONSTELLATION_LAYOUT = {
  dot: 22,
  dotSpacing: 30,
  pad: 12,
  logoInner: 18,
  minFieldRadius: 58,
  countFieldScale: 7,
  maxFieldRadius: 92,
  maxDots: 12,
  overflowRing: 8,
  narrowLaneDots: 8,
} as const;

export const HORIZON_PRE_LAUNCH_STABLECOINS = CLIENT_TRACKED_STABLECOINS.filter(
  (coin): coin is HorizonPreLaunchCoin => isPreLaunchStablecoinMeta(coin) && Boolean(coin.launchPhase),
);

export const HORIZON_COINS_BY_PHASE = HORIZON_PHASE_ORDER.map((phase) =>
  HORIZON_PRE_LAUNCH_STABLECOINS.filter((coin) => coin.launchPhase === phase).sort(
    (a, b) => dateScore(a.expectedLaunchDate) - dateScore(b.expectedLaunchDate),
  ),
);

// Pack dots into a circular cluster centered on (0, 0). Up to 6 form a single
// polygon ring; 7+ get a center dot wrapped by concentric rings.
function packHorizonDots(count: number): HorizonPackedDots {
  const { dot, dotSpacing, pad } = HORIZON_CONSTELLATION_LAYOUT;
  if (count <= 0) return { pts: [], fieldR: dotSpacing * 0.7 };
  if (count === 1) return { pts: [{ x: 0, y: 0 }], fieldR: dot / 2 + pad };
  if (count <= 6) {
    const r = dotSpacing / (2 * Math.sin(Math.PI / count));
    const pts = Array.from({ length: count }, (_, k) => {
      const a = (k / count) * 2 * Math.PI - Math.PI / 2;
      return { x: Math.cos(a) * r, y: Math.sin(a) * r };
    });
    return { pts, fieldR: r + dot / 2 + pad };
  }

  const pts = [{ x: 0, y: 0 }];
  let rem = count - 1;
  let ring = 1;
  let lastR = 0;
  while (rem > 0) {
    const r = ring * dotSpacing;
    const cap = Math.max(1, Math.round((2 * Math.PI * r) / dotSpacing));
    const cnt = Math.min(cap, rem);
    for (let k = 0; k < cnt; k++) {
      // Offset each ring's start so outer dots nest between inner ones.
      const a = (k / cnt) * 2 * Math.PI - Math.PI / 2 + ring * 0.4;
      pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
    }
    lastR = r;
    rem -= cnt;
    ring++;
  }
  return { pts, fieldR: lastR + dot / 2 + pad };
}

export function layoutHorizonPhase(count: number): HorizonPhaseLayout {
  const { dot, dotSpacing, maxDots, overflowRing, pad } = HORIZON_CONSTELLATION_LAYOUT;
  if (count <= maxDots) {
    const { pts, fieldR } = packHorizonDots(count);
    return { pts, fieldR, hidden: 0 };
  }

  const r = dotSpacing / (2 * Math.sin(Math.PI / overflowRing));
  const pts = Array.from({ length: overflowRing }, (_, k) => {
    const a = (k / overflowRing) * 2 * Math.PI - Math.PI / 2;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  });
  return { pts, fieldR: r + dot / 2 + pad, hidden: count - overflowRing };
}

export const HORIZON_PHASE_LAYOUTS = HORIZON_COINS_BY_PHASE.map((coins) => layoutHorizonPhase(coins.length));

function phaseFieldRadius(count: number, layout: HorizonPhaseLayout): number {
  const { countFieldScale, maxFieldRadius, minFieldRadius } = HORIZON_CONSTELLATION_LAYOUT;
  if (count <= 0) return Math.max(layout.fieldR, minFieldRadius);
  const countRadius = minFieldRadius + Math.sqrt(count) * countFieldScale;
  return Math.min(maxFieldRadius, Math.max(layout.fieldR, countRadius));
}

export function phaseRingSize(count: number, layout: HorizonPhaseLayout): number {
  return phaseFieldRadius(count, layout) * 2;
}
