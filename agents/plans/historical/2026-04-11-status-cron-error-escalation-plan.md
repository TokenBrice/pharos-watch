# Remediation plan: transient `/status` stale churn from critical cron errors

Date: 2026-04-11
Status: planning only, no implementation performed

## Goal

Eliminate the false-positive `healthy → stale → healthy` churn on the public `/status` dashboard caused by a single transient `sync-stablecoins` error, while preserving fast detection of sustained real outages.

## Root cause (verified against production)

The transitions have a 1:1 correspondence with `sync-stablecoins` cron errors in `cron_runs`:

```
status_transitions                cron_runs (sync-stablecoins, status='error')
04:39:54 degrade (266)         ←  04:30:51 "DefiLlama response body parse failed"
18:31:37 degrade (264)         ←  18:30:50 "DefiLlama response body parse failed"
14:31:16 degrade (262)         ←  14:30:23 "DefiLlama response body parse failed"
13:31:21 degrade (260)         ←  13:30:30 "DefiLlama response body parse failed"
07:31:34 degrade (258)         ←  07:31:07 "DefiLlama response body parse failed"
06:31:26 degrade (256)         ←  06:30:57 "DefiLlama response body parse failed"
```

Six errors in a 24h window, every one correlated with a transition. No exceptions.

### The failure chain

1. DefiLlama's `/stablecoins?includePrices=true` intermittently returns a truncated / malformed response body at the :30 slot. HTTP status is 200 OK — the fetch itself succeeds — but `res.json()` throws during body parsing.
2. `worker/src/cron/sync-stablecoins/intake.ts:105-115` catches the parse error, records a circuit-breaker failure, and returns `kind: "fallback"`. The fallback path calls `syncViaCoingeckoFallback`.
3. The CoinGecko fallback returns a `CronResult` with `itemCount === 0` because under the failure mode the CG fallback isn't producing a viable result.
4. `worker/src/cron/sync-stablecoins.ts:53-58` sees `intake.kind === "fallback"` AND `intake.result.itemCount === 0`, and **throws** `new Error(intake.errorMessage)`.
5. The throw propagates up through `runBestEffortScheduledJob` → `cron-logger` → `cron_runs` table with `status = 'error'`, `error = 'Error: DefiLlama response body parse failed'`, `metadata = null`. Duration is ~20s (normal runs take ~235s, so the failure is a short early abort).
6. The next regular run 15 minutes later (e.g. 04:45:51) typically succeeds in ~235s. The error is transient, not a sustained outage.

### The cascade

1. `worker/src/lib/status/cron-health.ts:207-211` counts `lastRun.status === "error"` as an error:

    ```ts
    if (!telemetryUnknown && lastRun?.status === "error" && !inFlightFresh) {
      cronErrorCount++;
      if (statusImpact === "critical") {
        availabilityImpactingCronErrors++;
      }
    }
    ```

2. `sync-stablecoins` has `statusImpact: "critical"` (`shared/lib/cron-jobs.ts:400-405`) so `availabilityImpactingCronErrors` becomes `1`.
3. `worker/src/lib/status/evaluation-state.ts:66-73` escalates on **any** positive count:

    ```ts
    const baseAvailabilityStatus =
      input.publicHealth.cacheImpactStatus === "stale"
      || input.availabilityImpactingCronErrors > 0          // ← single error ⇒ stale
      || input.availabilityImpactingUnhealthyCrons >= 2
        ? "stale"
        : …;
    ```

4. `rawOverallStatus = stale`. Hysteresis `STATUS_HYSTERESIS.escalateToStale = 1` (`shared/lib/status-reliability-shared.ts:14-21`) flips the persisted state on a single raw-stale sample.
5. Recovery requires 3 consecutive healthy raw samples + 180s dwell ≈ 45 min, which matches the observed incident duration exactly.

### Why Codex's fix did not help

Codex's 2026-04-10 investigation (`agents/2026-04-10-status-transient-stale-investigation.md`) concluded the raw-stale sample came from freshness diagnostic failures in `buildCacheStatuses`. Codex delivered:

- `worker/src/lib/freshness-sentinels.ts` + sentinel writes in producers
- Sentinel-first read in `buildCacheStatuses` with table-fallback and cron-fallback layers
- Moved `status-self-check` from the shared `*/15` slot to an isolated `9,24,39,54 * * * *` lane

None of those changes touch the cron-error path. Post-deploy transitions 265, 266, 267 at the new :39/:24 isolated slot still line up with `sync-stablecoins` errors. Codex's sentinel and isolated-lane work remains correct on its own merits and is kept.

## Non-goals

- Do not weaken detection of sustained single-cron outages: 2+ consecutive failed runs on the same critical cron must still flip availability to `stale`.
- Do not broaden the `degraded` → `stale` path for cache-age failures. That path already works.
- Do not redesign the hysteresis state machine. `STATUS_HYSTERESIS` stays untouched.
- Do not refactor the sync-stablecoins intake pipeline beyond what is required to make parse failures retry before falling back.
- Do not revert Codex's sentinel work.

## Design overview

Two independent changes:

### Phase 1: Retry DefiLlama stablecoins parse failures before falling back (source fix)

When `res.json()` throws, re-fetch the endpoint and re-parse up to 2 more times with a short backoff. Only fall back to CoinGecko after all attempts fail. Preserves HTTP status in error logs, cancels the partially-consumed response body between attempts, and respects the intake abort signal.

### Phase 2: Make a single transient cron error degrade, not stale (semantic fix)

Extend `CronHealthSnapshot` with a new counter `availabilityImpactingConsecutiveCronErrors` (count of critical-impact cron jobs whose most recent **≥2** runs are all `error`). Change `deriveAvailabilityStatus` so:

- 1 critical cron error → `degraded`
- 2+ consecutive errors on same critical cron → `stale`
- 2+ different critical crons simultaneously unhealthy → `stale` (unchanged)
- Cache-age stale → `stale` (unchanged)
- `publicAvailabilityFloor` (circuit, mintBurnImpactStatus) → unchanged

Surface the new counter in the public `StatusResponse.summary` shape, so the admin dashboard UI can distinguish transient from sustained without re-deriving the state machine.

## Files in scope

### Phase 1 — parse retry

- Modify: `worker/src/cron/sync-stablecoins/intake.ts`
- Modify: `worker/src/cron/__tests__/sync-stablecoins.test.ts` (colocate new tests here — this file already mocks `../../lib/fetch-retry`, `../../lib/circuit-breaker`, and `../../lib/coingecko`, and provides `fetchWithRetryMock`; creating a new `sync-stablecoins/__tests__/` directory would duplicate that infrastructure and drift over time)

### Phase 2 — semantic fix

- Modify: `shared/types/status.ts` — add `availabilityImpactingConsecutiveCronErrors: number` to the `summary` object in `StatusResponse` (after the existing `availabilityImpactingCronErrors` field, line ~442).
- Modify: `worker/src/lib/status/cron-health.ts` — add the counter computation.
- Modify: `worker/src/lib/status/evaluation-state.ts` — update `deriveAvailabilityStatus` signature and body.
- Modify: `worker/src/lib/status-evaluation.ts` — destructure + thread new field; add to the `summary` emitted by `computeRawStatus` and `buildDbUnavailableRawStatus`.
- Modify: `worker/src/lib/status/evaluation-causes.ts` — branch `cron_error_runs` severity on transient vs sustained; accept new field in `buildAvailabilityCauses` input; update the call site in `worker/src/lib/status-evaluation.ts` (same file as above — batch the edits).
- Modify: `worker/src/lib/__tests__/status-evaluation-state.test.ts` — update the existing `"does not let circuit diagnostics failure degrade availability on its own"` test (line ~128) to include `availabilityImpactingConsecutiveCronErrors: 0`. Add new test cases for the transient-vs-sustained semantic.
- Modify: `worker/src/api/__tests__/status.test.ts` — update the `"ignores orphaned in-flight progress when the lease is no longer active"` test (lines 1209-1253) whose assertion on line 1252 currently expects `availabilityStatus === "stale"` for a single `sync-blacklist` error run. Under the new semantic that case becomes `degraded`; either rewrite the assertion to `degraded` OR add a second error run to keep the `stale` expectation. The plan picks the **former** (rewrite to `degraded`) to keep the original test's intent (a single error is not a full outage). Also audit the file for any other `availabilityStatus === "stale"` assertions that rely on a single critical-cron error; at the time of plan writing the only one is line 1252.
- Create: `worker/src/lib/status/__tests__/cron-health.test.ts` — new unit test file for `loadCronHealth`. Directory `worker/src/lib/status/__tests__/` does not currently exist and must be created.

### Phase 2 — frontend consumer updates

The plan's Phase 2 semantic change will propagate through `/api/status`. Two frontend surfaces currently hardcode `availabilityImpactingCronErrors > 0` as the "critical" threshold and will lie to operators if they are not updated:

- Modify: `src/lib/status-dashboard-model.ts` — lines 355-362, the `cronStatus` derivation. After the change, a single critical cron error should produce `cronStatus = 1` (warning), not `2` (critical). Use `availabilityImpactingConsecutiveCronErrors > 0` as the `cronStatus = 2` gate; keep `availabilityImpactingCronErrors > 0` or `availabilityImpactingUnhealthyCrons > 0` as the `cronStatus = 1` gate.
- Modify: `src/components/status/status-facts.tsx` — lines 143-150, the "Cron Errors" card tone. After the change, red should fire on `availabilityImpactingConsecutiveCronErrors > 0`; amber should fire when `availabilityImpactingCronErrors > 0 || cronErrors > 0`; green otherwise.
- Modify: `src/lib/__tests__/status-dashboard-model.test.ts` — update any fixtures whose `summary` literal does not include the new counter (required after `shared/types/status.ts` is extended — it is a type requirement).
- Modify: `src/app/admin/__tests__/client.test.tsx` — same reason: summary fixtures need the new counter.

(These are type-level cascades, not behavioural choices — every consumer of `StatusResponse["summary"]` in the repo must spell the new field because `StatusResponse` is a strict type without defaults.)

### Phase 2 — docs

- Modify: `docs/status-dashboard.md` — the existing text around line 295 only documents the schema (`summary.availabilityImpactingCronErrors`). **Add** a new entry for `summary.availabilityImpactingConsecutiveCronErrors` and a new "Cron error escalation" sub-section explaining the transient-vs-sustained semantic.
- Modify: `docs/api-reference.md` — the file contains `availabilityImpactingCronErrors` in a `/api/status` sample payload at line 2385 and describes it in prose at line 2524. Update the sample to include the new counter field (value `0`), and extend the prose to explain that `summary.availabilityImpactingConsecutiveCronErrors` counts critical crons with **≥2 consecutive** failed runs and is the trigger for escalation to `stale` on the cron error path.

### Phase 2 — NOT in scope

- `docs/methodology.md` and related methodology-surface docs — the fix is a reliability / escalation semantic change, not a methodology change. No update required.
- Changelog entries — internal reliability fix.

## File inventory sanity check (verified at plan time)

