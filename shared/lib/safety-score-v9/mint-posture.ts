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
    detail: "Minting depends on a concentrated or collateral-gated administrator path.",
  },
  exposed: {
    label: "Exposed",
    detail: "Economically effective minting is unbounded — unreconciled, unverified, or compromised.",
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

// MINT-LADDER 9.32 (2026-08-21): the finer postures reuse existing public
// bands, so filter values and screener URLs remain unchanged.
const POSTURE_BANDS: Record<V9MintPosture, V9MintPostureBand | null> = {
  "none-resolved": "hardened",
  "bounded-admin": "hardened",
  "partially-bounded-admin": "governed",
  "unbounded-reconciled": "managed",
  "concentrated-admin": "concentrated",
  "collateral-gated": "concentrated",
  "unbounded-reconciliation-unknown": "exposed",
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
 * Curated-only posture values V9 never derives, so they cannot live in
 * `POSTURE_BANDS` (which is keyed by the derived vocabulary). `none-resolved-mint`
 * is the mint-scoped sibling of `none-resolved` and states the same fact about
 * the mint path, so it shares the hardened band — which is also what makes a
 * mint-scoped annotation agree with V9's mint-scoped derivation.
 */
const CURATED_ONLY_POSTURE_BANDS: Partial<Record<MintAuthorityPosture, V9MintPostureBand>> = {
  "none-resolved-mint": "hardened",
};

/**
 * Project the curated `authorityPosture` annotation onto the derived posture
 * vocabulary. The curated field predates V9's split of unbounded minting into
 * reconciled and unreconciled rungs, so it can only ever claim the adverse
 * side; both derived rungs are accepted as agreement.
 */
export function curatedMintPostureBand(posture: MintAuthorityPosture | null | undefined): V9MintPostureBand | null {
  if (posture == null || posture === "unknown") return null;
  return CURATED_ONLY_POSTURE_BANDS[posture] ?? POSTURE_BANDS[posture as V9MintPosture] ?? null;
}

/*
 * ---------------------------------------------------------------------------
 * Posture predicates — the single source of mint-posture set membership.
 *
 * Every engine that asks a yes/no question about a mint posture asks it here,
 * so a vocabulary addition is handled once instead of falling through unnamed
 * literal comparisons at each call site. The vocabulary has grown repeatedly
 * (`unbounded-reconciled`, `none-resolved-mint`, and the 9.32 ladder values),
 * and each time the membership of these sets had to be re-derived by hand at
 * every site.
 *
 * The predicates take `string | null | undefined` rather than
 * `MintAuthorityPosture`: consumers such as the Depeg Duration Resolver carry
 * the posture as an opaque registry string, and an unrecognized value must
 * answer `false` to every predicate rather than fail to typecheck.
 * ---------------------------------------------------------------------------
 */

/**
 * Postures asserting that *this asset* has no privileged mint path. Scope
 * differs between the two members and callers must choose deliberately:
 * `none-resolved` is whole-of-chain (nothing anywhere on the mint path can
 * print, and for a wrapper only when the parent is itself `none-resolved`),
 * while `none-resolved-mint` is mint-scoped to this asset and leaves the
 * parent's own mint authority untouched. Use this predicate when the question
 * is "can a privileged party mint *this token* directly"; use
 * `isNoPrivilegedMintChainPosture` when the question is "can this claim be
 * inflated at all".
 */
const NO_PRIVILEGED_MINT_POSTURES: ReadonlySet<string> = new Set<MintAuthorityPosture>([
  "none-resolved",
  "none-resolved-mint",
]);

/** Whole-of-chain non-inflatability — the strict subset of the above. */
const NO_PRIVILEGED_MINT_CHAIN_POSTURES: ReadonlySet<string> = new Set<MintAuthorityPosture>(["none-resolved"]);

/**
 * Postures whose minter can expand the claim at will. `unbounded-reconciled` is
 * a supervisory refinement *within* the unbounded class, not an exit from it:
 * reconciliation is after-the-fact evidence rather than a bound, so it belongs
 * to the adverse set exactly like `unbounded-or-compromised`. Adopting the finer
 * curated vocabulary must never relax a verdict.
 */
const FRAGILE_MINT_POSTURES: ReadonlySet<string> = new Set<MintAuthorityPosture>([
  "concentrated-admin",
  "collateral-gated",
  "unbounded-reconciled",
  "unbounded-reconciliation-unknown",
  "unbounded-or-compromised",
]);

/**
 * The *economically unbounded* rungs — the strict subset of the fragile set that
 * can print without limit during a live event. A merely concentrated admin is
 * fragile but not unbounded.
 */
const UNBOUNDED_MINT_POSTURES: ReadonlySet<string> = new Set<MintAuthorityPosture>([
  "unbounded-reconciled",
  "unbounded-reconciliation-unknown",
  "unbounded-or-compromised",
]);

/** True when no privileged party can mint this asset directly (either scope). */
export function isNoPrivilegedMintPosture(posture: string | null | undefined): boolean {
  return posture != null && NO_PRIVILEGED_MINT_POSTURES.has(posture);
}

/** True only for the whole-of-chain finding: the claim cannot be inflated anywhere. */
export function isNoPrivilegedMintChainPosture(posture: string | null | undefined): boolean {
  return posture != null && NO_PRIVILEGED_MINT_CHAIN_POSTURES.has(posture);
}

/** True when the minter is concentrated or economically unbounded. */
export function isFragileMintPosture(posture: string | null | undefined): boolean {
  return posture != null && FRAGILE_MINT_POSTURES.has(posture);
}

/** True when minting is economically unbounded, reconciled or not. */
export function isUnboundedMintPosture(posture: string | null | undefined): boolean {
  return posture != null && UNBOUNDED_MINT_POSTURES.has(posture);
}
