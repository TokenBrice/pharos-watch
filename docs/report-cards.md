# Safety Scores

> **Agent navigation** — Start with [Methodology Identity](#methodology-identity), [V10 Model](#v10-model), [API](#api) and [Consumers](#consumers). Maintainer detail is routed through `docs/mint-authority-scoring.md#mint-authority-entry` and the [technical appendix](https://github.com/TokenBrice/pharos-watch/blob/main/docs/process/report-cards-appendix.md); use their selected sections, not whole-file reads.

Safety Score V10 is the sole active stablecoin safety model. It publishes evidence-backed grades from A+ through F; NR is a causal withholding outcome, while Pipeline gap has no score or grade.

The public grade-distribution total is labeled **assets**, since its A/B/C/D/F/NR segments include not-rated assets. Rated-only supply and coverage figures keep their narrower denominator, including the hero's supply-weighted grade row and its A/B supply headline.


## Methodology Identity

- Active model: <!-- GENERATED-START: report-cards-active-model -->`v10`<!-- GENERATED-END: report-cards-active-model -->
- **Current methodology version:** <!-- GENERATED-START: methodology-version-safety-score -->`v10.23`<!-- GENERATED-END: methodology-version-safety-score -->
- Public breakdown/publication schema v7, API wrapper v8 and score trace v4; retained older publications require explicit historical dispatch or refusal, never fabricated causes or route identity
- Policy: `shared/data/safety-score-v9/methodology-policy-candidate-v1.json`, parsed and digested by `shared/lib/safety-score-v9/policy.ts`
- **Evaluation build:** `SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST` in `shared/data/safety-score-v9/evaluation-build-manifest-v1.ts` binds the offline candidate runtime import graph: captured fixed-input normalization, extension construction, fact-set compilation, evaluation and projection, including executable admission schemas, reviewed score-input data and full-catalog bytes/decoder. Edits anywhere in that evaluation-time closure rotate replay/publication identity. Capture-only network observers/producers and build-time generators are outside it; exact-input/fact digests bind their admitted output. Capture binding and runtime identity consumers are unchanged.
- Implementation: `shared/lib/safety-score-v9/`
- Structured changelog: `shared/data/methodology-changelogs/safety-score/`
- Public methodology: `/methodology/#safety-scores-methodology`
- Scoring history: `/methodology/scoring-changelog/`

Historical V8 methodology is documented in the scoring changelog. It is not a production API, fallback, selector input, or frontend model.

Release changes, activation status, replay evidence and outstanding acceptance obligations live in the [structured scoring history](https://pharos.watch/methodology/scoring-changelog/), including [v10.15](https://pharos.watch/methodology/scoring-changelog/archive/v10/#scoring-v10-15), [v10.18](https://pharos.watch/methodology/scoring-changelog/archive/v10/#scoring-v10-18) and [v10.21](https://pharos.watch/methodology/scoring-changelog/#scoring-v10-21). A version definition or fixed-input replay does not establish fresh producer closure or production health.

V10.01 introduces cause-aware scoring after the V10 major release. Internal `safety-score-v9` implementation names and API route paths remain unchanged; public body schemas distinguish technical availability from NR. Digest snapshots label their grade distribution from the captured methodology major version, preserving V9 editions rather than relabelling history.

## V10 Model

V10 evaluates three pillars:

| Pillar | Aggregation weight | Scope |
| --- | ---: | --- |
| Backing | <!-- GENERATED-START: report-cards-backing-pillar-weight -->40%<!-- GENERATED-END: report-cards-backing-pillar-weight --> | Reserve quality, mechanism solvency, custody, assurance, and loss-bearing structure |
| Exit | <!-- GENERATED-START: report-cards-exit-pillar-weight -->35%<!-- GENERATED-END: report-cards-exit-pillar-weight --> | Same-notional executable capacity, cost, settlement, confidence, independent backup credit, and stress horizon |
| Economic Control | <!-- GENERATED-START: report-cards-control-pillar-weight -->25%<!-- GENERATED-END: report-cards-control-pillar-weight --> | Mint, upgrade, oracle, bridge, and other binding control paths |

The Economic Control mint component evaluates native issuance posture, process certification and seasoning, not a second standalone Mint Authority score. It distinguishes affirmative governance and veto constraints from unrestricted operator discretion, and preserves measured adverse reach when evidence is incomplete. The [public methodology](https://pharos.watch/methodology/#safety-scores-methodology) explains the active model; exact ladders and D33 availability rules are maintained in `docs/mint-authority-scoring.md`.

Custody, bridge, incident, oracle and reserve-review credit is scope-bound: identity, current primary evidence and the relevant denominator must be established independently. One favorable review cannot close sibling controls or grant unmeasured capacity. Detailed maintainer admission gates live in `docs/process/report-cards-appendix.md#campaign-admission-rules`.

Mechanism-review overlays and independently reviewed components accept a strict evidence date or exact UTC timestamp. Date-only claims retain next-UTC-midnight admission; timestamped claims enter at their evidence instant, never before it. The unchanged 365-day expiry runs from the original review start (UTC midnight for a date, the exact instant for a timestamp). This admission-timing capability is score-neutral for existing date-only entries; it neither renews evidence nor changes quality grades, scoring formulas or weights. Authoring rules live in [Mechanism-overlay evidence standard](process/mechanism-overlay-evidence-standard.md#process-requirements).

Weights bound headroom, not an unrestricted average. With included pillars S, renormalize their original weights, let m be their minimum and M their weighted mean, then Q = m + 20 × tanh((M − m)/20). Three included pillars keep 40/35/25; exactly one A/B-only pillar permits a two-pillar rating. Q ≤ M ≤ max(S) holds before independently evidenced additions. Peg behavior, positively evidenced structural/method/parent/history limits and wrapper-local risk still apply; missing-data and generic evidence ceilings do not.

Published redemption schedules may resolve a conservative cost bound through a dated, fee-scoped `v9RouteCostTerms.publishedFeeSchedule` review: use the binding top tier/cap, or evaluate complete flat-plus-percentage terms at the request with admitted fresh captured FX. Partial tariffs, private-price overrides, unknown additional deductions and sampled quotes remain unresolved. Bounds above the request budget yield zero within-budget capacity without proving exhaustion. Business-day guarantees use reviewed jurisdiction calendars over the full 365-day submission horizon, never days × 86,400; completed KYC/delivery prerequisites remain access conditions. An explicitly published receipt-day rule needs no invented intraday cutoff, while payout gates, targets and unresolved notices remain unbounded.

Wrapper-local `measuredUnwind` accepts a fresh, admitted, exact-request transaction-simulation receipt proving at least 95% completion as a sufficient lower bound, even when the remaining route inventory is incomplete. A smaller successful receipt, an idle balance, an ERC-4626 preview or a reverted request never proves exhaustion or an adverse unwind assessment. Below that threshold, only exact-complete measurements across the entire admitted route inventory can establish the adverse completion bands.

For a reviewed synchronous ERC-4626 rail with an absent or stale share-price observation, the execution producer may instead value input shares from same-block `convertToAssets(10 ** shareDecimals)` and a separately fresh observed underlying USD price. The derived gross-NAV reference rounds down at the six-decimal USD boundary, binds the block hash and complete underlying-price provenance into the input generation, and inherits the older of their clocks. It establishes current native-share accounting value, not a market quote, financial assurance, fiat-redemption guarantee or exhaustion; stale/missing underlying prices and failed identity/NAV reads remain unavailable.

Source-reviewed ERC-4626-compatible custodian rails may burn a separately identified share token. Their exact canonical-request witness changes only the counterfactual holder balance, executes ordinary token approval, and verifies actual output transfer, holder-share decrease and total-supply burn at one pinned block. Reviewed gross-preview or gross-return conventions change only receipt decoding; costs always use actual net output. Ethereum custodian witnesses also require same-block transaction-gas estimation and fee-history pricing plus a fresh, identity-bound native-USD feed; those observations expire and never become published fee bounds. An admitted certificate may replace the exact reviewed primary rail, while failed execution cannot overwrite retained terms or establish exhaustion. External-share rails cannot synthesize a stale input market price from custodian conversion.

Exit output valuation preserves the existing admitted current-deviation and captured-NAV paths, including their retained route/source clocks and 365-day review budget; old fixed inputs need not contain raw-price provenance or `exitOutputPriceById`. The optional exact current USD-price census is an additional path for otherwise unvalued outputs, not a veto or replacement for independently admitted existing values. That new path retains the original quote clock and source, uses the 1,800-second current-price budget, and requires guarded protocol NAV for NAV outputs. Non-USD outputs compare against their independently current FX or commodity reference, not $1; captured GOLD/SILVER observations are not fiat FX aliases. Quiet peg history and explicitly unavailable or nominal-only prices never substitute for a missing observation; a rejected/missing current-census member supplies no new value. Single-output live valuations use the same exact identity and freshness gates as complete baskets. Every basket leg must have an admitted valuation or an independently reviewed exact conversion; a priced subset or USD-symbol accounting fallback cannot value the whole output. Prices resolve valuation only, not execution, capacity, fees, settlement or exhaustion. This adds no fetches, schedules or connection pressure.

Captured peg rows that explicitly report an unavailable current price, and nominal-only references rejected by the observed-price reader, carry exact scoped A producer/unsupported-reader proof rather than U. Stale supply and peg observations similarly bind A to their retained observation clock, source generation and existing freshness budget. This does not refresh carried data, admit nominal parity as a market observation, clear adverse history, or classify a wholly absent row as a failed attempt.

Missing evidence is classified by scoped proof: A pipeline unavailable; B current required public data not curated; C researched non-disclosure; U unresolved; D measured adverse. A/B factors stay visible with null scored values and zero effective weight, never synthetic favorable facts. Mixed components keep known/C/U/D constraints. `partialEvidence` flags contributing subcomponent exclusions as well as whole pillars; route-exclusive A/B gaps on unscored optional Exit alternatives remain diagnostic only, without hiding other exclusions. Two or three A/B-only pillars publish `ratingStatus: "pipeline-gap"`, null score/grade and diagnostic breakdowns, not NR or a one-pillar Safety Score. Exactly one excluded pillar publishes a two-pillar partial rating only if the other gates pass.

The public U label is “Unresolved”: researched inputs can still lack a conclusive admissible source. This wording does not change machine keys or scoring.

A source-pinned, admitted `routeSuspension` is a measured adverse **exact-channel** state (D), not an unresearched executable-route factor census. The withdrawn rail stays diagnostic and ineligible: it contributes no capacity, score or backup credit, and its deliberately masked access/output/cost/settlement fields do not create U/C obligations. Its adverse witness retains the review and source binding; the structural fact status remains non-known because it is not an execution observation. This does not prove zero total exit, exhaustion, asset-wide danger, or an executable recovery offer. Other redemption, physical-delivery, recovery and DEX rails remain independently evaluated; future or identity-mismatched suspension reviews are not admitted.

When a suspended channel has no independently admitted alternative that closes limited same-notional Exit evidence, a separate scoped U whole-Exit route-census witness remains attached to the limiting runtime/same-notional reasons. This includes measured alternatives that are immaterial at the canonical request under the existing Exit coverage/absolute-capacity breakpoints. Their measured routes and capacity remain visible; the witness does not assert exhaustion. Removing the closed channel's synthetic factor obligations cannot clear genuine Exit uncertainty or bypass NR. Material independent executable evidence can clear that census witness without reopening the suspended channel or inferring whole-asset danger.

Wrapper-local reviews in `wrapper-allocation-reviews-v1.json.localReviews` are admitted independently of wrapper form and aggregate mint/oracle completeness. Pinned, exhaustive deployment reviews can establish Vault V2 share accounting or adverse root-code mutability; published instrument terms can establish fixed-face liability accounting, emergency impairment capabilities, and deployment-scoped withdrawal restrictions. Published fixed-face accounting retains moderate local risk rather than claiming a verified NAV oracle or backing; published emergency powers retain at least high risk. Withdrawal reviews preserve alternative routes, output assets, fees, eligibility cooldowns, and prerequisites; missing settlement bounds or fees retain high risk, and a cooldown never becomes an end-to-end settlement bound. These reviews cannot create executable capacity, measured unwind, custody completeness, borrower-oracle relief, or an aggregate controller census. Future, expired, stale, duplicate, unsourced, wrong-asset, and mismatched deployment reviews fail closed.

### Morpho lender collateral-book Backing (v10.19)

Morpho books weight frozen accepted Backing or class quality by allocation and LLTV². Idle keeps parent quality; the blend cannot exceed it. Same-parent multi-slice books keep lower generic constraints; unavailable books keep prior scoring. Sub-1%-NAV oracle branches stay disclosed, weighted; unmatched claims keep the prior aggregate.

For collateral quality `q` and LLTV fraction `l`, transmitted lender quality is `100 − l² × (100 − q)`. Allocation-weighted book quality scales the deployed share of parent Backing, while idle retains parent quality; the final blend is capped at the parent. The [v10.19 changelog](https://pharos.watch/methodology/scoring-changelog/archive/v10/#scoring-v10-19) retains calibration evidence and production-acceptance boundaries.

### Report schema v8

The outer API report is schema v8 (`model: "v9"`), carrying public publication schema v7 with typed exact exit identity. Cause-bearing exclusions, partial weights and pipeline-gap/null-grade remain distinct from NR. `ratingStatus`, full `partialEvidence`, separate `confidenceDimensions` and `completeness.pipelineGapCount/pipelineGapIds` reconcile to the cards. Existing supply/shared-book fields retain their meanings.

Lossless witness interning preserves evidence, while obligation counts distinguish source questions from repeated witnesses. Supply/dependency projections and common-mode effects retain exact identities and clocks; implementation details live in `docs/process/report-cards-appendix.md#report-schema-v8`.

Accepted publication's private read models serve preparation and pre-compile comparison without decoding the prior full publication. Writers must seed and verify both rows before strict readers deploy; no full-publication fallback exists. Missing/invalid baseline projections block compilation with a named failed attempt; lender-source failures retain unavailable/class fallback. Recovery reverts only the strict-reader change on current head, reseeds through one normal accepted cycle, then reapplies it (`docs/process/report-cards-appendix.md#accepted-publication-read-models`). Public API and score-index schema 2 are unchanged.

## Publication journal and movement attribution

`worker/src/lib/safety-score-v9/publication-journal.ts` retains compact attribution evidence in two D1 tables:

- `safety_score_publication_journal`: an accepted publication generation × coin row at first sight, when the compact digest changes, or when methodology version, policy digest or evaluation-build identity changes. The compact card includes nullable score/grade, rating status and causes, partial evidence, pillar scores/inclusion/causes, peg multiplier, binding cap, and selected primary Exit route identity, executable capacity and confidence evidence. Route generation keys and observation clocks stay in lineage, outside the compact change digest; a quote refresh or generation re-key alone is not a score movement.
- `safety_score_publication_attempts`: a publication-level row for each accepted or held attempt, with candidate generation, attempt/publication clocks, the same three-part identity, sorted hold-reason codes and input lineage. Accepted attempts retain changed/unchanged card counts; held attempts retain null counts and never journal candidate cards. Lineage names the base/source generations, DEX/redemption/transfer-materiality generations, registry fingerprint and input freshness; per-coin rows additionally retain supply and primary-route key/clock.

The heavy Worker's `publication-runner.ts` calls the journal **after** canonical persistence: accepted publication/health/attempt state first (then the non-fatal alert-envelope projection), or held health/attempt state first. The journal uses the already-typed publication and fixed input rather than decoding a full cache publication. Its failure is isolated: `compute-safety-score-v9` cron metadata exposes `journal.status` (`written`, `failed` or `skipped`), `reason` and `rows`; a journal error reports `journal-write-failed` and never fails or rolls back publication. A failed publication skips journaling with `publication-failed`.

Both tables retain 120 days through daily `prune-cron-history`. They are not a full replay archive or the permanent `safety_score_history_v2` product history. No historical journal rows before deployment exist: migration 0262 has no backfill, and retention or failed writes can leave observation gaps.

Migration `0262_safety_score_publication_journal.sql` is additive and backward-compatible; apply it **before Worker activation** (`worker/migrations/MANIFEST.md`). Preserve the pre-window Time Travel bookmark, migration ledger and public/heavy versions. A code rollback leaves tables/evidence intact and stops journaling; schema removal needs separately coordinated cleanup. Observe the first heavy accepted/held attempts and bounded daily prune before claiming operational acceptance.

The movement ledger (`worker/scripts/safety-score-movement-ledger.ts`) enables same-identity comparison and evidence-based `release`, `data:<pillar>` / peg / cap / unattributed, and `operational` classification, retaining secondary deltas and adjacent holds. `release` means non-comparable identity, not proof of release-only causation. Same-identity pipeline-gap/partial-evidence changes are operational; persistent partial evidence does not override an included-pillar, peg or cap movement. Unexplained movement adjacent to a hold is operational. Retention/diagnostic tooling changes neither the formula nor methodology and asserts no measured score-stability improvement.

## Accepted capture archive and historical replay

`worker/src/lib/safety-score-v9/capture-archive.ts` **attempts to archive every accepted generation** after canonical persistence, beside the compact journal; this is best effort, not complete coverage. The heavy-only `SAFETY_CAPTURE_ARCHIVE` binding writes to the existing `pharos-measurements` R2 bucket at `captures/safety-score-v9-accepted/<YYYY-MM-DD UTC of publication>/<generation_id>.json`. Schema 1 retains publication/methodology/policy/build identity and the exact committed cache `key`, `value` and `updatedAt` for accepted replay base, delta, and `report-cards:v9` cards. Publication storage returns the already-encoded strings directly; the archive does not re-read overwriteable cache keys, re-encode input transports, or decode a full card set. All three values are already gzip-base64 codec envelopes, so the outer object stays plain `application/json` rather than being gzipped again.

R2 PUT runs first with object SHA-256 and identity custom metadata; only a successful upload is followed by the narrow `safety_score_capture_archive` D1 index row (generation, publication clock, methodology/policy/build, object key/SHA-256/UTF-8 bytes and archive clock). Migration `0263_safety_score_capture_archive.sql` contains **no blobs or backfill** and applies before Worker activation. R2 errors and index errors remain non-fatal: `compute-safety-score-v9` metadata includes `captureArchive.status` (`written`, `failed`, `skipped`), optional `reason`, `bytes`, `outcome` and confirmed `uploaded` state. Held/failed attempts write no object/index; missing binding or missing accepted replay transports skip explicitly. Each value uses the codec's 1,900,000-byte stored budget; the complete JSON object is capped at 8,000,000 UTF-8 bytes, otherwise `capture-too-large`.

The awaited archive phase is capped at 15 seconds and the earlier publication/scheduled execution deadline minus a 2-second finalization margin. Caller cancellation settles promptly as `capture-aborted`; upload timeout is `capture-upload-timeout`, ordinary upload failure is `capture-upload-failed`, and an index failure is `capture-index-write-failed`. R2 PUT itself cannot be cancelled. A still-pending operation is handed to scheduled `ctx.waitUntil` with an independent 30-second continuation budget: late upload success indexes the same narrow row with `INSERT OR IGNORE` and logs `safety_score_capture_archive_late_indexed`; late failure/deadline expiry logs `safety_score_capture_archive_late_failed`. Run metadata retains the original timeout/abort verdict and `outcome: pending-continuation`, not a retroactive success. Without an ExecutionContext, it records `outcome-unknown` and does not promise late indexing or operation lifetime; continuation expiry also leaves outcome unknown.

Failed/skipped archives, terminal timeouts/aborts and uploaded-but-unindexed orphan objects can create **permanent historical replay gaps** after live cache keys advance; no durable repair/retry handoff is promised. Run metadata exposes these outcomes. `export-safety-score-capture-archive.ts list --gaps` additionally reports generations with **no archive index row**, unioned from two read-only sources and deduplicated by generation: the retained accepted-attempt journal (120-day evidence, including unchanged publications) and productive `compute-safety-score-v9` runs (`cron_runs.productive = 1`) whose metadata names a `publicationGenerationId`, bounded to the retained `cron_runs` window. Each gap names its `evidence_sources`; `journal` carries the attempt's publication clock, methodology/policy/build identity and attempt, while `recent_cron_runs` carries the run id, start clock and status. A generation observed only in a cron run therefore shows `journal: null` — the CLI never invents a publication clock or identity digests from run metadata, and recent-cron evidence is selected by run start, not publication time. Cron generation ids must match the producer's `report-cards:v9:v1:<sha256>` format; absent or malformed ids are excluded and counted. `recentCronEvidence` states the effective window, the imported retention bound and its `rows` accounting (productive, valid generation, already indexed, missing, malformed, distinct gap generations); when the requested window starts before the retention floor the coverage is `incomplete-window` and the absent older cron evidence is never reported as complete. The supplement reads only; it never repairs, retries, uploads or mutates R2. It reveals missing index coverage, not every missing object or a repair path. A late successfully indexed object may close a gap, but an orphan remains undiscoverable through index-driven export until lifecycle expiry.

The 180-day `captures/` R2 lifecycle expires uploaded objects; daily `prune-cron-history` separately removes index rows older than 180 days and never issues R2 deletes. Verify the heavy binding's bucket lifecycle before release: migration/config checks cannot establish external account state. Lifecycle deletion is asynchronous and based on upload age; late uploads and delayed index pruning can exceed the nominal publication window. D1 retains only the narrow index, not object blobs.

Archive tooling (`worker/scripts/export-safety-score-capture-archive.ts`) lists the index, resolves adjacent identity boundaries and exports a generation from R2 or a local source directory, verifying object digest, bytes and identities. Its cache export feeds `capture-fixed-input --accepted-cache-export`; `--cards-output` also writes codec-validated decoded cards. Replay under the recorded build checks equivalence; comparing new-build replay of those same frozen inputs with archived cards isolates release from data changes. Project both sides to the same candidate-only shape, not a replay wrapper versus a public response. Maintainer commands live in `docs/process/safety-score-equivalence-harness.md#historical-release-and-data-separation`. Retention, failed writes and pre-deployment generations remain explicit gaps.

## API

`GET /api/report-cards/v9` is the full live Safety Score API. `GET /api/dependency-graph/v1` exposes a free, no-key graph projection of the same accepted publication, not another scoring authority.

The handler coalesces generation-bound reads, verifying integrity and live health before `200`. Missing/invalid evidence returns reason-bearing `503 no-store`; valid health identity/time mismatches serve held accepted bytes. No rescoring or V8 fallback; retired unversioned/preview routes return `404`.

A current response emits `X-Safety-Score-Status: current`. A held response serves the last accepted ratings, emits `X-Safety-Score-Status: held`, uses the accepted timestamp for freshness, and forces `Cache-Control: no-store`.

[Materialization admission and rollout](https://github.com/TokenBrice/pharos-watch/blob/main/docs/process/worker-infrastructure-appendix.md#v9-public-response-materialization) owns wire resolution, live-health re-admission, atomic storage, repair, retirement and qualification.

Site-only [compact list/detail representations](https://github.com/TokenBrice/pharos-watch/blob/main/docs/process/report-cards-appendix.md#compact-website-representations) preserve the full report and free-grades contracts.

Endpoint freshness uses 2x `compute-safety-score-v9` (3600 s), tolerating one missed 30-minute publication, matching consumer fail-close. `worker/src/lib/safety-score-v9/consumer-freshness.ts` rejects non-finite or future `updatedAt` (and non-finite `now`); no clock-skew allowance or alternate consumer budget is introduced.

The response includes:

- complete V9 identity and source digests
- methodology and policy identity
- active-set completeness
- current or held publication health
- native three-pillar cards, nullable excluded-pillar diagnostics and status-aware breakdowns
- per-card `backingFromLiveReserves` provenance for score-grade reserve coverage
- the canonical serial/basket dependency graph
- accepted `updatedAt`

See [Report schema v8](#report-schema-v8) for cause-aware fields and typed route identity. `/api/report-cards/v9` wraps public publication 7 as body schema 8; old public v6 is rejected rather than inferred current. Completeness reconciles `expectedCount = ratedCount + notRatedCount + pipelineGapCount`, with disjoint sorted NR/pipeline IDs. Index 2 and free-grades 1 preserve compact status/partial metadata; graph/scenario schema 2 preserves technical parent/model nulls separately from NR.


Pillar `freshness` is `current`, `stale`, or `unknown`. Only Exit is wired: age the DEX liquidity input at route observation against the inclusive 4-hour `DEX_LIQUIDITY_EVIDENCE_MAX_AGE_SEC` bound (compiler `routeFreshness.dexMaxAgeSec`); older evidence is `stale`, absent DEX rows `unknown`. Backing/Economic Control remain `unknown` pending lane-age projection. Card `evidence.freshness` is `stale` if any wired pillar is stale, otherwise `unknown`. This presentation metadata never affects scores, caps or publication identity digests.

See the [public API reference](https://pharos.watch/api/) for the wire contract.

## Consumers

All active safety consumers resolve the canonical V9 publication:

- Safety Scores, homepage, stablecoin detail, comparison, portfolio, and dependency map
- Yield Intelligence safety hydration
- daily digest and mint/burn flight-to-quality classification
- Telegram grade-change alerts
- OG cards, public datasets, and coverage/status surfaces
- append-only safety-grade history

The stability-index OG consumer renders an explicit unavailable state when no PSI sample exists; absence is never presented as score `0` or the `MELTDOWN` band.

The score-input coverage module labels `completeness.expectedCount` as assets assessed, covering rated, not-rated and pipeline-gap cards. Its detail reconciles those statuses separately; only `ratedCount` can describe a scored/rated population, and a publication hold continues to replace the headline.

Consumers that require current ratings reject held publications. Display surfaces may show the held accepted snapshot with an explicit notice, and a producer that stamps the accepted identity on its own payload (yield publication) may consume the held accepted ratings inside the same stale-coherent window the yield read path applies. No active consumer uses the V8 compact score cache or computes V8 cards on request.

The downstream canonical score-map helper keeps unavailable source denominators/coverage ratios null, with an empty returned score map, upstream reason and null publication identity/time. Yield readers preserve that unavailable state, never `0%`/`100%`; measured zero and held accepted coverage remain distinct from missing evidence. [Yield Public Wire Contract](./yield-intelligence.md#public-wire-contract) owns presentation.

Selector creation recomputes against the live V9 publication (`functions/lib/selector-canonical-snapshot.ts`); a `503` now indicates canonical-source or schema failure, not a policy hold. Existing signed selector snapshots remain readable through their historical contract.

## History

The compiler admits each asset's local extension and validates each asset's facts independently. An attributable asset-local build, admission, schema, evaluation, or public-card failure publishes that asset as a technical `pipeline-gap` with null score/grade, not issuer NR. Unaffected assets continue only when at least 90% of active assets remain unaffected, counting quarantined assets and their affected dependents, and all other publication gates pass. Unattributable dependency-graph, aggregate, evaluator, identity, and other global failures still hold the whole publication.

The asset-local allowance does not override the explicit [measured DEX history hold](process/report-cards-appendix.md#canonical-publication): one expired, previously mature contributing route can still hold the cohort under ADR-35. Count/rateability floors passing is not permission to quarantine that stale score-bearing input. Recovery requires fresh admitted producer evidence; a new liquidity timestamp or discovery-priority hint cannot renew its embedded history.

Frozen pre-9.07 captures retain read-only format compatibility, not a legacy publisher or live-input fallback. Historical reproduction requires the recorded registry, policy and evaluation build; current-tree replay is a separately identified comparison (`docs/process/report-cards-appendix.md#historical-capture-compatibility`).

`snapshot-safety-grade-history` appends identified V9 organic transitions and suppresses writes while publication is held. During a partial publication it also suppresses transitions for quarantined assets and their affected dependents, including the subsequent recovery, so technical pipeline gaps are not recorded as organic rating changes. Each V2 row records model, methodology, policy, evaluation-build, base-input, publication generation, and transition kind.

The writer compares *publication* identities. The capture's `v9-input` identity never reaches it, so a capture-producer change cannot manufacture a boundary or an organic transition by itself. The evaluation build is part of publication-identity comparability, so the first publication after an evaluation-build rotation writes one `methodology-boundary-baseline` per asset rather than organic grade changes.

`GET /api/safety-score-history` remains the public per-asset timeline. Historical V8 and activation-boundary rows remain readable as archive data; they are never live publication inputs.

The stablecoin detail Grade History module combines that legacy archive with `GET /api/safety-score-history-v2`. It collapses consecutive same-grade baselines, while retaining a boundary row when the published grade changes and labelling it as a methodology baseline rather than implying an organic upgrade or downgrade. This keeps the current V9 grade and the date it first appeared visible without comparing non-comparable publication identities.

