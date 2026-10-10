# Runbook: Cron Slot Abandonment

Triggered by synthetic `cron_runs` rows written by `worker/src/lib/scheduled-slot-reconciliation.ts`:

- `scheduled slot abandoned before child job started`
- `scheduled slot heartbeat stale; child job progress abandoned`

Ordinary stale-child rows carry `metadata.reason = "stale-slot-reconciled"` and `metadata.failureCategory = "platform-abandoned"`. A stale child can instead be recorded as `status = "skipped_neutral"` with `metadata.failureCategory = "platform-interrupted"` when its death is attributable to a deploy: the slot's Worker version differs from the current verified version of its registry owner, public or heavy (`slot.worker_version` falls back to the dying invocation's `cron_run_progress.metadata.workerVersion` when absent). Another script's reconciler version is not deployment evidence. The stale heartbeat must be no more than 15 seconds newer than the child's last progress, and child progress must lead it by no more than `resolveScheduledSlotPolicy(slot.slot_key).heartbeatSec`. Latest life evidence, `max(slot.updated_at, progress.updated_at)`, must fall between 15 seconds before and 120 seconds after the owner's `worker-version-activated:<version>` marker, with activation no later than the sweep. This admits eviction between slot ticks without admitting a slot that kept heartbeating after its child died. Duration is not part of the test. The scheduled `worker-version-first-seen:<version>` marker is diagnostic only; whenever version drift exists, both markers are recorded even when the death stays an abandoned error.

Also triggered by duration findings in the daily `cron-sentinel` run (`worker/src/cron/cron-sentinel-daily.ts`). Its `metadata.sources.duration.metadata` contains the last-7-day observations from `worker/src/cron/cron-duration-watchdog.ts`, with `breaching` split into `runtimeBreaching` (job names) and `slotAbandonmentBreaching` (schedule keys). When any threshold fires, the duration source's own metadata carries `quality.reason = "cron-duration-findings"` and the sentinel's top-level `metadata.quality.reason` is `"sentinel-source-findings"`; there is no standalone status-tracked `cron-duration-watchdog` job. Any one of these is enough:

- **Duration trend.** A job's 7-day average duration reaches 80% of its `CRON_TIMEOUT_MS` ceiling (`worker/src/lib/cron-timeouts.ts`), so the slot is near budget and the next provider added to it would tip it over. Suppressed below 20 runs in the window, where a 7-day average is noise rather than a trend.
- **Cap hits.** 3 or more runs in the last 24 hours at or above that ceiling. Counted in absolute terms, with no minimum run count.
- **Budget truncations.** 3 or more runs in the last 24 hours that set `metadata.runBudgetTruncated` **without** persisting a deferral cursor. A truncation that ends with `metadata.cursorTailState = "complete"` is the designed graceful-deferral path — the next run drains the tail — and never counts.
- **Slot abandonment.** A schedule key with 3 or more abandoned slots that are also at least 10% of its 7-day slots, plus at least one abandonment in the last 24 hours so a healed lane stops alerting. Suppressed below 20 slots in the window.

The watchdog only observes: it never pauses, throttles, or reschedules a lane, and it measures app-level timeout headroom, not Cloudflare's CPU-time class — a chain killed by the sub-hourly 30-second CPU cap surfaces as slot abandonment, never as a duration breach.

## Symptom

Jobs report `status = 'error'` without a real child exception. The scheduled invocation died without writing a terminal row, so the fence's same-key presweep, stale takeover, or unconditional five-minute reserve-recovery global sweep reconciled the slot after the fact. `status-self-check` runs first in the status chain; there is no sweeper-first child. Public caches can stay healthy because a later slot re-publishes, while durable harm includes missed one-shot work and blind observability windows.

Loss concentrates on the **tail of a serial job chain**. Chains are defined in `shared/lib/scheduled-runner-registry.ts`; every job in one chain shares a single invocation. The required `scheduled_child_attempts` marker proves a child was attempted even when detailed progress is suppressed. A due protocol-v1 child without a marker can be recorded as synthetic `not_started`; legacy missing evidence becomes `execution_unknown` (`scheduled slot abandoned; child execution unknown`), never proof of nonexecution. Reconciliation enumerates every unterminated attempt by its immutable executing schedule key and slot timestamp, including replay attempts whose producer source slot differs; it does not filter by the slot row's current owner, generation, or invocation. After a failed reconciliation claim, a later sweep therefore still finds the original attempts. Synthetic terminals retain each attempt's own identity and require the current reconciler's CAS fence; already-terminal attempts are not re-terminated or treated as missing-start children. The reconciliation pass excludes planned `daily-digest` work in `digestTriggerPoll` because digest delivery has separate recovery semantics.

