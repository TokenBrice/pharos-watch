import { VersionCard, getScoringEntry } from "./content-shared";

export function ScoringChangelogV707Entry() {
  return (
    <VersionCard
      entry={getScoringEntry("7.07")}
      accent="border-l-emerald-500"
    >
      <p>
        Liquidity / Exit and the redemption-backstop snapshot now reuse the last-known DEX liquidity score when
        its freshness runway has elapsed, instead of suppressing it and cascading documented offchain-issuer
        routes (USDC, USDP, USDT, GUSD, …) to NR on routine sync-dex-liquidity cron lag.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Reverses v6.1&apos;s rule that stripped stale DEX liquidity out of{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">effectiveExitScore</code>; staleness is surfaced
          via <code className="text-xs bg-muted px-1 py-0.5 rounded">liquidityStale</code> and{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">inputFreshness.dexLiquidity.stale</code> so
          consumers can warn on age without losing the dimension.
        </li>
        <li>
          <code className="text-xs bg-muted px-1 py-0.5 rounded">/api/redemption-backstops.effectiveExitScore</code>{" "}
          stays aligned with the stale-DEX freshness policy during stale windows instead of diverging to{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">null</code>, but it remains the raw best-path exit
          blend and can still differ numerically from report-card liquidity after Safety Score eligibility gates apply.
          The redemption-backstop cron still marks its run{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">degraded</code> and sets{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">metadata.liquidityStale = true</code> for operational
          visibility.
        </li>
        <li>
          Absent DEX snapshots (loader rejects or empty table) still produce{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">liquidityScore = null</code> and trigger the
          documented offchain-issuer primary-market-floor exclusion; the rule now distinguishes &quot;present but
          old&quot; from &quot;truly missing.&quot;
        </li>
      </ul>
    </VersionCard>
  );
}

export function ScoringChangelogV706Entry() {
  return (
    <VersionCard
      entry={getScoringEntry("7.06")}
      accent="border-l-emerald-500"
    >
      <p>
        The GHO reserve adapter now decomposes residual issuance across active facilitators and routes unmapped
        labels through the standard material-unknown-exposure validator instead of a GHO-specific warning.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Aave V3 direct-minter facilitators contribute medium-risk residual slices; FlashMinter and unmapped
          facilitators contribute high-risk slices.
        </li>
        <li>
          Unmapped residual share accumulates into unknown-exposure telemetry so material unknown exposure
          can degrade the GHO sync consistently with other reserve adapters.
        </li>
        <li>
          Direct GhoReserve / GhoDirectFacilitator / RemoteGSM reads remain a follow-up pending verified
          Aave deployment addresses.
        </li>
      </ul>
    </VersionCard>
  );
}

export function ScoringChangelogV705Entry() {
  return (
    <VersionCard
      entry={getScoringEntry("7.05")}
      accent="border-l-emerald-500"
    >
      <p>
        Documented issuer redemption now earns a small primary-market exit bonus only when DEX liquidity is already present.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Offchain issuer routes with documented-bound eventual redeemability can contribute the diversification bonus.
        </li>
        <li>
          The route cannot replace missing DEX liquidity; no-DEX assets still need immediate-bounded redemption evidence to score.
        </li>
        <li>
          Low-confidence, stale, impaired, route-limited, and severe-depeg-ineligible routes still fail closed.
        </li>
      </ul>
    </VersionCard>
  );
}

export function ScoringChangelogV704Entry() {
  return (
    <VersionCard
      entry={getScoringEntry("7.04")}
      accent="border-l-emerald-500"
    >
      <p>
        Redemption backstops now stay eligible through normal 4-hourly sync lag instead of dropping
        out of Liquidity / Exit as soon as the previous snapshot crosses one sync interval old.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Report-card redemption freshness now uses a two-run runway for the 4-hourly redemption sync.
        </li>
        <li>
          Medium- and high-confidence immediate-bounded redemption routes continue to improve Liquidity / Exit
          between normal syncs.
        </li>
        <li>
          Missing, materially stale, low-confidence, impaired, eventual-only, and severe-depeg-ineligible
          routes still fail closed.
        </li>
      </ul>
    </VersionCard>
  );
}

export function ScoringChangelogV703Entry() {
  return (
    <VersionCard
      entry={getScoringEntry("7.03")}
      accent="border-l-emerald-500"
    >
      <p>
        USTB can now use Superstate&apos;s current liquidity telemetry while keeping NAV/AUM separate from
        immediate exit capacity.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>Current Circle USD and USDC RedemptionIdle balances bound USTB redemption capacity.</li>
        <li>The on-chain NAV oracle remains reserve evidence, not immediate liquidity.</li>
        <li>Malformed or unavailable liquidity telemetry fails closed instead of falling back to NAV/AUM.</li>
      </ul>
    </VersionCard>
  );
}

export function ScoringChangelogV702Entry() {
  return (
    <VersionCard
      entry={getScoringEntry("7.02")}
      accent="border-l-emerald-500"
    >
      <p>
        frxUSD now uses fresh Frax balance-sheet redemption capacity with route-status and capacity-ratio
        fail-closed guards.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>frxUSD no longer relies on a static full-supply eventual redemption model.</li>
        <li>Live route-status telemetry can suppress redemption uplift when a route is paused, degraded, or cohort-limited.</li>
        <li>Nested capacity amounts no longer reuse flat reserve-composition ratios as supply-relative capacity ratios.</li>
      </ul>
    </VersionCard>
  );
}

export function ScoringChangelogV701Entry() {
  return (
    <VersionCard
      entry={getScoringEntry("7.01")}
      accent="border-l-emerald-500"
    >
      <p>
        Liquidity / Exit now distinguishes standalone redemption-route quality from Safety Score-eligible exit capacity.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>Eventual-only redemption routes remain visible but no longer uplift Liquidity / Exit by themselves.</li>
        <li>Queue-like routes can contribute when resolved and current, with their contribution capped before blending.</li>
        <li>Immediate-bounded, live-direct, and validated-live routes continue to improve the dimension when fresh and unimpaired.</li>
      </ul>
    </VersionCard>
  );
}

export function ScoringChangelogV70Entry() {
  return (
    <VersionCard
      entry={getScoringEntry("7.0")}
      accent="border-l-emerald-500"
    >
      <p>
        More proof-style reserve feeds now use timestamped independent evidence instead of weak liveness checks.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          USYC and TBILL now use Chainlink-style NAV oracle reads with verified source timestamps.
        </li>
        <li>
          FRAX now reads Frax&apos;s v2 balance-sheet API and maps known balance-sheet assets explicitly.
        </li>
        <li>
          USD1 now reads its Chainlink bundle oracle for live reserve size, timestamp, and supply comparison.
        </li>
        <li>
          The global gate remains strict: proof sources without payload-native freshness stay detail-visible only.
        </li>
      </ul>
    </VersionCard>
  );
}

export function ScoringChangelogV699Entry() {
  return (
    <VersionCard
      entry={getScoringEntry("6.99")}
      accent="border-l-emerald-500"
    >
      <p>
        USDaf&apos;s Asymmetry reserve feed can now qualify for live collateral passthrough when the protocol
        API snapshot is fresh.
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
    </VersionCard>
  );
}

export function ScoringChangelogV698Entry() {
  return (
    <VersionCard
      entry={getScoringEntry("6.98")}
      accent="border-l-emerald-500"
    >
      <p>
        Timestamped reserve feeds can now re-enter collateral-quality passthrough when they satisfy the
        existing freshness and sync-health gates.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Circle, M0, Mento, and USD.AI reserve adapters now preserve usable upstream disclosure or
          dashboard timestamps instead of leaving those snapshots marked{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">freshnessMode=unverified</code>.
        </li>
        <li>
          Re Protocol and Yuzu mappings now classify newly observed reserve buckets explicitly, so clean
          fresh snapshots are not degraded as unknown exposure.
        </li>
        <li>
          The global gate is unchanged: only fresh, independent,{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">ok</code> sync snapshots with verified
          or intrinsically current freshness can drive report-card collateral scoring.
        </li>
      </ul>
    </VersionCard>
  );
}

export function ScoringChangelogV697Entry() {
  return (
    <VersionCard
      entry={getScoringEntry("6.97")}
      accent="border-l-amber-500"
    >
      <p>
        Active-depeg and dependency edge cases now follow the documented Safety Score model more strictly.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Peg Stability now passes through <code className="text-xs bg-muted px-1 py-0.5 rounded">computePegScore()</code>{" "}
          during active depegs instead of applying the old 65-point peg-dimension cap before the multiplier.
        </li>
        <li>
          <code className="text-xs bg-muted px-1 py-0.5 rounded">activeDepegBps</code> now comes from the
          open depeg event&apos;s peak severity, so final Safety Score caps use the same severe-event source as
          redemption-route impairment.
        </li>
        <li>
          Stale redemption-backstop snapshots no longer uplift Liquidity / Exit; the dimension falls back to
          fresh DEX evidence or NR until the redemption snapshot refreshes.
        </li>
        <li>
          Missing upstream dependency scores are applied at the existing 70-point unavailable fallback for
          their declared weights, and the contagion stress test now propagates transitively through downstream
          dependency chains.
        </li>
      </ul>
    </VersionCard>
  );
}

export function ScoringChangelogV696Entry() {
  return (
    <VersionCard
      entry={getScoringEntry("6.96")}
      accent="border-l-amber-500"
    >
      <p>
        Severe active depegs now force redemption uplift to prove current exercisability instead of
        relying on static route documentation.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Liquidity / Exit now ignores redemption backstops that are unresolved, low-confidence, or
          marked impaired by route-availability evidence.
        </li>
        <li>
          Active depegs at or above <code className="text-xs bg-muted px-1 py-0.5 rounded">2500 bps</code>{" "}
          disable static, documented-bound, live-proxy, issuer/API, queue, and estimated redemption uplift.
        </li>
        <li>
          Live-direct, dynamic, permissionless routes with atomic or immediate settlement can still contribute
          during severe depegs because they carry current direct redemption evidence.
        </li>
      </ul>
    </VersionCard>
  );
}

export function ScoringChangelogV695Entry() {
  return (
    <VersionCard
      entry={getScoringEntry("6.95")}
      accent="border-l-amber-500"
    >
      <p>
        Direct inherited freeze risk now counts two reserve-side collateral classes that were previously
        under-attributed: custodied BTC wrappers and issuer-seizable tokenized collateral.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Shared <code className="text-xs bg-muted px-1 py-0.5 rounded">isBlacklistable()</code>{" "}
          now treats centralized-custody BTC wrappers such as{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">WBTC</code> and{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">cbBTC</code> as{" "}
          <span className="text-foreground font-medium">direct</span> inherited freeze exposure rather
          than only weak possible clues.
        </li>
        <li>
          Issuer-seizable tokenized collateral such as{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">PAXG</code>,{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">XAUT</code>, and reviewed tokenized
          share symbols such as <code className="text-xs bg-muted px-1 py-0.5 rounded">BOSS</code>{" "}
          now counts toward the same direct inherited threshold.
        </li>
        <li>
          Coins whose reserve mix crosses the majority threshold because of these assets now resolve to{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">inherited</code> instead of{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">possible</code>.
        </li>
      </ul>
    </VersionCard>
  );
}

export function ScoringChangelogV694Entry() {
  return (
    <VersionCard
      entry={getScoringEntry("6.94")}
      accent="border-l-amber-500"
    >
      <p>
        NAV wrappers that explicitly wrap a stablecoin now inherit peg risk from the referenced base
        asset instead of getting an automatic neutral peg multiplier.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Configured NAV wrappers can now reuse a referenced base stablecoin&apos;s{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">pegScore</code> in Safety Score
          report-card scoring.
        </li>
        <li>
          Pure fund-share NAV tokens with no configured peg reference still keep{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">pegScore = NR</code> and the neutral
          multiplier treatment.
        </li>
        <li>
          This specifically closes the loophole where a wrapped stablecoin NAV structure could avoid the
          stronger v6.93 peg penalty even when the underlying base stablecoin had clear peg risk.
        </li>
      </ul>
    </VersionCard>
  );
}

export function ScoringChangelogV693Entry() {
  return (
    <VersionCard
      entry={getScoringEntry("6.93")}
      accent="border-l-amber-500"
    >
      <p>
        Peg stability now has more weight in the final grade, and severe live depegs can hard-cap the
        score regardless of otherwise strong base dimensions.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          <code className="text-xs bg-muted px-1 py-0.5 rounded">PEG_MULTIPLIER_EXPONENT</code>{" "}
          increased from <code className="text-xs bg-muted px-1 py-0.5 rounded">0.20</code> to{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">0.40</code>.
        </li>
        <li>
          Active depegs at or above{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">1000 bps</code> now cap the overall
          score at D, and active depegs at or above{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">2500 bps</code> cap it at F.
        </li>
        <li>
          <code className="text-xs bg-muted px-1 py-0.5 rounded">activeDepegBps</code> is now exposed
          in report-card raw inputs so the frontend and stressed-grade recomputation paths apply the same
          cap logic.
        </li>
      </ul>
    </VersionCard>
  );
}

export function ScoringChangelogV692Entry() {
  return (
    <VersionCard
      entry={getScoringEntry("6.92")}
      accent="border-l-amber-500"
    >
      <p>
        LUSD now uses direct Liquity v1 system-collateral reads instead of the generic proof-style
        liveness probe, so clean snapshots qualify as independent live reserve evidence.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          The dedicated <code className="text-xs bg-muted px-1 py-0.5 rounded">liquity-v1</code>{" "}
          adapter reads <code className="text-xs bg-muted px-1 py-0.5 rounded">getEntireSystemColl()</code>{" "}
          and <code className="text-xs bg-muted px-1 py-0.5 rounded">getEntireSystemDebt()</code>{" "}
          from the official Ethereum <code className="text-xs bg-muted px-1 py-0.5 rounded">TroveManager</code>.
        </li>
        <li>
          LUSD reserve snapshots remain a single-bucket 100% ETH view, but the adapter is now registered
          as <code className="text-xs bg-muted px-1 py-0.5 rounded">independent</code> instead of{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">weak-live-probe</code>.
        </li>
        <li>
          This promotes LUSD&apos;s clean authoritative reserve snapshots into collateral-quality live
          passthrough without relaxing the generic gate for other{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">single-asset</code> probes.
        </li>
      </ul>
    </VersionCard>
  );
}

export function ScoringChangelogV691Entry() {
  return (
    <VersionCard
      entry={getScoringEntry("6.91")}
      accent="border-l-amber-500"
    >
      <p>
        Blacklistability attribution now treats reserve-side freeze clues as first-class signals instead of
        only trusting explicit slice flags and resolved upstream coin IDs.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Shared <code className="text-xs bg-muted px-1 py-0.5 rounded">isBlacklistable()</code>{" "}
          now resolves to <code className="text-xs bg-muted px-1 py-0.5 rounded">possible</code> when
          curated or live reserve labels imply blacklistable stablecoins, wrappers, or CEX/custody rails
          below the majority threshold.
        </li>
        <li>
          Majority <span className="text-foreground font-medium">direct</span> reserve exposure still
          resolves to <code className="text-xs bg-muted px-1 py-0.5 rounded">inherited</code>; the new
          heuristics are there to prevent reserve-side exposure from incorrectly falling through to{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">no</code>.
        </li>
        <li>
          Live reserve enrichment and curated reserve evaluation now share the same direct clue detection
          for named stablecoin baskets and explicit custody/CEX descriptors.
        </li>
        <li>
          This does not relax the collateral passthrough gate:{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">static-validated</code>,{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">weak-live-probe</code>, and{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">freshnessMode=unverified</code>{" "}
          reserve feeds remain detail-visible only.
        </li>
      </ul>
    </VersionCard>
  );
}
