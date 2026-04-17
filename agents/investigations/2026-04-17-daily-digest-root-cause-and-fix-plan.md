# Daily Digest Failure — Root Cause & Durable Fix Plan (2026-04-17)

**Author:** Debug session follow-up to `2026-04-17-daily-digest-manual-trigger-timeout-handoff.md`.
**Scope:** Explain why the 2026-04-17 scheduled digest failed, why the post-deploy manual trigger produced nothing, and what to change so both paths are reliable.

---

## TL;DR

There are two distinct failure modes, both introduced by the 2026-04-16 digest enhancement deploy (Opus 4.7 + adaptive thinking + `effort: "max"` + `max_tokens: 16000`):

1. **Scheduled path (2026-04-17 08:05 UTC run):** The old `ANTHROPIC_TIMEOUT_MS = 300_000` (5 min) was no longer enough for an Opus 4.7 max-effort digest. Commit `cdcd5968` already addresses this. We expect the 2026-04-18 scheduled run to succeed, modulo the headroom concerns listed below.

2. **Manual trigger path (post-deploy retry):** The manual trigger runs the digest inside `execCtx.waitUntil(...)` on an HTTP `fetch` invocation. Per Cloudflare's documented runtime semantics, HTTP-triggered `ctx.waitUntil()` is capped at **~30 seconds of tail work after the response is sent**, not 15 minutes. An Opus 4.7 digest now takes well over 30 seconds, so the Worker isolate is terminated mid-fetch. The `catch`/`finally` in `logCronRun` never runs — which is why **no `cron_runs` row** was written and the lease heartbeat never renewed.

Durable fix: keep `cdcd5968` as the floor, tighten the scheduled-path headroom, and rearchitect the manual trigger so it no longer relies on long-running `waitUntil`. The cleanest option is a deferred-execution pattern: the manual HTTP endpoint sets a D1 flag; a frequent scheduled cron consumes the flag and runs the digest under 15-minute scheduled-event wall-clock.

---

## Evidence & Root Cause

### Evidence

Historical `cron_runs` for `daily-digest` (from D1):

| Run (UTC)          | Duration   | Status   | Note |
|--------------------|-----------:|----------|------|
| 2026-04-17 08:05:00 | 311 654 ms | error    | `TimeoutError: The operation was aborted due to timeout` |
| 2026-04-16 08:05:03 |  52 062 ms | degraded | Post-Opus-4.7 deploy, first successful run |
| 2026-04-15 08:05:35 |  28 931 ms | ok       | Pre-Opus-4.7 baseline |
| 2026-04-14 08:05:45 |  26 624 ms | ok       | Pre-Opus-4.7 baseline |
| 2026-04-13 08:05:56 |  24 884 ms | ok       | Pre-Opus-4.7 baseline |
| 2026-04-12 08:05:33 |  25 168 ms | ok       | Pre-Opus-4.7 baseline |

- Pre-Opus-4.7 runs finished in ~25–29 s.
- First Opus-4.7 run (2026-04-16) doubled to 52 s and came back `degraded`. Still under 5 min.
- Second Opus-4.7 run (2026-04-17) exceeded 5 min and was killed by `AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS)`. Duration 311 654 ms ≈ 300 s + 11 s of error handling, perfectly consistent with the old 5-minute Anthropic timeout firing.
- After deploying `cdcd5968`, the manual trigger:
  - Acquired a lease at 08:37:01 UTC.
  - Never renewed the heartbeat (first renewal was scheduled for ~08:42:11).
  - **Inserted no `cron_runs` row at all** — not even an error row.
  - Left an orphan expired lease at 08:52:31.

### Root cause — scheduled path

`worker/src/cron/digest/platform.ts:60` sends:
- `model: "claude-opus-4-7"`
- `thinking: { type: "adaptive" }`
- `output_config: { effort: "max" }`
- `max_tokens: 16000`

With the 2026-04-16 plan's tighter prompts and new data blocks (momentum candidates, chain mint/burn, WoW deltas, forward-look constraint, voice guards), the model spends substantially more time thinking. Duration has jumped from ~25 s to ~52 s to >5 min within three consecutive daily runs as the model explores more at max effort.

