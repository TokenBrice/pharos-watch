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

Loss concentrates on the **tail of a serial job chain**. Chains are defined in `shared/lib/scheduled-runner-registry.ts`; every job in one chain shares a single invocation. The required `scheduled_child_attempts` marker proves a child was attempted even when detailed progress is suppressed. A due protocol-v1 child without a marker can be recorded as synthetic `not_started`; legacy missing evidence becomes `execution_unknown` (`scheduled slot abandoned; child execution unknown`), never proof of nonexecution. Reconciliation enumerates every unterminated attempt by its immutable executing schedule key and slot timestamp, including replay attempts whose producer source slot differs; it does not filter by the slot row's current owner, generation, or invocation. After a failed reconciliation claim, a later sweep therefore still finds the original attempts. Synthetic terminals retain each attempt's own identity and require the current reconciler's CAS fence; already-terminal attempts are not re-terminated or treated as missing-start children. The reconciliation pass excludes unstarted conditional retry/poll work unless demand admission is evidenced, as detailed below.

The synthetic child row retains `progressSnapshot`; the abandonment event exposes the same fields in its shallow `abandonedProgress` list from the last durable progress read before cleanup. It includes validated nonnegative item counts, reserve coin/adapter/breaker identifiers, and bounded aggregate adapter counters when available. `metadataStatus` distinguishes parsed, missing, malformed, and oversized input; the parser's input-length ceiling comes from `MAX_PERSISTED_CRON_METADATA_BYTES` in `worker/src/lib/cron-metadata-persistence.ts`. Free-text messages, provider errors, URLs, response bodies, and arbitrary fields are excluded. The snapshot is last-known progress, not proof that the named adapter caused the interruption; it may precede later checkpointed work. Missing fields are unknown, not zero. This diagnostic projection does not change lease ownership, takeover fencing, or synthetic chronology.

## First checks

**Confirm an OOM independently.** Open the hourly **Worker Memory Monitor** Action, its step summary and 30-day `worker-memory-<run>-<attempt>` artifact (`report.json`, `report.md`, `samples.ndjson`, `exceeded-memory.ndjson`, `queries.json`). Its separate **Heavy kill observed** and **Collection incomplete** steps use the [standard GitHub incident lifecycle](./workflow-incidents.md). The heavy-kill annotation/summary names the physical/logical lane when uniquely correlated, otherwise `unattributed`; candidate jobs are not culprit proof. `collectionIncomplete` means missing/failed required sources, never stale coverage. The collection step also fails separately with `coverage-stale` when a default-window run exceeds the 8,100-second coverage-lag budget (`freshnessFailed`); an explicit forensic window keeps that freshness label but does not fail for its historical end time. Neither incomplete nor stale evidence is a fresh zero-kill finding, and retained reports have no report-age gate: inspect `generatedAt` before reusing them. Lane descriptors are stored once in `report.json.laneDescriptors`, keyed by each row's `lane.scheduleKey`, not duplicated in NDJSON. Locally export `CLOUDFLARE_WORKERS_ANALYTICS_API_TOKEN` (Account Analytics: Read) and `CLOUDFLARE_ACCOUNT_ID`, then run:

```bash
npm run ops:worker-memory -- --from 2026-10-13T00:00:00Z --to 2026-10-15T00:00:00Z
```

The independent Adaptive `status:"exceededMemory"` query is kill authority; a broad success/memory query can miss rare kills. Scheduled can label the same event `internalError` or `clientDisconnected`. Correlation requires the same script and invocation second, CPU difference **strictly under 2 µs**, `sum.requests === 1` and `avg.sampleInterval === 1`, with a unique forward and reverse match. Grouped, sampled/unknown, ambiguous and unjoined kills remain in the inventory. Slot normalization uses `scheduledDatetime`, not invocation/child start. The collector revision's registry supplies **candidate jobs**, not historical execution or culprit proof; a `:16` shared-lane kill is not a canonical `:22/:52` compiler kill. Unattributed public kills do not identify an HTTP route.

For deeper corroboration, use the reported execution `scheduleKey` and `slotStartedAt` with approved read-only D1 access (replace the example identity, retain `LIMIT`):

```sql
SELECT s.slot_key, s.slot_started_at, s.worker_version AS current_slot_version,
       a.*, r.status, r.degraded_reason, r.metadata
FROM cron_slot_executions AS s
JOIN scheduled_child_attempts AS a
  ON a.execution_schedule_key = s.slot_key
 AND a.execution_slot_started_at = s.slot_started_at
LEFT JOIN cron_runs AS r ON r.idempotency_key = a.attempt_key
WHERE s.slot_key = 'halfHourlyChartsOffset' AND s.slot_started_at = 1791940560
ORDER BY a.attempt_key LIMIT 50;
```

