# ADR-26 Workflows spike: production measurement record

Measurement date: 2026-09-03 07:54:27 UTC. The requested 14-day lower bound was Unix `1787212467` (2026-08-20 07:54:27 UTC); `cron_runs` retained candidate rows only from 2026-08-27 through the query time (`1788422067`). Therefore the figures below are the available retained sample, not a claim that the full 14 days exist in D1.

Decision and enduring parity gate: [Architecture: ADR-26](../architecture.md#adr-26). Navigate to [duration/error measurements](#duration-and-error-query), [failure classes](#failure-class-query), [Workflow limits and cost](#workflow-source-notes), or the [lane parity matrix](#parity-answers-and-lane-decisions).

## Duration and error query

Exact command SQL (read-only remote D1 query):

```sql
WITH candidate AS (SELECT job, duration_ms, status, metadata, ROW_NUMBER() OVER (PARTITION BY job ORDER BY duration_ms) AS rank_no, COUNT(*) OVER (PARTITION BY job) AS n FROM cron_runs WHERE started_at >= 1787212467 AND job IN ('compute-safety-score-v9','sync-dex-liquidity-stage','sync-cl-exit-depth','sync-live-reserves','compute-depeg-resolver','digest-trigger-poll','daily-digest')) SELECT job, n AS runs, MIN(CASE WHEN rank_no >= (n + 1) / 2 THEN duration_ms END) AS p50_ms, MIN(CASE WHEN rank_no >= (95 * n + 99) / 100 THEN duration_ms END) AS p95_ms, SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_runs, SUM(CASE WHEN lower(COALESCE(metadata, '')) LIKE '%exceededmemory%' THEN 1 ELSE 0 END) AS exceeded_memory_class, SUM(CASE WHEN lower(COALESCE(metadata, '')) LIKE '%exceededcpu%' OR lower(COALESCE(metadata, '')) LIKE '%exceeded_cpu%' THEN 1 ELSE 0 END) AS exceeded_cpu_class FROM candidate GROUP BY job, n ORDER BY job
```

| job | retained runs | p50 | p95 | error rows | D1 `exceededMemory` markers | D1 `exceededCpu` markers |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `compute-depeg-resolver` | 690 | 16,278 ms | 26,969 ms | 17 | 0 | 0 |
| `compute-safety-score-v9` | 346 | 28,076 ms | 48,891 ms | 9 | 0 | 0 |
| `daily-digest` | 143 | 4,117 ms | 11,400 ms | 22 | 0 | 0 |
| `sync-cl-exit-depth` | 353 | 42,312 ms | 99,477 ms | 16 | 0 | 0 |
| `sync-dex-liquidity-stage` | 172 | 109,819 ms | 156,823 ms | 2 | 0 | 0 |
| `sync-live-reserves` | 48 | 349,068 ms | 496,272 ms | 2 | 0 | 0 |
| `digest-trigger-poll` | 0 | — | — | 0 | 0 | 0 |

The percentile query uses the nearest-rank form: `ceil(n/2)` and `ceil(0.95n)` (SQLite integer arithmetic). The `daily-digest` rows are the only `cron_runs` proxy for the digest-intent lane; `digest-trigger-poll` itself has no logger row when no intent is pending.

## Failure-class query

Exact command SQL (read-only remote D1 query):

```sql
SELECT job, COALESCE(json_extract(metadata, '$.failureCategory'), '(none)') AS failure_category, SUM(CASE WHEN lower(COALESCE(error, '')) LIKE '%memory%' OR lower(COALESCE(metadata, '')) LIKE '%memory%' THEN 1 ELSE 0 END) AS memory_markers, SUM(CASE WHEN lower(COALESCE(error, '')) LIKE '%cpu%' OR lower(COALESCE(metadata, '')) LIKE '%cpu%' THEN 1 ELSE 0 END) AS cpu_markers, COUNT(*) AS rows FROM cron_runs WHERE started_at >= 1787212467 AND job IN ('compute-safety-score-v9','sync-dex-liquidity-stage','sync-cl-exit-depth','sync-live-reserves','compute-depeg-resolver','daily-digest') GROUP BY job, failure_category ORDER BY job, failure_category
```

| job | failure category | rows | memory markers | CPU markers |
| --- | --- | ---: | ---: | ---: |
| `compute-depeg-resolver` | `(none)` | 673 | 0 | 0 |
| `compute-depeg-resolver` | `platform-abandoned` | 17 | 0 | 0 |
| `compute-safety-score-v9` | `(none)` | 337 | 0 | 0 |
| `compute-safety-score-v9` | `platform-abandoned` | 9 | 0 | 0 |
| `daily-digest` | `(none)` | 121 | 0 | 0 |
| `daily-digest` | `platform-abandoned` | 22 | 0 | 0 |
| `sync-cl-exit-depth` | `(none)` | 337 | 0 | 0 |
| `sync-cl-exit-depth` | `platform-abandoned` | 16 | 0 | 0 |
| `sync-dex-liquidity-stage` | `(none)` | 170 | 0 | 0 |
| `sync-dex-liquidity-stage` | `platform-abandoned` | 2 | 0 | 0 |
| `sync-live-reserves` | `(none)` | 47 | 0 | 0 |
| `sync-live-reserves` | `platform-abandoned` | 1 | 0 | 0 |

`platform-abandoned` is the D1 reconciliation class, not a Cloudflare resource-outcome label. No `exceededMemory`/`exceededCpu` marker appears in the retained `cron_runs` metadata or error text; Cloudflare invocation analytics would be required to assert platform resource outcomes separately.

## Workflow source notes

Official Cloudflare references consulted on 2026-09-03:

- [Workflow limits](https://developers.cloudflare.com/workflows/reference/limits/): Paid step CPU defaults to 30 seconds and is configurable to 5 minutes; step wall duration is unlimited; each step's non-stream result and payload are 1 MiB; max steps 10,000 (configurable to 25,000); retries per step 10,000; Cron-triggered instances have a one-hour budget without consuming the normal Workflow concurrency slot.
- [Workflow pricing](https://developers.cloudflare.com/workflows/reference/pricing/): Paid included usage is 10 million requests/month, 30 million CPU-ms/month, 500,000 steps/month, and 1 GB-month storage; overage is $0.30/million requests, $0.02/million CPU-ms, $0.80/100k steps, and $0.20/GB-month storage. Wait/sleep/idle time does not consume CPU.
- [Sleeping and retrying](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/): `step.do` retries are configurable (default limit 5, 10-second exponential delay); timeout applies per attempt; `NonRetryableError` suppresses retries.
- [Trigger Workflows](https://developers.cloudflare.com/workflows/build/trigger-workflows/): instance IDs are unique within a Workflow; the event exposes `instanceId` and schedule metadata; restart reruns steps and is not a takeover/fence API.
- [Workers API](https://developers.cloudflare.com/workflows/build/workers-api/): `step.do` is the per-step execution boundary.

Cost envelope at the plan's ~50 instances/day: 1,500 instance requests/month and approximately 7,500 steps/month for five steps/instance, both inside included Paid usage. Actual cost is active CPU, not cron wall time. A deliberately conservative upper bound of 300,000 active CPU-ms per instance yields 15 million CPU-ms/day across the fleet; after the 1 million CPU-ms/day share of the monthly allowance, the CPU-only overage is about $0.28/fleet-day ($0.0056 per instance, $8.40/fleet over a 30-day month). This is a ceiling scenario, not an observed measurement.

## Parity answers and lane decisions

This matrix records the 2026-09-03 spike, not the current implementation state. The six required questions are answered for each candidate below. For Q6, `50/day` is the planning envelope, not an observed Workflow count. Use the cost envelope in [Workflow source notes](#workflow-source-notes); wall-clock p95 is not active CPU and cannot establish actual price.

| Lane | Q1: exactly once / slot | Q2: clock and limits | Q3: retry and six-fetch budget | Q4: replay-sensitive D1 writes | Q5: observability | Q6: cost per instance-day | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| V9 publication | No replacement: deterministic ID dedupes a create, but the cron fence/takeover remains authoritative. | Current p95 48.9 s; Cron has 15 min wall time with a 60 s controlled-error reserve. Workflow step wall time is unlimited, but active CPU is 30 s by default (5 min max); split compile and writes into bounded steps. | Four fixed-input cache reads can remain under six; automatic retries still repeat writes and must be limited to the write step. | `persistAlertSafetyV9SourceEnvelope` uses generic `INSERT OR REPLACE` via `setCache`; an older retry can overwrite a newer envelope. Publication/attempt cache upserts are timestamp guarded. | Workflows do not emit a terminal `cron_runs` row; pass a deterministic instance ID into an explicit logger wrapper and retain status-oracle publication. | Five steps at 50/day is about 7,500 steps/month and 1,500 requests/month, within Paid inclusions; active CPU is the cost uncertainty (see Workflow source notes above). | **GO for one-week shadow only**; **NO-GO** authoritative cutover until the envelope write and terminal wrapper are proven. |
| DEX scoring stage | No: generation ID is deterministic, but stage reset/prune and downstream publication still need the slot fence. | Current p95 156.8 s; chunk payloads fit a step only with bounded input/output (1 MiB Workflow payload/result limits). Step wall time removes the 15-min concern, not payload or active-CPU limits. | Provider fan-out must be explicitly capped at six; stage is statically 5/6 and measured execution has a separate RPC-heavy phase, so step retries cannot be enabled until fan-out and retry admission are serialized. | Stage chunks upsert, but `surface_publication_generations`, measured target/quote rows use plain `INSERT`; `writeDexSourcePaginationState` unconditionally upserts the cursor. | Add one terminal row per instance; current generation and slot reports remain the operational oracle. | Same 50/day formula; no per-lane active-CPU sample exists, and the 156.8 s wall p95 cannot be priced as CPU. | **NO-GO** pending bounded provider steps, idempotent generation/target/quote writes, and a shadow replay. |
| CL exit depth | No: `<lane>:<slotStartedAt>` does not replace the slot fence or RPC admission ledger. | Current p95 99.5 s; step wall time is unlimited, but each step's active CPU and 1 MiB result/payload limits still apply to a bounded provider partition. | The `~1,300` RPC admissions must be split and throttled so retries cannot exceed six simultaneous fetches; retrying an entire aggregate step is unsafe. | Measured-execution target/quote generation and rows are plain inserts; the shared source pagination cursor is an unconditional conflict update. | A terminal `cron_runs` row and producer identity are required for each Workflow instance; Workflow history alone is not the status oracle. | Same 50/day formula; request/step inclusions cover a five-step shape, while active CPU and storage require measurement. | **NO-GO** with the DEX stage until the reduced measured-execution scope is replay-safe. |
| Live reserves | No: per-coin attempt fencing, deferred-tail ownership, and the five-minute recovery trigger are cross-invocation semantics a Workflow ID cannot claim. | Current p95 496.3 s; Cron's 15-min window and 60 s reserve are already adequate, but the resume path—not wall time—is the contract. Workflow step wall time is unlimited and does not remove the need for one resume pointer. | Preserve per-coin CAS/readback and bounded fetch phases; automatic retry of a cursor/checkpoint step can replay a tail and must be owner-checked. | Cursor cache uses replace/delete, reserve snapshot uses generic replace, and circuit-breaker outcomes use a read/compute/replace sequence; history inserts are `OR IGNORE` and composition finalization is CAS-guarded. | Keep the existing cron terminal row, recovery telemetry, and slot fence; a Workflow would add a second status system without reducing recovery state. | Same 50/day formula; the long wall p95 is not active CPU evidence and does not justify Workflow cost/complexity. | **NO-GO**; keep cron-native and complete the one-pointer/write-diet work separately. |
| Depeg resolver (DDR) | No: an instance ID cannot replace canonical incident fencing, lock state, or publication coordination. | Current p95 27.0 s; Workflow steps could isolate the heap, with unlimited step wall time and 30 s default/5 min max active CPU, but each generated result must stay within 1 MiB. | Automatic retries replay multi-table lock/publication batches; serial D1 steps are required, and no retry policy may exceed the six-fetch contract of any shared step. | Canonical incident/link/revision/membership paths contain plain inserts; public assessment/prediction sealing contains plain inserts; publication manifest v2 is a plain insert with `MAX(snapshot_sequence)+1`; snapshot/review evidence caches use replace. Lock audits are `OR IGNORE`, but that does not make the whole transaction replay-safe. | Require a deterministic terminal `cron_runs` row and preserve status-oracle publication; Workflow completion alone is insufficient for degraded/repair states. | Same 50/day formula; heap isolation may reduce failures, but D1 write volume and active CPU must be measured in shadow. | **NO-GO** until every write in a retried step is idempotent and the publication/repair replay is shadow-proven. |
| Digest intent | No Workflow cutover: this is a request, not a schedule slot; a Workflow ID still cannot replace request-id dedupe and the daily-digest lease. | `digest-trigger-poll` has no `cron_runs` rows when idle; its `daily-digest` proxy p95 is 11.4 s. Queue delivery avoids the poll wall clock; Workflow step limits add no value to the intent state machine. | Queue retries are acceptable only with request-ID dedupe and idempotent outbox effects; a Workflow retry would repeat singleton cache transitions and digest side effects. | Admin intent and poll state use singleton cache replace/delete; the digest/outbox writes must be keyed by request ID before any retrying substrate. | Queue message status plus the existing `daily-digest` terminal row is sufficient; do not create a second `digest-trigger-poll` logger stream. | Same 50/day formula; Queue is the lower-cost/simple fallback and has no Workflow step reason to pay for this polling-shaped work. | **NO-GO for Workflow**; use a request-ID-deduped Queue message to remove `digestTriggerPoll`. |

## Pilot implementation status at measurement time

**Pilot implementation status (2026-09-03).** The V9 shadow Workflow, deterministic post-cron trigger, generation-scoped shadow cache artifact, terminal `compute-safety-score-v9-workflow` row, off-by-default kill switch, and replay-focused unit tests are staged. The Worker exports `SafetyScoreV9PublicationWorkflow` through a thin entry shell whose `run()` dynamically imports the implementation, keeping the compiler graph out of fresh fetch and scheduled isolates. No cutover conditions are satisfied by implementation alone: the approximately seven-day live shadow and all six parity answers remain required.
