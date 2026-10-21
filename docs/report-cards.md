# Safety Scores

> **Agent navigation** — Start with [Methodology Identity](#methodology-identity), [V10 Model](#v10-model), [API](#api) and [Consumers](#consumers). Maintainer detail is routed through `docs/mint-authority-scoring.md#mint-authority-entry` and the [technical appendix](https://github.com/TokenBrice/pharos-watch/blob/main/docs/process/report-cards-appendix.md); use their selected sections, not whole-file reads.

Safety Score V10 is the sole active stablecoin safety model. It publishes evidence-backed grades from A+ through F; NR is a causal withholding outcome, while Pipeline gap has no score or grade.

The public grade-distribution total is labeled **assets**, since its A/B/C/D/F/NR segments include not-rated assets. Rated-only supply and coverage figures keep their narrower denominator, including the hero's supply-weighted grade row and its A/B supply headline.


## Methodology Identity

- Active model: <!-- GENERATED-START: report-cards-active-model -->`v10`<!-- GENERATED-END: report-cards-active-model -->
- **Current methodology version:** <!-- GENERATED-START: methodology-version-safety-score -->`v10.27`<!-- GENERATED-END: methodology-version-safety-score -->
- Public breakdown/publication schema v7, API wrapper v8 and score trace v4; retained older publications require explicit historical dispatch or refusal, never fabricated causes or route identity
- Policy: `shared/data/safety-score-v9/methodology-policy-candidate-v1.json`, parsed and digested by `shared/lib/safety-score-v9/policy.ts`
- **Evaluation build:** `SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST` in `shared/data/safety-score-v9/evaluation-build-manifest-v1.ts` binds the offline candidate runtime import graph: captured fixed-input normalization, extension construction, fact-set compilation, evaluation and projection, including executable admission schemas, reviewed score-input data and full-catalog bytes/decoder. Edits anywhere in that evaluation-time closure rotate replay/publication identity. Capture-only network observers/producers and build-time generators are outside it; exact-input/fact digests bind their admitted output. Capture binding and runtime identity consumers are unchanged.
- Implementation: `shared/lib/safety-score-v9/`
- Structured changelog: `shared/data/methodology-changelogs/safety-score/`
- Public methodology: `/methodology/#safety-scores-methodology`
- Scoring history: `/methodology/scoring-changelog/`

Historical V8 methodology is documented in the scoring changelog. It is not a production API, fallback, selector input, or frontend model.

Release changes, activation status, replay evidence and outstanding acceptance obligations live in the [structured scoring history](https://pharos.watch/methodology/scoring-changelog/), including [v10.15](https://pharos.watch/methodology/scoring-changelog/archive/v10/#scoring-v10-15), [v10.18](https://pharos.watch/methodology/scoring-changelog/archive/v10/#scoring-v10-18) and [v10.21](https://pharos.watch/methodology/scoring-changelog/#scoring-v10-21). v10.26 grade hysteresis (`gradeHold`) and bounded carry-forward are specified in the [appendix](process/report-cards-appendix.md#v1026-bounded-carry-forward-and-grade-hysteresis), v10.27 chain-supply carry-forward [there too](process/report-cards-appendix.md#v1027-chain-supply-carry-forward). A version definition or fixed-input replay does not establish fresh producer closure or production health.

V10.01 introduces cause-aware scoring after the V10 major release. Internal `safety-score-v9` implementation names and API route paths remain unchanged; public body schemas distinguish technical availability from NR. Digest snapshots label their grade distribution from the captured methodology major version, preserving V9 editions rather than relabelling history.

## V10 Model

V10 evaluates three pillars:

| Pillar | Aggregation weight | Scope |
| --- | ---: | --- |
| Backing | <!-- GENERATED-START: report-cards-backing-pillar-weight -->40%<!-- GENERATED-END: report-cards-backing-pillar-weight --> | Reserve quality, mechanism solvency, custody, assurance, and loss-bearing structure |
| Exit | <!-- GENERATED-START: report-cards-exit-pillar-weight -->35%<!-- GENERATED-END: report-cards-exit-pillar-weight --> | Same-notional executable capacity, cost, settlement, confidence, independent backup credit, and stress horizon |
| Economic Control | <!-- GENERATED-START: report-cards-control-pillar-weight -->25%<!-- GENERATED-END: report-cards-control-pillar-weight --> | Mint, upgrade, oracle, bridge, and other binding control paths |

The Economic Control mint component evaluates native issuance posture, process certification and seasoning, not a second standalone Mint Authority score. It distinguishes affirmative governance and veto constraints from unrestricted operator discretion, and preserves measured adverse reach when evidence is incomplete. The [public methodology](https://pharos.watch/methodology/#safety-scores-methodology) explains the active model; exact ladders and D33 availability rules are maintained in `docs/mint-authority-scoring.md`.

Economic Control consumes the normalized asset facts and admitted mint/oracle/bridge reviews directly at one evaluator seam; canonical ordering and policy validation remain evaluator-owned. Private mint, oracle and bridge phases share one evaluation-local context; inventory checks and section fallbacks remain explicit, and final component normalization preserves causal metadata, canonical traces and the same binding minimum. See `docs/process/report-cards-appendix.md#scoped-evidence-and-exit-evaluation` for the internal contract.

Custody, bridge, incident, oracle and reserve-review credit is scope-bound: identity, current primary evidence and the relevant denominator must be established independently. One favorable review cannot close sibling controls or grant unmeasured capacity. Detailed maintainer admission gates live in `docs/process/report-cards-appendix.md#campaign-admission-rules`.

Issuer keys retain complete normalized phrases. Exact reviewed aliases cover governance identity (MakerDAO/Sky) or an explicitly approved issuer group: StraitsX SGD Issuance Pte. Ltd. and StraitsX USD Issuance Pte. Ltd. share the StraitsX common-mode-control group, not a single legal issuer or reserve pool. Other leading-name matches do not merge; crossed/unresolved groups retain the constraint. See the [issuer-identity contract](https://github.com/TokenBrice/pharos-watch/blob/main/docs/process/report-cards-appendix.md#scoped-evidence-and-exit-evaluation).

Retained live reserve snapshots with any fatal warning are not Backing inputs, even when that warning code appears in a per-coin degraded allowlist. Legacy warning decoding preserves the evidence, not its scoring authority; clean, informational and permitted degraded snapshots retain their existing admission rules. The [reserve admission contract](live-reserves.md#snapshot-admission-gates) also withholds impossible fatal live detail and accepted snapshots.

Mechanism-review overlays and independently reviewed components accept a strict evidence date or exact UTC timestamp. Date-only claims retain next-UTC-midnight admission; timestamped claims enter at their evidence instant, never before it. The unchanged 365-day expiry runs from the original review start (UTC midnight for a date, the exact instant for a timestamp). This admission-timing capability is score-neutral for existing date-only entries; it neither renews evidence nor changes quality grades, scoring formulas or weights. Authoring rules live in [Mechanism-overlay evidence standard](process/mechanism-overlay-evidence-standard.md#process-requirements).

Evaluated upstream constraints survive C/U provenance: same-slice known and unresolved losses combine as `max(K,U)`, not their sum. Supported profile constraints survive unavailable sibling obligations; inherited Backing alone does not establish a wrapper.

The broader whole-liability supply-attribution change (WS04-A08) and independent ordinary bridge-route clock change (WS04-A09) are deferred from T1. Existing supply denominators, aggregate fallback, bridge applicability, route-clock semantics and mint-scope behavior remain in force. The deferred route-clock implementation must preserve independently admitted active incidents before it can be reconsidered.

Reviewed XRPL liabilities bind obligations to the exact validated ledger hash and its true close time. Pending proofs remain scoped to their accounting role: an escrow-supported protocol is not automatically eligible for independent liabilities. Missing or rejected reads never establish zero pending supply.

Independently admitted same-resource observations remain selectable alternatives. Exit chooses the best feasible singleton or independent pair; overlapping inventory earns no diversification credit and contributes at most its maximum admitted executable capacity. Diagnostic or expired observations cannot reserve resources against current alternatives.

Weights bound headroom, not an unrestricted average. With included pillars S, renormalize their original weights, let m be their minimum and M their weighted mean, then Q = m + 20 × tanh((M − m)/20). Three included pillars keep 40/35/25; exactly one A/B-only pillar permits a two-pillar rating. Q ≤ M ≤ max(S) holds before independently evidenced additions. Peg behavior, positively evidenced structural/method/parent/history limits and wrapper-local risk still apply; missing-data and generic evidence ceilings do not.

Exit and wrapper valuation require independently admitted exact identities, original source clocks and fresh execution evidence; incomplete measurements never establish exhaustion. The [model admission details](https://github.com/TokenBrice/pharos-watch/blob/main/docs/process/report-cards-appendix.md#model-admission-details) own published-fee/calendar bounds, unwind thresholds, measured-history/hash/FX gates, ERC-4626/custodian witnesses, output pricing and unavailable-price cause proofs.


Missing evidence is classified by scoped proof: A pipeline unavailable; B current required public data not curated; C researched non-disclosure; U unresolved; D measured adverse. A/B factors stay visible with null scored values and zero effective weight, never synthetic favorable facts. Mixed components keep known/C/U/D constraints. `partialEvidence` flags contributing subcomponent exclusions as well as whole pillars; route-exclusive A/B gaps on unscored optional Exit alternatives remain diagnostic only, without hiding other exclusions. Two or three A/B-only pillars publish `ratingStatus: "pipeline-gap"`, null score/grade and diagnostic breakdowns, not NR or a one-pillar Safety Score. Exactly one excluded pillar publishes a two-pillar partial rating only if the other gates pass.

The public U label is “Unresolved”: researched inputs can still lack a conclusive admissible source. This wording does not change machine keys or scoring.

Reviewed suspension removes only the exact channel's capacity/credit and masked obligations; it proves neither exhaustion nor whole-asset danger. Independent alternatives remain evaluable, and insufficient alternatives retain a scoped U whole-Exit census witness. [Admission details](https://github.com/TokenBrice/pharos-watch/blob/main/docs/process/report-cards-appendix.md#model-admission-details) prevent suspension from bypassing genuine uncertainty/NR.

Wrapper reviews scope accounting/mutability/withdrawals, not capacity/aggregate closure. Terms price access, execution model, settlement/fees, not measurement/model certainty; adverse floors, certificate freshness and independent fail-closed unwind gates remain.

### Morpho lender collateral-book Backing (v10.19)

Morpho books weight frozen accepted Backing or class quality by allocation and LLTV². Idle keeps parent quality; the blend cannot exceed it. Same-parent multi-slice books keep lower generic constraints; unavailable books keep prior scoring. Sub-1%-NAV oracle branches stay disclosed, weighted; unmatched claims keep the prior aggregate.

For collateral quality `q` and LLTV fraction `l`, transmitted lender quality is `100 − l² × (100 − q)`. Allocation-weighted book quality scales the deployed share of parent Backing, while idle retains parent quality; the final blend is capped at the parent. The [v10.19 changelog](https://pharos.watch/methodology/scoring-changelog/archive/v10/#scoring-v10-19) retains calibration evidence and production-acceptance boundaries.

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


Pillar freshness stays categorical; opt-in operands follow the compact-representation contract above. Scores and legacy wire stay unchanged.

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