- `worker/src/cron/sync-stablecoins/__tests__/` — **does not exist.** New tests colocate in existing `worker/src/cron/__tests__/sync-stablecoins.test.ts`.
- `worker/src/lib/status/__tests__/` — **does not exist.** Plan creates it for the new `cron-health.test.ts` file.
- `worker/src/lib/abort.ts` — exports `throwIfAborted` (line 8) and `sleepWithSignal` (line 26). ✓
- `worker/src/lib/response-body.ts` — exports `cancelResponseBodyQuietly`. Imported from `worker/src/lib/fetch-retry.ts:2`. ✓
- `worker/src/api/__tests__/helpers/mock-d1.ts` — `mockD1(tables: MockTableConfig[])` where each table is `{ match: string; matchBinds?: unknown[]; rows: Record<string, unknown>[]; first?: Record<string, unknown> | null; throwError?: unknown }`. ✓
- `worker/src/cron/__tests__/sync-stablecoins.test.ts` — already mocks `../../lib/fetch-retry` via `vi.mock("../../lib/fetch-retry", () => ({ fetchWithRetry: (...args) => fetchWithRetryMock(...args) }))` (line 253-255). New test cases reuse `fetchWithRetryMock` and the existing `mockFetch(routes)` helper (line 13-27).
- `docs/status-dashboard.md:295` — only has the schema summary line; no existing "Cron error escalation" section to replace.
- `docs/api-reference.md:2385` — sample payload line `"availabilityImpactingCronErrors": 0`. Line 2524 — prose describing the `summary` counters.
- `worker/src/lib/__tests__/status-evaluation-state.test.ts:128-135` — existing call to `deriveAvailabilityStatus` with only two cron fields (`availabilityImpactingCronErrors: 0, availabilityImpactingUnhealthyCrons: 0`). Must be updated when the signature changes.
- `worker/src/api/__tests__/status.test.ts:1252` — `expect(body.availabilityStatus).toBe("stale")` with a single `sync-blacklist` error seed. Must be updated.
- `src/lib/__tests__/status-dashboard-model.test.ts` and `src/app/admin/__tests__/client.test.tsx` — both contain `summary` fixtures that construct a full `StatusResponse["summary"]`. When the type gains a new field, every fixture needs the field or TS will error.

## Phase 1 task breakdown

### Task 1.1 — Failing tests for parse-retry success, exhaustion, and HTTP-error passthrough

**Files:**
- Modify: `worker/src/cron/__tests__/sync-stablecoins.test.ts`

- [ ] **Step 1: Write failing tests**

Inside the existing `describe("syncStablecoins", …)` block (or a sibling `describe("syncStablecoins DL parse retry", …)` block), add three tests. All three reuse the existing `fetchWithRetryMock`, `mockD1`, and the test's `syncStablecoins(db, …)` entry point. The mocks target `fetchWithRetry`, NOT raw `fetch`, in keeping with the rest of the file.

Pre-req: add the `CIRCUIT_SOURCE` import at the top of the test file if it is not already present. Current imports include `shouldAttemptFetch, recordOutcome` from `../../lib/circuit-breaker` (line 279); add `CIRCUIT_SOURCE` from `../../lib/constants` alongside the other `constants` imports (if any) or as a new line.

Test A — parse retry succeeds on second attempt:

```ts
  it("retries DL response body parse failure before falling back", async () => {
    // The file's beforeEach enables vi.useFakeTimers(). The parse-retry path
    // uses sleepWithSignal() (real setTimeout), which would hang forever under
    // fake timers. Switch to real timers for this test only — afterEach will
    // restore fake timers for the next test if needed.
    vi.useRealTimers();

    const db = mockD1([/* standard seed — copy from the adjacent "succeeds on happy path" test */]);

    // Use the existing 60-asset helper from this file — a smaller payload would
    // fall below MIN_VALID_ASSET_COUNT (50) and reach the fallback path anyway.
    const validPayload = makeDlResponse(60);

    // Stub a Response whose .json() rejects. Object.assign DOES override the
    // prototype method via an own-property shadow, but Partial<Response> cast
    // avoids any ambiguity and matches Test B's pattern below.
    function makeThrowingResponse(): Response {
      const stub: Partial<Response> = {
        ok: true,
        status: 200,
        headers: new Headers({ "Content-Type": "application/json" }),
        json: () => Promise.reject(new SyntaxError("Unexpected end of JSON input")),
        text: () => Promise.resolve("truncated{"),
        body: null,
        bodyUsed: false,
        clone: () => makeThrowingResponse(),
      };
      return stub as Response;
    }
    function makeValidResponse(): Response {
      return new Response(JSON.stringify(validPayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Capture the CG route spy ONCE outside the closure — calling mockFetch(...)
    // again inside the closure would call fetchWithRetryMock.mockImplementation()
    // and overwrite this very router mid-test. See comment in mockFetch() helper.
    const cgMockFetch = mockFetch([/* reuse the happy-path CG routes from the adjacent test */]);

    let dlAttempt = 0;
    fetchWithRetryMock.mockImplementation(async (url: string) => {
      if (url.includes("/stablecoins?includePrices=true")) {
        const attempt = dlAttempt++;
        return attempt === 0 ? makeThrowingResponse() : makeValidResponse();
      }
      return cgMockFetch(url);
    });

    await syncStablecoins(db, undefined, undefined, null, null, undefined);

    // Narrow assertion: DL stablecoins circuit MUST NOT have been marked failed,
    // since the retry recovered. We intentionally allow other circuit sources to
    // record failure (they are unrelated to this test's semantics).
    expect(recordOutcome).not.toHaveBeenCalledWith(
      expect.anything(),
      CIRCUIT_SOURCE.DL_STABLECOINS,
      false,
    );
    // DL was fetched exactly twice: initial attempt + 1 successful parse-retry.
    expect(dlAttempt).toBe(2);
  });
```

Test B — parse retry exhausts all attempts and falls back:

```ts
  it("falls back to CoinGecko after all DL parse retries fail", async () => {
    // Exercises the retry loop (2 sleeps) — needs real timers, see Test A note.
    vi.useRealTimers();

    const db = mockD1([/* standard seed */]);

    function makeThrowingResponse(): Response {
      const stub: Partial<Response> = {
        ok: true,
        status: 200,
        headers: new Headers({ "Content-Type": "application/json" }),
        json: () => Promise.reject(new SyntaxError("Unexpected end of JSON input")),
        text: () => Promise.resolve("truncated{"),
        body: null,
        bodyUsed: false,
        clone: () => makeThrowingResponse(),
      };
      return stub as Response;
    }

    // Capture CG router once — see Test A comment about the mockFetch cascade.
    const cgMockFetch = mockFetch([/* coingecko routes */]);

    let dlAttempt = 0;
    fetchWithRetryMock.mockImplementation(async (url: string) => {
      if (url.includes("/stablecoins?includePrices=true")) {
        dlAttempt++;
        return makeThrowingResponse();
      }
      return cgMockFetch(url);
    });

    await syncStablecoins(db, undefined, undefined, null, null, undefined);

    // DL fetched exactly DL_PARSE_MAX_ATTEMPTS (3) times — one per retry.
    expect(dlAttempt).toBe(3);

    // Circuit failure recorded, fallback path taken.
    expect(recordOutcome).toHaveBeenCalledWith(
      expect.anything(),
      CIRCUIT_SOURCE.DL_STABLECOINS,
      false,
    );
  });
```

Test C — HTTP non-OK does NOT enter the parse-retry loop (it goes straight to fallback via existing path):

```ts
  it("skips parse retry and falls back on DL HTTP failure", async () => {
    // No real sleeps in this test path — default fake timers are fine.
    const db = mockD1([/* standard seed */]);

    // Capture CG router once — see Test A comment about the mockFetch cascade.
    const cgMockFetch = mockFetch([/* coingecko routes */]);

    let dlAttempt = 0;
    fetchWithRetryMock.mockImplementation(async (url: string) => {
      if (url.includes("/stablecoins?includePrices=true")) {
        dlAttempt++;
        return new Response("", { status: 502 });
      }
      return cgMockFetch(url);
    });

    await syncStablecoins(db, undefined, undefined, null, null, undefined);

    // DL fetched exactly 1 time (no parse retry on HTTP error).
    expect(dlAttempt).toBe(1);

    expect(recordOutcome).toHaveBeenCalledWith(
      expect.anything(),
      CIRCUIT_SOURCE.DL_STABLECOINS,
      false,
    );
  });
```

(The "standard seed" placeholder refers to the existing table seed used by the happy-path test in the same file. Copy it verbatim — the new tests should not diverge from it in anything other than `fetchWithRetryMock` behavior.)

- [ ] **Step 2: Run and verify failure**

```bash
cd worker && npx vitest run src/cron/__tests__/sync-stablecoins.test.ts --reporter=verbose
```

Expected: Test A fails (current code returns `kind: "fallback"` on the first parse error). Tests B and C pass today (they exercise the existing fallback path and HTTP error path), but must **continue** to pass after Phase 1.2 and are included here so the retry work is fully covered.

- [ ] **Step 3: Commit the failing test**

```bash
git add worker/src/cron/__tests__/sync-stablecoins.test.ts
git commit -m "test(sync-stablecoins): failing test for DL parse retry path"
```

### Task 1.2 — Implement the parse-retry helper

**Files:**
- Modify: `worker/src/cron/sync-stablecoins/intake.ts`

- [ ] **Step 1: Add imports**

Edit the top of `intake.ts`. The current imports block is:

```ts
import { REGISTRY_BY_LLAMA_ID } from "@shared/lib/stablecoin-id-registry";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { CIRCUIT_SOURCE, DEFILLAMA_BASE, MIN_VALID_ASSET_COUNT } from "../../lib/constants";
import { shouldAttemptFetch, recordOutcome } from "../../lib/circuit-breaker";
import type { ChainRpcConfig } from "../../lib/chain-registry";
```

Add (after the `fetchWithRetry` import):

```ts
import { sleepWithSignal, throwIfAborted } from "../../lib/abort";
import { cancelResponseBodyQuietly } from "../../lib/response-body";
```

- [ ] **Step 2: Add the helper (private to the file)**

Insert this block immediately above `export async function loadStablecoinsIntake(` (which currently starts around line 49):

```ts
const DEFILLAMA_STABLECOINS_URL = `${DEFILLAMA_BASE}/stablecoins?includePrices=true`;
const DL_PARSE_MAX_ATTEMPTS = 3;
const DL_PARSE_RETRY_BASE_DELAY_MS = 500;

type DefillamaStablecoinsPayload = {
  peggedAssets: PeggedAsset[];
  fxFallbackRates?: Record<string, number>;
};

interface DefillamaFetchResult {
  payload: DefillamaStablecoinsPayload | null;
  attempts: number;
  lastError: "fetch-failed" | "parse-failed" | null;
  lastHttpStatus: number | null;
}

async function fetchDefillamaStablecoinsPayload(
  signal: AbortSignal | undefined,
): Promise<DefillamaFetchResult> {
  let lastError: DefillamaFetchResult["lastError"] = null;
  let lastHttpStatus: number | null = null;
  for (let attempt = 0; attempt < DL_PARSE_MAX_ATTEMPTS; attempt++) {
    throwIfAborted(signal);
    const res = await fetchWithRetry(
      DEFILLAMA_STABLECOINS_URL,
      signal ? { signal } : undefined,
    );
    if (!res?.ok) {
      lastError = "fetch-failed";
      lastHttpStatus = res?.status ?? null;
      break;
    }
    try {
      const payload = (await res.json()) as DefillamaStablecoinsPayload;
      return {
        payload,
        attempts: attempt + 1,
        lastError: null,
        lastHttpStatus: res.status,
      };
    } catch (parseErr) {
      lastError = "parse-failed";
      lastHttpStatus = res.status;
      console.warn(
        `[sync-stablecoins] DL response body parse failed on attempt ${attempt + 1}/${DL_PARSE_MAX_ATTEMPTS}:`,
        parseErr,
      );
      // Release the partially-consumed response so we don't hold a socket
      // across the retry delay. Matches fetchWithRetry's own between-attempt hygiene.
      await cancelResponseBodyQuietly(res);
      if (attempt + 1 < DL_PARSE_MAX_ATTEMPTS) {
        await sleepWithSignal(DL_PARSE_RETRY_BASE_DELAY_MS * (attempt + 1), signal);
      }
    }
  }
  return {
    payload: null,
    attempts: DL_PARSE_MAX_ATTEMPTS,
    lastError,
    lastHttpStatus,
  };
}
```

