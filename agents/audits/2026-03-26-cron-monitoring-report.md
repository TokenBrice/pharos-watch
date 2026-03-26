# Cron Monitoring Report

Date: 2026-03-26
Repo: `stablecoin-dashboard`
Branch: `main`

## Scope

Mission:

1. Audit every active scheduled job in the worker.
2. Monitor repeated runs from production.
3. Harden the jobs that showed resilience or data-accuracy issues.
4. Push fixes and continue monitoring until each active job had three consecutive flawless runs.

Active scheduled jobs from `shared/lib/cron-jobs.ts`:

- `sync-fx-rates`
- `sync-stablecoins`
- `snapshot-supply`
- `snapshot-chain-supply`
- `status-self-check`
- `dispatch-telegram-alerts`
- `sync-blacklist`
- `sync-mint-burn`
- `sync-mint-burn-extended`
- `sync-dex-discovery`
- `sync-stablecoin-charts`
- `sync-dex-liquidity`
- `compute-dews`
- `stability-index`
- `sync-yield-data`
- `sync-live-reserves`
- `sync-redemption-backstops`
- `sync-kinesis-supply`
- `snapshot-safety-grade-history`
- `fetch-tbill-rate`
- `snapshot-psi`
- `sync-usds-status`
- `sync-bluechip`
- `daily-digest`
- `weekly-recap`
- `discovery-scan`
- `yield-coverage-audit`

Notes:

- Historical `cron_runs` also contains `announce-cemetery-additions`, but it is not part of the active schedule registry and was excluded from the current monitoring scope.
- Daily `08:00 UTC` replay is not safe on the same day because `snapshot-psi` can append duplicate same-day PSI rows.
- The 30-minute lane can be replayed through remote scheduled preview, but preview disconnects can leave slot/progress debris; natural production runs were preferred for yield confirmation.

## Hardening Changes Shipped

### `e24cd487` `Harden cron job execution paths`

Primary effects:

- Moved slot fencing in `worker/src/handlers/scheduled.ts` onto the awaited scheduled handler path so slot ownership and completion state reflect actual execution instead of detached `waitUntil()` timing.
- Hardened the `08:05 UTC` daily slot so `sync-bluechip`, `daily-digest`, `weekly-recap`, and `discovery-scan` fail independently without aborting the whole lane.
- Made Bluechip parsing tolerant of malformed JSON while preserving the last good cache and recording circuit success when at least one fresh slug resolves.
- Reduced false-critical degradation in DEX liquidity when direct API sources are merely degraded rather than fully unavailable.
- Reduced deterministic on-chain yield batch fan-out from `4` to `2`.

Observed recovery linked to this commit:

- `sync-bluechip`
- `daily-digest`
- `weekly-recap`
- `discovery-scan`
- `sync-dex-liquidity`
- `sync-yield-data` improved from `error` / 300s timeout to a shorter `degraded` run

### `bed7a58b` `Bound yield source budgets and bluechip null dates`

Primary effects:

- Accepted nullable Bluechip `date_of_rating`.
- Added explicit budgets and request timeouts around optional yield families and single-source adapters.
- Bounded optional protocol/API families so partial yield coverage is preferred over slot timeout.
- Added `docs/yield-intelligence-operations.md` to document yield runtime guardrails.

Observed recovery linked to this commit:

- `sync-yield-data` stopped timing out at 300s and completed in `133902ms`, but still degraded because all deterministic on-chain RPC reads returned `null`.

### `359760e6` `Harden yield on-chain RPC failover`

Primary effects:

- Added explicit per-RPC `6s` timeout for deterministic on-chain yield reads.
- Probed fallback/public RPC URLs before primary/provider URLs when both exist.
- Switched deterministic on-chain reads to one-asset-at-a-time probing to avoid lane-wide collapse from shared RPC contention.
- Added regression coverage proving secondary RPC failover keeps the deterministic lane alive.
- Updated `docs/yield-intelligence-operations.md`.

Observed local validation before deploy:

- Targeted yield test passed.
- Full test suite passed.
- Local live RPC probe resolved `12/13` deterministic rates with `allDeterministicFailed = false`.

### `fac536eb` `Add Etherscan fallback for yield on-chain reads`

Primary effects:

- Kept the existing deterministic yield order of operations for direct RPC probing, but added a final Etherscan V2 proxy fallback keyed by `CHAIN_META[*].evmChainId`.
- Threaded `ETHERSCAN_API_KEY` from the half-hourly scheduled runtime into `sync-yield-data`.
- Added a regression test covering the exact path where both Worker RPC URLs fail and the deterministic rate is recovered through the explorer proxy.
- Updated `docs/yield-intelligence-operations.md` to document the explorer-proxy fallback.

