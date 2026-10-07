/**
 * Optional per-coin overrides applied on top of an archetype diagram.
 *
 * Returned from `getCoinOverride(coinId)` and applied by
 * `resolveMechanismFlowTemplate`. Every field is optional; missing entries
 * fall back to the archetype's default copy.
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
  /**
   * Override the stress footnote for this specific coin, e.g. to name the
   * coin's own dated incident. Archetype footnotes name no coin, so this is
   * the only place a coin name may enter a coin page's stress line.
   */
  stressFootnote?: string;
}

/**
 * Coin-level facts that pick a copy variant inside one archetype. A caller
 * that holds a coin always passes an object, even an empty one: family-level
 * claims the coin's own data cannot support (a quarterly redemption gate, a
 * liquidation engine the review ruled out) are then withheld. Only generic
 * archetype renders (`/learn`, the OG images) pass nothing and keep the
 * family description.
 */
export interface MechanismTemplateFacts {
  /** Coin's `flags.navToken`; `false` switches `tbill` to the par-redemption copy. */
  navToken?: boolean | null;
  /**
   * `false` when the reviewed mechanism rules out a liquidation engine (see
   * `deriveLiquidationEngine`); switches `cdp` to the reserve copy. `null`
   * keeps the archetype's liquidation copy.
   */
  liquidationEngine?: boolean | null;
}