- [ ] **Step 3: Rewire the intake flow**

Anchored edit — match the exact current block and replace it. The `old_string` to find (from the current file — verify by reading `worker/src/cron/sync-stablecoins/intake.ts` before editing):

```ts
  const dlAllowed = await shouldAttemptFetch(input.db, CIRCUIT_SOURCE.DL_STABLECOINS);
  const [llamaRes, supplementalTokens] = await Promise.all([
    dlAllowed
      ? fetchWithRetry(`${DEFILLAMA_BASE}/stablecoins?includePrices=true`, input.signal ? { signal: input.signal } : undefined)
      : Promise.resolve(null),
    fetchSupplementalTrackedTokens(cgData, input.signal, input.coingeckoApiKey, input.chainRpcs, input.fxFallbackRates),
  ]);
  const { goldTokens, silverTokens, fiatCgTokens } = supplementalTokens;

  if (dlAllowed) {
    if (!llamaRes?.ok) {
      console.error(`[sync-stablecoins] DefiLlama API error: ${llamaRes?.status ?? "no response"}`);
      await recordOutcome(input.db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
      return {
        kind: "fallback",
        result: await input.fallbackToCoingecko(cgData),
        errorMessage: "DefiLlama stablecoins API failed and CoinGecko fallback was insufficient",
      };
    }
  } else {
    console.warn("[sync-stablecoins] DL stablecoins circuit open — using CG supply fallback");
    return {
      kind: "fallback",
      result: await input.fallbackToCoingecko(cgData),
      errorMessage: "DefiLlama stablecoins circuit open and CoinGecko fallback was insufficient",
    };
  }

  const guardedLlamaRes = llamaRes;
  if (!guardedLlamaRes) {
    await recordOutcome(input.db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
    return {
      kind: "fallback",
      result: await input.fallbackToCoingecko(cgData),
      errorMessage: "DefiLlama response was unexpectedly missing",
    };
  }

  let llamaData: {
    peggedAssets: PeggedAsset[];
    fxFallbackRates?: Record<string, number>;
  };
  try {
    llamaData = await guardedLlamaRes.json() as typeof llamaData;
  } catch (parseErr) {
    console.error("[sync-stablecoins] DL response body parse failed:", parseErr);
    await recordOutcome(input.db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
    return {
      kind: "fallback",
      result: await input.fallbackToCoingecko(cgData),
      errorMessage: "DefiLlama response body parse failed",
    };
  }
```

`new_string`:

```ts
  const dlAllowed = await shouldAttemptFetch(input.db, CIRCUIT_SOURCE.DL_STABLECOINS);
  const supplementalTokensPromise = fetchSupplementalTrackedTokens(
    cgData,
    input.signal,
    input.coingeckoApiKey,
    input.chainRpcs,
    input.fxFallbackRates,
  );

  if (!dlAllowed) {
    console.warn("[sync-stablecoins] DL stablecoins circuit open — using CG supply fallback");
    const supplementalTokensBypassed = await supplementalTokensPromise;
    const { goldTokens: _g, silverTokens: _s, fiatCgTokens: _f } = supplementalTokensBypassed;
    void _g; void _s; void _f;
    return {
      kind: "fallback",
      result: await input.fallbackToCoingecko(cgData),
      errorMessage: "DefiLlama stablecoins circuit open and CoinGecko fallback was insufficient",
    };
  }

  const [dlFetchResult, supplementalTokens] = await Promise.all([
    fetchDefillamaStablecoinsPayload(input.signal),
    supplementalTokensPromise,
  ]);
  const { goldTokens, silverTokens, fiatCgTokens } = supplementalTokens;

  if (!dlFetchResult.payload) {
    if (dlFetchResult.lastError === "parse-failed") {
      console.error(
        `[sync-stablecoins] DL response body parse failed after ${dlFetchResult.attempts} attempts (last HTTP status=${dlFetchResult.lastHttpStatus ?? "unknown"})`,
      );
    } else {
      console.error(
        `[sync-stablecoins] DefiLlama API error after ${dlFetchResult.attempts} attempt(s) (last HTTP status=${dlFetchResult.lastHttpStatus ?? "no response"})`,
      );
    }
    await recordOutcome(input.db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
    return {
      kind: "fallback",
      result: await input.fallbackToCoingecko(cgData),
      errorMessage:
        dlFetchResult.lastError === "parse-failed"
          ? "DefiLlama response body parse failed"
          : "DefiLlama stablecoins API failed and CoinGecko fallback was insufficient",
    };
  }

  const llamaData = dlFetchResult.payload;
```

(Note: the `void _g; _s; _f;` dance in the `!dlAllowed` branch is intentional — the old code destructured those names from `supplementalTokens` before the early return, and preserving the same behavior avoids an unused-variable lint error when `dlAllowed === false`. If lint flags it anyway, convert to `await supplementalTokensPromise;` with no destructure.)

- [ ] **Step 4: Run tests and verify pass**

```bash
cd worker && npx vitest run src/cron/__tests__/sync-stablecoins.test.ts --reporter=verbose
```

Expected: Test A, B, C all PASS. All prior tests still PASS.

- [ ] **Step 5: Worker typecheck**

```bash
cd worker && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add worker/src/cron/sync-stablecoins/intake.ts
git commit -m "fix(sync-stablecoins): retry DL response body parse failures before falling back"
```

## Phase 2 task breakdown

### Task 2.1 — Extend `StatusResponse.summary` in shared types

**Files:**
- Modify: `shared/types/status.ts`

- [ ] **Step 1: Anchored edit**

`old_string`:

```ts
  summary: {
    unhealthyCrons: number;
    availabilityImpactingUnhealthyCrons: number;
    watchUnhealthyCrons: number;
    degradedCrons: number;
    cronErrors: number;
    availabilityImpactingCronErrors: number;
    diagnosticIssueCount: number;
    worstCacheRatio: number;
  };
```

`new_string`:

```ts
  summary: {
    unhealthyCrons: number;
    availabilityImpactingUnhealthyCrons: number;
    watchUnhealthyCrons: number;
    degradedCrons: number;
    cronErrors: number;
    availabilityImpactingCronErrors: number;
    /** Count of availability-critical crons with 2+ consecutive failed runs (sustained outage). */
    availabilityImpactingConsecutiveCronErrors: number;
    diagnosticIssueCount: number;
    worstCacheRatio: number;
  };
```

- [ ] **Step 2: Worker + frontend typecheck to surface every downstream consumer**

```bash
cd worker && npx tsc --noEmit
cd .. && npx tsc --noEmit
```

Expected: several type errors — one per file that constructs a `summary` literal without the new field. Confirmed consumer files (verified at plan time via `grep -rn "availabilityImpactingCronErrors:" --include="*.ts*"`): `worker/src/lib/status-evaluation.ts` (two literals — `computeRawStatus` return and `buildDbUnavailableRawStatus` fallback), `src/lib/__tests__/status-dashboard-model.test.ts`, `src/app/admin/__tests__/client.test.tsx`. Note: `worker/src/api/__tests__/status.test.ts` reads `summary` via narrowing type assertions, not object literals, so it does NOT need a type-level update. Do not commit yet.

### Task 2.2 — Cron health: compute consecutive-error streak counter

**Files:**
- Modify: `worker/src/lib/status/cron-health.ts`

- [ ] **Step 1: Extend the snapshot interface (anchored edit)**

`old_string`:

```ts
export interface CronHealthSnapshot {
  crons: Record<string, CronStatus>;
  unhealthyCrons: number;
  availabilityImpactingUnhealthyCrons: number;
  watchUnhealthyCrons: number;
  degradedCronRuns: number;
  cronErrorCount: number;
  availabilityImpactingCronErrors: number;
  cronHistoryQueryFailed: boolean;
  cronProgressQueryFailed: boolean;
}
```

`new_string`:

```ts
export interface CronHealthSnapshot {
  crons: Record<string, CronStatus>;
  unhealthyCrons: number;
  availabilityImpactingUnhealthyCrons: number;
  watchUnhealthyCrons: number;
  degradedCronRuns: number;
  cronErrorCount: number;
  availabilityImpactingCronErrors: number;
  /** Count of availability-critical crons whose most recent 2+ runs are all `error`. */
  availabilityImpactingConsecutiveCronErrors: number;
  cronHistoryQueryFailed: boolean;
  cronProgressQueryFailed: boolean;
}
```

- [ ] **Step 2: Initialize and compute the new counter (anchored edits)**

First anchored edit — add the initial counter declaration. `old_string`:

```ts
  const crons: Record<string, CronStatus> = {};
  let unhealthyCrons = 0;
  let availabilityImpactingUnhealthyCrons = 0;
  let watchUnhealthyCrons = 0;
  let degradedCronRuns = 0;
  let cronErrorCount = 0;
  let availabilityImpactingCronErrors = 0;
```

`new_string`:

```ts
  const crons: Record<string, CronStatus> = {};
  let unhealthyCrons = 0;
  let availabilityImpactingUnhealthyCrons = 0;
  let watchUnhealthyCrons = 0;
  let degradedCronRuns = 0;
  let cronErrorCount = 0;
  let availabilityImpactingCronErrors = 0;
  let availabilityImpactingConsecutiveCronErrors = 0;
```

Second anchored edit — compute the streak per job and increment. `old_string`:

```ts
    if (!telemetryUnknown && lastRun?.status === "degraded" && isFresh) degradedCronRuns++;
    if (!telemetryUnknown && lastRun?.status === "error" && !inFlightFresh) {
      cronErrorCount++;
      if (statusImpact === "critical") {
        availabilityImpactingCronErrors++;
      }
    }
```

`new_string`:

```ts
    if (!telemetryUnknown && lastRun?.status === "degraded" && isFresh) degradedCronRuns++;
    if (!telemetryUnknown && lastRun?.status === "error" && !inFlightFresh) {
      cronErrorCount++;
      if (statusImpact === "critical") {
        availabilityImpactingCronErrors++;
      }
      // Consecutive-error streak: only counts if the current run is in-error AND
      // the previous run (if any) was also in-error. Uses the already-loaded
      // `runs` array (DESC by started_at, capped at 10 per job).
      if (
        statusImpact === "critical"
        && runs.length >= 2
        && runs[0]?.status === "error"
        && runs[1]?.status === "error"
      ) {
        availabilityImpactingConsecutiveCronErrors++;
      }
    }
```