The old `ANTHROPIC_TIMEOUT_MS = 300_000` (5 min) was sized in Task 1 of the enhancement plan ("Bump Anthropic timeout to 300 seconds") as a theoretical 30–120 s + buffer. Production proved it insufficient once the model stabilized into its new thinking regime.

`cdcd5968` raised both `ANTHROPIC_TIMEOUT_MS` → 14 min and `CRON_TIMEOUT_MS["daily-digest"]` → 14.5 min. This fits inside Cloudflare's 15-minute scheduled-event wall-clock ceiling. **The scheduled path should now succeed** — but the headroom is extremely thin (see "Residual Risks" below).

### Root cause — manual trigger path

`worker/src/api/admin-actions.ts:63` (`handleTriggerDigest`):

```ts
execCtx.waitUntil(
  runManualDigestTrigger(db, anthropicApiKey ?? null, telegramCreds ?? null, requestId)
    .catch((err) => { console.error(...); }),
);
return jsonResponse({ ok: true, accepted: true, requestId, ... }, { status: 202, noStore: true });
```

The handler returns 202 immediately and relies on `ctx.waitUntil()` to keep the Worker alive while the digest runs.

**Cloudflare's documented runtime behavior:**

> Duration measures wall-clock time from start to end of a Worker invocation. There is no hard limit on duration for HTTP-triggered Workers — as long as the client remains connected.
>
> When the client disconnects, all tasks associated with that request are canceled. Use `event.waitUntil()` to delay cancellation for **another 30 seconds** or until the promise you pass to `waitUntil()` completes.

Flow of the broken run:

1. Pages Function (`functions/api/admin/[[path]].ts`) calls `ops-api.pharos.watch/api/trigger-digest` with `DEFAULT_PROXY_TIMEOUT_MS = 10_000`.
2. Worker returns 202 immediately. Pages returns 202 to the browser.
3. Pages' upstream fetch completes; as far as the Worker is concerned, the "client" has disconnected.
4. Worker has ~30 seconds of tail work via `ctx.waitUntil()`.
5. Anthropic call at Opus 4.7 max effort needs minutes. At T+~30 s, the Cloudflare runtime terminates the isolate.
6. The in-flight fetch is dropped. The `setInterval` heartbeat (scheduled for T+310 s) never fires. `logCronRun`'s `catch`/`finally` never runs because the isolate was killed, not an exception thrown. **No row gets written.**

This is consistent, every time, for Opus 4.7 max-effort digest generation.

A common misconception worth flagging (and directly relevant here): `waitUntil()` does **not** extend the overall invocation budget in the way the handoff doc hypothesized. The quote from CF docs: *"waitUntil() doesn't extend the timeout — it just lets you do cleanup work after sending the response. The isolate still shuts down at the same time limit. It extends execution after the response is sent, not the overall request processing time."*

### Cross-reference

- This pattern was previously partially diagnosed in `agents/research/2026-03-27-digest-timeout-investigation.md`, which moved the manual trigger *into* `waitUntil` to escape the Pages proxy's short upstream timeout. That fix was correct for 30 s digests but insufficient for 5-minute ones. The assumption that `waitUntil` extends the Worker's lifetime arbitrarily is not what CF actually provides.

---

## Residual Risks After `cdcd5968`

Even if the scheduled path succeeds tomorrow, the current config leaves very little margin:

| Budget slice                           | Current cap | Notes |
|----------------------------------------|-------------|-------|
| Cloudflare scheduled-event wall-clock  | 15 min      | Hard platform ceiling. |
| `CRON_TIMEOUT_MS["daily-digest"]`      | 14.5 min    | Wrapper timeout; aborts via `AbortSignal`. |
| `ANTHROPIC_TIMEOUT_MS` (single request)| 14 min      | Per-request timeout in `fetchWithRetry`. |
| `ANTHROPIC_MAX_RETRIES`                | 4           | Shared with outer budget; 5 attempts theoretically allowed. |
| Corrective retry in `requestDigestCopy`| —           | If quality checks fail, the prompt is rebuilt and the model is called a second time. |

Concrete risk:

