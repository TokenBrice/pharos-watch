# Safety Scores

Safety Score V9 is the sole active stablecoin safety model. It publishes evidence-backed grades from A+ through F, with NR reserved for assets whose required facts cannot be bounded honestly.

## Methodology Identity

- Active model: `v9`
- **Current methodology version:** `v9.07`
- Public response schema: report v4 with score trace v3
- Policy: `shared/data/safety-score-v9/methodology-policy-candidate-v1.json`
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

Responsibility follows causal provenance rather than the nearest compiler or evaluator stage. Explicit reason-level ownership wins; inherited reserve gaps, unavailable upstream backing or role-pillar evidence, and missing parent scores carry every originating owner into downstream reasons instead of defaulting to an integration gap. Every attributed root receives a causal-root-qualified score path even when it is the only root, so adding another root cannot rename an existing public fact; only unattributed fallbacks retain aggregate base paths, and ownership never becomes part of fact identity. Applicable-but-unpublished mechanism metrics may retain their conservative structural signal, but remain issuer-undisclosed rather than becoming measured-adverse. A reviewed external exit output whose identity is known but cannot receive a same-notional valuation is producer-failed, while an issuer-undisclosed settlement asset remains issuer-undisclosed; neither becomes scoreable. Date-only mechanism and exit-output dispositions are admitted only after their reviewed UTC day, so current curation cannot leak into earlier replay clocks. Partial mint-control reviews retain controls that were actually reviewed while unresolved deployment surfaces remain bounded and fail closed. Strategy-vault wrapper loss-control facts can also use those reviewed local controls as wrapper evidence, but unresolved controls remain bounded elsewhere and risk-transfer credit stays zero unless a separate enforceable parent-loss backstop is reviewed. These changes do not alter pillar weights, score aggregation, caps, or grade thresholds.

Subthreshold unrecognized chain-label supply pools are tolerated by the bridge-materiality completeness proof and no longer surface as public evidence-responsibility facts. At or above the common-mode materiality floor, unmatched bridge supply still fails closed through the ordinary material bridge-supply reason.

Coverage that no supported adapter can observe is unsupported methodology, not transient producer failure. Deployment census coverage is partitioned per chain: deployments on chains without a supported liquidity provider are reported as an explicit unsupported remainder, and the supported scope still publishes ordinary coverage. An exit surface with no retained pool, or with retained pools but no score-eligible execution-capability pool and no applicable execution-capability gate, is method-unsupported when its census remainder is method-unsupported; its runtime route evidence is then reported as unsupported rather than missing, so later adapter coverage returns the asset to scoring without renaming an existing public fact. Unreviewed dependency relationships are method-unsupported when the asset has no live-reserve adapter and stay producer-failed when one exists. An asset with no usable current price whose tracked peg record is already adverse is measured-adverse; a clean record with no usable price stays a quiet observation and its deviation is never coerced to zero. These reclassifications keep the affected surfaces bounded at the same evidence ceiling, so no published score or grade moves.

Exit capacity is route-specific. A route below both the first positive 1% completion and $100K absolute-capacity breakpoints receives a zero route score; reaching $100K while still completing less than 1% caps the route at 50. Exchange-wide volume, aggregate DEX TVL, and issuer reserves do not substitute for executable capacity on the selected route.

Exit selects the strongest eligible route as primary. An independent secondary route can add `min(10, 100 - primary score) × secondary score / 100` points. This is redundancy credit, not another route score: a weaker backup earns less credit, and backup credit alone cannot lift an imperfect primary route to 100.

Serial dependencies remain binding because the child cannot diversify away the parent claim. Basket dependencies contribute at their live exposure weights. Wrapper-local risks are evaluated separately from the parent asset so a wrapper cannot inherit safety it does not possess.

Rateable report-v4 cards include complete Backing, Exit, and Economic Control breakdowns. Each breakdown reconciles evaluator and published values through ordered adjustments. NR cards carry explicit reason rows and have `breakdowns: null`.

## Canonical Publication

The publication pipeline has two active stages:

1. `prepare-safety-score-v9-input` runs immediately after each successful half-hourly DEX publication. It captures the publication-exact base input and peg-provenance seed and binds them to that exact DEX generation.
2. `compute-safety-score-v9` runs at minutes 22 and 52. It rejects an input whose DEX dependency no longer matches the latest accepted generation, compiles the V9 fact set, evaluates the policy, and publishes the accepted result.