(The double guard — `lastRun?.status === "error" && !inFlightFresh` outer, plus `runs[0]?.status === "error" && runs[1]?.status === "error"` inner — is redundant in the happy path but cheap and keeps the semantics obvious. Walking the full streak length is unnecessary; all we need is "≥2 consecutive" which is `runs[0]` and `runs[1]` both error.)

Third anchored edit — include the new counter in the return value. `old_string`:

```ts
  return {
    crons,
    unhealthyCrons,
    availabilityImpactingUnhealthyCrons,
    watchUnhealthyCrons,
    degradedCronRuns,
    cronErrorCount,
    availabilityImpactingCronErrors,
    cronHistoryQueryFailed,
    cronProgressQueryFailed,
  };
```

`new_string`:

```ts
  return {
    crons,
    unhealthyCrons,
    availabilityImpactingUnhealthyCrons,
    watchUnhealthyCrons,
    degradedCronRuns,
    cronErrorCount,
    availabilityImpactingCronErrors,
    availabilityImpactingConsecutiveCronErrors,
    cronHistoryQueryFailed,
    cronProgressQueryFailed,
  };
```

- [ ] **Step 3: Worker typecheck**

```bash
cd worker && npx tsc --noEmit
```

Expected: no new errors from `cron-health.ts` itself. `shared/types/status.ts` errors from Task 2.1 still present (will be resolved in Task 2.5 / 2.6).

### Task 2.3 — Regression unit tests for `loadCronHealth` streak counting

This task lands AFTER Task 2.2 (the implementation). These are regression tests pinning the new contract, not strict-TDD failing tests.

**Files:**
- Create: `worker/src/lib/status/__tests__/cron-health.test.ts` (new directory: `worker/src/lib/status/__tests__/`)

- [ ] **Step 1: Create directory + write regression tests**

```bash
mkdir -p worker/src/lib/status/__tests__
```

Write:

```ts
// worker/src/lib/status/__tests__/cron-health.test.ts
import { describe, expect, it } from "vitest";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { mockD1 } from "../../../api/__tests__/helpers/mock-d1";
import { loadCronHealth } from "../cron-health";

interface SeedRun {
  job: string;
  status: "ok" | "error" | "degraded";
  ageSec: number;
}

function makeCronRow(job: string, status: string, ageSec: number, now: number): Record<string, unknown> {
  return {
    job,
    started_at: now - ageSec,
    duration_ms: 100,
    status,
    error: status === "error" ? "test-error" : null,
    item_count: 1,
    metadata: null,
  };
}

function seedWithOverrides(now: number, overrides: SeedRun[]): Record<string, unknown>[] {
  // Build a map of one 30s-old "ok" run per job as the default.
  // Every job in CRON_INTERVALS is pre-seeded so that jobs NOT listed in
  // `overrides` never count as "unhealthy" (lastRun = null) and pollute every
  // counter.
  const base: Map<string, Record<string, unknown>[]> = new Map();
  for (const job of Object.keys(CRON_INTERVALS)) {
    base.set(job, [makeCronRow(job, "ok", 30, now)]);
  }
  // For jobs that DO appear in `overrides`, clear the default ok row completely
  // and replace it with the caller-supplied sequence. Callers pass overrides in
  // "most recent first" order, and we push to preserve that order — the final
  // global sort by started_at DESC will re-interleave across jobs.
  const clearedForOverride = new Set<string>();
  for (const override of overrides) {
    if (!clearedForOverride.has(override.job)) {
      base.set(override.job, []);
      clearedForOverride.add(override.job);
    }
    base.get(override.job)!.push(makeCronRow(override.job, override.status, override.ageSec, now));
  }
  // Flatten into a single DESC-ordered result list.
  return [...base.values()]
    .flat()
    .sort((a, b) => (b.started_at as number) - (a.started_at as number));
}

function makeDb(now: number, rows: Record<string, unknown>[]) {
  return mockD1([
    { match: "ROW_NUMBER() OVER", rows },
    { match: "FROM cron_leases", rows: [] },
    { match: "FROM cron_run_progress", rows: [] },
  ]);
}

describe("loadCronHealth — availabilityImpactingConsecutiveCronErrors", () => {
  // Fixed epoch-seconds value so test assertions are deterministic and do not
  // drift with wall-clock time. Matches the production `now` argument shape
  // (Math.floor(Date.now() / 1000)).
  const NOW = 1_775_890_000;

  it("returns 0 when all critical crons have at most a single error run", async () => {
    // After the base ok row is cleared (because sync-stablecoins appears in
    // overrides), we explicitly seed an earlier ok run so the streak check has
    // something to compare against.
    const rows = seedWithOverrides(NOW, [
      { job: "sync-stablecoins", status: "error", ageSec: 30 },
      { job: "sync-stablecoins", status: "ok", ageSec: 900 },
    ]);
    const snapshot = await loadCronHealth(makeDb(NOW, rows), NOW);
    expect(snapshot.availabilityImpactingCronErrors).toBe(1);
    expect(snapshot.availabilityImpactingConsecutiveCronErrors).toBe(0);
  });

  it("returns 1 when exactly one critical cron has 2 consecutive errors", async () => {
    const rows = seedWithOverrides(NOW, [
      { job: "sync-stablecoins", status: "error", ageSec: 30 },
      { job: "sync-stablecoins", status: "error", ageSec: 900 },
      { job: "sync-stablecoins", status: "ok", ageSec: 1800 },
    ]);
    const snapshot = await loadCronHealth(makeDb(NOW, rows), NOW);
    expect(snapshot.availabilityImpactingCronErrors).toBe(1);
    expect(snapshot.availabilityImpactingConsecutiveCronErrors).toBe(1);
  });

  it("returns 2 when two critical crons each have 2 consecutive errors", async () => {
    const rows = seedWithOverrides(NOW, [
      { job: "sync-stablecoins", status: "error", ageSec: 30 },
      { job: "sync-stablecoins", status: "error", ageSec: 900 },
      { job: "sync-fx-rates", status: "error", ageSec: 30 },
      { job: "sync-fx-rates", status: "error", ageSec: 900 },
    ]);
    const snapshot = await loadCronHealth(makeDb(NOW, rows), NOW);
    expect(snapshot.availabilityImpactingCronErrors).toBe(2);
    expect(snapshot.availabilityImpactingConsecutiveCronErrors).toBe(2);
  });

  it("ignores watch-tier error streaks", async () => {
    // sync-dex-liquidity is watch-tier (not critical)
    const rows = seedWithOverrides(NOW, [
      { job: "sync-dex-liquidity", status: "error", ageSec: 30 },
      { job: "sync-dex-liquidity", status: "error", ageSec: 1800 },
    ]);
    const snapshot = await loadCronHealth(makeDb(NOW, rows), NOW);
    expect(snapshot.availabilityImpactingConsecutiveCronErrors).toBe(0);
  });

  it("resets the streak when the previous run was not an error", async () => {
    const rows = seedWithOverrides(NOW, [
      { job: "sync-stablecoins", status: "error", ageSec: 30 },
      { job: "sync-stablecoins", status: "ok", ageSec: 900 },
      { job: "sync-stablecoins", status: "error", ageSec: 1800 },
    ]);
    const snapshot = await loadCronHealth(makeDb(NOW, rows), NOW);
    // Most recent 2 runs are error/ok → streak is 0
    expect(snapshot.availabilityImpactingConsecutiveCronErrors).toBe(0);
  });
});
```

(The helper `seedWithOverrides` is slightly tricky because the existing cron-runs SQL uses `ROW_NUMBER() OVER (PARTITION BY job ORDER BY started_at DESC) AS rn … WHERE rn <= 10` to return up to 10 runs per job. `mockD1` does not simulate that SQL — it just returns the rows we give it. So we need to pass already-flattened rows that `loadCronHealth` will read verbatim, and then the per-job iteration inside `loadCronHealth` walks them. Double-check this by reading `worker/src/lib/status/cron-health.ts:155-170` where it builds `cronByJob` — it groups by row.job and caps at 10 entries per job, in the order rows arrive. Our mock returns rows in DESC started_at order so the first entry for each job is the most recent, which is what the streak counter needs.)

- [ ] **Step 2: Run and verify pass**

```bash
cd worker && npx vitest run src/lib/status/__tests__/cron-health.test.ts --reporter=verbose
```

Expected: all PASS. Task 2.2 already landed the implementation, so these regression tests should pass on first run. If any fail, the test caught a real bug in Task 2.2 — fix 2.2 before proceeding.

- [ ] **Step 3: Commit**

```bash
git add worker/src/lib/status/__tests__/cron-health.test.ts
git commit -m "test(status/cron-health): cover consecutive-error streak counter"
```

### Task 2.4 — Update `deriveAvailabilityStatus` and its tests

**Files:**
- Modify: `worker/src/lib/status/evaluation-state.ts`
- Modify: `worker/src/lib/__tests__/status-evaluation-state.test.ts`

- [ ] **Step 1: Update the existing test to the new signature (make it compile)**

Anchored edit in `status-evaluation-state.test.ts`. `old_string`:

```ts
  it("does not let circuit diagnostics failure degrade availability on its own", () => {
    const availability = deriveAvailabilityStatus({
      publicHealth: makePublicHealth({
        circuitImpactStatus: "degraded",
        circuitQueryError: "Circuit breaker diagnostics unavailable.",
      }),
      availabilityImpactingCronErrors: 0,
      availabilityImpactingUnhealthyCrons: 0,
    });

    expect(availability).toBe("healthy");
  });
});
```

`new_string`:

```ts
  it("does not let circuit diagnostics failure degrade availability on its own", () => {
    const availability = deriveAvailabilityStatus({
      publicHealth: makePublicHealth({
        circuitImpactStatus: "degraded",
        circuitQueryError: "Circuit breaker diagnostics unavailable.",
      }),
      availabilityImpactingCronErrors: 0,
      availabilityImpactingUnhealthyCrons: 0,
      availabilityImpactingConsecutiveCronErrors: 0,
    });

    expect(availability).toBe("healthy");
  });
});
```

- [ ] **Step 2: Write failing tests for the new semantic**

Append this block after the closing `});` of the existing `describe("status evaluation policy", …)` block:

```ts
describe("deriveAvailabilityStatus cron-error semantic", () => {
  const baseInput = {
    publicHealth: makePublicHealth(),
    availabilityImpactingCronErrors: 0,
    availabilityImpactingUnhealthyCrons: 0,
    availabilityImpactingConsecutiveCronErrors: 0,
  };

  it("stays healthy when nothing is wrong", () => {
    expect(deriveAvailabilityStatus(baseInput)).toBe("healthy");
  });

  it("degrades on a single critical cron error without escalating to stale", () => {
    expect(
      deriveAvailabilityStatus({
        ...baseInput,
        availabilityImpactingCronErrors: 1,
        availabilityImpactingUnhealthyCrons: 1,
      }),
    ).toBe("degraded");
  });

  it("escalates to stale on 2+ consecutive errors on the same critical cron", () => {
    expect(
      deriveAvailabilityStatus({
        ...baseInput,
        availabilityImpactingCronErrors: 1,
        availabilityImpactingUnhealthyCrons: 1,
        availabilityImpactingConsecutiveCronErrors: 1,
      }),
    ).toBe("stale");
  });

  it("escalates to stale when 2+ critical crons are simultaneously unhealthy", () => {
    expect(
      deriveAvailabilityStatus({
        ...baseInput,
        availabilityImpactingCronErrors: 2,
        availabilityImpactingUnhealthyCrons: 2,
      }),
    ).toBe("stale");
  });

  it("preserves cacheImpactStatus=stale escalation independent of cron health", () => {
    expect(
      deriveAvailabilityStatus({
        ...baseInput,
        publicHealth: makePublicHealth({ cacheImpactStatus: "stale" }),
      }),
    ).toBe("stale");
  });

  it("respects publicAvailabilityFloor via mintBurnImpactStatus=stale", () => {
    expect(
      deriveAvailabilityStatus({
        ...baseInput,
        publicHealth: makePublicHealth({
          mintBurnImpactStatus: "stale",
          mintBurnLastRunStatus: "error",
        }),
      }),
    ).toBe("stale");
  });
});
```

- [ ] **Step 3: Verify tests fail**

```bash
cd worker && npx vitest run src/lib/__tests__/status-evaluation-state.test.ts --reporter=verbose
```

Expected: TypeScript error or runtime failure — `availabilityImpactingConsecutiveCronErrors` not yet accepted by `deriveAvailabilityStatus`, and the single-error case currently returns `stale`.

- [ ] **Step 4: Update `deriveAvailabilityStatus` (anchored edit)**

`old_string`:

```ts
export function deriveAvailabilityStatus(input: {
  publicHealth: PublicHealthAssessment;
  availabilityImpactingCronErrors: number;
  availabilityImpactingUnhealthyCrons: number;
}): StatusResponse["availabilityStatus"] {
  const baseAvailabilityStatus: StatusResponse["availabilityStatus"] =
    input.publicHealth.cacheImpactStatus === "stale"
    || input.availabilityImpactingCronErrors > 0
    || input.availabilityImpactingUnhealthyCrons >= 2
      ? "stale"
      : input.publicHealth.cacheImpactStatus === "degraded" || input.availabilityImpactingUnhealthyCrons > 0
        ? "degraded"
        : "healthy";
  const publicAvailabilityFloor = maxPublicStatus(
    input.publicHealth.circuitQueryError == null ? input.publicHealth.circuitImpactStatus : "healthy",
    input.publicHealth.mintBurnQueryError == null && !input.publicHealth.mintBurnBootstrap
      ? input.publicHealth.mintBurnImpactStatus
      : "healthy",
  );
  return maxStatus(baseAvailabilityStatus, publicAvailabilityFloor);
}
```

`new_string`:

```ts
export function deriveAvailabilityStatus(input: {
  publicHealth: PublicHealthAssessment;
  availabilityImpactingCronErrors: number;
  availabilityImpactingUnhealthyCrons: number;
  availabilityImpactingConsecutiveCronErrors: number;
}): StatusResponse["availabilityStatus"] {
  const baseAvailabilityStatus: StatusResponse["availabilityStatus"] =
    input.publicHealth.cacheImpactStatus === "stale"
    || input.availabilityImpactingConsecutiveCronErrors > 0
    || input.availabilityImpactingUnhealthyCrons >= 2
      ? "stale"
      : input.publicHealth.cacheImpactStatus === "degraded"
        || input.availabilityImpactingCronErrors > 0
        || input.availabilityImpactingUnhealthyCrons > 0
        ? "degraded"
        : "healthy";
  const publicAvailabilityFloor = maxPublicStatus(
    input.publicHealth.circuitQueryError == null ? input.publicHealth.circuitImpactStatus : "healthy",
    input.publicHealth.mintBurnQueryError == null && !input.publicHealth.mintBurnBootstrap
      ? input.publicHealth.mintBurnImpactStatus
      : "healthy",
  );
  return maxStatus(baseAvailabilityStatus, publicAvailabilityFloor);
}
```

- [ ] **Step 5: Verify tests pass**

```bash
cd worker && npx vitest run src/lib/__tests__/status-evaluation-state.test.ts --reporter=verbose
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add worker/src/lib/status/evaluation-state.ts worker/src/lib/__tests__/status-evaluation-state.test.ts
git commit -m "fix(status): treat single critical cron error as degraded, not stale"
```

### Task 2.5 — Thread the new counter through `computeRawStatus` and `summary`

**Files:**
- Modify: `worker/src/lib/status-evaluation.ts`

- [ ] **Step 1: Destructure the new counter (anchored edit 1/3)**

`old_string`:

```ts
  const {
    crons,
    unhealthyCrons,
    availabilityImpactingUnhealthyCrons,
    watchUnhealthyCrons,
    degradedCronRuns,
    cronErrorCount,
    availabilityImpactingCronErrors,
    cronHistoryQueryFailed,
    cronProgressQueryFailed,
  } = await loadCronHealth(db, now);
```

`new_string`:

```ts
  const {
    crons,
    unhealthyCrons,
    availabilityImpactingUnhealthyCrons,
    watchUnhealthyCrons,
    degradedCronRuns,
    cronErrorCount,
    availabilityImpactingCronErrors,
    availabilityImpactingConsecutiveCronErrors,
    cronHistoryQueryFailed,
    cronProgressQueryFailed,
  } = await loadCronHealth(db, now);
```

- [ ] **Step 2: Pass the new counter to `deriveAvailabilityStatus` (anchored edit 2/3)**

`old_string`:

```ts
  const availabilityStatus = deriveAvailabilityStatus({
    publicHealth,
    availabilityImpactingCronErrors,
    availabilityImpactingUnhealthyCrons,
  });
```

`new_string`:

```ts
  const availabilityStatus = deriveAvailabilityStatus({
    publicHealth,
    availabilityImpactingCronErrors,
    availabilityImpactingUnhealthyCrons,
    availabilityImpactingConsecutiveCronErrors,
  });
```

- [ ] **Step 3: Emit the new counter in the summary (anchored edit 3/3)**

`old_string`:

```ts
    summary: {
      unhealthyCrons,
      availabilityImpactingUnhealthyCrons,
      watchUnhealthyCrons,
      degradedCrons: degradedCronRuns,
      cronErrors: cronErrorCount,
      availabilityImpactingCronErrors,
      diagnosticIssueCount,
      worstCacheRatio: publicHealth.worstCacheRatio,
    },
  };
}
```

`new_string`:

```ts
    summary: {
      unhealthyCrons,
      availabilityImpactingUnhealthyCrons,
      watchUnhealthyCrons,
      degradedCrons: degradedCronRuns,
      cronErrors: cronErrorCount,
      availabilityImpactingCronErrors,
      availabilityImpactingConsecutiveCronErrors,
      diagnosticIssueCount,
      worstCacheRatio: publicHealth.worstCacheRatio,
    },
  };
}
```

- [ ] **Step 4: Update the DB-unavailable fallback summary (anchored edit 4/4)**

`old_string`:

```ts
    summary: {
      unhealthyCrons: 0,
      availabilityImpactingUnhealthyCrons: 0,
      watchUnhealthyCrons: 0,
      degradedCrons: 0,
      cronErrors: 0,
      availabilityImpactingCronErrors: 0,
      diagnosticIssueCount: 0,
      worstCacheRatio: 0,
    },
```

`new_string`:

```ts
    summary: {
      unhealthyCrons: 0,
      availabilityImpactingUnhealthyCrons: 0,
      watchUnhealthyCrons: 0,
      degradedCrons: 0,
      cronErrors: 0,
      availabilityImpactingCronErrors: 0,
      availabilityImpactingConsecutiveCronErrors: 0,
      diagnosticIssueCount: 0,
      worstCacheRatio: 0,
    },
```

- [ ] **Step 5: Worker typecheck**

```bash
cd worker && npx tsc --noEmit
```

Expected: no errors from `status-evaluation.ts`. Errors remaining: frontend test fixtures in `src/lib/__tests__/status-dashboard-model.test.ts` and `src/app/admin/__tests__/client.test.tsx` — addressed in Task 2.8 Step 3.

- [ ] **Step 6: Commit**

```bash
git add worker/src/lib/status-evaluation.ts worker/src/lib/status/cron-health.ts shared/types/status.ts
git commit -m "feat(status): surface consecutive-error streak counter in summary"
```

(This commit bundles the type extension from Task 2.1 and the cron-health change from Task 2.2 with the wiring in 2.5. That is intentional — these three changes cannot be committed independently without leaving the tree in a type-broken state.)

### Task 2.6 — Update `cron_error_runs` cause severity + message

**Files:**
- Modify: `worker/src/lib/status/evaluation-causes.ts`
- Modify: `worker/src/lib/status-evaluation.ts` (the `buildAvailabilityCauses` call site)

- [ ] **Step 1: Extend `buildAvailabilityCauses` input + update the branch**

Anchored edit in `evaluation-causes.ts`. `old_string`:

```ts
export function buildAvailabilityCauses(input: {
  publicHealth: PublicHealthAssessment;
  availabilityImpactingUnhealthyCrons: number;
  watchUnhealthyCrons: number;
  degradedCronRuns: number;
  cronErrorCount: number;
  availabilityImpactingCronErrors: number;
  cronHistoryQueryFailed: boolean;
  cronProgressQueryFailed: boolean;
}): StatusCause[] {
```

`new_string`:

```ts
export function buildAvailabilityCauses(input: {
  publicHealth: PublicHealthAssessment;
  availabilityImpactingUnhealthyCrons: number;
  watchUnhealthyCrons: number;
  degradedCronRuns: number;
  cronErrorCount: number;
  availabilityImpactingCronErrors: number;
  availabilityImpactingConsecutiveCronErrors: number;
  cronHistoryQueryFailed: boolean;
  cronProgressQueryFailed: boolean;
}): StatusCause[] {
```

Second anchored edit in the same file. `old_string`:

```ts
  if (input.availabilityImpactingCronErrors > 0) {
    pushCause(availabilityCauses, {
      code: "cron_error_runs",
      layer: "availability",
      severity: "critical",
      message: `${input.availabilityImpactingCronErrors} availability-impacting cron job(s) currently have last-run status=error.`,
      metric: "availabilityImpactingCronErrors",
      value: input.availabilityImpactingCronErrors,
      threshold: 1,
    });
  }
```

`new_string`:

```ts
  if (input.availabilityImpactingCronErrors > 0) {
    const isSustained = input.availabilityImpactingConsecutiveCronErrors > 0;
    pushCause(availabilityCauses, {
      code: "cron_error_runs",
      layer: "availability",
      severity: isSustained ? "critical" : "warning",
      message: isSustained
        ? `${input.availabilityImpactingConsecutiveCronErrors} availability-impacting cron job(s) have 2+ consecutive failed runs.`
        : `${input.availabilityImpactingCronErrors} availability-impacting cron job(s) had a single transient failed run.`,
      metric: "availabilityImpactingCronErrors",
      value: input.availabilityImpactingCronErrors,
      threshold: 1,
    });
  }
```

- [ ] **Step 2: Pass the new field at the call site**

Anchored edit in `status-evaluation.ts`. `old_string`:

```ts
  const availabilityCauses = buildAvailabilityCauses({
    publicHealth,
    availabilityImpactingUnhealthyCrons,
    watchUnhealthyCrons,
    degradedCronRuns,
    cronErrorCount,
    availabilityImpactingCronErrors,
    cronHistoryQueryFailed,
    cronProgressQueryFailed,
  });
```

`new_string`:

```ts
  const availabilityCauses = buildAvailabilityCauses({
    publicHealth,
    availabilityImpactingUnhealthyCrons,
    watchUnhealthyCrons,
    degradedCronRuns,
    cronErrorCount,
    availabilityImpactingCronErrors,
    availabilityImpactingConsecutiveCronErrors,
    cronHistoryQueryFailed,
    cronProgressQueryFailed,
  });
```

- [ ] **Step 3: Worker typecheck and tests**

```bash
cd worker && npx tsc --noEmit
cd worker && npx vitest run --reporter=verbose
```

Expected: pass for status-evaluation tests. Other failures remain — fixtures in `status.test.ts` and frontend tests.

- [ ] **Step 4: Commit**

```bash
git add worker/src/lib/status/evaluation-causes.ts worker/src/lib/status-evaluation.ts
git commit -m "feat(status/causes): distinguish transient vs sustained cron error severity"
```

### Task 2.7 — Verify `status.test.ts` assertions still hold (no changes required)

**Files:**
- Read-only verify: `worker/src/api/__tests__/status.test.ts`

Review 2 surfaced that the existing `"ignores orphaned in-flight progress when the lease is no longer active"` test (lines 1209-1253) would continue to return `availabilityStatus = "stale"` under the new semantic for reasons unrelated to the cron-error path:

1. The test seeds `cron_runs` with ONLY `[makeCronRow("sync-blacklist", "error", 30)]`, leaving `sync-stablecoins`, `sync-fx-rates`, and `sync-mint-burn` with zero runs. Under `loadCronHealth`, a job with no runs evaluates to `lastRun = null`, `healthy = false`, and increments `availabilityImpactingUnhealthyCrons` for each critical cron — yielding a count of **4**, which still escalates via the existing `availabilityImpactingUnhealthyCrons >= 2 → stale` branch.
2. The test seeds `{ match: "cache WHERE key IN", rows: [] }`, which makes `cacheUpdatedAtByKey` empty. All non-sentinel cache keys return `ageSeconds = null` → `ratio = Infinity` → `getCacheFreshnessStatus` returns `"stale"` → `cacheImpactStatus = "stale"`, which also escalates via the existing `cacheImpactStatus === "stale" → stale` branch.

Both branches are preserved by the Phase 2 semantic change and will still fire for this test. The assertion `expect(body.availabilityStatus).toBe("stale")` remains correct. **No edit is required.**

- [ ] **Step 1: Run the status suite as-is to confirm no regression**

```bash
cd worker && npx vitest run src/api/__tests__/status.test.ts --reporter=verbose
```

Expected: PASS with no changes to the test file.

- [ ] **Step 2: Grep to confirm no other `status.test.ts` assertion relies on a single critical-cron error producing `stale` via the cron-error path alone**

```bash
grep -n "availabilityStatus).toBe(\"stale\")" worker/src/api/__tests__/status.test.ts
```

Expected output: exactly two hits — line 1252 (the orphaned-in-flight test, covered above) and line 2111 (the DB-unavailable fallback test, unaffected because `buildDbUnavailableRawStatus` hardcodes `"stale"`). If the output contains other hits, inspect each and decide whether the new semantic changes the expected verdict. At plan time this audit was clean.

- [ ] **Step 3: No commit** (no file changes).

The new degraded semantic is already covered by unit tests in `worker/src/lib/__tests__/status-evaluation-state.test.ts` (Task 2.4). A redundant integration test in `status.test.ts` would not add coverage beyond those unit tests and would require fabricating a fully-populated cron + cache seed just to isolate the cron-error path.

### Task 2.8 — Update frontend consumer files to the new semantic

**Files:**
- Modify: `src/lib/status-dashboard-model.ts`
- Modify: `src/components/status/status-facts.tsx`
- Modify: `src/lib/__tests__/status-dashboard-model.test.ts`
- Modify: `src/app/admin/__tests__/client.test.tsx`

- [ ] **Step 1: Update `status-dashboard-model.ts` cron status derivation**

Anchored edit. `old_string`:

```ts
  const cronStatus =
    data.summary.availabilityImpactingCronErrors > 0
      ? 2
      : data.summary.availabilityImpactingUnhealthyCrons > 0
        ? 1
        : data.summary.degradedCrons > 0 || data.summary.watchUnhealthyCrons > 0
          ? 1
          : 0;
```

`new_string`:

```ts
  const cronStatus =
    data.summary.availabilityImpactingConsecutiveCronErrors > 0
      ? 2
      : data.summary.availabilityImpactingCronErrors > 0
        || data.summary.availabilityImpactingUnhealthyCrons > 0
        ? 1
        : data.summary.degradedCrons > 0 || data.summary.watchUnhealthyCrons > 0
          ? 1
          : 0;
```

- [ ] **Step 2: Update `status-facts.tsx` cron-errors card tone**

Anchored edit. `old_string`:

```tsx
    {
      label: "Cron Errors",
      value: `${summary.availabilityImpactingCronErrors}/${summary.cronErrors}`,
      tone: summary.availabilityImpactingCronErrors > 0
        ? "text-red-600 dark:text-red-400"
        : summary.cronErrors > 0
          ? "text-amber-600 dark:text-amber-400"
          : "text-green-600 dark:text-green-400",
    },
```

`new_string`:

```tsx
    {
      label: "Cron Errors",
      value: `${summary.availabilityImpactingCronErrors}/${summary.cronErrors}`,
      tone: summary.availabilityImpactingConsecutiveCronErrors > 0
        ? "text-red-600 dark:text-red-400"
        : summary.availabilityImpactingCronErrors > 0 || summary.cronErrors > 0
          ? "text-amber-600 dark:text-amber-400"
          : "text-green-600 dark:text-green-400",
    },
```

- [ ] **Step 3: Update frontend test fixtures to include the new counter**

For `src/lib/__tests__/status-dashboard-model.test.ts`: find every object literal inside `summary:` and add `availabilityImpactingConsecutiveCronErrors: 0,` in the appropriate spot (next to `availabilityImpactingCronErrors`). Each hit is a simple type-driven fix. Use the same pattern for `src/app/admin/__tests__/client.test.tsx`.

(If there are many fixtures, a find-and-replace is fine: for every `availabilityImpactingCronErrors: N,` line inside a summary literal, insert `availabilityImpactingConsecutiveCronErrors: 0,` on the line after. Do this per-file, not globally, to avoid matches outside summary literals.)

- [ ] **Step 4: Add a frontend regression test for the new semantic (optional but recommended)**

In `src/lib/__tests__/status-dashboard-model.test.ts`, add:

```ts
describe("cronStatus derivation", () => {
  it("uses amber (warning) tone for a single transient critical cron error", () => {
    const model = buildStatusDashboardModel({
      data: makeStatusResponse({
        summary: {
          ...makeSummaryBase(),
          availabilityImpactingCronErrors: 1,
          availabilityImpactingConsecutiveCronErrors: 0,
          cronErrors: 1,
        },
      }),
    });
    // cronStatus is 1 when only transient (not sustained)
    expect(model.sections.find((s) => s.id === "crons")?.priority).toBeLessThan(200);
  });

  it("uses red (critical) tone when consecutive-error counter is positive", () => {
    const model = buildStatusDashboardModel({
      data: makeStatusResponse({
        summary: {
          ...makeSummaryBase(),
          availabilityImpactingCronErrors: 1,
          availabilityImpactingConsecutiveCronErrors: 1,
          cronErrors: 1,
        },
      }),
    });
    expect(model.sections.find((s) => s.id === "crons")?.priority).toBeGreaterThanOrEqual(200);
  });
});
```