1. **First-pass takes 10 min → quality issues → corrective retry has ~4 min left.** The retry will likely time out and write a `degraded`/error row, wasting the whole scheduled slot.
2. **First-pass takes 14 min → AbortSignal fires → `fetchWithRetry` catches → retry loop may attempt another fetch (since the outer timeout is >= per-request timeout).** Actually the outer signal is `AbortSignal.any([signal, AbortSignal.timeout(14 * 60_000)])` — once it's aborted, `throwIfAborted(signal)` at the top of the next loop iteration re-raises and we exit cleanly. Verified safe.
3. **D1 persistence + Telegram delivery + final `cron_runs` insert** have less than 60 seconds of the 15-min ceiling left. Any D1 overload (with its own 3-retry backoff) can push over.
4. **Heartbeat cadence** is 310 s (`ttlSec/3 = 930/3`). For a 14-min job, only 2 renewals fire. One stalled D1 write and `maxRenewFailures = 2` triggers `CronLeaseLostError` mid-run — the job then aborts itself thinking it lost the lease, even though it hasn't. The current code masks this risk only because `maxRenewFailures` requires two consecutive failures and renewals are relatively cheap, but it's fragile.

---

## Durable Fix Plan

> **Revision note (2026-04-17, review round 1):** Three independent opus-4.7 reviewers validated root cause and direction. Corrections below are incorporated. Unchanged paragraphs kept for context; deltas marked `[rev1]`.

### Part A — Scheduled path hardening (small, safe, in constants + cron-lease)

**A1. Shrink the Anthropic request budget to leave real headroom.**

- `ANTHROPIC_TIMEOUT_MS` : 14 min → **12 min**.
- `CRON_TIMEOUT_MS["daily-digest"]` : 14.5 min → **14 min** (= Anthropic cap + 2 min for persistence, channel delivery, and cron_runs write).
- Keeps ~1 minute of margin under the 15-min platform ceiling.

**A2. Cap retry depth AND per-attempt timeout so retries cannot mask budget exhaustion.** `[rev1 — timing reviewer]`

- The outer `AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS)` at `platform.ts:97` already caps total wall time, so `maxRetries: 2` *alone* is semantically redundant — the outer signal dominates. The meaningful change is to also lower the per-attempt `timeoutMs` passed into `fetchWithRetry` so a retry can actually fit:
  - Pass `maxRetries: 2` AND `timeoutMs: 11 * 60_000` (per-attempt) into `fetchWithRetry` at this call site.
  - With 3 attempts × 11 min per-attempt capped by an outer 12-min budget, a 529-overload retry chain gets at most one full attempt plus a partial follow-up — no dangling socket waiting past the outer cap.
- Document at `platform.ts:97` that the outer `AbortSignal.timeout` is the binding cap and per-attempt `timeoutMs` is redundant-but-harmless.

**A3. Skip the corrective retry when first-pass already consumed >= 50% of the budget.** `[rev1 — timing reviewer: threshold tightened from 60% → 50%; explicit start timestamp required]`

- Capture `const started = Date.now()` at `worker/src/cron/digest/platform.ts:60` (top of `requestDigestCopy`, before the first `requestClaude` call).
- In the existing block at `platform.ts:129`, gate the corrective retry on `Date.now() - started < 0.5 * ANTHROPIC_TIMEOUT_MS` (= 6 min at a 12-min budget).
- If skipped: log a warning with the measured elapsed, return the first-pass parse with `qualityIssues` intact. The validator is allowed to flag `degraded` without forcing a full second model call. Rationale: Opus 4.7 adaptive thinking on a diff-only corrective prompt is *not* guaranteed faster than first-pass, and a 7+ min first pass + retry + 2 min post-work does not fit the 14-min wrapper.
- Log the skip reason so 2026-04-18+ observations confirm or refute the threshold choice.

**A4. Tighten heartbeat cadence — surgical override only.** `[rev1 — timing reviewer: don't change global default]`

- Pass `heartbeatSec: 30` and `maxRenewFailures: 3` *explicitly* when calling `runCronWithLease` for `daily-digest` (both in the scheduled path's `createScheduledRuntimeContext.runLeasedCron` and in the new polling cron's call site).
- Do **not** change the global policy in `cron-lease.ts` — it would touch unrelated jobs (e.g. `sync-live-reserves` would drop from ~240 s to 73 s heartbeat) without evidence we need that.
- At 30 s cadence on a 14-min job: ~28 D1 writes per daily run — negligible. `maxRenewFailures: 3` tolerates 90 s of D1 outage before aborting, vs ~620 s at today's cadence but with only 2-failure tolerance — tighter detection without firing on transient D1 hiccups.

