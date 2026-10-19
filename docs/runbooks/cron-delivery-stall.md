# Scheduled delivery stall

## Evidence and prerequisite

`scheduled_delivery_stalled` means no actual start across the three canonical short-cadence lanes for strictly more than 600 seconds; strictly more than 1200 seconds is stale. Reserve recovery now polls each minute; Telegram and digest polls retain five minutes. The historical `lastFiveMinuteStartedAt` field and delivery budgets are unchanged. `scheduler_liveness_unavailable` means missing, future, or unreadable evidence, not healthy delivery. `/api/health` and authenticated `/api/status?refresh=live` read this without waiting for a cron. Per-lane silence is diagnostic while another canonical lane starts; hourly activity cannot clear the gate. Edge caching and polling can add visibility lag.

`heavy_scheduled_delivery_stalled` independently checks `schedulerLiveness.heavy`: the fastest lane owned by `worker: "heavy"` in `shared/lib/scheduled-runner-registry.ts`; see the [canonical cron table](../worker-infrastructure.md#cron-scheduling) for its logical cadence, physical aliases and slot identity. Strictly more than 1800 seconds (two missed 15-minute slots) warns; strictly more than 2700 seconds is stale. `heavy_scheduler_liveness_unavailable` means absent, invalid, or unreadable heavy start evidence, not zero age or healthy delivery. Both budgets come from `STATUS_HEAVY_SCHEDULER_LIVENESS_THRESHOLDS` in `shared/lib/status-thresholds.ts`. Healthy public starts cannot clear a heavy delivery failure; both roles contribute to public health and admin availability.

For platform evidence, provide `CLOUDFLARE_API_TOKEN` in the environment with Cloudflare Analytics read permission for the account. Never print the token or scrape Wrangler OAuth files. Optional `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_WORKER_NAME` select another explicit target.

```bash
npm run ops:cron-delivery -- --minutes 240
CLOUDFLARE_WORKER_NAME=stablecoin-heavy npm run ops:cron-delivery -- --minutes 240
```

The helper defaults to `stablecoin-api` and prints the selected script name. It reads GraphQL `workersInvocationsScheduled`, the delivery/resource-outcome ground truth. It rejects transport, GraphQL, schema and possible truncation failures; reduce the window on truncation. An empty window is absent evidence, not success. Compare `datetime`, `scheduledDatetime`, `cron`, `status` and `cpuTimeUs` against the missing lane clocks for each script separately. Cloudflare status values other than "success" (internal errors, exceeded memory/CPU, thrown exceptions) are platform evidence; child `cron_runs` alone cannot prove the trigger was delivered. `--raw` emits JSON rows instead of the human-readable summary.

For numeric memory and OOM attribution, use [`npm run ops:worker-memory`](./cron-slot-abandonment.md#first-checks) and the hourly Worker Memory Monitor artifacts. Scheduled is delivery evidence, **not a complete memory-outcome authority**: its `internalError`/`clientDisconnected` labels can correspond to Adaptive `exceededMemory`. The independent error-filtered Adaptive inventory and exact-second/CPU correlation preserve that distinction; no Scheduled non-success label alone establishes an OOM.

## Triage and lost slots

1. Read public health and admin live status. Retain `observedAt`, `lastAnyStartedAt`, `lastFiveMinuteStartedAt`, public lane clocks, `heavy.scheduleKey` / `heavy.lastStartedAt`, each role's age/budgets/status and unavailable reason.
   `lastAnyStartedAt` is permanent investigative context subject to clock validity, never the public short-cadence or heavy freshness clock. An unrelated lane start cannot conceal delivery stalls; a malformed/future overall clock makes evidence unavailable.
2. Use approved read-only D1 SELECT access: `SELECT slot_key, MAX(started_at) AS last_start FROM cron_slot_executions GROUP BY slot_key`. Use actual `started_at`, not scheduled time, leases, heartbeats or child completion.
3. Correlate platform scheduled invocations, deployed Worker version, recent rollout and Cloudflare incident evidence. Separate delivery absence from a delivered slot whose child crashed or held publication.
4. Inspect producer generations and dependent publication clocks. Missed triggers are lost opportunities, not proof that a later run replayed them. Historical gap repair requires the lane's existing generation-bound procedure; never invent completed rows.

## Recovery

No automatic schedule PUT/reset is permitted. Do not reset leases, checkpoints or cron rows. The external GitHub monitor declares `*/15 * * * *` UTC plus manual dispatch, but delivery is best-effort (30-day review: median gap ~4.7 h), not a ten-minute external SLA. It upserts one open incident issue before failing on stall/unavailability or transport/schema failure.

A platform delivery stall may recover without a configuration change. Keep observing platform events and successive live requests. Close the incident only after actual starts resume for the affected role and affected producer/publication evidence is current; other independent blockers may remain. An operator-directed schedule change requires a reviewed Cloudflare/deployment procedure and preserved before/after evidence, never an in-dashboard repair button.

If the paired deploy is verified but Analytics shows zero heavy-script invocations while public delivery continues, an authorized operator can re-PUT the heavy trigger configuration without redeploying code. Execute from `worker/`:

```bash
npx wrangler triggers deploy --config wrangler.heavy.toml
```

This remedy is not automatic and does not reset leases, checkpoints, or replay lost slots. Preserve the pre-change schedule and version evidence, then verify new `stablecoin-heavy` Analytics invocations and actual `v9SupplyAttributionOffset` starts. A successful trigger PUT alone is not recovery evidence.

## Rollback

Worker/Pages rollback restores code behavior, not lost events or D1 state. Additive migration `0259` indexes remain installed (after reserve-lane `0258`); do not drop them or reset state as part of rollback. Preserve the pre-window Time Travel bookmark, migration ledger and Worker version through the normal deployment procedure. A stall entirely between cron observations cannot acquire fabricated status-history transitions; retain the external workflow/issue evidence separately.