Compare the Adaptive version to the **attempt's** execution version/invocation/generation, not just the slot's current owner after takeover. Preserve producer identity separately and inspect `child_marker_version`, `childDisposition`, `progressSnapshot`, `failureCategory` and `degraded_reason`. `not_started` is not a culprit; legacy `execution_unknown` is not nonexecution proof. Slot/attempt retention is 14 days and ordinary cron history seven days; bounded recent `/api/status` rows cannot establish historical absence.

Before treating a downstream `not_started` row as required work, check its exact job/schedule pair against `CONDITIONALLY_ADMITTED_SCHEDULED_TASKS` in `shared/lib/scheduled-runner-registry.ts`. PSI/public daily catch-up, hourly yield/benchmark catch-up, and digest polls need demand admission beyond the slot clock. Current reconciliation does not synthesize missing-start failures for these lanes; status also excludes the narrowly identified historical false failures without deleting database evidence. Their canonical scheduled runs and any actually started attempts remain subject to failure and publication-freshness checks.

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

5. **Cron CPU class.** Find the lane's logical slot, Worker owner and physical expressions in the [canonical cron table](../worker-infrastructure.md#cron-scheduling), then compare the actual deployed triggers with the owning config: public `worker/wrangler.toml` or heavy `worker/wrangler.heavy.toml`, as assigned by `shared/lib/scheduled-runner-registry.ts`. Cloudflare caps a Cron expression with an interval below one hour at **30 seconds of CPU time**, versus **15 minutes** at hourly or longer ([Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). A CPU-heavy chain behind one sub-hourly comma expression is the single most common cause.

6. **Duration shape.** Compare abandoned `duration_ms` against healthy percentiles, but inspect `childDisposition` and marker protocol first. Schema-required zero duration can represent either proven `not_started` or legacy `execution_unknown`; it does not establish observed zero runtime. Started-child duration is a lower bound from last durable activity, not total execution time. A short duration cannot attribute the interruption to CPU or memory: correlate Cloudflare invocation analytics and the last durable phase rather than interpreting missing activity as a controlled timeout.

## Remediation

- **Wrong CPU class (most common).** Keep the logical `schedule` string and `shared/lib/cron-cadences.ts` untouched, and add a `triggerSchedules` array of single-minute hourly expressions in `shared/lib/cron-jobs.ts`, mirrored into the owning config: public `worker/wrangler.toml` or heavy `worker/wrangler.heavy.toml`, as assigned by `shared/lib/scheduled-runner-registry.ts`. Slot identity, cadence, and status freshness derive from the logical cadence, so they do not move. Use the existing aliases in `shared/lib/cron-jobs.ts` as the pattern. See ADR-20 through ADR-22 and `docs/process/cron-trigger-policy.md`; crossing the reviewed physical-trigger gate requires that policy's review.
- **Same-isolate heap accumulation.** If a later serial child dies after an earlier large graph completed, CPU-class aliases and reordering are not a memory boundary. Move the later job to a separate physical invocation while preserving its logical cadence and admission fences; this prevents run-scoped overlap but does not guarantee that the same Worker service will allocate a new isolate. ADR-22 applies this precedent to DDR after 43 of 45 post-CPU-rebalance V9 losses landed on the resolver child.
- **Genuinely too much work for one invocation.** Reduce per-invocation CPU, or move the offending leg to its own logical schedule key and runner plan. Adding another alias to an existing key does not separate the jobs — every alias resolves to the same chain.
- **Memory rather than CPU.** The isolate limit is 128 MB and is shared by every job in the chain. `worker/src/lib/v9-slot-window.ts` already serializes the Safety Score V9 heap lane for this reason. Reorder so a large graph is built after any capture that must survive it, and import heavy modules only at the point of use.
- **Do not clear a lease to "fix" this.** Reconciliation already releases or expires the dead slot's lease. Clearing a live lease while `/api/status` shows a fresh `inFlight` progress row for the same job risks a concurrent second writer.
- **Observed memory kill versus telemetry unavailable.** The collector alerts on heavy kills in its trailing 24-hour window and incomplete required collection; public kills and incomplete public broad sampling are report-only initially (review after one week of baseline). Preserve source/version/lane evidence before changing code. Do not retry/rebalance automatically, infer OOM from abandonment alone, or subtract sampled bytes from 128 MiB; shared sampled isolate memory is not live phase headroom.

## Safety Score accepted projection recovery