(If `buildStatusDashboardModel`, `makeStatusResponse`, or `makeSummaryBase` are not the actual export names in that test file, match the existing helpers before writing the test. The skeleton is there to show the intended shape — adapt to the file's conventions.)

- [ ] **Step 5: Run frontend tests and typecheck**

```bash
npm test -- --run src/lib/__tests__/status-dashboard-model.test.ts src/app/admin/__tests__/client.test.tsx
cd .. && npx tsc --noEmit   # note: from worker/, `..` is the repo root
```

Wait — path issue. If current directory is `worker/`, the frontend typecheck must be run from the repo root. Adjust:

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npx tsc --noEmit
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm test -- --run src/lib/__tests__/status-dashboard-model.test.ts src/app/admin/__tests__/client.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/status-dashboard-model.ts src/components/status/status-facts.tsx src/lib/__tests__/status-dashboard-model.test.ts src/app/admin/__tests__/client.test.tsx
git commit -m "fix(frontend/status): use consecutive-error streak for critical cron tone"
```

## Phase 3: documentation

### Task 3.1 — Extend `docs/status-dashboard.md`

**Files:**
- Modify: `docs/status-dashboard.md`

- [ ] **Step 1: Read the current file end to end**

```bash
cat docs/status-dashboard.md | head -80
cat docs/status-dashboard.md | sed -n '280,320p'
```

(Plan time verification confirmed only line 295 references `availabilityImpactingCronErrors`, and it is the schema-summary bullet, not an escalation rule. The change is an **addition**, not a replacement.)

- [ ] **Step 2: Anchored edit to extend the summary bullet**

`old_string`:

```
- `summary`: compact availability and diagnostics rollup (`unhealthyCrons`, `availabilityImpactingUnhealthyCrons`, `watchUnhealthyCrons`, `degradedCrons`, `cronErrors`, `availabilityImpactingCronErrors`, `diagnosticIssueCount`, `worstCacheRatio`)
```

`new_string`:

```
- `summary`: compact availability and diagnostics rollup (`unhealthyCrons`, `availabilityImpactingUnhealthyCrons`, `watchUnhealthyCrons`, `degradedCrons`, `cronErrors`, `availabilityImpactingCronErrors`, `availabilityImpactingConsecutiveCronErrors`, `diagnosticIssueCount`, `worstCacheRatio`)

### Cron error escalation

Availability escalation on cron errors follows a transient-vs-sustained split:

- A **single** transient failed run on an availability-critical cron (`sync-stablecoins`, `sync-fx-rates`, `sync-blacklist`, `sync-mint-burn`) surfaces as a `cron_error_runs` **warning** and sets `availabilityStatus` to `degraded`. This avoids flipping public state on rare upstream-caused single-sample flakes such as DefiLlama returning a truncated response body.
- **Two or more consecutive** failed runs on the same critical cron escalate to `stale` via `summary.availabilityImpactingConsecutiveCronErrors > 0`.
- Multiple critical crons simultaneously unhealthy (`summary.availabilityImpactingUnhealthyCrons >= 2`) also escalate to `stale`.
- Cache-age stale (`worstCacheRatio > STATUS_CACHE_RATIO_THRESHOLDS.stale`) and the `publicAvailabilityFloor` (circuit outages, mint/burn sync stale) paths remain unchanged.

```

- [ ] **Step 3: Commit**

```bash
git add docs/status-dashboard.md
git commit -m "docs(status-dashboard): document cron error escalation rule"
```

### Task 3.2 — Extend `docs/api-reference.md`

**Files:**
- Modify: `docs/api-reference.md`

- [ ] **Step 1: Update the sample payload**

`old_string`:

```
    "availabilityImpactingCronErrors": 0,
```

This line appears once at line ~2385 inside a `/api/status` response sample. Replace with:

`new_string`:

```
    "availabilityImpactingCronErrors": 0,
    "availabilityImpactingConsecutiveCronErrors": 0,
```

- [ ] **Step 2: Extend the prose description**

`old_string`:

```
`summary.availabilityImpactingUnhealthyCrons` and `summary.availabilityImpactingCronErrors` count only cron jobs tagged `statusImpact="critical"` in `shared/lib/cron-jobs.ts`. `summary.watchUnhealthyCrons` counts the watch-tier jobs that remain visible but do not degrade `availabilityStatus` on their own.
```

`new_string`:

```
`summary.availabilityImpactingUnhealthyCrons` and `summary.availabilityImpactingCronErrors` count only cron jobs tagged `statusImpact="critical"` in `shared/lib/cron-jobs.ts`. `summary.watchUnhealthyCrons` counts the watch-tier jobs that remain visible but do not degrade `availabilityStatus` on their own.

`summary.availabilityImpactingConsecutiveCronErrors` is the subset of `availabilityImpactingCronErrors` whose most recent 2+ runs are **all** `error`. A single transient critical-cron error increments `availabilityImpactingCronErrors` (and sets `availabilityStatus` to `degraded`), but only a `≥2`-consecutive streak increments `availabilityImpactingConsecutiveCronErrors` and escalates `availabilityStatus` to `stale`.
```

- [ ] **Step 3: Commit**

```bash
git add docs/api-reference.md
git commit -m "docs(api-reference): document availabilityImpactingConsecutiveCronErrors"
```

## Verification

### Task V.1 — Full test, lint, typecheck, build

- [ ] **Step 1: Lint (root)**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm run lint
```

Expected: PASS.

- [ ] **Step 2: Unit tests (root runs both frontend and worker under vitest)**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm test
```

Expected: PASS.

- [ ] **Step 3: Worker typecheck**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard/worker && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Frontend typecheck (implicit in build)**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm run build
```

Expected: PASS.

- [ ] **Step 5: Merge gate**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm run test:merge-gate
```

Expected: PASS.

### Task V.2 — Production observation (post-deploy)

- [ ] **Step 1: Confirm deploy**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard/worker && npx wrangler deployments list 2>&1 | head -15
```

Note the latest deployment timestamp.

- [ ] **Step 2: Watch the next :30 sync-stablecoins run**

Schedule an observation window around the next quarter-hourly :30 mark (or a retrospective query ≥15 min after the deploy):

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard/worker && npx wrangler d1 execute stablecoin-db --remote --json --command "SELECT datetime(started_at,'unixepoch') as at, duration_ms, status, substr(error,1,80) as err FROM cron_runs WHERE job='sync-stablecoins' AND started_at > (strftime('%s','now') - 7200) ORDER BY started_at DESC"
```

Expected: `sync-stablecoins` errors with "DefiLlama response body parse failed" should drop significantly. If any remain, they should have longer duration (because the retry path ran before the fallback throw).

- [ ] **Step 3: Check for new false transitions**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard/worker && npx wrangler d1 execute stablecoin-db --remote --json --command "SELECT id, datetime(created_at,'unixepoch') as at, previous_status, next_status, reason FROM status_transitions ORDER BY created_at DESC LIMIT 10"
```

Expected: no new transitions reasoned `raw-stale-immediate-escalation` attributable to a single `sync-stablecoins` error. If a transition does appear, correlate it with `cron_runs` to confirm either (a) the sync-stablecoins error was sustained (2+ consecutive), OR (b) some other cause (cache-age, mintBurn, etc).

- [ ] **Step 4: Admin dashboard spot check**

Visit `/admin` in the browser. Find the "Cron Errors" card on the status facts block. Verify that:
- If there's a recent single `sync-stablecoins` error in the last 15 min, the card renders **amber** (warning), not red (critical).
- The "Cron" dashboard section priority is 1 (`section.priority < 200`), not 2 (`>= 200`), under the same condition.

### Task V.3 — Rollback guidance

The plan produces the following ordered commits (each from Phase 1 or 2 above). Task 2.7 is a read-only verification task with no commit.

1. Phase 1: parse-retry test + implementation (2 commits — one for the failing tests, one for the implementation)
2. Task 2.5: summary + cron-health + shared/types bundled commit
3. Task 2.3: cron-health test file
4. Task 2.4: deriveAvailabilityStatus + unit tests
5. Task 2.6: cron_error_runs cause severity
6. Task 2.8: frontend consumer updates + fixtures
7. Task 3.1: docs/status-dashboard.md
8. Task 3.2: docs/api-reference.md

If **Phase 2** causes unexpected missed outages or UI inconsistencies, revert commits 2-6 (keep Phase 1 — it is independent and safe, and keep docs). If **Phase 1** causes unexpected runtime issues, revert only the Phase 1 commits. Keep commits 7-8 (docs) regardless.

```bash
git revert <commit-range>
npm run test:merge-gate
git push
```

**Do not force-push.** If the reverted tree fails merge-gate, fix forward.

## Risks and mitigations

1. **Delayed public escalation on sustained `sync-blacklist` outages.**
    Under Phase 2, a sustained `sync-blacklist` error takes ≥2 consecutive runs — i.e. ≥1h — before escalating availability to `stale`. Prior to this plan the escalation was immediate on a single error run.
    **Mitigation**: the dashboard still shows `degraded` with the `cron_error_runs` cause visible as a warning throughout the first failed run; operators see the signal instantly in `/status`. 1h to full public stale escalation is acceptable because the most recent blacklist data is still fresh (events are append-only, so stale-but-present data is safer than surfacing a pure red state on every flake).
    **Explicit non-mitigation**: this change does not add an independent staleness check for blacklist events (currently none exists). If operators want a stricter 15-min blacklist outage SLO, that is a separate future change outside the scope of this plan.

2. **Delayed public escalation on sustained `sync-mint-burn` outages.**
    `sync-mint-burn` has a secondary escalation path via `publicHealth.mintBurnImpactStatus` (see `public-health-assessment.ts:125-218`). That path evaluates mint/burn data freshness against the critical-lane cadence and is independent of the cron-error path.
    **Under Phase 2**: a single transient `sync-mint-burn` error → `degraded` via cron-error path. If the underlying mint/burn data stays fresh from a prior successful run, `mintBurnImpactStatus` stays `healthy`, so availability stays `degraded`. If the error is sustained, both paths eventually escalate: the consecutive-error path at 2 runs (40 min for a 20-minute cron) and the mint-burn freshness path when `sync.freshnessAgeSec` exceeds the freshness threshold.
    **Mitigation**: the two paths escalate on different evidence and together cover the outage space. A single transient mint-burn error is now correctly treated as a warning, not a full outage.

3. **Parse-retry adds wall-clock to the `:30` quarter-hourly slot.**
    Each retry costs up to `fetchWithRetry`'s per-call budget (≤15s per attempt, up to 2 internal HTTP retries on 429/529) plus the parse-retry delay (500ms + 1000ms = 1.5s for 2 retries). In the typical successful-after-one-retry case, the added wall-clock is ~1-2s. In the HTTP-failure tail where each of the 3 parse-retry attempts triggers `fetchWithRetry`'s own HTTP retries, worst-case wall-clock could reach ~15s per attempt × 3 = 45s.
    **Mitigation**: the quarter-hourly slot sequences `sync-fx-rates → sync-stablecoins → snapshot-supply → snapshot-chain-supply`. Current `sync-stablecoins` successful runtime is ~235s, with a budget of 30s CPU and wall-clock bounded by the slot's overall timeout. The extra ~1-2s typical (or ~45s worst case) stays comfortably under the budget. In the worst case, the existing slot-level timeout / abort signal cuts the retry short cleanly.

4. **The consecutive-error counter reads the same `cron_runs` data already loaded by `loadCronHealth`.**
    No new D1 query, no additional D1 pressure. If `cron_runs` reads fail transiently, `telemetryUnknown = true` and the counter returns 0 — same defensive behavior the existing code already has.

5. **Interaction with `skipped_locked` and `skipped_duplicate` statuses.**
    The streak counter looks for literal `status === 'error'`, so `skipped_*` runs break the streak. A locked-out run is not a genuine error, and a follow-up successful run already resets the streak in the existing healthy path. This is the intended behavior.

6. **New test file under `worker/src/lib/status/__tests__/`.**
    Directory does not currently exist; plan Task 2.3 Step 1 creates it explicitly via `mkdir -p` before writing. This is normal and not a risk.

## Success criteria

Primary:

- **Zero new status transitions** attributable to single transient `sync-stablecoins` errors over a 24h post-deploy observation window.
- **DefiLlama parse-retry log visible** in worker logs on the first occurrence of a transient parse failure — demonstrating the retry path engaged (`[sync-stablecoins] DL response body parse failed on attempt 1/3: …`).
- **Sustained outage detection still works**: 2+ consecutive errors in tests still flips availability to `stale`.
- **Admin UI consistent with API**: the "Cron Errors" card is amber (not red) on a single transient critical cron error; red only on sustained.

Secondary:

- `sync-stablecoins` error rate in `cron_runs` drops from ~6/24h to ≤1/24h (or zero).
- No regressions in existing status-related tests.
- Docs reflect the new semantic.

## Out of scope

- Investigating why DefiLlama's stablecoins endpoint returns malformed JSON at the :30 slot. Upstream concern; we only defend.
- Improving the CoinGecko fallback's `itemCount === 0` path. Separate, larger plan.
- Changing `STATUS_HYSTERESIS` constants.
- Adding an independent blacklist data-staleness check (currently none exists). Separate future change.
- Reverting Codex's sentinel work.
- Updating `docs/methodology.md` or changelog — reliability fix, not a methodology change.

## Review log

### Review 1 (2026-04-11, code-reviewer subagent)

Outcome: **12 medium-or-higher issues** (4 critical, 5 high, 3 medium, 7 low).

#### Critical (C1-C4)

- **C1**: existing `status-evaluation-state.test.ts:128` call to `deriveAvailabilityStatus` doesn't pass the new required field → fix applied in Task 2.4 Step 1 (explicit anchored edit).
- **C2**: `status.test.ts:1252` asserts `stale` on a single `sync-blacklist` error → fix applied in Task 2.7 Step 2 (explicit anchored rewrite to `degraded`).
- **C3**: frontend `src/lib/status-dashboard-model.ts:355-362` and `src/components/status/status-facts.tsx:143-150` hardcode `availabilityImpactingCronErrors > 0` as critical → fix applied in Task 2.8 Steps 1 & 2. Plan scope expanded to include both frontend files, their fixture test files, and a new frontend regression test.
- **C4**: Phase 2 cron-health test used a non-existent `makeDbStub` helper and didn't seed all critical crons → fix applied in Task 2.3 Step 1 (real `mockD1` usage, seeds all critical crons via `seedAllCronsOk` helper).

#### High (H1-H5)

- **H1**: plan deferred file-existence decisions → fix applied via "File inventory sanity check" section listing concrete facts verified at plan time. Test file locations: colocate parse tests in `worker/src/cron/__tests__/sync-stablecoins.test.ts`; create `worker/src/lib/status/__tests__/cron-health.test.ts`.
- **H2**: wrong mock path for a new test directory → fix: colocate in existing `worker/src/cron/__tests__/sync-stablecoins.test.ts` (Task 1.1 location). Existing mock path `../../lib/fetch-retry` stays correct.
- **H3**: lost HTTP status in error log → fix applied in Task 1.2 Step 2 (`lastHttpStatus` field on `DefillamaFetchResult`, included in both error log messages).
- **H4**: parse-retry helper didn't cancel partially-consumed response body between attempts → fix applied in Task 1.2 Step 2 (explicit `cancelResponseBodyQuietly(res)` in the catch block, plus import of `cancelResponseBodyQuietly` in Task 1.2 Step 1).
- **H5**: cron-health test assertions used ambiguous seeding → fix applied in Task 2.3 Step 1 with explicit `seedAllCronsOk` helper that pre-populates every `CRON_INTERVALS` entry with an `ok` run, and the test-specific `seedWithOverrides` adds the failing runs in front.

#### Medium (M1-M6)

- **M1**: `summary.availabilityImpactingConsecutiveCronErrors` not surfaced externally → fix: now explicitly added to `shared/types/status.ts` in Task 2.1, emitted by `computeRawStatus` in Task 2.5, and consumed by frontend in Task 2.8.
- **M2**: `docs/status-dashboard.md` doesn't contain the text the plan claimed to replace → fix: Task 3.1 reframed as an **addition** (new "Cron error escalation" sub-section after the summary bullet), not a replacement.
- **M3**: `docs/api-reference.md` not in original scope → fix: explicitly added in Task 3.2 with anchored edits to both the sample payload (line ~2385) and the prose description (line ~2524).
- **M4**: `sync-mint-burn` interaction under the new semantic not documented → fix applied in Risks section item 2 (explicit behavior under single vs sustained mint-burn errors).
- **M5**: wrong line range for phase 1 inline edit → fix: plan now uses anchored `old_string`/`new_string` blocks (Task 1.2 Step 3), not line numbers.
- **M6**: plan used line anchors for Phase 2 edits → fix: plan now uses anchored `old_string`/`new_string` blocks throughout (Tasks 2.1, 2.2, 2.4, 2.5, 2.6, 2.7, 3.1, 3.2).

#### Low (L1-L7)

- **L1**: confusing parenthetical about `sleepWithSignal`/`throwIfAborted` → fix: sanity-check section now states definitively that both are exported (line 8 + line 26 of `abort.ts`).
- **L2**: abort-mid-retry test accepted ambiguous outcome → fix: the plan no longer includes an explicit abort-mid-retry test (the three parse-retry tests in Task 1.1 cover the happy, exhaustion, and HTTP-error paths; abort propagation is implicitly covered by `throwIfAborted` inside the helper loop, already tested indirectly via the existing `syncStablecoins` abort tests in the same test file).
- **L3**: "total added wall-clock < 3s" claim undercounted the HTTP-retry tail → fix: Risks section item 3 now states explicit best case (~1-2s) and worst case (~45s) with the slot-level timeout/abort as mitigation.
- **L4**: inconsistent mocking target (fetch vs fetchWithRetry) → fix: all three tests in Task 1.1 mock `fetchWithRetryMock` explicitly, consistent with the rest of `sync-stablecoins.test.ts`.
- **L5**: `cron-health` test file existence risk → fix: promoted to a definitive "does not exist, plan creates it" statement in the File inventory sanity check section.
- **L6**: `datetime('unixepoch')` assumption on `status_transitions.created_at` → verified at plan time: production data query in Task V.2 uses the same expression and returns valid timestamps in the investigation output, so `created_at` is stored as epoch seconds. No fix required.
- **L7**: rollback mentioned "the two commits" → fix: Task V.3 now enumerates 9 concrete commits.

### Review 2 (2026-04-11, code-reviewer subagent)

Outcome: **3 medium-or-higher issues** (2 critical, 0 high, 1 medium, 3 low). Every Review 1 finding verified as resolved via file-by-file anchor verification.

#### Critical (C1-C2)

- **C1**: Plan's Task 2.7 proposed rewriting `status.test.ts:1252` assertion from `"stale"` to `"degraded"`, but the existing test seeds `cron_runs` with only a single sync-blacklist error row, leaving sync-stablecoins, sync-fx-rates, and sync-mint-burn with no runs at all. Under the new `deriveAvailabilityStatus`, both `availabilityImpactingUnhealthyCrons >= 2` (= 4) and `cacheImpactStatus === "stale"` (from empty cache seed) still fire, so the verdict stays `"stale"` and the proposed assertion rewrite would fail. Fix applied: Task 2.7 rewritten as a read-only verification task with no edits, since the existing assertion is still correct under the new semantic. The new cron-error semantic is already covered by unit tests in `worker/src/lib/__tests__/status-evaluation-state.test.ts` (Task 2.4).
- **C2**: Plan's Task 1.1 Test A used `fetchWithRetryMock.mockResolvedValueOnce(…).mockResolvedValueOnce(…).mockImplementation(…)` chaining to direct the first two calls to DL responses. But `loadStablecoinsIntake` starts `fetchSupplementalTrackedTokens` in parallel with DL fetching; the first actual `fetchWithRetry` call is typically a CoinGecko fetch, which would consume `throwingResponse()` and leave the DL parse-retry path unexercised. Additionally, `Object.assign(new Response(…), { json: …})` does NOT override the prototype method — native `Response.json()` still parses the response body. Fix applied: Test A now uses the same URL-dispatch `fetchWithRetryMock.mockImplementation(async (url) => { … })` pattern as Tests B and C, with a proper `makeThrowingResponse()` stub that fully overrides the Response shape (including `.json()` via a plain object rather than a native `Response` instance).

#### Medium (M1)

- **M1**: Review 1 log's C4/H5 fix claims referenced `seedAllCronsOk` helper, but the helper was defined and never called; `criticalJobs()` was also dead code. Fix applied: both dead helpers removed; `seedWithOverrides` is now the sole seed builder and pre-populates every `CRON_INTERVALS` entry with a 30s-old `"ok"` run by default, with a comment explaining why (so untouched jobs don't pollute `availabilityImpactingUnhealthyCrons` in the tests).

