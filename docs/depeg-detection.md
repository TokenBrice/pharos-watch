# Depeg Detection Pipeline

Two-stage depeg detection pipeline for stablecoins. Stage 1 runs every 15 minutes within `sync-stablecoins` and writes admitted, unsuppressed onsets to `depeg_pending`. Stage 2 runs immediately after; promotion requires at least 15 minutes beyond the full trigger threshold and the applicable source-trust rule.

> **Agent navigation** — Grep the heading you need: Methodology Versioning · Downstream: Depeg Duration Resolver · Thresholds & Constants · Database Schema · Build-time event archive · Cron Scheduling · Stage 1 -- Detection · Stage 2 -- Confirmation · Historical Backfill Validation · Event Lifecycle · Types · API · Peg Stability Metrics (`peg-stability.ts`) · Peg Score (`peg-score.ts`) · Edge Cases & Guardrails.

## Methodology Versioning

- **Current methodology version:** <!-- GENERATED-START: methodology-version-depeg-detection -->`v6.58`<!-- GENERATED-END: methodology-version-depeg-detection -->
- **Runtime/version source:** `shared/lib/methodology-versions/registry.ts`
- **Public changelog route:** `/methodology/depeg-changelog/`
- **Structured changelog:** `shared/data/methodology-changelogs/depeg-dews/`

DEWS v6.45 admits independently proven isolated canonical-leg outflows only when they raise stress; v6.46 caps a lone Mento Broker observation at WATCH unless independent qualifying evidence releases the cap. See [DEWS](./dews.md) for both evidence rules. Shared Depeg/DEWS v6.55 registered `NZD` (`peggedNZD`) in `REFERENCE_CLOSURE_HOLD_BANDS_BPS` and `CALIBRATED_FIXING_BANDS`. Shared Depeg/DEWS v6.56 adds the 30-day long-running open-incident horizon split (`DEPEG_LONG_RUNNING_AGE_DAYS = 30`), a Day-30-seeded upward-ratcheting two-sample re-escalation rule (`0323_depeg_event_peak_escalation.sql`, `DEPEG_REESCALATION_*`), and two-tier materiality ranking (`shared/lib/active-depegs.ts`) without changing PegScore, Safety Score V10, PSI, DEWS, or DDR/DDRR core scoring.