The synthetic child row retains `progressSnapshot`; the abandonment event exposes the same fields in its shallow `abandonedProgress` list from the last durable progress read before cleanup. It includes validated nonnegative item counts, reserve coin/adapter/breaker identifiers, and bounded aggregate adapter counters when available. `metadataStatus` distinguishes parsed, missing, malformed, and oversized input; the parser's input-length ceiling comes from `MAX_PERSISTED_CRON_METADATA_BYTES` in `worker/src/lib/cron-metadata-persistence.ts`. Free-text messages, provider errors, URLs, response bodies, and arbitrary fields are excluded. The snapshot is last-known progress, not proof that the named adapter caused the interruption; it may precede later checkpointed work. Missing fields are unknown, not zero. This diagnostic projection does not change lease ownership, takeover fencing, or synthetic chronology.

## First checks

Run the Wrangler SQL examples below from `worker/`, where `wrangler.toml` declares `stablecoin-db`.

Reserve recovery `producer-slot-priority` / `heavy-slot-co-tenancy` rows are neutral admission deferrals, not publication proof or abandonment. Inspect the protected slot's state and finished clock and the actual `blockedBy` holder, not the requester owner or lease key. Missing producer delivery remains protected; follow the delivery-stall procedure rather than manufacturing a slot or resetting a checkpoint. Incompatible debt retires only against a newer real finished full cohort with exact `superseded_by_json`; an operator-only cohort cannot supersede it. See [lease safety](./lease-and-breaker-recovery.md#safety-precondition).

Synthetic abandonment and deploy-interruption rows persist `degraded_reason` alongside `metadata.reason`.
Error text preserves the operational abandonment prefix and appends `[reason]`; neutral deploy
interruptions keep null error text. Inspect both the column and metadata, including reconciled rows
whose `started_at` still names an older slot.

Inspect `cron_slot_executions.child_marker_version` and the attempt ledger before treating missing progress as a never-started child. The terminal key and `schedulerAttemptKey`, `schedulerTerminalSource`, `schedulerTerminalToken`, and `childDisposition` metadata tie an accepted terminal to its full producer identity and executing fence. Real and reconciled contenders share SQL-fenced terminal arbitration; a late child cannot overwrite the accepted synthetic terminal, and distinct replay attempts are not duplicates. Unknown item counts stay null.

