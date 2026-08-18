import type { MechanismArchetype, VariantKind } from "@shared/types";

/**
 * Optional per-coin overrides applied on top of an archetype diagram.
 *
 * Returned from a separate `getCoinOverride(coinId)` helper (Wave 2C) and
 * passed via `MechanismDiagramOptions.override`. Both fields are optional;
 * missing entries fall back to the archetype's default copy.
 */
export interface CoinOverride {
  /** Synthetic delta-neutral implementation used by the dedicated diagram. */
  syntheticStrategy?: "perp-short" | "borrow-stake";
  /**
   * Optional per-step replacement of label/subtitle. Length should match the
   * archetype's step count (always 3 today). Entries may be sparse — only the
   * fields the caller wants to override need to be set.
   */
  steps?: ReadonlyArray<{ label?: string; subtitle?: string }>;
  /** Override the stress footnote for this specific coin. */
  stressFootnote?: string;
}

/**
 * Optional dispatch context for {@link mechanismDiagramFor}.
 *
 * Backwards-compatible: calling `mechanismDiagramFor(archetype, symbol)`
 * without options renders the plain archetype diagram exactly as before.
 */
export interface MechanismDiagramOptions {
  /** Coin-specific node hydration (label/subtitle overrides). */
  override?: CoinOverride;
  /**
   * Coin's `flags.navToken`. Splits the `tbill` archetype between NAV-accreting
   * fund shares and $1-pegged reserve-backed tokens; omit where no coin is in
   * hand (generic `/learn` rendering) to keep the archetype default.
   */
  navToken?: boolean | null;
  /** When true and {@link parentArchetype} is set, render the wrapper diagram. */
  isWrapper?: boolean;
  /** Parent stablecoin symbol (only meaningful when `isWrapper`). */
  parentSymbol?: string;
  /** Parent archetype, used to pick the inner diagram (only meaningful when `isWrapper`). */
  parentArchetype?: MechanismArchetype;
  /**
   * Parent coin's `flags.navToken`, for the wrapper diagram's parent panel. The
   * wrapper's own flag is not a substitute — three of the four tracked wrappers
   * over a `tbill` parent are NAV tokens whose parent is not.
   */
  parentNavToken?: boolean | null;
  /** Wrapper variant kind, controls the right-hand box copy. */
  variantKind?: VariantKind;
}