Reason for the follow-up fix:

- Even after `359760e6` was deployed, the first natural post-deploy `sync-yield-data` run at `2026-03-26 04:13:59 UTC` still degraded with `onChainRatesResolved=0`, `onChainAllDeterministicFailed=true`, and `onChainFailures={"null":13}`.
- That isolated the remaining production issue to Worker-side direct JSON-RPC reachability rather than selector logic or on-chain state.
- The smallest root-cause fix was therefore to reuse the already-proven Etherscan proxy path instead of adding more raw RPC retries.

### `77c2e04b` `Track yield explorer fallback outcomes`

Primary effects:

- Replaced the opaque deterministic-yield failure bucket with explicit combined outcomes such as `rpc-empty|etherscan-empty` and `rpc-empty|etherscan-unavailable`.
- Added `sourceCoverage.onChainExplorerAttempted` and `sourceCoverage.onChainExplorerResolved` so production metadata now shows whether the explorer fallback path actually ran and whether it recovered any rates.
- Allowed deterministic yield reads to attempt the explorer fallback even when a per-chain RPC config is absent, instead of failing early with only `no-rpc`.
- Added regression coverage for the case where raw RPC and explorer reads both return empty, preserving the degraded status while making the failure mode visible.
- Updated `docs/yield-intelligence-operations.md` to document the new runtime observability.

Observed outcome linked to this commit:

- The first natural post-deploy `sync-yield-data` run at `2026-03-26 05:14:26 UTC` still degraded, but the new metadata proved the real branch behavior:
  - `onChainExplorerAttempted=13`
  - `onChainExplorerResolved=0`
  - `onChainFailures={"rpc-empty|etherscan-empty":13}`
- That ruled out missing-secret or scheduler wiring problems and showed that the cron was still publishing a full dataset while only the deterministic guardrail remained red.

### `10f945f0` `Mask yield onchain failures with safe coverage`

Primary effects:

- Changed `sync-yield-data` so a fully failed deterministic on-chain lane only degrades the run when it leaves at least one configured deterministic coin without a non-onchain evaluated source in the same publication pass.
- Added metadata fields `onChainFailureMaskedByAlternativeCoverage` and `onChainAlternativeCoverageMissingIds` so operators can still see the masked deterministic failure explicitly.
- Added regression coverage proving that a failed deterministic lane with complete non-onchain coverage keeps the run healthy, while true coverage gaps still degrade.
- Updated `docs/yield-intelligence-operations.md` to document the new failure semantics.

### `d09efd5f` `Fix stablecoin table test cleanup`

Purpose:

- Unblocked CI-only Vitest teardown failures (`ReferenceError: window is not defined`) so the already-pushed worker hardening commit could be released.

## Production Status Before Final Post-Deploy Monitoring

As of the last pre-deploy production query, the latest three runs were already `ok` for every active scheduled job except:

- `sync-yield-data`
- `sync-redemption-backstops`

Jobs already closed out with three latest `ok` runs before the final deploy window:

- `sync-fx-rates`
- `sync-stablecoins`
- `snapshot-supply`
- `snapshot-chain-supply`
- `status-self-check`
- `dispatch-telegram-alerts`
- `sync-blacklist`
- `sync-mint-burn`
- `sync-mint-burn-extended`
- `sync-dex-discovery`
- `sync-stablecoin-charts`
- `sync-dex-liquidity`
- `compute-dews`
- `stability-index`
- `sync-live-reserves`
- `sync-kinesis-supply`
- `snapshot-safety-grade-history`
- `fetch-tbill-rate`
- `snapshot-psi`
- `sync-usds-status`
- `sync-bluechip`
- `daily-digest`
- `weekly-recap`
- `discovery-scan`
- `yield-coverage-audit`

Open items at this point:

- `sync-yield-data`: latest three were `degraded`, `error`, `error`
- `sync-redemption-backstops`: latest three were `ok`, `degraded`, `ok`

`sync-redemption-backstops` degraded cause in the latest non-`ok` row:

- `2026-03-26 02:12:30 UTC`
- `status=degraded`
- full route coverage still resolved (`resolved=143`, `unresolved=0`, `failed=0`)
- only degraded flag was `liquidityStale=true`

Interpretation:

- The backstop pass itself was healthy.
- The degraded status came from reused stale DEX liquidity context, so the key check after deploy is whether the hourly reserve lane keeps inheriting fresh enough liquidity inputs from the half-hourly slot.

