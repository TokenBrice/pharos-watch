# Worker Infrastructure Hardening Plan

Date: 2026-06-11
Status: active implementation; committed items are checked below
Scope: Cloudflare Worker cron/scheduled infrastructure, D1 persistence, provider fetch reliability, observability, and deploy recovery.

## Baseline

- Existing cron schedule guard passed: `npm run check:cron-sync`.
- Existing connection budget guard passed: `npm run check:cron-connections`.
- Existing abort-contract guard passed: `npm run check:cron-abort-contract`.
- Subagent spot checks also reported passing `npm run check:migrations`, `npm run check:env-contract`, `npm run check:cron-console-usage`, and `npm run typecheck:worker`.
- Official Cloudflare Workers best-practices guidance was consulted during the review.

## Committed Progress

- [x] Priority 0.1: bound quarter-hourly pricing fanout and corrected FX mirror connection metadata. Commit: `e52da4f23 fix(worker): cap pricing fanout and reserve cleanup chunks`.
- [x] Priority 0.2: gate 08:00 write-once snapshots on a fresh stablecoin cache. Commit: `a18aecd52 fix(worker): gate daily snapshots on fresh stablecoin cache`.
- [x] Priority 0.4 partial: make `batchExecute()` and D1 overload retry sleeps abort-aware. Commit: `aac0f69a8 fix(worker): make D1 batch retries abort-aware`.
- [x] Priority 0.4 partial: thread abort signals through DEX liquidity and DEWS chunked writes and freshness guards. Commit: `0fe677c4e fix(worker): thread abort signals through DEX and DEWS writes`.
- [x] Priority 0.4: finish remaining current-generation freshness audit by guarding yield publication retries and sentinels. Commit: `baa9ff6db fix(worker): guard yield publication on abort`.
- [x] Priority 0.5 partial: fix live-reserve stale-artifact cleanup chunk sizing and regression coverage. Commit: `e52da4f23 fix(worker): cap pricing fanout and reserve cleanup chunks`.
- [x] Priority 0.5: report live-reserve cleanup counts and warnings in cron metadata/status. Commit: `9ba4a2726 fix(worker): surface live reserve cleanup telemetry`.
- [x] Priority 0.3: keep leases held for abandoned non-cooperative cron jobs and log abandoned metadata. Commit: `54b6c3ad4 fix(worker): keep leases for abandoned cron jobs`.
- [x] Priority 3.14: make connection-budget CI derive peak usage from scheduled slot topology. Commit: `7eaa364f8 ci(cron): model connection slot topology`.
- [x] Priority 3.17: add Wrangler binding drift coverage to the env contract guardrail. Commit: `3ef77cf1b chore(env): check wrangler binding drift`.
- [x] Priority 4.18: persist child job summaries in scheduled slot metadata. Commit: `e49fe3c10 feat(cron): persist slot child summaries`.
- [x] Priority 1.7: publish DEWS generations behind a completed-run pointer and reader cutoffs. Commit: `96f71bca4 fix(worker): publish DEWS generations behind pointer`.
- [x] Priority 1.9: harden live-reserve cursor retries, deferred-tail metadata, and status visibility. Commit: `99a9c99c0 fix(worker): harden live reserve cursor recovery`.
- [x] Priority 1.6: publish DEX liquidity through validated generation staging. Commit: `677117c31 fix(worker): publish DEX liquidity by generation`.
- [x] Priority 1.6 follow-up: keep DEX publication generations published across post-publish overload retries. Commit: `4e9bc4a8a fix(worker): preserve DEX publication on retry`.
- [x] Priority 1.8: make status transitions and probe runs retry-idempotent under D1 overload. Commit: `2aebf1fd3 fix(worker): make status writes retry idempotent`.
- [x] Priority 2.10-2.13: restore provider circuit coverage, protocol-redeem breaker/budgeting, and 429 cooldown handling. Commit: `563f05393 fix(worker): harden provider circuit recovery`.
- [x] Priority 5.24: add provider resilience registry checks. Commit: `c00f9978b ci(worker): add provider resilience registry check`.

