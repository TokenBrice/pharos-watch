# Runbook: Cron Slot Abandonment

Triggered by synthetic `cron_runs` rows written by `worker/src/lib/scheduled-slot-reconciliation.ts`:

- `scheduled slot abandoned before child job started`
- `scheduled slot heartbeat stale; child job progress abandoned`

Both carry `metadata.reason = "stale-slot-reconciled"` and `metadata.failureCategory = "platform-abandoned"`.

## Symptom

Jobs report `status = 'error'` without a real child exception. The scheduled invocation died without writing a terminal row, so `cron-slot-sweeper` (or a stale takeover, or the five-minute unscoped reserve-recovery sweep) reconciled the slot after the fact. Public caches can stay healthy while this happens, because the next slot usually re-publishes; the durable harm is missed one-shot work and blind observability windows.

Loss concentrates on the **tail of a serial job chain**. Chains are defined in `shared/lib/scheduled-runner-registry.ts`; every job in one chain shares a single invocation, so when the isolate dies, each job that had not started yet is recorded as `not_started`.

## First checks

1. **Is it a deploy eviction or an in-place kill?** Compare `metadata.slotWorkerVersion` with `metadata.reconciledByWorkerVersion`. Different versions mean the isolate was evicted by a deploy and the event is expected and self-limiting. **Equal versions mean an in-place kill** (CPU class, memory, or a D1 stall) and needs the checks below.

   ```bash
   npx --no-install wrangler d1 execute stablecoin-db --remote --command \
     "SELECT job, slot_started_at, duration_ms, substr(metadata, 1, 400) AS metadata
        FROM cron_runs
       WHERE error LIKE 'scheduled slot%'
         AND started_at >= unixepoch() - 86400
       ORDER BY started_at DESC LIMIT 50;"
   ```

2. **Abandonment rate per slot key.** A rate above a few percent on one slot key is a topology problem, not platform noise. Compare against `cron_slot_executions` to get the denominator.

   ```bash
   npx --no-install wrangler d1 execute stablecoin-db --remote --command \
     "SELECT slot_key, count(DISTINCT slot_started_at) AS slots
        FROM cron_slot_executions
       WHERE slot_started_at >= unixepoch() - 86400
       GROUP BY slot_key ORDER BY slots DESC;"
   ```

3. **Chain position.** Count abandonments per job and order them by their position in the owning chain. Monotonically increasing counts down the chain confirm invocation exhaustion rather than a per-job bug.

4. **Consecutive-loss runs.** A single missed slot is usually absorbed by the next one. Consecutive losses are the real availability event: six consecutive quarter-hour losses leave a lane blind for 90 minutes. Order that job's rows by `slot_started_at` and look for adjacent `error` runs.

5. **Cron CPU class.** Check the lane's deployed expressions in `worker/wrangler.toml` against `CRON_TRIGGER_SCHEDULES` in `shared/lib/cron-jobs.ts`. Cloudflare caps a Cron expression with an interval below one hour at **30 seconds of CPU time**, versus **15 minutes** at hourly or longer ([Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). A CPU-heavy chain behind one sub-hourly comma expression is the single most common cause.

6. **Duration shape.** Compare abandoned `duration_ms` against the job's healthy percentiles. `0`–`1000` ms means the job never started and the loss belongs to an earlier leg of the chain. A value far below the job's configured timeout in `worker/src/lib/cron-timeouts.ts` means the platform killed the isolate rather than a controlled timeout firing.

## Remediation

- **Wrong CPU class (most common).** Deploy the lane in the paired-hourly form: keep the logical `schedule` string and `shared/lib/cron-cadences.ts` untouched, and add a `triggerSchedules` array of single-minute hourly expressions in `shared/lib/cron-jobs.ts`, mirrored into `worker/wrangler.toml`. Slot identity, cadence, and status freshness derive from the logical cadence, so they do not move. `quarterHourly`, `v9SupplyAttributionOffset`, `statusSelfCheckOffset`, `halfHourlyOffset`, and `halfHourlyChartsOffset` all use this form. See ADR-20 and `docs/process/cron-trigger-policy.md`; crossing the reviewed physical-trigger gate requires that policy's review.
- **Genuinely too much work for one invocation.** Reduce per-invocation CPU, or move the offending leg to its own logical schedule key and runner plan. Adding another alias to an existing key does not separate the jobs — every alias resolves to the same chain.
- **Memory rather than CPU.** The isolate limit is 128 MB and is shared by every job in the chain. `worker/src/lib/v9-slot-window.ts` already serializes the Safety Score V9 heap lane for this reason. Reorder so a large graph is built after any capture that must survive it, and import heavy modules only at the point of use.
- **Do not clear a lease to "fix" this.** Reconciliation already releases or expires the dead slot's lease. Clearing a live lease while `/api/status` shows a fresh `inFlight` progress row for the same job risks a concurrent second writer.

## Prevention

- Treat a sub-hourly logical cadence carrying CPU-heavy work as requiring the paired-hourly physical form. `shared/lib/__tests__/cron-jobs.test.ts` asserts the converted lanes keep single-minute hourly aliases so a regression to one comma expression fails CI instead of silently re-entering the 30-second class.
- Put the cheapest, most load-bearing jobs first in a chain and observers last only when the observer can tolerate loss. `cron-slot-sweeper` runs first in the status chain on purpose: it is the self-heal path and must not be starved.
- Watch the tail, not the average. `cron-duration-watchdog` excludes synthetic reconciled rows from duration statistics (`worker/src/cron/cron-duration-watchdog.ts`) and counts slot abandonment separately, so a lane can look healthy on duration while losing a quarter of its runs.
- Prefer durable queues for delivery work. `dispatch-telegram-alerts` reads a durable pending queue, so an abandoned slot costs delivery latency rather than lost alerts; one-shot writers such as time-series snapshot jobs have no equivalent safety net.

## Related

- `docs/worker-infrastructure.md` — deployed trigger topology and slot fencing
- `docs/worker-and-api-limits.md` — CPU, connection, and trigger budgets
- `docs/process/cron-trigger-policy.md` — physical-trigger growth gate
- `docs/status-dashboard.md` — how abandonment surfaces in `/api/status`
- `docs/yield-intelligence-operations.md` — the 2026-08-18 yield-lane precedent
