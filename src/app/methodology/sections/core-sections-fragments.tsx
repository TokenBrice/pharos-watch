export function CollateralQualityMethodologyCopy() {
  return (
    <p>
      Collateral quality is derived from reserve compositions when available &mdash; curated metadata by
      default, or a fresh authoritative independent live reserve snapshot for coins covered by the live
      reserve sync. For report-card scoring, that live snapshot must also carry scoring-eligible freshness
      evidence: either a verified timestamp path or an explicit on-chain latest-state{" "}
      <code className="text-xs bg-muted px-1 py-0.5 rounded">not-applicable</code> freshness mode.
      Detail-only <code className="text-xs bg-muted px-1 py-0.5 rounded">static-validated</code> and{" "}
      <code className="text-xs bg-muted px-1 py-0.5 rounded">weak-live-probe</code> feeds remain visible
      on reserve surfaces, but they never override curated collateral scoring.
      Each reserve slice is classified into one of five risk tiers and the score is their weighted average.
      Direct ETH and canonical WETH slices share the same Very Low tier, while ETH liquid staking tokens
      remain Low. For coins without usable reserve compositions, a coarser enum-based fallback is used.
      Explicit overrides exist for coins where defaults are incorrect (e.g., protocols on Solana, coins
      with CEX custody).
    </p>
  );
}
