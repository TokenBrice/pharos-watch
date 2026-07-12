import type { ReactNode } from "react";

export const scoringChangelogV70Details: Record<string, ReactNode> = {
  "7.26": (
    <>
      <p>
        NAV and savings wrappers with a configured peg reference now use the referenced base stablecoin&apos;s peg state
        for Safety Score peg scoring, instead of reading their own yield-accruing share price as a USD peg.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>Appreciating wrapper prices above $1 no longer trigger active-depeg D/F caps by themselves.</li>
        <li>Tracked wrappers such as fxSAVE inherit peg risk from the configured base asset.</li>
        <li>Wrapper, dependency, collateral, and liquidity risks remain scored through their own dimensions.</li>
      </ul>
    </>
  ),
  "7.25": (
    <>
      <p>
        Wrapper Decentralization now follows the tracked wrapped asset when the parent relationship is known, instead of
        assigning every wrapper the same flat low score.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Parent-linked wrappers such as yBOLD, sBOLD, and sfrxUSD inherit the wrapped asset&apos;s already
          chain-adjusted Decentralization score.
        </li>
        <li>
          The inherited score uses the same wrapper-kind haircut as Dependency Risk: savings minus 3,
          strategy-vault/risk-absorption minus 5, and bond-maturity minus 8.
        </li>
        <li>Wrappers without a resolvable single tracked parent keep the conservative fallback score of 10.</li>
      </ul>
    </>
  ),
  "7.24": (
    <>
      <p>
        Liquidity / Exit now consumes Redemption Backstop v4 current-capacity semantics instead of treating every
        configured redemption route as full-strength liquidity.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Eventual-only routes remain visible as redemption coverage but do not create redemption-only Safety liquidity
          uplift without modeled current executable capacity.
        </li>
        <li>
          Redemption contribution is scaled by current capacity and confidence before it can improve the effective-exit
          score.
        </li>
        <li>
          The diversification bonus is reserved for plausibly independent issuer rails rather than correlated wrappers,
          same-protocol routes, or unknown-correlation exits.
        </li>
      </ul>
    </>
  ),
  "7.23": (
    <>
      <p>
        Reserve-sync refinements promote additional clean independent snapshots without widening score-grade evidence
        policy to static or weak-probe sources.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          sGHO now reads the legacy savings contract&apos;s{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">previewRedeem(totalSupply)</code> path directly.
        </li>
        <li>
          Reservoir srUSD/wsrUSD snapshots now map AUSD and Steakhouse Prime USDC strategy rows from the live
          balance-sheet API instead of treating them as unknown exposure.
        </li>
        <li>
          USD.AI now stamps the latest scoped proof-row timestamp while preserving oldest/latest spread metadata, and
          mRe7YIELD allows a weekly Chainlink NAV cadence.
        </li>
      </ul>
    </>
  ),
  "7.22": (
    <>
      <p>
        More RWA NAV tokens and tracked savings wrappers now use direct independent reserve feeds instead of curated
        validation or weak liveness probes.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          WTGXX, VBILL, ACRED, USTBL, EUTBL, and JTRSY now use timestamped Chainlink NAV feeds for score-grade reserve
          freshness.
        </li>
        <li>
          USDCV now uses the SG Forge CoinVertible reserve parser, aligning it with EURCV&apos;s independent attestation
          path.
        </li>
        <li>
          sUSDD and sUSN now use ERC-4626 <code className="text-xs bg-muted px-1 py-0.5 rounded">totalAssets()</code>/
          <code className="text-xs bg-muted px-1 py-0.5 rounded">asset()</code> wrapper reads so their live reserve
          slices inherit tracked USDD and USN parent links.
        </li>
      </ul>
    </>
  ),
  "7.20": (
    <>
      <p>
        The follow-up admin-mint sweep expands the{" "}
        <code className="text-xs bg-muted px-1 py-0.5 rounded">Dilutable</code> tier and records source provenance for
        every Dilutable override.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          DAI, DOLA, FPI, PHT, USDD, USDe, USDN (SMARDEX), crvUSD, REUSD, USDU, and XAI now resolve as{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">Dilutable</code>.
        </li>
        <li>
          Each <code className="text-xs bg-muted px-1 py-0.5 rounded">canBeBlacklisted: &quot;dilutable&quot;</code>{" "}
          entry now carries a contract-source link via{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">canBeBlacklistedSource</code>.
        </li>
        <li>The homepage table and stablecoin detail hero link the Dilutable label directly to that source.</li>
      </ul>
    </>
  ),
  "7.21": (
    <>
      <p>
        crvUSD scoring now reads LLAMMA reserve balances directly from on-chain Curve ControllerFactory data instead of
        relying on a legacy market-state API.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          CrvUSD continues to use existing on-chain factory flows for Yield Basis while LLAMMA{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">bands_y</code> is consumed directly for collateral
          inventory checks.
        </li>
        <li>
          Soft-liquidity <code className="text-xs bg-muted px-1 py-0.5 rounded">bands_x</code> inventory remains in
          snapshot metadata rather than being reclassified as external collateral.
        </li>
        <li>
          Freshness output for this path is marked as{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">&quot;not-applicable&quot;</code>, which allows clean
          crvUSD snapshots to stay eligible for score-grade live reserve inputs.
        </li>
      </ul>
    </>
  ),
  "7.19": (
    <>
      <p>
        A re-audit of 22 stablecoins marked <code className="text-xs bg-muted px-1 py-0.5 rounded">Freezable: No</code>{" "}
        introduces a new <code className="text-xs bg-muted px-1 py-0.5 rounded">Dilutable</code> tier and reclassifies
        five coins to <code className="text-xs bg-muted px-1 py-0.5 rounded">Yes</code> after finding upgradeable
        proxies, admin freeze mixins, or chain-native seizure precedent.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          The new <code className="text-xs bg-muted px-1 py-0.5 rounded">Dilutable</code> tier sits between{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">No</code> and direct{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">Yes</code>: the token has no transfer freeze or
          blacklist, but the issuer can mint unbounded supply and effectively seize value through dilution.
        </li>
        <li>
          vCRED, LUAUSD, and srUSD now resolve as{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">Dilutable</code> because their token contracts expose{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">Ownable</code> mint or{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">AccessControl</code> minter-grant authority without
          supply caps.
        </li>
        <li>
          HBD, mRe7YIELD, FEUSD (Felix), USDQ (Quill), and USDK (Orki) move to direct{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">Yes</code> after confirming transparent upgradeable
          proxies, Midas <code className="text-xs bg-muted px-1 py-0.5 rounded">Blacklistable</code>/
          <code className="text-xs bg-muted px-1 py-0.5 rounded">Pausable</code> mixins, or Hive Hardfork 23 chain-level
          balance seizure precedent.
        </li>
        <li>
          BabelFish XUSD&apos;s explicit{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">canBeBlacklisted: false</code> override is removed so
          its bridged USDT/USDC reserve exposure now resolves to{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">Upstream</code> by default.
        </li>
      </ul>
    </>
  ),
  "7.18": (
    <>
      <p>
        Liquidity / Exit now applies stricter live redemption telemetry gates before redemption capacity can improve
        Safety Scores.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Unverified nested redemption freshness is excluded unless a route-specific lower-bound allowlist explicitly
          permits it.
        </li>
        <li>
          Daily redemption limits emitted by adapters cap usable scoring capacity while raw capacity stays visible.
        </li>
        <li>Proxy and queue capacity kinds cannot qualify as severe-depeg live-direct evidence.</li>
      </ul>
    </>
  ),
  "7.17": (
    <>
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
    </>
  ),
  "7.16": (
    <>
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
    </>
  ),
  "7.15": (
    <>
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
          The remaining resolved <code className="text-xs bg-muted px-1 py-0.5 rounded">No</code> cohort stays unchanged
          where no direct holder-facing freeze, blacklist, pause, denylist, or arbitrary burn surface was confirmed.
        </li>
      </ul>
    </>
  ),
  "7.14": (
    <>
      <p>
        Score-grade live reserve slices with tracked{" "}
        <code className="text-xs bg-muted px-1 py-0.5 rounded">coinId</code> links now drive Dependency Risk, raw
        dependency inputs, topological ordering, and the public dependency graph together.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Report-card Dependency Risk now uses the same fresh independent live reserve slices already eligible for
          collateral-quality scoring when those slices carry tracked stablecoin links.
        </li>
        <li>
          Unmapped live reserve share remains implicit self-backed or non-stablecoin exposure, so live snapshots no
          longer fall back to stale curated dependency percentages for that remainder.
        </li>
        <li>
          The public dependency graph now publishes the effective dependency edges used by the snapshot, while tracked
          variant parent wrapper edges remain synthetic and de-duplicated.
        </li>
      </ul>
    </>
  ),
  "7.13": (
    <>
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
    </>
  ),
  "7.12": (
    <>
      <p>K3 sBOLD now joins the tracked parent-linked variant framework as a risk-absorption child of BOLD.</p>
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
    </>
  ),
  "7.11": (
    <>
      <p>The tracked parent-linked wrapper framework now covers the four highest-confidence strategy-vault children.</p>
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
          <code className="text-xs bg-muted px-1 py-0.5 rounded">pegReferenceId</code> path for these four products, so
          severe parent depegs still constrain the child until independent NAV/peg handling ships later.
        </li>
      </ul>
    </>
  ),
  "7.10": (
    <>
      <p>
        The parent-linked wrapper framework now covers bond-maturity variants, starting with bUSD0 as a bond leg over
        USD0.
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
    </>
  ),
  "7.09": (
    <>
      <p>
        Tracked savings and staked wrappers now carry an explicit parent relationship in Safety Scores instead of
        relying on reserve-shape quirks to infer the upstream stablecoin.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Nine tracked wrapped or staked stablecoins now declare canonical{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">variantOf</code> /{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">variantKind</code> metadata and contribute a synthetic{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">wrapper</code> edge from parent to child in dependency
          scoring, topological ordering, and the dependency graph.
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
    </>
  ),
  "7.08": (
    <>
      <p>
        Reserve-risk tiering now distinguishes transparent spot or wrapped market exposure from actively managed
        strategy books.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>Delta-neutral wording no longer implies a medium reserve-risk tier by itself.</li>
        <li>
          Transparent spot or wrapped market exposure can remain medium when custody and counterparty risk are already
          captured by the custody model.
        </li>
        <li>
          Externally managed market-neutral, basis, perp, LP, private-deal, or custody-dependent strategy reserves are
          high unless stronger granular evidence shows the slice is only an idle stablecoin or cash-equivalent buffer.
        </li>
        <li>avUSD&apos;s 0xPartners-managed strategy and loss-absorption reserve slices move from medium to high.</li>
      </ul>
    </>
  ),
  "7.07": (
    <>
      <p>
        Liquidity / Exit and the redemption-backstop snapshot now reuse the last-known DEX liquidity score when its
        freshness runway has elapsed, instead of suppressing it and cascading documented offchain-issuer routes (USDC,
        USDP, USDT, GUSD, …) to NR on routine sync-dex-liquidity cron lag.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Reverses v6.1&apos;s rule that stripped stale DEX liquidity out of{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">effectiveExitScore</code>; staleness is surfaced via{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">liquidityStale</code> and{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">inputFreshness.dexLiquidity.stale</code> so consumers
          can warn on age without losing the dimension.
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
          <code className="text-xs bg-muted px-1 py-0.5 rounded">liquidityScore = null</code> and trigger the documented
          offchain-issuer primary-market-floor exclusion; the rule now distinguishes &quot;present but old&quot; from
          &quot;truly missing.&quot;
        </li>
      </ul>
    </>
  ),
  "7.06": (
    <>
      <p>
        The GHO reserve adapter now decomposes residual issuance across active facilitators and routes unmapped labels
        through the standard material-unknown-exposure validator instead of a GHO-specific warning.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Aave V3 direct-minter facilitators contribute medium-risk residual slices; FlashMinter and unmapped
          facilitators contribute high-risk slices.
        </li>
        <li>
          Unmapped residual share accumulates into unknown-exposure telemetry so material unknown exposure can degrade
          the GHO sync consistently with other reserve adapters.
        </li>
        <li>
          Direct GhoReserve / GhoDirectFacilitator / RemoteGSM reads remain a follow-up pending verified Aave deployment
          addresses.
        </li>
      </ul>
    </>
  ),
  "7.05": (
    <>
      <p>
        Documented issuer redemption now earns a small primary-market exit bonus only when DEX liquidity is already
        present.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Offchain issuer routes with documented-bound eventual redeemability can contribute the diversification bonus.
        </li>
        <li>
          The route cannot replace missing DEX liquidity; no-DEX assets still need immediate-bounded redemption evidence
          to score.
        </li>
        <li>Low-confidence, stale, impaired, route-limited, and severe-depeg-ineligible routes still fail closed.</li>
      </ul>
    </>
  ),
  "7.04": (
    <>
      <p>
        Redemption backstops now stay eligible through normal 4-hourly sync lag instead of dropping out of Liquidity /
        Exit as soon as the previous snapshot crosses one sync interval old.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>Report-card redemption freshness now uses a two-run runway for the 4-hourly redemption sync.</li>
        <li>
          Medium- and high-confidence immediate-bounded redemption routes continue to improve Liquidity / Exit between
          normal syncs.
        </li>
        <li>
          Missing, materially stale, low-confidence, impaired, eventual-only, and severe-depeg-ineligible routes still
          fail closed.
        </li>
      </ul>
    </>
  ),
  "7.03": (
    <>
      <p>
        USTB can now use Superstate&apos;s current liquidity telemetry while keeping NAV/AUM separate from immediate
        exit capacity.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>Current Circle USD and USDC RedemptionIdle balances bound USTB redemption capacity.</li>
        <li>The on-chain NAV oracle remains reserve evidence, not immediate liquidity.</li>
        <li>Malformed or unavailable liquidity telemetry fails closed instead of falling back to NAV/AUM.</li>
      </ul>
    </>
  ),
  "7.02": (
    <>
      <p>
        frxUSD now uses fresh Frax balance-sheet redemption capacity with route-status and capacity-ratio fail-closed
        guards.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>frxUSD no longer relies on a static full-supply eventual redemption model.</li>
        <li>
          Live route-status telemetry can suppress redemption uplift when a route is paused, degraded, or
          cohort-limited.
        </li>
        <li>
          Nested capacity amounts no longer reuse flat reserve-composition ratios as supply-relative capacity ratios.
        </li>
      </ul>
    </>
  ),
  "7.01": (
    <>
      <p>
        Liquidity / Exit now distinguishes standalone redemption-route quality from Safety Score-eligible exit capacity.
      </p>
      <ul className="list-disc list-inside space-y-1">
        <li>Eventual-only redemption routes remain visible but no longer uplift Liquidity / Exit by themselves.</li>
        <li>
          Queue-like routes can contribute when resolved and current, with their contribution capped before blending.
        </li>
        <li>
          Immediate-bounded, live-direct, and validated-live routes continue to improve the dimension when fresh and
          unimpaired.
        </li>
      </ul>
    </>
  ),
  "7.0": (
    <>
      <p>More proof-style reserve feeds now use timestamped independent evidence instead of weak liveness checks.</p>
      <ul className="list-disc list-inside space-y-1">
        <li>USYC and TBILL now use Chainlink-style NAV oracle reads with verified source timestamps.</li>
        <li>FRAX now reads Frax&apos;s v2 balance-sheet API and maps known balance-sheet assets explicitly.</li>
        <li>USD1 now reads its Chainlink bundle oracle for live reserve size, timestamp, and supply comparison.</li>
        <li>
          The global gate remains strict: proof sources without payload-native freshness stay detail-visible only.
        </li>
      </ul>
    </>
  ),
};
