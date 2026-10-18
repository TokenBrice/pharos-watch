# Yield Intelligence Operations

This guide owns diagnosis, coverage-queue handling, and slot recovery for yield producers. Wire, freshness, admission, and publication-failure invariants are owned by the [Yield Engineering Contract](./yield-intelligence.md#engineering-contract); operator thresholds and status interpretation by the [Yield Health runbook](./runbooks/yield-health.md#threshold-table).

## Slot Context

- `sync-yield-data` runs on the dedicated `55 * * * *` trigger after the `:52` Safety Score V9 publication. The publication chain is serial: supplemental catch-up (neutral skip while the newest family marker is younger than four hours), gated benchmark retry, then yield publication. When catch-up actually runs, the benchmark retry returns `skipped_neutral` with `deferred-after-supplemental-catch-up` so both recovery legs do not stack before publication. Otherwise the retry checks last market fetch age against 24 hours, USD separately, and USD/USD_EFFR/GBP observation age against their refresh-ahead bounds. An independent RPC-parity chain runs alongside it: the trigger's declared peak is four connections (supplemental three plus parity one). Schedules and chain ownership live in `shared/lib/cron-jobs.ts`, `shared/lib/scheduled-runner-registry.ts`, and `worker/src/handlers/scheduled/hourly-yield.ts`; DEWS / PSI remains on its separate lane.
- The single hourly expression is deliberate: Cloudflare caps sub-hourly Cron expressions at 30 seconds of CPU, insufficient for this source/publication graph. Mid-`source-resolution` kills can leave non-heartbeating slots and synthesized `platform-abandoned` runs. A sub-hourly cadence requires the paired-trigger form used by `halfHourlyChartsOffset` and another physical trigger under the [cron trigger policy](./process/cron-trigger-policy.md).
- `sync-yield-supplemental` runs on its own slower `25 */4 * * *` trigger and feeds a cache snapshot that the post-V9 publisher consumes; the four-hour slot stays the primary supplemental producer, and the hourly invocation is only a catch-up.
- The post-V9 publisher owns `yield-rankings` freshness and normally consumes cached supplemental evidence; a due hourly catch-up can still add upstream work before publication.
- Catch-up cadence and artifact availability are separate. A recent timestamp alone returns the generic `supplemental-catch-up-marker-not-due` admission skip, which cannot clear an earlier artifact failure. Only a successful readback of every registered family payload, with exact cache/payload timestamps inside the four-hour budget, valid unfiltered rows/counts and source identity, earns `supplemental-catch-up-not-due` in the shared proven-satisfied vocabulary. Metadata includes the validated family timestamps/hashes. Missing, malformed, stale or future family evidence cannot earn that identity; a failed D1 read propagates, never proves availability. Neither skip publishes output.
- Pendle cadence/backoff and retired supplemental cleanup prerequisites belong to the [supplemental incident procedure](./runbooks/yield-supplemental-snapshot.md#common-causes).

## Runtime Guardrails

| Symptom | Diagnostic owner |
| --- | --- |
| Supplemental family missing, empty, retained or rate-limited | [Supplemental Snapshot](./runbooks/yield-supplemental-snapshot.md#common-causes) |
| Benchmark fallback, GBP attempts or fresh-publication canaries | [Benchmark remediation](./runbooks/yield-benchmark-fallback-stale.md#remediation) |
| Deterministic all-fail or cooldown | [Health cooldown branch](./runbooks/yield-health.md#deterministic-all-fail-cooldown) |
| All rows Safety NR after a scoring rollout | [Safety Identity Mismatch](./runbooks/yield-rankings-stale-or-missing.md#safety-identity-mismatch) |
| Audit backlog or stale pins | [Coverage Audit Queue](#coverage-audit-queue) |

- The independent RPC-provider parity lane reports successful bounded collection as execution `ok` when at least one chain was attempted and samples were produced, even if its deadline truncated the remaining rotation. `metadata.truncated` and `deadlineHit`, attempted/headOk/skipped counts, sample errors, and retained skipped-chain reasons preserve incomplete observation coverage; `ok` does not claim full parity or a healthy provider circuit. A deadline with no attempted/sample evidence remains degraded with `rpc-parity-deadline-exhausted`; returned abort and store failures retain their existing degraded reasons. An aborted outer job signal still rejects to the slot fence.
- Parity selects at most 13 chains per hourly invocation under the unchanged four-minute wall cap. A deterministic UTC-hour position in a three-hour window advances by one third of the roster, so every registered chain is selected within any three consecutive delivered hourly runs (maximum roster capacity 39). `metadata.rotation` records position, window start, selected chains, roster size and cap; deadline truncation records `truncationReason`. Selection is not observation: timeouts, aborts, missing comparators and credit denial retain their reasons and cannot establish successful three-hour observation coverage.
- Deterministic on-chain vault reads now run one asset at a time with a 6 second per-RPC timeout, explicit per-URL failover, and an explorer-proxy fallback for supported EVM chains when Worker RPC reads all return empty. HTTP failures advance directly to the next RPC URL, while thrown transport failures retain their bounded retry allowance.
- When both a provider RPC and a public fallback are configured for a deterministic yield source, the reader probes the fallback/public URL first to avoid inheriting a sticky provider failure across the whole post-V9 slot.
- The post-V9 yield runtime forwards `ETHERSCAN_API_KEY` into deterministic reads so Ethereum-family explorer proxies can keep the publication path alive during transient Worker-to-RPC outages.
- A pre-publication Safety Score V9 identity rollover logs `yield-safety-identity-changed-before-publish` and `safetyIdentityChangedBeforePublish`. Confirm next-hour realignment under [failure semantics](./yield-intelligence.md#failure-semantics); blocking on rollover would pin an older, equally mismatched cache.
- Deterministic yield run metadata now splits RPC-vs-explorer failure buckets (for example `rpc-empty|etherscan-empty`) and records how many explorer fallbacks were attempted versus how many actually resolved.
- Repeated deterministic all-fail runs that are fully masked by non-onchain coverage now arm a 6-hour cooldown after the second consecutive masked failure. The cooldown skips the deterministic lane on the post-V9 publisher until either the cooldown expires or non-onchain coverage gaps reappear.
- Single-coin optional adapters are time-boxed to 12 seconds by `worker/src/cron/yield-sync/sources-rpc.ts`; `TRACKED_OPTIONAL_SOURCE_REGISTRY` and `STANDALONE_TRACKED_OPTIONAL_SOURCE_REGISTRY` in `worker/src/cron/yield-sync/sources-optional.ts` own the current adapter roster.
- `sync-yield-data` now also respects the operator pause guard `cache["yield-history-cleanup:writer-pause"]`. When that key is armed for a cleanup window, the post-V9 publisher returns a degraded no-op result instead of purging or rewriting parent-owned history during the operator mutation.
- For safety/common-input holds or coverage alarms, inspect `inputDiagnostics`, accepted safety identity/age, and `metadata.quality` under the [publication contract](./yield-intelligence.md#persistence-and-publication) and [failure semantics](./yield-intelligence.md#failure-semantics). Preserve prior evidence and diagnose the named input; do not hand-repair supply or ratings to clear a hold.
- supplemental candidate dedupe now keys on source identity plus asset identity, not bare `sourceKey` alone, so same-chain families such as Aave V3 cannot collapse multiple coins into one cached row.
- `sync-yield-supplemental` metadata now reports raw candidate count, deduped candidate count, and dropped-row count so silent row loss is visible in cron history; per-family `sourceFamilySummaries[*].dedupeDiscardedValues` records bounded examples of what identity-dedupe discarded.
- For aging observations or comparison anchors, use the [source-class warning budgets](./yield-intelligence.md#warning-signals-phase-2) and [response-time aging contract](./yield-intelligence.md#persistence-and-publication). Inspect stale-anchor examples with their source-specific `maxAgeSeconds`; publishing a new cache is not an upstream refresh.
- Inspect the compact, 4 KB selected-source alternatives ledger via [Source Decision Evidence](./runbooks/yield-rankings-stale-or-missing.md#source-decision-evidence), not an assumed full replay log.
- post-V9 publication loads previous-best and previous-TVL history through indexed point reads scoped to the coins and source keys resolved in the current run. It does not materialize broad previous-row candidate sets before evaluation.
- `yield-publication:coverage-regression:total` is a permanent, non-vetoing source-quality mix alarm, not a pending blocking feature; the [publication contract](./yield-intelligence.md#persistence-and-publication) owns its thresholds. Diagnose direct-to-modeled substitution without suppressing independent valid rows.
- During V9 rollouts, diagnose `yield-safety-hydration-stale` and `yield-safety-unrated-serving:*` through [Safety Identity Mismatch](./runbooks/yield-rankings-stale-or-missing.md#safety-identity-mismatch); the [failure contract](./yield-intelligence.md#failure-semantics) owns compatibility and original-clock fallback bounds.
- Protocol API families use an 8 second per-request timeout, no retries, and a 25 second family budget:
  - `Morpho`
  - `Pendle`
  - `Yearn/Kong`
  - `Beefy`
  - `Royco Dawn`
- Optional RPC families use a 30 second family budget on the supplemental lane (28 seconds for Aave V3), a 10 second per-attempt ceiling, and alternating fallback/primary endpoint order across targets. A target may only spend its fair share of what is left of the family budget (`remaining budget / remaining targets`; the Aave lane shares the same way across batches, because a concurrent batch is what consumes family wall-clock) and that share is split across the target's endpoints, so one hot endpoint cannot absorb the family burst: a stalled or failing URL fails over to the next endpoint instead of being retried, every endpoint is attempted once before any of them is retried again, and a further pass runs only while the target's share still fits a whole endpoint attempt. A stalled target therefore gives its remaining share back to the inventory instead of starving the remaining targets, and HTTP failures still advance directly to the next URL:
  - `Compound V3`
  - `Aave V3`
- Optional RPC family metadata now records target counts, attempted counts, resolved target counts, emitted row counts, missing target counts, chain-level miss breakdowns, miss reasons, bounded missing-target examples, and whether the family budget exhausted before all targets were attempted. `sourceCoverage.sourceFamilySummaries` carries a compact per-family status/raw/emitted/inventory/budget view for operator triage; `sourceCoverage.sourceFamilyInventoryCounts` keeps audit-only inventory volume separate from candidate-oriented `sourceFamilyCounts`. Detailed `optionalRpcTelemetry` keeps the same counters but caps missing-target examples to avoid oversized cron metadata.
- the audit's pool-backed queue kinds are deduped by pool id, `missing-protocol` items are one representative pool per known non-lending protocol above the $5M floor (unknown categories stay in the high-TVL queue so the `lending-allowlist` derivation is unchanged), native exact-pool candidates are grouped per tracked asset (`native-exact-pool:<stablecoinId>`), source-family projects no longer appear in pool-level buckets, and curated `AUTO_LENDING_POOL_MAP` / `YIELD_VARIANT_MAP` / `YIELD_WEIGHTED_POOL_GROUPS` pins are audited too — a pin whose pool disappeared queues as `stale-auto-lending-override` with reason codes `missing-pool` plus `coverage-outage` or `dead-config`, counted in `deadCuratedPinCount` and announced by the `curated-pin-missing` cron event.
- The empty generic-quarantine reprobe producer has been retired. New audits no longer emit restoration summaries or `quarantine-ready-to-restore` candidates. Retained cached reports and historical disposition text remain readable until a named fresh report with full pre-cap zero-current-kind evidence closes the decoder floor. Removing BIMA's consumed variant clears its stale queue item only in a new normal monthly report or separately authorized leased refresh, never by an hourly publication alone.

- Benchmark transport attempts, registry-write diagnostics and canary streak readback are owned by [benchmark remediation](./runbooks/yield-benchmark-fallback-stale.md#remediation).

## Yield Health Thresholds

`/api/status` exposes these checks under `yieldHealth`; the admin Pipeline card renders the same fields. The threshold table, per-surface impact, and inspection commands live in the [Yield Health runbook](./runbooks/yield-health.md#threshold-table).


## Coverage Audit Queue

The monthly coverage-audit schema can consume durable, evidence-fingerprinted review dispositions and reports `operatorQueue.persistence="durable"`. D1 read/upsert helpers exist, but no production admin route or current operator workflow writes dispositions. The supported drain workflow is therefore read-only: classify items in the monthly scratch note and implement accepted source/config changes directly. If a disposition has been populated by a future supported writer, unchanged evidence stays suppressed until its review or expiry boundary and decision-relevant evidence reopens it. A stored `accept` disposition records evidence only; it never mutates adapters or allowlists. `/api/status` exposes the bounded visible queue under `yieldHealth.coverageAudit.headlineGaps` and `yieldHealth.coverageAudit.recommendationCandidates` so the admin card can show representative items without loading the full cache payload.
The queue is permanently DISPLAY-ONLY (`coverageAudit.queueDisplayOnly`); no disposition UI/API is authorized. `queueTotals.totalItemCount` is the full visible pre-cap cohort, `publishedItemCount` is the report's bounded rows, and `truncatedItemCount` is their difference: visible = published + truncated, candidate = visible + suppressed. `byKindScope: "full-visible"` names pre-cap visible by-kind totals; legacy `published-sample` counts describe only published rows. Status samples six rows per side and the report queue twenty, so neither sample is a total. Existing historical evidence-fingerprinted dispositions remain readable.

Health's `queueBudgetBasis: "post-disposition"` uses `operatorReviewSummary.visibleHeadlineGapCount` and `visibleRecommendationCandidateCount` before truncation; legacy reports declare `"raw-detectors"` until refreshed. Dead-pin/restoration entries count once. Status shows at most six per side, report queues twenty, and applicable raw headline arrays fifty; these are samples. `staleVenueRiskScores` is registry-derived and uncapped.

`venue-risk-config-missing` needs sourced venue evidence; `stale-venue-risk-score` needs a fresh review. For `stale-auto-lending-override`, remove/repoint the pin or document a reviewed bypass. `missing-pool` with `coverage-outage` is an incident; `dead-config` is cleanup. Classify due lifecycle reviews in the same audit cycle. Retained restoration decoders/fingerprints/disposition text survive until a named fresh report proves full pre-cap zero-current-kind evidence; hourly publication cannot clear a monthly cached item.

| Action | Use when | Follow-up |
| --- | --- | --- |
| `accept` | The candidate is a real coverage improvement with enough evidence to implement | Open or land the config/runtime change with focused tests and docs |
| `dismiss` | The item is a duplicate, false positive, unsupported shape, or already covered through another source | Record the reason in the audit note; no cache or D1 mutation |
| `intentional-gap` | The asset or venue should remain explicitly uncovered until a reliable APY/source path exists | Add or confirm an intentional manifest gap with rationale when a code change is warranted |
| `watch` | The item is plausible but needs another cycle, more TVL, better timestamps, or venue review | Leave it visible for the next monthly audit and note the condition to re-check |

The admin queue rows are read-only and there are no `accept`/`dismiss` controls. Do not imply that a scratch-note classification was persisted, and do not edit `yield-rankings` or source-risk fields to clear the queue; fix the source config, add an intentional gap, or leave the item on watch. Adding an operator writer requires an authenticated mutation path, audit logging, and an update to the drain workflow.


## Adapter lifecycle states

Each yield-bearing adapter sits in one of four lifecycle states tracked by `YIELD_ADAPTER_LIFECYCLE` in `worker/src/lib/yield-config/yield-config-rate-sources.ts`. The monthly coverage audit emits a `lifecycleSummary` count plus bounded `quarantinedAdapters` and `intentionalGaps` lists in the `yield-coverage-audit` cache so operators can act on structured reasons (`code`, `since`, optional `nextReviewAt`, `note`).

| State | Use when | Operator classification cue |
| --- | --- | --- |
| `active` | Adapter ships an APY through the normal publication path | Default; no override needed |
| `quarantined` | Adapter is intentionally disabled pending reviewed evidence | Preserve typed lifecycle diagnosis for real adapters; scrvUSD/USTB generic prospects are final exclusions, not restoration work |
| `intentional-gap` | Asset is yield-bearing but no reliable runtime APY source exists yet | Add a typed reason in `INTENTIONAL_GAP_REASONS_TYPED` with a stable `code` such as `no-public-yield-source`, `off-chain-account-product`, `issuer-distributed-yield`, or `pre-launch` |
| `experimental` | Adapter is in trial; results should not block publication or alerts | Use sparingly while validating a new on-chain reader or rate source |

When promoting an adapter out of `quarantined` or `intentional-gap`, remove the typed entry (the legacy string map derives from the typed map, so a single edit propagates). Always set `since` to the date the lifecycle change happens; set `nextReviewAt` when the gap is expected to be revisited soon.

When a lifecycle review date comes due and the adapter stays quarantined or intentionally uncovered, update the typed reason `note` with the review date and disposition, then move `nextReviewAt` to the next concrete review window. Past-due dates are no longer advisory-only: the audit publishes `reviewDueAdapters` / `lifecycleReviewDueCount` and emits the `lifecycle-review-due` warning cron event, so a review that comes due is visible on the operator surface in the same cycle. Do not leave past-due review dates in the registry after a coverage-drain pass.

## Source Configuration

`ON_CHAIN_RATE_CONFIGS`, `RATE_DERIVED_CONFIGS`, and typed lifecycle gaps in [yield-config-rate-sources.ts](../worker/src/lib/yield-config/yield-config-rate-sources.ts), native/variant pool registries, and per-coin `yieldConfig` own current coverage. Configured paths do not imply a published APY or Safety Score eligibility.

- ERC-4626 reads use one whole share in share decimals, decode asset decimals, and preserve rate history before annualizing. Only USD-underlying `totalAssets` is USD TVL; EURCV is not.
- Saturn sUSDat NAV includes preferred-credit valuation as well as income: gains/losses do not certify a cash savings rate. The USDat parent remains non-yield-bearing.
- Axis's selector/padded-call evidence is in `worker/src/lib/yield-config/yield-config-rate-sources.ts:95` (block `26108099`); Steakhouse USDG's exact native UUID and Robinhood transport rationale are in `worker/src/lib/yield-config/yield-config-pools.ts:11`.
- Price-derived eligibility reads priced `supply_history` with a 7–45-day anchor, not a proposed CoinGecko endpoint. Configuration without priced history cannot publish APY.
- Distributed shares/rebases cannot be measured by stable NAV growth. Native-currency returns need native-currency evidence; USD price appreciation includes FX or gold movements. XGLD's configured XAUt-denominated reader is issuer-administered NAV, not reconciled strategy income. CHF SAFO still needs a reviewed native-CHF NAV-history adapter.

### Historical Ownership Cutover

The live Falcon savings pool and exchange-rate config move from `usdf-falcon` to `susdf-falcon`, and the obsolete parent variant is removed. USDf and xDAI already have no holder-yield flag or `yieldConfig`, so their metadata stays unchanged. The Gnosis pool `13392973-be6e-4b2f-bce9-4f7dd53d1c3a` moves from `sdai-sky` to `sdai-gnosis`; the Ethereum Sky rate remains owned by `sdai-sky`.

No historical database rows are rewritten by these config changes. Before any operator-led history migration, identify Falcon records by the sUSDf pool UUID or legacy `onchain:usdf-falcon` key, and review whether to move them to `susdf-falcon` / `onchain:susdf-falcon`. For sDAI, review only records tied to Gnosis pool UUID `13392973-be6e-4b2f-bce9-4f7dd53d1c3a` under `sdai-sky`. Never bulk-relabel `sdai-sky` history: its `onchain:sdai-sky` series belongs to the distinct Ethereum vault. Historical decisions and publication evidence need a coordinated, reviewed cutover rather than ad hoc D1 updates.

For Saturn, review any historical yield rows under `usdat-saturn` against the exact Ethereum sUSDat contract `0xd166337499e176bbc38a1fbd113ab144e5bd2df7` before assigning them to `susdat-saturn`. Do not move USDat supply or price history, and do not infer sUSDat ownership from a parent symbol alone. No D1 migration or historical backfill is part of this source cutover.

## Decision Ledger Retention (v8.14)

- Every stored `yield_source_decisions` row is tagged with a final `retention_reason` of `trend` or `audit`.
- Source switches are permanent `trend` rows. For anomaly or rejected-higher-confidence evidence, only the first row of a new evidence fingerprint is a permanent `trend`; unchanged hourly repetitions are `audit`. A resolved and later recurring fingerprint creates a new boundary row.
- `audit` decisions older than 30 days are pruned by `pruneYieldTables` after an applied publication only when required-input quality is clean and safety is not held. Imperfect or held-safety publications suppress destructive decision cleanup; no additional trigger is used.
- Retained public alternates live in the sibling `yield_source_decision_alternatives` table; cleanup explicitly removes orphaned alternates older than 30 days after decision pruning. There is no foreign-key cascade.
- The compact `alternatives_json` blob and typed `yield_source_decision_alternatives` rows are both written by each publication. There is no `/api/yield-source-decisions` read endpoint; use two direct D1 queries (see [`runbooks/yield-rankings-stale-or-missing.md`](./runbooks/yield-rankings-stale-or-missing.md)).
- Modern linked-variant and protocol-specific on-chain source keys are never normalized to `onchain:<stablecoinId>` merely because they carry an exchange rate. Only null/`legacy-best` history and the explicit LUSD `bprotocol-lqty-only` legacy alias normalize. Historical linked-variant false-switch rows are reclassified to `audit` only after two consecutive published generations select the linked identity with `source_switch = 0`; normal audit retention then removes the corrected noise.

`cleanupFalseLinkedVariantSourceSwitches` in `worker/src/cron/yield-sync/history.ts` owns the ranked-generation index pin and range-scan rationale; preserve that source-level constraint when changing cleanup.

Yield history keeps full hourly rows for the newest 30 days and one close-of-day row per stablecoin/source for days 31–365 in `yield_history_daily`. The API merges both tiers without duplicating a day and continues to use raw rows while a historical day has not yet been materialized. Daily materialization precedes any later raw-row cleanup.

The materializer drains at most 1,000 missing or newer daily closes per run below the 30-day raw cutoff, including cold-start and below-watermark backlogs. Raw observations are never pruned before a daily close at least as new exists for their source/day. Work beyond the cap stays in raw history for later runs; deleted values are never synthesized.

The E2-F1 recovery drain is **pending deployment**, not an executed backfill. Measure outstanding retained source-days with the assessment SELECT below; the 1,000-close-per-run materializer cap applies only below the 30-day raw cutoff. Newer closes wait until eligible. Elapsed hourly runs alone do not prove completion.

```sql
WITH raw_days AS (
  SELECT stablecoin_id, source_key,
    CAST(recorded_at / 86400 AS INTEGER) * 86400 AS day,
    COUNT(*) AS raw_rows, MAX(recorded_at) AS latest
  FROM yield_history
  WHERE publication_state IS NULL OR publication_state = 'published'
  GROUP BY stablecoin_id, source_key, day
)
SELECT COUNT(*) AS source_day_rows,
  SUM(r.raw_rows) AS raw_rows_covered,
  COUNT(DISTINCT r.day) AS utc_days,
  MIN(date(r.day, 'unixepoch')) AS first_day,
  MAX(date(r.day, 'unixepoch')) AS last_day,
  SUM(CASE WHEN d.stablecoin_id IS NULL THEN 1 ELSE 0 END) AS missing_daily_rows,
  SUM(CASE WHEN d.stablecoin_id IS NOT NULL THEN 1 ELSE 0 END) AS daily_rows_needing_newer_close
FROM raw_days r
LEFT JOIN yield_history_daily d
  ON d.stablecoin_id = r.stablecoin_id
  AND d.source_key = r.source_key AND d.snapshot_date = r.day
WHERE r.day < CAST(unixepoch('now') / 86400 AS INTEGER) * 86400
  AND (d.stablecoin_id IS NULL OR d.recorded_at < r.latest);
```

This is the assessment's `closedBackfillVolume` query; to assess only the currently eligible drain, replace the closed-day bound with `r.day < CAST((unixepoch('now') - 30 * 86400) / 86400 AS INTEGER) * 86400`. Legacy non-published raw rows are never compacted: only null legacy publication state or explicit `published` rows enter materialization.

Continuity gaps do not prove lost observations: source inactivity may explain them, and an assessment limited to retained raw/daily evidence is not a global upper bound. Deleted values must never be synthesized.

## Failure Semantics

The [engineering publication contract](./yield-intelligence.md#persistence-and-publication) owns applied/unapplied results, atomic generation/sentinel writes, admission, and cleanup eligibility; [engineering failure semantics](./yield-intelligence.md#failure-semantics) owns unavailable inputs and safety fallback. For diagnosis:

- Start with the [shared read-only status/cron checks](./runbooks/yield-health.md#first-checks). Read `metadata.quality.reasons` / `advisoryReasons` separately from `metadata.reason` and inspect the latest concrete cache/dependency reason, not a generic degraded streak.
- For a fully failed deterministic lane, compare alternative coverage and follow [Deterministic All-Fail Cooldown](./runbooks/yield-health.md#deterministic-all-fail-cooldown).
- For optional-source budget warnings, inspect family/target telemetry above. Core deterministic, curated DeFiLlama, price-derived, and rate-derived paths may remain available; do not move heavy optional fetches into the publisher to replace a missed family.
- For partial supplemental coverage, inspect the per-family snapshots and `yield:supplemental-source-run:v1` outcomes in [Supplemental Snapshot](./runbooks/yield-supplemental-snapshot.md). `retained-previous` names a failed family, not a successful empty result. Retired aggregate rows are never recovery authority.
- For `publication-skipped`, aborts, or abandoned staging, compare cache-advertised identity with [Source Decision Evidence](./runbooks/yield-rankings-stale-or-missing.md#source-decision-evidence). Confirm repair/readback against the winning published generation; never finalize or replay a losing attempt by hand.
- For `no-yield-bearing-coins`, inspect active tracked-asset/config input and the `yield-sync-no-yield-bearing-coins` event rather than interpreting the run as successful empty coverage.
- For safety NR/default rows, inspect their published `safetyReason` and use [Safety Identity Mismatch](./runbooks/yield-rankings-stale-or-missing.md#safety-identity-mismatch) before deciding whether the issue is an individual card or common publication evidence.
