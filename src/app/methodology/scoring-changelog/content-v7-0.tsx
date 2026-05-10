import { VersionCard, getScoringEntry } from "./content-shared";

export function ScoringChangelogV718Entry() {
  return (
    <VersionCard
      entry={getScoringEntry("7.18")}
      accent="border-l-emerald-500"
    >
      <p>
        Liquidity / Exit now applies stricter live redemption telemetry gates before redemption capacity can improve
        Safety Scores.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Unverified nested redemption freshness is excluded unless a route-specific lower-bound allowlist explicitly
          permits it.
        </li>
        <li>Daily redemption limits emitted by adapters cap usable scoring capacity while raw capacity stays visible.</li>
        <li>Proxy and queue capacity kinds cannot qualify as severe-depeg live-direct evidence.</li>
      </ul>
    </VersionCard>
  );
}

export function ScoringChangelogV717Entry() {
  return (
    <VersionCard
      entry={getScoringEntry("7.17")}
      accent="border-l-emerald-500"
    >
      <p>
        USD3 / Web 3 Dollar is reclassified from DeFi to CeFi-dependent because its Reserve Protocol DTF basket is
        concentrated in centralized stablecoin-derived collateral.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          <code className="text-xs bg-muted px-1 py-0.5 rounded">usd3-reserve-protocol</code> now uses governance{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">centralized-dependent</code>.
        </li>
        <li>
          The correction reflects Savings USDS, Aave USDC, wrapped Compound USDCv3, and Steakhouse USDC strategy
          exposure in the curated and live reserve configuration.
        </li>
        <li>Scoring weights, thresholds, reserve risks, and live reserve adapter behavior are unchanged.</li>
      </ul>
    </VersionCard>
  );
}

export function ScoringChangelogV716Entry() {
  return (
    <VersionCard
      entry={getScoringEntry("7.16")}
      accent="border-l-emerald-500"
    >
      <p>
        Six disputed <code className="text-xs bg-muted px-1 py-0.5 rounded">Freezable: No</code> classifications were
        rechecked against native protocol controls and verified contract surfaces.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          HomeCoin now resolves as <code className="text-xs bg-muted px-1 py-0.5 rounded">Possible</code> because the
          holder-facing HOME token is a transparent upgradeable proxy with an active proxy-admin upgrade surface.
        </li>
        <li>
          HBD, vCRED, Freedom Dollar, LUAUSD, and NXUSD remain{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">No</code> after review found no freeze, blacklist,
          pause, denylist, arbitrary burn, or upgrade control on the holder-facing asset surface.
        </li>
        <li>
          Owner mint authority and user or allowance burn functions stay classified as supply controls, not freeze
          controls, unless paired with transfer gates, arbitrary burns, blacklist controls, or mutable holder-control
          surfaces.
        </li>
      </ul>
    </VersionCard>
  );
}

export function ScoringChangelogV715Entry() {
  return (
    <VersionCard
      entry={getScoringEntry("7.15")}
      accent="border-l-emerald-500"
    >
      <p>
        The resolved <code className="text-xs bg-muted px-1 py-0.5 rounded">Freezable: No</code> cohort was reviewed
        against token-level freeze, denylist, blacklist, pause, and arbitrary role-burn controls.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          JupUSD, eSui Dollar, MAI, JUSD, Alpha Partner USDA, Ring USDR, DOC, USDRIF, and Nest inALPHA now resolve as
          direct <code className="text-xs bg-muted px-1 py-0.5 rounded">Freezable: Yes</code> where audited token or
          vault contracts expose holder-facing controls.
        </li>
        <li>
          sBOLD and Enosys CDP now resolve as <code className="text-xs bg-muted px-1 py-0.5 rounded">Possible</code>{" "}
          because their audited contracts expose pause or mutable branch-control surfaces rather than a confirmed
          current address-level blacklist.
        </li>
        <li>
          The remaining resolved <code className="text-xs bg-muted px-1 py-0.5 rounded">No</code> cohort stays
          unchanged where no direct holder-facing freeze, blacklist, pause, denylist, or arbitrary burn surface was
          confirmed.
        </li>
      </ul>
    </VersionCard>
  );
}

export function ScoringChangelogV714Entry() {
  return (
    <VersionCard
      entry={getScoringEntry("7.14")}
      accent="border-l-emerald-500"
    >
      <p>
        Score-grade live reserve slices with tracked{" "}
        <code className="text-xs bg-muted px-1 py-0.5 rounded">coinId</code> links now drive Dependency Risk,
        raw dependency inputs, topological ordering, and the public dependency graph together.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Report-card Dependency Risk now uses the same fresh independent live reserve slices already
          eligible for collateral-quality scoring when those slices carry tracked stablecoin links.
        </li>
        <li>
          Unmapped live reserve share remains implicit self-backed or non-stablecoin exposure, so live
          snapshots no longer fall back to stale curated dependency percentages for that remainder.
        </li>
        <li>
          The public dependency graph now publishes the effective dependency edges used by the snapshot,
          while tracked variant parent wrapper edges remain synthetic and de-duplicated.
        </li>
      </ul>
    </VersionCard>
  );
}

export function ScoringChangelogV713Entry() {
  return (
    <VersionCard
      entry={getScoringEntry("7.13")}
      accent="border-l-emerald-500"
    >
      <p>
        Blacklist labeling now reserves <code className="text-xs bg-muted px-1 py-0.5 rounded">possible</code> for
        curated direct token or vault controls.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Reserve-side stablecoins, wrapped or custodied collateral, custody/CEX rails, and tracked parent-asset
          exposures now resolve to <code className="text-xs bg-muted px-1 py-0.5 rounded">inherited</code> / Upstream
          instead of sharing the <code className="text-xs bg-muted px-1 py-0.5 rounded">possible</code> bucket.
        </li>
        <li>
          Explicit <code className="text-xs bg-muted px-1 py-0.5 rounded">canBeBlacklisted: &quot;possible&quot;</code>{" "}
          overrides remain only on assets whose holder-facing token or vault still exposes a pause, freeze, or blacklist
          surface.
        </li>
        <li>
          The change is descriptive only for Resilience and does not alter tracked-variant dependency ceilings or the
          parent-overall cap framework added in recent v7.x releases.
        </li>
      </ul>
    </VersionCard>
  );
}

export function ScoringChangelogV712Entry() {
  return (
    <VersionCard
      entry={getScoringEntry("7.12")}
      accent="border-l-emerald-500"
    >
      <p>
        K3 sBOLD now joins the tracked parent-linked variant framework as a risk-absorption child of BOLD.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          <code className="text-xs bg-muted px-1 py-0.5 rounded">sbold-k3-capital</code> now declares canonical{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">variantOf</code> /{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">variantKind</code> metadata as a{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">risk-absorption</code> child of{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">bold-liquity</code>.
        </li>
        <li>
          The classification is based on Liquity Stability Pool loss-absorption dominating the wrapper&apos;s extra risk
          surface, rather than a generic strategy-vault interpretation.
        </li>
        <li>
          sBOLD now joins the tracked risk-absorption cohort beside{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">stUSDS</code> and{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">stkGHO.v1</code>, using the existing parent minus 5
          dependency ceiling and parent-overall cap.
        </li>
      </ul>
    </VersionCard>
  );
}

export function ScoringChangelogV711Entry() {
  return (
    <VersionCard
      entry={getScoringEntry("7.11")}
      accent="border-l-emerald-500"
    >
      <p>
        The tracked parent-linked wrapper framework now covers the four highest-confidence strategy-vault children.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          <code className="text-xs bg-muted px-1 py-0.5 rounded">sUSDai</code>,{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">msY</code>,{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">sAID</code>, and{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">stcUSD</code> now declare canonical{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">variantOf</code> /{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">variantKind</code> metadata as tracked{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">strategy-vault</code> children.
        </li>
        <li>
          Dependency Risk now applies a tracked strategy-vault wrapper ceiling of parent minus 5 points, while the
          existing parent-overall cap still prevents the child from outscoring the parent card.
        </li>
        <li>
          The homepage variant owner on <code className="text-xs bg-muted px-1 py-0.5 rounded">/</code> now includes a
          <code className="text-xs bg-muted px-1 py-0.5 rounded">Strategy</code> filter state alongside the existing
          Savings, Risk-Abs, and Bond families.
        </li>
        <li>
          This phase keeps the current parent-linked{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">pegReferenceId</code> path for these four products,
          so severe parent depegs still constrain the child until independent NAV/peg handling ships later.
        </li>
      </ul>
    </VersionCard>
  );
}

export function ScoringChangelogV710Entry() {
  return (
    <VersionCard
      entry={getScoringEntry("7.10")}
      accent="border-l-emerald-500"
    >
      <p>
        The parent-linked wrapper framework now covers bond-maturity variants, starting with bUSD0 as a bond leg
        over USD0.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          <code className="text-xs bg-muted px-1 py-0.5 rounded">bUSD0</code> now declares canonical{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">variantOf</code> /{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">variantKind</code> metadata as a{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">bond-maturity</code> child of USD0.
        </li>
        <li>
          Dependency Risk now applies a stricter bond wrapper ceiling of parent minus 8 points while the existing
          parent-overall cap still prevents the child from outscoring the parent card.
        </li>
        <li>
          The homepage variant owner on <code className="text-xs bg-muted px-1 py-0.5 rounded">/</code> now includes a
          <code className="text-xs bg-muted px-1 py-0.5 rounded">Bond</code> filter state, and detail-page variant cards
          link back into that owner instead of introducing a dedicated variant route family.
        </li>
      </ul>
    </VersionCard>
  );
}

export function ScoringChangelogV709Entry() {
  return (
    <VersionCard
      entry={getScoringEntry("7.09")}
      accent="border-l-emerald-500"
    >
      <p>
        Tracked savings and staked wrappers now carry an explicit parent relationship in Safety Scores instead of
        relying on reserve-shape quirks to infer the upstream stablecoin.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Nine tracked wrapped or staked stablecoins now declare canonical{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">variantOf</code> /{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">variantKind</code> metadata and contribute a
          synthetic <code className="text-xs bg-muted px-1 py-0.5 rounded">wrapper</code> edge from parent to child
          in dependency scoring, topological ordering, and the dependency graph.
        </li>
        <li>
          Dependency Risk now caps tracked savings wrappers at parent minus 3 points and tracked risk-absorption
          wrappers at parent minus 5 points, while legacy non-variant wrapper dependencies keep the original
          parent-minus-3 behavior.
        </li>
        <li>
          Tracked variants cannot outscore their parent overall card; live cards and stressed recomputation now expose{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">overallCapped</code>,{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">uncappedOverallScore</code>,{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">rawInputs.variantParentId</code>, and{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">rawInputs.variantKind</code> so parent-cap drag is
          distinct from peg drag in the UI and stress tooling.
        </li>
      </ul>
    </VersionCard>
  );
}

export function ScoringChangelogV708Entry() {
  return (
    <VersionCard
      entry={getScoringEntry("7.08")}
      accent="border-l-emerald-500"
    >
      <p>
        Reserve-risk tiering now distinguishes transparent spot or wrapped market exposure from actively managed
        strategy books.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>Delta-neutral wording no longer implies a medium reserve-risk tier by itself.</li>
        <li>
          Transparent spot or wrapped market exposure can remain medium when custody and counterparty risk are
          already captured by the custody model.
        </li>
        <li>
          Externally managed market-neutral, basis, perp, LP, private-deal, or custody-dependent strategy reserves
          are high unless stronger granular evidence shows the slice is only an idle stablecoin or cash-equivalent
          buffer.
        </li>
        <li>
          avUSD&apos;s 0xPartners-managed strategy and loss-absorption reserve slices move from medium to high.
        </li>
      </ul>
    </VersionCard>
  );
}

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