#### Low (L1-L3)

- **L1**: Task 2.3 was labeled "Failing unit tests for `loadCronHealth` streak counting" but Task 2.3 runs AFTER the implementation lands in Task 2.2. Fix applied: Task 2.3 relabeled to "Regression unit tests for `loadCronHealth` streak counting", and Step 2 header changed from "Run and verify failure" to "Run and verify pass" with updated expected-outcome text.
- **L2**: Task 2.7 said "the single" existing `"stale"` assertion but there are actually two (lines 1252 and 2111, the second being the DB-unavailable fallback). Fix applied: Task 2.7 Step 2 now explicitly lists both hits and notes that line 2111 is out of scope (hardcoded by `buildDbUnavailableRawStatus`).
- **L3**: Task 2.3 used a magic `NOW = 1_775_890_000` constant without explanation. Fix applied: added an inline comment above the constant declaration explaining it is a fixed epoch-seconds value for deterministic test assertions.

#### Anchor verification (Review 2)

Every `old_string` in the plan was verified against the live source file. All 12 anchors matched verbatim. No drift since Review 1.

### Review 3 (2026-04-11, code-reviewer subagent)

Outcome: **5 medium-or-higher issues** (4 critical, 1 medium, 5 low). Review 1's original 12 findings all verified still addressed.

#### Critical (C1-C4)

- **C1**: Parse-retry tests would hang under `vi.useFakeTimers()` (enabled in the test file's `beforeEach` at line 342). `sleepWithSignal` uses raw `setTimeout` and does not resolve under mocked timers. Fix applied: added `vi.useRealTimers();` at the top of both Test A and Test B (Test C does not exercise the retry loop so fake timers are fine for it).
- **C2**: `seedWithOverrides` helper left the default `ok` row in place after unshifting overrides, producing the wrong runs array order (`[error, ok, error, ok]` instead of `[error, error, ok]` for the streak tests). Fix applied: helper now clears the base entry for any job that appears in `overrides` via a `clearedForOverride` Set tracker, and uses `push` instead of `unshift` so callers supplying overrides in "most recent first" order produce correctly ordered lists.
- **C3**: Tests B and C called `mockFetch([...])(url)` inline inside the `fetchWithRetryMock.mockImplementation` closure. `mockFetch()` has a side effect — it calls `fetchWithRetryMock.mockImplementation()` internally and overwrites the test's custom router on the very first invocation. Fix applied: both Tests B and C now capture `const cgMockFetch = mockFetch([...])` once outside the closure and call `cgMockFetch(url)` directly, matching Test A's pattern.
- **C4**: Test A's `validPayload` had only 1 asset, below `MIN_VALID_ASSET_COUNT = 50`, which would cause the downstream validation in `intake.ts:121-129` to reject the payload and fall through to the fallback path regardless of whether the retry worked. Fix applied: Test A now reuses the existing `makeDlResponse(60)` helper from the same test file, which produces a 60-asset payload that passes the minimum.

#### Medium (M1)

- **M1**: Test A's `recordOutcome` assertion was too broad — asserting the mock was never called with `false` for ANY circuit source, including unrelated sources in enriched pricing paths. Fix applied: narrowed to `expect.anything(), CIRCUIT_SOURCE.DL_STABLECOINS, false`. Requires importing `CIRCUIT_SOURCE` from `../../lib/constants` in the test file — pre-req note added at the start of Task 1.1 Step 1.

#### Low (L1-L5)

- **L1**: Misleading comment about `Response.json()` override. Fix applied: rewrote the comment to state that `Object.assign` overrides DO work via own-property shadowing, and the stub approach is chosen for consistency with Test B.
- **L2**: Task 2.1 Step 2 and Task 2.5 Step 5 both listed `worker/src/api/__tests__/status.test.ts` as a file requiring type updates, but that file uses narrowing type assertions, not full summary literals, and would not produce TS errors when the new field is added. Fix applied: both step descriptions now explicitly call out this file as NOT needing type updates and list only the actual consumer files.
- **L3**: Task 2.3 Test 1 had a comment referencing the deleted `seedAllCronsOk` helper. Fix applied: rewrote the comment to reference the new `seedWithOverrides` base-pre-population and clearing behavior.
- **L4**: Task V.3 rollback guidance enumerated Task 2.7 as a separate commit, but Review 2's C1 fix made Task 2.7 a read-only verification with no commit. Fix applied: rollback ordering now lists 8 commits (not 9), with Task 2.7 explicitly noted as "no commit". Revert guidance updated to match the renumbered list.
- **L5** (bisect-safety): Review 3 flagged that the ordered commits aren't all bisect-safe (e.g. Task 2.3 commits a test referencing a field implemented in a commit bundled with Task 2.5, and Task 2.4 commits a signature change before Task 2.5 updates the call site). Accepted as-is — the plan executes correctly top-to-bottom; bisect-safety is nice to have but not required for merge-gate correctness. No fix applied; documented here as a known limitation.

#### Anchor verification (Review 3)

All `old_string` anchors still match their live source files. No drift.

### Review 4

(to be filled by review loop if needed)