## Executive Readout

The Worker infrastructure already has strong foundations: explicit cron schedules, slot fencing, per-job leases, D1 migration policy, status surfaces, circuit breakers, cache sentinels, and deployment smokes. The maintenance load comes from a smaller set of reliability invariants that are still manual or only syntactically checked.

Highest-impact hardening should focus on:

- Turning declared cron connection budgets into measured runtime fanout.
- Making timeout and lease semantics safe when a job does not cooperate with aborts.
- Preventing partial multi-chunk D1 publications from becoming visible as current data.
- Closing provider circuit-breaker gaps in high-frequency pricing paths.
- Ensuring deploy rollback and status probes cover the real production edge path.

## Priority 0 - Directly Improve Successful Scheduled Runs

### 1. Bound real fetch fanout for quarter-hourly pricing

Committed: `e52da4f23 fix(worker): cap pricing fanout and reserve cleanup chunks`.

- [x] Limit Coinbase product fetches with `mapWithConcurrency()` or serial execution.
- [x] Keep `sync-stablecoins` inside its declared 4-connection budget after measuring actual fanout; correct stale `sync-fx-rates` connection metadata to the tested 3-mirror peak.
- [x] Add a regression test that counts peak in-flight Coinbase/product requests under the primary pricing collector.
- [x] Extend the same test harness to FX secondary mirror fetches so declared metadata matches runtime behavior.

Impact: prevents a high-frequency trigger from exceeding Cloudflare's 6-connection operating constraint and makes `check:cron-connections` trustworthy.

Evidence:

- `shared/lib/cron-jobs.ts` declares `sync-stablecoins` as `maxConnections: 4`.
- `worker/src/cron/sync-stablecoins/enrich-prices-primary-provider-collection.ts` caps top-level provider thunks at 4.
- `worker/src/lib/cex-tickers.ts` starts all Coinbase product fetches with `Promise.all`.
- `shared/lib/pricing-provider-config.ts` currently has 5 Coinbase products.
- `shared/lib/cron-jobs.ts` declares `sync-fx-rates` as `maxConnections: 2`.
- `worker/src/cron/sync-fx-rates-sources.ts` starts 3 secondary mirror fetches concurrently.

Validation:

- Unit test with mocked `fetch` tracks peak in-flight requests.
- `npm run check:cron-connections` still passes after metadata is corrected.
- Add a negative fixture proving the guard fails when product fanout exceeds the declared budget.

### 2. Fix the 08:00 write-once artifact race

Committed: `a18aecd52 fix(worker): gate daily snapshots on fresh stablecoin cache`.

- [x] Move the `daily0800Utc` snapshot fallback away from the `*/15` quarter-hourly boundary, or gate it on a stablecoins cache written after the relevant slot start.
- [x] Add a regression test where the daily fallback sees a 07:45 stablecoins cache while the 08:00 quarter-hourly sync is still running.
- [x] Apply the same freshness rule to `snapshot-public-dataset`, since it also writes immutable daily rows.

Impact: prevents stale 07:45 data from winning the 08:00 daily write-once snapshot before the fresh quarter-hourly run publishes.

Evidence:

- `worker/wrangler.toml` schedules both `*/15 * * * *` and `0 8 * * *`.
- `shared/lib/scheduled-runner-registry.ts` includes `snapshot-supply` in both the quarter-hourly slot and `daily0800Utc`.
- `worker/src/cron/snapshot-supply.ts` accepts stablecoins cache up to 20 minutes old and date-locks via `snapshot-supply:last-write`.
- `worker/src/cron/snapshot-public-dataset.ts` reads the stablecoins cache and writes immutable daily rows with `INSERT OR IGNORE`.

Validation:

- Focused test proves the fallback cannot consume the daily write marker before fresh 08:00 data is available.
- `/api/status` or cron metadata reports when a fallback defers because the fresh cache is not ready.

### 3. Make timeout and lease behavior safe for non-cooperative jobs

