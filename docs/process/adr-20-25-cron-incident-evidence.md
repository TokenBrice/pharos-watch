# ADR-20–25 cron incident evidence

This page preserves dated incident evidence for ADR-20–25, not a current contract. Current constraints live in [ADR-20](../architecture.md#adr-20), [ADR-21](../architecture.md#adr-21), [ADR-22](../architecture.md#adr-22), [ADR-23](../architecture.md#adr-23), [ADR-24](../architecture.md#adr-24), and [ADR-25](../architecture.md#adr-25); current topology ceilings come from `CRON_GROWTH_HEADROOM_POLICY` in [`shared/lib/cron-jobs.ts`](../../shared/lib/cron-jobs.ts). Counts, schedules, registry projections and acceptance requirements below describe the recorded incident/review window, not today's inventory or completed acceptance.

Synthetic `platform-abandoned` rows in `cron_runs` are abandonment evidence, not proof of CPU exhaustion or OOM. [`worker/src/lib/scheduled-slot-reconciliation.ts`](../../worker/src/lib/scheduled-slot-reconciliation.ts) reconstructs a terminal row from stale slots/heartbeats; same-version reconciliation can rule against deploy interruption without identifying the platform resource cause. Cloudflare invocation analytics are separate evidence. Wall duration is not active CPU. Historical identifiers that no longer name current code are left in plain text.

## ADR-20

Introducing commit: [8786e3a5e](https://github.com/TokenBrice/pharos-watch/commit/8786e3a5e), [PR #921](https://github.com/TokenBrice/pharos-watch/pull/921).

The 2026-08-21 production D1 sample compared single-expression sub-hourly lanes with paired-hourly DEX lanes. At the time, Paid Cron Triggers below one-hour intervals had a 30-second CPU class, versus 15 minutes for hourly-or-longer expressions ([Cloudflare limits](https://developers.cloudflare.com/workers/platform/limits/)).

| Recorded lane and physical expression | Abandoned slots | Ratio |
| --- | ---: | ---: |
| `statusSelfCheckOffset`, `9,24,39,54 * * * *` | 28/96 | 29.2% |
| `v9SupplyAttributionOffset`, `8,23,38,53 * * * *` | 28/96 | 29.2% |
| `quarterHourly`, `*/15 * * * *` | 27/96 | 28.1% |
| `halfHourlyChartsOffset`, hourly `:16` + `:46` | 0/48 | 0.0% |
| `halfHourlyOffset`, hourly `:10` + `:40` | 1/48 | 2.1% |

In 140/146 reconciled rows, `slotWorkerVersion` equaled `reconciledByWorkerVersion`; deploy eviction was not the main explanation. Loss concentrated on serial-chain tails: compute-depeg-resolver lost 49/192 runs (25.5%), including six consecutive slots with no depeg resolution for 90 minutes; cron-staleness-watchdog and data-invariant-canary were starved for 90 and 75 minutes respectively.

The reviewed correction added hourly `triggerSchedules` aliases and corresponding Wrangler single-minute expressions without changing logical slots or cadences, fetch surface or connection pressure. The physical topology moved 25→34; growth was frozen pending consolidation or Queues/Workflows review, not treated as spare capacity.

`fiveMinuteTelegramAlerts` was deferred: 44/288 slots abandoned (15.3%), while hourly aliasing would cost +11 expressions. Seven-day child losses increased down the chain: dispatch-telegram-alerts 37, telegram-personalized-recap-planner 40, telegram-degradation-watchdog 44, telegram-disambiguation-cleanup 51, telegram-pulse-snapshot 68. The then-stated deferral premise was that dispatch drained a durable pending queue, making abandonment a delivery-latency cost; the record explicitly said a one-shot writer at the same rate would not be acceptable. ADR-24 later disproved that latency-only premise.

## ADR-21

Introducing commit: [095b1af60](https://github.com/TokenBrice/pharos-watch/commit/095b1af60), [PR #931](https://github.com/TokenBrice/pharos-watch/pull/931).

The review reused ADR-20's 2026-08-21 comparison: status and supply-attribution lanes each 28/96 (29.2%), quarter-hourly 27/96 (28.1%), hourly chart aliases 0/48, and hourly DEX aliases 1/48. V9 publication had been missed: its combined `22,52 * * * *` expression had the same sub-hourly CPU class, but it was neither corrected nor named as deferred work. Unlike the Telegram rationale, compute-safety-score-v9 was a one-shot publication writer: termination could lose an attempt rather than delay queued work. That comparison did not independently prove the resource cause of publication abandonment.

The correction deployed `22 * * * *` and `52 * * * *`, preserving logical `22,52 * * * *`, slot identity, half-hour cadence, publication window and zero-connection declaration. The +1 physical expression moved 34→35, compared with Telegram's costed +11; it added no logical work, fetch surface or connection pressure. Further growth beyond 35 remained frozen pending another ADR and consolidation/execution-substrate review.

## ADR-22

Introducing commit: [756285690](https://github.com/TokenBrice/pharos-watch/commit/756285690), [PR #960](https://github.com/TokenBrice/pharos-watch/pull/960).

Seven-day evidence on 2026-08-27 showed 82/671 supply-attribution slots abandoned despite hourly aliasing; 80 were same-version in-place deaths. Of 45 post-rebalance child losses, 43 occurred after attribution while compute-depeg-resolver loaded its review graph, versus two attribution losses. [74ca9d2b57](https://github.com/TokenBrice/pharos-watch/commit/74ca9d2b57) recorded Cloudflare's confirmed exceededMemory outcome for this chain. Both dynamic graphs included the large generated catalog; serial ordering and cooperative timeouts did not provide a memory boundary.

DDR moved unchanged into depegResolverOffset at logical `13,28,43,58`, with four hourly aliases. Its declarations remained D1-only (0/6), 900-second freshness, and the core/version plus V9 memory-lane admission fence. The goal was separation of run-scoped graphs, not a promise of separate warm isolates within one Worker service; observed production runs remained acceptance evidence. DDR scanned approximately 8,800 incident rows, crossing the fan-out review threshold, but a separate D1-only snapshot compiler with sub-30-second p95 was judged simpler than Queue/Workflow orchestration.

The same review gave halfHourlyMintBurnCritical hourly `:04`/`:34` aliases: 17/332 healthy runs lasted over 30 seconds, and three same-version 2026-08-21 abandonments ended at 42–133 seconds. The review called this a CPU-class hazard despite the low rolling abandonment ratio; duration and synthetic rows alone do not prove CPU exhaustion.

The 35→34 bridge was retirement of the neutral DEX `:40` trigger in [bb8ea7a8e](https://github.com/TokenBrice/pharos-watch/commit/bb8ea7a8e), [PR #952](https://github.com/TokenBrice/pharos-watch/pull/952), on 2026-08-26. ADR-22 then added one logical zero-fetch plan and five net physical expressions, 34→39, with 32 fetch-capable entries and two 5/6 slots unchanged. Further growth beyond 39 remained frozen pending another ADR and consolidation/execution-substrate review.

## ADR-23

Introducing commit: [e3ca3130f](https://github.com/TokenBrice/pharos-watch/commit/e3ca3130f), [PR #1006](https://github.com/TokenBrice/pharos-watch/pull/1006).

ADR-22 corrected only the critical mint/burn lane; halfHourlyMintBurnExtended retained combined `18,48 * * * *` and its 30-second CPU class. [a988acf22](https://github.com/TokenBrice/pharos-watch/commit/a988acf22) removed the 15-MiB rich registry from that lane. On 2026-09-01, Worker version 7c171ad5-6421-49bd-8a5e-78408420bf87 completed the 14:18 UTC attempt in 61.3 seconds, but the 14:48 and 15:18 attempts stopped heartbeating after 39 seconds at scan-config. They were reconciled as same-version `platform-abandoned`, with `interruptedByWorkerVersionChange=false`.

**Attribution limit:** ADR-24's invocation analytics window, 2026-08-26 through 2026-09-02, covers these 2026-09-01 attempts and recorded zero exceededCpu and 196 exceededMemory outcomes. The CPU-class attribution for the ADR-23 deaths is therefore unproven; the configured class and wall durations do not resolve it.

The reviewed correction preserved logical `18,48 * * * *` and slot identity while deploying hourly `18 * * * *` / `48 * * * *`. It added one physical expression, 39→40, but no logical work, fetch-capable entry or connection pressure. The lane remained isolated at 1/6 with 122 configured units; normal runtime was far below the 10-minute and 1,000-unit Queue/Workflow review thresholds. The review chose aliasing over ingestion changes/orchestration and froze growth beyond 40 pending another ADR and consolidation/execution-substrate review.

## ADR-24

Introducing commit: [e738724aa](https://github.com/TokenBrice/pharos-watch/commit/e738724aa); amendment: [705cea3d1](https://github.com/TokenBrice/pharos-watch/commit/705cea3d1).

Production evidence on 2026-09-02 contradicted ADR-20's CPU/latency-only Telegram premise. Cloudflare workersInvocationsAdaptive analytics for 2026-08-26 through 2026-09-02 recorded 196 exceededMemory outcomes and zero exceededCpu. D1 abandonment concentrated on `:27`/`:57` safety fan-out after `:22`/`:52` V9 publication: 20/96 event-carrying runs abandoned over 48 hours, versus 2/480 eventless runs, always at fanout-built after 17–39 seconds during the pending drain.

Every kill reconciled in-flight sending rows to execution_unknown with pending_effect_owner_lost; 317 such rows had accumulated since 2026-07-29. The Bot API effect was unconfirmed and not retried by contract, so due deliveries became permanently ambiguous, not merely late.

Eleven Telegram modules imported the rich shared registry, inlining 15.8 MB of coins.generated.json and giving the five-minute bundle 19.0 MB of inputs within a 128 MB isolate. The lane then needed only id, symbol, name, status and pegCurrency. The reviewed runtime projection added name/pegCurrency and pre-launch/active-meta indexes, moved all eleven modules to the narrow registry, and reduced bundle inputs 19.0→3.2 MB. The mint-burn reachability policy also bundled five-minute-telegram.ts to prevent the full registry's return. Triggers, schedules, slots and connection budgets did not change; topology stayed 40.

On Worker 07c1ac69, the 20:27 and 20:57 UTC safety-event dispatches completed, but exceededMemory immediately afterward abandoned watchdog, cleanup and pulse sidecars. The second heap source was telegram-alert-context.ts calling loadActiveSafetyScoreSource for the Context line: full approximately 8 MB V9 publication gunzip/parse on every event-carrying dispatch. This bypassed the thin `alert-safety-v9-source` envelope introduced after the 2026-08-19 OOM. Worker 647e5b01 instead read grade, score and publication identity from that envelope.

Then-stated two-part acceptance required the first week of production `:27`/`:57` safety-event dispatches on 647e5b01 or later to complete **with sidecars**, with no `platform-abandoned`, exceededMemory or new pending_effect_owner_lost rows. If abandonment persisted, the next candidates were bounding drainPendingQueue claims/materialization and then the +11 hourly-alias rebalance. This page does not close that production gate.

## ADR-25

Introducing commit: [55408152c](https://github.com/TokenBrice/pharos-watch/commit/55408152c).

On 2026-09-03, trailing-day Cloudflare analytics showed 16 Worker errors, all memory-limit outcomes and no CPU-limit outcomes. Memory percentiles were p50 112.72 MB, p90 143.38 MB and p99 175.36 MB against the 128 MB isolate limit. At 03:00 UTC, `quarterHourly`, `halfHourlyMeasuredExecution` and `daily0300Utc` stopped heartbeating on the same Worker version and were reconciled as abandoned; daily child rows were unavailable because their parent invocation died, not because independent daily-child failures were proven.

Bundle tracing found the quarter-hourly core legitimately required the rich catalog, whereas snapshot-supply and prune-detail-cache were membership-only consumers that could use the narrow runtime registry unchanged. A blanket full-registry ban on quarter-hourly/daily entrypoints would have encoded a false boundary.

The correction preserved logical `:00/:30` and 03:00 freshness slots but deployed measured execution at `5,35 * * * *` and daily housekeeping at `3 3 * * *`. Physical expressions remained 40, connection peaks were unchanged, and measured execution still preceded the hourly `:10` DEX source stage. Narrow membership projections reduced avoidable allocations; staggering prevented the three rich run-scoped graphs starting together, without promising isolate separation within the service. Then-stated acceptance required clean first production executions of the staggered measured and daily triggers and no corresponding exceededMemory or `platform-abandoned` outcomes. This page does not certify that acceptance.
