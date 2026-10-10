import Link from "next/link";
import {
  METHODOLOGY_LINK_CLASS,
  MethodologyFacts,
  MethodologyPreconditions,
} from "../../methodology-shared";

export function SafetyScoresOverview() {
  return (
    <>
      <p>
        Safety Score V10 evaluates Backing, Exit and Economic Control, normally weighted 40%, 35% and 25%.
        It allows only bounded headroom above the weakest included pillar: a strong unrelated pillar cannot erase
        a known weak path. v10.01 stops treating our missing measurements as asset risk. Known peg problems,
        structural constraints, dependency limits and track record still matter; missing-data ceilings do not.
      </p>
      <p>
        Exit compares every admissible route alone and every independently usable pair, then takes the best feasible
        portfolio. The stronger member is primary; its backup adds{" "}
        <span className="font-mono">min(10, 100 − primary score) × backup score / 100</span>. An improving correlated
        alternative cannot displace a better independent pair. Capacity, output, fees, access, settlement and
        shared-resource checks still apply. Cards show selected routes, backup credit and stress-request completion
        separately; standalone route scores are not the Safety Score Exit pillar.
      </p>
      <p>
        Since methodology v9.96, issuer redemption routes honor reviewed explicit stablecoin payouts before the legacy
        fiat projection. Reviewed USDC payouts cover pathUSD, USYC Teller, pUSD and USDO; USDC/USDT payouts cover
        thBILL, MXNB&apos;s conversion rail and StandX DUSD, alongside HLUSD&apos;s existing basket. Unreviewed issuers
        keep the legacy default without inferring a variant parent; USDN is unchanged because current sources do not
        confirm USDC. Tracked payouts need captured price evidence rather than assumed $1 proceeds. A single payout
        at par keeps output quality 100; multiple outputs retain conservative stable-basket quality 80 and the
        weakest-priced component, a 3-point raw route difference at par. Missing output prices remain unresolved.
      </p>
      <p>
        Uniswap V4 retained exact PoolIds are fetched without the subgraph&apos;s TVL floor and bypass its indexed-TVL
        2% affinity guard; positive indexed TVL and the affinity guard remain required only for token/fee fallback.
        Positive retained TVL, currency/PoolKey identity, zero hooks, active liquidity, independent price references
        and existing quote/capacity gates still apply. The trigger was thUSD/USDC&apos;s -$222,031.94 indexed TVL.
        The seven affected pool assets are thUSD, USDD, USDT, USDS, USP, AUDM and sUSDD. Identity admission is not
        depth: at Ethereum block 26088713, a $1,000 thUSD sell returned $966.94. Standalone Liquidity Score arithmetic
        and retained TVL/volume are unchanged.
      </p>
      <p>
        As curation context, thUSD now uses an executed stablecoin-redeem rail consistent with USDe, with measured
        Cash Wallet capacity from the theo-thusd-redemption adapter and no fallback. This adds no scoring rule.
        On the frozen replay of generation report-cards:9.94:1790752511 at clock 1790752628, only thusd-theo moves,
        from 38/F to 43/D from its configuration, with no quarantines. That capture still contains the old issuer-api
        observation and lacks thUSD&apos;s live-reserve fallback observation. Payout and V4 effects require the first
        production redemption and DEX cycles: the reviewed payout assets and seven V4 pool assets are movement
        candidates, not guaranteed score or grade improvements.
      </p>
      <p>
        Since methodology v9.5, the binary $100K materiality gate uses producer-measured executable notional before
        output-value retention. Retention still discounts continuous capacity and output quality, so impaired proceeds
        remain penalized without being charged a second time at the threshold. Aggregate TVL and volume still do not
        substitute for an executable route.
      </p>
      <p>
        Settlement ceilings require a dated current source for the completed endpoint, not a processing target,
        average or cooldown. Exact-route reviews naming missing capacity, cost or settlement remain gaps even
        beside captured numbers, unless newer admitted exact evidence proves that same rail and request.
        Costs are request-specific; issuer zero and fee floors do not establish all-in ceilings.
        Unresearched or undisclosed whole-exit uncertainty remains bounded at 35 where policy permits it, not
        measured zero or an Exit-wide ceiling. Proven pipeline/curation gaps are excluded. Redemption fee
        reviews do not close independent DEX portfolio coverage, and exhaustion still needs complete evidence.
      </p>
      <p>
        Equal-score route ties and every other canonical V10 array use locale-independent JavaScript code-unit order.
        The same facts therefore select the same primary and backup routes, dependency paths, ordered traces, and
        digest inputs on every runtime host. This ordering can rotate identity or provenance where an older locale
        collated a non-ASCII or case-sensitive key differently, but it does not change numeric score or grade math.
      </p>
      <p>
        We classify why evidence is missing: A, our pipeline was unavailable; B, the required current data is public
        but we have not curated it; C, research found the issuer does not disclose it; U, not yet researched;
        D, a measured adverse fact. A/B exclusion needs proof for that asset and question, not just a missing value.
        U is never labelled issuer silence. Unknown values do not prove safety, failure or zero loss.
      </p>
      <p>
        Proven A/B components do not score and carry a visible “Partial evidence: pipeline gap” flag.
        If one whole pillar is excluded, the other two weights are renormalized. If two or three are excluded,
        we show Pipeline gap with no score or grade—not NR and not a one-pillar rating. Known restrictions and
        measured problems remain charged even beside a gap. Measuring a formerly excluded weak pillar can lower
        a partial rating because coverage has changed.
      </p>
      <p>
        For C/U, quality credit is no lower than before v10.01 and no lower than the weakest comparable ordinary
        disclosed rung; existing uncertainty charges and discounts remain. This does not guarantee every disclosure
        raises a score: cost, holder, topology, some route defaults and wrapper charges retain explicit exceptions
        where a genuinely weaker measurement scores lower. There are no missing-data whole-score ceilings.
        Evidence-based NR counts U as C. A pillar must still be limited by its pre-v10.01 evidence predicate after
        A/B relief and have a real compiled witness; a newly tagged bounded component alone does not qualify.
        A computed F without measured adversity is still withheld, explained as “Score below the F threshold
        without a measured adverse fact”.
      </p>
      <p>
        Exit shows observation, model and capacity-method confidence separately. Positive method identity maps to
        its tier: live-direct is 1 and same-run verified live queue/proxy is 0.75. Known queue delays and liquidity
        limits still count. A proven-empty, reconciled route surface is measured adverse D, not an unknown gap.
        A confidence gap caused by our pipeline or curation does not discount the asset, but this never makes stale
        capacity current or admits an invalid execution certificate. Issuer/unresearched uncertainty and genuinely
        weaker models still apply. Unknown holder terms are not verified eligibility; an unevaluated public fee
        formula is not a zero fee. Dynamic immediate redemption rails require current on-chain or protocol-API
        open status for credit even when their producer marks them unscored. Frozen documented costs cannot
        override a current unquantified review. Wrapper A/B gaps do not trigger form fallback charges; C/U eligibility follows
        cause, not a legacy disposition label. Allocation reviews resolve U custody/reuse, while other eligible
        local gaps keep existing charges and no missing proof grants risk-transfer credit.
      </p>
      <p>
        Live reserve percentages are scoring weights, not identities. A namespace-qualified stable source key joins
        an adapter-owned reserve category to reviewed classification and dependency metadata across rebalancing or
        label changes. Explicit keys must match uniquely and otherwise fail closed; historical unkeyed captures retain
        a unique normalized-name compatibility join.
      </p>
      <p>
        The live-reserve/redemption closure preserves original freshness mode, invalid-source diagnosis and
        matching configuration identity in new accepted generations. A failed or future fetch cannot become
        fresh evidence, and direct controller observations do not upgrade reserve composition. Required typed
        route identity separates the observed rail from its producer key; independent-resource checks prevent
        Reservoir&apos;s shared PSM cash from being counted three times. Pillar weights, stress requests,
        portfolio thresholds and grade gates are unchanged.
      </p>
      <p>
        Classification research lasts 365 days; composition has its own clock. Named-firm attestations, audits and
        examinations can be admitted for 120 days inclusive from the report&apos;s as-of date, at their actual assurance
        strength. A named attestation is not promoted to an audit. Scope, chronology, source and fingerprint checks
        remain strict; unnamed generic curated composition keeps the 31-day window plus 7-day grace.
        Neither a later review nor publication refreshes old holdings.
      </p>
      <p>
        Since methodology v9.31, curated collateral links share the reserve-envelope admission gate. When no live
        reserve slices exist and the curated composition is stale or otherwise inadmissible, the dependency overlay
        publishes no curated basket edges; the existing reserve-envelope gap carries the bounded consequence instead
        of an unrelated unreviewed-dependency reason. Admissible curated reviews, live-derived edges, and manual
        dependency reviews remain unchanged.
      </p>
      <p>
        Since methodology v9.49, variant parents, explicit wrapped-asset claims, and manual non-collateral
        relationships survive independently of reserve composition. Unmapped live reserves still cannot restore
        older curated or manual collateral weights. Dependency facts distinguish unmatched identities, expired
        matching classifications, and explicitly reviewed non-links. Curated reserve fallback applies only when
        there is no live composition; partial live mappings retain their live weights.
      </p>
      <p>
        Since methodology v9.95, a live reserve link must agree with its reviewed upstream identity and relationship
        kind; conflicts withhold the link rather than silently choosing one. Keyed zero-balance rows remain evidence
        but never create reserve-derived edges. Intermediary annotations identify a bridge, wrapper token, or vault
        share without creating another measured holding. Serial mechanism claims inherit the required parent&apos;s
        final score: Spark&apos;s native-asset and USDS parents both apply, so the weaker parent limits the claim.
      </p>
      <p>
        Since methodology v9.97, reserve producers reconcile reviewed nested holdings, correct immediate claim
        identities, and preserve positive measured dust without display rounding. Pooled holdings do not create
        token-specific dependencies without attributable backing and tranche loss allocation. Producer recovery
        does not bypass evidence admission: weak probes, unverified freshness, and reconciliation failures retain
        their existing gates. Optional report-v6 multi-asset common-mode groups reference existing priced effects
        without adding a penalty. Scoring weights and materiality thresholds are unchanged.
      </p>
      <p>
        Since methodology v9.98, authored linked reserve rows require an explicit relationship kind. Legacy live
        rows may inherit only a unique reviewed kind for the same coin identity; unresolved or conflicting kinds
        withhold that row&apos;s link rather than silently treating it as collateral. Other rows remain available,
        but cached legacy withholding can change backing and downstream scores until typed producer rows arrive.
        Historical reserve evidence is not refreshed by adding a kind. Mento separates native and bridged holdings
        while retaining their canonical parents; USDat&apos;s PYUSDx and Frankencoin&apos;s ysyBOLD are intermediary
        annotations, not additional holdings. Representation identity verification does not establish independent
        bridge solvency assurance. Avant discloses measured gross-positive-long holdings and separate debt and NAV,
        but withholds tracked links until exact token, receipt, and bridge claims are joined. Labels do not establish
        identities, and gross shares are not leveraged net-NAV loss coefficients. Diagnostic fixture replacements
        are not production freshness evidence or score forecasts.
      </p>
      <p>
        A current established circulating amount can size the Exit stress request even when its chain or bridge
        partition is unresolved. This sizes the request only: it does not invent bridge shares, transfer scope,
        control safety or executable capacity. Unknown, stale or unavailable amounts still cannot size it.
        Route valuation, cost, access and settlement admission remain; missing bridge evidence now follows the
        cause-aware rules rather than a generic missing-data ceiling.
      </p>
      <p>
        We keep independently identified reserve holdings instead of rejecting an entire reviewed composition
        because an unclassified tail exceeds 0.1%. Each remaining share carries its own cause. Researched or
        unresearched uncertainty is bounded; measured adverse holdings keep their measured treatment; proven pipeline
        or curation gaps receive no scoring weight. Original whole-asset shares and unknown tails remain visible—only
        scoring weights can be renormalized. Exposure and dependency shares are never rescaled to pretend the book
        is complete, and a defensible whole-book denominator is still required.
        Inherited parent Backing replaces only unknown local defaults: known local class, liquidity and source
        strength still bound it, with missing factors at their best ordinary rungs. An empty issuer/obligor census
        scores concentration at bounded-unknown 35, not diversified 98. A missing obligor affects only concentration,
        never a reserve row&apos;s class quality.
      </p>
      <p>
        Since methodology v10.10, a reserve liquidity or maturity factor is known when the existing evaluator&apos;s
        selected current bound fully determines that exact exposure. Every supporting reference remains attached;
        a raw unknown horizon or maximum stays null rather than becoming a fictional number. Partial bounds are
        never summed, and a selected stronger partial bound cannot borrow a weaker full bound&apos;s coverage.
        Stale, future, rejected, unmatched and nonbinding evidence keeps its gap. Quality ladders, weights,
        applicability and scores do not change.
      </p>
      <p>
        Responsibility follows validated evidence about the exact missing question, not the nearest processing stage
        or a compiler&apos;s default label. A pipeline verdict binds the captured source and generation.
        Public-but-uncurated and researched-undisclosed classifications retain dated primary sources; otherwise the
        question is “Not yet researched”. Inherited gaps preserve their originating causes and evidence identities.
        Every attributed root receives a causal-root-qualified score path, so adding another root cannot rename an
        existing public fact; ownership never becomes part of fact identity. Since methodology v9.46, a bridge control
        whose controlling party is an external message-validation quorum — a LayerZero DVN set, a Chainlink CCIP DON/RMN,
        a Bantu AMTP validator
        group — is graded as the known, weak authority it is instead of compiling as unknown and publishing an
        issuer-owned unresolved-control gap for a fact the issuer had published. The rung grades at or below a named
        issuer backend and never above a named multisig: naming a validation domain cannot lift a control, and a
        route co-controlled by an unattested single key still reports that key as its weakest link.
        A reviewed unpriced output is not automatically a pipeline failure: the missing valuation needs its own
        cause proof, and never becomes assumed par proceeds. Date-only dispositions enter replay only after their
        reviewed UTC day. Partial control reviews retain the controls that
        were actually reviewed while unresolved surfaces remain bounded and fail closed. Strategy-vault wrapper
        loss-control facts can use those reviewed local controls as wrapper evidence. Methodology v10.0 grants no
        parent first-loss or risk-transfer credit, even for documented backstops. Activating that credit requires a new
        evidence lane, reviewed intake, a review window, and a methodology change. Subthreshold unrecognized chain-label
        supply pools are tolerated by the bridge-materiality proof and no longer surface as public
        evidence-responsibility facts; material unmatched bridge supply still fails closed. Unsupported coverage
        needs a captured reader-boundary proof for A exclusion; otherwise the unresolved question remains U.
        Since methodology 9.2, a populated DEX exit surface is complete for gap accounting once its budgeted
        score-eligible routes are observed; leftover target-construction and reviewed model-limit gates on other
        recognised venues are not a data-feed failure. Exact-route scoring completeness stays strict.
        Measured adverse peg history retains its own treatment; missing current price remains a separately
        cause-bearing observation and its deviation is never coerced to zero.
      </p>
      <p>
        Since methodology v9.94, the XAUT lock/mint group attribution reconciles Tether&apos;s daily disclosure to
        finalized Ethereum state on the circulating liability alone: total supply minus the treasury balance must equal
        the disclosed authorized minus not-issued amount. Unissued treasury inventory is not a liability, so a
        treasury-only mint or burn after the disclosure changes both terms equally and no longer rejects the
        attribution; a circulating mismatch, a treasury balance above total supply, non-zero quarantined supply, and
        every identity, freshness, and finalized-block check still fail closed.
      </p>
      <p>
        Since methodology v9.93, a chain whose supply row several reviewed profile routes compete for no longer blocks
        the bridge review when that row is immaterial. The unsplit chain row is an upper bound on every candidate
        deployment&apos;s share, so a row below both the deployment-material and common-mode thresholds, on a chain
        whose candidate routes are all reviewed, is accepted as bounded supply evidence; a material ambiguous row, or
        one with any unreviewed candidate route, still fails closed, and shares are never summed across rows. The
        null-share deployment bound now includes that unsplit chain row instead of reading the unavailable
        within-chain share as zero.
      </p>
      <p>
        Since methodology v9.92, an asset whose intake publishes only an aggregate circulating quantity and no per-chain
        rows no longer bounds that quantity on a bridge gap the control pillar already owns: there is no per-chain
        partition for the bridge-materiality join to be ambiguous about, the state is diagnosed as
        <code className="text-xs">supply-review.unpartitioned-aggregate</code>, and the circulating USD publishes as
        known so the Exit pillar can size a stress request. Bridge-materiality availability keeps its single owner on
        the control pillar (<code className="text-xs">runtime-bridge-materiality-unavailable</code>), while a join that
        ran and failed over real rows, a missing bridge profile, stale input, and a missing or rejected runtime
        attribution packet all still fail closed. The same release attributes a gapless
        <code className="text-xs">missing-same-notional-route</code> — a route the method withholds by design with no
        authored producer gap — to <code className="text-xs">integration-missing</code> instead of
        <code className="text-xs">producer-failed</code>; only an authored causal gap carrying a
        <code className="text-xs">sourceGapId</code> may claim a producer failure, and scores, ceilings, and NR
        treatment are unchanged.
      </p>
      <p>
        Since methodology v9.6, an exhaustive-liability attestation can complete transfer scope for one exact
        active contract with positive admitted aggregate supply and no bridge or wrapper representations.
        Singleton assets and savings-passthrough, risk-absorption, and strategy-vault share tokens qualify;
        pure wrappers, bond-maturity variants, and unspecified variant kinds do not. Scope is explicitly
        attributed, not observed, and no chain amounts are invented. Attestations expire within 365 days;
        every capture rechecks structure, so a second contract or representation route invalidates attribution
        immediately. Freeze and economic-control scope remain independent.
      </p>
      <p>
        Physical delivery alone remains diagnostic. This methodology can compose reviewed gold or silver
        redemption with a modelled in-vault sale to USD for any verified customer. Minimums and bar
        increments constrain the same stress request; all-in costs must not exceed 500 bps (other
        routes retain 200 bps), and output quality and the offchain route ceiling remain 65.
        Published fees and explicit settlement maxima win; unpublished fees and stated typical times
        use conservative, publicly traced policy assumptions at lower confidence. Explicit unbounded
        terms, unstated timing, expired 90-day reviews or missing/stale 24-hour metal references earn
        no credit. Sale costs are charged once, with no metal-price-movement charge; best-effort issuer
        cash-out can qualify independently at lower confidence when its lot, cost and timing are established.
      </p>
      <p>
        Since methodology v9.47, a dependent&apos;s exposure to an upstream with an open reserve gap counts once per
        upstream cause. The backing projection folds the slice-level reasons an upstream raises into one reason per
        projected code, source code, and owner on each dependent exposure, and the slice paths survive in the causal
        key. An upstream on the audited fallback with nine stale reserve slices previously put 18
        <code className="text-xs">bounded-unknown-reserve-exposure</code> facts on every direct holder. On replay of
        <code className="text-xs">capture-20260907-0917.json</code> at clock
        <code className="text-xs">1788772631</code>, open data points fell 1,280 -&gt; 733
        (<code className="text-xs">published-evidence-expired</code> 602 -&gt; 58,
        <code className="text-xs">issuer-undisclosed</code> 354 -&gt; 351), 30 assets changed fact counts, 0 scores
        moved, 0 grades flipped. No evidence was added.
      </p>
      <p>
        Since methodology v10.10, open data points count distinct evidence obligations on each card, not the number
        of scoring explanations. Multiple reasons or paths tied to the same exact source gap count once under the
        same responsibility owner. A source-less causal view aliases it only when its single exact root is already
        counted as a source on that card under that owner. All scoring witnesses, caps and not-rated explanations
        remain visible. Unmatched inherited roots, synthetic facts and multi-root views remain separate; nothing is
        deduplicated across cards. Critical counts retain any critical witness and reason lists retain every code.
        This accounting correction adds no evidence and changes no score.
      </p>
      <p>
        Since methodology v9.461, two evaluator mapping defects are corrected without adding evidence. First,
        reviewed-native selected supply rows no longer enter the bridge-exposure completeness join:
        <code className="text-xs">evaluateV9SubthresholdUnresolvedBridgeJoins</code> excludes them from
        <code className="text-xs">bridgeControlsByDeployment</code>, while the route predicate and native-liability
        boundary keep native controls as umbrella facts and exclude native route ids from
        <code className="text-xs">bridgeClaimControls</code>. On replay of
        <code className="text-xs">capture-20260904-1100.json</code> at clock
        <code className="text-xs">1788509806</code>, this corrected a wrong join and closed 9 facts
        (<code className="text-xs">nonmaterial-bridge-supply-unmatched</code> on
        <code className="text-xs">ausd-agora</code>, <code className="text-xs">pyusd-paypal</code>,
        <code className="text-xs">reusd-re-protocol</code>, <code className="text-xs">usbd-bima</code>,
        <code className="text-xs">fusd-finchain</code>, <code className="text-xs">cusd-celo</code>,
        <code className="text-xs">frxusd-frax</code>, <code className="text-xs">usdy-ondo-finance</code>, plus
        <code className="text-xs">missing-bridge-route-rows</code> on
        <code className="text-xs">fusd-finchain</code>), with 0 replacements and exactly 1 mover:
        <code className="text-xs">fusd-finchain</code> NR -&gt; 46/D. Floors, the completeness predicate, and
        <code className="text-xs">unknownBridgeShare</code> are unchanged; Pharos learned nothing new.
      </p>
      <p>
        Second, offchain-issuer commodity routes whose
        <code className="text-xs">outputAssetType</code> is
        <code className="text-xs">bluechip-collateral</code> (physical GOLD/SILVER delivery) now resolve as
        <code className="text-xs">unresolved-asset</code> rather than fiat. The old mapping let
        <code className="text-xs">buildOutputReview</code> imply a synthetic $1 value for a physical bar; removing
        that false valuation ADDED 5 facts
        (<code className="text-xs">unresolved-exit-output</code> and
        <code className="text-xs">missing-runtime-route-evidence</code> on
        <code className="text-xs">gldt-gold-dao</code>, <code className="text-xs">paxg-paxos</code>, and
        <code className="text-xs">xnk-kinka</code>) and moved 2 grades:
        <code className="text-xs">gldt-gold-dao</code> 47/D -&gt; NR and
        <code className="text-xs">xnk-kinka</code> 41/D -&gt; 39/F. This is an honest loss of false coverage, not a
        newly learned adverse fact. The affected asset set is
        <code className="text-xs">cgo-comtech</code>, <code className="text-xs">dgld-gold-token-sa</code>,
        <code className="text-xs">ggbr-goldfish-gold</code>, <code className="text-xs">gldt-gold-dao</code>,
        <code className="text-xs">gldy-streamex</code>, <code className="text-xs">kag-kinesis</code>,
        <code className="text-xs">kau-kinesis</code>, <code className="text-xs">paxg-paxos</code>,
        <code className="text-xs">pgold-pleasing</code>, <code className="text-xs">xagm-matrixdock</code>,
        <code className="text-xs">xaum-matrixdock</code>, <code className="text-xs">xaut-tether</code>, and
        <code className="text-xs">xnk-kinka</code>. Both effects are measured on that fixed capture; producer-side
        repairs in these waves cannot manifest until a real producer cycle runs.
      </p>
      <p>
        Expired evidence stays dated history. Expiry is not proof the issuer is silent, nor that newer required data
        is public. Current cause proof decides whether the gap is pipeline, uncurated public data, researched
        non-disclosure or not yet researched. Known active adverse facts are not cleared by an expired positive
        review, and favorable parent inheritance still needs current whole-allocation proof.
      </p>
      <p>
        Governance access posture treats a reviewed global mint-domain contract as immutable when it has no privileged
        capabilities, no applicable cap, no claim-impairment path, and access-only scope. A contract address alone
        identifies protocol machinery rather than a concentrated administrator; deployment-scoped bridge controls
        remain separate.
      </p>
      <p>
        Economic Control treats oracle applicability separately from oracle quality. A reviewed path with no
        price-sensitive oracle or internal valuation authority is not applicable and contributes no scored component.
        If no other binding control remains, the neutral empty set resolves to 95 without manufacturing a display row.
        A genuinely oracleless mechanism scores 95, while privileged internal pricing scores 45; a top-level mint,
        redemption, NAV, or exchange-rate authority can therefore be evaluated without inventing borrower liquidation
        branches. External oracle tiers keep their existing scores.
      </p>
      <p>
        Methodology v9.4 applies that distinction to stale pre-v9.17 reviews: the absence of borrower liquidation
        branches does not make a top-level mint, redemption, NAV, or exchange-rate authority non-applicable. Verified
        adverse oracle evidence remains measured adverse, unresolved applicability remains bounded, and a genuinely
        price-insensitive mechanism remains neutral.
      </p>
      <p>
        Control scope follows the liabilities an admitted control can reach. Known deployment-local controls need
        a complete reconciled supply partition for proportional pricing; no gap creates deployment shares or proves
        native issuance. Proven A/B uncertainty is excluded and C/U stays component-bounded, without the former
        control-unverified whole-score ceiling. Known adverse/root-reaching controls keep their actual constraints.
        Common-control census still counts independent root liabilities, not extra wrapper copies. Chain
        maturity is a dated five-gate review requiring 36 months of continuous production history,
        a 365-day liveness record, permissionless participation or at least 21 independently operated block producers
        or finality members, no unilateral instant change path (with L2s at Stage 1 or later and at least a 7-day holder
        exit), and documented bridge or data-availability dependencies with a holder exit. Cardano, Gnosis, Hedera,
        Rootstock, Sui, Conflux, and Kaia are the seven newly admitted chains; Celo remains excluded.
      </p>
      <p>
        Reviewed incidents are routed into the control, wrapper-local, operational, or peg component that owns the
        risk, with root-claim, deployment, integration-only, or holder-exit scope. Active, mitigated, and resolved
        evidence therefore changes an existing component without creating a fourth pillar or charging an event beyond
        the affected liability.
        Since methodology v10.10, independent researched-negative incident reviews can resolve only a matching
        unknown control incident state. They require dated issuer/status evidence, exact-deployment event history
        and an independent incident-tracker search, with source excerpts, an honest researched window and reviewer
        identity. Both review and window end must remain current; date-only reviews wait until their UTC day ends.
        Exact deployment/control-kind reviews never resolve global controls. Actual incidents retain precedence,
        an empty registry or audit alone proves no absence, and unrelated authority or custody gaps stay open.
      </p>
      <p>
        Publication remains fail-closed: global or invalid-identity state holds the last accepted publication.
        Attributable asset-local producer failures are technical pipeline gaps, never fabricated issuer NR or
        measured danger. Current consumers use the accepted publication and status, not a fallback scorer.
      </p>
      <p>
        Since methodology v10.12, exact orderbook execution is research-only with diagnostic certification.
        The dormant Kraken request observer is retired: a public book does not prove same-run account access,
        deposits, withdrawals, fees or maximum settlement. Ordinary exchange spot prices remain separate evidence;
        Liquidity v6.93 excludes synthetic CoinGecko books while Pricing v6.44 retains price-only ticker evidence.
        Reviewed Securitize and synchronous ERC-4626 routes keep their existing admission. The Safety formula is
        unchanged and improved Safety Score stability is unmeasured. A neutral captured-input replay is required before
        release, not assumed.
      </p>
      <p>
        The same release preserves source-native reserve quantities and original clocks: CAD/QCAD and GBP/tGBP
        are not USD, and an ETH supply check does not refresh an entire reserve. Ratios without a reviewed
        reserve-versus-circulation time allowance are withheld. BC3M now has a source-reviewed inclusive
        86,400-second allowance from its own Chainlink heartbeat and Backed daily/10% reporting disclosure,
        applied to every pinned circulation block. Its ratio requires complete same-run inventory-adjusted
        on-chain circulation/API reconciliation and is withheld beyond that allowance. Original clocks remain;
        this is not simultaneous reserve/liability attestation, production observation or scoring activation.
        BIB01 remains quarantined with no policy change, and no TUSD allowance is borrowed.
        Reserve snapshots no longer invent redemption
        terms or capacity; actual River exits and Origin vault/redemption remain. Static/weak source evidence
        does not activate independent scoring. MYRC retains its upstream released independent-assurance adapter
        and original report clocks, with no further promotion in this release. Fresh admitted inputs can change
        availability or scores and require their own attributed comparison.
      </p>
      <p>
        Methodology v10.14 follows the reverted v10.13 release without reusing its version. Pipeline-gap
        diagnostics and partial-evidence flags remain visible, while expired mechanism research degrades
        without quarantining the asset. Supply observers require complete provider proof; non-exhaustive
        DEX emptiness cannot certify absence, and completed census outcomes survive a discovery tail timeout.
        Fresh admitted census and deployment-supply evidence are still required to close coverage gaps.
      </p>
      <p>
        Reviewed bridge-representation identities can support exhaustive wrapper identity reviews without
        changing native Mint Authority ownership or granting immutable credit to proxies. Local-fiat charges
        and outputs use admitted captured FX, never fetched or assumed rates; incomplete fee schedules stay
        gaps. Date-only route reviews wait until the next UTC midnight. Oracle uncertainty binds its actual
        tier witness, and the transfer census uses bounded whole-asset admission and source-clock rotation;
        deferred deployments remain unknown. Pillar weights, grade gates and evidence freshness are unchanged.
      </p>
      <p>
        Methodology v10.15 corrects score-moving evidence admission: excluded dependency events no longer
        dilute measured loss or uncertainty, and binding limits keep their measured-adverse causes through
        subsequent dependency hops. Measured certificate costs at the exact request budget receive zero
        cost credit. Global no-exit findings require current exhaustive deployment coverage reconciled to
        aggregate supply, with each deployment observation independently fresh.
      </p>
      <p>
        USDtb shortfalls and unreadable Reserve Protocol plugin status cannot establish clean independent
        backing. Incomplete JupUSD holding units withhold whole-book totals, while malformed Sky group debt
        rejects the shared DAI/USDS book. Quote-quality warnings and original reserve clocks remain admission
        gates. Removing inactive F settings rotates policy identity but does not change active F admission,
        pillar weights or grade gates. Fixed-clock replay, mover attribution and owner review are required
        before release; this version does not claim completed replay or new producer observations.
      </p>
      <p>
        Methodology v10.16 aligns track record with the newest required implementation layer across a variant
        and its parent chain, using each layer&apos;s implementation launch date or product launch fallback.
        Year, month, quarter and half-year dates use the inclusive period end, capped to the fixed scoring UTC
        date so an unfinished period claims zero whole months. Cycle detection stops repeated traversal.
        The whole-calendar-month age calculation and its thresholds are unchanged; corrected launch inputs
        can still move scores, grades or availability. Fixed-clock replay and mover review remain release gates.
      </p>
      <p className="text-xs text-muted-foreground">
        See also:{" "}
        <Link href="/methodology/scoring-changelog/" className={METHODOLOGY_LINK_CLASS}>Safety Score changelog</Link>
        {" · "}
        <a href="#pegscore-dews-methodology" className={METHODOLOGY_LINK_CLASS}>PegScore + DEWS</a>
        {" · "}
        <a href="#liquidity-methodology" className={METHODOLOGY_LINK_CLASS}>Liquidity Score</a>
        {" · "}
        <a href="#infrastructure-methodology" className={METHODOLOGY_LINK_CLASS}>Infrastructure</a>
      </p>
      <MethodologyFacts
        facts={[
          { label: "Model shape", value: "3 pillars + bounded aggregation" },
          { label: "Grade output", value: "A+ to F; NR and Pipeline gap are distinct" },
          { label: "Publication state", value: "Current or held; never V8 fallback" },
        ]}
      />
      <MethodologyPreconditions
        facts={[
          { label: "Minimum data", value: "At least two included pillars for a score; scoped cause proof for exclusions" },
          { label: "Required sources", value: "Backing, exit, control, peg, dependency, and evidence-provenance inputs" },
          {
            label: "Failure behavior",
            value: "Technical gaps have no score/grade; NR needs causal evidence gates; global failures hold accepted state",
          },
        ]}
      />
    </>
  );
}