Committed: `54b6c3ad4 fix(worker): keep leases for abandoned cron jobs`.

- [x] Change `runCronWithLease()` so timeout/lease-loss handling does not immediately release a lease while the job promise is still executing.
- [x] Add a bounded "abandoned" state or grace path: abort first, keep the lease until settlement or TTL, and record durable metadata when the job fails to settle.
- [x] Add tests where a job ignores the abort signal and attempts a late D1 write.
- [x] Prevent publication sentinel writes after timeout or lease loss.

Impact: avoids overlapping runs and late writes from jobs that miss or delay abort handling.

Evidence:

- `worker/src/lib/cron-logger.ts` uses `Promise.race()` between the cron function and a timeout.
- `worker/src/lib/cron-lease.ts` races the job against stop signals and releases the lease in `finally`.
- `worker/src/handlers/scheduled/run-best-effort-job.ts` swallows child errors so the slot can continue.
- `worker/src/handlers/scheduled/quarter-hourly.ts` can proceed to later jobs after a best-effort failure.

Validation:

- Unit test proves a non-cooperative job cannot immediately free the lease for a second run.
- Unit test proves late job completion cannot update current cache/publication sentinels after timeout.
- Status metadata exposes `abandoned` or equivalent state distinctly from normal `error`.

### 4. Make D1 chunked writes abort-aware

Committed:

- `aac0f69a8 fix(worker): make D1 batch retries abort-aware`.
- `0fe677c4e fix(worker): thread abort signals through DEX and DEWS writes`.
- `baa9ff6db fix(worker): guard yield publication on abort`.

- [x] Add `AbortSignal` support to `batchExecute()` or introduce an abort-aware sibling helper.
- [x] Check the signal before each chunk and before retry sleeps.
- [x] Update DEX liquidity and DEWS high-volume cron persistence paths to pass the cron signal into chunked writes and retrying D1 operations.
- [x] Block DEX liquidity and DEWS freshness sentinel writes if the signal is aborted.
- [x] Audit/update remaining current-generation publishers that combine chunked writes with cache/current sentinels.

Impact: aligns D1 writes with the cron timeout model and reduces partial publication after aborted work.

Evidence:

- `worker/src/lib/db.ts` chunks `db.batch()` calls but has no signal argument.
- `worker/src/lib/cron-logger.ts` and `worker/src/lib/cron-lease.ts` treat timeout/lease loss as abort-driven.
- DEX liquidity, DEWS, and other high-volume publishers use chunked writes before publishing freshness/current sentinels.

Validation:

- Tests simulate abort between D1 chunks and assert no freshness/current sentinel is written.
- Tests verify retry logic exits promptly on abort.

### 5. Fix live-reserve stale-artifact cleanup chunking

Committed:

- `e52da4f23 fix(worker): cap pricing fanout and reserve cleanup chunks`.
- `9ba4a2726 fix(worker): surface live reserve cleanup telemetry`.

- [x] Replace the live-reserve cleanup chunk size of 900 with `D1_SAFE_IN_CLAUSE_BIND_LIMIT` or the shared default from `chunkArray()`.
- [x] Add a regression test with more than 100 stale reserve artifacts.
- [x] Report cleanup warnings in cron metadata/status instead of only logging them during finalize.

Impact: fixes a concrete cleanup failure that can let ghost live-reserve artifacts accumulate without failing the run.

Evidence:

- `worker/src/lib/live-reserves-store-write.ts` chunks stale IDs at 900.
- `worker/src/lib/db.ts` rejects `buildInClause()` calls above 100 values.
- `worker/src/cron/sync-live-reserves-finalize.ts` catches cleanup failures as warnings.

Validation:

- Unit test confirms cleanup succeeds with 101+ stale IDs.
- Live-reserve cron metadata includes cleanup counts and cleanup warning counts.

## Priority 1 - Protect Data Publication Integrity

### 6. Add generation-based publication for DEX liquidity

Committed:
- `677117c31 fix(worker): publish DEX liquidity by generation`.
- `4e9bc4a8a fix(worker): preserve DEX publication on retry`.

