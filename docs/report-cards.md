# Safety Scores

> **Agent navigation** — Start with [Methodology Identity](#methodology-identity), [V10 Model](#v10-model), [API](#api) and [Consumers](#consumers). Maintainer detail is routed through `docs/mint-authority-scoring.md#mint-authority-entry` and the [technical appendix](https://github.com/TokenBrice/pharos-watch/blob/main/docs/process/report-cards-appendix.md); use their selected sections, not whole-file reads.

Safety Score V10 is the sole active stablecoin safety model. It publishes evidence-backed grades from A+ through F; NR is a causal withholding outcome, while Pipeline gap has no score or grade.

The public grade-distribution total is labeled **assets**, since its A/B/C/D/F/NR segments include not-rated assets. Rated-only supply and coverage figures keep their narrower denominator, including the hero's supply-weighted grade row and its A/B supply headline.


## Methodology Identity

- Active model: <!-- GENERATED-START: report-cards-active-model -->`v10`<!-- GENERATED-END: report-cards-active-model -->
- **Current methodology version:** <!-- GENERATED-START: methodology-version-safety-score -->`v10.28`<!-- GENERATED-END: methodology-version-safety-score -->
- Public breakdown/publication schema v7, API wrapper v8 and score trace v4; retained older publications require explicit historical dispatch or refusal, never fabricated causes or route identity
- Policy: `shared/data/safety-score-v9/methodology-policy-candidate-v1.json`, parsed and digested by `shared/lib/safety-score-v9/policy.ts`
- **Evaluation build:** `SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST` in `shared/data/safety-score-v9/evaluation-build-manifest-v1.ts` binds the offline candidate runtime import graph: captured fixed-input normalization, extension construction, fact-set compilation, evaluation and projection, including executable admission schemas, reviewed score-input data and full-catalog bytes/decoder. Edits anywhere in that evaluation-time closure rotate replay/publication identity. Capture-only network observers/producers and build-time generators are outside it; exact-input/fact digests bind their admitted output. Capture binding and runtime identity consumers are unchanged.
- Implementation: `shared/lib/safety-score-v9/`
- Structured changelog: `shared/data/methodology-changelogs/safety-score/`
- Public methodology: `/methodology/#safety-scores-methodology`
- Scoring history: `/methodology/scoring-changelog/`

Historical V8 methodology is documented in the scoring changelog. It is not a production API, fallback, selector input, or frontend model.

Release changes, activation status, replay evidence and outstanding acceptance obligations live in the [structured scoring history](https://pharos.watch/methodology/scoring-changelog/), including [v10.15](https://pharos.watch/methodology/scoring-changelog/archive/v10/#scoring-v10-15), [v10.18](https://pharos.watch/methodology/scoring-changelog/archive/v10/#scoring-v10-18) and [v10.21](https://pharos.watch/methodology/scoring-changelog/#scoring-v10-21). v10.26 grade hysteresis (`gradeHold`) and bounded carry-forward are specified in the [appendix](process/report-cards-appendix.md#v1026-bounded-carry-forward-and-grade-hysteresis), v10.27 chain-supply carry-forward [there too](process/report-cards-appendix.md#v1027-chain-supply-carry-forward). A version definition or fixed-input replay does not establish fresh producer closure or production health.

The local v10.28 Release 1 candidate is recorded in [structured history](https://pharos.watch/methodology/scoring-changelog/#scoring-v10-28). It includes exit correctness, mild-wrapper protection, current-review-gated MPC/HSM custody, atomic exact-parent exits, published-residual materiality and headline reasons. Stricter D33 standards, PoR-cadence changes, upgrade-only competition, parent-governed U, bounded residual-cap grandfathering and source-bound F witnesses are deferred. This source-tree version establishes neither production activation nor replay or first-publication acceptance.

V10.01 introduces cause-aware scoring after the V10 major release. Internal `safety-score-v9` implementation names and API route paths remain unchanged; public body schemas distinguish technical availability from NR. Digest snapshots label their grade distribution from the captured methodology major version, preserving V9 editions rather than relabelling history.

## V10 Model

V10 evaluates three pillars:

| Pillar | Aggregation weight | Scope |
| --- | ---: | --- |
| Backing | <!-- GENERATED-START: report-cards-backing-pillar-weight -->40%<!-- GENERATED-END: report-cards-backing-pillar-weight --> | Reserve quality, mechanism solvency, custody, assurance, and loss-bearing structure |
| Exit | <!-- GENERATED-START: report-cards-exit-pillar-weight -->35%<!-- GENERATED-END: report-cards-exit-pillar-weight --> | Same-notional executable capacity, cost, settlement, confidence, independent backup credit, and stress horizon |
| Economic Control | <!-- GENERATED-START: report-cards-control-pillar-weight -->25%<!-- GENERATED-END: report-cards-control-pillar-weight --> | Mint, upgrade, oracle, bridge, and other binding control paths |

Control grades mint/process/seasoning once; known adverse reach survives incomplete evidence. The [mint contract](mint-authority-scoring.md#mint-authority-entry) owns the existing D33 ladder. Release 1 retains the existing proof-of-reserves cadence inference and mint-path competition rather than adopting the stricter Release 2 standards.

Control consumes normalized facts and admitted mint/oracle/bridge reviews. Policy, canonical-order, inventory and fallback checks retain causes, traces and the binding minimum ([contract](process/report-cards-appendix.md#scoped-evidence-and-exit-evaluation)).

Custody/bridge/incident/oracle/reserve credit needs exact identity, current evidence and its denominator. MPC/HSM needs its own complete/current control-profile review, never a parent renewal. Custody-only questions retain admitted technical credit and scoped U, not human-quorum/execution/process proof ([admission gates](process/report-cards-appendix.md#campaign-admission-rules)).

Match complete normalized issuer phrases. Exact reviewed aliases cover MakerDAO/Sky governance identity or the approved StraitsX SGD Issuance Pte. Ltd./StraitsX USD Issuance Pte. Ltd. common-mode-control group—not one legal issuer or reserve pool. Leading-name matches never merge; crossed/unresolved groups retain the constraint ([issuer contract](process/report-cards-appendix.md#scoped-evidence-and-exit-evaluation)).

Any fatal warning bars a retained live-reserve snapshot from Backing, even if per-coin allowlisted as degraded. Legacy decoding preserves warning evidence, not scoring authority; clean, informational and permitted degraded snapshots keep existing admission rules. [Reserve admission](live-reserves.md#snapshot-admission-gates) also withholds impossible fatal live detail and accepted snapshots.

Owner-adopted v10.28 materiality: explicitly reviewed issuer-named residual categories aggregating to ≤1% of a complete measured book do not alone limit Backing evidence. Their whole-book weights, scoped C/U pricing and identities remain; no reserve/assurance/liquidity credit is added. Unmarked categories, coverage gaps and larger aggregates retain limiting gates ([evidence standard](process/mechanism-overlay-evidence-standard.md#scoped-reports-and-bounded-observations)).

Mechanism strict dates enter next UTC midnight; exact UTC timestamps enter at their instant. Overlays/components expire 365 days from the original review start. Current components govern after report-scope/technical gates; old reports stay diagnostic, not co-expiring. Future/same-day-unadmitted components keep history without credit. [Authoring](process/mechanism-overlay-evidence-standard.md#process-requirements) retains strict validation, scoped financial assurance and non-orphaned refs. Timing changes no date-only score, quality, formula or weight.

Evaluated upstream constraints survive C/U provenance: same-slice known and unresolved losses combine as `max(K,U)`, not their sum. Supported profile constraints survive unavailable sibling obligations; inherited Backing alone does not establish a wrapper.

The broader whole-liability supply-attribution change (WS04-A08) and independent ordinary bridge-route clock change (WS04-A09) are deferred from T1. Existing supply denominators, aggregate fallback, bridge applicability, route-clock semantics and mint-scope behavior remain in force. The deferred route-clock implementation must preserve independently admitted active incidents before it can be reconsidered.

Reviewed XRPL liabilities bind obligations to the exact validated ledger hash and its true close time. Pending proofs remain scoped to their accounting role: an escrow-supported protocol is not automatically eligible for independent liabilities. Missing or rejected reads never establish zero pending supply.

Independently admitted same-resource observations remain selectable alternatives. Exit chooses the best feasible singleton or independent pair; overlapping inventory earns no diversification credit and contributes at most its maximum admitted executable capacity. Diagnostic or expired observations cannot reserve resources against current alternatives.

Weights bound headroom, not an unrestricted average. With included pillars S, renormalize their original weights, let m be their minimum and M their weighted mean, then Q = m + 20 × tanh((M − m)/20). Three included pillars keep 40/35/25; exactly one A/B-only pillar permits a two-pillar rating. Q ≤ M ≤ max(S) holds before independently evidenced additions. Peg behavior, positively evidenced structural/method/parent/history limits and wrapper-local risk still apply; missing-data and generic evidence ceilings do not.

F needs a score-causal admitted source or existing numeric peg witness, not an adverse label. Known unbounded authority qualifies beside C/U process gaps; unwitnessed F stays NR, never a D uplift. [Cap/witness rules](process/report-cards-appendix.md#cap-limits-and-scope-gates) retain source clocks, D gates and public diagnostics.

The v10.28 per-kind provisional cap applies uniformly to admitted measured-adverse `speculative-credit:high` at reserve-claim or global-claim scope and `centralized-mint:high` at global-claim scope, even when already priced in Backing or Control and without an additional residual-risk marker. The existing policy `signalLimits` owns the 59 ceiling; no asset identity or grandfather list selects eligibility. Deployment-only and access-only signals retain their scope gates, and stricter independent caps still win. Other pillar-priced signals retain the explicit residual-risk requirement. The provisional rule adds no per-asset review exemption.

Exit and wrapper valuation require independently admitted exact identities, original source clocks and fresh execution evidence; incomplete measurements never establish exhaustion. The [model admission details](process/report-cards-appendix.md#model-admission-details) own published-fee/calendar bounds, unwind thresholds, measured-history/hash/FX gates, ERC-4626/custodian witnesses, output pricing and unavailable-price cause proofs.

Scoped proof classifies missing evidence: A pipeline unavailable; B current public data not curated; C researched non-disclosure; U unresolved; D measured adverse. A/B factors retain null scored values and zero weight, not favorable facts; mixed components keep known/C/U/D constraints. `partialEvidence` flags contributing subcomponent and whole-pillar exclusions; optional unscored Exit-route A/B gaps stay diagnostic without hiding other exclusions. Two or three A/B-only pillars publish `ratingStatus: "pipeline-gap"`, null score/grade and diagnostic breakdowns—not NR or a one-pillar rating. Exactly one excluded pillar permits a two-pillar partial rating only if other gates pass.

The public U label is “Unresolved”: researched inputs can still lack a conclusive admissible source. This wording does not change machine keys or scoring.

Reviewed suspension removes only the exact channel's capacity/credit and masked obligations; it proves neither exhaustion nor whole-asset danger. Independent alternatives remain evaluable, and insufficient alternatives retain a scoped U whole-Exit census witness. [Admission details](process/report-cards-appendix.md#model-admission-details) prevent suspension from bypassing genuine uncertainty/NR.

Wrapper reviews price local powers/terms, not measurement certainty, capacity or aggregate closure. [Eligible direct parent returns](process/report-cards-appendix.md#wrapper-local-evidence) stay reviewed/moderate without end-to-end bounds; parent realization and worse independent terms remain priced. Mild charges/form fallback stop non-F parent limits at policy D before rounding; high/critical/measured-adverse findings and F parents keep full charges. Independent pillar/peg danger, certificate freshness and fail-closed unwind gates remain.

### Morpho lender collateral-book Backing (v10.19)

Morpho books use frozen accepted Backing or class quality. Same-parent multi-slice books keep lower generic constraints; unavailable books keep prior scoring. Sub-1%-NAV oracle branches stay disclosed and weighted; unmatched claims keep the prior aggregate.

Class qualities remain methodology policy; exact chain/token classifications live in the strict reviewed `lender-collateral-classes-v1.json` data registry with reviewer, original date and sources. The compiler binds its own registry digest and evaluation-build closure, without symbol aliases or renewed allocation clocks. The [Morpho appendix](process/report-cards-appendix.md#exact-nav-partition-and-quality-source) owns registry admission and migration boundaries.

For collateral quality `q`/LLTV fraction `l`, lender quality is `100 − l² × (100 − q)`. Allocation-weighted quality scales deployed parent Backing; idle retains it and the blend stays capped at parent quality ([v10.19 calibration/acceptance](https://pharos.watch/methodology/scoring-changelog/archive/v10/#scoring-v10-19)).

### Report schema v8

The outer API report is schema v8 (`model: "v9"`), carrying public publication schema v7 with typed exact exit identity. Cause-bearing exclusions, partial weights and pipeline-gap/null-grade remain distinct from NR. `ratingStatus`, full `partialEvidence`, separate `confidenceDimensions` and `completeness.pipelineGapCount/pipelineGapIds` reconcile to the cards. Existing supply/shared-book fields retain their meanings.

The publication envelope cross-checks inherited parent attribution against the referenced parents. A mismatch is a normal schema validation failure at `cards`, including for `safeParse` callers, rather than an exception escaping validation.

Lossless witness interning preserves evidence, while obligation counts distinguish source questions from repeated witnesses. Supply/dependency projections and common-mode effects retain exact identities and clocks; implementation details live in `docs/process/report-cards-appendix.md#report-schema-v8`.

Accepted publication's private read models serve preparation and pre-compile comparison without decoding the prior full publication. Writers must seed and verify both rows before strict readers deploy; no full-publication fallback exists. Missing/invalid baseline projections block compilation with a named failed attempt; lender-source failures retain unavailable/class fallback. Recovery reverts only the strict-reader change on current head, reseeds through one normal accepted cycle, then reapplies it (`docs/process/report-cards-appendix.md#accepted-publication-read-models`). Public API and score-index schema 2 are unchanged.

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