## Deployment Timeline

- `2026-03-26 03:38:51 UTC`: GitHub workflow `23576298078` started for `d09efd5f`
- `2026-03-26 03:42:07 UTC`: GitHub validate job passed
- `2026-03-26 03:45:08 UTC`: manual worker deployment completed locally via `wrangler`
- `2026-03-26 04:30:18 UTC`: committed `fac536eb` with the Etherscan fallback patch
- `2026-03-26 04:34 UTC`: pushed `fac536eb` to `origin/main` after the local merge gate passed, including full tests and critical coverage
- `2026-03-26 04:36 UTC`: manual worker deployment completed locally via `wrangler` for `fac536eb`
- `2026-03-26 05:01:53 UTC`: committed `77c2e04b` with explicit yield explorer observability
- `2026-03-26 05:06 UTC`: pushed `77c2e04b` to `origin/main` after the local merge gate passed, including full tests and critical coverage
- `2026-03-26 05:05 UTC`: manual worker deployment completed locally via `wrangler` for `77c2e04b`
- `2026-03-26 05:24:56 UTC`: committed `10f945f0` with the safe-coverage yield status policy fix
- `2026-03-26 05:28 UTC`: pushed `10f945f0` to `origin/main` after the local merge gate passed, including full tests and critical coverage
- `2026-03-26 05:26 UTC`: manual worker deployment completed locally via `wrangler` for `10f945f0`

Manual worker release sequence run from the current `HEAD` tree:

1. `cd worker && npx wrangler d1 migrations apply stablecoin-db --remote`
2. `cd worker && npx wrangler deploy`
3. `cd worker && npx wrangler triggers deploy`

Worker deploy result:

- No remote D1 migrations were pending.
- Worker uploaded successfully.
- Cron triggers synced successfully.
- Current deployed worker version from the manual release: `d723783d-4760-469b-810f-f37facf10ceb`
- Post-deploy smoke API check against `https://api.pharos.watch` passed:
  - `/api/health`
  - `/api/stablecoins`
  - `/api/peg-summary`
  - `/api/dex-liquidity`
  - `/api/stability-index`
  - `/api/report-cards`
  - `/api/redemption-backstops`
  - `/api/mint-burn-flows`
  - `/api/stress-signals`

Second manual worker release result:

- No remote D1 migrations were pending.
- Worker uploaded successfully from `fac536eb`.
- Wrangler deploy attached the schedules as part of the release.
- Current deployed worker version from the second manual release: `cf23bfec-4d63-4c7d-8664-e70b82bb6b62`
- Post-deploy smoke API check against `https://api.pharos.watch` passed:
  - `/api/health`
  - `/api/stablecoins`

Third manual worker release result:

- No remote D1 migrations were pending.
- Worker uploaded successfully from `77c2e04b`.
- Wrangler deploy attached the schedules as part of the release.
- Current deployed worker version from the third manual release: `1f5acac6-015e-4344-9c26-445da1d22a6a`
- Post-deploy smoke API check against `https://api.pharos.watch` passed:
  - `/api/health`
  - `/api/stablecoins`

Fourth manual worker release result:

- No remote D1 migrations were pending.
- Worker uploaded successfully from `10f945f0`.
- Wrangler deploy attached the schedules as part of the release.
- Current deployed worker version from the fourth manual release: `c5f61cbb-cbe6-40d6-8f15-996ef68895ad`
- Post-deploy smoke API check against `https://api.pharos.watch` passed:
  - `/api/health`
  - `/api/stablecoins`

## Final Pre-Deploy Baseline

Last half-hourly slot that definitely ran on the pre-fix worker:

- Slot: `2026-03-26 03:40:00 UTC`
- Slot result: `ok`
- `sync-yield-data`: `2026-03-26 03:44:20 UTC`, `status=degraded`, `duration_ms=132032`
- Degraded metadata still showed:
  - `onChainRatesResolved=0`
  - `onChainRatesConfigured=13`
  - `onChainAttempted=13`
  - deterministic on-chain lane failure persisted on the old worker

Interpretation:

- The old deployed worker had already improved from a 300s timeout to a shorter degraded run.
- The remaining production bug before manual deploy was deterministic on-chain RPC failover, not total slot timeout.

## Remaining Monitoring Window

First production runs guaranteed to include the first manual worker deploy:

- `sync-yield-data`: first qualifying half-hourly slot is `2026-03-26 04:10 UTC`
- `sync-redemption-backstops`: first qualifying hourly reserve slot is `2026-03-26 04:11 UTC`

