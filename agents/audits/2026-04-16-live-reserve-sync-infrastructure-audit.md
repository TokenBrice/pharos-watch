# Live Reserve Sync Infrastructure Audit - 2026-04-16

## Scope

Comprehensive audit of the live reserve sync infrastructure and framework — NOT the individual adapter implementations. Focus: cron orchestration, adapter framework, D1 store, schema/registry consistency, API resolver, migrations, test coverage, and performance. Feeds a remediation plan.

Complement to the 2026-04-15 full-adapter audit. Where April 15 findings are already fixed, they are not repeated here.

Current baseline (verified against the checked-in data):

- 43 registered adapters; 39 configured in stablecoin JSON.
- **140 configured live-reserve coins** (docs/live-reserves.md says 140; April 15 audit said 138 — live source of truth is now 140).
- 4 currently-unconfigured adapters remaining: `abracadabra`, `frax`, `lista`, `tether`.
- `SCORING_LIVE_RESERVE_EVIDENCE_CLASSES = ["independent"]`, `LIVE_RESERVE_FRESHNESS_SEC = 2 days`, `LIVE_RESERVE_HISTORY_RETENTION_SEC = 90 days`, `ADAPTER_TIMEOUT_MS = 20_000`, `D1_WRITE_FINALIZE_TIMEOUT_MS = 30_000`, `MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC = 600`, `RESERVE_ADAPTER_MAX_PARALLEL_IO = 2`.

## Summary

The reserve sync infrastructure is solid in structure but has several concrete correctness and robustness gaps that are worth addressing before further coverage expansion. The fencing protocol added by migration 0080 is well-designed (composition rows are rejected during read if their attempt_id does not match `reserve_sync_state.last_success_attempt_id`), but the write path still has a narrow window for orphaned history rows and the stale-artifact cleanup is unnecessarily non-atomic. The most urgent fixes are a potential API-crash path on unknown stored adapter keys, a timing risk where the 12-minute cron budget is smaller than the worst-case 140-coin × 20s serial ceiling, and an error-classification gap for `parseLiveReserveAdapterParams` failures. Schema/registry consistency is excellent. The overview counters need two small fixes (ordering of stale-vs-status checks, and `writeTimeoutUncertain` being counted before the missing-snapshot gate).

## Critical Issues

### C1. `parseReserveCompositionRow` can crash with a TypeError on unknown stored adapter keys

`worker/src/lib/live-reserves-store-row-decoding.ts:293, 303` — `resolveSnapshotSourceModel` / `resolveSnapshotEvidenceClass` fall back to `getLiveReserveAdapterDefinition(fallbackAdapterKey as LiveReserveAdapterKey).sourceModel` / `.evidenceClass`. `getLiveReserveAdapterDefinition` (shared/lib/live-reserve-adapters.ts:20-24) does `return LIVE_RESERVE_ADAPTER_DEFINITIONS[adapterKey]` with no defensive check — an unknown key returns `undefined`, and `.sourceModel` then throws.

Triggers:
- A legacy/removed adapter key persists in `reserve_composition.source` or `reserve_sync_state.adapter_key` after an adapter is deleted.
- A typo in `stablecoin_id` mapping that lands on a row with a removed adapter source.
- A breaker-key legacy migration that leaves unknown adapter keys around.

Callers (all transitively depend on `parseReserveCompositionRow`):
- `resolveReserveResult` → `GET /api/stablecoin-reserves/:id` returns 5xx via `withErrorHandler`.
- `loadReserveSnapshotMetadataMap` → `sync-redemption-backstops` cron crashes loudly; affects DEX/scoring pipeline.
- `loadFreshIndependentLiveReserveMap` → `report-cards-snapshot-inputs.ts`, `collateral-drift.ts`, `status-supplements.ts` all crash.
- `computeReserveCompositionOverview` → status endpoint crashes.

**Fix approach:** Treat unknown adapter keys as corrupt data (return `{ record: null, issue: ... }` or a synthetic neutral evidenceClass). Harden `getLiveReserveAdapterDefinition` to either throw a structured error or return `null | undefined` and require callers to handle it.

Scope: S (one function to harden + one call-site update + a regression test).

### C2. 12-minute cron budget is smaller than the 140-coin × 20s worst-case serial ceiling