**Symptom:** after the Release B strict-reader cutover, `compute-safety-score-v9` fails at `publication-gate` before compiling with `safety-score-v9-accepted-baseline-projection-missing`, `-invalid`, `-publication-mismatch` or `-read-failed`. Accepted publication/health remain unchanged; the failed attempt is recorded separately. Missing/invalid projections beside accepted state can follow a D1 restore to a pre-writer point, manual deletion or writer/reader skew. Preparation may report `accepted-source-unavailable` instead of previous-accepted lender backing. This is not by itself an OOM.

1. Preserve the named failure, deployed heavy/public versions and read-only cache evidence. Compare both projection identities, result digests and `publishedAtSec`/row clocks with the envelope identity and health's accepted generation/clock. Check D1 availability first for `-read-failed`; do not treat read errors or orphan replay/index/projection rows as bootstrap.
2. Make a **minimal temporary reader-only recovery change on the current head**, retaining subsequent fixes, current full-catalog/runtime-registry imports and Release A's atomic projection writers. There is no single revertable "Release B reader commit": `ef096e16a` cut over the call sites and `53e3425a3` subsequently moved their loaders. Do not blindly revert either commit or deploy a historical Release A build.
   - In `worker/src/lib/safety-score-v9/capture.ts`, switch `captureLenderCollateralBacking` from `loadSafetyScoreV9LenderCollateralState` to `loadSafetyScoreV9Publication(db)` plus `loadSafetyScoreV9PublicationHealth(db)` from `publication-store.ts`. Restore the full-publication lender extraction, not just the imports: require current health and matching accepted generation/clock; retain future-clock and 3,600-second age checks; select required tokens' eligible cards, resolve D>C>U causes and stable gap IDs, and hash each canonical card. The pre-cutover function body is available with `git show 'ef096e16a^:worker/src/lib/safety-score-v9/capture.ts'`; transplant only this function's reader/extraction body and its needed imports, not the historical file or registry imports.
   - In `worker/src/lib/safety-score-v9/publication-runner.ts`, replace the `loadSafetyScoreV9AcceptedBaselineState` block at `publication-gate` with `Promise.all([loadSafetyScoreV9Publication(input.db, publicationSignal), loadSafetyScoreV9PublicationHealth(input.db, publicationSignal)])`. Set `acceptedPublication` to `publication === null ? null : buildSafetyScoreV9AcceptedPublicationBaseline(publication)` and `previousHealth` to the loaded health. Import both loaders from `publication-store.ts` and the baseline builder from `publication-assessment.ts`; let read/decode errors propagate through the existing failed-attempt path. Remove the now-unused strict-reader error class/type imports. Do not reinstate retired schema-cutover plumbing.
   - Leave `accepted-projections.ts`, both projection writers and `accepted-projection-readers.ts` in place. Confirm neither active call site calls a strict reader (`git grep -n -E 'loadSafetyScoreV9(LenderCollateralState|AcceptedBaselineState)' -- worker/src/lib/safety-score-v9/capture.ts worker/src/lib/safety-score-v9/publication-runner.ts` must have no matches). Review/test the two-call-site change through the normal process, record it as a separate temporary recovery commit, and deploy heavy before public; allow any earlier publication lease to settle.