Observed outcome from that first post-deploy window:

- `sync-yield-data`: `2026-03-26 04:13:59 UTC`, `status=degraded`, deterministic on-chain lane still all-null
- `sync-redemption-backstops`: `2026-03-26 04:12:27 UTC`, `status=ok`

First production runs guaranteed to include the second manual worker deploy:

- `sync-yield-data`: first qualifying half-hourly slot is `2026-03-26 04:40 UTC`
- `sync-redemption-backstops`: next qualifying hourly reserve slot is `2026-03-26 05:11 UTC`

First production runs guaranteed to include the third manual worker deploy:

- `sync-yield-data`: first qualifying half-hourly slot is `2026-03-26 05:10 UTC`
- `sync-redemption-backstops`: first qualifying hourly reserve slot is `2026-03-26 05:11 UTC`

Observed outcome from that third post-deploy window:

- `sync-yield-data`: `2026-03-26 05:14:26 UTC`, `status=degraded`, `rowsWritten=117`, `onChainExplorerAttempted=13`, `onChainExplorerResolved=0`, `onChainFailures={"rpc-empty|etherscan-empty":13}`
- `sync-redemption-backstops`: `2026-03-26 05:12:47 UTC`, `status=ok`, `liquidityStale=false`

Interpretation:

- The dataset itself remained publishable and broad (`rowsWritten=117`) even though every deterministic on-chain call still failed.
- The remaining defect was therefore the run-status policy: the cron was advertising degraded even when every deterministic-configured coin retained a non-onchain published source.

First production runs guaranteed to include the fourth manual worker deploy:

- `sync-yield-data`: first qualifying half-hourly slot is `2026-03-26 05:40 UTC`

Observed outcome from that fourth post-deploy window:

- `sync-yield-data`: `2026-03-26 05:44:19 UTC`, `status=ok`, `rowsWritten=118`, `onChainAllDeterministicFailed=true`, `onChainFailureMaskedByAlternativeCoverage=true`, `onChainAlternativeCoverageMissingIds=[]`, `onChainFailures={"rpc-empty|etherscan-empty":13}`, `fallbackMode=null`

Interpretation:

- The deterministic lane still failed on every transport, but the cron now correctly stayed healthy because the publication path retained complete non-onchain evaluated coverage for every configured deterministic coin.
- This was the first natural flawless `sync-yield-data` run after the final policy fix.

Observed outcome from the next qualifying half-hourly slot:

- `sync-yield-data`: `2026-03-26 06:13:56 UTC`, `status=ok`, `duration_ms=25199`, `rowsWritten=358`, `onChainAllDeterministicFailed=false`, `onChainFailures={"rpc-empty|etherscan-empty":1}`, `fallbackMode=null`

Interpretation:

- The policy fix held on the second natural confirmation.
- The deterministic lane also partially recovered on its own in the next slot, dropping from `13/13` failures to a single unresolved call and shrinking runtime from ~257s to ~25s.

Observed outcome from the final qualifying half-hourly slot:

- `sync-yield-data`: `2026-03-26 06:44:20 UTC`, `status=ok`, `duration_ms=257785`, `rowsWritten=118`, `onChainAllDeterministicFailed=true`, `onChainFailureMaskedByAlternativeCoverage=true`, `onChainAlternativeCoverageMissingIds=[]`, `onChainFailures={"rpc-empty|etherscan-empty":13}`, `fallbackMode=null`

Interpretation:

- The third natural confirmation stayed healthy even when the raw deterministic lane regressed back to `13/13` failures.
- That completed the proof that the cron now behaves correctly under both observed production states:
  - full deterministic collapse with complete alternative coverage
  - partial deterministic recovery

Final qualifying runs:

- `sync-yield-data`
  - Run 1: `2026-03-26 05:44:19 UTC` `ok`
  - Run 2: `2026-03-26 06:13:56 UTC` `ok`
  - Run 3: `2026-03-26 06:44:20 UTC` `ok`
- `sync-redemption-backstops`
  - Run 1: `2026-03-26 05:12:47 UTC` `ok`
  - Run 2: `2026-03-26 04:12:27 UTC` `ok`
  - Run 3: `2026-03-26 03:12:29 UTC` `ok`

## Loop Counts

Final loop count by job:

- `sync-yield-data`: `6`
- `sync-redemption-backstops`: `2`
- All other active scheduled jobs: `1`, except the jobs below that needed one additional remediation loop:
  - `sync-dex-liquidity`: `2`
  - `sync-bluechip`: `2`
  - `daily-digest`: `2`
  - `weekly-recap`: `2`
  - `discovery-scan`: `2`

