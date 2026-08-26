import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const SAFETY_SCORE_V9_UNPROVEN_SETTLEMENT_BOUND: MethodologyChangelogEntry = {
  version: "9.45",
  title: "Unproven settlement bounds become bounded exit evidence gaps",
  date: "2026-08-26",
  effectiveAt: 1787702400,
  summary:
    "An open operator-batched redemption request queue whose settlement completion bound is unproven is a bounded exit evidence gap, not a measured zero. Exit floors at the bounded-unknown score, the final score remains subject to the exit-unverified ceiling, and the public card carries an explicit warning; the standalone redemption route is unrated because its capacity is missing.",
  impact: [
    "The new `unproven-settlement-bound` reason code is owned by Exit and globally bounded: the Exit pillar floors at the policy bounded-unknown score, the existing exit-unverified ceiling applies, and the public label is `Redemption is an operator-batched request queue with no proven settlement bound`.",
    "The v9.44 measured-zero ruling is unchanged. This corrects its input: an observer-synthesized zero standing in for an unproven completion bound is bounded uncertainty, not a measurement.",
    "The eearn-ember operator-batched queue observer now publishes `unproven-settlement-bound` instead of a synthesized measured zero.",
    "The standalone redemption route score for this shape is unrated (missing capacity) rather than zero.",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_EXIT_CAPACITY_TRUTH: MethodologyChangelogEntry = {
  version: "9.44",
  title: "Measured zero-capacity exits remain attributable",
  date: "2026-08-26",
  effectiveAt: 1787702400,
  summary:
    "Exit no longer discards a fully observed issuer or protocol redemption route merely because its executable capacity is zero or below the first material breakpoint. The route remains the attributable primary evidence with a zero route score, its measured capacity and confidence stay public, and a zero pillar emits the explicit no-viable-exit-path reason. Atomic protocol redemptions are no longer misclassified as inherently delayed when deciding whether discounted evidence can receive credit.",
  impact: [
    "A known zero or immaterial redemption route is retained as measured evidence instead of being relabeled unsupported-same-notional-route. Its score remains zero, so the change repairs attribution and explanation rather than granting exit credit.",
    "The public trace preserves executable capacity, modeled-request completion, confidence, and the binding zero-capacity cap for both the primary route and alternatives. Zero completion is displayed as 0% rather than being omitted.",
    "A zero Exit pillar publishes no-viable-exit-path even when an older producer omitted the reason, preventing cards with a numeric zero and F grade from presenting a blank explanation.",
    "Protocol redemption timing now follows the route's admissible reviewed settlement model. Favorable terms retain the existing 365-day evidence expiry; conservative corrections remain durable. Atomic protocol routes remain eligible for atomic treatment, while queued or delayed routes retain the existing discount and horizon rules.",
    "On the pre-release production snapshot, nine cards had Exit 0 and four of those paired it with a standalone redemption headline of at least 50. This release removes that semantic contradiction through the paired redemption-backstop v4.39 capacity and settlement correction; it does not infer capacity where none was observed.",
    "wsrUSD is the only observed grade change on the pre-release production snapshot: its measured $74,992.50 executable capacity is immaterial against the $10 million modeled request, moving Exit from 35 to 0 and the overall score from 45 (D) to 19 (F).",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_TETHER_DISCLOSURE_FRESHNESS: MethodologyChangelogEntry = {
  version: "9.43",
  title: "Tether transparency uses the measured disclosure cadence",
  date: "2026-08-25",
  effectiveAt: 1787664000,
  summary:
    "The `tether-transparency` adapter now uses the existing 7-day disclosure source-age tier instead of the 3-day dashboard tier. The retained 30-day history contains 24 upstream publications with a 1.00-day median gap and a 3.00-day maximum from the recurring Friday-publish/weekend-skip pattern; that gap landed exactly on the old bound with zero margin, and the 2026-08-16 shift from 01:00Z to 23:30Z consumed the remaining margin. The last publication was 2026-08-21T23:30:02Z, and the first production breach was detected at 2026-08-25T00:11:34Z when warning_count rose from 1 to 2. This is a live-reserve admission policy change, not evaluator arithmetic.",
  impact: [
    "The seven-day tier accepts the adapter's `collateralizationRatio`, `totalAssetsUsd`, `totalLiabilitiesUsd`, and chain details up to seven days old. Reserve-category percentages remain curated in `liveReservesConfig.params.slices` and do not age with the feed, so the widened clock applies only to the upstream totals and chain details.",
    "Those totals are currently unscored for a `fiat-cash` asset. The bound therefore protects whether the live snapshot retains `strong` backing evidence rather than assigning points to an otherwise unscored number; for `usdt-tether`, retaining the live path keeps the policy-declared market-anchor premium eligible instead of entering the adequate audited fallback ceiling.",
    "The adapter declaration is shared by `usdt-tether` and `xaut-tether`. A fixed-input replay cannot observe this producer-admission change because `liveToFallbackCoins` is captured before evaluation: the 2026-08-25 production capture remains byte-identical with zero score or grade movers. The next live capture can retain a source aged 3.36 days instead of emitting `stale-source-data` and falling back.",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_AUDITED_STALE_RESERVE_CEILING: MethodologyChangelogEntry = {
  version: "9.42",
  title: "A stale audited composition keeps an adequate ceiling, not a limited one",
  date: "2026-08-25",
  effectiveAt: 1787660000,
  summary:
    "An independently attested reserve composition that is no longer current was priced identically to a partial review: both floored the backing evidence level at `limited`, capping the asset at 69. A complete composition signed and reconciled by an independent attestor is stronger evidence than a partial one even after it ages, so it now carries its own reason with the `adequate` ceiling the policy declares. The evaluator also stops flooring every ceiling reason at `limited` and honours the level each reason declares, which made an existing `adequate` declaration reachable for the first time.",
  impact: [
    "`reasonClassifiedEvidenceLevel` read `limited` for any ceiling-treatment reason, ignoring the per-reason `ceilingRule.level` the policy already carried. `missing-latest-assurance-report` declared `adequate` and could never reach it, because the implied 69 evidence ceiling always bound below the reason's own 84. The declared level is now used and the weakest declared level still wins; replay shows this alone moves nothing, because every affected card also carries a `limited`-declaring reason",
    "A stale exposure whose composition was admitted through the audited fallback emits `stale-audited-reserve-composition` instead of `partial-reserve-review`, with a ceiling at the `adequate` rung and public copy that says the audited composition is not current rather than implying the review was incomplete",
    "The ladder for a stale upstream feed is now graduated rather than a cliff: a current feed scores normally, a stale feed with an independently audited composition is capped at the adequate rung, and no admissible composition at all still falls to the reason-coded floor",
    "Three assets become rateable that were previously withheld as `insufficient-evidence`: brla-brla-digital to 51/C-, sbc-brale to 50/C-, and wars-argentine-peso to 47/D. This is a deliberate consequence rather than a side effect: if an audited composition is adequate evidence for a ceiling it is also adequate evidence for rateability, and treating the same fact as adequate for one and limited for the other would be incoherent",
    "On the fixed-input release replay 3 assets move and 3 change grade, all from NR into a rated band. No previously rated card moves",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_AUDITED_RESERVE_FALLBACK: MethodologyChangelogEntry = {
  version: "9.41",
  title: "A stale reserve feed degrades backing instead of erasing it",
  date: "2026-08-25",
  effectiveAt: 1787640000,
  summary:
    "An issuer without prudential supervision could publish an independently attested reserve composition and still be reported as having no reserve composition at all, because admission required supervision and the asset's only other source was a live feed. One upstream feed going stale then removed an entire backing pillar. Such a composition is now admitted one rung down, as static-validated evidence under the shorter composition window, and it keeps the issuer attribution so an expired document is reported as expired rather than undisclosed.",
  impact: [
    "Admission and strength are separated: an independent audit is evidence about the reserves, prudential supervision is evidence about the issuer. Supervision no longer decides whether a composition is admitted, only the rung it enters at. An unsupervised issuer's audited composition enters as `static-validated` and can never reach `independent` strength through this path, so the supervision gap still costs the asset its ceiling",
    "The rung is reachable only where a live reserve producer was observed returning nothing for that capture. An asset with no live producer keeps the existing standalone path, and an asset whose producer is excluded from falling back is not rescued",
    "Audited fallback evidence is emitted with the report's own publisher and dates instead of as an anonymous standalone review, and it carries the 31-day composition window plus the 7-day reporting grace rather than the 365-day audit window it was admitted under, so the rung degrades as the composition ages",
    "Because the publisher is retained, a lapsed composition now resolves to `published-evidence-expired` rather than `issuer-undisclosed`. The public copy for that value stops stating that an issuer has not disclosed reserves it did in fact publish. Unknown provenance continues to fail closed",
    "On the fixed-input release replay, 8 assets move and 6 change grade, all upward: fdusd-first-digital, xagm-matrixdock, vnxau-vnx, tryb-bilira, wcop-ripio, and wmxn-ripio flip, with audx-aussie-dollar-token and wbrl-ripio moving inside their grade. Every mover has a live producer that was observed falling back",
  ],
  commits: ["a1034c254"],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_EVIDENCE_SCOPE_AND_FRESHNESS: MethodologyChangelogEntry = {
  version: "9.4",
  title: "Evidence, scope, freshness, and incidents become explicit",
  date: "2026-08-24",
  effectiveAt: 1787594024,
  summary:
    "Safety Score V9 replaces several broad assumptions with reviewed, scope-aware evidence. Exit terms must be established for the scored request, reserve classification and composition age independently, chain maturity follows a dated five-gate review, local controls are charged to the liabilities they can reach, and reviewed incidents enter their owning risk domain. The release also corrects stale oracle-applicability dispositions and distinguishes expired published evidence from issuer non-disclosure. Scores move in both directions because better evidence can remove a conservative penalty while adverse or missing evidence can lower or withhold a rating.",
  impact: [
    "A favorable faster-settlement term can replace the conservative default only when the exact delay has a review date and source; a conservative correction can still lower credit without asserting a favorable promise. A route whose stress capacity, settlement, or cost is not established receives the explicit bounded-terms-gap disposition: valid partial facts remain visible, but the route is excluded from primary and diversification credit and ordinary uncertainty cannot manufacture a measured-danger F",
    "Reserve classification remains admissible for 365 days, while reserve composition uses a 31-day window plus a fixed 7-day reporting grace. The clocks apply to live overlays as well as curated fallback rows, so an expired classification cannot remain score-bearing merely because a live adapter supplied percentages",
    "Chain maturity is now a dated quarterly review with five fail-closed gates: 36 months of continuous production history; a 365-day liveness record; permissionless participation or at least 21 independently operated block producers or finality members; no unilateral instant change path, with L2s at Stage 1 or later and at least a 7-day holder exit; and documented bridge or data-availability dependencies with a holder exit. Cardano, Gnosis, Hedera, Rootstock, Sui, Conflux, and Kaia are admitted; Celo remains excluded after its security-model migration and failed continuity, change-control, and dependency/exit gates",
    "Oracle applicability now preserves the V9 distinction between a top-level price authority and a genuinely non-applicable path. Stale pre-9.17 dispositions were reviewed asset by asset: a mint, redemption, NAV, or exchange-rate authority is scoreable without fabricated borrower-liquidation branches, while verified adverse evidence and bounded uncertainty retain different cap treatment",
    "A reviewed control that reaches only one deployment is charged proportionally when its liability partition is complete and reconciled; unresolved or root-reaching controls remain global. Common-control thresholds now count independent root liabilities rather than wrappers or derivatives, same-issuer controls remain diagnostic, and corrected Mento issuer attribution removes a manufactured cross-issuer failure domain",
    "The evidence-responsibility vocabulary adds `published-evidence-expired` for stale issuer- or parent-published material that Pharos has not kept current. Unknown provenance continues to fail closed under the existing fallback, and the new responsibility changes attribution and public copy without directly changing a score",
    "Reviewed incidents are typed as control, wrapper-local, operational, or peg events and enter the existing component that owns the risk rather than creating another scoring dimension. Scope distinguishes root-claim, deployment, integration-only, and holder-exit consequences, and remediation evidence preserves active, mitigated, and resolved treatment",
    "On the fixed-input release replay, 87 assets move and 67 change grade. The mover set contains upgrades, downgrades, newly rated cards, and newly withheld cards, so the release is explicitly not score-neutral",
  ],
  commits: [
    "2f510a8d7",
    "68714f9e2",
    "392d3187c",
    "ca437e069",
    "f07597c45",
    "29839cff9",
    "78a765eb9",
    "bfe391a51",
    "fd62fe2f9",
    "b6735756e",
  ],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_CAP_REASON_PRECEDENCE: MethodologyChangelogEntry = {
  version: "9.35",
  title: "Deterministic cap reasons and locale-independent canonical ordering",
  date: "2026-08-23",
  effectiveAt: 1787500014,
  summary:
    "Safety Score V9 removes two ways the host environment could influence a published result. When two cap candidates share a limit, the specific observed or withheld fact is now published ahead of the generic absence reason instead of letting alphabetical ordering decide. Separately, every canonical ordering and digest input across compilation and publication now uses a locale-independent code-unit comparator rather than host-locale collation. Cap limits and score arithmetic are unchanged.",
  impact: [
    "A specific observed or withheld fact outranks a generic absence reason at equal source and limit. Remaining ties fall through to source priority, then locale-independent code-unit ordering of kind and then reason, so the selection stays total and replay-stable",
    "The candidate dedupe and binding-selection comparators were unified into one ordering function. They previously differed: only the dedupe path applied the final `reason` tie-break, so the two stages could rank identical candidates differently",
    "On the frozen capture replay (clock 1787500014, 337 cards) no score, grade, or cap limit moves. Exactly one binding reason changes: usdaf-asymmetry publishes `peg-supply-floor-withheld` instead of `missing-applicable-peg`, both 60-point evidence ceilings. The diagnostic `caps[]` ordering also changes on 12 cards — bd-basedollar, deuro-deuro, kau-kinesis, krwq-iq, nect-beraborrow, pht-pht, scusd-rings, usdaf-asymmetry, usdu-usdu-finance, usdxl-last, weusd-picwe and xnk-kinka — where a specific peg reason now precedes `missing-applicable-peg`. Every candidate set is identical before and after; only the order moves, and two consecutive replays are byte-identical",
    "Canonical V9 ordering no longer depends on the runtime locale. 44 `localeCompare()` call sites across the dependency, exit, scoped-risk and archetype evaluators and the extension-transfer, publication-assessment and supply-attribution publishers now use the existing locale-independent `compareText()` comparator. Two were demonstrably load-bearing: Exit resolved an equal-score route tie before primary and diversification route identity and the ordered route traces were emitted, and the reviewed-transfer sequence feeding `sha256Hex` made a published digest input locale-dependent. A probe with two equal-scoring Unicode route keys selected different primary and secondary routes under `en_US.UTF-8` than under `sv_SE.UTF-8`",
    "Replaying identical facts can no longer select a different equal-scoring route, reorder a dependency path, or hash a different reviewed-transfer sequence because the host locale changed. Numeric scores and grades are unaffected — this is ordering, not arithmetic — but route and path identity, ordered traces, and their digests can rotate where a previously published non-ASCII or case-sensitive key collated differently from code-unit order. The evaluation-build manifest digest rotates accordingly",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_CAP_AND_EVIDENCE_CLARIFICATIONS: MethodologyChangelogEntry = {
  version: "9.34",
  title: "Cap claims become integral, scope-gated, and explicit",
  date: "2026-08-23",
  effectiveAt: 1787500014,
  summary:
    "Safety Score V9 aligns cap outputs and evidence dispositions with their published meaning: cap limits now live in the integral published score space, unrated cards do not assert binding caps, and a pillar-priced signal needs an asserted residual before it can impose a whole-score cap. Absent wrapper facts stop being treated as issuer non-disclosure, and active-depeg peaks resolve through `pegReferenceId`; the release also records the existing policy-declared USDT market-anchor-longevity premium and its non-inheritable public adjustment.",
  impact: [
    "Candidate cap limits are floored at the published-score funnel before deduplication and selection. Wrapper-local parent measurements remain exact in their own trace, while published cap limits are integral. On the frozen capture replay (clock 1787500014, 337 cards), 0 scores and 0 grades moved; asusdf-astherus 49.55 became 49, susd1plus-lorenzo 43.45 became 43, and susn-noon 61.9 became 61, with no non-integral cap limit remaining",
    "An NR card no longer reports a binding cap because no numeric score exists for a cap to constrain. syzusd-yuzu was the only affected card; rated scores did not move, all 18 NR cards now report `bindingCap: null` with zero binding flags, and their `caps[]` candidates remain available as counterfactual diagnostics",
    "Absent custodyEscrow, leverage, and rehypothecationCorrelation profiles on known pure serial wrappers resolve as `not-applicable` rather than `issuer-undisclosed`; strategy vaults retain the latter when disclosure is genuinely missing, and reviewed leverage 1.0 resolves as reviewed/none. Complete wrapper fact sets rise from 1 to 11 of 56, exactly 6 published scores move, all upward: sdai-sky 75 to 78, scrvusd-curve 68 B- to 71 B, sdola-inverse-finance 51 to 54, susdd-tron-dao-reserve 38 F to 41 D, srusd-reservoir 54 C- to 55 C, and susds-sky 75 to 77",
    "A signal already priced in a pillar can impose a whole-score cap only when `additionalHardCapRisk` asserts the residual risk that remains outside that pillar. The replay moves 0 scores, changes 0 binding-cap identities, and preserves all 15 structural caps; the 9 pillar-priced caps remain grandfathered by the provisional marker still owed per-asset review: seven `centralized-mint:high` caps (cusd-celo, ftusd-flying-tulip, jpym-mento, jupusd-jupiter, rusd-reservoir, usd0-usual, and ussd-sonic-labs), `usdt-tether` at `centralized-mint:low`, and pht-pht at `weak-oracle-branch:critical`",
    "Active-depeg peak inheritance follows one `pegReferenceId` hop without redirecting child-keyed peg data, supply, or wrapper-local facts. The replay moves 0 scores and 0 `pegMultiplier` values; apyusd-apyx gains a non-binding inherited `active-depeg:f@39` candidate",
    "The policy-declared `market-anchor-longevity` premium is recorded as a bounded USDT-specific adjustment: 12 points, with `signal:centralized-mint:low` relief from 83 to 87 and a maximum published score of 87. Eligibility remains gated on rank 1, at least 120 months, base score at least 75, exit score at least 70, strong evidence, a clean peg, and `stress-redemption` plus `reserve-reconciliation`; the public 87 does not replace the pre-premium 83 returned for dependency inheritance",
  ],
  commits: ["fa7ce76ce", "1037bc89c", "80f319339", "b8260d9f1", "fd4d5f590"],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_EXIT_ROUTE_STABILITY: MethodologyChangelogEntry = {
  version: "9.33",
  title: "An expired exit-route observation is derated, not discarded",
  date: "2026-08-21",
  effectiveAt: 1787328000,
  summary:
    "Exit-route evidence whose producer window expired now loses credit instead of leaving the capacity denominator, and the published route payload widens so no single route is a tenth of an anchor's evidence. Together these remove a scoring cliff in which an ordinary producer-schedule delay re-graded an asset with no market event behind it, and propagated that move through the dependency graph to everything the asset backs.",
  impact: [
    "A route whose observation aged past its lane freshness bound is now included at the reviewed `staleObservationConfidenceFactor` (0.6, the same credit other low-confidence observations receive) rather than excluded outright. The factor derates both the route's own score and the capacity it contributes, and the route reports an `observation:stale` cap in its trace. A `missing` observation — no retained evidence at all — still fails closed exactly as before, as does a stale creditable non-atomic redemption, which keeps its stricter reviewed requirement",
    "The bounded public route payload widens from 10 observations to 24, and its concentration bounds scale with it (per-chain 6 to 14, per-protocol and per-adapter 3 to 7) so the extra slots admit genuinely new evidence. Measured on the live surface the previous bounds were saturated on concentration, not on slot count: usdc-circle, usdt-tether and dai-makerdao each published exactly six Ethereum, three Curve and three Uniswap-V3 routes. Common-mode risk continues to be modelled downstream, where routes sharing a physical resource are grouped and only the strongest member is credited",
    "The measured-execution freshness ceiling moves from two hours to three, one full publication cycle wider than the two-hour score-bearing Liquidity Score cadence it must cover. At two hours the expiry ceiling equalled the republication period, so one delayed or degraded even-hour publication expired every measured profile simultaneously. Generation retention moves from three hours to four to stay above the widened bound",
    "Measured on the 2026-08-21 production capture replay (337 cards): no card changes score or grade. The release is score-neutral on a healthy capture by construction — the derate only engages on evidence that the previous rule would have discarded, and the widened payload only engages where the producer had more admissible evidence than it could publish. The policy semantic digest rotates with the added exit key",
    "A new `dex-exit-route-turnover-watchdog` reports degraded when a coin's published route set turns over substantially between publications, so producer-driven route churn is visible as an operational signal instead of surfacing only as an unexplained grade change",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_MINT_POSTURE_LADDER_REFINEMENT: MethodologyChangelogEntry = {
  version: "9.32",
  title: "Mint posture separates missing reconciliation from confirmed exposure",
  date: "2026-08-21",
  effectiveAt: 1787270400,
  summary:
    "The mint component splits the exposed floor by reconciliation evidence, recognizes verified collateral-gated issuance, and extends bounded seasoning credit to eligible adverse postures. Economically unbounded minting with unknown reconciliation now scores 35 instead of the confirmed 25 floor; a collateral-gated path scores 50 below the concentrated-admin rung at 55; and an eligible adverse posture can season without crossing the dedicated 39 ceiling. The release also reclassifies CASH as continuously reconciled and the spUSDC and USDF vaults as raiseable rather than unbounded.",
  impact: [
    "The reviewed vocabulary gains reconciliation `none` for a positively established absence, cap semantics `collateral-gated`, and the derived postures `unbounded-reconciliation-unknown` and `collateral-gated`; `unknown`, `none`, and `not-applicable` remain distinct findings",
    "A reviewer's explicit reconciliation `unknown` on a reviewed direct non-backend mint control now compiles through to the evaluator instead of being swallowed by the not-applicable inference, and the facts schema admits that known-review shape — the 9.27 doctrine that a recorded could-not-establish finding beats silence. An absent field keeps the fail-closed inference, issuer-backend minters keep the PoR-derived cadence, and inherited share wrappers keep the wrapper convention",
    "`unbounded-reconciliation-unknown` maps to the existing Exposed band at 35, while `collateral-gated` maps to the existing Concentrated band at 50. No public band, CSV header, filter value, or saved screener URL changes",
    "DDR conservatism is preserved: both new postures join the fragile set, only `unbounded-reconciliation-unknown` joins the economically unbounded set, and the K1 risky set is unchanged because both postures land in existing risky bands",
    "After at least 60 months, a non-active `unbounded-or-compromised` posture and an `unbounded-reconciliation-unknown` posture can earn the existing 10-point seasoned credit without claiming reconciliation. The former uses the dedicated 39 ceiling rather than falling to the generic 34 next-rung ceiling created by the new 35 rung; the latter remains capped at 44 by the ordinary next-rung rule. An active incident remains ineligible",
    "Curated evidence moves cash-phantom to continuously reconciled `unbounded-reconciled`, and moves susdc-spark plus usdf-astherus to raiseable `partially-bounded-admin`; no broader recuration is part of this release",
    "Measured on the 2026-08-21 production capture replay: 60 of 337 cards move, all upward, none newly unrated. The Exposed floor shrinks from 78 to 26 cards; 49 assets derive the new unbounded-reconciliation-unknown posture, and 5 not-applicable-reconciliation assets earn the adverse seasoning lift to 35. 23 grades improve — 18 F to D, plus susdc-spark D to C+, usdf-astherus D to C, usg-tangent and yusd-yieldfi D to C-, cash-phantom F to D — and the largest single move is susdc-spark 44 to 64",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_CURATED_DEPENDENCY_GATE: MethodologyChangelogEntry = {
  version: "9.31",
  title: "Curated dependency links share the reserve admission gate",
  date: "2026-08-20",
  effectiveAt: 1787238000,
  summary:
    "Curated basket links no longer assert a dependency relationship when the same reserve composition is inadmissible for Backing and no live reserve slices are present. The dependency overlay now degrades with the reserve envelope, leaving the existing reserve gap to carry the bounded score consequence instead of publishing an unrelated unreviewed-dependency reason.",
  impact: [
    "When a curated review is stale, incomplete, non-verified, or otherwise fails the existing full-composition admission path, its curated collateral edges are omitted for that cycle when no live reserve slices exist; the reserve envelope continues to publish its existing missing or partial-review gap",
    "A verified, current curated composition keeps the same basket edges, and live-derived edges plus manual dependency reviews remain unchanged",
    "No pillar weights, aggregation, caps, grade thresholds, or reason vocabulary changes; the release aligns dependency-edge admission with the reserve-envelope gate",
    "On the current-tree replay, five affected assets keep their score and grade while six lose the stale dependency reason; jusd-juicedollar moves 40/D to 37/F because removing its expired full-weight curated edge also removes the inherited-backing path — accepted at release: the 2026-08-20 on-chain re-verification found the StablecoinBridgeUSDT reserve holding ~0.00042 USDT.e against ~10,460 JUSD supply, so the D grade rested on a stale optimistic edge",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_NONE_RESOLVED_TOP_RUNG: MethodologyChangelogEntry = {
  version: "9.3",
  title: "A verified absence of privileged mint scores what it proves",
  date: "2026-08-20",
  effectiveAt: 1787234400,
  summary:
    "The mint component's top rung moves from 95 to 100. A derived `none-resolved` posture states that no reviewed control can mint, authorize minting, or expand issuance on this component's scope, so reserving five points at the top of that rung priced a residual the component does not measure. The motivating case is proven outright: LUSD and BOLD resolve `none-resolved` on immutable, owner-renounced deployments where no privileged minter can ever be added, yet their mint component was capped at a ceiling nothing could reach.",
  impact: [
    "`mintPostureQuality[\"none-resolved\"]` moves 95 to 100; every other posture rung, the reconciled grading rungs, the seasoned credit, and all merged mint signals are unchanged. The ladder keeps its invariants: 100 is the new top rung and bounded credits still cannot lift a lower posture class past the rung above it",
    "The rung is mint-scoped, as the V9 derivation is: reviewed no-local-issuance wrappers and other assets whose mint component resolves `none-resolved` also take it, whatever their other control domains score. The oracle and bridge tier tables are independent calibrations and are unchanged",
    "The curated `none-resolved-mint` annotation stays a banding-only value with no quality rung of its own; the depeg resolver consumes posture bands, not component scores, so no DDR verdict input moves",
    "Measured on the 2026-08-20 publication capture: 30 evaluated assets move their mint component — 29 from 95 to 100 and srusd-reservoir from 92 to 97 through its unchanged -3 merged-signal penalty; 29 of them appear in published control breakdowns (syzusd-yuzu moves in the evaluated set only). Five assets move their Economic Control pillar 95 to 100 (susde-ethena, usdb-blast, usdk-kast, usdn-noble, xo-exodus) and exactly one published score moves — xo-exodus 56 to 57. No grade changes anywhere; usdn-noble's parent cap at 60 becomes its binding cap without moving its published score",
    "The policy semantic digest rotates because a posture quality value changed; pillar weights, aggregation, caps, grade thresholds, and every score-bearing gate value are unchanged",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_BRIDGE_SCOPED_QUESTIONS: MethodologyChangelogEntry = {
  version: "9.28",
  title: "Scoped open questions extend to bridge controls",
  date: "2026-08-18",
  effectiveAt: 1787097600,
  summary:
    "The 9.27 scoped-question contract now covers structured bridge controls. A curated bridgeRouteRisk review can author scopedQuestions, each naming one structured control by its id, its exact label, or its controllerChain:controllerAddress pair, with its own question text, review date, and sources. While such a question is fresh, an unresolved named control takes the 69 control-scoped-gap ceiling instead of the 55 control-unverified ceiling — the same ninety-day freshness window, the same reversion when it ages out, and the same rule that a question softens only the control it names. The compiled bridge fact is the route-level merge of its structured controls, so the merged overlay inherits the marker only when every unresolved contributor on that route is named; one unnamed unresolved sibling keeps the hard treatment, mirroring the mint-authority whole-inventory rule at route granularity.",
  impact: [
    "bridgeRouteRisk gains scopedQuestions[] with the same shape as mintAuthority.review.scopedQuestions. The schema rejects a controlRef that names no authored structured control, and questions attach nothing to conservative route-derived fallback controls, which have no reviewer behind them",
    "No scoring policy changes: the scoped-control-question reason, its 69 control-scoped-gap ceiling, and its deployment-control path kind all exist since 9.27, so the policy semantic digest does not move. Only the sidecar vocabulary, the bridge compiler, and the version label change",
    "The three open questions the aug18 control-research wave could not attach in 9.27 are authored in the same release: usn-noon's Starknet owner account-class identity and Sophon-origin Hyperlane validator operator, and usdat-saturn's CCIP RMN blessing-roster membership",
    "Measured on the 2026-08-18 publication capture: no score, grade, or pillar score moves. The named controls were already resolved by the same wave's research, so the questions document residual soft unknowns today and bound the downgrade to 69 instead of 55 if any of those controls later degrades to unresolved",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_SCOPED_CONTROL_QUESTIONS: MethodologyChangelogEntry = {
  version: "9.27",
  title: "A reviewer-scoped open question is better evidence than silence",
  date: "2026-08-18",
  effectiveAt: 1787097600,
  summary:
    "Economic Control distinguishes a reviewer who investigated a control and recorded exactly what stays unknown from a control nobody has resolved. A curated mint-authority review can now author scoped questions, each naming one control by chain:address or label with its own question text, review date, and sources. While such a question is fresh, the named control's gap takes the new 69 control-scoped-gap ceiling instead of the 55 control-unverified ceiling. The 9.23 boundary migration had recorded several of these as prose — PAXG's Solana Token-2022 authority was reviewed, dated, sourced, and explicitly retained as an unresolved fact — yet the score treated that documented, bounded unknown identically to total ignorance, publishing an 85 A asset at 55 C.",
  impact: [
    "The reason registry gains `scoped-control-question` and `namedReasonCeilings` gains `control-scoped-gap` at 69, aligned with the limited-evidence ceiling: a scoped, dated, sourced open question is limited evidence, not absent evidence. All other named ceilings, treatments, weights, and thresholds are unchanged",
    "A scoped question names exactly one control and softens only that control's gap. The legacy `unresolvedQuestions` list keeps its all-or-nothing semantics unchanged; curators migrate a question to the scoped form only when it genuinely binds one named control",
    "Freshness is enforced at compile time with a 90-day window: a scoped question whose review date ages past it reverts to the hard 55 ceiling, so a named gap cannot rot as a permanent softener. The gap row stays in the DEPLOYMENT_CONTROLS curation queue throughout",
    "The whole-asset inventory reason softens only when every unresolved control in the inventory carries a fresh scoped question; one unscoped unresolved control keeps the hard reason for the asset",
    "Deployment-scoped controls with a null supply share gain a materiality release: when the asset's supply partition is complete and reconciled, the deployment's measured rows (or zero, when a complete partition holds no row for it) bound the share, and a proven sub-threshold bound stops binding the control-unverified ceiling. A missing or unreconciled partition keeps the fail-closed treatment, and global-claim controls are never released by materiality. No currently tracked asset relied on this release at the 2026-08-18 capture; it closes the gap class the 9.26 aggregate-residue fix left open per control",
    "Reference curation in the same release converts the documented open questions for paxg-paxos (Solana Token-2022 mint authority attribution) and xsgd-straitsx (Hedera supply and admin key attribution) into scoped questions",
    "Measured on the 2026-08-18 publication capture: exactly two assets move, both upward — paxg-paxos 55 C to 69 B- and xsgd-straitsx 55 C to 69 B-. No other score, grade, or pillar score changes",
    "Pillar weights, bounded aggregation, grade thresholds, the withhold band, and every score-bearing gate value are unchanged. The policy semantic digest moves because the registry gains the reason and the named-ceiling table gains its entry",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_BRIDGE_RESIDUE_MATERIALITY: MethodologyChangelogEntry = {
  version: "9.26",
  title: "A trace of unmapped bridge supply stops being a material control gap",
  date: "2026-08-18",
  effectiveAt: 1787097600,
  summary:
    "Economic Control grades unattributed bridge supply against the same 10% deployment-materiality floor its per-row check already used. The aggregate check fired on any residue at all, so a rounding tail — $257 of EURC's $470M inventory, $40 of frxUSD's — was published as a material control gap and took the 55 control-unverified ceiling. Because a ceiling-treatment reason also classifies its pillar as limited evidence, the same trace applied the 69 evidence ceiling underneath it, and EURC published C/55 against an 82 it had otherwise earned. Sub-material residue is still published, now as a diagnostic that scores nothing.",
  impact: [
    "The aggregate unattributed-supply check moves from \"any residue\" to the deployment materiality floor already applied per row, which is what the reason's own name asserted. Residue at or above 10% keeps the material reason and its 55 control-unverified ceiling unchanged",
    "Residue below the floor publishes the new diagnostic reason `nonmaterial-bridge-supply-unmatched`, the twin of the existing non-material dependency reason. It carries no ceiling and does not classify its pillar as limited evidence, so the gap stays visible on the card and in the BRIDGE_MATERIALITY curation queue without bounding a score",
    "The material check no longer consults the subthreshold completeness proof. That proof clears each unmatched row against the floor individually, so rows that are each immaterial could sum past it and still prove complete — harmless while the trigger was any residue, an escape once the trigger is the floor itself. A material aggregate now fails closed on its own terms, and no tracked asset relied on the exemption",
    "Measured on the 2026-08-18 publication capture: 5 assets change score, all upward, and none worsens or becomes unrated. eurc-circle 55 C to 82 A-, frxusd-frax 55 C to 70 B, pyusd-paypal 55 C to 70 B, ausd-agora 55 C to 63 C+, and ussd-sonic-labs 45 D to 59 C as a strategy-vault wrapper whose frxUSD parent limit rises with it",
    "Five further assets exchange the material reason for the diagnostic without moving: cusd-celo, eurs-stasis, fusd-finchain, usbd-bima, and usdy-ondo-finance were each bounded by something other than this gap",
    "usdtb-ethena keeps its 55. Its 11.37% ($45.9M) Solana row matches two curated routes rather than one, which is a genuinely material attribution gap and not a rounding tail",
    "Pillar weights, bounded aggregation, grade thresholds, the withhold band, and every score-bearing gate value are unchanged. The policy semantic digest moves only because the reason registry gains the diagnostic entry",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_UNDISCLOSED_PRIMARY_EXIT: MethodologyChangelogEntry = {
  version: "9.25",
  title: "Undisclosed stops being published as a fact, in both directions",
  date: "2026-08-18",
  effectiveAt: 1787097600,
  summary:
    "The published access posture's primaryExit now reads the same route set the Exit pillar credits, and reserves \"none\" for a reviewed-complete, genuinely empty exit surface. Everything else — routes that exist but earn no credit, and a missing, stale, or unsupported exit surface — publishes the new \"undisclosed\" state. The derivation previously counted only score-eligible routes, so an asset whose Exit pillar was scoring a reviewed issuer, protocol, or eventual redemption simultaneously published \"Primary exit: None\", asserting an absence its own scoring contradicted. The same release fixes the mirror-image defect in Economic Control, where a missing reconciliation cadence was read as evidence of a periodic one.",
  impact: [
    "primaryExit is derived from any credited route: score-eligible, or admitted by the creditable-non-atomic-redemption rule that the Exit pillar already applies to the reviewed issuer-redemption, protocol-redemption, and eventual-redemption families. That rule now has a single definition shared by both surfaces, which is what stopped them drifting apart",
    "\"none\" now requires known negative evidence: a required exit surface observed complete with zero routes. A surface that is missing, stale, or unsupported is an absence of evidence and publishes \"undisclosed\" instead",
    "accessPostureVocabulary.primaryExit grows from five members to six with the addition of \"undisclosed\". It is not an unknown value, so it does not enter accessPosture.unknownFields and the detail page renders it as an explicit \"Primary exit — Not disclosed\" row rather than dropping the row",
    "Measured on the 2026-08-18 publication capture: primaryExit moves from none 184 / permissionless 146 / eligibility-gated 7 to a distribution in which every card publishing a scored exit route reports the access posture of that route. BUIDL, USDY, USYC, VBILL, JAAA, USDPT, YLDS, and the Spiko and Midas ranges stop asserting that no exit exists",
    "primaryExit is a published posture projection and not a scoring input. Measured against the 2026-08-18 capture, the posture change alone leaves every pillar score, cap, and grade byte-identical to 9.24; only the policy semantic digest and the version label move",
    "Economic Control no longer infers a periodic reserve reconciliation from the absence of one. The inference read proofOfReserves.cadence for truthiness, and the sentinel values \"none\" and \"undisclosed\" are non-empty strings, so an issuer-backend mint whose issuer publishes no reconciliation at all was graded as reconciling periodically. A dated latestReport, or a cadence that names a real rhythm, still establishes \"periodic\"; everything else is now \"unknown\"",
    "\"unknown\" rather than a known negative is deliberate: an undisclosed cadence establishes only that nothing is published, never that the issuer does not reconcile internally. The mint reconciliation vocabulary has no member for a proven absence, and inventing one would assert more than the evidence carries. A reviewed economicControlReview.mint.reconciliation continues to supersede the inference, so the gap is closable by curation",
    "That correction moves three assets on the 2026-08-18 capture, and only downward: a7a5-old-vector 23 to 19 (F, unchanged), cngn-compliant-naira 37 F to NR, and euri-banking-circle 52 C- to NR. Both withholds are the insufficient-evidence path — an F requires an attributable measured-adverse fact, and losing an unearned reconciliation credit does not supply one — so the model declines to rate rather than publishing an unjustified F. No asset improves, and no other asset moves",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_CONTROL_SECTION_APPLICABILITY: MethodologyChangelogEntry = {
  version: "9.24",
  title: "A reviewed absence of bridge or local issuance is a fact, not a gap",
  date: "2026-08-18",
  effectiveAt: 1787011200,
  summary:
    "Economic Control now reads three reviewed answers as the measured facts they are. An inventory whose every reviewed route is native issuance is not bridge-exposed even when structured controls govern those canonical deployments; a bridge review whose unattributed supply is immaterial keeps the rows it did review; and a reviewed no-local-issuance exception compiles as a not-applicable mint section when the risk it displaces is carried by a serial-claim parent or by Bridge Risk. The 9.23 boundary release had made each of these compile as missing evidence, collapsing the control pillar to its neutral default and withholding otherwise rateable assets.",
  impact: [
    "A structured bridge control whose only reviewed routes are native issuance no longer keeps the bridge section applicable, so an asset whose reviewed answer is \"no bridge\" scores single-chain-or-native instead of the opaque-or-unknown fallback. A reviewed representation route keeps the section applicable even when no control compiled for it, and an unresolved zero-share deployment remains an audit fact rather than proof of no bridge",
    "A bounded bridge review keeps its reviewed rows when the supply the compiler could not attribute is below the deployment materiality threshold, or when a known supply review selected no bridge route at all. A material residual, an unknown share, and a supply review that is not itself a known fact all keep the previous discard, and every row still fails closed on its own",
    "mintAuthority.review.noLocalIssuance compiles as the mint review's existing not-applicable state. It is granted only when an inherited claim carries a compiled serial-claim edge to its parent, or an external-only representation carries the reviewed route inventory covering every authored deployment; any authored control keeps the section required",
    "USDN and USDK are re-curated to hold a serial claim on M0 rather than a copy of M0's collateral composition, ending a threefold count of the same Treasury exposure and scoring the inherited mint risk on the dependency edge. Both are rated D/45, below the C/55 their parent scores, which is the intended result of binding an inherited claim to its parent",
    "cngn's boundary-migration review questions are recorded as the decided dispositions they were. As open questions they made the mint review incomplete, which zeroed the control's incident state and suppressed the centralized-mint signal carrying the asset's only measured-adverse attribution, so the F-floor withheld a grade the evidence still supports",
    "Measured on the 2026-08-18 publication capture: 17 assets changed on score-material terms, 9 of them rated again and 8 improving. No asset worsened, none became newly unrated, and no rated asset moved by 10 points or more. Not Rated falls from 25 to 16",
    "Pillar weights, bounded aggregation, caps, grade thresholds, the withhold band, and every score-bearing gate value are unchanged; only the methodology version label moves",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_MINT_BRIDGE_SCOPE_BOUNDARY: MethodologyChangelogEntry = {
  version: "9.23",
  title: "Mint authority follows native issuance; bridge controls stay route-scoped",
  date: "2026-08-17",
  effectiveAt: 1786924800,
  summary:
    "Economic Control now binds Mint Authority controls to reviewed canonical native-issuance deployments and compiles structured bridge controls separately for each referenced route. A controller may operate in both domains, but a representation or transfer-rail capability can no longer become global native-mint risk.",
  impact: [
    "Active multi-deployment Mint Authority controls and mutable mint-logic upgrade paths name their reviewed native deployments; inherited or external-only products require an explicit reviewed no-local-issuance exception",
    "Bridge mint/burn, adapters, lockboxes or escrow, messaging, peer configuration, limits, upgrades, validators, pause, and administrators are authored as structured route-scoped controls, while conservative route-derived controls remain when structured evidence is absent",
    "The ownership gate blocks active bridge vocabulary in Mint Authority, invalid or non-native deployment references, and duplicate cross-domain bridge capabilities instead of silently filtering them during compilation",
    "A structured bridge control covering a reviewed bridge- or wrapped-representation route must name that route's bridge-mint holder; otherwise the ownership gate fails closed, because leaving the route unreferenced is what preserves the conservative route-derived mint overlay",
    "Common-mode evidence for a shared critical control identity is now resolved per receiving asset: a reviewed bounded-unknown member stays measured-adverse, a missing or stale member remains an integration gap, and evidence confidence is high only when the receiving asset's own member facts are known. Previously one bounded-unknown member released the shared-critical-control ceiling for peers whose own facts were known, so weaker evidence could raise a published score",
    "USDai's satellite OToken administrator exposure remains scoreable under Bridge Risk but no longer classifies canonical Arbitrum issuance as unbounded-or-compromised; the corrected scope moved USDai from D to B",
    "Across the 375 scoreable assets, 159 changed on score-material terms: 16 improved and 37 worsened, with the rest moving only posture, bridge tier, or compiled capabilities. The distribution is net more conservative, the largest moves being downgrades of 33, 23, and 22 points where satellite bridge machinery had been masking canonical or route risk",
    "Pillar weights, bounded aggregation, caps, grade thresholds, and non-bridge Mint Authority scoring are unchanged",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_RESERVE_SLICE_IDENTITY: MethodologyChangelogEntry = {
  version: "9.21",
  title: "Reserve classifications follow source identity, not daily weights",
  date: "2026-08-16",
  effectiveAt: 1786838400,
  summary:
    "A live reserve slice's percentage is now only a scoring weight, never part of the join that attaches reviewed asset class, obligor, liquidity, maturity, or dependency metadata. Adapters can emit a namespace-qualified stable source key; a keyed live row joins one-to-one by that exact key and fails closed on a missing or duplicate reviewed key. Historical unkeyed rows retain a unique normalized-name compatibility join.",
  impact: [
    "Ordinary issuer rebalancing can no longer turn an unchanged reserve category into bounded unknown merely because its live percentage moved more than a fixed tolerance",
    "Circle USDC and EURC, Re Protocol reUSD, and Noon's USN now carry adapter-owned source keys on both live and reviewed rows; the same matched identities drive Backing classifications and dependency compilation",
    "On the current USDC publication inputs, the two drifted Treasury and systemically-important-bank rows leave the bounded 35 floor; the unchanged-pillar counterfactual restores Backing from 68.39 to about 90.02 and the public score from 79/B+ to 89/A+",
    "Explicit-key mismatches and collisions remain unclassified, newly introduced source buckets cannot inherit metadata by label accident, and live percentages remain the only weights used by scoring",
    "Pillar weights, reserve quality scores, bounded-unknown floors, score aggregation, structural caps, and grade thresholds are unchanged",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_POLICY_GATE_PROVENANCE: MethodologyChangelogEntry = {
  version: "9.22",
  title: "Every score-bearing gate rotates the methodology-policy digest",
  date: "2026-08-16",
  effectiveAt: 1786838400,
  summary:
    "Safety Score policy provenance now binds the reshape withhold band, danger and F-grade predicates, material-bridge share band, and score-bearing evidence-expiry windows. Policy-only replay and sensitivity analysis can change those gates through one validated projection and observe a different semantic digest instead of relying on code literals invisible to policy comparison.",
  impact: [
    "The shared scorer reads withhold, danger, F-only attribution, pre-exit danger, and material-bridge thresholds from the validated score-bearing-gates policy",
    "Reviewed research, access, research-overlay, mechanism-overlay, issuer-attested reserve, and curated-reserve expiry windows are separately named and included in the semantic digest even where their current values coincide",
    "The active values are unchanged, so scores, pillars, caps, grades, and evidence freshness outcomes do not move; the policy semantic digest and published score provenance rotate",
    "Presentation grade bands now derive from the active scoring policy, preventing a second display threshold authority from drifting from the engine",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_ROUTE_BUDGET_COMPLETENESS: MethodologyChangelogEntry = {
  version: "9.2",
  title: "Budgeted DEX observations stop publishing as a data-feed failure",
  date: "2026-08-13",
  effectiveAt: 1786622400,
  summary:
    "Exit gap accounting treats the public route-selection bound as the admitted observation set. A populated p4a.8 surface that already carries its budgeted score-eligible routes is complete even when hundreds of other recognised venues failed target construction or sit behind a reviewed model limit. Leftover `quote-failed` attempts no longer keep a payload-saturated surface open; they still fail closed when the bound is not full. A recognised venue whose only remaining gates are reviewed model limits is method-unsupported rather than producer-failed.",
  impact: [
    "USDT, USDC, DAI, EURC, and other payload-saturated or fully-carved populated surfaces leave `incomplete-dex-route-coverage` instead of publishing as a data-feed failure",
    "Exact-route scoring completeness is unchanged: only gap accounting uses the budgeted denominator, so a partial observation set still cannot replace the aggregate DEX path",
    "Rate-bearing, unsupported-invariant, metapool, and paused/swap-disabled gates on a zero-observation surface are method limits, not feed outages",
    "Pillar weights, score aggregation, structural caps, and grade thresholds are unchanged",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_RESERVE_FRESHNESS_PROVENANCE: MethodologyChangelogEntry = {
  version: "9.193",
  title: "Reserve freshness follows the accounting state, not its API envelope",
  date: "2026-08-13",
  effectiveAt: 1786615191,
  summary:
    "DUSD's Makina reserve snapshot now uses the oldest underlying Caliber position-accounting timestamp and the reviewed Machine's three-hour staleness threshold. A newly generated index response can no longer make stale contract accounting score-eligible.",
  impact: [
    "Makina-indexed balances, AUM, supply, debt flags, oracle values, and redemption state were independently reconciled to Machine and Caliber contracts; the API remains the source of human protocol and strategy labels",
    "DUSD reserve snapshots become stale when any included position accounting exceeds the Machine's three-hour threshold, even if both API envelopes were generated recently",
    "Frax, Tether, and USD.AI mixed native feeds retain conservative issuer-attested ingestion provenance and now use proof-style public presentation instead of claiming that the complete feed is independently measured",
    "Pillar weights, score aggregation, structural caps, and grade thresholds are unchanged",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_REVIEWED_BOUNDED_RESIDUALS: MethodologyChangelogEntry = {
  version: "9.192",
  title: "Reviewed bounded residuals stop publishing as missing data",
  date: "2026-08-12",
  effectiveAt: 1786569600,
  summary:
    "Two reviewed-but-unproven residuals stop appearing as missing inputs. A current freeze review whose honest verdict is `possible` is measured as `reviewed-possible-access` instead of `missing-access-review`. Independently subthreshold unmatched bridge-supply rows on a resolved chain no longer mint unknown-identity controls, extending the 9.03 D-J dust rule from unrecognized labels to recognized deployments below the 10% floor.",
  impact: [
    "Twelve assets whose freeze review is current `possible` leave the open-data census for freeze/blacklist; scoring stays bounded-unknown and the verdict is not rewritten to true or false",
    "Transfer access facts are unchanged: they still require a material-scope bind and do not inherit the freeze disposition",
    "USDT's 27 unmatched resolved-chain identity facts (Starknet, Metis, Aurora, and the rest of the dust book, each well below 10% of supply) stop publishing as `unresolved-control-identity`; a row at or above the deployment floor still fails closed",
    "Pillar weights, score aggregation, structural caps, and grade thresholds are unchanged",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_ATTRIBUTION_RECONCILIATION: MethodologyChangelogEntry = {
  version: "9.191",
  title: "Every bounded attribution keeps its owned open fact",
  date: "2026-08-12",
  effectiveAt: 1786528422,
  summary:
    "The 9.19 single-count deduplication could collide two distinct reasons that shared a gap identity, keeping the raw entry and dropping the score-bearing one whose bounded-uncertainty attribution then pointed at no owned open fact. On an asset whose mechanism reviews had aged into bounded gaps this made score publication fail its own reconciliation schema. The published fact list now restores any direct reason attribution the deduplication displaced, so every bounded-uncertainty entry reconciles to an owned open fact with its exact code, path, and responsibility.",
  impact: [
    "Score publication can no longer throw when a mechanism review ages past its window: the far-future regression compiles a full candidate with aged reviews and asserts every reason-sourced bounded attribution reconciles",
    "Where the collision occurred, both colliding facts are now visible, so an asset's open-fact count can rise by the entries that were previously silently dropped — on the aged-review fixture this is one additional fact",
    "Current-clock published output is unchanged: the reconciliation fixture pins today's USDC card byte-equal (same grade, same five open facts, same reason codes)",
    "Attribution semantics, the reconciliation schema, pillar weights, score aggregation, structural caps, and grade thresholds are unchanged",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_EVIDENCE_ATTRIBUTION: MethodologyChangelogEntry = {
  version: "9.19",
  title: "Open facts are counted once and carry the path that produced them",
  date: "2026-08-12",
  effectiveAt: 1786500893,
  summary:
    "An asset's open-fact mass double-counted every mechanism gap: once through its pillar reason and again through a generic re-emission under a different path, which no consumer could reconcile back to a single gap. The duplicate entries also carried no usable fact path, so a reader could not tell what to disclose to clear them. Separately, a DEX surface on a chain with no registered discovery provider stops being reported as a method floor.",
  impact: [
    "Each gap is now published once. Deduplication is by gap identity only, so two distinct gaps that share a reason code both survive; entries that carry no gap identity keep their previous behaviour exactly",
    "Published facts carry the `exactFactPath` the gap constructor already held, so an open fact can be traced to the component that produced it and answered. Three assets whose residual mass was previously unattributable — nopal-nest, ntbill-nest and xusd-babelfish — resolve to their real gaps: for example nopal-nest's seven facts were five real paths plus two re-emissions",
    "No score, pillar, cap or grade moves: this removes duplicate reporting entries, not scored inputs, and a fixed-input replay confirms score equality",
    "A DEX exit surface whose deployment census carries no registered discovery provider is attributed `integration-missing` rather than `method-unsupported`, in both the portfolio-coverage and zero-route branches so one condition cannot publish two responsibilities. The chain has deployments and markets; Pharos has not wired a provider for it. `no-exact-capable-venue` remains the genuine method limit and is unchanged",
    "This supersedes in part the 2026-07-29 ruling that classified the no-provider census condition as a method limit",
    "Pillar weights, score aggregation, structural caps, and grade thresholds are unchanged",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_TRANSFER_MATERIALITY_OBSERVATION: MethodologyChangelogEntry = {
  version: "9.18",
  title: "A reviewed transfer scope no longer depends on third-party chain supply",
  date: "2026-08-11",
  effectiveAt: 1786500892,
  summary:
    "The transfer scope test proves a review covers material deployments from per-chain supply, which only the DefiLlama list provides. An asset absent from that list had no supply rows, so the test could never be satisfied and an authored transfer review was withheld as unreviewed. A materiality-only on-chain observation now establishes deployment scope for a bounded cohort, and it is structurally walled off from circulating supply and market cap.",
  impact: [
    "Thirty-nine assets that carry an authored transfer review but no DefiLlama listing can publish that reviewed posture instead of gapping as `missing-access-review`; the remaining assets in the unlisted cohort have no review to admit and stay fail-closed",
    "Materiality on this path is any deployment carrying non-zero supply, not a share of a summed total. Raw `totalSupply()` is never summed across deployments: for lock-mint and bridged representations the same liability is reported more than once, which would overstate the denominator and could drop a material deployment out of review while still reporting the scope complete",
    "The observation carries only a deployment key, raw token units, decimals, block number and observation time. It has no USD or price field, so it cannot be consumed by the circulating-supply or market-cap paths, which are unchanged and remain sourced solely from the DefiLlama list",
    "The path is fail-closed on every leg: a stale generation, a null or unreadable on-chain result, decimals that disagree with the registry, an identity mismatch, a partial deployment read, or a registry or base-input fingerprint mismatch all return the existing `bounded-unknown` result",
    "The on-chain path engages only where there is no per-chain supply at all; where the DefiLlama list reports supply the existing share-based materiality threshold continues to decide scope unchanged",
    "Pillar weights, score aggregation, structural caps, and grade thresholds are unchanged",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_ORACLE_APPLICABILITY: MethodologyChangelogEntry = {
  version: "9.17",
  title: "Oracle applicability no longer implies oracle safety",
  date: "2026-08-11",
  effectiveAt: 1786458344,
  summary:
    "Economic Control now separates a genuinely oracleless mechanism from privileged internal pricing, while a reviewed not-applicable oracle path is neutral and emits no scored component instead of manufacturing a green 95.",
  impact: [
    "The combined `oracleless-or-internal` posture is replaced by `oracleless` at 95 and `privileged-internal-pricing` at 45; external-feed tiers and scores are unchanged",
    "A not-applicable oracle review emits no oracle component and contributes neither credit nor penalty to Economic Control",
    "A reviewed top-level price authority can be scored without inventing collateral-liquidation branches",
    "Tori trUSD moves to privileged internal pricing because its backend constructs the economically effective signed-order quote without an independent on-chain feed or collateral-depeg circuit breaker",
    "Tori's strUSD loss-reporting authority is disclosed separately as wrapper-specific risk and is not attributed to ordinary trUSD balances",
    "On the 337-card fixed-input replay, 281 manufactured not-applicable oracle rows disappear; after partitioning unrelated registry drift, Tori is the only methodology-attributed score move, from 57/C to 52/C- as Economic Control moves from 70 to 45",
    "Pillar weights, aggregation, structural caps, and grade thresholds are unchanged",
  ],
  commits: [],
  reconstructed: false,
};

/**
 * V9 is activated under methodology `9.0`.
 */
export const SAFETY_SCORE_V9_ACTIVATION: MethodologyChangelogEntry = {
  version: "9.0",
  title: "Safety Score V9 becomes the active model",
  date: "2026-07-27",
  effectiveAt: 1785129044,
  summary:
    "Pharos activates the identity-bound V9 model with three risk pillars, explicit evidence responsibility, structural ceilings, and fail-closed publication health.",
  impact: [
    "All active consumers select V9 without recomputing or falling back to V8",
    "Backing, Exit, and Economic Control replace the five V8 dimensions for native V9 output",
    "Transient producer failures hold the last accepted V9 snapshot and expose held status instead of publishing infrastructure-attributed score movement",
    "Capability-free immutable protocol contracts resolve to immutable governance access posture instead of being mistaken for concentrated administrators",
    "V8.17 remains available only as historical methodology and archived score history",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_ROUTE_CAPACITY: MethodologyChangelogEntry = {
  version: "9.01",
  title: "Economically material route capacity",
  date: "2026-07-28",
  effectiveAt: 1785224355,
  summary:
    "Exit routes now need economically material capacity, and sub-1% completion cannot score above 50 even when the absolute-capacity floor is met.",
  impact: [
    "The prior threshold derived from two-decimal trace rounding is replaced by the policy's first positive 1% coverage or $100K absolute-capacity breakpoint",
    "A route below both breakpoints receives a zero route score; a route that reaches $100K but remains below 1% completion is capped at 50",
    "Public Exit breakdowns identify capacity as selected-route-specific and expose executable amount, request, cost bound, horizon, protocol, pool, evidence kind, and evidence time",
    "Issuer redemption remains a separate near-term or eventual horizon and is not inferred from exchange volume, aggregate DEX TVL, or issuer reserves",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_CAUSAL_RESPONSIBILITY: MethodologyChangelogEntry = {
  version: "9.02",
  title: "Causal responsibility provenance",
  date: "2026-07-28",
  effectiveAt: 1785234908,
  summary:
    "V9 now preserves causal responsibility through inherited and upstream evidence paths, distinguishes producer-unpriceable exit outputs from issuer non-disclosure, and retains reviewed controls in partial inventories without changing score or grade formulas.",
  impact: [
    "Explicit reason-level responsibility is authoritative; legacy reason defaults are used only when no explicit attribution is available",
    "Inherited reserve gaps, unavailable backing and role-pillar dependencies, and missing parent scores propagate the originating owner instead of defaulting downstream gaps to integration-missing",
    "Every attributed root receives a causal-root-qualified path even when it is the only root, so adding another root cannot rename an existing public fact; only unattributed fallbacks retain aggregate base paths, and mutable ownership never enters public fact identity",
    "Applicable but unpublished mechanism metrics retain issuer-undisclosed responsibility and never become measured-adverse merely because a related component was reviewed",
    "A reviewed external exit output with known identity but no same-notional valuation is producer-failed; an issuer-undisclosed settlement asset stays issuer-undisclosed, and neither output becomes scoreable",
    "Date-only mechanism and exit-output dispositions become admissible after the reviewed UTC day and cannot enter earlier replay clocks",
    "Reviewed mint controls remain present when the aggregate inventory is unresolved; unreviewed deployment surfaces stay bounded and fail closed",
    "Backing, Exit, and Economic Control weights, score aggregation, caps, and grade thresholds are unchanged",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_UNRECOGNIZED_CHAIN_LABEL_TOLERANCE: MethodologyChangelogEntry = {
  version: "9.03",
  title: "Subthreshold chain-label pool tolerance",
  date: "2026-07-29",
  effectiveAt: 1785341437,
  summary:
    "Subthreshold unrecognized chain-label supply pools remain tolerated by the bridge-materiality proof but no longer surface as public evidence-responsibility facts.",
  impact: [
    "Small raw provider chain-label pools below the common-mode materiality floor no longer create producer-failed remediation items",
    "Material unmatched bridge supply still fails closed through the ordinary bridge-supply reason at or above the materiality floor",
    "Backing, Exit, and Economic Control weights, score aggregation, caps, and grade thresholds are unchanged",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_UNSUPPORTED_EXIT_COVERAGE: MethodologyChangelogEntry = {
  version: "9.04",
  title: "Unsupported coverage separated from producer failure",
  date: "2026-07-29",
  effectiveAt: 1785353342,
  summary:
    "Exit-coverage, route-evidence, and dependency gaps that no supported adapter can observe are now attributed to unsupported methodology instead of transient producer failure, deployment census coverage is reported per chain, and a peg with no usable price but an adverse record becomes measured adverse.",
  impact: [
    "Deployment census coverage is evaluated per chain: deployments on chains with no supported liquidity provider are reported as an explicit unsupported remainder instead of leaving the whole asset's coverage unknown, so a clean supported scope publishes real coverage",
    "An exit surface with no retained pool, or with retained pools but no score-eligible execution-capability pool, is attributed to unsupported methodology when its census remainder is methodology-unsupported and no execution-capability gate applies; genuine producer failures keep producer-failed responsibility",
    "Runtime route evidence for that unsupported cohort is reported as unsupported rather than missing, so later adapter coverage silently returns those assets to scoring without a responsibility rewrite",
    "Unreviewed dependency relationships are unsupported methodology when the asset has no live-reserve adapter and remain producer-failed when one exists, correcting the misattributed hubble USDH dependency gap",
    "Zero-pool and zero-exact-capable exit surfaces carry their own gap messages; the reviewed-capability-pool message is now emitted only where reviewed execution-capability pools actually exist",
    "An asset with no usable current price whose tracked peg record is already adverse is classified as measured adverse instead of a producer feed failure, while a clean record with no usable price stays a quiet observation and the deviation is never coerced to zero",
    "The unreachable subthreshold unrecognized chain-label pool reason is retired from the reason registry",
    "Reclassified surfaces stay bounded and remain at the same evidence ceiling, so pillar weights, score aggregation, caps, and grade thresholds are unchanged and no published grade moves",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_WRAPPER_LOCAL_CONTROL_EVIDENCE: MethodologyChangelogEntry = {
  version: "9.05",
  title: "Wrapper local controls retain partial evidence",
  date: "2026-07-30",
  effectiveAt: 1785431359,
  summary:
    "Strategy-vault wrapper loss-control facts can now use reviewed local controls from a partial deployment inventory while unresolved controls remain bounded and risk-transfer credit remains disabled unless separately documented.",
  impact: [
    "Reviewed local controls on a strategy-vault wrapper populate the wrapper loss-absorption and emergency-control dimension even when the aggregate mint/control review is still bounded",
    "Unresolved deployment surfaces still fail closed in Economic Control and keep their original evidence responsibility",
    "Security-module, recovery-mode, and other local emergency controls do not create parent-loss absorption credit; wrapper risk-transfer remains zero unless a separate enforceable backstop is reviewed",
    "Backing, Exit, and Economic Control weights, score aggregation, caps, and grade thresholds are unchanged",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_EXIT_REDUNDANCY: MethodologyChangelogEntry = {
  version: "9.06",
  title: "Exit backup credit scales with route quality",
  date: "2026-08-06",
  effectiveAt: 1786027489,
  summary:
    "V9 Exit now scales its bounded backup-route credit by the backup route's own score and presents primary-route, backup, and completion measurements separately.",
  impact: [
    "Backup credit is min(10, 100 - primary route score) multiplied by backup route score / 100",
    "A primary route below 100 can no longer reach 100 from backup-route credit alone",
    "The Exit card names the selected primary route, identifies the backup credit, and shows actual stress-request completion separately from its capacity component score",
    "The Exit pillar name, aggregation weight, route components, caps, and grade thresholds are unchanged",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_COMMODITY_CLAIM_ARCHETYPE: MethodologyChangelogEntry = {
  version: "9.14",
  title: "Commodity claims get their own archetype",
  date: "2026-08-09",
  effectiveAt: 1786233603,
  summary:
    "Gold and silver tokens stop being scored as custodial cash. The new `commodity-claim` mechanism archetype asks the questions the asset actually poses — legal title to identified bars, vault custody continuity, bar-list assurance, and operable physical redemption — instead of reusing the fiat-cash reserve component names and smuggling the real semantics in through a mechanism profile.",
  impact: [
    "Backing mechanism components for a commodity claim are `title-and-allocation` (0.15), `custody-continuity` (0.10), `assurance-and-reconciliation` (0.13), and `physical-redemption` (0.07), against the same 0.55 reserve weight the fiat-cash archetype carries; title and custody remain the serial claims that fail closed, and title failure keeps the critical unsafe-backing signal",
    "Physical redemption is now graded in Backing rather than existing only as a profile exit fact. It is stated once: the Exit pillar keeps reading the same curated fact to explain a missing runtime route, so the two pillars cannot disagree and no fact is counted twice",
    "There is deliberately no price-basis component. A commodity token's reference price is the metal, and the peg layer already measures the token-versus-reference spread; adding a backing component for it would double-count. Price-coupling context belongs in the physical-redemption rationale",
    "Gold-collateralized dollar tokens are not commodity claims and stay in their dollar archetypes with metal recorded as allocated-commodity reserve; the archetype is for direct claims on the commodity itself",
    "Commodity-claim components follow the same ratified strict evidence standard as fiat-cash and tbill: they are compiler-bounded, only a source-cited curated overlay may claim them, and insufficient disclosure records a sourced unavailable disposition that stays bounded and non-scoring",
    "A commodity claim is oracle-free like custodial cash and T-bill claims: nothing is liquidated against a price feed, so the oracle review publishes not-applicable instead of demanding a profile that cannot exist",
    "Fifteen assets migrate off fiat-cash: XAUT, PAXG, XAUm, XAGm, PGOLD, VNXAU, GLDT, DGLD, CGO, KAU, KAG, GGBR, GRAMG, GRAMS, and XNK. Gold-referenced dollar and franc tokens (USDKG, CHFAU) and tokenized metal ETF shares (IAUON, SLVON) keep their existing archetypes",
    "Measured over the full active registry at a fixed input, 12 of 337 cards move and none flips a grade. Three lose one point — PAXG 79 to 78, XAUm 73 to 72, VNXAU 71 to 70 — where the newly asked physical-redemption question is not answered by the sources already pinned in their reviews. XAUT's exit pillar is unchanged at 35, because the exit fact is now derived from the same curated redemption component rather than declared twice",
    "Pillar weights, score aggregation, structural caps, and grade thresholds are unchanged",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_WRAPPER_OPERATOR_CLASSIFICATION: MethodologyChangelogEntry = {
  version: "9.13",
  title: "Wrapper caps follow operator ownership",
  date: "2026-08-08",
  effectiveAt: 1786233602,
  summary:
    "When a risk-absorption product's taxonomy does not reveal who operates the wrapper, its reviewed operator ownership now selects the existing parent-cap form: third-party wrappers use the strategy-vault treatment, while parent-protocol wrappers keep the native-staked treatment.",
  impact: [
    "No new cap tier, pillar weight, aggregation rule, or grade threshold is introduced; the change selects between the existing vault and native-staked wrapper treatments",
    "K3 sBOLD is a third-party wrapper over BOLD and now receives the same vault fallback discount as Yearn yBOLD: on the fixed production replay its parent limit moves from 79 to 74 and its published result moves from 78/B+ to 74/B",
    "Strata srUSDe is also classified as third-party but remains 52/C- because its own score is already below the parent cap; Aave stkGHO and Sky stUSDS remain parent-protocol wrappers and keep native-staked treatment",
    "Every risk-absorption variant must now declare `wrapperOperator`; the field is rejected on unambiguous variant kinds, preventing product taxonomy from silently granting a third-party wrapper native treatment",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_INCIDENT_DECAY_SEVERITY: MethodologyChangelogEntry = {
  version: "9.12",
  title: "A resolved mint incident costs a full posture class",
  date: "2026-08-08",
  effectiveAt: 1786233601,
  summary:
    "The resolved-mint-incident decay shipped in 9.1 at the strongest ladder that flipped no grade — a calibration constraint, not a judgment, whose whole effect was one point on one asset. The severity is now chosen on merit: while the incident is recent the mint reads as a concentrated admin, from 24 months as a partially bounded admin, and from 48 months as a bounded admin. Every rung is an existing V9 posture value, and because the last rung sits above every uncapped mint in the incident-carrying set the penalty genuinely expires rather than becoming a permanent tax.",
  impact: [
    "The resolved-incident cap on the mint component moves from 79/85/90 to 55/70/85 for the recent (under 24 months), aging (24-48 months), and dated (48+ months) tiers; the tier boundaries themselves are unchanged",
    "One published grade changes: pyusd-paypal moves A- to B (mint 79 to 55, score 80 to 70) on a resolved 2025-10-15 incident. Its cap relaxes to 70 on 2027-10-15 (B+) and to 85 on 2029-10-15, by which point its seasoned-issuer credit has raised its uncapped mint to 84, so A- is fully restored",
    "One published score changes without a grade change: reusd-resupply 47 to 45, D either way",
    "usdt-tether, dola-inverse-finance, ousd-origin-protocol, lisusd-lista and the four USDT wrappers are untouched, so the dependency-projection channel is never engaged; dgld-gold-token-sa and nxusd-nereus stay pinned at the unbounded-or-compromised floor",
    "The decay still measures only the age of the most recent resolved incident, not its severity: an operational error reversed the same day and an exploit with real bad debt take the identical cap. Making the decay severity-aware is a schema change and is not in this version",
    "The curated `authorityPosture` vocabulary gains two values, neither of which scores. `unbounded-reconciled` (\"Unbounded, supervised & reconciled\") stops a supervised issuer being annotated with the same value as an issuer with no reconciliation at all; the depeg resolver treats it exactly like `unbounded-or-compromised`, so it moves no depeg verdict. `none-resolved-mint` (\"No privileged mint path\") is the mint-scoped sibling of `none-resolved`, for an asset no control can mint while other control domains still exist — the scope V9 already derives at, which whole-of-chain `none-resolved` could not express. 14 share wrappers whose own token has no minter move onto it from an adverse posture; the resolver reads it as benign (neither fragile nor risky) and it does not earn the R1 non-inflatable-supply anchor, so two of the 14 change structural stratum and seven lose K1's curated risky-minter leg",
    "Pillar weights, aggregation, structural caps, and grade thresholds are unchanged",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_EXIT_BOUNDARY_UNIFICATION: MethodologyChangelogEntry = {
  version: "9.11",
  title: "Unified exit ladder boundary semantics",
  date: "2026-08-08",
  effectiveAt: 1786233600,
  summary:
    "The shared exit engine's two descending penalty ladders read their thresholds the same way. The queue-backlog ladder already matched at-or-above; the minimum-redeem ladder matched strictly above, so a route whose minimum landed exactly on a boundary took the gentler band. Both now match at-or-above.",
  impact: [
    "A route with a minimum redemption of exactly $1,000,000 takes the 0.75 capacity multiplier instead of 0.9; exactly $10,000 takes 0.9 instead of no penalty",
    "Only routes whose reviewed minimum sits exactly on a ladder threshold can move; every other route is arithmetically identical",
    "The comparison mode is no longer a parameter of the shared band resolver, so the two ladders cannot silently diverge again",
    "Ladder thresholds and multipliers, component weights, pillar weights, aggregation, caps, and grade thresholds are unchanged",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_MERGED_MINT_GRADER: MethodologyChangelogEntry = {
  version: "9.1",
  title: "One mint grader: incident decay, key custody, and quorum granularity",
  date: "2026-08-08",
  effectiveAt: 1786147200,
  summary:
    "The standalone Mint Authority Score is retired and its distinct signals are merged into the Economic Control pillar's mint component. A resolved mint incident now decays instead of disappearing, MPC/HSM key custody reclassifies an externally-owned mint key, multisig quorum granularity replaces a binary strong-quorum test, and Safe module evidence is a small modifier. This is the only deliberate score-moving change in the consolidation wave.",
  impact: [
    "A resolved mint incident caps the mint component at 79 while recent (under 24 months), 85 while aging (24-48 months), and 90 once dated (48+ months), so it can never score as a clean record; an active incident keeps its unchanged critical path",
    "An externally-owned mint key takes a 3-point quality penalty that reviewed MPC or HSM custody attestation waives, mirroring the retired engine's issuer-backend treatment",
    "Multisig mint authority is graded on threshold, signer set, timelock, and Safe module surface instead of a single strong-quorum test; credits are relief against the penalty and can never lift a score above its posture rung",
    "A reviewed Safe module or guard on the binding mint control applies a 2-point penalty; unknown and not-applicable module surfaces are inert",
    "41 of 337 published cards moved their mint component (-1 to -3 points) and 16 moved their published score by one point; every letter grade is unchanged, verified by a full-set replay against the 9.07 release baseline",
    "The curated `authorityPosture` field no longer affects the Safety Score: V9's derived posture is canonical and a curated-vs-derived disagreement raises a curation-queue item instead. It is still a structural input to the depeg resolver, so re-curating a posture can move a published depeg verdict",
    "Mint route-family pricing is excluded by design because the cap and claim semantics already price it; pillar weights, aggregation, caps, and grade thresholds are unchanged",
    "Breaking for header-keyed CSV consumers: the homepage and screener exports rename the `Mint Authority Score` column to `Mint Control Score` and `Mint Authority Band` to `Mint Control Band`. Band keys, filter values, and saved screener URLs are unchanged, and the export provenance line now stamps the safety-score identity instead of the retired mint-authority lane",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_NATIVE_INPUT: MethodologyChangelogEntry = {
  version: "9.07",
  title: "Native input pipeline replaces the V8-shaped bridge",
  date: "2026-08-07",
  effectiveAt: 1786116293,
  summary:
    "The V9 compiler now captures a native input schema; the retired V8 scoring engine no longer executes, and no published score, grade, pillar, breakdown, or reason changes.",
  impact: [
    "Input identity is bound to the V9 evaluation build instead of the retired V8 digest",
    "The V8 dimension engine, penalty blends, and evaluation-build manifest are deleted",
    "Peg-analytics publication is an explicit producer step with unchanged content and cadence",
    "Captures taken before 9.07 remain replayable read-only through the retained v3 parser",
    "Backing, Exit, and Economic Control weights, score aggregation, caps, and grade thresholds are unchanged",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_STRESS_STATE_DIGEST_REMOVAL: MethodologyChangelogEntry = {
  version: "9.15",
  title: "Stress-state digest removed from published cards",
  date: "2026-08-09",
  effectiveAt: 1786304559,
  summary:
    "The published card drops `stressStateDigest`. The what-if stress evaluator it identified was never wired into any published surface, and no consumer read the digest.",
  impact: [
    "`stressStateDigest` is no longer present on Safety Score V9 cards, in the V9 response schema, or in the OpenAPI contract",
    "No score movement: the field was an identity digest over retained scoring state, never an input to any pillar, cap, or grade",
    "The unused stress what-if evaluator that consumed the identified state is removed with it",
    "Pillar weights, score aggregation, structural caps, and grade thresholds are unchanged",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_ACCESS_STRUCTURAL_APPLICABILITY: MethodologyChangelogEntry = {
  version: "9.16",
  title: "A reviewed access fact stops being reported as unreviewed",
  date: "2026-08-10",
  effectiveAt: 1786319466,
  summary:
    "Two engine mechanisms made the access branch publish 'we never looked' about assets it had looked at. The transfer scope test is contract-addressed, so a chain-native asset with no contracts by design could never satisfy it; and an inherited freeze verdict whose upstream is not a tracked asset was deleted rather than measured. Both now resolve to an explicit structural fact, and neither invents data where no current review exists.",
  impact: [
    "A curated transfer review publishes a known posture with the applicability basis `non-contract-native` when the asset offers nothing the contract-scope machinery can address — no supported-chain contract, no material supported-chain supply — and every reviewed deployment sits on a chain outside the supported chain registry. The curated review is then the complete deployment scope, not a partial view of one",
    "That path is fail-closed on every leg: one supported-chain deployment, any material supported-chain supply, a review touching a supported chain, or a stale or absent review, and the asset keeps gapping as `missing-access-review` exactly as before. Three assets qualify — FUSD on Zano and the two Zephyr protocol assets",
    "An `inherited` freeze verdict that names no tracked upstream is retained as `inherited-untracked-upstream` instead of being dropped. No upstream id and no failure domain are asserted, because the branch verifies neither; the reach stays `possible` and the gap is the measured `inherited-access-exposure` rather than missing data. Seven assets move: DAI, crvUSD, BUCK, FPI, lisUSD, LUAUSD, and NXUSD",
    "Freeze facts stay bounded-unknown for scoring; the freeze exposure those seven assets publish moves from `unknown` to the measured `possible`. Transfer facts that become known publish a posture where they previously published none",
    "Pillar weights, score aggregation, structural caps, and grade thresholds are unchanged; no card changes grade",
    "The curation incentive is corrected at the source: an honest `inherited` verdict is no longer penalised as an unreviewed asset, which is what pushed the wave-1 over-suppression of 29 verdicts restored in `1134ab32f`",
  ],
  commits: [],
  reconstructed: false,
};