`worker/src/cron/sync-live-reserves.ts:21` sets `ADAPTER_TIMEOUT_MS = 20_000`. `worker/src/lib/cron-lease.ts:7` sets `sync-live-reserves` to `12 * 60_000 = 720_000 ms = 12 min`. Coins run sequentially (`for (const [index, coin] of CONFIGURED_COINS.entries())`, line 197). Worst case: 140 × 20s = 2800s = ~46 min — almost 4× the documented budget.

In practice, most adapters return in <1s and the shared source cache compresses source-invariant adapters (m0, mento, sky-makercore). But a cluster of slow adapters (or a DNS outage across multiple breaker keys so the breaker hasn't opened yet) can trip the 12-min guard, and the in-flight `for` loop will be force-aborted mid-coin by the lease `AbortSignal`. Coins remaining in the batch never get their `finalizeReserveSyncAttempt`, leaving `pending_attempt_id` dangling.

There is no "remaining-budget" check before starting the next coin, and no overall sync-level time budget that would abort gracefully rather than mid-fetch.

**Fix approach options:**
- Add a pre-coin check: `if (Date.now() - runStartedMs > SYNC_BUDGET_MS - ADAPTER_TIMEOUT_MS) break;` with a "deferred" bucket counted in failed so the alert path fires.
- Tighten per-coin timeout below 20s (most healthy adapters complete well inside 5s).
- Increase `sync-live-reserves` timeout to a defensible worst case and document it.
- Prefer the first: quick win, graceful degradation, keeps budget intact.

Scope: S.

### C3. Stale-artifact cleanup DELETEs are per-row and non-transactional

`worker/src/cron/sync-live-reserves.ts:49-64`: loops over stale rows calling `.run()` one statement per delete; the cache LIKE cleanup does the same. If `runLeasedCron` aborts between rows (lease lost, slot timeout), we're left partway through cleanup with no recovery. Only benign (tables prune on next successful run), but easy to consolidate:

```ts
// CURRENT: per-row DELETE
for (const row of staleRows) {
  await db.prepare("DELETE FROM reserve_sync_state WHERE stablecoin_id = ?").bind(row.stablecoin_id).run();
}
```

**Fix approach:** single `DELETE ... WHERE stablecoin_id NOT IN (?, ?, ...)` for state; same for cache via `breaker_key NOT IN (...)`. Use `db.batch()` to atomically issue both. Scope: S.

### C4. `computeReserveCompositionOverview` counts `writeTimeoutUncertain` even when the coin is missing / was never attempted

`worker/src/lib/live-reserves-store-overview.ts:61-76`:

```ts
if (hasUncertainWriteState(syncState)) {
  writeTimeoutUncertain++;
}
const hasSnapshot = hasConsistentSnapshotState(...);
if (!hasSnapshot || !compositionRow) {
  if (syncState?.lastStatus === "error") errorCoins++; else missingCoins++;
  continue;
}
```

`writeTimeoutUncertain` is incremented before the "missing" short-circuit, which means a coin with `metadata.uncertainWrite: true` AND no snapshot is counted in BOTH `writeTimeoutUncertain` AND `missingCoins`/`errorCoins`. The status dashboard will overcount. Tests in `live-reserves-store.test.ts` (around line 909) cover the happy path where the coin has other snapshots but this double-count pathway isn't exercised.

**Fix approach:** move the `writeTimeoutUncertain++` into the success/degraded/error branch so it's a sub-classifier of one primary bucket, not a cross-bucket counter. Or explicitly document it as a cross-cut metric (but then ensure the status UI doesn't add it to totals).

Scope: S.

## Moderate Issues

### M1. `parseLiveReserveAdapterParams` errors classify as "unknown" instead of "adapter-config"

`worker/src/cron/sync-live-reserves-shared.ts:92-113` — `classifyFailure` maps reason-strings to categories. When an adapter calls `parseLiveReserveAdapterParams` at runtime and zod rejects params, a plain `Error` is thrown with the message `${adapterKey} adapter params invalid.<path>: <zod message>`. The catch in `syncReserveCoin` sets reason = "adapter-exception", lastError = that message. `classifyFailure` then checks against keyword patterns. The message doesn't include `layout-changed`, `parse-failed`, `http 4xx/5xx`, `fetch failed`, `no-response`, `timed out`, `aborted`, `network`, `database`, `sqlite`, `d1 write timeout` → falls to `"unknown"`.