- [x] Add a `snapshot_run_id`, generation table, or staging table for `dex_liquidity`.
- [x] Write all metrics/placeholders for a run under the candidate generation.
- [x] Validate expected coverage before atomically marking the generation current.
- [x] Update readers to consume only complete current generations.

Impact: prevents mixed-generation DEX liquidity rows from becoming visible after a partial multi-chunk write.

Evidence:

- `worker/src/cron/dex-liquidity/persistence.ts` writes many metric rows/placeholders through chunked `batchExecute()`.
- `worker/src/api/dex-liquidity.ts` reads directly from `dex_liquidity`.
- `worker/src/cron/dews/source-state/hydration.ts` consumes DEX liquidity rows for downstream state.

Validation:

- Test fails halfway through a DEX write and proves readers still see the previous complete generation.
- DEX cron metadata reports written row count, expected row count, and current generation id.

### 7. Add generation boundaries or mixed-generation detection for DEWS

Committed: `96f71bca4 fix(worker): publish DEWS generations behind pointer`.

- [x] Add a completed-run pointer for `stress_signals` and `stress_signals_latest`, or stage DEWS writes before current publication.
- [x] At minimum, detect mixed `computed_at` generations and surface this in cron metadata/status.
- [x] Add a regression test for partial DEWS publication across chunk boundaries.

Impact: keeps current stress-signal state coherent for API readers and Telegram dispatch.

Evidence:

- `worker/src/cron/dews/persistence.ts` writes `stress_signals`, then `stress_signals_latest`, then freshness metadata.
- `worker/src/api/stress-signals.ts` reads latest/current stress signals.
- `worker/src/cron/dispatch-telegram-state.ts` consumes stress signal state.

Validation:

- Partial-write test proves current readers do not observe mixed generations, or status reports a degraded mixed-generation condition.

### 8. Make append-only status and audit writes retry-idempotent

Committed: `2aebf1fd3 fix(worker): make status writes retry idempotent`.

- [x] Add deterministic idempotency keys or uniqueness constraints before applying overload retry to append-only transitions.
- [x] Route status-state persistence through `runWithOverloadRetry()` once idempotency is in place.
- [x] Review DDR incident/publication audit rows and other append-only cron stores for the same pattern.

Impact: improves resilience under transient D1 overload without duplicating operator/audit history.

Evidence:

- `worker/src/lib/status-reliability-shared.ts` calls raw `db.batch()` for status persistence.
- `worker/src/lib/status-state-store.ts` appends transitions.
- `worker/src/lib/status-probe-store.ts` and status reads use raw D1 calls.
- Docs already define `runWithOverloadRetry()` as the D1 overload posture for bursty writes.

Validation:

- Tests simulate retryable D1 errors and prove exactly-once transition/audit rows.

### 9. Harden live-reserve cursor and deferred-tail recovery

Committed: `99a9c99c0 fix(worker): harden live reserve cursor recovery`.

- [x] Route live-reserve cursor writes through retrying cache helpers or `runWithOverloadRetry()`.
- [x] Include cursor state, `recording`/`incomplete` tail state, and next stablecoin id in cron metadata/status.
- [x] Add tests for cursor write failure during run-budget truncation.

Impact: makes live-reserve deferred-tail recovery more visible and less fragile under D1 pressure.

Evidence:

- `worker/src/cron/sync-live-reserves-run-state.ts` writes cursor state through raw `INSERT OR REPLACE`.
- `worker/src/cron/sync-live-reserves.ts` rotates from the stored `nextStablecoinId`.

Validation:

- Tests prove cursor write retry and operator-visible metadata on incomplete runs.

## Priority 2 - Close Provider Resilience Gaps

### 10. Restore DefiLlama circuit-breaker coverage in supplemental pricing

Committed: `563f05393 fix(worker): harden provider circuit recovery`.

- [x] Add `DL_COINS` gating and outcome recording to supplemental `/coins` price fetches.
- [x] Record success/failure for non-OK responses, malformed payloads, and thrown fetch errors.
- [x] Add tests for open-circuit skip and half-open recovery.

