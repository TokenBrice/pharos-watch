# Safety Scores

> **Agent navigation** — Start with [Methodology Identity](#methodology-identity), [V10 Model](#v10-model), [API](#api) and [Consumers](#consumers). Maintainer detail is routed through `docs/mint-authority-scoring.md#mint-authority-entry` and the [technical appendix](https://github.com/TokenBrice/pharos-watch/blob/main/docs/process/report-cards-appendix.md); use their selected sections, not whole-file reads.

Safety Score V10 is the sole active stablecoin safety model. It publishes evidence-backed grades from A+ through F. NR denotes genuine rating unavailability, never a low-score or missing-subfactor penalty; technical Pipeline gaps have no score or grade.

The public grade-distribution total is labeled **assets**, since its A/B/C/D/F/NR segments include not-rated assets. Rated-only supply and coverage figures keep their narrower denominator, including the hero's supply-weighted grade row and its A/B supply headline.


## Methodology Identity

- Active model: <!-- GENERATED-START: report-cards-active-model -->`v10`<!-- GENERATED-END: report-cards-active-model -->
- **Current methodology version:** <!-- GENERATED-START: methodology-version-safety-score -->`v10.40`<!-- GENERATED-END: methodology-version-safety-score -->
- Public breakdown/publication schema v8, API wrapper v9 and score trace v4; retained older publications require explicit historical dispatch or refusal, never fabricated causes or route identity
- Policy: `shared/data/safety-score-v9/methodology-policy-candidate-v1.json`, parsed and digested by `shared/lib/safety-score-v9/policy.ts`
- **Evaluation build:** `SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST` in `shared/data/safety-score-v9/evaluation-build-manifest-v1.ts` binds the offline candidate runtime import graph: captured fixed-input normalization, extension construction, fact-set compilation, evaluation and projection, including executable admission schemas, reviewed score-input data and full-catalog bytes/decoder. Edits anywhere in that evaluation-time closure rotate replay/publication identity; domain `safety-score-v9.evaluation-build.v2` hashes reviewed JSON data by its stable parsed value, so formatting/key-order-only edits do not, while executable sources stay byte-hashed. Capture-only network observers/producers and build-time generators are outside it; exact-input/fact digests bind their admitted output. Capture binding and runtime identity consumers are unchanged.
- Implementation: `shared/lib/safety-score-v9/`
- Structured changelog: `shared/data/methodology-changelogs/safety-score/`
- Public methodology: `/methodology/#safety-scores-methodology`
- Scoring history: `/methodology/scoring-changelog/`

Historical V8 methodology is documented in the scoring changelog. It is not a production API, fallback, selector input, or frontend model.

The [structured scoring history](https://pharos.watch/methodology/scoring-changelog/) owns release changes, activation status, replay evidence and outstanding acceptance. Appendix contracts own [v10.26 hysteresis/carry-forward](process/report-cards-appendix.md#v1026-bounded-carry-forward-and-grade-hysteresis) and [v10.27 chain-supply carry-forward](process/report-cards-appendix.md#v1027-chain-supply-carry-forward). A version or fixed-input replay does not establish producer closure or production health.

The [v10.30 history](https://pharos.watch/methodology/scoring-changelog/#scoring-v10-30) owns its calibration, evidence corrections and replay attribution; replay is not production acceptance.

V10.01 introduces cause-aware scoring after the V10 major release. Internal `safety-score-v9` implementation names and API route paths remain unchanged; public body schemas distinguish technical availability from NR. Digest snapshots label their grade distribution from the captured methodology major version, preserving V9 editions rather than relabelling history.

## V10 Model

V10 evaluates three pillars:

| Pillar | Aggregation weight | Scope |
| --- | ---: | --- |
| Backing | <!-- GENERATED-START: report-cards-backing-pillar-weight -->40%<!-- GENERATED-END: report-cards-backing-pillar-weight --> | Reserve quality, mechanism solvency, custody, assurance, and loss-bearing structure |
| Exit | <!-- GENERATED-START: report-cards-exit-pillar-weight -->35%<!-- GENERATED-END: report-cards-exit-pillar-weight --> | Same-notional executable capacity, cost, settlement, confidence, independent backup credit, and stress horizon |
| Economic Control | <!-- GENERATED-START: report-cards-control-pillar-weight -->25%<!-- GENERATED-END: report-cards-control-pillar-weight --> | Mint, upgrade, oracle, bridge, and other binding control paths |

Control=min binding economic path, overall≤90 (including non-authority). [Authority ladder/proof](mint-authority-scoring.md#mint-authority-entry): signer50, opaque60, quorum65, delay70, governance/veto+delay75, no-power90; bound+10, reconciliation≤15, supervision15/attestation10, assurance≤30, component≤90. Compromise25/no credits; >80 needs no supervision.

v10.31: known-share local authority, including bounded powers/incidents, is non-binding and priced without thresholds by the [resolved mixture](process/report-cards-appendix.md#v1031-exposure-weighted-local-authority). Null-share binding, bridges and oracles retain prior treatment.

Admitted facts retain canonical order, causes, traces and inventory under the control contract below.

Custody/bridge/incident/oracle/reserve credit requires exact identity and current evidence/denominator. MPC/HSM needs its own complete/current profile; custody gaps retain technical credit/scoped U, not quorum proof ([gates](process/report-cards-appendix.md#campaign-admission-rules)).

Match full issuer phrases/exact reviewed aliases, never leading words; shared control does not merge reserves. Crossed/unresolved groups retain constraints ([contract](process/report-cards-appendix.md#scoped-evidence-and-exit-evaluation)).

Fatal warnings bar retained live-reserve Backing even under degraded allowlists; legacy decoding grants no scoring authority. Other snapshots retain [admission rules](live-reserves.md#snapshot-admission-gates), which also govern live/accepted detail.

Reviewed issuer-named residuals ≤1% of a complete measured book do not alone limit Backing evidence. Keep weights/C/U/identities; no quality credit. Unmarked/incomplete/larger residuals retain gates ([standard](process/mechanism-overlay-evidence-standard.md#scoped-reports-and-bounded-observations)).

Mechanism reviews admit next UTC midnight (date-only) or at their exact UTC pin, expiring original start+365d. Old/future/unadmitted facts earn nothing; component reviews renew no siblings. [Authoring](process/mechanism-overlay-evidence-standard.md#process-requirements) requires scoped assurance/intact refs.

C/U provenance preserves upstream constraints: same-slice known/unknown loss=`max(K,U)`, not sum. Supported constraints survive unknown siblings; inherited Backing alone proves no wrapper.

`unknownQuality(pillar,cause)` prices unknown factors/unavailable pillars: Backing/Exit/Control C non-disclosure=35/50/50; U research/infrastructure or unclassified=50/50/60. Exit C/U labels are presentation-only (both50). Preserve measurements/causes/provenance; unknown reconciliation/supervision earns no credit.

Verified worse facts score lower than unresolved ones: an opaque controller proven single-key drops base60→50. Unknown is priced as uncertainty, not as safety; research can lower scores.

Rated cards are **Provisional** at **>50% unknown-constant scoring weight**. Optional `provisional: true` / `unknownPricedWeightShare` are absent otherwise and on older archives. Sum original pillar weights × effective C/U component/subfactor weights, including controlling paths and a priced missing third pillar; exclude measured adversity, excluded factors and verified pool-less supply. Label only: no score/grade/availability change or new ±1 boundary hold.

XRPL liabilities bind the validated ledger hash/true close time. Pending proof is role-specific: escrow support grants no independent-liability eligibility. Missing/rejected reads prove no zero pending supply.

Exit selects the best admissible singleton/independent pair. Same-resource alternatives remain selectable but gain no diversification and share at most their maximum executable capacity; stale/diagnostic rows reserve no resources.

Require ≥2 usable pillars; price a missing third via `unknownQuality` (unclassified=U), retaining40/35/25. With m=min, M=weighted mean, `Q = m + 20 × tanh((M − m)/20)`. Measurements, applicable reviewed subjects with bounded gaps and admitted claims are usable; defaults are not. Keep peg exponent .4, nearest rounding/bands/hysteresis.

Raw grade bands use the rounded own score: **A+ 87–100; A 83–86; A− 80–82; B+ 75–79; B 70–74; B− 65–69; C+ 60–64; C 55–59; C− 50–54; D 40–49; F 0–39**. The policy's `formula.gradeThresholds` owns these cutoffs. Two-consecutive-publication hysteresis can hold a prior letter; `gradeHold` identifies the current raw band without holding the numeric score. NR and pipeline gaps have no numeric band.

Questions/low scores/incidents never cause NR; <2 usable pillars is pipeline-gap. Required-parent technical failures propagate pipeline-gap/null score/grade. Other parent unavailability/quarantine/accepted holds remain. Uncertainty witnesses survive above C−; attribution never gates letters ([history](https://pharos.watch/methodology/scoring-changelog/#scoring-v10-29)).

Five caps: open-event peak depeg≥10%→49/≥25%→25/≥50%→10; known age<24m→84; parent/wrapper; realized loss; speculative-credit→59. Unknown age is uncapped. [Scope gates](process/report-cards-appendix.md#cap-limits-and-scope-gates) own eligibility and quantization; no other structural/evidence ceiling remains.

Source-proved NAV/imposed withdrawal loss: ≥25%→39, ≥1%→49, held365d then relaxing to100 at730d. [Event scope, sources and exclusions](process/report-cards-appendix.md#cap-limits-and-scope-gates) prevent duplicate or non-holder-loss charges; thresholds/periods are calibration.

Exit/wrappers require exact identities, original clocks and fresh execution; incomplete measurements prove no exhaustion. [Admission details](process/report-cards-appendix.md#model-admission-details) own fee/calendar bounds, unwind/history/hash/FX gates, execution witnesses, output pricing and unavailable-price causes.

Causes: A pipeline unavailable, B public uncurated, C researched non-disclosure, U unresolved, D adverse. Proven A/B pillars use `"excluded-a-b"`; evidence-free ones `"unavailable"`, without invented proof. Both keep null diagnostics/`partialEvidence`; unavailable cause/gap lists may be empty. Retain known/C/U/D components and original weights. <2 usable means pipeline-gap/null score/grade; pricing creates no evidence. Optional missing routes add no capacity/veto.

Local authority has no shared-root suppression: dominated paths cost zero, worse paths cost their share. Control shows global paths; deployment rows disclose local quality/share and resolved counterfactual score.

Shared-chain/bridge losses remain proportional, never caps. Evaluated quality wins; fallback policy: shared-dependency moderate/high79/64, material-bridge74/59, active-incident critical39. Authority leaves this resolver pool: inputs stay unchanged; allocations/deductions may move. Unknown shares remain unresolved.

Shared-chain maturity charges require a date-admitted authored failing gate. Pending, unreviewed/missing, expired-passing or dead/non-supporting citation reviews remain Pharos-side **U diagnostics**, retaining measured exposure but adding no synthetic scored gap or chain charge. Authored failures retain proportional losses. There is no new below-5% deployment floor.

Public U means “Unresolved”, including researched but inconclusive evidence; machine keys/scoring are unchanged.

Documentation gaps are a policy determination, not a fourth cause, and change no evidence level: a limited pillar reads "limited · documentation gaps only" only when every `limitingCauseGapIds` entry resolves to a documentation gap ([class](process/report-cards-appendix.md#documentation-class-v1037)).

Headlines follow score-matching binding Control components/credited Exit routes. Humanized labels/rounded display preserve machine identity/precision. Active deployment-incident headlines need **≥0.5 directly attributed points**, unless compromised authority binds Control. Detailed losses remain; inherited risk uses parent limits. Unwired freshness is **not assessed**, never publication time.

Suspension removes only its channel's credit/masked obligations, not alternatives, proving no global exhaustion/danger. Insufficient alternatives retain scoped U census proof under the admission details above.

Wrapper limit=`max(0, floor(min(required parents' premium-free inheritable scores) − formDeduction))`: pure 3, native-staked 5, active strategy-allocation vault 10. Final=min(independently constrained own score, limit); unavailable parents stay unavailable. Local risks belong in pillars, not another fallback/factor-sum/floor. USDT returns to +12 after the artefact fixes, retaining max87 and eligibility; no inheritance.

Collateral children receive premium-free parent−3 when **≥99% of admitted direct reserve rows are stablecoin/fund-share claims in that scored parent**. Sum same-parent rows; denomination/composite strategies do not qualify. Keep lower own scores/stricter serial limits; missing/unadmitted dependencies prove nothing. Trace `parentKind: "concentrated-collateral"`/`parentAssetId`; `collateralParentScore` differs from Backing inheritance.

Exit request=5% usable supply clamped **$1m–$25m**; missing/stale supply=$25m. Smaller observations remain capacity lower bounds, never full execution/exhaustion. Materiality separately uses5% supply clamped $100k–$25m: raw capacity≥1% of that amount or $100k qualifies; missing/stale=$25m. Raising stress cannot erase thin measurements into U50. Curves/resolved output plus missing fee/settlement use C/U subfactors, ceiling70; absent curves leave capacity unknown. Same-rail exact-complete certificates beat models; execution proves open, closure vetoes. Access once: permissionless100, whitelist75, institutional/API55, manual20, unknown C/U. Medium model confidence: documented terms .85, other on-chain/models .75; admitted exact execution certificates scale .85→1.00 with the share of the current stress ask their scored point measured, and observation confidence follows that share from a .85 floor, never lifted from a low/unknown label, while limited queue/unknown capacity .75 stays. Admission and measurement rules are unchanged. Valued completion<1% of stress caps50 before confidence. Measured weakness has no unknown floor.

**AM17:** all routes excluded as immaterial plus applicable C/U rail gaps means unknown Exit, not fabricated exhaustion. The published cause set is the scorer's priced cause set, including relevant factor gaps. For no-route censuses, a current aggregate-reconciled verified-no-pools share `z` remains measured zero: `Exit = (1 − z) × unknownQuality(Exit, cause)`; only uncovered supply is unknown. Unsupported-chain dust cannot replace measured zero with whole-pillar U50.

Peg spread uses only non-positive signed peak deviations; exclude above-peg events rather than zero-filling them, so premiums neither create nor dilute downside spread. Other peg terms retain their treatment.

### Morpho lender collateral-book Backing (v10.19)

Books require supported adapter/schema, complete census/exact identity, no allowlist. Direct inheritance needs ≥99% live parent-token idle/1:1 claims, not merely parent-denominated positions. Current evidenced curated serial/basket claims may inherit without live rows, retaining composition gaps; inheritance/variant labels prove no wrapper. Complete books transmit weighted collateral/LLTV risk; absent books retain reserve/mechanism evidence, pricing only unknown factors by C/U. Preserve known reserves, identity/cycle checks and weighted/disclosed sub-1%-NAV oracle branches. Missing books grant no collateral/capacity.

Policy owns class qualities; strict `lender-collateral-classes-v1.json` owns token identities/reviewers/dates/sources. Compilation binds registry/build digests, never symbol aliases or renewed clocks ([admission](process/report-cards-appendix.md#exact-nav-partition-and-quality-source)).

For collateral quality `q`/LLTV fraction `l`, lender quality=`100 − l² × (100 − q)`. Allocation weights scale deployed parent Backing; idle retains it, blend≤parent. See [methodology history](#methodology-identity) for v10.19 calibration/acceptance.

### Report schema v9

Body 9 wraps publication 8 (`model: "v9"`); see the [report9 wire contract](api-reference.md#full-cards).

### Report schema v8

Archive-only via explicit historical dispatch: report8 (API v8)/publication v7 retain exact exit identity. Exclusions/partial weights, pipeline-gap/null-grade and NR remain distinct. Cards reconcile `ratingStatus`, `partialEvidence`, `confidenceDimensions`, `completeness.pipelineGapCount/pipelineGapIds`; supply/shared-book semantics stand. Optional provisional fields reconcile to the breakdown and aggregation weights when present; historical cards without them remain valid and are not retroactively relabelled.

Inherited-parent attribution must match referenced parents; mismatches fail `safeParse` at `cards`, never escaping.

Witness interning stays lossless and separates questions from repeated witnesses ([schema details](process/report-cards-appendix.md#report-schema-v8)).

Seed/verify both accepted private read models before strict readers; preparation/pre-compile uses them, never full-publication fallback. Invalid baselines block compilation; recovery reseeds then reverts strict readers ([rollout](process/report-cards-appendix.md#accepted-publication-read-models)). Public API/score-index schema 2 stay unchanged.

## Local authority exposure display

Rated cards may carry a display-only `localAuthorityExposure` summary beside Control: the weakest priced local quality and covered supply share, with up to three deployments by modeled loss and an omitted count. It is already priced in the score, not in the Control number, and is **not** a score-equivalent pillar. Older cards omit it; readers show no note rather than infer exposure from reason text. Only the stablecoin dossier shows it: a one-line note under the unchanged Control row, with the deployment list in that row's expanded details. The Safety Scores grid, mini radars and compare radar never show it.

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

## Dated public preview

The current `scores-latest` public dataset carries a versioned `_meta.displayProjection` object (also in the NDJSON preamble, never the CSV) with the accepted publication identity, `asOfSec`, `publishedAtSec`, `publicationHealth`, completeness and source generations. The generator appends `ratingStatus`, `safetyDisplay` (NR reasons/reason codes/partial evidence plus recorded grade hold or provisional labels), `dewsComputedAt`, `liquidityUpdatedAt`, `liquidityUnavailableReason` and `liquidityMethodologyVersion` to each row. Legacy envelopes emit the projection with `safety: null` and `safetyUnavailableReason: "legacy-source-metadata-unavailable"`; nothing is inferred from scores. The projection is version 2: every v1 field keeps its bytes and it adds `openEvidence` (`{ semantics: "open-question-v1", totals }` copied from the accepted publication) and `openEvidenceUnavailableReason` (`"safety-publication-unavailable"` or `"open-evidence-unavailable"`, null exactly when the counts are present). A publication without the block emits null counts with a named reason, never three zero counts.

`/safety-scores/` uses this export as a build-time, bounded preview: the 20 highest published numeric Safety Scores among active rated registry assets, with a code-unit ID tie-break, canonical name/symbol/link and recorded grade/score/labels. The visible caption is `Grades as of <publication UTC date>` (matching the `<time>` clock, not the dataset's calendar date) linked to the dated JSON artifact, followed by `Top 20 of <eligibleRatedCount> rated active stablecoins by Safety Score` (the shown count replaces 20 when fewer are eligible). Counts come from the full admitted census, never the 20 rendered rows.

A successful live publication replaces the preview; a newer preview is retained when the live accepted generation is older and shares the same methodology identity. A changed methodology identity takes the live publication. Initial read failure or schema rejection retains the preview with the existing error/retry notice until the calendar retention boundary (snapshot UTC midnight plus `PUBLIC_DATASET_MAX_AGE_DAYS + 1` days). A successful empty publication removes it. The preview is display props only: it never enters TanStack query caches, localStorage or IndexedDB, and the client imports projection types rather than the dataset.

## API

`GET /api/report-cards/v9` is the full live Safety Score API. `GET /api/dependency-graph/v1` exposes a free, no-key graph projection of the same accepted publication, not another scoring authority.

Coalesce generation-bound reads; verify integrity/live health before `200`. Missing/invalid evidence returns reason-bearing `503 no-store`; valid health identity/time mismatches serve held accepted bytes. Never rescore or fall back to V8; retired unversioned/preview routes return `404`.

`X-Safety-Score-Status` is `current`, or `held` for last accepted ratings/clock served `no-store`. Non-held publications older than 7200s (one missed publication) or future at any skew instead emit status `stale`, `X-Data-Freshness: stale`, `X-Data-Freshness-Reason` (`safety-score-publication-age`/`future-timestamp`), `Warning: 110` and `no-store`; body `publicationHealth`/`publicationStatus` remain producer health. Every response includes `X-Safety-Score-Freshness-Budget`/`X-Safety-Score-Generation`. Current shared/browser TTL plus `stale-while-revalidate` cannot exceed remaining budget. This covers `/api/report-cards/v9`, site projections, `/api/safety-grades` and `/api/dependency-graph/v1`.

[Materialization admission and rollout](https://github.com/TokenBrice/pharos-watch/blob/main/docs/process/worker-infrastructure-appendix.md#v9-public-response-materialization) owns wire resolution, live-health re-admission, atomic storage, repair, retirement and qualification.

Site-only [compact list/detail representations](https://github.com/TokenBrice/pharos-watch/blob/main/docs/process/report-cards-appendix.md#compact-website-representations) preserve full-report/free-grades contracts and admit card rows before publication.

Endpoint freshness uses 2x `compute-safety-score-v9` (7200 s), matching consumer fail-close. `worker/src/lib/safety-score-v9/consumer-freshness.ts` rejects non-finite or future `updatedAt` (and non-finite `now`); no clock-skew allowance or alternate consumer budget is introduced.

The response carries V9 identity/source digests, methodology/policy identity, active-set completeness, current/held health, native three-pillar cards with nullable excluded diagnostics and status-aware breakdowns, per-card `backingFromLiveReserves`, the serial/basket dependency graph and accepted `updatedAt`.

`/api/report-cards/v9` wraps publication 8 as body 9. Reject public v6 rather than infer it current. `expectedCount = ratedCount + notRatedCount + pipelineGapCount`; NR/pipeline IDs are disjoint and sorted. Index 2/free-grades 1 retain compact status/partial metadata; graph/scenario 2 distinguish technical parent/model nulls from NR. Pillar freshness stays categorical, opt-in operands follow the compact-representation contract, and scores/legacy wire are unchanged. [Report schema v9](#report-schema-v9) owns the current wire; archive-only [v8](#report-schema-v8) owns cause-bearing fields and typed route identity.

See the [public API reference](https://pharos.watch/api/) for the wire contract.

## Consumers

V9 serves Safety Scores, home/detail/compare, portfolio/dependency map, yield, digest/flight-to-quality, Telegram, OG, datasets, status/grade history.

Graph/DDR/digest-detail/ops read the accepted cohort; grade/identity readers use the index; daily datasets decode full cards. Projections bind accepted identity/health; missing/invalid/mismatched cohorts fail closed with machine-readable reasons without full-card decoding.

Portfolio dependency exposure is unavailable, not $0, when a basket link's share is unknown. Observed zero shares stay $0, and unknown-share links still count as routes.

Rated read-only top-driver `reason`: binding cap, else weakest pillar; Control prefers recognized score-matching binding mint posture, otherwise pillar/score. Nonbinding/score-mismatched postures cannot supply it. Badges/reason codes may be empty. Scores/evidence/schema/withholding stay unchanged; reasons explain current constraints, not history/misconduct.

Without PSI, stability-index OG is unavailable, never `0`/`MELTDOWN`. Coverage: `expectedCount` assets assessed, rated/NR/pipeline-gap reconciled; only `ratedCount` means scored. Holds replace headlines.

Current-only reads reject held/>7200 s ratings. Held-data displays require notice; yield needs accepted identity within its stale-coherent window. No V8 cache/scoring fallback.

Score-map/yield retain null denominators/ratios, empty map, reason and null identity/time when unavailable, never `0%`/`100%` ([yield wire](./yield-intelligence.md#public-wire-contract)). Selector creation recomputes live V9 (`functions/lib/selector-canonical-snapshot.ts`); `503`: source/schema failure, not policy hold. Signed snapshots retain historical reads.

## History

Asset-local build/admission/schema/evaluation/public-card failures yield technical `pipeline-gap` with null score/grade, never issuer NR. Continue unaffected assets only with ≥90% unaffected active assets, counting quarantines and their affected dependents, and every other gate passing; unattributable graph/aggregate/evaluator/identity/global failures hold the cohort.

Since v10.35 an expired, previously mature contributing [measured DEX route](process/report-cards-appendix.md#canonical-publication) quarantines only its asset, keeping an expiry witness. Recovery needs fresh same-route evidence, not a new liquidity timestamp or discovery-priority hint. Pre-9.07 captures are read-only compatibility, never a legacy publisher/live fallback; reproduction uses recorded registry/policy/build, while current-tree replay is a separate comparison ([compatibility](process/report-cards-appendix.md#historical-capture-compatibility)).

Since v10.38 the Exit producer admits an ERC-4626 request above issued shares only as `exact-lower-bound` (never `exact-complete`), captures reference-price legs with the policy's 7,200 s evaluation-lag margin inside the unchanged 18,000 s window, and ages chain-supply evidence against the per-source `chainSupplyMaxAgeBySource` ceiling (5,400 s for the provider and deployment-census sources; otherwise the default window plus carry, which a source's declared window may only tighten). The deployment supply census admits a pinned, generation-bound upper bound below the 1% threshold, which both the documentation class and Control's binding read, and requires a reviewed escrow rule above it; the 1,800 s capture window governs packet pins and prices while the declared 5,400 s ceiling governs serving and admission. Incident reviews are keyed by their authored stable identity; provider/issuer-surface rows are parsed but close nothing, and certificate-based lane closure is not active in v10.38 ([detail](process/report-cards-appendix.md#v1038-evidence-method-admission)).

Since v10.40 an admitted execution certificate is priced by the share of the current stress ask its scored point measured, not by the producer's flat `medium` label: `semantic.exit.certificateConfidenceByCertification` scales credit from 0.85 at no coverage to 1.00 at full coverage, so a full measurement cannot score below the same-rail model it confirms while a shrunken ask or a clamped receipt keeps the discount for the fraction it did not measure, and a low or unknown label is never lifted. Non-certificate mappings, admission and supersession are unchanged. On capture 20261030T1033Z (clock 1793355466) 43 assets move up, 14 grades flip and `openEvidence` is byte-identical.

`snapshot-safety-grade-history` appends identified V9 organic transitions only when not held; partial publication suppresses quarantined assets/dependents and their recovery. V2 rows record model, methodology, policy, evaluation-build, base-input, publication generation and transition kind. Compare publication identities, never capture `v9-input`: producer-only changes create no boundary; build rotation writes one `methodology-boundary-baseline` per asset, not organic transitions.

`GET /api/safety-score-history` remains the per-asset timeline; V8/activation boundaries are archive-only. Grade History combines it with `/api/safety-score-history-v2`, collapses consecutive same-grade baselines and labels changed-grade boundaries methodology baselines, retaining current grade/first-seen date without comparing incompatible identities.

