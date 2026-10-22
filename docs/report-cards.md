# Safety Scores

> **Agent navigation** — Start with [Methodology Identity](#methodology-identity), [V10 Model](#v10-model), [API](#api) and [Consumers](#consumers). Maintainer detail is routed through `docs/mint-authority-scoring.md#mint-authority-entry` and the [technical appendix](https://github.com/TokenBrice/pharos-watch/blob/main/docs/process/report-cards-appendix.md); use their selected sections, not whole-file reads.

Safety Score V10 is the sole active stablecoin safety model. It publishes evidence-backed grades from A+ through F. NR denotes genuine rating unavailability, never a low-score or missing-subfactor penalty; technical Pipeline gaps have no score or grade.

The public grade-distribution total is labeled **assets**, since its A/B/C/D/F/NR segments include not-rated assets. Rated-only supply and coverage figures keep their narrower denominator, including the hero's supply-weighted grade row and its A/B supply headline.


## Methodology Identity

- Active model: <!-- GENERATED-START: report-cards-active-model -->`v10`<!-- GENERATED-END: report-cards-active-model -->
- **Current methodology version:** <!-- GENERATED-START: methodology-version-safety-score -->`v10.29`<!-- GENERATED-END: methodology-version-safety-score -->
- Public breakdown/publication schema v7, API wrapper v8 and score trace v4; retained older publications require explicit historical dispatch or refusal, never fabricated causes or route identity
- Policy: `shared/data/safety-score-v9/methodology-policy-candidate-v1.json`, parsed and digested by `shared/lib/safety-score-v9/policy.ts`
- **Evaluation build:** `SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST` in `shared/data/safety-score-v9/evaluation-build-manifest-v1.ts` binds the offline candidate runtime import graph: captured fixed-input normalization, extension construction, fact-set compilation, evaluation and projection, including executable admission schemas, reviewed score-input data and full-catalog bytes/decoder. Edits anywhere in that evaluation-time closure rotate replay/publication identity. Capture-only network observers/producers and build-time generators are outside it; exact-input/fact digests bind their admitted output. Capture binding and runtime identity consumers are unchanged.
- Implementation: `shared/lib/safety-score-v9/`
- Structured changelog: `shared/data/methodology-changelogs/safety-score/`
- Public methodology: `/methodology/#safety-scores-methodology`
- Scoring history: `/methodology/scoring-changelog/`

Historical V8 methodology is documented in the scoring changelog. It is not a production API, fallback, selector input, or frontend model.

Release changes, activation status, replay evidence and outstanding acceptance obligations live in the [structured scoring history](https://pharos.watch/methodology/scoring-changelog/), including [v10.15](https://pharos.watch/methodology/scoring-changelog/archive/v10/#scoring-v10-15), [v10.18](https://pharos.watch/methodology/scoring-changelog/archive/v10/#scoring-v10-18) and [v10.21](https://pharos.watch/methodology/scoring-changelog/#scoring-v10-21). v10.26 grade hysteresis (`gradeHold`) and bounded carry-forward are specified in the [appendix](process/report-cards-appendix.md#v1026-bounded-carry-forward-and-grade-hysteresis), v10.27 chain-supply carry-forward [there too](process/report-cards-appendix.md#v1027-chain-supply-carry-forward). A version definition or fixed-input replay does not establish fresh producer closure or production health.

The local, unreleased v10.29 candidate is recorded in [structured history](https://pharos.watch/methodology/scoring-changelog/#scoring-v10-29), stacked on unshipped v10.28. It simplifies authority, Exit, caps and wrapper limits and adds a source-bound realized-holder-loss rule. `effectiveAt` remains 1792627200 until the owner chooses a ship date; this source-tree version establishes neither activation nor replay or first-publication acceptance.

V10.01 introduces cause-aware scoring after the V10 major release. Internal `safety-score-v9` implementation names and API route paths remain unchanged; public body schemas distinguish technical availability from NR. Digest snapshots label their grade distribution from the captured methodology major version, preserving V9 editions rather than relabelling history.

## V10 Model

V10 evaluates three pillars:

| Pillar | Aggregation weight | Scope |
| --- | ---: | --- |
| Backing | <!-- GENERATED-START: report-cards-backing-pillar-weight -->40%<!-- GENERATED-END: report-cards-backing-pillar-weight --> | Reserve quality, mechanism solvency, custody, assurance, and loss-bearing structure |
| Exit | <!-- GENERATED-START: report-cards-exit-pillar-weight -->35%<!-- GENERATED-END: report-cards-exit-pillar-weight --> | Same-notional executable capacity, cost, settlement, confidence, independent backup credit, and stress horizon |
| Economic Control | <!-- GENERATED-START: report-cards-control-pillar-weight -->25%<!-- GENERATED-END: report-cards-control-pillar-weight --> | Mint, upgrade, oracle, bridge, and other binding control paths |

Control takes the weakest effective economic path: mint/upgrade, fee/accountant, allocator/curator, custody-transfer or parameter. Qualities: single signer 50; opaque 60; quorum 65; quorum+delay 70; public governance/minority veto+delay 75; reviewed immutable/no-power 90. Add enforceable bound 10, reconciliation ≤15, supervision 15 or attestation 10 (assurance ≤30); clamp at 90. Compromise/exploitation: 25, no credits. [Authority proof](mint-authority-scoring.md#mint-authority-entry) requires unavoidable delays and closure of every bypass.

Control consumes normalized facts/admitted reviews, preserving causes, traces, canonical order, inventory and the binding minimum ([contract](process/report-cards-appendix.md#scoped-evidence-and-exit-evaluation)).

Custody/bridge/incident/oracle/reserve credit needs exact identity, current evidence and its denominator. MPC/HSM requires its own complete/current profile; custody-only questions preserve technical credit/scoped U, not quorum/process proof ([admission](process/report-cards-appendix.md#campaign-admission-rules)).

Issuer matching uses complete normalized phrases and exact reviewed aliases (MakerDAO/Sky; StraitsX SGD/USD's control group, not merged issuers/reserves). Leading words never join; crossed/unresolved groups retain constraints ([contract](process/report-cards-appendix.md#scoped-evidence-and-exit-evaluation)).

Fatal warnings bar retained live-reserve Backing even under degraded allowlists; legacy decoding grants no scoring authority. Other snapshots retain [admission rules](live-reserves.md#snapshot-admission-gates), which also govern live/accepted detail.

Reviewed issuer-named residuals totaling ≤1% of a complete measured book do not alone limit Backing evidence. Keep whole-book weights, C/U pricing and identities; no reserve/assurance/liquidity credit. Unmarked, incomplete or larger residuals retain gates ([standard](process/mechanism-overlay-evidence-standard.md#scoped-reports-and-bounded-observations)).

Date-only mechanism reviews enter next UTC midnight; exact UTC pins enter at that instant. Expiry is 365 days from original review start. Admitted current components govern; old reports remain diagnostic and future/unadmitted components grant no credit. [Authoring gates](process/mechanism-overlay-evidence-standard.md#process-requirements) preserve scoped assurance, validation and reference integrity.

Evaluated upstream constraints survive C/U provenance: same-slice known and unresolved losses combine as `max(K,U)`, not their sum. Supported profile constraints survive unavailable sibling obligations; inherited Backing alone does not establish a wrapper.

`unknownQuality(pillar, cause)` prices missing factors/unavailable pillars on rateable cards: researched non-disclosure C uses Backing/Exit/Control 35/35/50; research/infrastructure U or unclassified uses 50/50/60. Keep measured values, causes/provenance; unknown reconciliation/supervision earns nothing.

Whole-liability attribution (WS04-A08) and independent ordinary bridge clocks (WS04-A09) remain deferred. Current supply denominators, aggregate fallback, bridge applicability, route clocks and mint scope stand; any later clock change must preserve admitted active incidents.

Reviewed XRPL liabilities bind obligations to the exact validated ledger hash and its true close time. Pending proofs remain scoped to their accounting role: an escrow-supported protocol is not automatically eligible for independent liabilities. Missing or rejected reads never establish zero pending supply.

Exit selects the best admissible singleton/independent pair. Same-resource alternatives remain selectable but gain no diversification and share at most their maximum executable capacity; stale/diagnostic rows reserve no resources.

Require ≥2 usable pillars; price an unavailable third by cause-keyed `unknownQuality` (unclassified=U), never renormalizing 40/35/25. For all three priced scores, m=min and M=weighted mean: `Q = m + 20 × tanh((M − m)/20)`. Measurements, reviewed applicable mechanisms/routes with bounded gaps and admitted upstream claims are usable; subject-free defaults are not. Trace priced uncertainty separately. Peg exponent .4, nearest rounding, bands/hysteresis remain.

Questions, low scores/incidents do not cause NR. Below two usable pillars is a pipeline gap. Required-parent technical failure (cycles/failed evaluation included) propagates causal pipeline-gap/null score/grade, never an invented parent score. Other parent unavailability and quarantine/accepted-output holds remain. Uncertainty retains witnesses even above C−; attribution never gates letters ([retired gates](https://pharos.watch/methodology/scoring-changelog/#scoring-v10-29)).

Five cap families remain: active depeg (≥10%→49, ≥25%→39); known implementation age <24 months→84 and 24–<36 months→86; required-parent/wrapper; realized-holder-loss; speculative-credit→59. The last retains high measured-adverse reserve/global-claim and admitted legacy-unscoped signals even when priced in Backing, never deployment/access-only signals. Unknown age is uncapped. All other structural/evidence ceilings are removed; reserve, scoped-loss, oracle/bridge and serial/role risks remain in their owning calculations.

Source-proved realized holder loss selects L=39 for ≥25%, L=49 for ≥1%, otherwise no cap. For ageDays≥0, `eventLimit = min(100, L + (100 − L) × max(0, ageDays − 365) / 365)`; floor the minimum event limit once. This holds through day 365 and ends at day 730. Require original dates, exact scope, holder-claim denominator and primary sources for actual NAV impairment/imposed withdrawal loss, not discounts, slippage, gross protocol or treasury-covered losses. No duplicate whole-score incident charge. Thresholds/periods are calibration choices.

Exit/wrappers require exact identities, original clocks and fresh execution; incomplete measurements prove no exhaustion. [Admission details](process/report-cards-appendix.md#model-admission-details) own fee/calendar bounds, unwind/history/hash/FX gates, execution witnesses, output pricing and unavailable-price causes.

Causes: A pipeline unavailable; B public uncurated; C researched non-disclosure; U unresolved; D adverse. Proven A/B pillars use `"excluded-a-b"`; evidence-free pillars use `"unavailable"` without invented proof. Both keep null diagnostics and `partialEvidence` (cause/gap lists may be empty for unavailable). Rateable cards price missing pillars, not drop weights. Preserve known/C/U/D components; <2 usable pillars yields `"pipeline-gap"`/null score/grade. Unknown pricing creates no evidence; optional unavailable routes veto no alternatives or invent capacity.

Do not charge deployment/bridge authority again when its exact root controller is priced in Control. Identity requires admitted facts, not asset ID. Independent controllers and measured slice failures retain proportional losses; shared roots erase no distinct measured risk.

Shared-chain and bridge deployment losses remain proportional to measured holder-supply exposure, never whole-score caps. Without a separately evaluated exposed quality, the deployment-only policy table uses shared-dependency moderate/high 79/64, material-bridge moderate/high 74/59 and active-control-incident critical 39. A supplied measured quality takes precedence. Unknown shares stay unresolved rather than becoming zero or whole-asset exposure; same-root authority de-duplication still applies.

Public U means “Unresolved”, including researched but inconclusive evidence; machine keys/scoring are unchanged.

Suspension removes only its channel's credit/masked obligations, not alternatives, and proves no global exhaustion/danger. Insufficient alternatives retain scoped U census proof ([admission](process/report-cards-appendix.md#model-admission-details)).

Wrapper limit: `max(0, floor(min(required parents' premium-free inheritable scores) − formDeduction))`; pure 3, native-staked 5, strategy-vault 10. Active allocation receipts are strategy-vaults. Final score is min(independently constrained own score, wrapper limit); unavailable parents remain unavailable. Local risks belong in pillars, not a second fallback/factor-sum/floor. USDT keeps its existing +12 premium, maximum 87 and eligibility, never inherited.

Exit preserves original clocks/exact requests. Known supply uses 5%, clamped/gridded $100k–$25m; stale/missing supply uses $25m without discarding fresh routes. A usable curve/resolved output with missing terms prices only missing subfactors by C/U, route ceiling 70; without a curve, capacity stays unknown. Same-rail certificates supersede modeled duplicates. Executable on-chain evidence can establish open status; closure vetoes it. Access is charged once: permissionless 100, whitelisted 75, institutional/API 55, manual/discretionary 20, unknown by C/U. Medium confidence is .85 for documented terms, .75 for certified/on-chain; limited queue/unknown capacity keeps .75. Continuous coverage/absolute-capacity curves replace binary low-capacity gates/caps; measured zero/low scores have no unknown floor. No research-only model is activated.

### Morpho lender collateral-book Backing (v10.19)

Lender books need supported adapter/schema, complete census and exact identity, not an allowlist. Direct parent-token Backing inheritance requires at least 99% admitted live same-parent claims: idle balances held in the parent token and slices admitted as 1:1 parent-token claims, not merely denominated in that token. A protocol-position or lending deployment does not become a parent claim because its underlying is USDC or another stablecoin. Complete admitted lender books remain a separate measured strategy path using allocation-weighted collateral quality and LLTV transmission; without a usable book, the reserve classification and mechanism/archetype evidence apply, pricing only missing factors at their cause-keyed unknown quality. Keep known reserves when a separate mechanism is unresolved, along with exact-identity and cycle checks. Missing books invent no collateral/capacity; sub-1%-NAV oracle branches stay weighted/disclosed.

Policy owns class qualities; strict `lender-collateral-classes-v1.json` owns exact-token classifications, reviewer/dates/sources. Compilation binds registry/build digests without symbol aliases or renewed clocks ([admission/migration](process/report-cards-appendix.md#exact-nav-partition-and-quality-source)).

For collateral quality `q`/LLTV fraction `l`, lender quality is `100 − l² × (100 − q)`. Allocation-weighted quality scales deployed parent Backing; idle retains it and the blend stays capped at parent quality ([v10.19 calibration/acceptance](https://pharos.watch/methodology/scoring-changelog/archive/v10/#scoring-v10-19)).

### Report schema v8

API schema v8 (`model: "v9"`) wraps publication v7 with exact exit identity. Cause exclusions/partial weights and pipeline-gap/null-grade differ from NR. `ratingStatus`, `partialEvidence`, `confidenceDimensions` and `completeness.pipelineGapCount/pipelineGapIds` reconcile to cards; supply/shared-book semantics remain.

Inherited-parent attribution must match referenced parents; mismatch fails schema validation at `cards`, including `safeParse`, never an escaped exception.

Lossless witness interning preserves evidence; obligation counts distinguish questions from repeated witnesses. Supply/dependency/common-mode projections preserve identities/clocks ([schema details](process/report-cards-appendix.md#report-schema-v8)).

Accepted private read models serve preparation/pre-compile comparison, never full-publication fallback. Seed/verify both rows before strict readers; invalid baselines block compilation, unavailable lender sources use class fallback. Recovery reverts strict readers on current head, reseeds an accepted cycle, then reapplies ([rollout](process/report-cards-appendix.md#accepted-publication-read-models)). Public API and score-index schema 2 stay unchanged.

## Publication journal and movement attribution

The non-fatal post-persistence journal retains compact card movements and accepted/held attempts, not a second scoring authority. [Journal implementation](https://github.com/TokenBrice/pharos-watch/blob/main/docs/process/report-cards-appendix.md#publication-journal-implementation) owns fields, lineage, ordering and failure metadata; quote refreshes/re-keying alone are not score movements.


Both tables retain 120 days through daily `prune-cron-history`. They are not a full replay archive or the permanent `safety_score_history_v2` product history. No historical journal rows before deployment exist: migration 0262 has no backfill, and retention or failed writes can leave observation gaps.

Migration `0262_safety_score_publication_journal.sql` is additive and backward-compatible; apply it **before Worker activation** (`worker/migrations/MANIFEST.md`). Preserve the pre-window Time Travel bookmark, migration ledger and public/heavy versions. A code rollback leaves tables/evidence intact and stops journaling; schema removal needs separately coordinated cleanup. Observe the first heavy accepted/held attempts and bounded daily prune before claiming operational acceptance.

The movement ledger (`worker/scripts/safety-score-movement-ledger.ts`) enables same-identity comparison and evidence-based `release`, `data:<pillar>` / peg / cap / unattributed, and `operational` classification, retaining secondary deltas and adjacent holds. `release` means non-comparable identity, not proof of release-only causation. Same-identity pipeline-gap/partial-evidence changes are operational; persistent partial evidence does not override an included-pillar, peg or cap movement. Unexplained movement adjacent to a hold is operational. Retention/diagnostic tooling changes neither the formula nor methodology and asserts no measured score-stability improvement.

## Accepted capture archive and historical replay

After canonical persistence, the heavy-only archive attempts every accepted generation without guaranteeing coverage; held/failed attempts write none. Apply additive, blob-free/no-backfill migration `0263_safety_score_capture_archive.sql` before activation. [Storage details](https://github.com/TokenBrice/pharos-watch/blob/main/docs/process/report-cards-appendix.md#archive-storage-details) own exact encoded transports, R2-before-index ordering, identity/digest/byte checks, limits and explicit metadata.

Archive waits/continuations are bounded and non-fatal. Failed, skipped, aborted or uploaded-but-unindexed captures may leave permanent replay gaps; no durable repair/retry is promised. The read-only gap CLI reports retained journal/cron evidence of missing index coverage, not every missing object. [Archive continuation and gap details](https://github.com/TokenBrice/pharos-watch/blob/main/docs/process/report-cards-appendix.md#archive-continuation-and-gap-details) own deadlines, outcomes and exact coverage accounting.

The 180-day `captures/` R2 lifecycle expires uploaded objects; daily `prune-cron-history` separately removes index rows older than 180 days and never issues R2 deletes. Verify the heavy binding's bucket lifecycle before release: migration/config checks cannot establish external account state. Lifecycle deletion is asynchronous and based on upload age; late uploads and delayed index pruning can exceed the nominal publication window. D1 retains only the narrow index, not object blobs.

Archive tooling (`worker/scripts/export-safety-score-capture-archive.ts`) lists the index, resolves adjacent identity boundaries and exports a generation from R2 or a local source directory, verifying object digest, bytes and identities. Its cache export feeds `capture-fixed-input --accepted-cache-export`; `--cards-output` also writes codec-validated decoded cards. Replay under the recorded build checks equivalence; comparing new-build replay of those same frozen inputs with archived cards isolates release from data changes. Project both sides to the same candidate-only shape, not a replay wrapper versus a public response. Maintainer commands live in `docs/process/safety-score-equivalence-harness.md#historical-release-and-data-separation`. Retention, failed writes and pre-deployment generations remain explicit gaps.

## API

`GET /api/report-cards/v9` is the full live Safety Score API. `GET /api/dependency-graph/v1` exposes a free, no-key graph projection of the same accepted publication, not another scoring authority.

Coalesce generation-bound reads; verify integrity/live health before `200`. Missing/invalid evidence returns reason-bearing `503 no-store`; valid health identity/time mismatches serve held accepted bytes. Never rescore or fall back to V8; retired unversioned/preview routes return `404`.

`X-Safety-Score-Status` is `current`, or `held` for last accepted ratings/clock served `no-store`. Non-held publications older than 3600s (one missed 30-minute publication) or future at any skew instead emit status `stale`, `X-Data-Freshness: stale`, `X-Data-Freshness-Reason` (`safety-score-publication-age`/`future-timestamp`), `Warning: 110` and `no-store`; body `publicationHealth`/`publicationStatus` remain producer health. Every response includes `X-Safety-Score-Freshness-Budget`/`X-Safety-Score-Generation`. Current shared/browser TTL plus `stale-while-revalidate` cannot exceed remaining budget. This covers `/api/report-cards/v9`, site projections, `/api/safety-grades` and `/api/dependency-graph/v1`.

[Materialization admission and rollout](https://github.com/TokenBrice/pharos-watch/blob/main/docs/process/worker-infrastructure-appendix.md#v9-public-response-materialization) owns wire resolution, live-health re-admission, atomic storage, repair, retirement and qualification.

Site-only [compact list/detail representations](https://github.com/TokenBrice/pharos-watch/blob/main/docs/process/report-cards-appendix.md#compact-website-representations) preserve the full report and free-grades contracts.

Endpoint freshness uses 2x `compute-safety-score-v9` (3600 s), tolerating one missed 30-minute publication, matching consumer fail-close. `worker/src/lib/safety-score-v9/consumer-freshness.ts` rejects non-finite or future `updatedAt` (and non-finite `now`); no clock-skew allowance or alternate consumer budget is introduced.

The response carries V9 identity/source digests, methodology/policy identity, active-set completeness, current/held health, native three-pillar cards with nullable excluded diagnostics and status-aware breakdowns, per-card `backingFromLiveReserves`, the serial/basket dependency graph and accepted `updatedAt`.

`/api/report-cards/v9` wraps publication 7 as body 8; reject public v6 rather than infer it current. `expectedCount = ratedCount + notRatedCount + pipelineGapCount`; NR/pipeline IDs are disjoint and sorted. Index 2/free-grades 1 retain compact status/partial metadata; graph/scenario 2 distinguish technical parent/model nulls from NR. Pillar freshness stays categorical, opt-in operands follow the compact-representation contract, and scores/legacy wire are unchanged. [Report schema v8](#report-schema-v8) owns cause-bearing fields and typed route identity.

See the [public API reference](https://pharos.watch/api/) for the wire contract.

## Consumers

Canonical V9 consumers: Safety Scores, homepage, stablecoin detail, comparison, portfolio/dependency map; yield hydration; digest and mint/burn flight-to-quality; Telegram alerts; OG, public datasets, coverage/status; append-only grade history.

Every rated card's read-only top-driver `reason` is populated: binding cap first, else weakest-pillar reason, preferring a recognized score-matching binding mint posture for Control; lacking either, state the pillar/score. Nonbinding/differently scored postures cannot supply it. Badges/reason codes may stay empty; scores, grades, evidence, schema and withheld behavior are unchanged. This explains current constraints, not historical grade changes or misconduct.

Stability-index OG shows unavailable without PSI, never `0`/`MELTDOWN`. Coverage labels `expectedCount` assets assessed (rated/NR/pipeline-gap), reconciles statuses separately and reserves scored-population wording for `ratedCount`; a hold replaces the headline.

Current-only consumers reject held ratings. Displays may show held accepted data with notice; yield publication may use it only with accepted identity stamped and within its stale-coherent window. No active V8 cache or request-time V8 scoring remains.

Score-map/yield readers retain null unavailable denominators/ratios, empty score map, upstream reason and null publication identity/time; never missing-as-`0%`/`100%`. Measured zero, held coverage and missing evidence stay distinct ([yield wire](./yield-intelligence.md#public-wire-contract)). Selector creation recomputes live V9 (`functions/lib/selector-canonical-snapshot.ts`); `503` means canonical-source/schema failure, not policy hold. Signed snapshots retain historical readability.

## History

Asset-local build/admission/schema/evaluation/public-card failures yield technical `pipeline-gap` with null score/grade, never issuer NR. Continue unaffected assets only with ≥90% unaffected active assets, counting quarantines and their affected dependents, and every other gate passing; unattributable graph/aggregate/evaluator/identity/global failures hold the cohort.

This does not override the [measured DEX history hold](process/report-cards-appendix.md#canonical-publication): one expired, previously mature contributing route can hold under ADR-35 despite count/rateability floors. Recovery needs fresh admitted producer evidence, not a new liquidity timestamp or discovery-priority hint. Pre-9.07 captures are read-only compatibility, never a legacy publisher/live fallback; reproduction uses recorded registry/policy/build, while current-tree replay is a separate comparison ([compatibility](process/report-cards-appendix.md#historical-capture-compatibility)).

`snapshot-safety-grade-history` appends identified V9 organic transitions only when not held; partial publication suppresses quarantined assets/dependents and their recovery. V2 rows record model, methodology, policy, evaluation-build, base-input, publication generation and transition kind. Compare publication identities, never capture `v9-input`: producer-only changes create no boundary; build rotation writes one `methodology-boundary-baseline` per asset, not organic transitions.

`GET /api/safety-score-history` remains the per-asset timeline; V8/activation boundaries are archive-only. Grade History combines it with `/api/safety-score-history-v2`, collapses consecutive same-grade baselines and labels changed-grade boundaries methodology baselines, retaining current grade/first-seen date without comparing incompatible identities.

