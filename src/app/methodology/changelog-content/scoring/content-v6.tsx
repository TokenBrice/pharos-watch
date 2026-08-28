import type { ReactNode } from "react";
import { scoringChangelogV69Details } from "./content-v6-9";
import { scoringChangelogV691ToV699Details } from "./content-v6-91-to-v6-99";

export const scoringChangelogV6Details: Record<string, ReactNode> = {
  ...scoringChangelogV691ToV699Details,
  ...scoringChangelogV69Details,
  "6.8": (
    <>
      <p>
        Safety Score structure is unchanged, but direct latest-state reserve adapters now stamp explicit on-chain
        freshness so eligible feeds are no longer excluded by missing timestamp metadata.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          <code className="text-xs bg-muted px-1 py-0.5 rounded">evm-branch-balances</code> snapshots now persist{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">freshnessMode=not-applicable</code>.
        </li>
        <li>
          Clean independent branch-balance snapshots can once again override curated collateral quality when their
          latest <code className="text-xs bg-muted px-1 py-0.5 rounded">reserve_sync_state.last_status</code> is{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">ok</code>.
        </li>
        <li>
          This aligns implementation with the existing v6.6 freshness gate rather than introducing a new
          collateral-scoring rule family.
        </li>
      </ul>
    </>
  ),
  "6.7": (
    <>
      <p>
        Blacklistability attribution now treats{" "}
        <span className="text-foreground font-medium">centralized-dependent</span> stablecoins as{" "}
        <span className="text-foreground font-medium">possible</span> by default unless a more specific signal applies.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Shared blacklistability resolution now falls back to{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">possible</code> for centralized-dependent governance
          instead of <code className="text-xs bg-muted px-1 py-0.5 rounded">false</code>.
        </li>
        <li>
          Reserve-heavy dependency cases still surface as{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">possible-inherited</code> when inherited exposure is
          the more specific explanation.
        </li>
        <li>
          Explicit overrides remain authoritative, including curated{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">false</code> exceptions.
        </li>
      </ul>
    </>
  ),
  "6.6": (
    <>
      <p>
        Safety Score structure is unchanged, but collateral-quality live reserve passthrough now requires stronger
        freshness evidence before a live feed can override curated collateral scoring.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Independent live reserve feeds still need a{" "}
          <span className="text-foreground font-medium">fresh authoritative snapshot</span> whose latest{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">reserve_sync_state.last_status</code> is{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">ok</code>.
        </li>
        <li>
          In addition, collateral passthrough now requires scoring-eligible freshness evidence: either a verified
          timestamp path or a <code className="text-xs bg-muted px-1 py-0.5 rounded">freshnessMode</code> of{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">verified</code> or{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">not-applicable</code>.
        </li>
        <li>
          Feeds marked <code className="text-xs bg-muted px-1 py-0.5 rounded">unverified</code> remain available on
          reserve detail/status surfaces, but they no longer override curated collateral quality in report-card scoring.
        </li>
      </ul>
    </>
  ),
  "6.5": (
    <>
      <p>
        Safety Score structure is unchanged, but the collateral-quality live reserve passthrough is now stricter about
        evidence quality and warning-bearing feeds.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Live collateral passthrough now requires a{" "}
          <span className="text-foreground font-medium">fresh authoritative snapshot</span> whose latest{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">reserve_sync_state.last_status</code> is{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">ok</code>.
        </li>
        <li>
          The live reserve adapter registry now separates reserve shape (
          <code className="text-xs bg-muted px-1 py-0.5 rounded">sourceModel</code>) from evidence strength (
          <code className="text-xs bg-muted px-1 py-0.5 rounded">evidenceClass</code>).
        </li>
        <li>
          <code className="text-xs bg-muted px-1 py-0.5 rounded">single-asset</code> and{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">tether</code> style feeds are now treated as{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">weak-live-probe</code> evidence, so they remain visible
          on reserve detail/status surfaces but no longer override curated collateral scoring.
        </li>
        <li>
          Source-age and material unknown-exposure warnings now degrade reserve sync health and automatically keep those
          snapshots out of collateral passthrough.
        </li>
      </ul>
    </>
  ),
  "6.4": (
    <>
      <p>
        Safety Score structure is unchanged, but Liquity-style formula routes can now use current on-chain redemption
        fees when live reserve telemetry is available.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          <span className="text-foreground font-medium">LUSD</span> and{" "}
          <span className="text-foreground font-medium">BOLD</span> now reuse live reserve sync metadata for current
          redemption fee bps instead of always sitting in the generic reviewed-formula bucket.
        </li>
        <li>
          These routes remain labeled as <code className="text-xs bg-muted px-1 py-0.5 rounded">formula</code> fee
          models and <code className="text-xs bg-muted px-1 py-0.5 rounded">eventual-only</code> capacity routes, so
          Pharos does not present them as having an immediate redeemable buffer.
        </li>
        <li>
          If live fee telemetry is unavailable, the liquidity dimension falls back to the prior reviewed-formula
          treatment.
        </li>
      </ul>
    </>
  ),
  "6.3": (
    <>
      <p>
        Safety Score structure is unchanged, but a narrow class of immutable on-chain redemption routes now counts as
        stronger exit evidence than heuristic capacity models.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          <span className="text-foreground font-medium">LUSD</span> and{" "}
          <span className="text-foreground font-medium">BOLD</span> now use{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">documented-bound</code> eventual redemption capacity
          instead of generic heuristic <code className="text-xs bg-muted px-1 py-0.5 rounded">supply-full</code>{" "}
          modeling.
        </li>
        <li>
          These routes still present as <code className="text-xs bg-muted px-1 py-0.5 rounded">eventual-only</code>, so
          Pharos does not treat full current supply as an immediate redeemable buffer.
        </li>
        <li>
          Liquity-style <code className="text-xs bg-muted px-1 py-0.5 rounded">min 50 bps + baseRate</code> fees remain
          reviewed formula inputs rather than fixed-fee assumptions.
        </li>
      </ul>
    </>
  ),
  "6.2": (
    <>
      <p>
        Safety Score structure is unchanged, but the collateral-quality live reserve passthrough is now stricter about
        which hourly reserve feeds qualify.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Live collateral passthrough now requires a
          <span className="text-foreground font-medium"> fresh authoritative snapshot</span>: the reserve row must be
          non-empty and matched to the coin&apos;s latest successful sync state.
        </li>
        <li>
          Only <code className="text-xs bg-muted px-1 py-0.5 rounded">dynamic-mix</code> and{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">single-bucket</code> feeds count as independent live
          collateral inputs. <code className="text-xs bg-muted px-1 py-0.5 rounded">validated-static</code> feeds stay
          visible on reserve detail/status surfaces but no longer override curated collateral scoring.
        </li>
        <li>
          Single-bucket live feeds now participate in collateral drift and fallback tracking; the old implicit{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">&gt;= 2 slices</code> gate is no longer the scoring
          contract.
        </li>
      </ul>
    </>
  ),
  "6.1": (
    <>
      <p>
        Safety Score structure is unchanged, but the Liquidity dimension is now stricter about what redemption evidence
        can improve it.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Low-confidence redemption routes remain visible in detail surfaces, but they no longer uplift the Safety Score
          liquidity dimension.
        </li>
        <li>
          When the reused DEX liquidity snapshot is stale, it is no longer blended into{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">effectiveExitScore</code>.
        </li>
        <li>
          Redemption detail output now distinguishes immediate redeemable capacity from eventual issuer/protocol
          redeemability.
        </li>
      </ul>
    </>
  ),
  "6.0": (
    <>
      <p>
        Four structural changes landed together in the safety methodology: a wider custody model, a new chain tier for
        Solana and BNB Chain, a simpler 2-factor Resilience score, and a steeper 5-band chain penalty.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Custody model expanded from 3 to 6 tiers: onchain, institutional-top, institutional-regulated,
          institutional-unregulated, institutional-sanctioned, and cex.
        </li>
        <li>
          Added <span className="text-foreground font-medium">mature-alt-l1</span> for Solana and BNB Chain with score
          45.
        </li>
        <li>
          Resilience became <code className="text-xs bg-muted px-1 py-0.5 rounded">(collateral + custody) / 2</code>;
          blacklist capability is now descriptive only.
        </li>
        <li>Chain-risk penalty moved to 5 bands, and wrapper governance became exempt from that penalty.</li>
      </ul>
    </>
  ),
};