Impact: prevents a repeated supplemental DefiLlama outage from consuming high-frequency pricing fetch capacity every sync cycle.

Evidence:

- `worker/src/cron/sync-stablecoins/supplemental-assets/shared.ts` fetches `coins.llama.fi/prices/current/...` directly through `fetchWithRetry()`.
- `docs/pricing-pipeline.md` documents `DL_COINS` coverage for this path.
- `worker/src/lib/pricing-circuit-map.ts` maps the mirror source to `DL_COINS`.

Validation:

- Circuit tests prove supplemental price fetches skip while open and record outcomes while closed/half-open.

### 11. Add `DL_PROTOCOLS` coverage for supplemental gold protocol fetches

Committed: `563f05393 fix(worker): harden provider circuit recovery`.

- [x] Gate gold protocol mcap/TVL fetches with `CIRCUIT_SOURCE.DL_PROTOCOLS`.
- [x] Record one aggregate outcome per run, or per protocol if diagnostics need that granularity.
- [x] Keep the current bounded concurrency, but ensure an open circuit avoids fetch fanout.

Impact: avoids repeated DefiLlama protocol failures consuming connection slots during the stablecoins intake path.

Evidence:

- `worker/src/cron/sync-stablecoins/supplemental-assets/gold.ts` batches DefiLlama protocol requests three at a time.
- `worker/src/lib/constants.ts` defines `CIRCUIT_SOURCE.DL_PROTOCOLS`.
- `worker/src/cron/sync-stablecoins/intake.ts` overlaps supplemental work with main intake work.

Validation:

- Tests verify open-circuit skip, closed-circuit success recording, and failure recording.

### 12. Add a scoped breaker and wall-clock budget for protocol-redeem overrides

Committed: `563f05393 fix(worker): harden provider circuit recovery`.

- [x] Add a circuit source or grouped circuit for authoritative `protocol-redeem` RPC overrides.
- [x] Add a wall-clock budget for the full override stage, not only per-RPC timeout.
- [x] Surface skipped/open-circuit override counts in pricing metadata.

Impact: prevents recurring RPC/provider failures from retrying every quarter-hourly cycle across all scoped assets.

Evidence:

- `worker/src/lib/authoritative-price-sources/index.ts` runs matching live providers serially.
- `worker/src/lib/authoritative-price-sources/helpers.ts` calls EVM RPC helpers.
- `worker/src/lib/evm-rpc.ts` has per-RPC retries and 10s timeouts.
- `docs/data-pipeline.md` notes `protocol-redeem` is not directly circuit-gated.

Validation:

- Tests simulate RPC outage and prove the override stage enters cooldown without blocking the broader pricing pipeline.

### 13. Normalize 429 handling and provider cooldowns

Committed: `563f05393 fix(worker): harden provider circuit recovery`.

- [x] Decide how `fetchWithRetry()` should handle `Retry-After` when 429 is in `passthroughStatuses`.
- [x] Ensure CMC/address-provider diagnostics still preserve response details while respecting rate-limit backoff.
- [x] Write local cooldown state on 429 where appropriate, not only after success.

Impact: reduces repeated rate-limit pressure and improves recovery behavior during provider throttling.

Evidence:

- `worker/src/lib/fetch-retry.ts` honors `Retry-After` only when 429 is not passthrough.
- `worker/src/lib/address-price-providers/shared.ts` passes 429 through.
- `worker/src/cron/sync-stablecoins/enrich-prices-cmc-pass.ts` passes 429 through and writes local cooldown after success.

Validation:

- Tests cover passthrough 429 with `Retry-After`, generic breaker interaction, and CMC local cooldown behavior.

## Priority 3 - Make Guardrails Prove Runtime Behavior

### 14. Upgrade connection-budget CI from declared metadata to slot topology