Impact: these are actionable config-level failures that should alert specifically. Lumping them with "unknown" delays diagnosis.

**Fix:** add a keyword match for `"adapter params invalid"` (and a neighbor test for `"adapter requires"`/`"could not find a"` from `requireJsonInput`/`probeOnchainTotalSupply` to classify setup failures as `"adapter-config"`).

Scope: S.

### M2. Shared source cache key depends on JSON.stringify determinism

`worker/src/cron/sync-live-reserves-shared.ts:34-57` — `buildSharedSourceCacheKey` uses `JSON.stringify` on `config.params ?? null`. Params shapes differ across adapters. For today's source-invariant adapters (`m0`, `mento`, `sky-makercore`), the zod schema is `noParamsSchema` (empty `{}`), so cache collisions don't occur. However:

- If a future source-invariant adapter takes params and JSON files produce the same logical params with different key ordering, cache keys will diverge → duplicate fetches for identical sources.
- The test `sync-live-reserves.test.ts` already stringifies the same way in its assertion, so a drift between runtime and test serialization would be invisible.

**Fix:** switch to a canonical-key JSON serializer (sort keys recursively), OR tighten sharedSourceMode to only fire when adapter's params schema is empty. Scope: S.

### M3. Shared source cache failure cleanup is eager, causing redundant retries

`worker/src/cron/sync-live-reserves.ts:162-168`:

```ts
const cachedPromise = resultPromise.catch((error) => {
  sharedSourceResults.delete(cacheKey);
  throw error;
});
sharedSourceResults.set(cacheKey, cachedPromise);
```

If the source-invariant adapter fails, the next coin sharing the same source retries the fetch from scratch. Across `m0` (9 coins), `mento` (2), `sky-makercore` (2), a transient outage that affects all N coins on that source retries N times. The breaker probably opens after 5 failures (`CIRCUIT_OPEN_THRESHOLD`), but some source-invariant clusters have fewer than 5 coins.

**Fix options:**
- Keep the cached failure for the remainder of the run (delete only on success, or after a bounded retry count).
- Rely on the circuit breaker via `breakerCanFetch` — but the breaker is per-`breakerKey` and source-invariant cache is per-source, which can be the same in practice; still N retries happen in a single run before the breaker opens on the NEXT run.

Scope: S to M.

### M4. `hourly-live-reserves.ts` short-circuits kinesis-supply and drift-check when `sync-live-reserves` throws

`worker/src/handlers/scheduled/hourly-live-reserves.ts:17-29` wraps sync-live-reserves in a `try`, runs redemption-backstops in `finally`, then proceeds with kinesis and drift in a separate `try`. If `sync-live-reserves` throws (or `logCronRun` throws — see `cron-logger.ts:178`), the exception propagates out after the `finally`, skipping the entire kinesis + drift block.

Kinesis supply and drift check are independent from live reserves. The current wiring lets a live-reserves failure cascade into a silent drop of chain health & collateral drift alerts.

**Fix:** wrap the first block in a broader `try { ... } catch (e) { console.error(...); }` so subsequent blocks always execute. Or restructure as three independent `await`s, each in its own try/catch. Scope: S.

### M5. `finalizeReserveSyncSuccess` can leak history rows on a stalled write

`worker/src/lib/live-reserves-store-write.ts:31-58` writes in sequence:
1. `buildReserveCompositionUpsertStatement.run()`
2. `buildReserveCompositionHistoryInsertStatement.run()`
3. `buildReserveSyncFinalizeSuccessStatement.run()` (fenced UPDATE)
4. conditional `buildReserveSyncAttemptHistoryInsertStatement.run()` (only when `finalized`)

If step 3's UPDATE returns `changes === 0` because the fencing deadline expired, steps 1+2 have already committed. The `reserve_composition` row is protected at read-time via `hasConsistentSnapshotState` (attempt_id mismatch → rejected). **But `reserve_composition_history` is not read-time fenced** — pruning drops it after 90 days, but metrics that count history rows (e.g., sync-coverage views or debug endpoints) may see orphans.

