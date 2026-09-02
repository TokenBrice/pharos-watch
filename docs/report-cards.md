# Safety Scores

Safety Score V9 is the sole active stablecoin safety model. It publishes evidence-backed grades from A+ through F, with NR reserved for assets whose required facts cannot be bounded honestly.

## Methodology Identity

- Active model: `v9`
- **Current methodology version:** `v9.46`
- Public response schema: report v5 with score trace v3
- Policy: `shared/data/safety-score-v9/methodology-policy-candidate-v1.json`, parsed and digested by `shared/lib/safety-score-v9/policy.ts`
- Implementation: `shared/lib/safety-score-v9/`
- Structured changelog: `shared/data/methodology-changelogs/safety-score/`
- Public methodology: `/methodology/#safety-scores-methodology`
- Scoring history: `/methodology/scoring-changelog/`

Historical V8 methodology is documented in the scoring changelog. It is not a production API, fallback, selector input, or frontend model.

## V9 Model

V9 evaluates three pillars:

| Pillar | Aggregation weight | Scope |
| --- | ---: | --- |
| Backing | 40% | Reserve quality, mechanism solvency, custody, assurance, and loss-bearing structure |
| Exit | 35% | Same-notional executable capacity, cost, settlement, confidence, independent backup credit, and stress horizon |
| Economic Control | 25% | Mint, upgrade, oracle, bridge, and other binding control paths |

The weights allocate bounded headroom; they are not an unrestricted weighted average. The evaluator applies evidence ceilings, peg behavior, track record, dependencies, wrapper-local risk, structural caps, and causally attributed danger after pillar evaluation.

Missing evidence is classified by reason and ownership. A bounded documentation or integration gap can remain rateable under an explicit ceiling. An unbounded required fact returns NR. F is reserved for causally attributed measured danger rather than ordinary uncertainty.

Live reserve percentages are scoring weights, not slice identities. An adapter may attach a namespace-qualified stable `sourceKey` to a reserve category and the reviewed reserve sidecar carries the same key. A keyed live row joins one-to-one and fails closed when its reviewed key is missing or duplicated; the key remains stable across display-label edits and rebalancing. Historical unkeyed captures use a unique normalized-name compatibility join. Neither path compares the reviewed percentage with the live percentage, and both Backing classification and dependency compilation consume the same match set.

Reserve classification and reserve composition have separate freshness clocks. A reviewed classification remains current for 365 days. Composition remains current for 31 days plus a fixed 7-day reporting grace, for a 38-day effective window. Both clocks apply before curated facts are overlaid onto live adapter rows, so fresh percentages cannot keep an expired classification score-bearing and a classification review cannot extend stale percentages.