Pending release obligations are tracked by [DEWS](./dews.md#methodology-versioning).

DEWS supply/liquidity composites renormalize their existing internal weights over readable legs and persist explicit component coverage; missing component deltas remain null. This changes prospective DEWS scores and potentially bands, not detector onset, confirmation, recovery or PegScore thresholds. The [DEWS component contracts](./dews.md#sub-signal-details) govern full, partial, unavailable and legacy-unknown coverage; retained historical rows keep their original bytes and methodology identity.

## Downstream: Depeg Duration Resolver

Confirmed events feed DDR's canonical incidents and immutable public forecasts or no-calls; DDR does not detect depegs independently or issue retroactive forecasts after a pre-lock resolution. See the [live forecast and grading board](https://pharos.watch/depeg/). The forecast-lock contract is owned by `docs/depeg-resolver.md`, not this detector.

## Thresholds & Constants
| Constant | Value | Purpose |
|----------|-------|---------|
| `DEPEG_THRESHOLD_BPS` | <!-- GENERATED-START: depeg-threshold-usd -->100 (1%)<!-- GENERATED-END: depeg-threshold-usd --> | USD peg deviation threshold |
| `DEPEG_THRESHOLD_BPS_NON_USD` | <!-- GENERATED-START: depeg-threshold-non-usd -->150 (1.5%)<!-- GENERATED-END: depeg-threshold-non-usd --> | Non-USD peg threshold (accounts for FX noise + thin liquidity) |
| `DEPEG_CONFIRMATION_SUPPLY_THRESHOLD` | <!-- GENERATED-START: depeg-confirmation-supply -->$1,000,000,000<!-- GENERATED-END: depeg-confirmation-supply --> | Adds the large-cap source-confirmation reason flag |
| `DEPEG_CONFIRMATION_SOFT_SUPPLY_THRESHOLD` | $750,000,000 | Adds the large-cap flag when source depth is below 2 or severity is at least 2x the peg threshold |
| `DEPEG_CONFIRMATION_WEAK_SEVERE_SUPPLY_THRESHOLD` | $500,000,000 | Adds the large-cap flag when both source depth is below 2 and severity is at least 2x the peg threshold |
| `DEPEG_PENDING_MIN_AGE_SEC` | <!-- GENERATED-START: depeg-pending-min-age -->900 (15 min)<!-- GENERATED-END: depeg-pending-min-age --> | Minimum continuous onset or recovery confirmation window |
| `DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC` | 1200 (20 min) | Largest gap between consecutive qualifying onset/recovery observations or trusted off-peg duration endpoints. Wider than ordinary 900-second producer jitter, below two intervals; a missed run starts a new observation interval |
| `DEPEG_PENDING_EXPIRY_SEC` | <!-- GENERATED-START: depeg-pending-expiry -->2700 (45 min)<!-- GENERATED-END: depeg-pending-expiry --> | Base time before a pending record can expire |
| `DEPEG_PENDING_EXTENDED_EXPIRY_SEC` | 8100 (135 min) | Extended limit when primary evidence still points same-direction or confirmation sources are unavailable/circuit-open |
| `DEPEG_PENDING_SEVERE_EXPIRY_SEC` | 10800 (180 min) | Severe/extreme-move limit; expiry records `unconfirmed-severe` |
| `DEPEG_SECONDARY_THRESHOLD_RATIO` | <!-- GENERATED-START: depeg-secondary-threshold-ratio -->1.0<!-- GENERATED-END: depeg-secondary-threshold-ratio --> | Secondary source agreement uses the full trigger threshold |
| `DEPEG_RECOVERY_THRESHOLD_RATIO` | 0.5 | Recovery must reach half the trigger threshold before its confirmation window starts |
| `DEPEG_PRIMARY_PRICE_MAX_AGE_SEC` | <!-- GENERATED-START: depeg-primary-price-max-age -->1800 (30 min)<!-- GENERATED-END: depeg-primary-price-max-age --> | Primary prices older than this are marked `confirm_required` |
| `DEPEG_EXTREME_MOVE_BPS` | <!-- GENERATED-START: depeg-extreme-move -->5000 (50%)<!-- GENERATED-END: depeg-extreme-move --> | Adds the severe/extreme pending reason and extended expiry policy |
| `DEX_FRESHNESS_SEC` | <!-- GENERATED-START: depeg-dex-freshness -->4500 (75 min)<!-- GENERATED-END: depeg-dex-freshness --> | Hourly DEX prices older than this are ignored |
| `DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD` | <!-- GENERATED-START: depeg-dex-min-tvl -->1,000,000<!-- GENERATED-END: depeg-dex-min-tvl --> | Minimum aggregate DEX source TVL required before depeg logic trusts a DEX row |
| `DEPEG_DEX_PROTOCOL_CORROBORATION_MIN` | 2 protocol groups | Aggregate DEX corroboration minimum; per-source evidence uses `DEX_PROTOCOL_SOURCE_FRESHNESS_SEC` (35 min), distinct from the aggregate row's 75 min |
| `POOL_CHALLENGE_CONFIRM_MIN` | 2 protocol/source-family groups | Challenger group minimum; pools require `POOL_CHALLENGE_MIN_TVL` ($100k). Confirming/diverging groups must match or outnumber opposing/recovery groups, except the recovery high-TVL veto below |
| `POOL_CHALLENGE_HIGH_TVL_USD` | $5,000,000 | Pending confirmation: replaces the second-group minimum but not the opposing vote. Live recovery: a single qualifying pool vetoes directly |
| `DEPEG_LONG_RUNNING_AGE_DAYS` | 30 days | Canonical onset age past which an open confirmed incident classifies as long-running unless re-escalated |
| `DEPEG_REESCALATION_MIN_STEP_BPS` / `MAX_STEP_BPS` / `STEP_RATIO` | 250 / 1,500 bps / 25% | Upward-ratcheting step above the Day-30-seeded anchor required to re-escalate a `>30d` open incident |
| `DEPEG_REESCALATION_CONFIRM_MIN_AGE_SEC` | 900 (15 min) | Minimum separation between two consecutive trusted primary/native qualifying observations to confirm re-escalation |
| `DEPEG_REESCALATION_WINDOW_DAYS` | 7 days | Window during which a confirmed re-escalated `>30d` incident remains promoted in the Recent bucket (`Escalating`) |

`getDepegThresholdBps(pegType)` returns 100 for `peggedUSD`, 150 for all other peg types.

`MIN_PEER_MEDIAN_CONTRIBUTORS` in `shared/lib/peg-reference-trust.ts` is the single quorum authority for peer-median references: non-USD fiat medians and commodity medians both require at least 3 live contributors, while a direct spot/FX reference does not need peers.

Runtime-neutral deviation and directional-signal primitives live in `shared/lib/depeg-signals.ts`. The shared calculation normalizes floating-point error at integer-bps boundaries before threshold comparisons and retains distinct fractional-bps moves.

### Reference admission and calibration

FX and bullion detection pairs the token quote with a source-clocked, same-unit reference. The [shared admission contract](./architecture.md#adr-45) covers the session, the first eligible observation after reopening, quote/reference pairing and repricing. The inclusive severe boundary allows one floating-point unit at par, expressed in basis points. A closed or unrefreshed reference can leave the published market price visible in USD while its current peg comparison is unavailable. The reader labels are **Reference market closed** and **Reference not yet updated**.

Clocked current comparisons require a token quote no more than six hours old. A quote beyond that budget supplies no current peg deviation, even when it pairs with a fresh reference.

During a closure, a fresh traded median needs at least three provenance-distinct traded contributors observed inside that closure. The lower-confidence peer-relative path excludes the subject, needs three independent same-peg peers and corroborates the break in a traded native pair or independent 24/7 pool. The detector and confirmer withhold peer-relative pending rows, events and peak updates while the supported rollback Worker interprets them as benchmark moves. A raw move of at least 2,500 bps in either direction can open or sustain a candidate against a direct reference that was within budget at the close. The token quote must fall inside the closure and within its freshness budget. A shifted independent cohort blocks that benchmark comparison. For gold and silver, a fresh same-metal median can also establish a severe move when at least three distinct assets have upstream quotes inside the closure. At a lower calibrated band, the closing benchmark requires a fresh, independent same-direction native trade and a near-benchmark cohort. A dated silver entitlement is required to compare XAGm on its actual ounces per token. The entitlement must match the timestamp of the token quote used in the comparison.

The Tape projector repairs a rollback opening in place using its recorded onset. A peer onset gets a peer label, and a benchmark onset keeps its own magnitude when the peak used a peer median. Scheduled reconciliation covers the trailing 90 days. For older openings, run the `depeg.opened` class over the affected dates with [backfill-tape](./runbooks/one-shot-backfills.md#backfill-tape).

The pending-confirmation canary accepts a closure hold only when the receipt matches both the candidate revision and the exact decision timestamp. Clearing the hold also clears its receipt.

A severe candidate still observed just before the close can confirm during the closure. If the independent evidence is missing, expiry resumes at reopening. A missing current comparison leaves the candidate visible to the coverage canary.

During a Worker version transition, provider-status-only FX metadata and a missing FX state use the legacy numeric reference path. A carried rate retains its legacy provenance across mixed publications. Incumbent selection and cached-rate carry use the fixing cutoff for that peg even when a sibling peg refreshes. Legacy detection uses the fixed UTC weekend closure from Friday 21:00 to Sunday 23:00. Legacy ECB fixings use the 16:00 UTC freshness cutoff. Clocked ECB fixings use the Berlin release clock. The first OXR snapshot replacing a legacy rate, and rereads of that snapshot, can use the legacy path when repricing is the only missing check. The next distinct observation uses the new admission rules. An explicitly empty observations map withholds the comparison, as does rejected evidence for the peg. Detection allows up to three hours between an OXR reference and a quote, covering its accepted snapshot age and one hourly poll.

With source-clocked evidence, at least three eligible same-metal assets can supply the gold or silver median. During a closure, only upstream market quotes from within the closure and freshness budget enter that median. When the FX producer has a qualifying median, at least three distinct local assets must have quotes strictly newer than its oldest constituent to replace it. Only those newer quotes supply the replacement value and receipts. Otherwise the producer supplies both. Below quorum, the detector evaluates an available direct closing observation under the same severity and independent-cohort rules.

Detection keeps the legacy bullion median when that metal's carried rate has a verified legacy marker and lacks its own source observation. For fiat medians in a source-clocked generation, detection and current peg display use the same eligible set for the median, contributor count, and oldest clock. Each contributor is a distinct asset with an upstream quote within the session and freshness budget.

If a newer FX fixing or bullion median fails the closure checks, detection can use an eligible direct sample retained in the verified FX state. An omitted peg can also use its retained close when the current verified FX generation carries that peg's eligibility. A rejected replacement does not grant eligibility. The comparison uses the retained sample's USD value and original source clock.

If a legacy pending loses its primary quote in the same open legacy session, an independent secondary quote can confirm it against a matching usable legacy reference or the stored benchmark when the refresh supplies no reference evidence. Modern refusal still withholds confirmation. The D1 promotion guard aborts an incompatible legacy write of a clocked closure pending and preserves the pending for a compatible writer.

With only a dated daily FX fixing, current peg display remains stale. Detection may use the fixing in an open session when both clocks meet the admission and repricing gates and the absolute move exceeds the applicable fixing-age band. Smaller moves remain `stale-reference`. Frankfurter age counts TARGET business days, and the dated secondary feed counts weekdays. The third age column applies from three days onward.

The release calibration uses the nearest-rank 99.5th percentile of absolute USD-per-unit changes over one, two and three business-day intervals in the ten years before April 1, 2024. With fewer than 2,000 moves at a horizon, use 500 bps. Closure calibration uses the maximum absolute close-to-reopen log move plus 25%, estimated from the last fixing before and first after the closure. This includes trading on either side of the closure. The ordinary and extended samples have two and three to four intervening calendar days respectively, including Saturday and Sunday. Fewer than 300 closures in a class yields 2,500 bps. Both calibrations round up to 25 bps. The closure series starts in January 1999 and ends before April 1, 2024. Bullion calibration removes weekend carries and comparisons across the 2015 source break. Secondary FX history starts on March 2, 2024, so those currencies use the fallback. [Frankfurter](https://frankfurter.dev/v1/) · [Gold and silver history](https://www.goldprice.com/gold-price-history) · [Secondary FX history](https://registry.npmjs.org/@fawazahmed0%2Fcurrency-api)

The closure columns apply to corroborated benchmark moves with an independent cohort. Sub-day closures and missing cohorts use 2,500 bps. The daily table is active for supported FX currencies. The bullion daily values are calibration context.

| Calibration unit | 1 day (bps) | 2 days | 3+ days | Weekend | Extended |
| --- | ---: | ---: | ---: | ---: | ---: |
| EUR | 200 | 275 | 300 | 300 | 2,500 |
| GBP | 250 | 325 | 450 | 500 | 2,500 |
| CHF | 200 | 275 | 350 | 425 | 2,500 |
| BRL | 375 | 500 | 600 | 1850 | 2,500 |
| JPY | 250 | 325 | 375 | 550 | 2,500 |
| KRW | 225 | 275 | 300 | 750 | 2,500 |
| IDR | 200 | 300 | 375 | 1100 | 2,500 |
| INR | 125 | 175 | 200 | 400 | 2,500 |
| MYR | 200 | 275 | 300 | 325 | 2,500 |
| SGD | 125 | 175 | 200 | 275 | 2,500 |
| HKD | 25 | 50 | 50 | 200 | 2,500 |
| TRY | 550 | 825 | 1150 | 1650 | 2,500 |
| AUD | 250 | 325 | 375 | 525 | 2,500 |
| ZAR | 350 | 500 | 550 | 675 | 2,500 |
| CAD | 175 | 250 | 275 | 425 | 2,500 |
| CNY | 125 | 175 | 175 | 225 | 2,500 |
| PHP | 125 | 150 | 200 | 800 | 2,500 |
| MXN | 325 | 450 | 500 | 975 | 2,500 |
| CZK | 225 | 325 | 350 | 400 | 2,500 |
| PLN | 225 | 350 | 425 | 600 | 2,500 |
| Gold | 325 | 475 | 550 | 1200 | 2,500 |
| Silver | 700 | 1025 | 1225 | 2450 | 2,500 |
| Other supported FX units | 500 | 500 | 500 | 2500 | 2,500 |

## Database Schema

Exact DDL and indexes are owned by `worker/migrations/0000_baseline.sql` plus the
active tail in `worker/migrations/MANIFEST.md`. The baseline alone is not the
cumulative schema: `0232_depeg_recovery_continuity.sql` adds recovery continuity,
`0252_depeg_audit_verdict_vocabulary.sql` guards audit verdicts,
`0255_depeg_trusted_price_coverage.sql` adds nullable trusted-price coverage, and
`0323_depeg_event_peak_escalation.sql` adds nullable `peak_escalated_at`,
`peak_escalation_anchor_bps`, `peak_escalation_candidate_at`, and `peak_escalation_candidate_seen_at` columns for
Day-30-seeded upward-ratcheting two-sample re-escalation tracking on long-running open events.
The semantics below distinguish recovery, unobserved time and immutable audit evidence.

### depeg_events

Confirmed live/backfill rows retain coin/peg/direction identity, onset and nullable
closure, observed peak prices, confirmation provenance and trusted-price coverage.
Uniqueness is `(stablecoin_id, started_at, source)`; open rows have `ended_at = NULL`.

`close_reason` distinguishes real recovery from non-recovery terminal boundaries:

- `recovered-primary`, `recovered-dex`, `recovered-native`
- `coverage-lost-supply` (only an observed sub-floor supply, including an explicit zero; unavailable supply never closes a row)
- `superseded-direction`
- `orphan-tracking-removed`

Live non-USD events opened from native-fiat quotes retain native prices and `peg_reference = 1`. Admission matches asset/currency identities; peaks exclude mismatched domains. Native confirmers of USD-origin pending rows use the admitted USD reference. Native-domain open rows require an admitted native quote to progress; USD prices never become their recovery price.

Pending onset survives only matching direction, continuity, peg identity and quote domain. USD-primary / `native-origin` transitions or peg changes reset onset, reference and prices; other reason-flag changes preserve continuity. Historical provenance remains authoritative; unknown conversions are not invented.

Current deviation and reference are independent of circulating supply: any observed non-NAV price with an authoritative reference can populate `currentDeviationBps` and `pegReference`, including below $1M or when supply is unknown. The supply floor remains an event-creation/coverage gate, not a price-observation gate. Nominal par and unavailable prices remain unobserved; `depegEventCoverageLimited` still warns that no new events are created for a positive sub-floor supply.

### depeg_pending

At most one candidate per coin holds its first/last/peak observations, quote
reference, direction, peg identity and trust/severity reasons until a terminal
confirmation decision. Continuity rules below govern whether onset is preserved.

### depeg_pending_outcomes (migration 0126)

The append-only outcome schema is in the baseline; `outcome` distinguishes
`promoted`, `rejected`, `expired`, `recovered`, `superseded` and `unconfirmed-severe`.

Append-only terminal ledger for every candidate that leaves `depeg_pending`. Each row is written in the same batch that deletes the pending row (`buildOutcomeAndDeleteStmts()` in `worker/src/cron/pending-depeg-confirmation.ts`), so the candidate transition and its evidence land together. Because `depeg_pending` holds at most one row per coin and is deleted on every terminal path, this is the only record of candidates that never became events -- rejections, expiries, recoveries, and rows superseded by an already-open event leave no trace in `depeg_events`.

The four source columns record which confirmation families agreed, opposed, were unavailable, or were skipped behind an open circuit at decision time, which is what distinguishes "no evidence was reachable" from "evidence disagreed" when auditing a REJECT or an `unconfirmed-severe` expiry after the fact.

DDR depends on the `outcome = 'promoted'` rows: `loadPendingPromotionConfirmationTimes()` in `worker/src/cron/depeg-resolver/incident-state.ts` matches them to events on `(stablecoin_id, peg_type, direction, first_seen_at = started_at)` and uses the latest `outcome_at` as the incident `confirmedAt`. That timestamp decides `late_confirmation` lock timing, so deleting or rewriting promoted rows changes DDR lock verdicts for historical incidents.

Retention policy: never pruned. `prune-cron-history` does not touch this table, and no other job deletes from it; only growth telemetry reads it (`worker/src/lib/status/d1-usage.ts`). Growth is bounded by candidate volume, not by a cutoff.

### depeg_event_provenance (migration 0127)

Side-table provenance for depeg rows. Legacy `depeg_events` rows remain valid when no provenance row exists. The public API reads through `depeg_events_with_provenance`, which projects a compact `provenance` object without exposing raw diagnostics.

Stored fields include source kind, replay run ID/version, source price providers, quote mode, peg-reference source, supply source, confirmation policy, confirmation point count, market diagnostics, policy adjustments, confidence tier, audit verdict, and created/updated timestamps.

Audit vocabulary is owned by `shared/types/depeg-audit.ts`: `confirmed`, `disputed`, `false_positive`, `no_data`, and `repaired`. Archived event parsing rejects unknown verdicts rather than coercing them to null. Migration `0252_depeg_audit_verdict_vocabulary.sql` rejects unknown insert/update values while preserving stored archives. Null continues to mean legacy unaudited evidence.

### depeg_backfill_runs (migration 0128)

Backfill replay manifest table. Each mutating replay records stablecoin/window, source type, expected event count, expected fingerprint, removed/added/inserted counts, status (`started`, `complete`, or `incomplete`), timestamps, and any failure message. Chunked insert failures mark the run `incomplete` so operators can repair or re-run instead of assuming the historical slice is complete.

Retention policy: `depeg_backfill_runs` is a backfill audit archive kept forever. Replays are rare, and the run manifest is the durable evidence for repair provenance, expected fingerprints, and incomplete-run follow-up.

### Non-USD threshold cleanup (folded into baseline)

Historical non-USD rows below the current 150 bps threshold are excluded by the
baseline cleanup; threshold history belongs to the structured methodology changelog.

### Build-time event archive

The Pages build snapshot is maintained by `scripts/maintenance/sync-depeg-events.ts` under `data/depeg-events/`. `index.json` is the compact route-bearing projection used to enumerate permanent `/depeg/<event>/` pages and build the command-palette payload. It carries each route's slug, coin identity, direction, start date, and peak severity. The full event ledger is partitioned into UTC-year shards (`YYYY.json`); feeds, public dataset generation, and page hydration read those shards. A refresh therefore changes the index and only the affected year shard instead of rewriting one monolithic archive file.

Synchronization follows the API cursor until exhaustion, not a display-sized page cap. An outstanding cursor at the 1,000-page safety ceiling, an empty continuation page, or a unique-event count that disagrees with the initial API total is a `SnapshotIntegrityError` before any output write. Fetch-failure fallback cannot turn these integrity failures into successful refreshes; the Pages release wrapper retains the committed directory on producer failure. Published static-page preservation checks remain in force.

Every incoming API page is admitted through the shared depeg response schema, including event chronology, before accumulation. Legacy responses may omit `total` and optional provenance; supplied totals must be nonnegative safe integers and remain consistent across pages, and supplied continuation cursors must be nonempty strings or null. The complete stored projection must pass `DepegEventStoredSnapshotSchema` before preservation checks or writes. Invalid JSON, schema failures and chronology failures are integrity errors, so fetch fallback cannot renew capture metadata or overwrite archive bytes with rejected rows.

Slug assignment first reserves every prior ledger slug by durable event ID. Existing IDs reuse their exact URLs; only newcomers receive collision suffixes, including when duplicate symbols belong to different coins. A missing ID's slug stays reserved during assignment, so a newcomer cannot mask a true deletion. Reusing an ID for a different stablecoin fails closed. An identity-rewriting backfill requires a reviewed old-ID/slug → surviving-ID/slug mapping, archive shrink approval and direct redirects; symbols are not an identity migration.

Every successful sync also writes `data/depeg-events/metadata/capture.json`: the SHA-256 identity of the exact yearly shard bytes, event count, API total when supplied, source URL, methodology label, and observation start/end clocks. `eventCount` covers every retained record; `apiTotal` is the API's pageable row count, including reviewed disputes. Capture metadata lives in a subdirectory so top-level JSON archive enumeration sees only the route index and event shards; synchronization removes the superseded top-level `capture.json`. Keeping metadata within the archive directory also preserves the Pages release wrapper's directory-level copy and replacement; the release archive allowlist admits only this metadata directory and its capture file, not arbitrary metadata contents. Dataset generation validates this identity before using the ledger; legacy shards without a capture must be synchronized first. The ledger is a current capture, not a reconstruction of event peaks or recoveries at an older market snapshot's clock. Dated `depeg-history` exports therefore publish explicitly retrospective windowed history with this capture's provenance, not as-of market observations; the [public API guide](https://pharos.watch/api/) explains the surface split.

## Cron Scheduling

Detection runs as part of the `*/15 * * * *` sync cycle. After `syncStablecoins()` enriches prices, it calls:

1. `detectDepegEvents(db, peggedAssets, fxFallbackRates, signal, coingeckoApiKey, nativePegSession)` -- detection
2. `confirmPendingDepegs(db, peggedAssets, fxFallbackRates, signal, coingeckoApiKey, binanceSession, nativePegSession)` -- confirmation

Both calls are in `worker/src/cron/sync-stablecoins/post-enrichment.ts` (invoked from the parent `sync-stablecoins.ts` orchestrator). Errors from either are captured in the sync metadata as a `depegErrors` array and degrade, rather than abort, the parent cron.

Each stage returns `completed` or a typed `held` result. Reaching `MAX_OPEN_DEPEG_EVENTS` in a bounded open-event read returns `held` with `depeg-open-event-limit-reached`; initial detection and confirmation holds leave event/pending mutations untouched, while the later orphan-cleanup guard skips only its own mutations. A hold is not a thrown error and does not increment `depegErrorCount`. On both main and fallback publication paths, it sets sync `status = "degraded"`, `metadata.reason` and `depegHeldReason` to that reason, and `depegPipelineSucceeded` / `capabilities.depegPipeline` to false. Stablecoin cache publication remains independent. DDR therefore defers forecast locks with `depeg-pipeline-unhealthy`, rather than treating a fulfilled capacity-limited stage as healthy.

Detection also records an observation census of PSI-eligible, non-NAV assets, including historical members that supply a row: each is counted as observed, unavailable or below the supply floor, and every gap carries a reason (`native-quote-implausible` for an open native-domain row whose native quote was withheld). Unavailable supply is not observed zero, and a completed run does not prove complete coverage. The census is diagnostic and does not change detection, confirmation or event writes; the [status canary cohort](./status-dashboard.md#cron-health-model) reads it back from `cron_runs`, and the `depegs` dataset clock is the newest completed-census run.

The operator-only `depeg-open-coverage` canary counts an open event as blind only after 75 minutes without a trusted price observation, derived from `DEX_FRESHNESS_SEC` to cover the hourly refresh plus margin; public coverage keeps its 1,200-second continuity budget. It grades unreviewed blindness. `DEPEG_BLIND_EVENT_REVIEWS` in `worker/src/lib/canary-checks-depeg.ts` records `ops` reviews naming one positive-integer `eventId` and its exact `stablecoinId` for structurally single-source coins without an authoritative primary or an independent DEX aggregate above the unchanged $1M/two-family floor. Reviews require HTTPS evidence, a nonfuture `reviewedAt` and a later `expiresAt` within 14 days; malformed, duplicate, future or expired reviews acknowledge nothing. Raw blind counts, events and coverage clocks remain intact. Separately, a blind open event with a fresh detector receipt for admitted DEX evidence outside its recovery band and below its full trigger according to the detector's unmodified raw signal and comparison helpers is an automatic unresolved operator notice, counted separately from acknowledged and actionable blind events. The receipt binds the exact event and detector generation, aggregate price and clocks, and per-family contributor prices, depth and observation clocks; admission reuses the existing TVL, independent-family and freshness budgets; receipt samples are bounded by count and bytes before metadata assembly, report shown/omitted counts, and are discarded before any coverage-detail compaction, with omitted events remaining actionable. Missing, stale, future, truncated or unreadable evidence restores ordinary actionable blindness on the next evaluation. Entry sends an informational operator notice through the freshness watchdog's existing delivery mechanism with separate informational entry memory and delivery clock using the same 30-minute duration, including the aggregate, recovery band, trigger and all contributor values. Informational sends never consume or extend the error cooldown. Same-run error delivery takes priority; notice delivery waits for a quiet run and complete text, repeats only after exit and re-entry past the cooldown, and never calls an exit recovery. Valid reviews remain acknowledged; neither class changes trusted duration, recovery, public depeg output or score inputs, and independent failures remain actionable. A new blind event for the same coin re-alerts and needs its own review. Detection, DDR, DEWS, closure and alerts are unchanged. The [operator canary contract](./status-dashboard.md#cron-error-escalation) owns standing notices and 48-hour renewal reminders.

The API layer reuses this event dataset through `worker/src/lib/peg-analytics.ts` (`derivePegAnalyticsSnapshot()`), which builds shared `eventsByCoin` and `pegDataById` maps. The charts lane writes the producer-published `peg-analytics` D1 cache row every 30 minutes: the hourly, DEX-publication-triggered `prepare-safety-score-v9-input` job at `:16` (also the only writer of the exact V9 peg-provenance seed) and the same job's standalone refresh when it skips preparation at `:46`. `/api/peg-summary` accepts the analytics row for up to 30 minutes (one producer interval) and falls back to direct compute on a miss or stale/invalid row. Future-clock recovery deletes a row only while its inspected value and `updated_at` still match; concurrent replacements survive, and writers retry publication under normal timestamp ordering. Its day-scoped event counters are re-bucketed against the request's UTC day from a bounded two-day `depeg_events` read when the row was published on an earlier UTC day, so midnight never relabels a previous day's counts, forces a full recompute, or turns a projection read failure into an outage. `GET /api/report-cards/v9` reads only the separately accepted canonical V9 publication.

A DEX cross-check uses its own observation clock and reference admission. A held primary quote can coexist with an admitted DEX comparison across reopening. For a USD NAV token, the DEX comparison uses the usable NAV denominator.

Current quote-adjacent displays use the optional `currentPeg` block on `/api/stablecoins`, with that same row's price observation and source-agreement lists. It is derived by the shared current-observation helper used below; null price/reference remains null deviation, and the new block has no DEX agreement without an admitted quote. Peg-summary retains its independent live fields and historical analytics; legacy list rows without `currentPeg` retain the previous reader fallback.

Current peg-summary observations are rederived from the latest stablecoins snapshot through `deriveCurrentPegObservationMap`, not from a numeric price plus an older cached analytics reference. The optional nullable `price` is the same admitted live observation used for current deviation and provenance, including retained-history responses. It is null when that observation is unavailable or nominal even if the raw asset has a positive price; an observed NAV quote may remain present with null deviation. Invalid or nonpositive quotes emit null, and legacy responses may omit the field. A snapshot `pegType` that disagrees with the curated registry peg currency withholds the reference (`pegReferenceUnavailable: true`) instead of anchoring a cross-unit deviation; the admitted unit (registry first, snapshot label only where the registry has no canonical type) also drives the DEX cross-check, the at-peg threshold and the published per-coin `pegType`, so a cached generation's older `pegType` never overrides it. Nominal or missing primary observations publish `currentPriceUnavailable: true` and `currentDeviationBps: null`; they are excluded from observed at-peg counts. At-peg summaries use the detector's raw-precision trigger boundaries, not rounded display deviations. A deviation below the severe band, observed while the coin's FX or metal reference market is closed (judged at the price observation's own time), stays on its row but is left out of the summary aggregates (`totalTracked`, `coinsAtPeg`, median and worst current deviation), as it is from the OG at-peg cohort. Historical analytics fields remain attached to their accepted generation, except that `depegEventsToday` / `depegEventsYesterday` are re-bucketed against the request's UTC day from a bounded two-day `depeg_events` read when the accepted generation was published on an earlier UTC day. The re-bucketing counts the same effective onset the public feed publishes (an active incident's projected first onset, falling back to the fragment's `started_at`), so a fragment that starts after midnight still counts on its incident's first day. If that read fails, the endpoint returns explicit `503` with `peg-event-day-count-read-failed` and `no-store` rather than defaulting the counters to zero. If canonical incident projections cannot be read during a fallback recompute, the endpoint retains an available accepted analytics snapshot with `incident-projection-read-failed` and `no-store`, or returns explicit `503` when none exists.

If a retained historical analytics row has no current observation-map entry, `/api/peg-summary` publishes `pegReference: null` with `pegReferenceUnavailable: true`; missing live evidence must not be labelled as an available reference.

## Stage 1 -- Detection

### Initialization

1. Load PSI-eligible stablecoins into `metaById` map
2. Derive peg rates (handles FX lookups once)
3. Load DEX prices from `dex_prices` table (silently skip if table missing)
4. Merge duplicate open events: same-direction duplicates select the earliest row for live processing and absorb only same-direction peaks measured in that keeper's own quote domain against the same peg reference (1% relative bound). A cross-domain or reference-drifted duplicate is still deleted, but its peak is not copied: the keeper keeps the peak its own reference reproduces. Persistence deletes only duplicates with no canonical incident first/current pointer or constituent link; referenced duplicates remain intact, including before sealing. If opposite directions are open, the newest direction remains live and older direction rows close with `close_reason = 'superseded-direction'` and `recovery_price = NULL`.

Open-event hydration explicitly joins `depeg_event_provenance.quote_mode`. This structured quote domain is authoritative for both live and backfilled rows: `native-peg` events keep native-currency peak and recovery prices with reference 1, while USD-domain rows use USD prices. Only legacy live non-USD events without quote-mode provenance use the reference-1 native heuristic.

The DEX publisher selects deduplicated plausible contributors with original clocks strictly younger than `DEX_FRESHNESS_SEC` (75 minutes), then applies the existing outlier filter. The selected median inputs define the aggregate clock (oldest input), source count, source TVL and protocol provenance. If none qualify, the full blend and its oldest clock remain available for conservative vetoes.

Aggregate `dex_prices` admission requires a publication age strictly below 75 minutes and `source_total_tvl >= $1M`. Affirmative direction, recovery, trusted coverage and public confirmation-source availability also require an original aggregate age strictly below 75 minutes. The shared reader validates the oldest repeated `aggregateObservedAt` from legacy nonempty arrays, or the independent `{aggregateObservedAt,sources:[]}` envelope, before protocol filtering; any missing, invalid, nonpositive, nonfinite or future clock withholds affirmative admission. A valid aggregate remains available when no protocol lane survives its separate gates. Thin DEX rows remain visible in storage for analytics, but they do not suppress or confirm events.

Protocol corroboration additionally requires original per-protocol/source-family `observedAt` within the caller's 35-minute source budget and that entry's original `aggregateObservedAt` within 75 minutes; those source gates remain inclusive and reject future clocks. A fresh publication wrapping a six-hour quote fails admission. Legacy unclocked sources, including those with a fresh compatibility `updatedAt`, cannot prove current corroboration or recovery: neither clock falls back to publication `updated_at`. Publication-fresh raw aggregates and existing pool-challenger observations retain their separate conservative veto policies. Pending confirmation, recovery and contradiction require admitted original clocks; an old same-direction confirmation can only veto rejection, without becoming affirmative confirmation or a stale opposing signal beside unavailable evidence. Native extreme admission likewise needs original-clock-fresh DEX corroboration, while native-quote veto corroboration retains its publication-fresh conservative policy. Rejecting affirmative evidence cannot remove a veto and create recovery or confirmation. Activate this reader only after observing an accepted clocked-writer generation; historical events and sealed artifacts are not rewritten.

The `dex_prices.updated_at` run-start clock is retained for row-age telemetry and independent aggregate-row policies, not as an affirmative source-admission veto. A row older than 35 minutes can still contain later original observations inside both source budgets; those source groups remain admissible.

A DEX challenger with verified venue lineage that overlaps the named primary venue cannot corroborate that primary. This also applies to USD primaries whose ancestry array was omitted.

For XAGm, aggregate DEX prices, protocol quotes and pool challengers need a silver entitlement matched to their own observation time, including when detection uses a legacy FX rate.

The stablecoin detail page can show live deviation below the event-creation floor with an explicit coverage-limited label. An existing row closes as `coverage-lost-supply` with `recovery_price = NULL` only on observed sub-floor supply, including zero. Unavailable supply opens no new row and leaves the existing lifecycle and peak unchanged, but records blind price coverage rather than extending trusted intervals.

### Per-Asset Processing

Validation gates (skip if any fail):

- Must be in `PSI_ELIGIBLE_STABLECOINS`
- Not a NAV token (`meta.flags.navToken`)
- Price valid: observed, finite and > 0
- Supply >= $1M (via `getCirculatingRawOrNull()`) for live event recording. Observed sub-floor supply, including zero, closes existing rows as `coverage-lost-supply` with `recovery_price = NULL`; unavailable supply keeps the lifecycle open and records blind coverage
- Peg reference valid: finite and > 0
- Non-USD fiat peg references use the live FX rate whenever it is available; a fiat peer median is only a fallback and needs at least 3 live contributors. Commodity references may use a peer median only once at least 3 live same-metal contributors are admitted, otherwise they use a direct spot rate when available and fail closed without one. A 1- or 2-coin gold/silver median never anchors deviation
- FX and bullion lifecycle decisions follow [reference admission and calibration](#reference-admission-and-calibration). A held quote supplies no onset, peak, direction or recovery update. Candidate and open-event canaries can exempt a matching scheduled hold during its evidence budget. A candidate already stalled, or an event already blind at closure onset, remains actionable.
- Floating `VAR`/`OTHER` pegs have no authoritative reference — their peer median is another coin's level, not a peg — so signal derivation fails closed and they cannot open or mutate live depeg state
- Supported non-USD fiat pegs with reliable CoinGecko native pairs also consult a fresh native-currency quote before mutating live state; a native quote inside the recovery band or pointing the other way vetoes the derived USD/FX onset for that cycle, while a threshold-crossing native quote can initiate a pending candidate when the primary USD-vs-reference path is still inside threshold
- Every live native-currency quote passes one plausibility bound against its own par (`classifyNativeQuoteImplausibility()` in `worker/src/lib/native-quote-plausibility.ts`, built on the primary price-validation reference band and `DEPEG_EXTREME_MOVE_BPS`). A quote outside that bound is withheld unless an independent source family (trusted DEX protocol groups in Stage 1, the normalized canonical family at confirmation) shows its own implausible move in the same direction. A withheld sample is unavailable evidence with a machine-readable reason: it cannot open a pending candidate, suppress the primary path, deepen a peak, or recover an event

Every completed run records a `depegObservation` census over the non-NAV PSI-eligible universe (eligible, observed, unavailable and below-floor counts with per-reason counts). The `depeg-observation-coverage` canary compares the latest census with the previous generation and degrades when unacknowledged unavailable assets increase (naming their reason deltas), so a peg-reference source losing authority, which skips each affected asset as `non-authoritative-reference`, reaches a machine-readable status cause instead of only a log line. A held stage (`depegObservation: null` plus `depegObservationUnavailableReason`) is named; a missing census is a failed read, not healthy coverage.

The two operator observation-completeness canaries grade unacknowledged gaps and retain the raw census counts. Up to 64 `primary-unusable` IDs can be acknowledged through reviewed nominal-reference evidence, a valid source calendar at the census clock (including its post-closure wait), or a valid price-gap review at the canary clock. Every ID must be distinct and have reason `primary-unusable`, and the list length must match the census count for that reason. Missing, truncated, malformed or size-guard-dropped IDs leave the full `primary-unusable` cohort actionable. `reference-market-closed` gaps carry no IDs and are acknowledged by count only when the census clock is inside a metal-market closure.

Both canaries validate totals before grading gaps. Observed, unavailable and below-floor counts must sum to the eligible count, and known reason counts may not exceed the raw unavailable count. An invalid current census fails the measurement with `depeg-observation-census-invalid` in the pricing canary or `depeg-census-invalid` in the detection canary. An invalid previous census leaves the baseline unavailable. For consecutive losses, the detection canary selects the newest completed run with a strictly earlier start timestamp and requires its census to be valid.

A dated `no-parity-quote-by-design` review acknowledges Solayer sUSD's `primary-unusable` gap only when that census records a positive, upstream-clocked `protocol-redeem` valuation that fails `isParityPrice`. Legacy censuses and gaps without this source fact remain actionable. The acknowledgement grades operator completeness only. The valuation remains published, and peg detection, events, and DEWS continue to use their existing admission rules.

Primary-price trust gates:

- `authoritative`: fresh observed `single-source` with exactly one policy-admitted authoritative source, or `high` with at least two authoritative sources or one upstream-capable authoritative source (`classifyPrimaryDepegTrust()` in `worker/src/lib/depeg-trust-policy.ts`)
- `confirm_required`: cached, fallback, low-confidence (including display quotes published via `pricePublicationReason: "open-confirmed-depeg-continuity"`), stale, or otherwise source-policy-ineligible primary prices. Continuity display quotes require an already open confirmed `depeg_events` row (`depeg_pending` does not qualify) and cannot open, close, deepen peaks, flip direction, extend trusted coverage, or confirm pending rows
- `unusable`: invalid/missing/non-finite price, or a non-observed price (`priceObservedAtMode: "nominal_reference"`, an unsupported mode, or any `protocol-par` source component). Since pricing v6.38 the nominal par routes publish par this way whenever no trusted market quote is admitted, so par can neither open, confirm nor recover an event; an open row stays open (tracked coins are never orphan-closed) until observed price evidence decides it, while a trusted market discount on those assets is evaluated like any other primary price

Stage 1 treats a last trade with an explicitly unknown market clock as unavailable primary evidence. Successive polls of a standalone Kraken display price supply zero qualifying observations for pending persistence.

Before those gates are applied, `priceSource` and `agreeSources` are normalized through the pricing-source registry. Composite labels are expanded into their component source keys, unknown sources do not become pool-challenge eligible by accident, and each known key resolves to its registered `depegSourceFamily`. CoinGecko variants, DefiLlama list/detail/contract variants, and CoinMarketCap-style list aggregators are therefore not counted as independent hard corroboration just because their labels differ; promoted DEX protocol lanes and hard market/oracle/protocol sources keep provider- or protocol-specific families.

Deviation calculation:

```
rawBps = ((price / pegRef) - 1) * 10000
bps = Math.round(rawBps) // persisted and displayed value
direction = rawBps >= 0 ? "above" : "below"
```

Threshold decisions use `abs(rawBps)` so a value that merely rounds to the boundary cannot open or confirm an event.

### Three State Paths

**Path A -- Deviation beyond the trigger threshold AND event already open**

- If a fresh native-currency quote is inside the recovery band, route the row through the recovery confirmation path rather than closing immediately
- If threshold-crossing USD-primary and native quotes conflict: suppress mutation and keep the lifecycle open
- An admitted native-domain quote can drive that row's direction replacement. For USD-domain rows, replacement requires authoritative primary input or trusted aggregate DEX corroboration from at least 2 protocol groups; close the old row and queue the replacement
- Otherwise, <!-- GENERATED-START: depeg-confirm-required-direction -->`confirm_required` direction changes keep the old-direction lifecycle open<!-- GENERATED-END: depeg-confirm-required-direction --> and log a warning
- Same direction: mark as legitimately open (add to `seen` set); update peak only when the primary input is authoritative or a corroborated trusted DEX row corroborates the move
- For a live event opened in the native quote domain (`peg_reference = 1` on a non-USD peg), update the peak only from a same-direction native quote; never write the USD primary price into that row
- Same-direction DEX disagreement is now advisory only: detection logs the mismatch but does **not** auto-close the event from that contradiction alone

### Long-Running Re-Escalation (v6.56)

Open incidents older than 30 days (`DEPEG_LONG_RUNNING_AGE_SEC`) classify into the `long_running` display bucket unless a confirmed re-escalation promotes them back into `Recent` (`Escalating`) for 7 days (`DEPEG_REESCALATION_WINDOW_SEC`). Re-escalation state lives on `depeg_events` (`peak_escalated_at`, `peak_escalation_anchor_bps`, `peak_escalation_candidate_at`, `peak_escalation_candidate_seen_at`, migration `0323_depeg_event_peak_escalation.sql`) and is evaluated through a dedicated `update-escalation` command in `worker/src/cron/depeg-detection/escalation.ts`, completely decoupled from `update-peak` and duplicate repair (`repair.ts`):

- **Day-30 gate & fresh-incident reset:** Re-escalation never arms or fires while canonical incident age is `<= 30d`, and seeding/advancing requires the admitted observation clock itself to be strictly past `incidentStartedAt + 30d`. If DDR later assigns a reopened row to a fresh `<= 30d` incident, hydration detects the fresh onset and resets all four columns to `NULL`. When enriched metadata hydration falls back to the base open-event query, detection preserves stored anchor and confirmed escalation, clears transient candidate clocks on newer observations, and defers seeding, arming, confirmation, and unverified duplicate repair until metadata hydration succeeds.
- **Trusted same-direction observation & deadband seeding:** USD-domain events require an authoritative primary quote with an admitted `quoteObservedAt` timestamp (never a `now` fallback, DEX-only, `confirm_required`, peer-relative, or closed-session reading, and never contradicted by an at-par native quote). Native-domain events require a fresh admitted same-direction native quote. On the first qualifying post-Day-30 observation (including same-direction deadband readings between the recovery band and opening threshold), `peak_escalation_anchor_bps` seeds at `max(|bps|, pegThreshold)` and keeps both candidate clocks `NULL`. Stored or carried anchors below `pegThreshold` are rejected and reseeded rather than lowering the target.
- **Two-sample confirmation & continuity:** Once seeded, target magnitude is `anchor + clamp(250, 1500, round(anchor * 25%))` (capping the step at `1500 bps` keeps downside anchors under `8500 bps` reachable below `10000 bps`). The first qualifying observation at or above target arms `peak_escalation_candidate_at = observedAt` and `peak_escalation_candidate_seen_at = observedAt`. Each consecutive distinct qualifying observation within the 20-minute continuity budget (`DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC`, requiring gap-free `trusted-off-peg` prior coverage, no active reference hold, and exact `priorLastTrusted === peak_escalation_candidate_seen_at`) either advances `peak_escalation_candidate_seen_at = observedAt` while keeping `peak_escalation_candidate_at` anchored when `observedAt < candidate_at + 15m`, or confirms `peak_escalated_at = observedAt` once `observedAt >= candidate_at + 15m` (`DEPEG_REESCALATION_CONFIRM_MIN_AGE_SEC`), ratcheting `peak_escalation_anchor_bps` upward only (`max(anchor, |bps|)`) and clearing both candidate clocks. Re-evaluating an unchanged observation clock is a no-op. Any intervening escalation-ineligible tick (non-authoritative, missing clock, closed session, peer move, native veto, deadband/recovery, or below-target reversion) clears both candidate clocks immediately, and any gap exceeding 20 minutes or unaccounted coverage advance (`priorLastTrusted !== peak_escalation_candidate_seen_at`, e.g. from a rolled-back writer) restarts the candidate window rather than confirming across it.
- **Reopen & family carry-forward:** Open-event hydration, pending promotion (`confirm-pending-depegs.ts` fail-open wrapper), analytics sidecar derivation (`worker/src/lib/peg-analytics.ts`), and OG briefing (`worker/src/api/og-depeg.ts`) share indexed lookup helpers (`worker/src/lib/depeg-escalation-metadata.ts`) that resolve canonical onset and the maximum clean `peak_escalation_anchor_bps` / `peak_escalated_at` across linked active DDR incident families (including superseded aliases) and eligible non-disputed `<= 6h` same-direction predecessors. Inheritance is withheld whenever a sealed DDR prediction triggers a regime-escalation split (`>= 1000 bps` and `>= 4x` lock-time peak) or has indeterminate/unreadable frozen peak evidence.

**Path B -- Deviation beyond the trigger threshold AND no event open**

- If the peg reference is a thin non-USD fiat peer median without live FX: skip live-state mutation for this cycle
- If a supported native-currency quote is inside the recovery band or shows the opposite side of the peg: suppress the new event for this cycle
- If the primary USD-vs-reference deviation is inside threshold but a fresh supported native-currency quote crosses threshold, store that quote against a `1.0` peg reference in `depeg_pending`
- Every remaining onset is inserted or refreshed in `depeg_pending` with `reason = "confirmation-window"`. Large-cap, low-confidence, extreme-move, and native-origin flags are appended when applicable; none bypass the 15-minute window.
- Corroborated trusted DEX recovery can still suppress a new candidate before the pending write.

Whenever a row is written to `depeg_pending`, the worker now upserts directional state instead of treating the table as write-once:

- same direction with no more than 1200 seconds since the prior qualifying observation: preserve `first_seen_*`, refresh `last_seen_*`, and update `peak_seen_*` when the move worsens
- same direction after a gap greater than 1200 seconds: reset first/last/peak fields to the new observation; the blind interval cannot count toward confirmation
- opposite direction: reset the row as a new incident instead of preserving stale first-seen direction metadata

The 1200-second continuity tolerance allows ordinary producer jitter beyond the 900-second schedule but remains below two intervals. A missed run must reset onset: a blind interval cannot prove persistence.

Detection persistence commits all mutations for one stablecoin as one ordered atomic transition, then proceeds to the next asset.

**Path C -- Deviation inside the trigger threshold AND event open**

- If a supported CoinGecko native-currency quote still shows the same-direction depeg: keep the event open and ignore the derived recovery
- If a fresh trusted aggregate DEX row still crosses the depeg threshold in the existing event direction, with at least 2 protocol-level DEX groups corroborating that direction: keep the event open and ignore the primary recovery print
- Qualifying pool challengers veto primary recovery when either one same-direction pool has at least $5M TVL, or at least 2 independent protocol/source-family groups match or outnumber groups corroborating recovery. The single-high-TVL recovery veto is independent of that group vote; only the ordinary group-based path rejects a diverging minority.
- V2 challenger payloads retain original pool-price observation clocks separately from source/publication clocks and immutable membership. Their TVL evidence and source family follow the price observation, bounded by retained pool TVL; unrelated inventory cannot trigger a high-TVL veto. Legacy snapshots retain their historical clock limitations. Only diverging/corroborating group counts and the high-TVL veto are derived; no positive recovery price is computed. Ambiguous primary recovery still requires the fresh trusted aggregate DEX lane; retaining quote provenance does not activate a new recovery policy.
- A qualifying recovery must be at or inside 50% of the trigger threshold: 50 bps for USD pegs and 75 bps for non-USD pegs. The first qualifying observation sets both recovery timestamps; each consecutive qualifying observation refreshes `recovery_last_seen_at`. The row closes only after total recovery age reaches 15 minutes and the gap from the prior qualified observation is no more than 1200 seconds.
- A later qualifying recovery after a gap greater than 1200 seconds resets both recovery timestamps to the new observation. Missing data leaves the event open, but the missing interval never proves recovery.
- A reading between the recovery and trigger thresholds is a deadband: keep the event open and clear any partial recovery timer.
- Native-domain rows recover only with a qualifying native quote, persisted with `close_reason = 'recovered-native'`. Missing native evidence keeps the lifecycle open even if USD primary or DEX prices suggest recovery.
- USD-domain rows can recover from qualifying native evidence alone, but close as `recovered-native` with `recovery_price = NULL`: a native quote is not a USD recovery price. `recovered-primary` always requires the primary signal itself to be inside the recovery band as well as meeting its trust gate; native-only recovery does not override the existing USD-domain DEX or pool vetoes.
- Authoritative or fresh multi-source primary recovery can advance the timer. Ambiguous primary recovery requires a trusted aggregate DEX row, at least 2 corroborating DEX protocol groups, and no qualifying pool veto.
- Any renewed same-direction depeg or contradictory trusted evidence clears the partial recovery timer.
- Sustained single-source recovery: a USD-domain row whose primary is fresh, upstream-dated and `confirm_required` (a non-cached `single-source` or `high` quote that cannot be depeg-authoritative, for example CoinGecko alone) advances the same recovery timer when it sits inside the recovery band and nothing contradicts it: no fresh trusted DEX price outside the recovery band, no liquid DEX row (at the depeg TVL floor) that is stale or not affirmative, no DEX recovery challenge, no pool veto, and no admitted native quote outside the band. The row closes as `recovered-primary` only after 24 continuous hours (`DEPEG_SUSTAINED_PRIMARY_RECOVERY_SEC`), instead of 15 minutes for trusted evidence. Events opened on pool or temporal confirmation therefore no longer stay open forever once their own price source shows sustained recovery; a reference-market hold pauses and resets the timer. The timer is shared, so trusted recovery evidence arriving once it has run 15 minutes closes the row at once. `ended_at` is the close time, so a sustained close's duration includes up to 24 hours already back inside the band.

### Orphan Cleanup

After the main loop, load open events with the `MAX_OPEN_DEPEG_EVENTS = 200` bound. If the read reaches that bound, skip orphan cleanup and emit a structured degraded warning rather than operating on a truncated set. Otherwise, close any rows that were not in the `seen` set and were not created during the current run. Rows for frozen coins are also exempt and are never force-closed -- preserved historical data must not be falsified by a lifecycle change (`shouldCloseOrphanedDepeg` in `worker/src/cron/depeg-detection/repair.ts`). These are true "orphans" -- the coin was removed from tracking or exited the PSI-eligible set. Tracked coins are intentionally kept open through transient missing-price or ambiguous-input cycles and are **not** force-closed just because one run lacked a trusted recovery signal. Orphans are closed with `close_reason = 'orphan-tracking-removed'` and `recovery_price = NULL`.

## Stage 2 -- Confirmation

Pending confirmation rechecks the original evidence basis and current admission. A directly traded native quote can initiate a candidate during a hold. Promotion then needs independent corroboration in the relevant unit. The pending dead band lies between the event and recovery thresholds. Pool voting uses the pool's original observation clock, with mirrors and overlapping venues excluded. Recoveries can use continuous eligible primary observations or independently timed DEX evidence. Store an observation's own reference at a measured peak or recovery.

Processes all rows in `depeg_pending`. Every live onset, including small-cap, multi-source, native-origin, and extreme candidates, enters this stage.

### Per-Record Processing

Guards (delete pending + skip):

1. Invalid `peg_reference` (<= 0)
2. Open event already exists for this coin (another path created it)

Recovery checks run before the age gate. A fresh native quote strictly inside the full trigger threshold clears pending as `recovered`; authoritative primary recovery does likewise unless native evidence still confirms the pending direction. Ambiguous primary prices alone cannot clear a row. Native recovery evidence does not let a native-origin quote confirm its own promotion.

Native-origin candidates keep their native quote as the event-price domain, but that quote cannot confirm itself. At confirmation time, Pharos normalizes the fresh canonical USD price through the authoritative FX reference and admits only source families outside CoinGecko. One such independent canonical family must agree with the native-domain direction and full threshold before promotion; an at-peg or opposite-direction normalized canonical reading rejects the candidate after the temporal window. Missing, stale, fallback, cached, or CoinGecko-only canonical evidence leaves the row pending rather than promoting it.

A native quote, or a stored native-origin sample, that fails the same plausibility bound is recorded as unavailable evidence (`native:<currency>:<reason>`). It cannot confirm, oppose, promote, deepen or recover a candidate, and it suppresses this row's native confirmation read instead of opening a replacement fetch. An implausible stored sample cannot be closed as recovered from canonical pricing; an independent family must show its own implausible move in the same direction before an extreme native sample can stand.

Confirmation uses the detector’s monitoring registry, including historical UST and IRON. An unsupported or mismatched pending row can expire after the unavailable-reference window. For USD recovery, a legacy authoritative primary uses its quote update time when both observation clock fields are absent. An explicit clock verdict governs ordering when supplied.

The 15-minute wait and dynamic expiry start at the detection run that first saw the continuous episode. When a quote has an upstream clock, its original time also governs ordering and persistence. A repeated quote cannot advance the episode. Pending first, latest and peak deviations are stored in whole basis points. Original price/reference pairs resolve peaks that round to the same value.

If the primary disappears in an open session, confirmation can pair an eligible independent USD secondary quote with the selected reference at the secondary quote's own observation time. The pending episode must still meet the temporal requirement.

Age checks:

- If age < 15 minutes: skip (wait for next cycle)
- If age is past the 45-minute base expiry, delete only when the dynamic final limit is also exceeded. The limit extends to 135 minutes when the current authoritative primary still points in the pending direction or confirmation sources are unavailable/circuit-open, and to 180 minutes for extreme-move pending rows.

### Secondary Source Checks

**Off-chain check:**

- Preferred path for supported non-USD fiat pegs: use a fresh CoinGecko native-currency quote (for example `BRZ/BRL` or `EURC/EUR`) and compare that quote to the native `1.0` peg
- A candidate initiated by that native quote additionally requires a fresh canonical USD price from at least one non-CoinGecko source family, normalized through the authoritative FX reference, to cross the full native-domain threshold in the same direction. Repeated CoinGecko native observations provide temporal persistence only, not independent source confirmation.
- Default path: CoinGecko can confirm a primary that does not already contain the CoinGecko source family. A CoinGecko-family primary gets no off-chain confirmer because DefiLlama's `coingecko:{id}` price is a CoinGecko mirror, not an independent observation.
- CoinGecko confirmation uses `/simple/price` with `precision=full` and `include_last_updated_at=true`. Missing, stale, or future-dated observations are ignored, and non-OK response bodies are canceled before later confirmation fetches.
- Recompute the peg reference through the Stage 1 authority gate. In the same open session, a legacy pending can reuse its stored reference when replacement evidence is wholly absent. A median consisting solely of the pending asset supplies no replacement. An explicit modern rejection withholds the reference.
- XAGm secondary measurements require an entitlement matched to their own quote clock in both legacy and clocked FX modes.
- Counts as confirmation only when deviation reaches the full trigger threshold and points in the same direction as the pending incident
- Non-fatal: if fetch fails, the off-chain agreement remains `null`
- Canonical persisted keys are `temporal:15m`, `coingecko-confirm`, or `native:<peg>`.

**CEX ticker check:**

- Fetches the active configured Binance market batch (currently `USDTUSD` and `USDCUSD`) as an additional secondary confirmation source, then looks up the pending coin by symbol
- Only attempted for symbols present in the configured Binance market set
- Binance and CoinGecko confirmation exclude source families used by the current primary or retained in the pending episode. A receipt can still identify the onset venue after a legacy writer refreshes the latest quote. Binance needs source keys that match the onset to confirm or deepen the peak. Pending episodes without those keys need other qualifying evidence for promotion.
- If an admitted observation ties the stored peak at the exact same price and in the same quote domain, its paired reference can complete a legacy peak. A different price cannot backfill that pair.
- Counts as confirmation only when deviation reaches the full trigger threshold and points in the same direction as the pending incident
- Non-fatal: if the Binance fetch fails, the CEX agreement remains `null`

**DEX check:**

- Read from `dex_prices` table (same data as Stage 1)
- Both original aggregate and publication ages must be strictly below the 75-minute hourly-producer window, with aggregate source TVL >= $1M
- Aggregate DEX confirmation now also requires at least `DEPEG_DEX_PROTOCOL_CORROBORATION_MIN` independent protocol groups from fresh per-source `price_sources_json`; one protocol cannot promote, recover, or decisively contradict a pending row by itself
- Aggregate, protocol and individual pool votes exclude known pool or venue identities shared with the current primary or retained pending observations.
- Counts as confirmation only when deviation reaches the full trigger threshold and points in the same direction as the pending incident
- Persisted confirmation keys use `dex:<protocol>`.

**Pool challenger check:**

- Loads qualifying individual DEX pool challengers from the published challenger snapshot tables via `loadDexPoolChallengers(...)`
- Uses the same freshness / minimum-TVL guardrail family as the depeg helper layer
- Shared pool or conversion identities link challengers into one group. The newest eligible quote represents the group, with bounded TVL breaking clock ties. Confirmation, price hardening and the rollback-readable projections all use this rule. A disjoint group contributes independently.
- Counts as confirmation only when **at least two distinct protocol/source-family groups** reach the full trigger threshold in the same direction, **or** a single qualifying pool with `>= $5M` TVL does so, and the confirming groups are at least as numerous as the groups contradicting the pending direction (opposite-direction or back inside the bar). Multiple same-protocol pools from the same source family count as one group.
- The single-high-TVL exception replaces only the two-group minimum, never the opposing-group vote: one confirming group can be unopposed or tied with one opposing group, but cannot confirm against two opposing groups.
- Missing challenger tables or incomplete snapshots can fall back to the TVL-bounded challenger projection, top pools, or protocol sources. The writer excludes duplicate votes, quotes with explicitly incomplete ancestry and quotes that share inputs with a configured primary route from these voting fields. Display readers still surface the pool and protocol prices.
- Persisted confirmation keys use `pool:<protocol>:<sourceFamily>`.

### Decision Matrix

| Temporal persistence | Source confirmation | Contradiction | Action |
|----------------------|---------------------|---------------|--------|
| Less than 15 minutes | any | no terminal guard or recovery | Keep pending |
| Full 15 minutes beyond the trigger threshold | fresh primary cluster spanning at least 2 independent families | none decisive | PROMOTE |
| Full 15 minutes beyond the trigger threshold | independent CoinGecko, CEX, corroborated aggregate DEX, or qualifying pool evidence | none decisive | PROMOTE |
| Full 15 minutes beyond the trigger threshold | native-origin candidate plus a fresh non-CoinGecko canonical USD family normalized through authoritative FX, both beyond threshold in the same direction | none decisive | PROMOTE |
| Full 15 minutes beyond the trigger threshold | native-origin candidate only | normalized independent canonical price is at peg or points in the opposite direction | REJECT |
| Full 15 minutes | only soft off-chain evidence on a `low-confidence` row | none | Keep pending; require CEX, aggregate DEX, or pool confirmation |
| At least 15 minutes | any | decisive opposing evidence with no same-direction rescue | REJECT under the safeguards below |
| any | none | none | Keep pending until dynamic expiry, then expire or record `unconfirmed-severe` |

**Primary-still-depegged safeguard:** the REJECT rows above assume the refreshed authoritative primary price no longer shows the pending direction. When it still does (`primarySameDirectionDepegged`), a single opposing secondary source cannot reject the row -- rejection then requires at least two independent hard-opposing sources (reason `two-hard-opposing-sources:...`); otherwise one opposing source suffices (reason `secondary-evidence-opposes`).

The event can start at the episode’s first quote clock when that clock follows the previous live episode’s end and falls inside the session that admitted the pending. Live recoveries also establish this boundary for events originally opened by backfill. The onset receipt selects the calendar used at admission. A legacy reopening with a quote from the closure starts the event at discovery. Quote clocks still determine temporal ordering. Promotion records the active direction, the paired onset price and reference, confirmation sources beginning with `temporal:15m`, and the worst trusted same-direction price and reference pair. The event, outcome and pending deletion commit atomically.

Native-currency confirmers on USD-origin candidates normalize their price by multiplying the native quote (reference 1) by the candidate's admitted USD peg reference before peak selection; native-origin candidates retain native prices and reference 1. Pool peak candidates are exposed and consumed only when the pool confirmation policy accepts them, so rejected minority pools cannot deepen a primary-led promotion or supply uncredited event peaks.

Pending rows that pass the 45-minute base expiry but still have same-direction primary evidence, unavailable sources, or open confirmation circuits remain pending until their final dynamic limit. Rows that exceed that final limit are deleted with a recorded pending outcome; extreme-move expiries use `unconfirmed-severe` instead of the generic `expired` label.

## Historical Backfill Validation

Replay pairs dated observations with same-unit references available at the observation time. Historical metal medians exclude the asset being scored and require three independent peers when independent spot is unavailable. Keep onset, peak and recovery evidence distinct and preserve the existing incident where a replacement boundary cannot be proven. When per-observation reference evidence is missing, replay reports a degraded result. Targeted history repair preserves IDs and uses admitted intervals, with separately reviewed restoration and PSI receipts.

Historical backfills in `worker/scripts/backfills/backfill-depegs.ts` consult the authoritative-provider registry before market history, but use a distinct episode policy: raw absolute bps for triggers, a flat timestamp-valued $1B large-cap confirmation cutoff, and closure on the first sample at or inside the half-threshold recovery band. Historical extraction and Tape allow one unit of floating-point precision at par when comparing the inclusive boundary. A deeper sample replaces an open episode's peak only when another sample of the same episode is within 1,000 bps of it: a lone wick between par readings can still open a sub-$1B episode under the one-point policy, but it cannot become the published peak. An episode whose opening print is never corroborated (and is not extreme) is withheld at close instead of publishing that print as the peak; extreme single-point crashes keep their existing exemption.

The earlier repair removed selected closure-origin artifacts. The current [repair workflow](./runbooks/one-shot-backfills.md#repair-reference-market-artifacts) records analytic disposition and admitted intervals while preserving incident identities. It includes reviewed restorations of PAXG event 24994 and EURS event 89640 and targeted PSI reversals. Apply the write only after reviewing its dry run.

Backfill rewrites delete prior `source='backfill'` rows even when a trusted replay finds zero replacement events. Dry-runs preview that same removal scope through `removedBackfillEventCount`. For non-empty replacements, the delete and first insert chunk share one D1 `batch()` call (up to the D1 100-statement batch limit: delete + 99 inserts). Additional inserts are written in later chunks, so large replacements are bounded and restartable but not a single all-rows transaction.

Replay now drops recomputed episodes that reviewed data or an existing live row already covers, inside `executeBackfillForCoin` (`worker/scripts/backfills/backfill-depegs/execution.ts`; overlap predicate `backfillEpisodeCoveredByLiveEvent` in `worker/scripts/backfills/backfill-depegs-window.ts`):

- **Reviewed suppression.** An episode whose inclusive `[startedAt, endedAt]` interval overlaps a matching registry entry for the same coin and direction is skipped.
- **Live overlap.** An episode that overlaps an existing `source='live'` row of the same coin and direction (`episodeStart <= liveEnd && liveStart <= episodeEnd`, inclusive; an open row collapses to its start second) is skipped. Live detection polls at minute cadence while replay consumes hourly samples, so same-side overlapping windows are one market episode counted twice; intervals one second apart are disjoint.

Both rules run before the dry-run/apply split, so the preview, `expectedEventCount`/`expectedFingerprint`, and the inserted rows stay mutually consistent. Each skip logs `backfill-depegs-episode-skipped` with `skipReason: reviewed-suppression` or `live-overlap`. Neither rule deletes anything by itself: the replayed window's delete still removes stale `source='backfill'` rows, live rows are never removed by replay, and the skip only prevents the twin from being re-inserted.

Mutating backfills now persist replay-run status and event provenance. Backfilled rows receive replay version, provider roster, quote mode, peg-reference source, supply source, confirmation policy, confidence tier, and compact public provenance. Existing rows without provenance are still accepted by API mappers and PegScore.

Historical supply admission prefers DefiLlama `totalCirculatingUSD`. Native-only `totalCirculating` / `circulating` snapshots are converted through the timestamp's historical FX or commodity peg reference (including per-token `commodityOunces`) before applying the `$1M` event floor or large-cap confirmation threshold; native units are never compared directly to USD thresholds. Absent, empty, invalid, or unconvertible records do not become zero snapshots; explicit finite zero remains observed zero.

When DefiLlama returns no historical rows, replay applies the live `$1M` event floor using the current stablecoins-cache supply for that asset. If neither historical nor current supply is available, the backfill preserves existing rows instead of silently replaying market prices without a supply floor. A non-empty historical response with no usable supply snapshots is treated as degraded and preserves existing rows even when current supply exists. The same current fallback supply controls large-cap confirmation behavior for genuinely absent-history assets.

Supported non-USD fiat backfills now prefer direct CoinGecko native-fiat history first and compare that series against the native `1.0` peg. In that native-fiat mode, replay uses daily points plus a two-point confirmation window across 36 hours before opening a normal event, while still preserving extreme single-point crashes of `>= 5000 bps`. Only when that native history is unavailable does the replay fall back to USD-denominated CoinGecko/DefiLlama history plus the historical FX reference.

`npx tsx worker/scripts/one-shot-backfill.ts backfill-depegs --query 'dry-run=true'` also accepts `startDay` / `endDay` for bounded replay audits, plus optional `contextDays` to widen the replay pad around that UTC window. The job compares only overlapping stored `source='backfill'` rows; live replacement additionally requires `--execute --allow-atomic-import` and a coordinated maintenance window acknowledging temporary D1 unavailability. Transport and interruption handling are owned by `docs/runbooks/one-shot-backfills.md#transport-safety`.
For commodity-pegged assets, the peer-median reference fetch is bounded to the same replay pad and only fetches the needed gold or silver source family instead of rebuilding full hourly history for every tracked commodity token.
Commodity lookup series and their current-rate fallback stay in per-ounce units until a single final `commodityOunces` conversion. Missing historical spot data therefore uses the current per-ounce rate times the token weight once, never an already per-token fallback weighted again. If neither a historical series anchor nor a current commodity reference is available, replay skips the coin as `missing-fx-reference` and preserves its existing events.

When a coin has an authoritative historical provider (for example, protocol redemption quotes replayed at historical blocks), backfill uses that provider first. If the provider cannot return enough historical coverage, the handler preserves existing `source='backfill'` rows instead of rebuilding from a weaker market-data source.

Instead, `extractDepegEvents()` now validates each price point in `historical_backfill` mode against the **direct peg reference for that timestamp**:

- USD and other fixed pegs can preserve catastrophic downside moves when the historical peg reference itself is valid
- low-nominal FX pegs such as JPY are judged against the actual historical FX reference, not a generic live-only fallback
- commodity tokens use `commodityOunces` when converting the historical gold/silver peg reference into per-token units

This keeps confirmed historical crashes visible without weakening the stricter live-source filters used to protect sync and DEX ingestion.

### Reviewed replay suppression registry

`shared/data/depegs/backfill-replay-suppressions.ts` records operator verdicts that a recomputed backfill episode is a price-feed artifact rather than a market depeg. It is what keeps a reviewed artifact deletion durable: without it, the next admin replay would delete and recompute the same window and re-persist the artifact.

| Field | Type | Meaning |
| ----- | ---- | ------- |
| `coinId` | `string` | Tracked stablecoin id (validated against `shared/data/stablecoins/canonical-order.json`) |
| `direction` | `"above" \| "below"` | Depeg side the verdict applies to (shared `DepegDirectionSchema` vocabulary) |
| `windowStart` / `windowEnd` | `number` | Inclusive UTC window bounds in Unix seconds; `windowStart < windowEnd` |
| `reason` | `string` | The reviewed verdict, stated as the artifact conclusion |
| `evidenceUrls` | `string[]` | Primary forensics (on-chain transaction links, price-feed pages); `https` only |
| `reviewedAt` | `string` | Review date, `YYYY-MM-DD` |

Matching is inclusive interval overlap between the recomputed episode `[startedAt, endedAt ?? startedAt]` and the entry window, scoped to `(coinId, direction)`.

An episode is an artifact only when no executed trade on any observed venue printed at the stored deviation. Historical backfill admits a single sample for sub-$1B assets, so a thin venue that genuinely traded at the deviation is a real print and must not be suppressed; a deep-pool state quote at par does not by itself refute a thin-venue trade.

The module validates the corpus at import time and fails closed. `shared/data/depegs/__tests__/backfill-replay-suppressions.test.ts` additionally guards tracked coin ids, the shared direction vocabulary, ordered integer windows, `https` evidence URLs, `YYYY-MM-DD` review dates, non-overlapping same-coin/same-direction windows, and the behavioral contract of the seeded USN windows.

Registry edits and primary-evidence review belong to `docs/runbooks/depeg-artifact-removal.md#recording-the-verdict`; the seeded reviewed windows live in the registry, not a second list here.

### Operator runbook

Reviewed artifact removal deploys suppression and live-overlap protection **before** deleting rows, then rebuilds PSI and preserves published URL redirects. Sealed DDR predictions require append-only repair instead of direct deletion; deletes and backfill replays refuse unsealed DDR incident members, whose append-only links would otherwise dangle and fail the public depeg list closed. The command sequence, complete-id comparison and interruption handling are owned by `docs/runbooks/depeg-artifact-removal.md`.

## Event Lifecycle

```
Price crosses threshold
        |
        +-- Corroborated trusted DEX recovery --> suppress candidate
        |
        +-- Otherwise --> INSERT/UPDATE depeg_pending
                              |
                   remain beyond full threshold
                      for at least 15 minutes?
                              |
                   yes -------+------- no
                    |                  |
            source rule passes?      keep pending
                    |
             yes ---+--- no
              |          |
       PROMOTE to       keep pending, recover,
       depeg_events     reject, or expire

Low-confidence pending rows are stricter: off-chain agreement alone does not promote them; they need CEX, aggregate DEX, or pool-challenger confirmation.

While event is open:
  - Peak deviation updated if worse price seen
  - Direction change with authoritative, DEX-confirmed, or admitted native-domain input: close old, queue new pending candidate
  - USD-domain direction change with only `confirm_required` input: keep old-direction lifecycle open until authoritative or DEX-confirmed input arrives
  - Trusted DEX disagreement on the same side is logged, but does not by itself close the event
  - Price reaches the 50% recovery band: start or continue a 15-minute timer with admitted native recovery, authoritative primary recovery, or corroborated trusted aggregate DEX recovery without a qualifying pool veto. A fresh, upstream-dated `confirm_required` single-source primary with no contradicting DEX, pool or native evidence (a fresh trusted DEX price must also sit inside the band) instead runs a 24-hour timer and closes as `recovered-primary`.
  - Price returns to the deadband or depeg range: clear the recovery timer and keep the event open

Orphan cleanup:
  - If a bounded open-event read reaches `MAX_OPEN_DEPEG_EVENTS = 200`, skip the affected detection, confirmation, or orphan-cleanup pass and emit a structured degraded warning
  - Open event for a coin no longer tracked by Pharos: close with `close_reason='orphan-tracking-removed'` and `recovery_price=NULL`
  - Open event for a tracked coin not observed in the current run: keep open to avoid false recoveries during upstream gaps
```

## Types

### DepegRow to DepegEvent

`rowToDepegEvent()` converts D1 snake_case rows to frontend camelCase. It validates:

- `direction` must be `"above"` or `"below"` (an invalid value throws)
- `source` must be `"live"` or `"backfill"` (an invalid value throws)
- `closeReason` is `null` for open/legacy rows or one of the validated terminal reason strings above

`DepegEventSchema` and inferred `DepegEvent` in `shared/types/market.ts` own the
public shape, including nullable coverage and compact provenance. Legacy rows
without provenance remain valid; absence is not a positive audit verdict.

## API

### GET /api/depeg-events

The [public API guide](https://pharos.watch/api/) and `docs/api-reference.md#get-apidepeg-events`
own query parameters, pagination, response schemas and defaults. This endpoint
projects canonical public incidents; optional pending rows remain unconfirmed.

Malformed booleans, pagination values, and cursors return `400` before projection reads. Valid requests return `503` for unreadable (`incident-projection-read-failed`), malformed (`incident-projection-invalid`), or dangling-reference (`incident-projection-dangling-reference`) canonical projections; raw history is never substituted. A stored event whose direction, source or close reason cannot be classified returns `503` naming `invalid-direction`, `invalid-source`, or `invalid-close-reason` plus the offending `eventId` (`unreadable-row` for another refused row); no partial ledger is served. Admission checks every active incident's first/current source events and membership links, including single-event incidents, and every linked constituent event. A successful join that drops missing references is not an empty cohort. A genuinely empty cohort remains available.

Responses carry events, pagination/count precision and methodology provenance,
plus pending candidates only when requested. Unknown coverage remains explicit.

`total` counts all pageable public incident rows under the same stablecoin and active filters, including `disputed` and `false_positive` verdicts, not necessarily individual threshold crossings. Reviewed disputes stay listed with their archive badge; separate event statistics exclude `DISPUTED_AUDIT_VERDICTS`. The endpoint does not emit derived `counts`; clients sum `constituentEventCount` across the fully loaded incident history for threshold-crossing totals, excluding reviewed disputes.

Exact totals reuse one D1 summary (`cache['depeg-events:counts:v1']`) grouped by stablecoin and active/closed membership, rather than recounting the full provenance view for every page/filter. Its publication generation is the committed public membership: migration `0271` invalidates it atomically on event insertion/deletion, identity/stablecoin changes, active/closed transitions, and DDR incident/link changes that affect supersession. Peak observations and closed-to-closed timestamp corrections do not change counts. This covers live detection, pending confirmation, historical backfills/replays, audit deletion and DDR repairs without relying on the later `sync-stablecoins` completion clock. The summary stores every public membership row, including reviewed disputes. Verdict changes do not affect page membership or exact totals and need no count invalidation. The first exact read after invalidation rebuilds the grouped summary; cache population, filtered total and the page share one transactional D1 batch. Concurrent mutations cannot mix an older cached total with a newer page. `includeTotal=false` neither populates nor reads the summary and preserves observed lower-bound/cursor behavior. The summary is derived count data, never a freshness authority.

Each `pending` row's `expiresAt` is `firstSeenAt` plus the shared `getPendingExpiryLimitSec` limit for the published confirmation-family availability: base expiry when every category is available, extended expiry when any category is unavailable, and the severe limit for `extreme-move` candidates (see the timing table). This projection does not read the live primary quote; a same-direction primary may separately extend the confirmation cron's decision. The shared contract requires only `lastSeenAt >= firstSeenAt` and `expiresAt > firstSeenAt`; `lastSeenAt` may legitimately exceed the projected expiry.

When DDR links multiple rows into one incident, the public row uses the effective current fragment, selected by latest `current_started_at` then highest `current_event_id` across the canonical incident and its superseded aliases. It reports the canonical onset and total linked `constituentEventCount`. The first row supplies `startPrice`, `pegReference` and `onsetBasis` when its opening quote domain is known and matches the effective fragment's opening domain. Otherwise the three fields come from the effective fragment. Unprojected rows use `constituentEventCount = 1`.

For both fragments, a peer-relative opening uses USD. Otherwise the projection checks the provenance column, public JSON and legacy inference in that order. Inferring the first fragment's quote domain from a live opening with a unit reference requires a recognized peg type. The projected `onsetQuoteDomain` gives the display unit for the opening price and reference. The effective fragment retains its stored quote provenance. An unrecognized audit verdict in either provenance field or duplicate `auditVerdict` keys in public JSON disqualify a constituent from peak ranking and its severity from legacy onset admission.

A grouped incident reports the deepest discount or largest premium among its same-direction constituents with numeric stored deviations in the JavaScript safe integer range. It retains that peak when the effective fragment closes. The effective fragment supplies its own peak fields when it ties or is itself under a reviewed dispute. Otherwise the strongest constituent supplies the peak, its confidence tier and any validated reference or peer-relative evidence; a constituent that is itself under a reviewed dispute is never that strongest constituent (v6.54), so a family with one disputed fragment keeps its worst clean peak while its other reviewed-dispute treatment (PegScore ineligibility, empty admitted coverage, withheld analytic recovery, digest and social-briefing exclusion) is unchanged. Public provenance JSON takes precedence over the confidence column, as it does for individual events. Invalid constituent timestamps withhold that constituent’s peak receipt and admitted coverage evidence. A borrowed price requires a positive stored price and a validated peak quote domain or legacy quote provenance. For legacy peaks, the quote mode column and public provenance JSON take precedence over inference from the opening reference and a recognized peg type. An unreadable peg type leaves independently validated peak evidence available. The API publishes the deviation with a null price when the quote is malformed or its unit is uncertain. PegScore reads the event rows and resolver projection in one D1 batch. Legacy closure admission uses the onset fragment’s own peak to admit the opening and the effective fragment’s peak to admit its observations. The API carries both when they differ from their fallbacks, so the detail page applies the same rules to occupancy. Unreadable onset severity or a stored onset deviation outside the safe integer range withholds legacy onset admission and leaves admitted observations available. Severity and spread use the grouped peak and its confidence after admission.

Incident page synopses and search descriptions use `onsetBasis` for the opening comparison and `peakBasis` for the historical extreme. When `onsetQuoteFromLaterFragment` is present, they date the detector start and describe the peak separately. The page's record and summary label the price and its reference as later observations.

Public incident pages sort by effective `startedAt` descending, then numeric event `id` descending; offset selection, cursor comparisons/tokens, and the page's latest-event methodology `asOf` use that same projected onset rather than the current fragment's raw clock. Cursors use version 2; pre-cutover version-1 raw-onset tokens return `400` and callers must restart pagination. Canonical projection admission and event selection share one transactional D1 batch, together with count-summary population/read when requested. This also applies with `includeTotal=false`, so a pointer advance cannot mix an older projection with newer page membership or silently publish an unprojected fragment.

Rows may include a nullable `provenance` object with public replay/audit metadata (`sourceKind`, `replayRunId`, `replayVersion`, `sourcePriceProviders`, `quoteMode`, `pegReferenceSource`, `supplySource`, `confirmationPolicy`, `confirmationPointCount`, `confidenceTier`, `auditVerdict`, `pegScoreEligible`, `updatedAt`). Legacy rows return `provenance: null`.

A row whose coin is absent from the tracked catalog carries `retired: true`; such rows stay public history and are never filtered out. The tracked registry is the only authority, so the marker follows catalog membership rather than a stored list. Archive shards written before the marker existed gain it from the same check when read, without rewriting the captured shard bytes.

Cache: producer-backed profile (`s-maxage=300`, `max-age=60`, `stale-while-revalidate=300`). Freshness headers use the confirmed `sync-stablecoins` output timestamp with a 900s budget. Missing, unreadable, or invalid producer history returns `no-store` and unavailable freshness; event onset times are never a freshness fallback.

## Frontend

The [Depeg & Recovery board](https://pharos.watch/depeg/) opens with a 4-stage pipeline
jump strip (`Early Stress (DEWS) -> Live Incidents -> Recovery Forecast (DDR) -> Peg History`)
and a live "Now" hero pairing active incidents and signed worst deviation with the DEWS radar.
DDR recovery outlook and DDRR track-record summaries live in the resolver module header with
inline fired kill signals on terminal cards; detailed ML calibration tables stay collapsed
behind a one-row `Track Record` grading disclosure by default. The peg control board uses
`DataTableShell` with sticky clickable sort headers, a `Status` filter (`All`, `Active/Pending`,
`DEWS Alert+`, `At peg`), concise `at peg` occupancy sublines, and CSV/NDJSON/Markdown export.
The [permanent archive](https://pharos.watch/depeg/archive/) remains server-rendered for full
link crawlability with client-side coin, direction, and severity filters; individual
`/depeg/<event>/` pages include a visible breadcrumb back-link, a `Start -> Peak -> Recovery`
price-path bar, and human-readable close and quality labels. Sub-threshold detections remain in
the API and per-coin history. Route/crawl contracts live in
`docs/depeg-page.md#event-history-and-crawlability`; detail-history presentation lives in
`docs/stablecoin-detail-page.md`.

## Peg Stability Metrics (`peg-stability.ts`)

`computePegStability()` in `src/lib/peg-stability.ts` supports detail-history
streak/current-event metrics over full available history. It does not use
PegScore's four-year clamp; do not present its full-history occupancy/span as
the scored window.

The latest chronological terminal boundary, excluding reviewed-dispute verdicts
through the same `isPegScoreExcludedAuditVerdict` authority as Peg Score, is
classified with `classifyDepegClosure` before deriving recovery age.
`currentStreakDays` is available only for recovered
or legacy-recovered closures, including a genuine zero-day recovery; coverage loss,
superseded direction, removed tracking and unknown closure withhold it rather than
falling back to an older recovery. `latestClosure` preserves that distinction in
the view model. An open event remains a separate current-event state.

Detail history labels this duration **since last recorded recovery**, not an
uninterrupted at-peg streak. Both board `pegPct` and detail `recent90d.pegPct` are
visibly and accessibly qualified as record-derived occupancy estimates. The
recent window's `observedDays` is the calculation basis, not proof of continuous
observations; tracking closure can leave unobserved post-closure time. Specific
latest-closure disclosures require complete detail history. Compare's **Time at peg ·
up to 90d** row shows the same estimate with its floored basis (`Based on Nd`, `<1d`
for a positive sub-day basis), **Partial 90-day coverage** when `coverageLimited`, and
the caveat as its accessible description. These are presentation
qualifications only: the shared scorer, recent-stat calculations and numeric
producer contracts are unchanged.

## Peg Score (`peg-score.ts`)

PegScore uses recorded admitted intervals for incident duration and excludes scheduled blind time from the observed denominator. Legacy fallback can accept a confirmed in-session onset with unknown duration. Recent statistics require evidence in their own window. A point at the scoring boundary can establish an incident with zero elapsed duration. A valid declared hold matches the effective fragment’s last trusted observation and peak. The active penalty continues to use the incident’s grouped peak. The recorded detector onset remains visible alongside the first admissible observation.

The [public PegScore methodology](https://pharos.watch/methodology/#pegscore-dews-methodology)
owns the formula and components; `shared/lib/peg-score.ts` owns execution.
`derivePegAnalyticsSnapshot()` resolves tracking coverage through `coinTrackingStart()`
and passes its explicit scoring clock to `computePegScore()`. NAV admission stays
at that caller: NAV rows are omitted by default or included with a null PegScore.
Missing history without an anchor remains insufficient data, not a perfect score.
Detection contributes eligible episodes, observed price intervals and audit provenance:

- `false_positive` and `disputed` events are excluded. `no_data` remains eligible
  here but is excluded by DDR's separate policy. Unknown non-null verdicts fail
  closed; null legacy verdicts remain eligible. Low-confidence events retain
  occupancy impact with half-weight severity; the spread uses confidence-weighted
  mean and variance of below-peg peak deviations divided by the weight sum, so a
  half-weighted row keeps its observed peak instead of shrinking into artificial
  dispersion while premiums never dilute downside spread. Quality counters expose
  this. Safety Score’s exact replay retains the peak confidence and counts
  low-confidence scored peaks within each effective-fragment provenance class.
- `coinTrackingStart()` honors reviewed replay/continuous-live coverage first,
  otherwise launch date, then the earliest supply or durable valid-price anchor.
  Without these, the earliest event is the fallback; no anchor or events means NR.
  An assumed age anchor does not prove earlier incident-free coverage.
- Scoring uses the four-year clamp and requires seven known days after unknown
  event spans are removed. Fully blind occupancy is null, never 100% at peg.
- The 90-day companion starts at the later of its window boundary or tracking
  anchor and reports observed days, incidents, threshold crossings, peg percentage
  and coverage limitation under the same audit exclusions.
- An open lifecycle alone cannot activate the current-depeg penalty: it needs a
  trusted off-peg observation, no explicit gap and age ≤1200 seconds. Historical
  observed peaks still contribute severity/spread when current coverage is unavailable.
  A fresh legacy observation during a reference-market closure qualifies at the
  severe band of 2,500 bps in either direction. Recorded legacy off-peg intervals
  for severe moves contribute to both off-peg and observed time through the
  closure. Blind spans stay excluded. An explicit admitted-coverage ledger
  takes precedence, including an empty ledger.
- Since v6.49 `/api/peg-summary` publishes `pegScore`, `pegPct` and `recent90d`
  as null on a row with `currentPriceUnavailable: true` (no price row, a rejected
  price, or a nominal-only reference such as `protocol-par`), which names the reason,
  once the coin's daily price history (`supply_history.price`, observations only)
  holds no observed price on the current or previous UTC day: detection needs an
  observed price, so an event-free window without one is unobserved, not time at
  peg. A shorter miss keeps the score; a failed history read withholds it. Events,
  worst deviation, the active flag and tracking coverage stay published. The
  analytics producer keeps its event-derived values for Safety Score capture, which
  applies its own current-price admission.

## Edge Cases & Guardrails

| Scenario | Handling |
|----------|----------|
| Duplicate events | Unique index (`stablecoin_id`, `started_at`, `source`) + run-start repair; same-direction rows merge, opposite-direction rows close older directions without absorbing opposite-sign peaks |
| NAV tokens | Skipped (expected to appreciate, depeg detection N/A) |
| Supply < $1M | Skipped for live event recording (prevents micro-cap noise); detail UI may still show current price deviation with an explicit coverage-limited note; existing USD rows close with `close_reason = 'coverage-lost-supply'` when the primary price is usable and observed supply is below the floor |
| Supply unavailable (absent/empty/invalid buckets) | No new event; an existing lifecycle stays open without peak/recovery progress, records blind price coverage, and emits a per-asset warning |
| Missing/invalid prices | Multiple null/NaN/<= 0 checks |
| Peg reference validation | Must be finite and > 0 |
| DEX freshness | Affirmative aggregate evidence requires original and publication ages < 75 min; conservative vetoes retain their separate publication-age gates |
| Orphaned events | Closed with `close_reason = 'orphan-tracking-removed'` and `recovery_price = NULL` when coin drops off tracking |
| Non-USD threshold | 150bps accounts for FX noise and thin liquidity |
| Implausible native-currency quote | Withheld as unavailable evidence (`native-quote-above-peg-reference-band`, `native-quote-extreme-move`, or `native-quote-invalid`); an independent family must show its own implausible move in the same direction to admit it. It never opens, confirms, deepens or recovers an event |

### Trusted-price coverage and unresolved legacy spans (6.31)

Migration `0255_depeg_trusted_price_coverage.sql` adds nullable columns only; it records no historical observations. Detection persists trusted off-peg `intervals`, known `atParIntervals`, the latest trusted price clock, and `lastObservationKind` (`trusted-off-peg`, `trusted-at-par`, or `blind`). A trusted at-par observation advances the trusted clock but breaks off-peg continuity; `gapStartedAt` therefore marks a break in off-peg continuity, not necessarily blind time. Missing/unusable prices, unavailable supply/reference context, omitted assets, and gaps over 1200 seconds break observation continuity. State transitions and resumption start zero-length endpoints; only subsequent continuous observations in the same trusted state extend their intervals. Pending promotion starts evidence at confirmation, not inside unrecorded pending history. Malformed stored coverage warns with the row ID and becomes unknown; producer writes remain strictly validated. Unchanged omitted-asset blind coverage does not trigger another UPDATE.

For pre-migration **open** events, the entire uninstrumented span is explicitly unknown. The first post-migration trusted observation does not backfill the preceding span. Closed legacy and historical replay rows retain their recorded episode durations; their internal price-gap boundaries remain unreconstructable. Instrumented rows retain coverage intervals when closed. Recovery time bounded by consecutive trusted at-par endpoints is known at-par time; unrecorded transition/recovery spans remain unknown rather than automatically off peg.

The single `mergeDepegSeconds` authority counts recorded off-peg intervals only. The complement of both off-peg and at-par intervals inside each scored event is `unknownCoverageSeconds`; overlapping unknown spans merge and trusted intervals from another row take precedence. Unknown time is excluded from both off-peg time and the occupancy denominator, including recent 90-day statistics, and from duration severity. It is neither zero deviation nor verified at-peg time. `pegPct` is nullable when the known denominator is empty; `pegScore` is NR when fewer than seven known days remain. Public event `priceCoverage` and summary `unknownCoverageSeconds` expose this distinction, and exact Safety Score peg provenance retains it.