1. **Is it an evidenced deploy interruption or an in-place kill?** Compare `metadata.slotWorkerVersion` with `metadata.reconciledByWorkerVersion`, then compare the latest of the child's last progress write (`metadata.progressUpdatedAt`) and the slot's own last heartbeat with `metadata.reconciledByWorkerVersionActivatedAt`: it must fall no earlier than 15 seconds before and no later than 120 seconds after activation. Child progress may lead the slot timestamp by one fence-heartbeat interval, but a slot heartbeat more than 15 seconds newer than the child disproves co-death. Different versions are necessary but not sufficient: missing activation evidence, out-of-window latest life evidence, or excessive directional heartbeat separation remains an abandoned error. A non-null `slotWorkerVersion` may come from the dying invocation's own progress metadata when the slot row had none, so it does not prove the slot row recorded a version. **Equal versions or missing activation evidence** means the event needs the checks below (CPU class, memory, or a D1 stall).

   ```bash
   npx --no-install wrangler d1 execute stablecoin-db --remote --command \
    "SELECT job, slot_started_at, status, duration_ms, degraded_reason, metadata
       FROM cron_runs
      WHERE json_valid(metadata) AND json_extract(metadata, '\$.reason') = 'stale-slot-reconciled'
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

5. **Cron CPU class.** Check the lane's owner in `shared/lib/scheduled-runner-registry.ts` and its deployed expressions in `worker/wrangler.toml` or `worker/wrangler.heavy.toml` against `CRON_TRIGGER_SCHEDULES` in `shared/lib/cron-jobs.ts`. Cloudflare caps a Cron expression with an interval below one hour at **30 seconds of CPU time**, versus **15 minutes** at hourly or longer ([Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). A CPU-heavy chain behind one sub-hourly comma expression is the single most common cause.

6. **Duration shape.** Compare abandoned `duration_ms` against healthy percentiles, but inspect `childDisposition` and marker protocol first. Schema-required zero duration can represent either proven `not_started` or legacy `execution_unknown`; it does not establish observed zero runtime. Started-child duration is a lower bound from last durable activity, not total execution time. A short duration cannot attribute the interruption to CPU or memory: correlate Cloudflare invocation analytics and the last durable phase rather than interpreting missing activity as a controlled timeout.

## Remediation

- **Wrong CPU class (most common).** Keep the logical `schedule` string and `shared/lib/cron-cadences.ts` untouched, and add a `triggerSchedules` array of single-minute hourly expressions in `shared/lib/cron-jobs.ts`, mirrored into the owning public or heavy Wrangler config. Slot identity, cadence, and status freshness derive from the logical cadence, so they do not move. Use the existing aliases in `shared/lib/cron-jobs.ts` as the pattern. See ADR-20 through ADR-22 and `docs/process/cron-trigger-policy.md`; crossing the reviewed physical-trigger gate requires that policy's review.
- **Same-isolate heap accumulation.** If a later serial child dies after an earlier large graph completed, CPU-class aliases and reordering are not a memory boundary. Move the later job to a separate physical invocation while preserving its logical cadence and admission fences; this prevents run-scoped overlap but does not guarantee that the same Worker service will allocate a new isolate. ADR-22 applies this precedent to DDR after 43 of 45 post-CPU-rebalance V9 losses landed on the resolver child.
- **Genuinely too much work for one invocation.** Reduce per-invocation CPU, or move the offending leg to its own logical schedule key and runner plan. Adding another alias to an existing key does not separate the jobs — every alias resolves to the same chain.
- **Memory rather than CPU.** The isolate limit is 128 MB and is shared by every job in the chain. `worker/src/lib/v9-slot-window.ts` already serializes the Safety Score V9 heap lane for this reason. Reorder so a large graph is built after any capture that must survive it, and import heavy modules only at the point of use.
- **Do not clear a lease to "fix" this.** Reconciliation already releases or expires the dead slot's lease. Clearing a live lease while `/api/status` shows a fresh `inFlight` progress row for the same job risks a concurrent second writer.

## Prevention

- Treat a sub-hourly logical cadence carrying CPU-heavy work as requiring the paired-hourly physical form. `shared/lib/__tests__/cron-jobs.test.ts` asserts the converted lanes keep single-minute hourly aliases so a regression to one comma expression fails CI instead of silently re-entering the 30-second class.
- Put the cheapest, most load-bearing jobs first in a chain and observers last only when they can tolerate loss. The status chain starts with `status-self-check`; fence presweeps and the unconditional reserve-recovery global sweep reconcile abandoned slots independently of that child chain. Daily cron-sentinel growth/duration observations precede retention work.
- Watch the tail, not the average. The sentinel's duration source (`worker/src/cron/cron-duration-watchdog.ts`) excludes synthetic reconciled rows from duration statistics and counts slot abandonment separately, so a lane can look healthy on duration while losing a quarter of its runs.
- Prefer durable queues for delivery work. `dispatch-telegram-alerts` reads a durable pending queue, so an abandoned slot costs delivery latency rather than lost alerts; one-shot writers such as time-series snapshot jobs have no equivalent safety net.
- Keep abandonment thresholds source-owned by `resolveScheduledSlotPolicy()` in `worker/src/lib/scheduled-slot-policy.ts`: 60-second heartbeat, 300-second slot silence (360 seconds for existing long runners), 300-second child silence and a 960-second hard-dead backstop. Same-key and global sweeps apply the same policy before candidate limits and again in CAS.
- Carry one event-entry `SlotDeadline` through child waits and replay; clip local enrichment caps with `childCeilingMs()` rather than rebuilding a deadline from the producer slot or granting fresh time after admission waits. Readiness and output freshness clocks remain separate.

## Related

- `docs/worker-infrastructure.md` — deployed trigger topology and slot fencing
- `docs/worker-and-api-limits.md` — CPU, connection, and trigger budgets
- `docs/process/cron-trigger-policy.md` — physical-trigger growth gate
- `docs/status-dashboard.md` — how abandonment surfaces in `/api/status`
- `docs/yield-intelligence-operations.md` — the 2026-08-18 yield-lane precedent