Since methodology `9.07` the private upstream input is a native V9 capture. Schema v4 carries exactly the fields the V9 compiler reads and drops everything the retired V8 report-card projection needed: bluechip ratings, resolved blacklist statuses, collateral-drift diagnostics, the non-current chain-circulating buckets, and every DEX row field outside the exit-route observations. Its capture identity is `model: "v9-input"`, bound to the V9 evaluation build; the retired V8 evaluation-build identity is gone with the engine. Base-input generation ids keep the `report-cards-input:v1:` prefix, which is a published format namespace pinned by the public fact-set schemas, the OpenAPI spec, the publication codec, and the `safety_score_history_v2` CHECK constraint — not a projection version. Which projection minted an id is carried by the input identity.

The prepare cron owns:

- `report-cards:fixed-input:exact` (cache envelope v2, carrying the v4 capture)
- `report-cards:v9-peg-provenance-seed:exact`
- publishing the peg-analytics aggregate cache, now an explicit producer step rather than a side effect of building V8 cards. Content and cadence are unchanged: one publish per capture, at the half-hourly chart slot.

V9-only enrichment is loaded directly by the canonical compiler. Supply attribution runs on its dedicated fenced schedule and is admitted only when its identity matches the fixed scoring generation. The producer due interval is shorter than the compiler's freshness window so the existing 15-minute trigger grid lands healthy captures roughly every 30 minutes. Compilation normally follows an `ok` same-version core slot. A degraded core slot can proceed only when the durable publication ledger proves a same-slot, same-Worker `stablecoins` cache generation, and the compiler rejects a fixed input whose stablecoin timestamp no longer matches the live cache. Stale, future, registry, and inventory mismatches are reported with clause-specific reason codes.

Canonical accepted state is stored in:

- `report-cards:v9`
- `report-cards:v9:publication-health`

Both rows carry matching model, schema, methodology, policy, evaluation-build, base-input, and publication identities. The canonical writer accepts only newer publications and commits an accepted publication with its current health atomically.

Publication is fail-closed at the identity and system level. Missing, malformed, stale, or incompatible score-bearing inputs hold the last accepted ratings. Asset-local producer failures do not freeze unrelated ratings while at least 90% of active assets remain unaffected. A held attempt updates publication health only; it does not rewrite the accepted ratings or their timestamp.

Deleting the superseded D1 cache keys still requires a coordinated cleanup migration, because migrations run before the new Worker is active.

## API

`GET /api/report-cards/v9` is the only live Safety Score API.

The handler reads the canonical publication and matching health row, validates the complete current response, and never recomputes or falls back to V8. Missing or incompatible state returns `503`. The retired unversioned `/api/report-cards` route and preview aliases return `404`.

A current response emits `X-Safety-Score-Status: current`. A held response serves the last accepted ratings, emits `X-Safety-Score-Status: held`, uses the accepted timestamp for freshness, and forces `Cache-Control: no-store`.

The response includes:

- complete V9 identity and source digests
- methodology and policy identity
- active-set completeness
- current or held publication health
- native three-pillar cards and numeric breakdowns
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

The compiler validates each asset's facts independently (unchanged by 9.07). An attributable asset-local build or schema failure publishes that asset as a producer-failed NR result while unaffected assets continue, provided at least 90% of active assets remain unaffected. Dependency, aggregate, evaluator, identity, and other global failures still hold the whole publication.

Replay captures taken before 9.07 carry the retired v3 exact fixed input in cache envelope v1. `npm run safety-score-v9:replay` still accepts them, read-only: nothing writes that shape any more, but frozen operator captures must keep replaying byte-for-byte through the same compiler. `--input` therefore accepts both the native v4 capture and a pre-9.07 v3 capture, in raw or envelope form.

`snapshot-safety-grade-history` appends identified V9 organic transitions and suppresses writes while publication is held. During a partial publication it also suppresses transitions for quarantined assets and their affected dependents, so operational NR and recovery edges are not recorded as organic rating changes. Each V2 row records model, methodology, policy, evaluation-build, base-input, publication generation, and transition kind.

The writer compares *publication* identities. The capture's `v9-input` identity never reaches it, so the 9.07 producer change cannot manufacture a boundary or an organic transition by itself. The evaluation build is part of publication-identity comparability, so the first publication after an evaluation-build rotation writes one `methodology-boundary-baseline` per asset rather than organic grade changes.

