import type { MintAuthorityPosture } from "../../types/core";
import type { V9MintPosture } from "./control";

/**
 * Public band vocabulary for the published V9 mint component.
 *
 * Safety 9.1 retired the standalone Mint Authority Score, whose 80/65/50/35
 * score cutoffs were calibrated on a composite this pillar does not compute.
 * The band is therefore derived from the published *posture* rather than from
 * the component score: the posture is the classification, and the score is the
 * graded quality inside it. Deriving from the posture also keeps the band
 * stable when a bounded credit or penalty moves the score by a point or two.
 *
 * The five band keys and labels are unchanged so screener filters, CSV columns,
 * coverage buckets and saved screener URLs keep working across the cutover.
 */
export type V9MintPostureBand = "hardened" | "governed" | "managed" | "concentrated" | "exposed";

export const V9_MINT_POSTURE_BANDS: Record<V9MintPostureBand, { label: string; detail: string }> = {
  hardened: {
    label: "Hardened",
    detail: "No live mint authority, or a bounded administrator that cannot expand the claim.",
  },
  governed: {
    label: "Governed",
    detail: "A partially bounded administrator: the claim is constrained but the cap can move.",
  },
  managed: {
    label: "Managed",
    detail: "Economically unbounded minting that is reconciled against reserves or a supervisory regime.",
  },
  concentrated: {
    label: "Concentrated",
    detail: "Minting depends on one concentrated administrator path.",
  },
  exposed: {
    label: "Exposed",
    detail: "Economically effective minting is unbounded or compromised.",
  },
};

/** Band order, strongest first — the render and sort order for every surface. */
export const V9_MINT_POSTURE_BAND_ORDER = [
  "hardened",
  "governed",
  "managed",
  "concentrated",
  "exposed",
] as const satisfies readonly V9MintPostureBand[];

const POSTURE_BANDS: Record<V9MintPosture, V9MintPostureBand | null> = {
  "none-resolved": "hardened",
  "bounded-admin": "hardened",
  "partially-bounded-admin": "governed",
  "unbounded-reconciled": "managed",
  "concentrated-admin": "concentrated",
  "unbounded-or-compromised": "exposed",
  // An unresolved posture is not a band: it is the absence of a review.
  unknown: null,
};

/**
 * Band for a published mint posture. Returns null for `unknown` and for any
 * posture string the publication carries that this build does not recognize —
 * both render as NR rather than being forced into a band.
 */
export function resolveV9MintPostureBand(posture: string | null | undefined): V9MintPostureBand | null {
  if (posture == null) return null;
  return POSTURE_BANDS[posture as V9MintPosture] ?? null;
}

/**
 * Project the curated `authorityPosture` annotation onto the derived posture
 * vocabulary. The curated field predates V9's split of unbounded minting into
 * reconciled and unreconciled rungs, so it can only ever claim the adverse
 * side; both derived rungs are accepted as agreement.
 */
export function curatedMintPostureBand(posture: MintAuthorityPosture | null | undefined): V9MintPostureBand | null {
  if (posture == null || posture === "unknown") return null;
  return POSTURE_BANDS[posture as V9MintPosture] ?? null;
}