3. Let **one normal accepted `:22/:52` cycle** reseed both projections. A held or failed cycle does not reseed; wait for acceptance. Run these exact read-only queries against the same production database snapshot (not a preview database):

   ```sql
   SELECT key, updated_at, length(value) AS bytes,
          json_extract(value, '$.safetyScoreIdentity.model') AS model,
          json_extract(value, '$.safetyScoreIdentity.schemaVersion') AS identity_schema,
          json_extract(value, '$.safetyScoreIdentity.methodologyVersion') AS policy_version,
          json_extract(value, '$.safetyScoreIdentity.policyId') AS policy_id,
          json_extract(value, '$.safetyScoreIdentity.policyDigest') AS policy_digest,
          json_extract(value, '$.safetyScoreIdentity.evaluationBuildDigest') AS build_digest,
          json_extract(value, '$.safetyScoreIdentity.baseInputGenerationId') AS base_generation,
          json_extract(value, '$.safetyScoreIdentity.publicationGenerationId') AS generation,
          json_extract(value, '$.publicationResultDigest') AS result_digest,
          json_extract(value, '$.publishedAtSec') AS published_at
     FROM cache
    WHERE key IN ('report-cards:v9:accepted-baseline:v1',
                  'report-cards:v9:lender-collateral:v1')
    ORDER BY key;

   SELECT updated_at, 'v9' AS model, 1 AS identity_schema,
          json_extract(value, '$.identity.policyVersion') AS policy_version,
          json_extract(value, '$.identity.policyId') AS policy_id,
          json_extract(value, '$.identity.policyDigest') AS policy_digest,
          json_extract(value, '$.identity.evaluationBuildDigest') AS build_digest,
          json_extract(value, '$.identity.baseInputGenerationId') AS base_generation,
          json_extract(value, '$.identity.publicationGenerationId') AS generation,
          json_extract(value, '$.identity.resultDigest') AS result_digest
     FROM cache WHERE key = 'report-cards:v9';

   SELECT updated_at,
          json_extract(value, '$.status') AS status,
          json_extract(value, '$.acceptedPublicationGenerationId') AS generation,
          json_extract(value, '$.acceptedAtSec') AS accepted_at,
          json_extract(value, '$.attemptedAtSec') AS attempted_at
     FROM cache WHERE key = 'report-cards:v9:publication-health';
   ```

   Require exactly two projection rows and one envelope/health row, with no null identity/digest/clock fields. Every same-named identity/digest column in both projections must equal the envelope's; `policyVersion` in the envelope maps to projection `methodologyVersion`, and its decoder supplies `model = 'v9'` / identity schema `1`. Both projection `published_at` and `updated_at` must equal envelope `updated_at` and health `accepted_at`; health generation must equal that envelope generation, and health `updated_at` must equal `attempted_at`. These are the strict loader's identity/result/clock bindings, including its health decoder's row-clock check. A later held attempt may have a newer health attempt clock; it does not change the accepted clock. Any missing row, SQL/decode failure or mismatch means reseeding is not verified: stop, preserve evidence and investigate rather than reapplying strict readers.
4. Revert only the recorded temporary recovery commit on the then-current head (resolve any intervening edits by restoring the two strict-reader call sites/imports, not by replacing whole files) and deploy normally. Observe the first `:16/:46` preparation using the lender projection and the first successful `:22/:52` compile; correlate memory-monitor evidence separately.

Never hand-write projections, delete accepted state or clear a live lease to force reseeding. A dedicated fenced reseed tool requires separate owner approval; it is not this recovery procedure.

## Prevention

- Treat a sub-hourly logical cadence carrying CPU-heavy work as requiring the paired-hourly physical form. `shared/lib/__tests__/cron-jobs.test.ts` asserts the converted lanes keep single-minute hourly aliases so a regression to one comma expression fails CI instead of silently re-entering the 30-second class.
- Put the cheapest, most load-bearing jobs first in a chain and observers last only when they can tolerate loss. The status chain starts with `status-self-check`; fence presweeps and the unconditional reserve-recovery global sweep reconcile abandoned slots independently of that child chain. Daily cron-sentinel growth/duration observations precede retention work.
- Watch the tail, not the average. The sentinel's duration source (`worker/src/cron/cron-duration-watchdog.ts`) excludes synthetic reconciled rows from duration statistics and counts slot abandonment separately, so a lane can look healthy on duration while losing a quarter of its runs.
- Prefer durable queues for delivery work, but distinguish retryable pending rows from claimed deliveries. `dispatch-telegram-alerts` retries eligible `pending` rows; a delivery claim that expires in `sending` becomes terminal `execution_unknown` and is never retried. An abandoned slot can therefore lose or ambiguously deliver alerts; see [ADR-24](../architecture.md#adr-24) and `worker/src/cron/telegram-pending/drain.ts`. One-shot writers such as time-series snapshot jobs have no equivalent pending-queue retry path.
- Keep abandonment thresholds source-owned by `resolveScheduledSlotPolicy()` in `worker/src/lib/scheduled-slot-policy.ts`: 60-second heartbeat, 300-second slot silence (360 seconds for existing long runners), 300-second child silence and a 960-second hard-dead backstop. Same-key and global sweeps apply the same policy before candidate limits and again in CAS.
- Retain the external memory reports alongside first post-deploy lane/publication observations. A green monitor means only no currently observed alerting kills with fresh available required query evidence, not established heap margin, runway or proof a production defect is fixed.
- Carry one event-entry `SlotDeadline` through child waits and replay; clip local enrichment caps with `childCeilingMs()` rather than rebuilding a deadline from the producer slot or granting fresh time after admission waits. Readiness and output freshness clocks remain separate.

## Related

- `docs/worker-infrastructure.md` — deployed trigger topology and slot fencing
- `docs/worker-and-api-limits.md` — CPU, connection, and trigger budgets
- `docs/process/cron-trigger-policy.md` — physical-trigger growth gate
- `docs/status-dashboard.md` — how abandonment surfaces in `/api/status`
- `docs/yield-intelligence-operations.md` — the 2026-08-18 yield-lane precedent