`GET /api/safety-score-history` remains the public per-asset timeline. Historical V8 and activation-boundary rows remain readable as archive data; they are never live publication inputs.

## Frontend

- `src/app/safety-scores/v9-client.tsx` owns the active ratings grid, filters, and sorting.
- `src/app/safety-scores/data-coverage-view-model.ts` and `data-coverage-module.tsx` render the data-coverage rail in the hero footer (`FeatureHeroSplit`'s `footer` slot), not a standalone card. Collapsed it shows one sentence of headline counts and the open-data-point split by evidence responsibility; expanding it adds the responsibility explanations, the per-count breakdowns, and the most common reason codes by affected assets. A publication hold replaces the headline sentence. The rail replaces the status notice on `/safety-scores`.
- `src/components/report-card-mini-v9.tsx` renders the V9 card treatment.
- `src/components/stablecoin-detail/stablecoin-safety-score-v9-card.tsx` renders detail-page score, pillars, evidence, and breakdowns.
  - Pillar breakdowns render as `groups`, not a flat row list. Backing nests its components under the Reserves and Mechanism groups the producer already computes — component `effectiveWeight` sums exactly to each group's weight — with `mechanism`-sourced components under Mechanism and both `reserve-exposure` and `reserve-concentration` under Reserves. Rows sort by weight descending, and components under `2%` of the pillar fold into a `Smaller holdings (N) · X% combined` tail once at least three qualify. Exit and Control render a single unlabelled group; Exit keeps producer order because its route components are few and already meaningfully ordered. The Exit summary names the primary route and backup credit, while actual stress-request completion appears separately from the capacity component score. Other eligible routes are labeled as evaluated rather than implying that every route was blended into the pillar.
  - The Economic Control breakdown leads with its binding components, cheapest first, so the row that sets the pillar score is read first. Its mint component renders as `Mint control posture`. Non-binding bridges roll into one `Bridge deployments` composite carrying the cohort's **worst** score — the pillar rule is a minimum, so an average would flatter it — expandable to the full list. Any *binding* bridge stays a top-level row: a bridge is the lowest binding control on 37 assets and must never be folded away. The composite needs at least two members, otherwise the bridge renders as an ordinary row. This takes `usdc-circle` from 50 rows to 3.
  - Component bars are tinted only when the input is the problem: neutral below the warn threshold, amber under 65, rose under 40. Those boundaries are the published grade-band floors for B and D, so a tinted bar always reads as "C or worse" and a strong asset's breakdown stays monochrome.
  - `Why not higher` renders the two causal buckets from `scoreTrace`: `adverseAttribution` (measured and adverse) as a flat list, and `boundedUncertaintyAttribution` (unresolved) grouped by `responsibility`. Pharos's own gaps — `producer-failed`, `integration-missing` — are named as ours rather than folded into a neutral "not measured".
  - Attribution `path` values are machine keys and are never rendered; producer messages quoting four or more decimal places round to three for display.
- The card footer carries neither an Evidence block nor a Dependencies block. Evidence collapsed to a chip beside the score trace, because no card in the corpus publishes evidence reason lines and each pillar row already states its own evidence level. Dependencies was removed outright: `ContagionSnapshot` ("Dependency Context") owns that surface with the full dependency graph, and the card's version rendered an empty-state line on 207 of 336 cards.
- `AccessPosturePanel` renders the four scored access enums in the summary rail at `xl+` and inside the card below `xl` (`xl:hidden`), the same split `#price` uses. `buildSafetyScoreV9AccessRows` exposes the rows without building the whole card presentation.
- `src/lib/safety-score-v9-labels.ts` is the single shared machine-key to display-copy map for public V9 surfaces. Cap kinds, failure domains, and attribution paths draw on overlapping producer keys, so new modules extend this map rather than adding their own.
- `src/components/radar-chart-v9.tsx` renders Backing, Exit, and Economic Control comparisons.
- `src/components/safety-score-v9-status-notice.tsx` renders held publication state on every other surface. Reason codes and assessment detail are evaluator identifiers and are never rendered raw; both surfaces route hold reasons through `describeDataCoverageHoldCauses`.
- `src/hooks/api-hooks.ts` exposes `useReportCardsV9` and `useSafetyScoreHistory`.

The retired V8 report-card components, V8 portfolio synthesis, and contagion stress simulator have been removed. A future stress feature must define native V9 semantics rather than recomputing retired V8 dimensions.