### Part B — Manual trigger rearchitecture (deferred execution via D1 flag)

**Core change:** The manual trigger stops doing long-running work in `ctx.waitUntil()`. Instead:

1. The HTTP endpoint sets a pending-trigger flag in a D1 cache/table.
2. A frequent scheduled cron (new, dedicated) reads the flag at the start of its scheduled invocation, runs the digest under scheduled-event wall-clock, clears the flag *only on non-`skipped_locked` outcomes*.

**B0. Why not Cloudflare Queues?** `[rev1 — architecture reviewer required justification]`

Queues is the textbook fit here (producer=HTTP handler, consumer=Worker running under scheduled-event limits, built-in retry + DLQ, no polling latency). We reject Queues for this project specifically:

- It adds a new runtime binding, a new consumer handler shape unlike any other code in the repo, and new dev/test setup.
- The operator triggers this endpoint rarely (emergency recovery only); 5-min polling latency is an acceptable UX cost.
- The existing `runCronWithLease` + `logCronRun` + `runScheduledSlotWithFence` machinery already gives us exactly the semantics we need on the consumer side, and every cron job in this Worker follows that pattern. Consistency beats novelty.
- Queues is the right choice if we later add high-frequency or multi-tenant manual-trigger flows. For a single ops button, D1 flag + `*/5` polling is the minimal change.

**B1. Add a `deleteCache` helper.** `[rev1 — code reviewer: setCache has no TTL arg]`

- Add to `worker/src/lib/db-cache.ts`: `export async function deleteCache(db: D1Database, key: string): Promise<void>` that runs `DELETE FROM cache WHERE key = ?`.
- The original pseudo-code `setCache(db, key, "", 1)` is a type error (the real `setCache` has signature `(db, key, value)` with no TTL) and would also leave a row whose truthy-check reads as a present request. Fix the root cause; don't work around it with sentinels.

**B2. Update `handleTriggerDigest` to just enqueue.**