The `tether-transparency` live adapter is declared under the 7-day disclosure source-age tier rather than the 3-day dashboard tier, so its totals and chain details stay admissible up to seven days old; the tier assignment and its cadence rationale are owned by [live-reserves.md](./live-reserves.md#adapter-registry). Reserve-category percentages remain curated in `liveReservesConfig.params.slices` and do not age with the feed, and those totals are currently unscored for `fiat-cash`, so the wider bound protects live strong backing-evidence admission rather than a scored reserve number.

A stale exposure whose composition came through the audited fallback carries `stale-audited-reserve-composition` rather than `partial-reserve-review`. A complete composition signed and reconciled by an independent attestor is stronger evidence than a partial review even once it ages, so it keeps a ceiling at the `adequate` rung the policy declares for it instead of the generic `limited` floor. The evaluator also honours the `ceilingRule.level` each ceiling reason declares rather than flooring every one at `limited`; the weakest declared level still wins.

Admission of a reviewed composition and the strength it enters at are separate decisions. An independent audit is evidence about the reserves; prudential supervision is evidence about the issuer. Supervision therefore does not gate admission, only the rung: a prudentially supervised issuer's corroborated composition keeps `issuer-attested` strength (or `independent` where a verified audit or examination reconciles it directly), while an unsupervised issuer's independently attested composition is admitted one rung down as `static-validated` and can never reach `independent` through that path. The lower rung is reachable only where a live reserve producer was observed returning nothing for that capture, so an asset with no live producer keeps the standalone path and an asset excluded from falling back is not rescued. Audited fallback evidence keeps the report's own publisher and dates rather than being emitted as an anonymous standalone review, and it carries the 38-day composition window rather than the 365-day audit window it was admitted under, so the rung degrades as the composition ages. Because the publisher is retained, a lapsed composition resolves to `published-evidence-expired` instead of `issuer-undisclosed`; unknown provenance still fails closed.

Curated collateral links enter the dependency overlay only when the same curated composition is admissible for the reserve envelope and no live reserve slices are present. An expired, incomplete, or otherwise inadmissible curated review therefore contributes no asserted basket edges for that cycle; the existing reserve-envelope gap (such as missing or partial reserve composition) remains the bounded score consequence.

Economic Control prices mint, upgrade, oracle, bridge, and other binding control paths. Mint-component posture derivation, the scoped-control-question contract, and the ceilings each takes are owned by [mint-authority-scoring.md](./mint-authority-scoring.md#current-v9-scope); this document keeps only the pillar-level contract.

The policy semantic digest binds every score-bearing reshape and freshness gate: the insufficient-evidence withhold band, danger and F-grade peg predicates, pre-exit danger predicate, material-bridge high-share band, and the separately named evidence-expiry windows used by reviewed research, access, overlays, and reserve evidence. Counterfactual replay can change those fields in a policy clone and receives a distinct semantic digest for any changed gate. Report-card presentation also derives grade thresholds from the active scoring policy rather than maintaining another threshold table.

Oracle applicability is explicit in Economic Control. A reviewed path with no price-sensitive oracle or internal valuation authority is not applicable and emits no scored component. If no other binding control remains, the neutral empty set resolves to 95 without manufacturing a display row. A genuinely oracleless mechanism scores 95; privileged internal pricing scores 45. The latter can apply to a top-level mint, redemption, NAV, or exchange-rate quote even when borrower liquidation branches do not exist. External oracle tiers retain their existing scores.

Oracle dispositions reviewed before `9.17` are interpreted under that current contract rather than the older question of whether borrower-specific liquidation branches exist. A reviewed top-level mint, redemption, NAV, or exchange-rate authority remains applicable without fabricated branch rows. A genuinely non-price-sensitive mechanism remains `not-applicable`; unresolved applicability stays bounded, while verified adverse oracle evidence can produce a measured-adverse component and its corresponding structural ceiling.

Responsibility follows causal provenance rather than the nearest compiler or evaluator stage. Explicit reason-level ownership wins; inherited reserve gaps, unavailable upstream backing or role-pillar evidence, and missing parent scores carry every originating owner into downstream reasons instead of defaulting to an integration gap. Every attributed root receives a causal-root-qualified score path even when it is the only root, so adding another root cannot rename an existing public fact; only unattributed fallbacks retain aggregate base paths, and ownership never becomes part of fact identity. Applicable-but-unpublished mechanism metrics may retain their conservative structural signal, but remain issuer-undisclosed rather than becoming measured-adverse. A reviewed external exit output whose identity is known but cannot receive a same-notional valuation is producer-failed, while an issuer-undisclosed settlement asset remains issuer-undisclosed; neither becomes scoreable. Exact DEX observations retain the output-token reference already used by their execution model when it is provenance-bound. The captured peg/NAV record remains authoritative when available; only a previously unvalued output uses the route-carried value, with the captured peg/NAV record independently establishing its expected value. A non-USD output without an authoritative expected reference still fails closed, and this path never infers an unpriced external redemption asset at par. Date-only mechanism and exit-output dispositions are admitted only after their reviewed UTC day, so current curation cannot leak into earlier replay clocks. Partial mint-control reviews retain controls that were actually reviewed while unresolved deployment surfaces remain bounded and fail closed. Strategy-vault wrapper loss-control facts can also use those reviewed local controls as wrapper evidence, but unresolved controls remain bounded elsewhere and risk-transfer credit stays zero unless a separate enforceable parent-loss backstop is reviewed.

`published-evidence-expired` identifies a stale document that the issuer or an upstream parent did publish but Pharos has not kept current. It is assigned only when the stale evidence record identifies that publisher; missing history, unrelated evidence, and unknown publisher provenance keep the existing fail-closed responsibility. The value changes attribution and public copy, not score arithmetic.

Shared-dependency evidence ownership is local to the receiving asset. When several reviewed assets share one critical control identity, the resulting common-mode signal is priced per asset from that asset's own member facts. A reviewed member whose control observation is bounded-unknown stays measured-adverse — an unverified critical controller cannot make a shared failure domain safer — while a missing, stale, or unresolved member remains an integration gap. Evidence confidence is high only when the receiving asset's own member facts are known, so neither the asset carrying the unknown member nor its peers gain from the gap, and the published reason states how many shared members are bounded-unknown.

The common-control census counts independent root liabilities rather than presentation assets. A wrapper or derivative cannot make its own parent satisfy the multi-liability threshold, and same-issuer controllers remain diagnostic rather than external common mode. Local mint, upgrade, bridge, and related control signals become deployment-scoped only when every member is reviewed as non-root, the exact deployment is named, and the liability partition is complete and reconciled; otherwise the signal remains global and fail-closed. Mento issuer attribution applies the same-issuer rule to the shared Safe rather than manufacturing a cross-issuer dependency.

The supply partition that bridge materiality reconciles against can come from the exact captured per-chain rows, from a V9-only observed attribution (the wM/Centrifuge reviewed deployment-unit partitions, the XAUT lock/mint group partition, or the independent-liability allocation), or — for a native gas token whose whole liability sits on one chain behind one reviewed route with no probeable contract equal to the native supply — from the curated native single-route attribution (`CURATED_NATIVE_SINGLE_ROUTE_SUPPLY_ATTRIBUTION`, currently `xdai-gnosis` only). That curated lane distributes the already-published aggregate onto the single reviewed route (share 1) only behind four fail-closed gates (reviewer-signed dated entry; exactly one reviewed route matching the entry's route id; no per-chain supply rows, so any real partition wins; finite positive published aggregate), asserts no new supply number, and on any failed gate the asset keeps the aggregate-only null-share treatment. See [`Supply Pipeline`](./supply-snapshot.md#supply-pipeline) for the gate detail.

Subthreshold unrecognized chain-label supply pools are tolerated by the bridge-materiality completeness proof and no longer surface as public evidence-responsibility facts. At or above the common-mode materiality floor, unmatched bridge supply still fails closed through the ordinary material bridge-supply reason. The aggregate unattributed share is graded on the same 10% deployment-materiality floor the per-row check uses, rather than on any residue at all. Residue at or above the floor keeps `material-bridge-supply-unmatched` and its 55 control-unverified ceiling; residue below it publishes the diagnostic `nonmaterial-bridge-supply-unmatched`, which carries no ceiling and does not classify its pillar as limited evidence, so a rounding tail stays visible without bounding a score. The material check is deliberately independent of the completeness proof: that proof clears each unmatched row against the floor one at a time, so rows that are individually immaterial can sum past it and still prove complete.

Coverage that no supported adapter can observe is unsupported methodology, not transient producer failure. Deployment census coverage is partitioned per chain: deployments on chains without a supported liquidity provider are reported as an explicit unsupported remainder, and the supported scope still publishes ordinary coverage. An exit surface with no retained pool, or with retained pools but no score-eligible execution-capability pool and no applicable execution-capability gate, is method-unsupported when its census remainder is method-unsupported; its runtime route evidence is then reported as unsupported rather than missing, so later adapter coverage returns the asset to scoring without renaming an existing public fact. Gap accounting for a populated p4a.9 DEX surface follows the public route-selection bound rather than the full recognition set: leftover `target-unresolved`, incomplete exact-capture, quote-budget deferral, and reviewed model-limit gates do not keep `incomplete-dex-route-coverage` open once the budgeted score-eligible routes are observed. Exact-route scoring completeness stays strict and is not widened. A recognised venue whose only remaining gates are reviewed model limits is method-unsupported rather than producer-failed. Unreviewed dependency relationships are method-unsupported when the asset has no live-reserve adapter and stay producer-failed when one exists. An asset with no usable current price whose tracked peg record is already adverse is measured-adverse; a clean record with no usable price stays a quiet observation and its deviation is never coerced to zero.

Exit capacity is route-specific. A route below both the first positive 1% completion and $100K absolute-capacity breakpoints receives a zero route score; reaching $100K while still completing less than 1% caps the route at 50. A fully observed zero or immaterial issuer/protocol route remains included as the attributable primary evidence with its measured capacity, completion, confidence, and cap; it is not relabeled as unsupported merely because the measurement is adverse. A zero Exit pillar emits `no-viable-exit-path`. Exchange-wide volume, aggregate DEX TVL, and issuer reserves do not substitute for executable capacity on the selected route.

Since methodology 9.46, an external message-validation quorum is a named authority rather than an unknown one. A bridge control whose controlling party is a LayerZero DVN set, a Chainlink CCIP DON/RMN, a Bantu AMTP validator group or an equivalent rotating validator population has no single controller address to record, and until 9.46 the authority ladder had no value that could express it: a reviewer who wrote the quorum down with its failure domains and its sources still compiled to `unknown`, which under the route-level weakest-authority merge dragged every route the quorum covered into an unresolved-control gap owned by the issuer. The `validator-quorum` rung is deliberately weak. On the control-quality ladder it holds the bounded-unknown default, where a named issuer backend already sits, and strictly below the concentrated-admin rung a multisig starts from, so naming a validation domain can never lift a control into the multisig class; on the weakest-authority merge it sits below `issuer-backend` and above `eoa`, so a route co-controlled by an unattested single key still reports that key as its weakest link. The reader-facing effect is that the quorum's real, published identity is scored instead of being reported as an issuer non-disclosure. Two authored authority types, `bridge` and `custodian`, also had no branch in the authority mappers and fell through to `unknown`; they now compile to `contract` and `issuer-backend` respectively.

Since methodology 9.451, a mechanism component the reviewer covered and found unpublished publishes that finding: its gap message carries the review date, the recorded reason, and the source that was checked, rather than the generic sentence shared with a component nobody has reviewed yet. The curated `applicability: "unavailable"` rationale and `sourceUrl` already existed in the mechanism-review overlay; only `not-applicable` passed them through. The input remains bounded-unknown, the gap keeps `bounded-mechanism-review` and its `issuer-undisclosed` owner, and the open data-point count is unchanged, so this moves no score or grade. The reader-facing reason-code label changes with it, from "Mechanism review incomplete" to "A mechanism detail is unresolved", which is true both of an adjudicated non-disclosure and of an outstanding review. The same-UTC-day overlay clock guard is unaffected and remains `method-unsupported`.

Since methodology 9.45, an open operator-batched redemption request queue whose settlement completion bound is unproven is a bounded evidence gap, not a measured zero: Exit floors at the bounded-unknown score under the `exit-unverified` ceiling with a visible warning, and the standalone redemption route is unrated rather than zero. The v9.44 measured-zero ruling remains unchanged; only an observer-synthesized zero standing in for an unproven completion bound is reclassified.

A faster reviewed settlement term needs the exact delay, a review date, and a source for that term; conservative corrections may still lower credit without asserting a favorable promise. Curated cost and settlement terms can therefore move Exit in either direction. When the same-notional stress capacity, settlement, or cost needed for scoring is not established, the route publishes a `bounded-terms-gap`: supported partial facts remain visible, but the route receives no primary or diversification credit from a generated fallback. A measured-zero DEX does not turn that separate uncertainty into measured danger; the Exit pillar remains bounded-unknown where the rest of the evidence permits a rating.

Exit selects the strongest eligible route as primary. An independent secondary route can add `min(10, 100 - primary score) × secondary score / 100` points. This is redundancy credit, not another route score: a weaker backup earns less credit, and backup credit alone cannot lift an imperfect primary route to 100.

Canonical V9 ordering is locale-independent. Route ties, dependency paths and diagnostics, reviewed-transfer inputs, supply-attribution records, and bounded publication reasons use JavaScript code-unit order rather than host-locale collation. Numeric scores and grades do not depend on this ordering, but route/path identity, ordered traces, and their digests can rotate when a previously published non-ASCII or case-sensitive key collated differently on the runtime host.

Serial dependencies remain binding because the child cannot diversify away the parent claim. Basket dependencies contribute at their live exposure weights. Wrapper-local risks are evaluated separately from the parent asset so a wrapper cannot inherit safety it does not possess. Parent-cap form follows the wrapper relationship rather than the product label: a reviewed third-party risk-absorption wrapper uses the existing strategy-vault treatment, while a wrapper operated by the parent protocol uses the existing native-staked treatment.

Wrapper allocation reviews are fixed-block, expiry-bounded facts rather than live compilation reads. The curated row records the allocation calls and factual posture (fully on-chain custody, local leverage band, and capital-use class); the fact producer maps those fields onto the existing wrapper ladder. Fully on-chain allocators have no applicable off-chain custody/escrow fact, while their lending, strategy reuse, or loss-absorption exposure remains independently assessed. Direct serial wrappers keep parent custody and reuse in the parent dependency instead of duplicating it locally.

Reviewed incidents use a domain-routed contract rather than a generic penalty. Control, wrapper-local, operational, and peg incidents enter the existing component that owns the risk; root-claim, deployment, integration-only, and holder-exit scopes prevent an event from being charged beyond the liabilities it affected. Active, mitigated, and resolved states require dated remediation evidence, and repeated evidence cannot charge the same domain fact twice. Incidents therefore remain part of the three-pillar model rather than becoming a fourth scoring dimension.

### Cap limits and scope gates

The `signalLimits` table is not a table of whole-score ceilings. Each rung has one of three roles, selected by the signal's `economicLossScope` and pillar pricing:

| Signal context | Role of the limit |
| --- | --- |
| `global-claim` and legacy-scope signals | Hard cap on the published whole score; legacy scope binds when responsibility is undefined or measured-adverse, while `global-claim` binds only when responsibility is measured-adverse |
| Deployment-scoped signals | Proportional exposure floor, published as `exposedScore`, rather than a whole-score cap; the per-card values are live publication output from `GET /api/report-cards/v9` |
| Pillar-priced signals without an asserted residual | Inert as a whole-score cap; a signal already priced inside a pillar cannot impose a second ceiling without an asserted `additionalHardCapRisk` residual |

This scope gate prevents a pillar fact from being charged twice while retaining the proportional deployment-risk adjustment. Cap limits are integral in the published score space, and a pillar-priced signal can bind only when its residual is explicitly asserted.

Equal-limit caps publish a specific observed or withheld fact before a generic absence reason. Remaining ties are resolved by source priority, then locale-independent code-unit ordering of kind and reason, so the selected reason and full cap trace remain total and byte-stable across replay environments.

The cap/scope decision follows the liability a reviewed control can impair. A root-reaching or unresolved local control keeps the global hard-cap treatment. A proved deployment-local control with a complete reconciled share instead contributes the proportional exposure adjustment; if that same control still binds the Economic Control component, its causal attribution remains attached even when the proportional adjustment is zero. Scope correction cannot by itself turn an unchanged measured D or F into NR.

Chain maturity is also reviewed rather than inferred from age. Admission requires all five dated gates: 36 months of continuous production history; a 365-day liveness record; permissionless participation or at least 21 independently operated block producers or finality members; no unilateral instant change path, with L2s at Stage 1 or later and at least a 7-day holder exit; and documented bridge or data-availability dependencies with a holder exit. The admitted set and every per-chain admit/exclude rationale are owned by `CHAIN_MATURITY_REVIEWS_V1` in `shared/data/safety-score-v9/chain-maturity-reviews-v1.ts`, projected into the policy as `matureChains`; do not copy the roster here.

Rateable report-v5 cards include complete Backing, Exit, and Economic Control breakdowns plus per-card live-reserve provenance. Each breakdown reconciles evaluator and published values through ordered adjustments. NR cards carry explicit reason rows and have `breakdowns: null`; they never report a binding cap (`bindingCap: null` and every `caps[].binding: false`). The `caps[]` array may still list candidate ceilings as diagnostics.

### Asset premiums and dependency inheritance

The policy-declared `market-anchor-longevity` premium applies only to `usdt-tether` when its eligibility gates are met: market rank 1, at least 120 months of history, base score at least 75, exit score at least 70, strong evidence, a clean peg, and the `stress-redemption` plus `reserve-reconciliation` operational components. It adds 12 points, raises the `signal:centralized-mint:low` cap from 83 to 87, and limits the public score to 87, the A+ threshold.

The public premium is intentionally not inherited. `applyV9AssetPremium` does not reassign `inheritableScore`, and `projectV9DependencyScore` returns that pre-premium value. Therefore USDT's public card can show 87 while children such as `steakusdt-steakhouse` and `susdt-spark` correctly inherit 83. A child snapshot carrying 83 is not stale and must not be resynchronized to the parent's premium-adjusted public score.

## Canonical Publication

The publication pipeline has two active stages:

1. `prepare-safety-score-v9-input` runs immediately after each successful half-hourly DEX publication. It captures the publication-exact base input and peg-provenance seed and binds them to that exact DEX generation.
2. `compute-safety-score-v9` runs at minutes 22 and 52. It rejects an input whose DEX dependency no longer matches the latest accepted generation, compiles the V9 fact set, evaluates the policy, and publishes the accepted result.

Since methodology `9.07` the private upstream input is a native V9 capture. Schema v4 carries exactly the fields the V9 compiler reads and drops everything the retired V8 report-card projection needed: bluechip ratings, resolved blacklist statuses, collateral-drift diagnostics, the non-current chain-circulating buckets, and every DEX row field outside the exit-route observations. Its capture identity is `model: "v9-input"`, bound to the V9 evaluation build; the retired V8 evaluation-build identity is gone with the engine. Base-input generation ids keep the `report-cards-input:v1:` prefix, which is a published format namespace pinned by the public fact-set schemas, the OpenAPI spec, the publication codec, and the `safety_score_history_v2` CHECK constraint — not a projection version. Which projection minted an id is carried by the input identity.

The prepare cron owns:

- `report-cards:fixed-input:exact` (cache envelope v2, carrying the v4 capture)
- `report-cards:v9-peg-provenance-seed:exact`
- publishing the peg-analytics aggregate cache, now an explicit producer step rather than a side effect of building V8 cards. Content and cadence are unchanged: one publish per capture, at the half-hourly chart slot.

V9-only enrichment is loaded directly by the canonical compiler. Supply attribution runs on its dedicated fenced schedule and is admitted only when its identity matches the fixed scoring generation. The producer due interval is shorter than the compiler's freshness window so the existing 15-minute trigger grid lands healthy captures roughly every 30 minutes. Compilation normally follows an `ok` same-version core slot, but durable same-slot, same-Worker `stablecoins` publication evidence is sufficient when the parent slot row is degraded or otherwise not terminal. The compiler still rejects a fixed input whose stablecoin timestamp no longer matches the live cache. Stale, future, registry, and inventory mismatches are reported with clause-specific reason codes.

Canonical accepted state is stored in:

- `report-cards:v9`
- `report-cards:v9:publication-health`

Both rows carry matching model, schema, methodology, policy, evaluation-build, base-input, and publication identities. The canonical writer accepts only newer publications and commits an accepted publication with its current health atomically.

Canonical arrays and digest inputs use the same locale-independent code-unit comparator throughout compilation and publication assessment. Replaying identical facts therefore cannot select a different equal-scoring route, reorder a dependency path, or hash a different reviewed-transfer sequence solely because the runtime locale changed.

Publication is fail-closed at the identity and system level. Missing, malformed, stale, or incompatible score-bearing inputs hold the last accepted ratings. Asset-local producer failures do not freeze unrelated ratings while at least 90% of active assets remain unaffected. A held attempt updates publication health only when the retained accepted identity can be verified; an unreadable accepted ledger records a separate failed attempt and leaves publication and health untouched. Post-9.19 writes require the per-fact disclosure paths, while the reader remains compatible with authenticated pre-9.19 snapshots.

Deleting the superseded D1 cache keys still requires a coordinated cleanup migration, because migrations run before the new Worker is active.

## API

`GET /api/report-cards/v9` is the only live Safety Score API.

The handler reads the canonical publication and health row, validates the complete current response, and never recomputes or falls back to V8. Missing, malformed, or incomplete accepted state returns `503`; an identity mismatch between otherwise valid rows serves the authenticated publication as explicitly held. The retired unversioned `/api/report-cards` route and preview aliases return `404`.

A current response emits `X-Safety-Score-Status: current`. A held response serves the last accepted ratings, emits `X-Safety-Score-Status: held`, uses the accepted timestamp for freshness, and forces `Cache-Control: no-store`.

The response includes:

- complete V9 identity and source digests
- methodology and policy identity
- active-set completeness
- current or held publication health
- native three-pillar cards and numeric breakdowns
- per-card `backingFromLiveReserves` provenance for score-grade reserve coverage
- the canonical serial/basket dependency graph
- accepted `updatedAt`

See [API Reference](./api-reference.md) for the wire contract.

## Consumers

All active safety consumers resolve the canonical V9 publication:

- Safety Scores, homepage, stablecoin detail, comparison, portfolio, and dependency map
- Yield Intelligence safety hydration
- daily digest and mint/burn flight-to-quality classification
- Telegram grade-change alerts
- OG cards, public datasets, and coverage/status surfaces
- append-only safety-grade history

Consumers that require current ratings reject held publications. Display surfaces may show the held accepted snapshot with an explicit notice. No active consumer uses the V8 compact score cache or computes V8 cards on request.

Selector creation recomputes against the live V9 publication (`functions/lib/selector-canonical-snapshot.ts`); a `503` now indicates canonical-source or schema failure, not a policy hold. Existing signed selector snapshots remain readable through their historical contract.

## History

The compiler validates each asset's facts independently. An attributable asset-local build or schema failure publishes that asset as a producer-failed NR result while unaffected assets continue, provided at least 90% of active assets remain unaffected. Dependency, aggregate, evaluator, identity, and other global failures still hold the whole publication.

Replay captures taken before 9.07 carry the retired v3 exact fixed input in cache envelope v1. `npm run safety-score-v9:replay` still accepts them, read-only: nothing writes that shape any more, but frozen operator captures must keep replaying byte-for-byte through the same compiler. `--input` therefore accepts both the native v4 capture and a pre-9.07 v3 capture, in raw or envelope form.

`snapshot-safety-grade-history` appends identified V9 organic transitions and suppresses writes while publication is held. During a partial publication it also suppresses transitions for quarantined assets and their affected dependents, so operational NR and recovery edges are not recorded as organic rating changes. Each V2 row records model, methodology, policy, evaluation-build, base-input, publication generation, and transition kind.

The writer compares *publication* identities. The capture's `v9-input` identity never reaches it, so a capture-producer change cannot manufacture a boundary or an organic transition by itself. The evaluation build is part of publication-identity comparability, so the first publication after an evaluation-build rotation writes one `methodology-boundary-baseline` per asset rather than organic grade changes.

`GET /api/safety-score-history` remains the public per-asset timeline. Historical V8 and activation-boundary rows remain readable as archive data; they are never live publication inputs.

The stablecoin detail Grade History module combines that legacy archive with `GET /api/safety-score-history-v2`. It collapses consecutive same-grade baselines, while retaining a boundary row when the published grade changes and labelling it as a methodology baseline rather than implying an organic upgrade or downgrade. This keeps the current V9 grade and the date it first appeared visible without comparing non-comparable publication identities.

## Frontend

- `src/app/safety-scores/v9-client.tsx` owns the active ratings grid, filters, and sorting. Its grade filter composes with an inline peg filter that groups the stablecoin-list `pegType` values into USD, non-USD fiat, and commodities (gold or silver); selecting the active peg pill again clears that peg constraint.
- `src/app/safety-scores/pillar-explainer.tsx` renders the static three-column primer immediately below the hero. It introduces Backing, Exit, and Control through one plain-language question apiece, shows the current 40% / 35% / 25% weights, and keeps methodology detail out of the ratings grid.
- `src/lib/safety-score-data-coverage.ts` and `data-coverage-module.tsx` derive and render the score-input coverage module on `/coverage/`. Collapsed it shows one sentence of headline counts and the open-data-point split by evidence responsibility; expanding it adds the responsibility explanations, the per-count breakdowns, and the most common reason codes by affected assets. A publication hold replaces the headline sentence. The Safety Scores hero no longer embeds this module.
- `src/components/report-card-mini-v9.tsx` renders the V9 card treatment.
- `src/components/stablecoin-detail/stablecoin-safety-score-v9-card.tsx` renders detail-page score, pillars, evidence, and breakdowns.
  - Pillar breakdowns render as `groups`, not a flat row list. Backing nests its components under the Reserves and Mechanism groups the producer already computes — component `effectiveWeight` sums exactly to each group's weight — with `mechanism`-sourced components under Mechanism and both `reserve-exposure` and `reserve-concentration` under Reserves. Rows sort by weight descending, and components under `2%` of the pillar fold into a `Smaller holdings (N) · X% combined` tail once at least three qualify. Exit and Control render a single unlabelled group; Exit keeps producer order because its route components are few and already meaningfully ordered. The Exit summary names the primary route and backup credit, while actual stress-request completion appears separately from the capacity component score. Other eligible routes are labeled as evaluated rather than implying that every route was blended into the pillar.
  - The Economic Control breakdown leads with its binding components, cheapest first, so the row that sets the pillar score is read first. Its mint component renders as `Mint authority`, matching the detail page's Mint Authority section below the card. Non-binding bridges roll into one `Bridge deployments` composite carrying the cohort's **worst** score — the pillar rule is a minimum, so an average would flatter it — expandable to the full list. Any *binding* bridge stays a top-level row and must never be folded away. The composite needs at least two members; otherwise the bridge renders as an ordinary row. This keeps large deployment rosters compact without hiding the score-setting control.
  - Component bars are tinted only when the input is the problem: neutral below the warn threshold, amber under 65, rose under 40. Those boundaries are the published grade-band floors for B and D, so a tinted bar always reads as "C or worse" and a strong asset's breakdown stays monochrome.
  - `Why not higher` renders the two causal buckets from `scoreTrace`: `adverseAttribution` (measured and adverse) as a flat list, and `boundedUncertaintyAttribution` (unresolved) grouped by `responsibility`. Pharos's own gaps — `producer-failed`, `integration-missing`, `published-evidence-expired` — are named as ours rather than folded into a neutral "not measured".
  - Attribution `path` values are machine keys and are never rendered; producer messages quoting four or more decimal places round to three for display.
- The detail card renders an evidence summary under the score, pillar rows, score adjustments/caps/construction, an access panel, and `EvidenceFooter`, which provides methodology links plus an optional folded `Sources (N)` list; it has no evidence chip. Dependency context remains with `ContagionSnapshot` ("Dependency Context"), which owns the full dependency graph.
- `AccessPosturePanel` renders the four scored access enums in the summary rail at `xl+` and inside the card below `xl` (`xl:hidden`), the same split `#price` uses. `buildSafetyScoreV9AccessRows` exposes the rows without building the whole card presentation. `primaryExit` distinguishes three kinds of absence and the panel treats them differently. `none` is a *reviewed negative* — an exit surface observed complete with zero routes — and renders as "None". `undisclosed` means no credited route resolved a posture, or the exit surface was never observed; it renders as an explicit "Not disclosed" row, because dropping it would let an evidence gap read as a clean bill of health. `unknown` means credited routes exist but their access facts are unresolved; it alone enters `unknownFields` and alone drops out of the panel. The posture is derived from every route the Exit pillar credits — score-eligible routes plus reviewed issuer-, protocol-, and eventual-redemption routes — so the panel cannot contradict a scored exit route.
- `src/lib/safety-score-v9-labels.ts` is the single shared machine-key to display-copy map for public V9 surfaces. Cap kinds, failure domains, and attribution paths draw on overlapping producer keys, so new modules extend this map rather than adding their own.
- `src/components/radar-chart-v9.tsx` renders Backing, Exit, and Economic Control comparisons.
- `src/components/safety-score-v9-status-notice.tsx` renders held publication state on every other surface. Reason codes and assessment detail are evaluator identifiers and are never rendered raw; both surfaces route hold reasons through `describeDataCoverageHoldCauses`.
- `src/hooks/api-hooks.ts` exposes `useReportCardsV9` and `useSafetyScoreHistory`.

The retired V8 report-card components, V8 portfolio synthesis, and contagion stress simulator have been removed. A future stress feature must define native V9 semantics rather than recomputing retired V8 dimensions.