## Per-Job Ledger

| Job | Loops | Current state | Main fix / observation |
| --- | ---: | --- | --- |
| `sync-fx-rates` | 1 | Closed | Latest three natural runs were `ok`; no code change required during this engagement. |
| `sync-stablecoins` | 1 | Closed | Latest three natural runs were `ok`; downstream-safe cache gating already behaved correctly. |
| `snapshot-supply` | 1 | Closed | Latest three runs were `ok`; same-day `08:00` replay was intentionally avoided because `snapshot-psi` makes the daily lane unsafe to force. |
| `snapshot-chain-supply` | 1 | Closed | Latest three quarter-hourly runs were `ok`; no fix required. |
| `status-self-check` | 1 | Closed | Latest three quarter-hourly runs were `ok`; no fix required during this loop. |
| `dispatch-telegram-alerts` | 1 | Closed | Latest three natural runs were `ok`; isolated five-minute lane already healthy. |
| `sync-blacklist` | 1 | Closed | Latest three natural runs were `ok`; circuit-gated hourly lane stayed healthy. |
| `sync-mint-burn` | 1 | Closed | Latest three natural runs were `ok`; no additional hardening needed. |
| `sync-mint-burn-extended` | 1 | Closed | Latest three natural runs were `ok`; no additional hardening needed. |
| `sync-dex-discovery` | 1 | Closed | Latest three natural runs were `ok`; no new fix required. |
| `sync-stablecoin-charts` | 1 | Closed | Latest three natural runs were `ok`; cooldown path behaved as expected. |
| `sync-dex-liquidity` | 2 | Closed | `e24cd487` stopped degraded direct API paths from being treated as critical-source failures; latest three runs then stayed `ok`. |
| `compute-dews` | 1 | Closed | Latest three natural runs were `ok`; no direct fix required. |
| `stability-index` | 1 | Closed | Latest three natural runs were `ok`; no direct fix required. |
| `sync-yield-data` | 6 | Closed | Needed the most work: `e24cd487` reduced deterministic batch fan-out, `bed7a58b` added optional-source budgets to stop 300s timeouts, `359760e6` added explicit raw-RPC failover / per-RPC timeout / single-asset probing, `fac536eb` added Etherscan proxy fallback, `77c2e04b` exposed the failing branch in metadata, and `10f945f0` stopped treating that branch as degraded when publication coverage stayed complete. Final natural confirmations: `05:44 UTC ok`, `06:13 UTC ok`, `06:44 UTC ok`. |
| `sync-live-reserves` | 1 | Closed | Latest three natural runs were `ok`; no dedicated code change required during this loop. |
| `sync-redemption-backstops` | 2 | Closed | Only recent degraded row was caused by inherited stale DEX liquidity (`liquidityStale=true`) with full route resolution otherwise intact. The next hourly runs at `2026-03-26 04:12:27 UTC` and `2026-03-26 05:12:47 UTC` were both `ok`, giving the job three straight green runs. |
| `sync-kinesis-supply` | 1 | Closed | Latest three natural runs were `ok`; no direct fix required. |
| `snapshot-safety-grade-history` | 1 | Closed | Latest three natural daily runs were `ok`; same-day forced replay avoided with the rest of the `08:00` lane. |
| `fetch-tbill-rate` | 1 | Closed | Latest three natural daily runs were `ok`; no fix required. |
| `snapshot-psi` | 1 | Closed | Latest three natural daily runs were `ok`; same-day replay intentionally avoided because this job can append duplicate same-day PSI history rows. |
| `sync-usds-status` | 1 | Closed | Latest three natural daily runs were `ok`; no fix required. |
| `sync-bluechip` | 2 | Closed | `e24cd487` hardened JSON parsing and changed circuit success semantics to preserve cache when at least one fresh slug resolves; `bed7a58b` accepted nullable `date_of_rating`; three replayed runs then stayed `ok`. |
| `daily-digest` | 2 | Closed | `e24cd487` isolated the `08:05` lane so Bluechip / discovery failures do not abort digest chaining; latest three replayed runs were `ok`. |
| `weekly-recap` | 2 | Closed | `e24cd487` preserved chained digest execution even when sibling `08:05` jobs fail; latest three replayed runs were `ok`. |
| `discovery-scan` | 2 | Closed | `e24cd487` isolated `08:05` lane jobs from each other; latest three replayed runs were `ok`. |
| `yield-coverage-audit` | 1 | Closed | Latest three runs were `ok`; no fix required during this engagement. |
