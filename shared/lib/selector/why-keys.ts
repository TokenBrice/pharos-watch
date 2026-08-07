/**
 * Canonical why-key vocabulary, grouped by profile applicability.
 *
 * Engine emits these keys; editorial layer reads `whyKeysByProfile` to author
 * prose templates. CI test asserts every emitted key has a non-fallback
 * template entry.
 *
 * Binding: `agents/impl-plan-drafts/02-engine.md` §8.
 */
import type { SelectorProfile, WhyKey } from "./types";
import { WHY_KEYS } from "./types";

export { WHY_KEYS };

/**
 * Set used by the engine to validate emitted keys against the canonical
 * vocabulary in dev. CI guarantees no unrecognized string is emitted.
 */
export const WHY_KEYS_SET: ReadonlySet<WhyKey> = new Set(WHY_KEYS);

/**
 * Per-profile applicability. The engine evaluates only the keys listed here
 * for the given profile, in declaration order.
 *
 * `low-dependency-risk` left the Treasury list at `selector-v2.0`: it graded a
 * dependency scalar the Selector re-derived from V9's raw graph, and that
 * re-derivation is gone. `WHY_KEYS` still lists the key so stored snapshots
 * that recorded it stay readable and renderable.
 */
export const whyKeysByProfile: Readonly<Record<SelectorProfile, readonly WhyKey[]>> = {
  treasury: [
    "top-safety",
    "strong-bluechip",
    "low-dews",
    "clean-peg-history",
    "strong-resilience",
    "wide-chain-presence",
    "recent-listing",
    "regulated-custody",
    "dao-governance",
    "long-tracking-span",
  ],
  yield: [
    "top-safety",
    "strong-bluechip",
    "low-dews",
    "clean-peg-history",
    "strong-resilience",
    "recent-listing",
    "top-pys",
    "yield-above-benchmark",
    "low-variance",
    "clean-yield-source",
    "native-wrapper-rail",
    "yield-source-recently-switched",
    "liquid-on-multiple-chains",
  ],
  trading: [
    "top-safety",
    "low-dews",
    "clean-peg-history",
    "strong-resilience",
    "wide-chain-presence",
    "recent-listing",
    "deepest-liquidity",
    "multi-dex-presence",
    "tight-peg",
    "low-stress",
    "strong-exit",
  ],
};
