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

Control=min effective economic path (mint/upgrade, fee/accountant, allocator/curator, custody-transfer, parameters). Base: signer 50, opaque 60, quorum 65, quorum+delay 70, public governance/minority veto+delay 75, immutable/no-power 90. Credits: bound 10, reconciliation ≤15, supervision 15 or attestation 10; assurance ≤30, total ≤90. Compromise/exploitation=25, no credits. [Proof](mint-authority-scoring.md#mint-authority-entry) requires unavoidable delay/all-bypass closure.

Admitted reviews/normalized facts retain canonical order, causes, traces, inventory and minimum under the issuer/control contract below.

Custody/bridge/incident/oracle/reserve credit needs exact identity, current evidence/denominator. MPC/HSM needs its own complete/current profile; custody questions retain technical credit/scoped U, never quorum/process proof ([gates](process/report-cards-appendix.md#campaign-admission-rules)).

Match full issuer phrases/exact reviewed aliases (MakerDAO/Sky; StraitsX SGD/USD control group, not merged issuers/reserves). No leading-word joins; crossed/unresolved groups retain constraints ([contract](process/report-cards-appendix.md#scoped-evidence-and-exit-evaluation)).

Fatal warnings bar retained live-reserve Backing even under degraded allowlists; legacy decoding grants no scoring authority. Other snapshots retain [admission rules](live-reserves.md#snapshot-admission-gates), which also govern live/accepted detail.

Reviewed issuer-named residuals ≤1% of a complete measured book do not alone limit Backing evidence. Keep weights/C/U/identities; no quality credit. Unmarked/incomplete/larger residuals retain gates ([standard](process/mechanism-overlay-evidence-standard.md#scoped-reports-and-bounded-observations)).

Mechanism reviews enter next UTC midnight (date-only) or at their exact UTC pin, expiring original start+365d. Current admitted components govern; old reports remain diagnostic, future/unadmitted facts earn nothing. [Authoring](process/mechanism-overlay-evidence-standard.md#process-requirements) requires scoped assurance, validation/intact refs.

C/U provenance preserves upstream constraints: same-slice known/unknown loss=`max(K,U)`, not sum. Supported constraints survive unknown siblings; inherited Backing alone proves no wrapper.

`unknownQuality(pillar,cause)` prices unknown factors/unavailable pillars on rateable cards. Backing/Exit/Control: C researched non-disclosure=35/35/50; U research/infrastructure or unclassified=50/50/60. Preserve measurements/causes/provenance; unknown reconciliation/supervision earns no credit.

Whole-liability attribution (WS04-A08) and independent ordinary bridge clocks (WS04-A09) remain deferred. Current supply denominators, aggregate fallback, bridge applicability, route clocks and mint scope stand; any later clock change must preserve admitted active incidents.

XRPL liabilities bind the validated ledger hash/true close time. Pending proof is role-specific: escrow support grants no independent-liability eligibility. Missing/rejected reads prove no zero pending supply.

Exit selects the best admissible singleton/independent pair. Same-resource alternatives remain selectable but gain no diversification and share at most their maximum executable capacity; stale/diagnostic rows reserve no resources.

Require ≥2 usable pillars; price missing third via `unknownQuality` (unclassified=U), retaining 40/35/25. Across all three priced scores, m=min, M=weighted mean: `Q = m + 20 × tanh((M − m)/20)`. Measurements, applicable reviewed mechanisms/routes with bounded gaps and admitted claims are usable; subject-free defaults are not. Trace uncertainty separately. Keep peg exponent .4, nearest rounding/bands/hysteresis.

Raw grade bands use the rounded own score: **A+ 87–100; A 83–86; A− 80–82; B+ 75–79; B 70–74; B− 65–69; C+ 60–64; C 55–59; C− 50–54; D 40–49; F 0–39**. The policy's `formula.gradeThresholds` owns these cutoffs. Two-consecutive-publication hysteresis can hold a prior letter; `gradeHold` identifies the current raw band without holding the numeric score. NR and pipeline gaps have no numeric band.

Questions/low scores/incidents never cause NR; <2 usable pillars is pipeline-gap. Required-parent technical failures (cycles/evaluation included) propagate causal pipeline-gap/null score/grade, never invented scores. Other parent unavailability/quarantine/accepted holds remain. Uncertainty keeps witnesses above C− too; attribution never gates letters ([history](https://pharos.watch/methodology/scoring-changelog/#scoring-v10-29)).

Five caps: active depeg ≥10%→49/≥25%→39; known age <24m→84/24–<36m→86; parent/wrapper; realized loss; speculative-credit→59. Credit retains high measured-adverse reserve/global-claim or admitted legacy-unscoped eligibility despite Backing pricing, never deployment/access-only scope. Unknown age is uncapped. Retire other structural/evidence ceilings, retaining reserve/scoped-loss and oracle/bridge pricing; separate numeric role-pillar limits, operational-resilience credits and the unresolved-deployment-share Control adjustment are removed.

Source-proved holder loss sets L=39 for ≥25%, 49 for ≥1%, else no cap. At ageDays≥0, `eventLimit = min(100, L + (100 − L) × max(0, ageDays − 365) / 365)`; floor the minimum once. Hold through day 365, end at 730. NAV/imposed withdrawal loss needs original date, scope, holder-claim denominator/primary sources. Discounts, slippage, gross protocol/treasury-covered losses do not qualify. No duplicate charge; thresholds/periods are calibration.

Exit/wrappers require exact identities, original clocks and fresh execution; incomplete measurements prove no exhaustion. [Admission details](process/report-cards-appendix.md#model-admission-details) own fee/calendar bounds, unwind/history/hash/FX gates, execution witnesses, output pricing and unavailable-price causes.

Causes: A pipeline unavailable, B public uncurated, C researched non-disclosure, U unresolved, D adverse. Proven A/B pillars use `"excluded-a-b"`; evidence-free ones `"unavailable"`, without invented proof. Both keep null diagnostics/`partialEvidence`; unavailable cause/gap lists may be empty. Retain known/C/U/D components and original weights. <2 usable means pipeline-gap/null score/grade; pricing creates no evidence. Optional missing routes add no capacity/veto.

Do not charge deployment/bridge authority again when its exact root controller is priced in Control. Identity requires admitted facts, not asset ID. Independent controllers and measured slice failures retain proportional losses; shared roots erase no distinct measured risk.

Shared-chain/bridge losses are supply-proportional, never whole-score caps. Measured exposed quality wins; otherwise deployment-only policy uses shared-dependency moderate/high 79/64, material-bridge 74/59 and active-control-incident critical 39. Unknown shares are unresolved, not zero/full exposure. Same-root deduplication preserves distinct measured risks.

Shared-chain maturity charges require a date-admitted authored failing gate. Pending, unreviewed/missing, expired-passing or dead/non-supporting citation reviews remain Pharos-side **U diagnostics**, retaining measured exposure but adding no synthetic scored gap or chain charge. Authored failures retain proportional losses. There is no new below-5% deployment floor.

Public U means “Unresolved”, including researched but inconclusive evidence; machine keys/scoring are unchanged.

Headlines use the actual score-matching binding Control component or selected Exit route, not an unrelated first gap. Display prose humanizes factors/routes and rounds long score fractions without changing machine identities or scoring precision. Public active deployment-incident attribution requires at least **0.5 directly attributed score points**, unless a compromised authority itself binds Control. Detailed slice losses remain; inherited risk is described by the parent limit rather than an unquantified incident claim. Unwired aggregate freshness is labelled **not assessed**; publication time is never evidence time.

Suspension removes only its channel's credit/masked obligations, not alternatives, proving no global exhaustion/danger. Insufficient alternatives retain scoped U census proof under the admission details above.

Wrapper limit=`max(0, floor(min(required parents' premium-free inheritable scores) − formDeduction))`: pure 3, native-staked 5, active strategy-allocation vault 10. Final=min(independently constrained own score, limit); unavailable parents stay unavailable. Local risks belong in pillars, not another fallback/factor-sum/floor. USDT keeps +14, max87 and eligibility; no inheritance.

An admitted collateral child receives the pure-wrapper parent ceiling (premium-free parent score minus 3) only when **≥99% of admitted direct reserve rows are classified stablecoin or fund-share in that same scored parent token**. Sum qualifying same-parent rows; protocol-position denomination and composite strategy claims do not establish direct collateral eligibility. Keep any lower own score or stricter serial-parent limit; dust cannot defeat concentration, while missing/unadmitted dependencies cannot prove it. The trace identifies `parentKind: "concentrated-collateral"` and `parentAssetId`; basket `collateralParentScore` remains separate from its Backing-only score.

Exit keeps original clocks. Known supply sizes a continuous 5% request clamped to $100k–$25m; stale/missing supply uses $25m. Valid smaller measurements remain conservative capacity lower bounds relative to that request, not invented full execution or exhaustion. Curve/resolved output plus missing terms uses C/U subfactors, ceiling 70; absent curves leave capacity unknown. Same-rail certificates beat models. Execution can prove open; closure vetoes. Access once: permissionless 100, whitelist 75, institutional/API 55, manual 20, unknown C/U. Medium confidence: terms .85, certified/on-chain .75; limited queue/unknown capacity .75. Materiality: 1% of request or $100k; insufficient-completion cap 50 before confidence. Measured zero/low scores have no unknown floor.

**AM17:** all routes excluded as immaterial plus applicable C/U rail gaps means unknown Exit, not fabricated exhaustion. The published cause set is the scorer's priced cause set, including relevant factor gaps. For no-route censuses, a current aggregate-reconciled verified-no-pools share `z` remains measured zero: `Exit = (1 − z) × unknownQuality(Exit, cause)`; only uncovered supply is unknown. Unsupported-chain dust cannot replace measured zero with whole-pillar U50.

Peg spread uses only non-positive signed peak deviations; exclude above-peg events rather than zero-filling them, so premiums neither create nor dilute downside spread. Other peg terms retain their treatment.

### Morpho lender collateral-book Backing (v10.19)

Books require supported adapter/schema, complete census/exact identity, no allowlist. Direct inheritance needs ≥99% live parent-token idle/1:1 claims, not merely parent-denominated positions. Current evidenced curated serial/basket claims may inherit without live rows, retaining composition gaps; inheritance/variant labels prove no wrapper. Complete books transmit weighted collateral/LLTV risk; absent books retain reserve/mechanism evidence, pricing only unknown factors by C/U. Preserve known reserves, identity/cycle checks and weighted/disclosed sub-1%-NAV oracle branches. Missing books grant no collateral/capacity.

Policy owns class qualities; strict `lender-collateral-classes-v1.json` owns token identities/reviewers/dates/sources. Compilation binds registry/build digests, never symbol aliases or renewed clocks ([admission](process/report-cards-appendix.md#exact-nav-partition-and-quality-source)).

For collateral quality `q`/LLTV fraction `l`, lender quality=`100 − l² × (100 − q)`. Allocation weights scale deployed parent Backing; idle retains it, blend≤parent. See [methodology history](#methodology-identity) for v10.19 calibration/acceptance.

### Report schema v8

API v8 (`model: "v9"`)/publication v7 retain exact exit identity. Exclusions/partial weights, pipeline-gap/null-grade and NR remain distinct. Cards reconcile `ratingStatus`, `partialEvidence`, `confidenceDimensions`, `completeness.pipelineGapCount/pipelineGapIds`; supply/shared-book semantics stand.

Inherited-parent attribution must match referenced parents; mismatch fails schema validation at `cards`, including `safeParse`, never an escaped exception.

Lossless witness interning preserves evidence; obligation counts distinguish questions from repeated witnesses. Supply/dependency/common-mode projections preserve identities/clocks ([schema details](process/report-cards-appendix.md#report-schema-v8)).

Seed/verify both accepted private read models before strict readers. Preparation/pre-compile uses them, never full-publication fallback. Invalid baselines block compilation; unavailable lender sources use class fallback. Recovery: revert strict readers on current head, reseed an accepted cycle, reapply ([rollout](process/report-cards-appendix.md#accepted-publication-read-models)). Public API/score-index schema 2 stay unchanged.

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

