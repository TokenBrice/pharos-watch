import type { ReactNode } from "react";

export const scoringChangelogV691ToV699Details: Record<string, ReactNode> = {
  "6.99": (
    <>
      <p>
        USDaf&apos;s Asymmetry reserve feed can now qualify for live collateral passthrough when the protocol API
        snapshot is fresh.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          The adapter now preserves Asymmetry&apos;s top-level API timestamp as verified reserve-source freshness.
        </li>
        <li>
          Branch symbols are normalized before risk lookup, so casing-only variants such as{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">wBTC</code> no longer degrade the feed.
        </li>
        <li>
          No scoring policy changed; the feed still needs fresh independent evidence and an{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">ok</code> sync state.
        </li>
      </ul>
    </>
  ),
  "6.98": (
    <>
      <p>
        Timestamped reserve feeds can now re-enter collateral-quality passthrough when they satisfy the existing
        freshness and sync-health gates.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Circle, M0, Mento, and USD.AI reserve adapters now preserve usable upstream disclosure or dashboard timestamps
          instead of leaving those snapshots marked{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">freshnessMode=unverified</code>.
        </li>
        <li>
          Re Protocol and Yuzu mappings now classify newly observed reserve buckets explicitly, so clean fresh snapshots
          are not degraded as unknown exposure.
        </li>
        <li>
          The global gate is unchanged: only fresh, independent,{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">ok</code> sync snapshots with verified or intrinsically
          current freshness can drive report-card collateral scoring.
        </li>
      </ul>
    </>
  ),
  "6.97": (
    <>
      <p>Active-depeg and dependency edge cases now follow the documented Safety Score model more strictly.</p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Peg Stability now passes through{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">computePegScore()</code> during active depegs instead
          of applying the old 65-point peg-dimension cap before the multiplier.
        </li>
        <li>
          <code className="text-xs bg-muted px-1 py-0.5 rounded">activeDepegBps</code> now comes from the open depeg
          event&apos;s peak severity, so final Safety Score caps use the same severe-event source as redemption-route
          impairment.
        </li>
        <li>
          Stale redemption-backstop snapshots no longer uplift Liquidity / Exit; the dimension falls back to fresh DEX
          evidence or NR until the redemption snapshot refreshes.
        </li>
        <li>
          Missing upstream dependency scores are applied at the existing 70-point unavailable fallback for their
          declared weights, and the contagion stress test now propagates transitively through downstream dependency
          chains.
        </li>
      </ul>
    </>
  ),
  "6.96": (
    <>
      <p>
        Severe active depegs now force redemption uplift to prove current exercisability instead of relying on static
        route documentation.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Liquidity / Exit now ignores redemption backstops that are unresolved, low-confidence, or marked impaired by
          route-availability evidence.
        </li>
        <li>
          Active depegs at or above <code className="text-xs bg-muted px-1 py-0.5 rounded">2500 bps</code> disable
          static, documented-bound, live-proxy, issuer/API, queue, and estimated redemption uplift.
        </li>
        <li>
          Live-direct, dynamic, permissionless routes with atomic or immediate settlement can still contribute during
          severe depegs because they carry current direct redemption evidence.
        </li>
      </ul>
    </>
  ),
  "6.95": (
    <>
      <p>
        Direct inherited freeze risk now counts two reserve-side collateral classes that were previously
        under-attributed: custodied BTC wrappers and issuer-seizable tokenized collateral.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Shared <code className="text-xs bg-muted px-1 py-0.5 rounded">isBlacklistable()</code> now treats
          centralized-custody BTC wrappers such as <code className="text-xs bg-muted px-1 py-0.5 rounded">WBTC</code>{" "}
          and <code className="text-xs bg-muted px-1 py-0.5 rounded">cbBTC</code> as{" "}
          <span className="text-foreground font-medium">direct</span> inherited freeze exposure rather than only weak
          possible clues.
        </li>
        <li>
          Issuer-seizable tokenized collateral such as{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">PAXG</code>,{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">XAUT</code>, and reviewed tokenized share symbols such
          as <code className="text-xs bg-muted px-1 py-0.5 rounded">BOSS</code> joined the direct inherited-freeze
          signal set introduced in this phase.
        </li>
        <li>
          Coins with these reviewed collateral assets gained inherited-freeze treatment in this phase; v7.13 later
          superseded the reserve-weight gate with the current any-reserve{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">inherited</code> instead of{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">possible</code>.
        </li>
      </ul>
    </>
  ),
  "6.94": (
    <>
      <p>
        NAV wrappers that explicitly wrap a stablecoin now inherit peg risk from the referenced base asset instead of
        getting an automatic neutral peg multiplier.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Configured NAV wrappers can now reuse a referenced base stablecoin&apos;s{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">pegScore</code> in Safety Score report-card scoring.
        </li>
        <li>
          Pure fund-share NAV tokens with no configured peg reference still keep{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">pegScore = NR</code> and the neutral multiplier
          treatment.
        </li>
        <li>
          This specifically closes the loophole where a wrapped stablecoin NAV structure could avoid the stronger v6.93
          peg penalty even when the underlying base stablecoin had clear peg risk.
        </li>
      </ul>
    </>
  ),
  "6.93": (
    <>
      <p>
        Peg stability now has more weight in the final grade, and severe live depegs can hard-cap the score regardless
        of otherwise strong base dimensions.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          <code className="text-xs bg-muted px-1 py-0.5 rounded">PEG_MULTIPLIER_EXPONENT</code> increased from{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">0.20</code> to{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">0.40</code>.
        </li>
        <li>
          Active depegs at or above <code className="text-xs bg-muted px-1 py-0.5 rounded">1000 bps</code> now cap the
          overall score at D, and active depegs at or above{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">2500 bps</code> cap it at F.
        </li>
        <li>
          <code className="text-xs bg-muted px-1 py-0.5 rounded">activeDepegBps</code> is now exposed in report-card raw
          inputs so the frontend and stressed-grade recomputation paths apply the same cap logic.
        </li>
      </ul>
    </>
  ),
  "6.92": (
    <>
      <p>
        LUSD now uses direct Liquity v1 system-collateral reads instead of the generic proof-style liveness probe, so
        clean snapshots qualify as independent live reserve evidence.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          The dedicated <code className="text-xs bg-muted px-1 py-0.5 rounded">liquity-v1</code> adapter reads{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">getEntireSystemColl()</code> and{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">getEntireSystemDebt()</code> from the official Ethereum{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">TroveManager</code>.
        </li>
        <li>
          LUSD reserve snapshots remain a single-bucket 100% ETH view, but the adapter is now registered as{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">independent</code> instead of{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">weak-live-probe</code>.
        </li>
        <li>
          This promotes LUSD&apos;s clean authoritative reserve snapshots into collateral-quality live passthrough
          without relaxing the generic gate for other{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">single-asset</code> probes.
        </li>
      </ul>
    </>
  ),
  "6.91": (
    <>
      <p>
        Blacklistability attribution now treats reserve-side freeze clues as first-class signals instead of only
        trusting explicit slice flags and resolved upstream coin IDs.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Shared <code className="text-xs bg-muted px-1 py-0.5 rounded">isBlacklistable()</code> now resolves to{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">possible</code> when curated or live reserve labels
          imply blacklistable stablecoins, wrappers, or CEX/custody rails below the majority threshold.
        </li>
        <li>
          Majority <span className="text-foreground font-medium">direct</span> reserve exposure still resolves to{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">inherited</code>; the new heuristics are there to
          prevent reserve-side exposure from incorrectly falling through to{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">no</code>.
        </li>
        <li>
          Live reserve enrichment and curated reserve evaluation now share the same direct clue detection for named
          stablecoin baskets and explicit custody/CEX descriptors.
        </li>
        <li>
          This does not relax the collateral passthrough gate:{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">static-validated</code>,{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">weak-live-probe</code>, and{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">freshnessMode=unverified</code> reserve feeds remain
          detail-visible only.
        </li>
      </ul>
    </>
  ),
};
