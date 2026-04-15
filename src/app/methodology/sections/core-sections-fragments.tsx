export function CollateralQualityMethodologyCopy() {
  return (
    <p>
      Collateral quality is derived from reserve compositions when available. The default source is curated
      metadata. A live reserve snapshot replaces it only when the current report-card snapshot can prove the
      feed is fresh, authoritative, independent, and clean. In coverage tables this is the difference between
      a reserve view being configured and a score-grade live reserve actually being used. For report-card
      scoring, the live snapshot must carry scoring-eligible freshness evidence: either a verified timestamp
      path or an explicit on-chain latest-state{" "}
      <code className="text-xs bg-muted px-1 py-0.5 rounded">not-applicable</code> freshness mode.
      Direct one-bucket on-chain reserve proofs such as Liquity v1 can qualify when the adapter is
      classified as independent, but weak probe families do not qualify just because they are on-chain.
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

export function ReserveRelatedSignalsMethodologyCopy() {
  return (
    <div className="space-y-2">
      <h3 className="text-foreground font-medium">Three Reserve-Related Signals</h3>
      <p>These labels are easy to conflate. They do different jobs, and only two can affect the Safety Score.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th scope="col" className="py-2 pr-4 font-medium text-foreground">Signal</th>
              <th scope="col" className="py-2 pr-4 font-medium text-foreground">What it means</th>
              <th scope="col" className="py-2 font-medium text-foreground">Score use</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            <tr className="hover:bg-muted/40 transition-colors">
              <td className="py-2 pr-4 text-foreground">Reserve view</td>
              <td className="py-2 pr-4">A detail-page reserve display exists: live, curated-validated, proof, curated, or estimated.</td>
              <td className="py-2">Informational unless it also passes the score-grade live-reserve gates.</td>
            </tr>
            <tr className="hover:bg-muted/40 transition-colors">
              <td className="py-2 pr-4 text-foreground">Score-grade live reserve</td>
              <td className="py-2 pr-4">The current report-card snapshot used a fresh, clean, independent live reserve snapshot for collateral quality.</td>
              <td className="py-2">Can replace curated collateral slices inside Resilience.</td>
            </tr>
            <tr className="hover:bg-muted/40 transition-colors">
              <td className="py-2 pr-4 text-foreground">Redemption telemetry</td>
              <td className="py-2 pr-4">A live reserve adapter emitted current redemption capacity, fee, freshness, or route-status metadata.</td>
              <td className="py-2">Can feed Redemption Backstop capacity or fee scoring; it does not automatically change collateral quality.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