```ts
export const handleTriggerDigest = makeAdminRoute(
  "route-trigger-digest",
  async ({ db, request }: TriggerDigestRouteContext) =>
    runIdempotentAdminAction(db, "trigger-digest", request, async () => {
      const requestId = `manual-digest-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      await setCache(db, "digest:force-run-request", JSON.stringify({
        requestedAt: Math.floor(Date.now() / 1000),
        requestId,
      }));
      return jsonResponse({
        ok: true,
        accepted: true,
        requestId,
        message: "Digest trigger queued; will execute on the next polling tick (≤5 min).",
      }, { status: 202, noStore: true });
    }),
);
```

Idempotency is preserved by `runIdempotentAdminAction` — an operator clicking twice with the same `Idempotency-Key` reuses the cached 202 without overwriting the flag.

**B3. Add a dedicated polling cron.**

Add cron pattern `*/5 * * * *` to `worker/wrangler.toml`. Register a new schedule key `digestTriggerPoll` in `shared/lib/cron-jobs.ts` and `shared/lib/scheduled-runner-registry.ts`. Model the new slot handler on `worker/src/handlers/scheduled/five-minute-telegram.ts` (simplest analog — same `runLeasedCron` pattern, no fence needed on the poll slot itself because the inner `daily-digest` lease already serializes execution across colos).

```ts
// worker/src/handlers/scheduled/digest-trigger-poll.ts
export async function runDigestTriggerPollSlot(runtime: ScheduledRuntimeContext): Promise<void> {
  const pending = await getCache(runtime.db, "digest:force-run-request");
  if (!pending) return;

  // Run via runLeasedCron so cron_runs gets a row, progress is reported, and the
  // existing daily-digest lease serializes execution with the 08:05 scheduled run.
  const result = await runtime.runLeasedCron("daily-digest", (signal) =>
    generateDailyDigest(
      runtime.db,
      runtime.env.ANTHROPIC_API_KEY ?? null,
      null,
      true, // force = true — bypass the "<1h old" check
      buildTelegramCreds(runtime.env),
      signal,
    ),
  );

  // [rev1 — code reviewer fix] Only clear the flag when we actually ran or
  // terminally failed. If the lease is held (e.g. 08:05 scheduled run still
  // in-flight), keep the flag so the next poll retries.
  const leaseLocked = (result as { status?: string } | null | undefined)?.status === "skipped_locked";
  if (!leaseLocked) {
    await deleteCache(runtime.db, "digest:force-run-request");
  }
}
```

Also pass `{ heartbeatSec: 30, maxRenewFailures: 3 }` to the `runCronWithLease` call that backs `runLeasedCron` for this job (per A4). Simplest path: accept a per-job override inside `createScheduledRuntimeContext.runLeasedCron` that looks up daily-digest and passes those options.

**B4. Stuck-flag safety valve.** `[rev1 — code reviewer: repeated failures]`

If `generateDailyDigest` throws, `runLeasedCron` writes an error row to `cron_runs` and the poll handler's `leaseLocked` check is false → flag is cleared. Operator loses visibility that their request was consumed without producing a digest.

Mitigations:
- Persist a short-lived `digest:last-trigger-result` cache key (5-min TTL) storing `{requestId, outcome: "ok"|"error"|"skipped_locked", error?}` so the ops UI can show the result of the last manual trigger.
- Do NOT add unbounded auto-retry on the flag — if the digest is genuinely broken (bad prompt, model outage), we want the operator to see one clear error in the ops UI, not a loop.

**B5. Acceptance trade-off:** The operator sees up to 5 minutes of latency. Acceptable for a recovery tool. If faster latency is later needed, swap `*/5` for `*/2`.

### Part C — Observability so silent failures can't recur

**C1. Persist a manual-trigger audit row before doing any work.**

Even after B2, we should prove the trigger endpoint was hit. Insert a row into an `admin_action_log` table (or piggyback on `idempotency_keys`, which already records every admin action) on every trigger. D1 writes are durable even if the Worker dies 1 ms later.

**C2. Write a "started" progress row on every digest run (scheduled + poll-driven).**

The scheduled path already calls `reportProgress({stage: "started"})` via `createScheduledRuntimeContext`. The current manual path does not. After B2, the polling cron goes through `runLeasedCron` which already reports progress. So this is free once B2 lands.

**C3. Surface pending-trigger state in the ops UI.**

Small follow-up: expose `getCache(db, "digest:force-run-request")` via an admin endpoint so the ops UI can show "digest trigger queued, waiting for next poll" instead of silently suggesting the request succeeded.

### Part D — Tests

**D1. Rewrite `worker/src/__tests__/trigger-digest-route.test.ts`.** `[rev1 — code reviewer: underspecified]`

- Remove the `vi.mock` hoists for `../cron/daily-digest`, `../lib/cron-logger`, `../lib/cron-lease` — those code paths are no longer exercised by the manual trigger handler.
- Add `vi.mock("../lib/db-cache", () => ({ setCache: vi.fn() }))` (and `getCache`, `deleteCache` as no-ops if they're exported from the same module).
- Assertions change to:
  - `response.status === 202` and body matches `{ok: true, accepted: true, requestId}`.
  - `setCache` called exactly once with key `"digest:force-run-request"` and a JSON value containing `requestId` and `requestedAt`.
  - `ctx.waitUntil` NOT called (since we moved the work out of it).
  - Idempotent replay: second call with same `Idempotency-Key` reuses the cached response and does not call `setCache` again.

**D2. New test `worker/src/handlers/scheduled/__tests__/digest-trigger-poll.test.ts`** covering:
- No-op when `getCache` returns null.
- When flag present: calls `runLeasedCron("daily-digest", ...)` with `force=true`.
- When result.status !== "skipped_locked": `deleteCache("digest:force-run-request")` is called.
- When result.status === "skipped_locked": `deleteCache` is NOT called (flag preserved for next poll).
- When inner `generateDailyDigest` throws: error propagates, cron_runs error row was written (via the mocked `runLeasedCron`), `deleteCache` is still called (treating throw as terminal failure, not lease lock).

**D3. Keep the existing daily-0805 scheduled-digest tests unchanged.**

**D4. Add a test for the corrective-retry skip in `worker/src/cron/__tests__/daily-digest.test.ts`** verifying that when first-pass `requestClaude` resolves after >= 50% of `ANTHROPIC_TIMEOUT_MS`, `requestClaude` is called exactly once regardless of `qualityIssues.length`.

### Part E — Docs

- `docs/digest-pipeline.md` — document the new manual trigger flow (deferred), the poll cron, and the ~5 min expected latency.
- `docs/worker-and-api-limits.md` — add a subsection summarizing the `ctx.waitUntil()` 30-second-tail limitation so future agents don't try to resurrect the old pattern.
- `docs/digest-pipeline.md` — document the reduced Anthropic/cron budgets from Part A and the rationale.

---

## Recommended Execution Order

1. **Ship Part A immediately** (commit alongside `cdcd5968` or a fast follow-up). Low risk, tightens scheduled path.
2. **Watch 2026-04-18 08:05 UTC scheduled run.** If it succeeds with ~5–10 min duration, the scheduled path is stable.
3. **Ship Part B + Part C2/C3 together** as a single PR. This is the durable fix for the manual trigger; ship it before the next ops incident forces another trigger attempt.
4. **Ship Part D (tests) within the same PR.**
5. **Ship Part E docs in the same PR.**

Part A is safe to deploy without Part B; Part B is safe to deploy without Part A but should not ship ahead of A because the scheduled run is still the thing that needs to succeed reliably.

---

## What We Proved vs. What Remains to Verify

Proved:
- The 2026-04-17 08:05 failure was the old 5-min Anthropic timeout firing against a slower Opus 4.7 max-effort digest.
- The manual trigger silently dies because HTTP `ctx.waitUntil()` is capped at ~30 s of tail work on Cloudflare Workers.
- `cdcd5968` addresses the scheduled path in isolation.
- The heartbeat evidence, orphan lease, and missing `cron_runs` row all fit the waitUntil-termination explanation cleanly.

Not yet verified (will be proven by the 2026-04-18 scheduled run):
- That Opus 4.7 max-effort on the new prompt actually completes in under 12–14 min. If it routinely approaches 14 min, prompt-level mitigations (smaller input, lower `max_tokens`, fewer forward-look blocks) are the next lever.

If the 2026-04-18 scheduled run also fails at exactly 14 min → drop to `effort: "high"` or trim the prompt. That's a separate investigation; the architecture fix here is complementary, not conditional.

---

## Files That Will Change in the Fix PR

- `worker/src/lib/constants.ts` — A1 (timeouts).
- `worker/src/lib/db-cache.ts` — B1 (new `deleteCache` helper).
- `worker/src/cron/digest/platform.ts` — A2 (per-attempt timeoutMs + maxRetries override at call site) and A3 (explicit `const started = Date.now()` at line 60, 50% gate at line 129).
- `worker/src/cron/daily-digest.ts` — pass surgical heartbeat options when `requestDigestCopy` uses the outer signal (A4 threads through).
- `worker/src/handlers/scheduled/context.ts` — A4 (per-job override to pass `heartbeatSec: 30, maxRenewFailures: 3` when `job === "daily-digest"`).
- `worker/src/api/admin-actions.ts` — B2 (trigger endpoint writes flag only, no more `waitUntil`).
- `worker/src/handlers/scheduled/digest-trigger-poll.ts` — new B3 handler (with rev1's lease-locked guard around `deleteCache`).
- `worker/src/handlers/scheduled.ts` — register new handler.
- `worker/wrangler.toml` — add `*/5 * * * *` cron trigger.
- `shared/lib/cron-jobs.ts` + `shared/lib/scheduled-runner-registry.ts` — add `digestTriggerPoll` schedule key.
- `worker/src/__tests__/trigger-digest-route.test.ts` — D1 (rewrite to assert cache write, not lease path).
- `worker/src/handlers/scheduled/__tests__/digest-trigger-poll.test.ts` — D2 (new).
- `worker/src/cron/__tests__/daily-digest.test.ts` — D4 (corrective-retry skip test).
- `docs/digest-pipeline.md`, `docs/worker-and-api-limits.md` — E.

This is a ~300-line change across ~13 files, no migrations, no new infrastructure (no Queues, no Workflows — justified in B0).