Impact: low (history is primarily debug/retrospective), but worth filing as a correctness note.

**Fix:** make the write order: fenced state UPDATE → composition UPSERT (already idempotent) → history insert ONLY if the state fenced UPDATE succeeded. Or wrap all four as a `db.batch()` — D1 batches are atomic (per `MEMORY.md`). Scope: M.

### M6. `finalize` timeout deadline is computed from the initial `Date.now()`, not adjusted for start-to-D1 latency

`worker/src/cron/sync-live-reserves-core.ts:181-190`:

```ts
await raceWithTimeout(
  finalizeReserveSyncSuccess(db, compositionRecord, successState, Date.now() + D1_WRITE_FINALIZE_TIMEOUT_MS),
  D1_WRITE_FINALIZE_TIMEOUT_MS, ...
);
```

The `finalizeDeadlineMs` bound on the server is `Date.now() + 30_000` captured before `finalizeReserveSyncSuccess` even runs. `finalizeReserveSyncSuccess` then fires composition UPSERT (D1 round-trip) + history INSERT (D1 round-trip) BEFORE the fenced state UPDATE. By the time the fenced UPDATE actually executes, SQLite's `julianday('now')` may still be <= the deadline (since the full 30s budget hasn't elapsed), so the fence works. But the coupling is unsafe:

- If D1 takes 25s to return composition+history, and the state UPDATE is sent at ~25s after `Date.now()` was captured, then SQLite evaluates `current_ms <= deadline_ms` with deadline fixed at +30s — this survives. 
- If D1 takes 40s (past the JS-side 30s race), `raceWithTimeout` rejects and the follow-up `getReserveSyncState` then `didReserveSyncAttemptFinalizeAsSuccess` kicks in for recovery. Also survives.

