import type { MintAuthorityPosture } from "../../types/core";
import type { V9MintPosture } from "./control-primitives";

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


/** Band order, strongest first — the render and sort order for every surface. */
export const V9_MINT_POSTURE_BAND_ORDER = [
  "hardened",
  "governed",
  "managed",
  "concentrated",
  "exposed",
] as const satisfies readonly V9MintPostureBand[];

// D29/D30/H governance process rungs reuse the governed public band;
// filter values and screener URLs remain unchanged.
const POSTURE_BANDS: Record<V9MintPosture, V9MintPostureBand | null> = {
  "none-resolved": "hardened",
  "bounded-admin": "hardened",
  "partially-bounded-admin": "governed",
  "unbounded-governed": "governed",
  "unbounded-veto-guarded": "governed",
  "unbounded-operationally-governed": "governed",
  "unbounded-reconciled": "managed",
  "concentrated-admin": "concentrated",
  "collateral-gated": "concentrated",
  "unbounded-adverse": "exposed",
  compromised: "exposed",
  // An unresolved posture is not a band: it is the absence of a review.
  unknown: null,
};

/**
 * Band for a published mint posture. Returns null for `unknown` and for any
 * posture string the publication carries that this build does not recognize —
 * both render as NR rather than being forced into a band.
 */
export function resolveV9MintPostureBand(posture: string | null | undefined): V9MintPostureBand | null {
  if (posture == null || !Object.prototype.hasOwnProperty.call(POSTURE_BANDS, posture)) return null;
  return POSTURE_BANDS[posture as V9MintPosture];
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
 * Project the curated `authorityPosture` annotation onto the public band.
 * Curated and derived postures share the same band map except for the
 * curated-only mint-scoped `none-resolved-mint` value.
 */
export function curatedMintPostureBand(posture: MintAuthorityPosture | null | undefined): V9MintPostureBand | null {
  if (posture == null || posture === "unknown") return null;
  if (Object.prototype.hasOwnProperty.call(CURATED_ONLY_POSTURE_BANDS, posture)) {
    return CURATED_ONLY_POSTURE_BANDS[posture] ?? null;
  }
  return Object.prototype.hasOwnProperty.call(POSTURE_BANDS, posture)
    ? POSTURE_BANDS[posture as V9MintPosture]
    : null;
}

/*
 * ---------------------------------------------------------------------------
 * Posture predicates — the single source of mint-posture set membership.
 *
 * Every engine that asks a yes/no question about a mint posture asks it here,
 * so a vocabulary addition is handled once instead of falling through unnamed
 * literal comparisons at each call site. The vocabulary has grown repeatedly
 * (`unbounded-reconciled`, `none-resolved-mint`, the 9.32 ladder values, and
 * D29's governed issuance and D30's minority veto), so explicit membership must preserve each
 * consumer's economic meaning across classification refinements.
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
 * Concentrated or economically unbounded minters remain fragile for DDR.
 * Reconciliation and delayed token governance refine the Safety Score rung,
 * not the economic issuance bound; active incidents remain adverse too.
 * These refinements must never relax a DDR verdict.
 */
const FRAGILE_MINT_POSTURES: ReadonlySet<string> = new Set<MintAuthorityPosture>([
  "concentrated-admin",
  "collateral-gated",
  "unbounded-reconciled",
  "unbounded-governed",
  "unbounded-veto-guarded",
  "unbounded-operationally-governed",
  "unbounded-adverse",
  "compromised",
]);

/**
 * The economically unbounded subset of the fragile set. Reconciliation and
 * governance delay do not impose an issuance limit; a merely concentrated
 * administrator is fragile but not unbounded.
 */
const UNBOUNDED_MINT_POSTURES: ReadonlySet<string> = new Set<MintAuthorityPosture>([
  "unbounded-reconciled",
  "unbounded-governed",
  "unbounded-veto-guarded",
  "unbounded-operationally-governed",
  "unbounded-adverse",
  "compromised",
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

/** True when minting is economically unbounded, including governance-delayed issuance. */
export function isUnboundedMintPosture(posture: string | null | undefined): boolean {
  return posture != null && UNBOUNDED_MINT_POSTURES.has(posture);
}