- [x] Model actual `serial`, `parallel`, and `parallel-serial` slot topology in `check:cron-connections`.
- [x] Detect parallel chains that accidentally share or undercount a connection group.
- [x] Add fixture tests for a false-low budget and a correct parallel-chain budget.

Committed: `7eaa364f8 ci(cron): model connection slot topology`.

Impact: catches future schedule changes before they silently overrun Cloudflare's per-trigger connection pool.

Evidence:

- `scripts/ci/check-cron-connection-budget.ts` sums declared budget entries.
- `worker/src/handlers/scheduled/slot-groups.ts` supports `Promise.all` for parallel chains.
- `worker/src/handlers/scheduled/daily-0805.ts` relies on manually documented parallel fanout.

Validation:

- CI fails for intentionally undercounted parallel-chain fixtures.
- Existing 19 triggers pass with explicit topology-derived peak values.

### 15. Strengthen abort-contract checks beyond syntax

- [ ] Replace or supplement the current regex-style abort contract with AST-level checks.
- [ ] Include cron-used helpers under `worker/src/lib`, not only cron entrypoint files.
- [ ] Require signal propagation into fetch/helper calls where a signal is available.
- [ ] Require long loops to call `throwIfAborted()` or equivalent.

Impact: makes cooperative cancellation enforceable enough to support the lease and timeout model.

Evidence:

- `scripts/ci/check-cron-abort-contract.mjs` scans only `worker/src/handlers/scheduled` and `worker/src/cron`.
- Current checks catch `_signal` naming and no-arg callbacks, but not signal propagation or long-loop checks.

Validation:

- Add fixtures for a helper that drops the signal, a loop without abort checks, and a valid signal-aware helper chain.

### 16. Add a scheduled-path smoke that does not hit live providers

Committed: `6c8b7dab8 ci(worker): smoke scheduled entrypoints`.

- [x] Create `validate:worker-scheduled-smoke` or a focused `test:scheduled-contracts` command.
- [x] Invoke `worker.scheduled` for every cron expression with mocked D1 and mocked providers.
- [x] Assert no unknown schedule, slot fence/logging behavior, and no real network.
- [x] Add the command to the worker-impacting merge-gate path or release checklist.

Impact: catches schedule wiring and runtime import failures before deploy, closer to the actual Worker entrypoint than isolated unit tests.

Evidence:

- `scripts/maintenance/smoke-api.mjs` covers API endpoint contracts but not scheduled invocations.
- `worker/src/index.ts` exposes the scheduled handler.
- `worker/src/__tests__/index.scheduled.test.ts` covers pieces of schedule mapping but not a full no-network rehearsal for every trigger.

Validation:

- Smoke command runs locally without external credentials and fails on accidental live network use.

### 17. Add generated Worker binding type drift checks

- [x] Generate Worker binding types from `worker/wrangler.toml` with `wrangler types` or an equivalent CI-only comparison.
- [x] Compare generated bindings against `worker/src/lib/env.ts`.
- [x] Keep the existing env contract check for app-specific secret/documentation coverage.
- [ ] Optionally verify production secret/binding presence before Worker promotion.

Committed: `3ef77cf1b chore(env): check wrangler binding drift`.

Impact: catches config and binding drift before runtime, especially when adding D1/KV/secrets or changing Wrangler config.

Evidence:

- `worker/src/lib/env.ts` is hand-written.
- `scripts/ci/check-env-contract.mjs` checks local env registry/docs/source references, not generated Cloudflare binding types.
- `worker/src/handlers/http/gates.ts` logs runtime env validation issues once per isolate.

Validation:

- CI fails when `wrangler.toml` gains/removes a binding without matching `Env`.

## Priority 4 - Improve Operator Visibility And Recovery

### 18. Aggregate child job outcomes into slot execution metadata

- [x] Have scheduled slot group runners return a slot summary: jobs run, skipped, degraded, errored, and budget-only jobs.
- [x] Store the summary in `cron_slot_executions` metadata.
- [x] Mark slot outcome as degraded/error when children fail, while preserving best-effort isolation for later jobs.

Committed: `e49fe3c10 feat(cron): persist slot child summaries`.