Edge case where it fails: the JS-side 30s timer fires BEFORE the D1 fenced UPDATE even leaves the socket. The D1 write may still land later (Workers don't cancel in-flight fetches on timeout racing), causing a "late success" state update. But by then `finalizeReserveSyncAttempt` (from `recordFailure`) will have already cleared `pending_attempt_id`, so the late UPDATE's `WHERE pending_attempt_id = ?` fails (NULL != attemptId). 

In summary: the design is sound but the code is hard to reason about. **Fix (optional):** add a comment explaining the three-way timeout interlock (JS timer / SQLite deadline fence / post-timeout recovery), and add an explicit test for "D1 UPDATE physically runs after the SQLite deadline". Scope: S docs + S test.

### M7. `runAdapterAttempt` creates a fresh `createAdapterIoLimiter` per coin

`worker/src/cron/sync-live-reserves.ts:107` — `ioLimiter: createAdapterIoLimiter(RESERVE_ADAPTER_MAX_PARALLEL_IO)` is instantiated per attempt. This means parallelism is capped within a single adapter call (good), but there is no cross-coin throttling. That is intentional because coins run sequentially, so at any moment only one coin's I/O is happening.

However, there's still an edge: during the `runAdapter` function, after primary fails, multiple fallbacks are tried in sequence, each with its own fresh limiter. That's fine for the same reason.

Concern: the `createAdapterIoLimiter` is also bound into the `ctx` passed into the primary fetch. If the adapter caches the ctx and uses it after another coin has started (it shouldn't, but the request cache in `ctx.requestCache` is shared across the whole run — line 134), the old limiter reference is orphaned but benign. Not a bug; just complex to reason about.

**Fix (optional):** document the I/O limiter scope explicitly in a comment on `AdapterContext`. Scope: trivial.

### M8. `AdapterContext.requestCache` scope correctness

`sync-live-reserves.ts:134` initializes `requestCache ?? new Map<string, Promise<unknown>>()` once per sync run and shares it across coins. `request.ts:getCachedRequest` delete-on-error is implemented (line 46-51). For the whole run, a successful fetch stays cached across coins. If two coins have the same `json-get:URL:10000:headers` key, they dedupe. Good.

Gotcha: `requestCache` dedupes by **URL + timeout + headers**, which is looser than `sharedSourceResults` (which adds adapter/version/params). So a coin with a HTTP-json input to `https://example.com/reserves` and a DIFFERENT adapter gets the same cached HTTP response. That seems intentional (it's just the HTTP layer) but means two different adapters reusing a body could run adapter-A first, have its parsing crash mid-work, and then adapter-B would still get cached HTTP response (because the cache only evicts on the `fetch` throwing, not on adapter parsing).

This is generally fine — an HTTP-level cache hit is correct. But if the cached response is later mutated (unusual for JSON.parse results), cross-adapter bugs could emerge. Low risk, worth a comment.

### M9. `validateRedemptionTelemetry` fatal-returns hide later redemption warnings

`worker/src/cron/reserve-adapters/validate.ts:93-177` — the function returns early with a single fatal on the first violation:

```ts
if (hasNegativeNumber(capacityUsdValues)) {
  return [fatalWarning("invalid-redemption-capacity-usd", ...)];
}
if (hasOutOfRangeRatio(capacityRatioValues)) {
  return [fatalWarning(...)];
}
// ...
```

If BOTH capacity and fee telemetry are invalid, operators only see the first violation. For diagnosis, surfacing all fatals would be more helpful. This is a UX gap rather than correctness: the sync fails closed either way.

**Fix:** collect all fatals and degraded into the same array and `return { ... }` at the end. Scope: S.

### M10. `validate.ts:hasDegradingWarnings` and `hasFatalWarnings` have different defaults

Both exported from `validate.ts`. `hasDegradingWarnings` treats `undefined` as `[]` (returns false). `hasFatalWarnings` same. Fine, but `warnings ?? []` is duplicated and the caller in `syncReserveCoin` always passes a non-undefined array. Minor cleanup.

### M11. `normalizeSlices` largest-slice remainder adjustment could produce negative pctUnits

`worker/src/cron/reserve-adapters/slice-math.ts:56-66`:

```ts
const sumUnits = normalized.reduce((acc, slice) => acc + slice.pctUnits, 0);
const maxIdx = normalized.reduce(...);
normalized[maxIdx].pctUnits += (100 * factor) - sumUnits;
```

If `sumUnits` is very large (e.g., 1050 units), `(100 * factor) - sumUnits = -50`. The adjustment is subtracted from the max slice, which could go negative. The subsequent `.filter((slice) => slice.pct > 0)` would then drop the largest slice and return fewer slices than input.

Likely unreachable because upstream validation rejects 102%+ sums. But a defensive clamp (Math.max(0, ...)) would prevent silently losing slices. The `pct-sum-deviation` error is supposed to catch this in `validateAdapterOutput` first.

Scope: S.

### M12. `classifyFailure` has no unit test coverage

`sync-live-reserves-shared.ts:92-113` maps reason/error to categories. No dedicated test file verifies each branch. The only coverage is via `sync-live-reserves.test.ts:236-252` ("classifies parser drift in sync attempt metadata") which tests just the `parser-drift` branch. Adding a small table-driven test asserting all 8 categories map correctly would catch regressions. Scope: S.

### M13. `recordFailure` is called after `finalizeReserveSyncAttempt` but composition row was never written for "validation-failed" / "empty-slices" paths

Lines 121-143 in `sync-live-reserves-core.ts` handle validation-failed / empty-slices / fatal-warning. They call `recordFailure`, which calls `finalizeReserveSyncAttempt`. This is fine — no composition is written on failure. But note: the sequence `beginReserveSyncAttempt` → `finalizeReserveSyncAttempt` with `pending_attempt_id` cleared to NULL (so subsequent fenced-UPDATE attempts for the same attempt_id will no-op because `pending_attempt_id = ?` won't match NULL). The success path writes composition first, then fences state. Failure path just fences state. Both correct — just worth a comment flagging the asymmetry for future readers.

### M14. API cache-control policy for `live-stale` mode is underspecified

`worker/src/api/stablecoin-reserves.ts:42`:

```ts
cacheControl: resolved.mode === "live" ? LIVE_CACHE_CONTROL : FALLBACK_CACHE_CONTROL,
```

Only `"live"` gets the generous 1h CDN TTL. All other modes (`live-stale`, `curated-fallback`, `template-fallback`, `unavailable`) get the short 5-min TTL. Fine in principle, but `live-stale` with `stale: true` but still-recent data (say, 3 days old after a 2-day freshness cutoff) gets the same aggressive 5-min refresh as a bootstrap coin that has never been synced. That's double the CDN pressure for the "only slightly stale" case.

No specific bug — just an opportunity for a 3-tier cache policy. Scope: S if wanted.

## Minor Issues / Nits

### N1. `ReserveAttemptFailureSummary.label` repeats the input kind unnecessarily

`sync-live-reserves-shared.ts:124-129`:

```ts
if (source === "fallback") {
  return `fallback#${(fallbackIndex ?? 0) + 1}:${input.kind}`;
}
return `primary:${input.kind}`;
```

Makes sense but doesn't capture the URL or the chain for easier diagnosis. `primary:http-json` for `https://api.falcon.fi/...` is less useful than `primary:http-json:api.falcon.fi`. Scope: trivial.

### N2. `SQLITE_NOW_MS_EXPRESSION` is duplicated inline rather than a named constant

`live-reserves-store-statements.ts:8` has it as a constant, but only used once. Fine as is.

### N3. `parseWarnings` drops severity/effect info on malformed entries

`live-reserves-store-row-decoding.ts:200-210` — an item missing `code` or `message` is dropped, but one with invalid `severity` is coerced to "warning". Silently fixing invalid severity is mostly OK; might log once.

### N4. `buildSyncView` `warnings` field merges extraWarnings at the end of messages

`live-reserves-store-response.ts:29-32` — if both `syncState.warnings` and `overrides.extraWarnings` exist, the order is unstable (extra at end). UI likely sorts/filters anyway. Nit.

### N5. `pruneLiveReserveHistory` has no pagination safety

Two large DELETEs against unbounded tables. If retention is ever shortened (e.g., 30 days → 7 days), a single cron run could delete hundreds of thousands of rows. D1 has a 30s per-statement limit (per `MEMORY.md`). Realistic row counts for 90d × 140 coins × hourly ≈ 302K composition rows + 302K attempt rows — at D1's typical DELETE throughput this MIGHT time out on a first-time shortening. Scope: S if relevant (pagination by LIMIT).

### N6. `ChainHealth` isn't in scope here, but `hourly-live-reserves` log line says "collateral drift" — the exact phrase matters for ops

Not a bug.

### N7. `validateAdapterOutput` freshness-mode-missing and freshness-metadata-missing are both degraded

`validate.ts:283-294` — two very similar warning codes that could be hard to disambiguate in logs. Fine, just worth documenting.

### N8. `buildSharedSourceCacheKey` key strings can exceed reasonable Map key sizes for large param blobs

Not actionable today; worth noting if params grow.

## Test Coverage Gaps

High-priority tests to add:

1. **Attempt-id fencing under concurrent writes** — simulate two overlapping runs with interleaving `begin`/`finalize` and assert only one `last_success_attempt_id` wins; assert orphaned composition row is rejected at read time. (Could be done in `live-reserves-store.test.ts` with carefully sequenced mock D1 calls.)

2. **`parseReserveCompositionRow` with unknown adapter source_model and evidence_class fallback that hits an unknown adapter key.** Expect a graceful issue, not a thrown exception. Covers C1.

3. **Overview `writeTimeoutUncertain` double-count** — a coin with `uncertainWrite: true` but no composition row should count in writeTimeoutUncertain OR missingCoins, not both. Covers C4.

4. **`hourly-live-reserves` cascade** — sync-live-reserves throws → assert kinesis and drift check still run. Covers M4.

5. **`classifyFailure` table-driven test** for all 8 categories, including `adapter params invalid` messages. Covers M1/M12.

6. **Shared source cache key determinism** — two identical configs whose `params` object has different insertion order produce the same cache key. Covers M2.

7. **Shared source cache failure retention** — source-invariant adapter fails once; subsequent coins sharing the source either retry OR observe the cached failure (pick one, and test it). Covers M3.

8. **Finalize success with D1 write timeout** — existing test covers part of this (via fake timers); add a variant where the composition write is slow but the fenced UPDATE runs after the deadline expires → assert the UPDATE returns 0 changes → assert `recordFailure` lands with `uncertainWrite: true`.

9. **Per-coin budget / overall-run-budget** — simulate a scenario where 10 coins each consume 20s and the budget is 60s → assert subsequent coins are marked skipped/deferred, not force-aborted. Covers C2.

10. **Stale artifact cleanup uses a single DELETE** (after C3 fix) — assert SQL runs one `DELETE ... WHERE stablecoin_id NOT IN (...)` and one cache-cleanup DELETE per run.

11. **API cache-control for all 5 modes** — `live`, `live-stale`, `curated-fallback`, `template-fallback`, `unavailable`. Only `live` exists today (`stablecoin-reserves.test.ts`).

12. **Future-timestamp validation on redemption.sourceTimestamp** — already covered in `reserve-adapter-validate.test.ts:186-211` ✓.

13. **`validateRedemptionTelemetry` multiple simultaneous violations** — assert all fatals returned (after M9 fix). Today only first is returned.

14. **Input-kind discrimination happy-path for all 43 adapters.** Current test (registry.test.ts:61-99) only covers two adapters. A parameterized test using `LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS` for every adapter would catch schema drift.

15. **Circuit-breaker deferred outcome** — two coins share `breakerKey`. Coin A succeeds, coin B fails. Confirm the `worst outcome wins` semantics: `breakerOutcomes.set(key, false)`. This is the only branch truly tested via the "records circuit breaker outcome only once per unique breakerKey per run" test, but that test only runs the "all success" case. Add mixed-outcome.

## Remediation Plan Sketch

Priority order, critical-first. Sizes: S = <1h, M = half-day, L = day+.

| # | Item | Priority | Scope | Why |
|---|---|---|---|---|
| 1 | C1 — harden `parseReserveCompositionRow` against unknown adapter keys; make `getLiveReserveAdapterDefinition` return `null` or throw a structured error | Critical | S | Prevents API 500s and cron crashes from legacy/removed adapter data |
| 2 | C2 — add per-run budget guard (break loop when remaining budget < ADAPTER_TIMEOUT_MS) | Critical | S | 140 × 20s > 12 min budget by 4× |
| 3 | C4 — fix `writeTimeoutUncertain` double-count in `computeReserveCompositionOverview` | Critical | S | Overview metrics accuracy |
| 4 | M4 — decouple cascade: wrap sync-live-reserves / redemption-backstops in independent try/catch so kinesis + drift always run | High | S | Silent failure of chain health / drift alerts |
| 5 | M1/M12 — add "adapter params invalid" + setup-error patterns to `classifyFailure`; add table-driven classifyFailure test | High | S | Better incident triage signal |
| 6 | C3 — consolidate stale-artifact cleanup into a single `DELETE ... NOT IN` and `db.batch()` | Medium | S | Safer, simpler |
| 7 | M2 — canonical JSON key ordering for `buildSharedSourceCacheKey` or gate on empty params | Medium | S | Prevents future cache-miss bugs |
| 8 | M9 — return all fatal + degraded warnings in `validateRedemptionTelemetry` | Medium | S | Better diagnostics |
| 9 | M5 — reorder finalize writes to avoid orphaned history rows (or move to `db.batch()`) | Medium | M | Minor correctness + simplification |
| 10 | M3 — shared source cache failure retention policy (cache failure for the rest of the run) | Medium | S-M | Reduces redundant upstream pressure |
| 11 | M11 — defensive `Math.max(0, ...)` on `normalizeSlices` remainder adjustment | Low | S | Defense-in-depth |
| 12 | M14 — 3-tier cache control policy (live / live-stale / fallback) | Low | S | Minor CDN optimization |
| 13 | M6 — add doc comment explaining the 3-way finalize-timeout interlock + add an "fenced UPDATE runs after deadline" test | Low | S | Easier future reasoning |
| 14 | Add missing tests enumerated above (items 1-15) | Gradual | M across items | Lock in invariants as the fixes land |
| 15 | Docs drift: update `docs/live-reserves.md` to 140 configured coins; reconcile April 15 audit's 138 with the current 140 | Admin | S | After `npm run check:doc-counts` |

### Fencing / atomicity conclusions

- `buildReserveSyncFinalizeSuccessStatement` (statements.ts:157-199) uses a 4-column fencing WHERE (`stablecoin_id`, `last_attempt_id`, `pending_attempt_id`, `SQLITE_NOW_MS <= deadline`) and zero rows → no state change. The composition UPSERT is idempotent but unfenced at write time; read-time consistency is enforced via `hasConsistentSnapshotState` comparing `lastSuccessAttemptId === snapshot.attemptId`. That correctness property holds.
- `beginReserveSyncAttempt` does an INSERT ... ON CONFLICT UPDATE and sets `pending_attempt_id = excluded.pending_attempt_id` — so a second beginAttempt would overwrite the first `pending_attempt_id`. If two sync runs overlap (lease fails), run A's pending ID is clobbered by run B, and run A's finalize will fail fencing (A's attempt_id ≠ current `last_attempt_id`). Good failover.
- `attempt_id` uniqueness is enforced only implicitly via `crypto.randomUUID`. No DB-level uniqueness constraint on `attempt_id`. UUID collision probability is trivially zero; acceptable.
- Composition history and attempt history have no fencing and no uniqueness constraints. Orphan rows are possible (M5). Low impact because of 90d TTL.

### Observability upgrades (worth considering as a follow-up)

- Add `upstreamStatus` (HTTP status code on HTTP adapter failures) to `recordFailure` metadata.
- Add `adapterDurationMs` per attempt (measured from `attemptStartedAt` to validate/finalize).
- Add `responseSnippet` (first 120 chars) to parser-drift / parse-failure metadata. The JSON parse error builder already does this for HTTP JSON (`request.ts:buildJsonParseError`) but it isn't consistently propagated to `lastError`.
- Expose `failureCategory` counts in the sync metadata (already in attempt history metadata, but not in the top-level cron result metadata).

### Performance summary

- `RESERVE_ADAPTER_MAX_PARALLEL_IO = 2` cap is enforced per-coin only; no cross-coin cap. Given sequential coin loop, this is fine.
- Documented `Connection budget: 2/6 peak` for hourly-live-reserves slot is accurate if only one coin runs I/O at a time + kinesis/backstop sync runs after. Adapter-internal fan-out (e.g., `gho`, `cap-vault`, `crvusd` per April 15 audit) can exceed the in-adapter limiter's 2-parallel cap because some adapters use `Promise.all` outside of `runAdapterIo`. Worth an adapter-level audit pass (but out of scope here).

### Migration / rollback safety

- Migration 0080 is additive (nullable columns + indexes). Rollback requires paired worker revert because writes reference the new columns unconditionally.
- No destructive migration that cleans up legacy `attempt_id = NULL` rows. That's intentional and safe.
- `reserve_composition.adapter_source_model` and `adapter_evidence_class` are nullable in baseline 0000 → the read path handles nulls via `resolveSnapshotSourceModel`/`resolveSnapshotEvidenceClass`. That's where C1 lurks.

## Verification Performed

- Read every file in the scope list; mapped call flows for the critical data path (`sync-live-reserves` → adapter → `validateAdapterOutput` → `finalizeReserveSyncSuccess` → store → API resolver).
- Compared `LIVE_RESERVE_ADAPTER_KEYS`, `LIVE_RESERVE_ADAPTER_DEFINITIONS`, `ADAPTER_FNS`, `LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS`, `adapterParamsSchemas`, and `ADAPTER_DISPLAY_BADGE_KINDS`: all 6 sets agree on 43 keys.
- Re-counted configured coins: 140 across `shared/data/stablecoins/*.json` (docs already match; April 15 audit count of 138 is stale).
- Traced the 4-step finalize-success write sequence and confirmed the read-time fencing via `hasConsistentSnapshotState`.
- Traced `classifyFailure` keyword patterns against the error messages that actually reach it from adapters.
- Confirmed `raceWithTimeout` signal disposal and `createAbortableAttemptSignal` cleanup.
- Sanity-checked D1 timeout expressions against SQLite `julianday` math.

## External Notes

- Migration manifest: `worker/migrations/0080_live_reserve_attempt_fencing.sql` — marked `rollout-safety: backward-compatible`. Matches my read.
- `docs/worker-and-api-limits.md`: 6-connection per-trigger budget is trigger-level, not slot-level. Reserve sync's stated 2/6 peak is a slot-level documentation convention.
- `SECONDS.ONE_WEEK` used in `cron-logger.ts` pruning is independent from live reserve pruning (90d). No conflict.
