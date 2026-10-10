# Yield Intelligence Operations

This guide owns diagnosis, coverage-queue handling, and slot recovery for yield producers. Wire, freshness, admission, and publication-failure invariants are owned by the [Yield Engineering Contract](./yield-intelligence.md#engineering-contract); operator thresholds and status interpretation by the [Yield Health runbook](./runbooks/yield-health.md#threshold-table).

## Slot Context

- `sync-yield-data` runs on the dedicated `55 * * * *` trigger after the `:52` Safety Score V9 publication. The publication chain is serial: supplemental catch-up (neutral skip while the newest family marker is younger than four hours), gated benchmark retry, then yield publication. When catch-up actually runs, the benchmark retry returns `skipped_neutral` with `deferred-after-supplemental-catch-up` so both recovery legs do not stack before publication. Otherwise the retry checks last market fetch age against 24 hours, USD separately, and USD/USD_EFFR/GBP observation age against their refresh-ahead bounds. An independent RPC-parity chain runs alongside it: the trigger's declared peak is four connections (supplemental three plus parity one). Schedules and chain ownership live in `shared/lib/cron-jobs.ts`, `shared/lib/scheduled-runner-registry.ts`, and `worker/src/handlers/scheduled/hourly-yield.ts`; DEWS / PSI remains on its separate lane.
- The single hourly expression is deliberate. Cloudflare caps Cron expressions with intervals below one hour at 30 seconds of CPU time, and the yield source and publication graph needs several minutes of runtime. A twice-hourly expression (`28,58` and then `24,54`) took the lane down on 2026-08-18: every invocation was killed mid `source-resolution`, leaving slots that never heartbeat and `cron_runs` rows synthesized as `platform-abandoned`. Restoring a sub-hourly cadence requires the paired-trigger form used by `halfHourlyChartsOffset`, which needs a physical trigger beyond the reviewed budget in `docs/process/cron-trigger-policy.md`.
- `sync-yield-supplemental` runs on its own slower `25 */4 * * *` trigger and feeds a cache snapshot that the post-V9 publisher consumes; the four-hour slot stays the primary supplemental producer, and the hourly invocation is only a catch-up.
- The post-V9 publisher owns `yield-rankings` freshness and normally consumes cached supplemental evidence; a due hourly catch-up can still add upstream work before publication.
- Pendle uses the free unkeyed API, with no bearer header. Its lane normally fetches on a 24-hour cadence and reuses `yield:supplemental-sources:v1:pendle` between fetches (`familyCacheResults.pendle = "skipped-not-due"`). `fetchPendleMarketSources` in `worker/src/cron/yield-sync/sources-optional-protocols-supplemental.ts` owns chain pagination; request count is not fixed to one page per chain. On 429, the lane persists `yield:supplemental-sources:v1:pendle-backoff`: the longest applicable `Retry-After`/reset delay wins, weekly reset is considered for weekly exhaustion or absent quota evidence, and the bound is seven days (24-hour default without usable headers). A skip is neutral while retained evidence remains inside 48 hours; expired evidence reports `pendle-rate-limited-backoff`. The cadence/backoff gate depends on readable, successfully persisted D1 state; state-read failure is explicitly logged and permits an ungated fetch.
- vaults.fyi has been retired from both supplemental entrypoints. No provider probe, exact-vault allowlist, runtime env control, or credit-ledger writer remains. Historical source classification and links are retained; secret deletion and archived cache/circuit cleanup are separate post-deploy operations.

## Runtime Guardrails

- Deterministic on-chain vault reads now run one asset at a time with a 6 second per-RPC timeout, explicit per-URL failover, and an explorer-proxy fallback for supported EVM chains when Worker RPC reads all return empty. HTTP failures advance directly to the next RPC URL, while thrown transport failures retain their bounded retry allowance.
- When both a provider RPC and a public fallback are configured for a deterministic yield source, the reader probes the fallback/public URL first to avoid inheriting a sticky provider failure across the whole post-V9 slot.
- The post-V9 yield runtime forwards `ETHERSCAN_API_KEY` into deterministic reads so Ethereum-family explorer proxies can keep the publication path alive during transient Worker-to-RPC outages.
- A pre-publication Safety Score V9 identity rollover is logged as `yield-safety-identity-changed-before-publish` and `safetyIdentityChangedBeforePublish` in cron metadata. During an evaluator-incompatible rollover, inspect the [publish-time safety fallback contract](./yield-intelligence.md#failure-semantics) and confirm that the next hourly run re-aligns; reverting to the pre-2026-08-19 blocking behavior would pin an older, equally mismatched cache.
- Deterministic yield run metadata now splits RPC-vs-explorer failure buckets (for example `rpc-empty|etherscan-empty`) and records how many explorer fallbacks were attempted versus how many actually resolved.
- Repeated deterministic all-fail runs that are fully masked by non-onchain coverage now arm a 6-hour cooldown after the second consecutive masked failure. The cooldown skips the deterministic lane on the post-V9 publisher until either the cooldown expires or non-onchain coverage gaps reappear.
- Single-coin optional adapters are time-boxed to 12 seconds by `worker/src/cron/yield-sync/optional-source-runtime.ts`; `TRACKED_OPTIONAL_SOURCE_REGISTRY` and `STANDALONE_TRACKED_OPTIONAL_SOURCE_REGISTRY` in `worker/src/cron/yield-sync/tracked-optional-source-registry.ts` own the current adapter roster.
- `sync-yield-supplemental` owns the heavier best-effort families. It writes per-family cache rows (`yield:supplemental-sources:v1:<family>`) for the surviving `SUPPLEMENTAL_SOURCE_FAMILY_KEYS` registry, including explicit empty rows for successful families with no candidates. The retired unsuffixed aggregate is retained pending separate cleanup and is neither written nor read.
- Each supplemental run also writes one outcome row, `yield:supplemental-source-run:v1`, recording per-family write results (`published`, `skipped-newer`, `empty`, `empty-published`, `retained-previous`, plus the neutral `skipped-not-due` / `skipped-backoff` for the daily Pendle lane) plus `degradedFamilies` and, when the producer knows it, the machine-readable `degradedFamilyReasons`. A family whose upstream fetch failed mid-run skips its cache write, keeps the previous snapshot (`retained-previous`), and is named there — a fresh empty write never masks a partial outage.
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
- The post-V9 publisher loads fresh per-family supplemental caches, so a malformed, stale, or missing family suppresses only that family while other valid families can still publish optional rows. A valid all-empty family snapshot is available state with zero supplemental candidates; there is no aggregate-cache fallback.
- Aave, Beefy, and Royco each cap concurrent outbound work at three. Aave refreshes pinned Ethereum USDC, Arbitrum USDT, and Base USDC reserves plus three rotating tracked-contract targets in two batches within its 28-second deadline; long-tail probes do not imply continuous reserve coverage.
- the monthly yield coverage audit now counts explicit auto-lending overrides and curated exact-pool overrides as covered DL surfaces, and its high-TVL gap list is scoped to unsupported protocol families so the report stays actionable.
- the audit's pool-backed queue kinds are deduped by pool id, `missing-protocol` items are one representative pool per known non-lending protocol above the $5M floor (unknown categories stay in the high-TVL queue so the `lending-allowlist` derivation is unchanged), native exact-pool candidates are grouped per tracked asset (`native-exact-pool:<stablecoinId>`), source-family projects no longer appear in pool-level buckets, and curated `AUTO_LENDING_POOL_MAP` / `YIELD_VARIANT_MAP` / `YIELD_WEIGHTED_POOL_GROUPS` pins are audited too — a pin whose pool disappeared queues as `stale-auto-lending-override` with reason codes `missing-pool` plus `coverage-outage` or `dead-config`, counted in `deadCuratedPinCount` and announced by the `curated-pin-missing` cron event.
- The empty generic-quarantine reprobe producer has been retired. New audits no longer emit restoration summaries or `quarantine-ready-to-restore` candidates. Retained cached reports and historical disposition text remain readable until a named fresh report with full pre-cap zero-current-kind evidence closes the decoder floor. Removing BIMA's consumed variant clears its stale queue item only in a new normal monthly report or separately authorized leased refresh, never by an hourly publication alone.

- `fetch-tbill-rate` metadata includes bounded GBP `gbpResponseAttempts` entries for FRED, ALFRED, and BoE attempts: provider, status, content type, byte count, parse result, record date, and stable failure class. It never records response bodies or URLs. FRED and ALFRED graph requests use the contact-bearing `Pharos/1.0 (+https://pharos.watch)` user agent. The `yield-gbp-benchmark-current` canary requires a direct GBP observation fetched within 48 hours, a record date within the shared GBP bound (five days), and two consecutive fresh publications; hourly retries can contribute to that streak.
The same metadata carries `registryCacheState`, `registryCacheWrite`, and `resolvedBenchmarkKeys` (an unreadable prior registry row is skipped — left unwritten, `registryCacheWrite: "skipped-unreadable-cache"` in `worker/src/cron/fetch-tbill-rate.ts` — only when the run resolved zero benchmark keys; any resolved key rewrites the row), and the USD fields `usdFreshPublicationStreak` / `usdLastFresh*` feed the `yield-usd-benchmark-current` canary, which is `ok` only when the USD row is direct, current, and published fresh in two consecutive generations.

## Yield Health Thresholds

`/api/status` exposes these checks under `yieldHealth`; the admin Pipeline card renders the same fields. The threshold table, per-surface impact, and inspection commands live in the [Yield Health runbook](./runbooks/yield-health.md#threshold-table).

`yieldHealth.statusImpact` remains public-critical only for stale or missing rankings. Safety, supplemental, benchmark, coverage-audit, and source-risk coverage gaps are admin-watch unless a later release explicitly changes that rule.

## Coverage Audit Queue

The monthly coverage-audit schema can consume durable, evidence-fingerprinted review dispositions and reports `operatorQueue.persistence="durable"`. D1 read/upsert helpers exist, but no production admin route or current operator workflow writes dispositions. The supported drain workflow is therefore read-only: classify items in the monthly scratch note and implement accepted source/config changes directly. If a disposition has been populated by a future supported writer, unchanged evidence stays suppressed until its review or expiry boundary and decision-relevant evidence reopens it. A stored `accept` disposition records evidence only; it never mutates adapters or allowlists. `/api/status` exposes the bounded visible queue under `yieldHealth.coverageAudit.headlineGaps` and `yieldHealth.coverageAudit.recommendationCandidates` so the admin card can show representative items without loading the full cache payload.
The queue is permanently DISPLAY-ONLY (`coverageAudit.queueDisplayOnly`); no disposition UI/API is authorized. `queueTotals.totalItemCount` is the full visible pre-cap cohort, `publishedItemCount` is the report's bounded rows, and `truncatedItemCount` is their difference: visible = published + truncated, candidate = visible + suppressed. `byKindScope: "full-visible"` names pre-cap visible by-kind totals; legacy `published-sample` counts describe only published rows. Status samples six rows per side and the report queue twenty, so neither sample is a total. Existing historical evidence-fingerprinted dispositions remain readable.

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

## Coverage Extension Reviewed 2026-10-03

Source configuration and intentional gaps are owned by `worker/src/lib/yield-config/yield-config-rate-sources.ts`, native/variant pool registries, and per-coin `yieldConfig` metadata. Configured paths do not imply published APYs or Safety Score eligibility; inspect the registry rather than treating this review's historical inventory counts as current coverage.

- ERC-4626 sources cover the new Morpho vaults plus strUSD, syrupUSDG, sFRAX, sreUSD, Gnosis sDAI, legacy Spark sUSDC, and Falcon sUSDf. `yield-config-rate-sources.ts` owns compact constructor calls with explicit share, asset and nullable TVL decimals. Read one whole share using share decimals, decode using asset decimals, and preserve rate history before annualizing. USD-underlying vaults also read `totalAssets`; EURCV assets are not USD TVL.
- Saturn sUSDat owns its exact Ethereum ERC-4626 rate and `totalAssets` source. The USDat parent remains non-yield-bearing and no longer carries an sUSDat wrapper mapping. The observed NAV includes STRCon preferred-credit valuation as well as income, so annualized rate changes can reflect gains or losses and do not certify a cash savings rate.
- Axis sUSDx uses `exchangeRate()` (`0x3ba0b9a9`). Exact selector-only and generic zero-padded calls matched at Ethereum block 26108099. The padded word is ignored by this deployment, not treated as an ERC-4626 share amount.
- Steakhouse USDG uses native DeFiLlama pool `32f586b4-5358-5aa2-88ee-c842139e7023` because Robinhood has no generic Worker rate-RPC route. The live [pool inventory](https://yields.llama.fi/pools) contains one Robinhood `STEAKUSDG` row with the exact USDG underlying. A pinned read of the [tracked vault](https://app.morpho.org/robinhood-chain/vault/0xBeEff033F34C046626B8D0A041844C5d1A5409dd/steakhouse-usdg) confirms its symbol and asset.
- earnUSD, FILQA, FIUSD, CUMIU, USCC, and uMINT use the existing `navToken` plus `nav-appreciation` price-derived eligibility. The runtime reads priced `supply_history`, not the proposed CoinGecko endpoint directly. It requires a priced anchor at least seven days old and no more than 45 days old. uMINT's reviewed CoinGecko 90-day response contained no prices; configuration does not imply an immediately publishable APY.
- BRSRV, STBT, and JLTXX remain intentional gaps because income is distributed in shares or through rebasing, which a stable NAV cannot measure. XGLD remains a gap until principal-adjusted returns separate gold appreciation from strategy income. CHF SAFO remains a gap until a reviewed native-CHF NAV-history adapter consumes the [Spiko share-class feed](https://public-api.spiko.io/share-classes/chfSAFO/totals); USD price returns include currency movements.

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

The `cleanupFalseLinkedVariantSourceSwitches()` reclassification pins its ranked-generations CTE to `idx_yield_source_decisions_created_coin` so the seven-day `created_at` bound drives a range scan. Without the pin the planner joins from every published generation into its decisions and reads the whole decision ledger (~5.5s per destructive-cleanup run); keep the index pin if that CTE is edited.

Yield history keeps full hourly rows for the newest 30 days and one close-of-day row per stablecoin/source for days 31–365 in `yield_history_daily`. The API merges both tiers without duplicating a day and continues to use raw rows while a historical day has not yet been materialized. Daily materialization precedes any later raw-row cleanup.

The materializer drains at most 1,000 missing or newer daily closes per run below the 30-day raw cutoff, including cold-start and below-watermark backlogs. Raw observations are never pruned before a daily close at least as new exists for their source/day. Work beyond the cap stays in raw history for later runs; deleted values are never synthesized.

The E2-F1 recovery drain is **pending deployment**, not an already executed backfill. The 2026-09-27 assessment found 8,975 recoverable retained daily closes across 161 UTC days (2026-03-01 through 2026-09-26), including 8,330 closed source-days since the daily-history rollout. After deployment, the materializer's 1,000-close-per-run drain provides capacity for this volume in approximately nine hourly runs; only days below the 30-day raw cutoff are eligible immediately, so newer closes wait until they age into that window. Verify the outstanding volume with the recovery assessment SELECT below; do not infer completion solely from elapsed runs.

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

The same recovery assessment identified up to 807 potentially lost source-days across 56 source pairs between 2026-08-10 and 2026-09-24. This is a conditional continuity estimate, not proof of lost observations: source inactivity may explain gaps, and sources without retained raw rows or daily evidence were excluded, so it is not a global upper bound. Deleted values must never be synthesized.

## Failure Semantics

The [engineering publication contract](./yield-intelligence.md#persistence-and-publication) owns applied/unapplied results, atomic generation/sentinel writes, admission, and cleanup eligibility; [engineering failure semantics](./yield-intelligence.md#failure-semantics) owns unavailable inputs and safety fallback. For diagnosis:

- Start with the [shared read-only status/cron checks](./runbooks/yield-health.md#first-checks). Read `metadata.quality.reasons` / `advisoryReasons` separately from `metadata.reason` and inspect the latest concrete cache/dependency reason, not a generic degraded streak.
- For a fully failed deterministic lane, compare alternative coverage and cooldown metadata, then follow [Deterministic All-Fail Cooldown](./runbooks/yield-deterministic-cooldown.md). Coverage-gap recovery must retry on the next hourly cycle; do not force RPC reads by editing health state.
- For optional-source budget warnings, inspect family/target telemetry above. Core deterministic, curated DeFiLlama, price-derived, and rate-derived paths may remain available; do not move heavy optional fetches into the publisher to replace a missed family.
- For partial supplemental coverage, inspect the per-family snapshots and `yield:supplemental-source-run:v1` outcomes in [Supplemental Snapshot](./runbooks/yield-supplemental-snapshot.md). `retained-previous` names a failed family, not a successful empty result. Retired aggregate rows are never recovery authority.
- For `publication-skipped`, aborts, or abandoned staging, compare cache-advertised identity with [Source Decision Evidence](./runbooks/yield-rankings-stale-or-missing.md#source-decision-evidence). Confirm repair/readback against the winning published generation; never finalize or replay a losing attempt by hand.
- For `no-yield-bearing-coins`, inspect active tracked-asset/config input and the `yield-sync-no-yield-bearing-coins` event rather than interpreting the run as successful empty coverage.
- For safety NR/default rows, inspect their published `safetyReason` and use [Safety Identity Mismatch](./runbooks/yield-rankings-stale-or-missing.md#safety-identity-mismatch) before deciding whether the issue is an individual card or common publication evidence.

## Public Wire Contract

The sole wire owner is [Yield Intelligence: Public Wire Contract](./yield-intelligence.md#public-wire-contract). Use [Persistence And Publication](./yield-intelligence.md#persistence-and-publication) for response-time freshness, sentinel/generation clocks, and admission, and [Failure Semantics](./yield-intelligence.md#failure-semantics) for unavailable evidence. Operator readback steps remain in the incident runbooks linked above.