Impact: prevents a clean-looking slot row from hiding failed child jobs and makes stale-slot triage faster.

Evidence:

- `worker/src/handlers/scheduled/run-best-effort-job.ts` catches child failures and returns `null`.
- `worker/src/lib/cron-lease.ts` and `cron_runs` still record per-job failure, but `cron_slot_executions` can finish as ok.
- `/api/status` relies heavily on per-job `cron_runs`, while slot rows are useful for schedule-level diagnosis.

Validation:

- Tests prove one failed child yields a degraded slot summary while subsequent children still run.

### 19. Split internal and external status probes

- [ ] Keep internal self-check probes for app/router isolation.
- [ ] Add explicit external HTTP probes through the production custom domain for representative public, site API, and ops API routes.
- [ ] Surface internal-vs-external discrepancies in `/api/status` and Telegram/operator alerts.

Impact: detects custom-domain, Access, routing, cache, and edge regressions that internal routing cannot see.

Evidence:

- `worker/wrangler.toml` sets `SELF_URL` to `https://api.pharos.watch`.
- `worker/src/cron/status-self-check.ts` internally routes non-health probes when the base origin matches the default.
- Admin probes also use direct internal routing.

Validation:

- Tests cover internal success plus external failure as a degraded operator status.

### 20. Harden Worker deploy rollback coverage

Committed: `3ecad3c21 ci(worker): harden deploy rollback gates`.

- [x] Fail closed before promotion if previous Worker version capture is missing on the Workers Versions path.
- [x] Move worker-only UI/ops/transport smokes into the rollback-eligible block, or add an equivalent rollback step for those failures.
- [x] Decide whether legacy `wrangler deploy` fallback is allowed in production; if allowed, document its reduced safety and require manual rollback instructions.

Impact: improves recovery when a deploy passes preview but fails production edge or ops smoke.

Evidence:

- `.github/workflows/deploy-cloudflare.yml` captures the previous version before promotion.
- Rollback only runs when that previous version id is available.
- The legacy fallback deploy path cannot use preview-version smoke or automatic version rollback.
- Some worker-only smokes run after the rollback block.

Validation:

- Workflow dry-run or mocked action tests prove missing previous-version capture blocks promotion.
- Simulated post-promotion smoke failure triggers rollback.

### 21. Extend stage-level progress metadata for high-SLO jobs

- [ ] Add progress stages to DEX liquidity, yield, digest, and Telegram dispatch where they currently rely mostly on wrapper-level run state.
- [ ] Include provider family, phase, count totals, cursor, and deferred-tail state where relevant.
- [ ] Show stage summaries in `/api/status` without increasing heavy D1 scans.

Impact: reduces maintenance time by making long-running or stuck jobs diagnosable while they are in flight.

Evidence:

- `worker/src/handlers/scheduled/context.ts` records wrapper progress.
- `docs/worker-infrastructure.md` documents detailed producer stages for only a subset of jobs.

Validation:

- Status tests verify progress rows are filtered to active matching leases and render useful metadata.

### 22. Standardize structured logging outside cron

Committed: `fix(worker): standardize route structured logging`.

- [x] Introduce a small structured logger for HTTP, status, and admin routes.
- [x] Expand console guardrails from cron-only baseline counts to structured-log shape checks.
- [x] Keep high-cardinality values out of log keys and use consistent fields for route, job, provider, source, and run id.

Impact: makes production incident triage faster and easier to query in Cloudflare observability.

Evidence:

- `worker/wrangler.toml` enables Worker observability and invocation logs.
- `scripts/ci/check-cron-console-usage.mjs` scans cron/scheduled files only.
- HTTP/status paths still have mixed plain-string console logging.

Validation:

- `npm run check:cron-console-usage` catches new unstructured HTTP/status logs outside the checked-in baseline.
- Focused logger, API/status, and idempotency tests pass.

## Priority 5 - Maintenance Load Reduction

### 23. Require explicit duration budgets for all status-tracked jobs

Committed: `8b3f89255 chore(cron): require explicit duration budgets`.

- [x] Add `timeoutMs` or `durationBudgetMs` to `CronJobDefinition`, or require every status-tracked job to appear in `CRON_TIMEOUT_MS`.
- [x] Extend `cron-duration-watchdog` to watch default-timeout jobs too.
- [x] Fail CI when a new status-tracked job lacks an explicit duration budget.

Impact: catches slow drift before jobs begin hitting timeout caps.

Evidence:

- `worker/src/cron/cron-duration-watchdog.ts` watches `Object.entries(CRON_TIMEOUT_MS)`.
- Many jobs rely on the default 5-minute timeout instead of explicit metadata.

Validation:

- CI fixture proves a new job without duration metadata fails the contract check.

### 24. Add provider resilience registry checks

Committed: `c00f9978b ci(worker): add provider resilience registry check`.

- [x] Maintain a registry of external provider/fetcher surfaces with required timeout, circuit source where applicable, body cancellation/parsing, and tests.
- [x] Add `check:provider-resilience` to catch direct fetches that bypass `fetchWithRetry()` or required circuit wrappers.
- [x] Include supplemental assets, authoritative overrides, FX sources, Telegram, GitHub feedback, X/Twitter, and live-reserve providers.

Impact: turns provider hardening from review memory into a repeatable gate.

Evidence:

- `worker/src/lib/fetch-retry.ts` handles timeout/retry/body cancellation for many paths.
- Provider-specific direct fetches and passthrough statuses still exist.
- Docs already require failed upstream response bodies to be consumed or canceled before later passes.

Validation:

- CI fixtures prove direct fetch without a resilience annotation fails.

### 25. Improve migration drift visibility

Committed: `dcdcffbe9 chore(migrations): surface schema drift in guardrail`.

- [x] Extend `check:migrations` to verify manifest row parity with migration files.
- [x] Emit an optional schema fingerprint after replaying migrations.
- [x] Store the fingerprint in CI artifacts or release notes for comparison during deploy triage.

Impact: keeps D1 schema drift visible while preserving the existing backward-compatible migration policy.

Evidence:

- `worker/migrations/MANIFEST.md` documents rollout safety and D1 rollback scope.
- `scripts/ci/check-worker-migrations.mjs` replays migrations and checks rollout-safety headers/destructive SQL policy.

Validation:

- Check fails when a migration file lacks manifest parity.
- Fingerprint changes are visible in CI output.

## Suggested Execution Order

1. Fix concrete correctness bugs: live-reserve cleanup chunking, Coinbase fanout, FX budget metadata, and 08:00 snapshot race.
2. Patch core execution semantics: non-cooperative lease timeout behavior and abort-aware D1 batch writes.
3. Add publication generations: DEX liquidity first, then DEWS.
4. Restore provider circuit coverage: supplemental `DL_COINS`, `DL_PROTOCOLS`, `protocol-redeem`, then 429 handling.
5. Upgrade guardrails: topology-aware connection checks, deeper abort checks, scheduled smoke, generated Worker type drift.
6. Improve operator recovery: rollback gates, external probes, slot summary metadata, structured logs, progress stages.
7. Reduce future maintenance load: duration budgets, provider resilience registry, migration fingerprinting.

## Documentation Updates Required When Implementing

- Update `docs/worker-and-api-limits.md` for any changed cron connection budgets, timeout budgets, or schedule-slot capacity assumptions.
- Update `docs/process/cron-trigger-policy.md` when schedule placement, slot topology, or connection-budget rules change.
- Update `docs/worker-infrastructure.md` for lease timeout semantics, slot metadata, publication generations, progress metadata, and status probe behavior.
- Update `docs/data-flow-map.md` when snapshot timing, DEX/DEWS publication flow, provider circuits, or daily artifact behavior changes.
- Update `docs/deployment-process.md` for rollback workflow changes or legacy fallback policy.
- Update `docs/pricing-pipeline.md` and `docs/data-pipeline.md` when supplemental/provider circuit coverage changes.
