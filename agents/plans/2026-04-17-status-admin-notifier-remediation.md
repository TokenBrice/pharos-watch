# Status Notifier, /status Public Page, and /admin Dashboard — Remediation & Enhancement Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the three surfaces that together constitute Pharos's source-of-truth about its own operational state — the state-notifier backend (cron + state machine + discrepancy tracker), the public `/status` page (users + API consumers), and the private `/admin` dashboard (operator control board) — to a correct, informative, actionable, and maintainable baseline. Close correctness gaps that can silently under-report incidents, add the missing operator controls that today require SSH/wrangler, make staleness and divergence visible at a glance, and tighten code health without breaking the v5.x status-stability envelope.

**Architecture:** Three-layer stack — (a) **backend** (`worker/src/cron/status-self-check.ts`, `worker/src/lib/status-{evaluation,reliability*,state-store,probe-store,discrepancy-*}.ts`, `worker/src/api/{status,status-history,status-supplements,admin-actions}.ts`) persists a 3-state machine (`healthy ↔ degraded ↔ stale`) with hysteresis in `status_state` + audit log in `status_transitions` + per-run probe summary in `status_probe_runs` + divergence tracker in `status_discrepancy_state`; (b) **public surface** (`src/app/status/`, `src/components/status/public-*`, `src/lib/status/public-status.ts`) consumes `/api/health` and `/api/public-status-history`; (c) **private dashboard** (`src/app/admin/`, `src/app/admin/sections/*`, `src/lib/status-dashboard-model.ts`, `src/lib/status/action-recommendations.ts`) consumes `/api/status`, `/api/status-history`, `/api/probes`, `/api/request-source-stats`. We preserve the 3-state machine, hysteresis policy, cron schedule (`*/15 * * * *`), and overall component layout. We fix correctness in probe classification + state reconciliation + admin auth, add five new operator controls (lease reset, breaker reset, in-flight kill, bulk candidate dismiss, admin audit log), make freshness + divergence first-class on both pages, and split oversized files into focused modules.

**Tech Stack:** TypeScript, Cloudflare Workers, D1 (SQLite), Next.js 16 static export, TanStack Query, Tailwind, shadcn/ui, Vitest. `@shared/*` maps to `shared/*` (runtime-neutral). Root TS config excludes `worker/` — worker has its own `tsc --noEmit`.

---

## Audit Summary (context for tasks)

### Critical correctness gaps (backend)

1. **/api/health semantic failures escape probe classification.** In `probePathInternally` / `probePathExternally` → `evaluateProbeResponse`, when `/api/health` returns 200 with unparseable JSON (`"invalid-health-payload"`) or an unknown `status` value (`"invalid-health-status"`), the probe sets `ok: false` but does **not** set `semanticStatus`. `classifyProbeStatus` allows `failCount <= 1 && p95 <= 5000` to return `"healthy"`. A corrupted `/api/health` therefore shows as 1 failure amongst ~50 passing probes → overall `probeStatus = healthy`. The discrepancy detector (which compares probe vs effective) then does not flag it. (`worker/src/cron/status-self-check.ts:146-181, 123-128, 344-351`)

2. **Race between cron and API both calling `reconcileStatusState`.** `handleStatus` (`worker/src/api/status.ts:41-58`) calls `reconcileStatusState` whenever `staleness.isStale` is true (snapshot older than `STATUS_SYSTEM_FRESHNESS_SEC = 1800s`). The `status-self-check` cron also calls `reconcileStatusState` every 15 min. When a stale snapshot plus a cron fire overlap, both read the same row, compute independently, and second write wins — the losing side's counters and transition are silently dropped. (`worker/src/api/status.ts:41-58`, `worker/src/lib/status-state-store.ts:24-245`, `worker/src/cron/status-self-check.ts:381-385`)

3. **No CSRF/origin check on admin mutation endpoints.** `makeAdminRoute` validates CF Access JWT or `trustedAdmin` but does not require a custom header or `Origin` check. A CF Access session cookie in the browser + a cross-site `fetch()` with `credentials: "include"` against `ops-api.pharos.watch` would succeed. Current controls: CORS (restricted origin list) + `Idempotency-Key` header (discoverable, no secret). (`worker/src/api/admin-actions.ts:26-89`, `worker/src/lib/route-wrappers.ts`, `src/components/status/admin-action-button.tsx:44-66`)

4. **`buildFallbackStatusState` on missed persistence can mask transitions.** When `persistStatusStateAtomically` fails on the seed path (`worker/src/lib/status-state-store.ts:125-132`), a transient `state` is returned with `buildFallbackStatusState(rawStatus, now)`, but no transition row is written. On the next successful cron, `current` exists but the initial "init" transition never happened, so the timeline begins at the first post-failure reconcile — the bootstrap "init" transition is lost. Update path correctly preserves `current` state when persist fails (line 230-237), so the race is scoped to first-ever seed.

### High-severity correctness gaps (frontend)

5. **Admin page has no section-level error boundaries.** Any `null` dereference in `OverviewSection`, `PipelineSection`, `ReliabilitySection`, `CronsSection`, `ControlSection`, or `HistorySection` crashes the entire page. (`src/app/admin/client.tsx:191-253`, only a page-level `error.tsx` exists)

6. **`discrepancyReason` enum is missing from `StatusDiscrepancy`.** UI renders `details: string | null` which mixes "probe stale", "probe disagrees", and "probe-missing" in human-readable text; operators cannot condition alerts or UX on the failure mode. (`shared/types/status.ts:115-123`)

### Informativeness / UX gaps (both pages)

7. **Public `/status` freshness is buried.** `lastUpdated` appears only in small hero-footer metadata; no relative "X ago"; no timezone-offset indicator (`toLocaleString` with `timeZoneName: 'short'` produces ambiguous labels like "IST"). (`src/app/status/client.tsx:79-80`, `src/components/status/public-status-hero.tsx:192-193`, `src/lib/status-dashboard-model.ts:154-162`)

8. **Public `/status` does not highlight `healthData.status` vs `probeSummary.status` divergence.** Admin page surfaces `healthDiffersFromStatus` in a notice; public page treats them as parallel tiles without a conflict callout. (`src/app/status/client.tsx:139-147`)

9. **Cache freshness table does not show which upstream provider each cache depends on.** Operators cannot immediately map "binance-tickers" cache freshness to "Binance is down". (`src/components/status/cache-freshness-table.tsx`, `shared/types/status.ts:6-28`)

10. **"Recovery hold — raw degraded" label is cryptic to first-time operators.** Needs a hover tooltip explaining min-dwell. (`src/app/admin/client.tsx:276-279`)

11. **Admin top-fold shows only `topCauses.slice(0, 3)` with no "show more".** During multi-layer incidents, the 4th/5th blockers are only visible inside the expanded sections. (`src/app/admin/client.tsx:335-355`, `src/lib/status-dashboard-model.ts:279`)

12. **Cron in-flight progress is text-only.** No visual bar. (`src/components/status/cron-card.tsx:58-85`)

13. **`useSyncExternalStore` hydration gate is overkill for a check that simply reads `window.location.hostname`.** Causes a null render → real render flicker on load. Fallback UX is correct but path could be simpler. (`src/app/admin/client.tsx:47-51`)

### Operator controls gap (admin page)

14. **No UI control to reset a stuck cron lease** (`cron_leases` table). Today operators must `wrangler d1 execute`.

15. **No UI control to reset an open circuit breaker.** Today operators must wait the breaker's recovery window or `wrangler d1 execute`.

16. **No UI control to kill a stale in-flight cron run.** Today operators wait for lease timeout.

17. **No bulk-dismiss for discovery candidates.** `ControlSection` only supports per-candidate dismiss via modal.

18. **No persisted admin action audit log.** Action history in the UI is ephemeral (client state only); after page reload the record of "who did what, when" is lost unless it's in Cloudflare request logs.

### Observability gaps

19. **Rich per-probe failure data is logged into `status_probe_runs.details_json` but no API exposes it.** No `/api/status/probe-history?path=X&days=N` endpoint to inspect specific endpoint reliability over time.

20. **Hardcoded latency thresholds (`5000` / `8000` ms) live in `status-self-check.ts` — not in `shared/lib/status-thresholds.ts`.** Drifting these silently re-classifies production performance. (`worker/src/cron/status-self-check.ts:123-128`)

21. **`StatusCause` codes have no runbook link.** Operators must search docs manually. (`shared/types/status.ts:68-76`)

22. **Confidence score (0.1–1.0) has no UI tooltip or doc reference.** (`shared/types/status.ts:427`)

### Code health / maintainability

23. **`src/app/admin/client.tsx` = 402 LOC with `StatusDashboard` as a 302-line inline component.** Mixes auth gating, data fetching, state derivation, sorting logic, layout.

24. **`src/lib/status-dashboard-model.ts` = 484 LOC** with both public-page helpers (`buildBrowserProbeSummary`, `formatTimestampSeconds`) and admin-only derivations (`buildStatusDashboardData`, section priority/ordering).

25. **Duplicated client-side severity class strings** in `admin-actions-panel.tsx`, `recommended-action-strip.tsx` — `getSeverityBadgeClass` (already in `status-dashboard-model.ts:173`) should be used everywhere.

26. **Missing section tests.** Only `src/app/admin/__tests__/client.test.tsx` exists. No tests for `OverviewSection`, `PipelineSection`, `ReliabilitySection`, `CronsSection`, `ControlSection`, `HistorySection`.

27. **No tests for public-status derivation helpers.** `getPublicWorstCacheSummary`, `getImpactedPublicSurfaces`, `getPublicMintBurnStatus` (`src/lib/status/public-status.ts`) have no unit tests.

28. **`decideNextStatus` hardcodes `counters.stale >= 2` (`worker/src/lib/status-reliability-decision.ts:25`)** instead of using `policy.escalateToStale` for the degraded→stale transition. Behaviourally consistent with current policy but the inconsistency invites bugs if the policy is tuned.

### Performance / schema

29. **`computeRawStatus` sequential D1 loads.** `assessPublicHealth`, `loadCronHealth`, `getDataQuality`, `loadSupplementalStatusSections`, `countRecentStatusTransitions` run in sequence (`worker/src/lib/status-evaluation.ts:133-225`). Most are independent.

30. **`handleStatus` issues 1–2 D1 reads before writing.** `getStatusStateSnapshot` reads `status_state`; if stale, `reconcileStatusState` reads it again. Can be merged.

31. **`status_probe_runs` has no `created_at` index confirmed in a migration.** Append-only table with 15-min write cadence → ~35k rows/year. Without an index, `getLatestStatusProbe` relies on `ORDER BY created_at DESC LIMIT 1` against an unindexed column if the baseline didn't include one.

32. **No TTL/archival for `status_probe_runs`.** Unbounded growth.

### Healthy patterns (MUST preserve)

- 3-state machine with hysteresis (`escalateToDegraded=2`, `escalateToStale=1`, `recoverToDegraded=2`, `recoverToHealthy=3`, `minDwellSec=120`, `staleMinDwellSec=180`). Do not adjust these numbers as part of this plan.
- `NOT_STORE` caching on `/api/status` (freshness is non-negotiable for operator).
- Public-impact circuit filtering via `isPublicImpactCircuitKey` — public `/status` only shows user-visible breakers.
- `deriveStatusActionRecommendations` cause→action + cron→action mapping.
- `useAutoExpand` pattern for operator-relevant sections.
- Zod validation on `HealthResponse` + `CircuitRecord`.
- Lease-coordinated crons (`runLeasedCron`) preventing self-overlap.
- `cancelResponseBodyQuietly` cleanup for internal router probes.
- `Idempotency-Key` discipline on mutating admin actions.

---

## File Structure

### New files
- `worker/src/api/admin-reset-circuit-breaker.ts` — Task 9 (endpoint).
- `worker/src/api/admin-reset-cron-lease.ts` — Task 8 (endpoint).
- `worker/src/api/admin-kill-cron-in-flight.ts` — Task 10 (endpoint).
- `worker/src/api/admin-bulk-dismiss-discovery-candidates.ts` — Task 11 (endpoint).
- `worker/src/api/admin-action-log.ts` — Task 12 (GET read endpoint).
- `worker/src/api/status-probe-history.ts` — Task 17 (endpoint).
- `worker/src/lib/admin-action-audit.ts` — Task 12 (persistence helper).
- `worker/migrations/0098_admin_action_audit_log.sql` — Task 12 (schema).
- ~~`worker/migrations/0099_status_probe_runs_created_at_index.sql`~~ — Task 22 is a **no-op**; index already in baseline. No new file.
- `src/app/admin/status-dashboard.tsx` — Task 19 (extracted component).
- `src/app/admin/cron-severity.ts` — Task 19 (extracted helper).
- `src/app/admin/section-error-boundary.tsx` — Task 6 (error boundary).
- `src/lib/status/admin-status-model.ts` — Task 20 (split target).
- `src/lib/status/status-formatting.ts` — Task 20 (split target).
- ~~`src/lib/__tests__/status/public-status.test.ts`~~ — Tasks 15/26 instead **extend** the existing `src/lib/__tests__/public-status.test.ts`. No new test file.
- `src/app/admin/sections/__tests__/overview-section.test.tsx` — Task 25 (new).
- `src/app/admin/sections/__tests__/reliability-section.test.tsx` — Task 25 (new).
- `src/app/admin/sections/__tests__/crons-section.test.tsx` — Task 25 (new).
- `src/app/admin/sections/__tests__/control-section.test.tsx` — Task 25 (new).
- `worker/src/lib/__tests__/status-state-store-race.test.ts` — Task 2 (new).
- `src/components/status/freshness-indicator.tsx` — Task 13 (new UI primitive).
- `src/components/status/cron-in-flight-progress.tsx` — Task 16 (new).

### Modified files (by task)
- Task 1: `worker/src/cron/status-self-check.ts`, `worker/src/cron/__tests__/status-self-check.test.ts`
- Task 2: `worker/src/api/status.ts`, `worker/src/lib/status-state-store.ts`, `worker/src/api/__tests__/status.test.ts`
- Task 3: `worker/src/lib/route-wrappers.ts`, `worker/src/api/__tests__/admin-actions.test.ts`, `src/components/status/admin-action-button.tsx`
- Task 4: `shared/types/status.ts`, `worker/src/lib/status-discrepancy-view.ts`, `worker/src/lib/__tests__/status-discrepancy-view.test.ts`
- Task 5: `worker/src/lib/status-reliability-shared.ts`, `worker/src/lib/status-reliability-decision.ts`, `worker/src/lib/__tests__/status-reliability.test.ts`
- Task 6: `src/app/admin/client.tsx`
- Task 7: `shared/lib/status-thresholds.ts`, `worker/src/cron/status-self-check.ts`, tests
- Task 8–12: control-section + endpoints as above
- Task 13: `src/components/status/public-status-hero.tsx`, `src/app/status/client.tsx`
- Task 14: `shared/types/status.ts`, `worker/src/lib/public-health-assessment.ts` (adds upstream attribution)
- Task 15: `src/components/status/cache-freshness-table.tsx` + new column
- Task 16: `src/components/status/cron-card.tsx`
- Task 17: `worker/src/api/status-probe-history.ts`, `worker/src/router.ts`, `src/hooks/use-probe-history.ts`
- Task 18: `shared/types/status.ts`, `worker/src/lib/status/evaluation-causes.ts`, `src/components/status/recommended-action-strip.tsx`
- Task 19: split admin client.tsx
- Task 20: split status-dashboard-model.ts
- Task 21: `src/components/status/admin-actions-panel.tsx`, `src/components/status/recommended-action-strip.tsx`
- Task 22: migration
- Task 23: `worker/src/lib/status-evaluation.ts` (parallelization)
- Task 24: `worker/src/api/status.ts` (merge read+write)
- Task 25–26: tests
- Task 27: TTL cron
- Task 28: final docs + methodology bump

---

## Execution notes

- **Branch strategy:** One feature branch `feat/status-admin-notifier-remediation`. Commit per task. Do NOT squash — per-task commits are the review unit.
- **Test execution:** Root `npm test` for frontend; `cd worker && npx vitest run <file>` for targeted worker runs; `npm test` from root also runs worker via project references.
- **Type-check:** After every task touching worker code, run `cd worker && npx tsc --noEmit`. After every task touching frontend code, run `npx tsc --noEmit` from root.
- **Pre-push:** `npm run test:merge-gate` before opening PR.
- **Docs:** `docs/architecture.md`, `docs/api-reference.md`, and `docs/worker-and-api-limits.md` may need touch-ups; the final task bundles doc updates. `/methodology` does NOT apply here (no PegScore/DEWS/LiquidityScore change).
- **Phase ordering:**
  - **Phase 1 — Correctness** (Tasks 1–5). Must land first. Each independently deployable.
  - **Phase 2 — Operator controls** (Tasks 6–12). Phase 1 must be merged for the new audit table migration to deploy safely.
  - **Phase 3 — Informativeness & UX** (Tasks 13–18).
  - **Phase 4 — Code health** (Tasks 19–21, 25–26). Tasks 19 and 20 are strictly ordered (20 after 19 to reduce merge conflicts).
  - **Phase 5 — Performance & schema** (Tasks 22–24, 27).
  - **Phase 6 — Docs & methodology close-out** (Task 28).
- **Concurrency note:** Task 2 removes the API's `reconcileStatusState` call. Downstream: `/api/status` will serve a stale snapshot up to `STATUS_SYSTEM_FRESHNESS_SEC` (30 min) after a cron miss; staleness is already surfaced via `staleness.isStale`. This is the intended semantic — API must not mutate state.
- **Per-task dependency flags** are called out inline in each task.

---

# PHASE 1 — Correctness fixes

---

## Task 1: /api/health semantic failures must be classified as stale

**Files:**
- Modify: `worker/src/cron/status-self-check.ts` (`evaluateProbeResponse`, lines 146-181)
- Test: `worker/src/cron/__tests__/status-self-check.test.ts` (new `describe("health probe semantic classification")` block)

**Context:** When `/api/health` returns HTTP 200 but the body is invalid (unparseable JSON or unknown `status` value), `evaluateProbeResponse` currently returns `{ok: false, error: "invalid-health-payload"}` or `{ok: false, error: "invalid-health-status"}` with `semanticStatus` unset. `classifyProbeStatus` then tolerates ≤1 connectivity failure → `probeStatus` resolves to `healthy`. The discrepancy detector compares `effectiveStatus` to `probeStatus`, so a silent corruption of the health endpoint is invisible. Fix: when the health endpoint is semantically broken, set `semanticStatus: "stale"`. The `maxProbeStatus` reduction over `semanticProbeStatus` then forces the overall `probeStatus` to at least `stale`, triggering the discrepancy path reliably.

- [ ] **Step 1: Write the failing test** in `worker/src/cron/__tests__/status-self-check.test.ts` (create the block if absent):

```typescript
import { describe, it, expect } from "vitest";
import { runStatusSelfCheck } from "../status-self-check";

// Re-use any existing D1 mock factory used in this file. If none exists,
// the block below duplicates the minimal mock already present in other
// tests in this directory.
function makeResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("health probe semantic classification", () => {
  it("classifies invalid-health-payload (unparseable JSON) as stale semantic status", async () => {
    // Wire the test's existing fetch-mock so ONLY /api/health returns
    // a 200 response with corrupt body; all other paths return 200 OK.
    // All other setup (stateful DB mock, etc.) follows the in-file pattern.
    const probes = await captureProbesWithHealthBody("not-json");
    const health = probes.find((p) => p.path === "/api/health")!;
    expect(health.ok).toBe(false);
    expect(health.semanticStatus).toBe("stale");
  });

  it("classifies invalid-health-status (unknown status value) as stale", async () => {
    const probes = await captureProbesWithHealthBody({ status: "weird" });
    const health = probes.find((p) => p.path === "/api/health")!;
    expect(health.ok).toBe(false);
    expect(health.semanticStatus).toBe("stale");
  });

  it("forces overall probeStatus to at least stale when health endpoint semantically broken", async () => {
    const result = await runWithHealthBody("not-json");
    const metadata = JSON.parse(result.metadata!);
    expect(metadata.probeStatus).not.toBe("healthy");
  });
});
```

`captureProbesWithHealthBody` and `runWithHealthBody` are thin wrappers around the test's existing self-check invocation; write them following the pattern already present in the file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd worker && npx vitest run src/cron/__tests__/status-self-check.test.ts`
Expected: FAIL on `semanticStatus` assertion (undefined instead of "stale").

- [ ] **Step 3: Update `evaluateProbeResponse`** — change the two invalid branches to set `semanticStatus: "stale"`:

```typescript
    return {
      ok: false,
      error: "invalid-health-status",
      semanticStatus: "stale",
    };
  } catch { /* degraded: health endpoint returned unparseable JSON */
    return {
      ok: false,
      error: "invalid-health-payload",
      semanticStatus: "stale",
    };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run src/cron/__tests__/status-self-check.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check and full worker test run**

Run: `cd worker && npx tsc --noEmit && npx vitest run`

- [ ] **Step 6: Commit**

```bash
git add worker/src/cron/status-self-check.ts worker/src/cron/__tests__/status-self-check.test.ts
git commit -m "fix(status): classify invalid /api/health responses as semantic stale"
```

---

## Task 2: Remove race — `handleStatus` must not call `reconcileStatusState`

**Files:**
- Modify: `worker/src/api/status.ts` (lines 41-58)
- Modify: `worker/src/lib/status-state-store.ts` (add `hasStatusState(db)` helper)
- Test: `worker/src/api/__tests__/status.test.ts` (new block asserting handleStatus is read-only w.r.t. state)
- Test: `worker/src/lib/__tests__/status-state-store-race.test.ts` (new — concurrent-write scenario)

**Context:** `handleStatus` reads `status_state`; if the row is stale (older than 30 min) or absent, it calls `reconcileStatusState` with freshly-computed raw. Meanwhile `runStatusSelfCheck` runs every 15 min and calls `reconcileStatusState` through `evaluateStatusAndPersist`. Overlapping events = same row read by two writers = last-write-wins = at-most-one logged transition. The cron is the authoritative writer — the API must be strictly read-only to maintain a truthful audit log. If the snapshot is absent (first boot), return a fallback synthesised from the just-computed raw; do NOT persist. The next cron will seed. If the snapshot is stale, return it with `staleness.isStale = true` so the operator sees the lag clearly.

- [ ] **Step 1: Write the failing race test** at `worker/src/lib/__tests__/status-state-store-race.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { reconcileStatusState } from "../status-state-store";

// `makeStatefulDb` is a stateful D1 mock used by several status tests in this
// directory. Before writing the test, audit its export status:
//   Grep(pattern="makeStatefulDb", path="worker/src/lib/__tests__")
// If it's already exported from a shared helper, import it. If it's defined
// privately inside `status-reliability.test.ts`, DO extract it to a new shared
// file `worker/src/lib/__tests__/_helpers/stateful-d1.ts` as a prerequisite
// step — inline-copying a 100+ LOC mock is a maintenance hazard.

describe("reconcileStatusState concurrency (regression)", () => {
  it("does not skip transitions when two callers reconcile simultaneously against the same row", async () => {
    const db = makeStatefulDb({
      seed: {
        scope: "global",
        current_status: "healthy",
        raw_status: "healthy",
        last_evaluated_at: 1000,
        last_changed_at: 1000,
        consecutive_healthy: 5,
        consecutive_degraded: 0,
        consecutive_stale: 0,
        confidence: 0.9,
        causes_json: "[]",
      },
    });
    // Simulate two in-flight calls that should both see the seed and both
    // try to write; at most one will win, but both must be observable via
    // the persisted state (no transition loss for the winning write).
    const [a, b] = await Promise.all([
      reconcileStatusState(db, 2000, "degraded", 0.8, []),
      reconcileStatusState(db, 2000, "degraded", 0.8, []),
    ]);
    // At least one must report persistenceSucceeded; transition count in
    // the timeline must equal the number of genuine state changes, never
    // two "healthy -> degraded" transitions for the same effective event.
    const persistedOk = [a, b].filter((r) => r.persistenceSucceeded).length;
    expect(persistedOk).toBeGreaterThanOrEqual(1);
    const transitions = await db.prepare(
      "SELECT previous_status, next_status FROM status_transitions ORDER BY id"
    ).all<{ previous_status: string; next_status: string }>();
    const degradations = transitions.results.filter(
      (t) => t.previous_status === "healthy" && t.next_status === "degraded"
    );
    expect(degradations.length).toBeLessThanOrEqual(1);
  });
});
```

This test documents the invariant. With the current implementation the test may pass in a deterministic single-threaded D1 mock because `Promise.all` with sync-mock `db.batch` serialises. **Its primary value is regression protection: after Task 2, the API no longer races the cron, and if anyone re-introduces a second writer path, this test plus the read-only test below fail fast.**

- [ ] **Step 2: Write the read-only-API test** at `worker/src/api/__tests__/status.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { handleStatus } from "../status";
import * as stateStore from "../../lib/status-state-store";

describe("handleStatus — read-only w.r.t. status_state", () => {
  it("does not call reconcileStatusState even when snapshot is stale", async () => {
    const reconcileSpy = vi.spyOn(stateStore, "reconcileStatusState");
    // Arrange a db mock whose getStatusStateSnapshot returns
    // staleness.isStale = true. Existing test file already has the
    // handleStatus invocation scaffolding; reuse it.
    await handleStatus(staleSnapshotDb, /*trustedAdmin*/ true);
    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it("returns staleness.isStale = true when snapshot is stale without writing", async () => {
    const response = await handleStatus(staleSnapshotDb, /*trustedAdmin*/ true);
    const body = await response.json() as { staleness: { isStale: boolean } };
    expect(body.staleness.isStale).toBe(true);
  });

  it("returns fallback state when snapshot is absent (first boot), without writing", async () => {
    const reconcileSpy = vi.spyOn(stateStore, "reconcileStatusState");
    const response = await handleStatus(emptyStatusStateDb, /*trustedAdmin*/ true);
    const body = await response.json() as {
      state: { currentStatus: string };
      staleness: { isStale: boolean };
    };
    expect(reconcileSpy).not.toHaveBeenCalled();
    // rawOverallStatus drives fallback currentStatus
    expect(["healthy", "degraded", "stale"]).toContain(body.state.currentStatus);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd worker && npx vitest run src/api/__tests__/status.test.ts src/lib/__tests__/status-state-store-race.test.ts`
Expected: FAIL on read-only assertions (currently `reconcileStatusState` IS called from `handleStatus`).

- [ ] **Step 4: Modify `handleStatus`** — replace lines 41-58 with a read-only snapshot path:

```typescript
      const { state, staleness } = await getStatusStateSnapshot(db, now, collectPersistenceIssue);
      // Intentionally read-only: the cron (status-self-check, */15 min) is the
      // sole writer. If the snapshot is stale or absent, we return it as-is
      // with `staleness.isStale` reflecting the lag. This removes the prior
      // race with the cron's own reconcile call. First-boot with empty table
      // returns a fallback state but does NOT persist — the next cron seeds.
      const resolvedState = state ?? buildFallbackStatusState(raw.rawOverallStatus, now);
      const resolvedStaleness = staleness ?? {
        ageSeconds: 0,
        maxAgeSec: STATUS_SYSTEM_FRESHNESS_SEC,
        isStale: false,
      };
```

Then use `resolvedState` / `resolvedStaleness` in the response body construction (replacing the existing `state` / `staleness` references in lines 83-88). Remove the `let` mutation pattern.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd worker && npx vitest run src/api/__tests__/status.test.ts src/lib/__tests__/status-state-store-race.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify downstream** — `handleStatus` no longer imports `reconcileStatusState`. Remove the now-unused import if applicable; keep `buildFallbackStatusState` and `STATUS_SYSTEM_FRESHNESS_SEC` imports.

Run: `cd worker && npx tsc --noEmit`

- [ ] **Step 7: Run full worker test suite to catch any integration tests that relied on the removed side effect**

Run: `cd worker && npx vitest run`

- [ ] **Step 8: Commit**

```bash
git add worker/src/api/status.ts worker/src/api/__tests__/status.test.ts worker/src/lib/__tests__/status-state-store-race.test.ts
git commit -m "fix(status): make /api/status read-only w.r.t. status_state (remove race with cron)"
```

---

## Task 3: CSRF-style origin lock on admin mutation endpoints

**Files:**
- Modify: `worker/src/lib/route-wrappers.ts` (add per-mutation header check in `makeAdminRoute`)
- Modify: `src/components/status/admin-action-button.tsx` (add required custom header on all mutating calls)
- Modify: `src/lib/admin-access.ts` if that's where the fetch helpers live
- Test: `worker/src/api/__tests__/admin-actions.test.ts` (new `describe("admin mutation auth — custom header")` block)

**Context:** CF Access authenticates the caller as the operator; it does not authenticate the page that initiated the fetch. A compromised browser extension or a malicious cross-origin page with the operator's CF Access cookie could POST to `ops-api.pharos.watch/api/admin/*`. The defense is either a rotating CSRF token (heavy) or a custom header + strict CORS (light; effective because browsers will not add a non-simple header on cross-origin fetch without a preflight, and the preflight returns CORS failure for non-allowed origins). We add `X-Pharos-Admin: 1` as a required header on every mutating admin call and reject without it at the wrapper level. Safe methods (`GET`) do not require the header.

- [ ] **Step 1: Write the failing wrapper test** at `worker/src/api/__tests__/admin-actions.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { handleResetBlacklistSync } from "../admin-actions";

describe("admin mutation auth — custom header required for mutating methods", () => {
  it("rejects POST without X-Pharos-Admin header", async () => {
    const req = new Request("https://ops-api.pharos.watch/api/reset-blacklist-sync", {
      method: "POST",
      headers: { "Idempotency-Key": "t1" },
    });
    const res = await handleResetBlacklistSync({ db: mockDb, request: req, trustedAdmin: true });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/admin header/i);
  });

  it("accepts POST with X-Pharos-Admin: 1", async () => {
    const req = new Request("https://ops-api.pharos.watch/api/reset-blacklist-sync", {
      method: "POST",
      headers: { "Idempotency-Key": "t2", "X-Pharos-Admin": "1" },
    });
    const res = await handleResetBlacklistSync({ db: mockDb, request: req, trustedAdmin: true });
    expect(res.status).toBe(200);
  });

  it("does not require header on GET admin endpoints", async () => {
    const req = new Request("https://ops-api.pharos.watch/api/debug-sync-state", {
      method: "GET",
    });
    // Route handler call matches existing GET admin test pattern.
    const res = await callDebugSyncStateHandler(req);
    expect(res.status).not.toBe(403);
  });
});
```

- [ ] **Step 2: Run to verify failures**

Run: `cd worker && npx vitest run src/api/__tests__/admin-actions.test.ts`

- [ ] **Step 3: Modify `runAdminRoute`** in `worker/src/lib/route-wrappers.ts:20-32`. Insert the gate as the FIRST check inside `withErrorHandler`, before `withAdmin` auth resolution. This keeps the error message narrow (a missing-header rejection is not an auth failure) and applies uniformly whether the caller is `trustedAdmin: true` or CF-Access-authed:

```typescript
// worker/src/lib/route-wrappers.ts — inside runAdminRoute, before withAdmin(...)
const method = options.request?.method?.toUpperCase() ?? "GET";
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
if (MUTATING.has(method) && options.request?.headers.get("X-Pharos-Admin") !== "1") {
  return jsonResponse(
    { error: "Missing required X-Pharos-Admin header; refusing mutation." },
    { status: 403, noStore: true },
  );
}
```

**Trusted-admin callers:** `probePathInternally` (`worker/src/cron/status-self-check.ts:244`) uses `trustedAdmin: true` but issues GETs only — no regression. Search for any other `trustedAdmin: true` + mutating-method call site before shipping; if found, add the header to that internal call.

- [ ] **Step 4: Update every client-side admin fetch to include the header.** The repo has **two** families of admin mutation callers:
  - `src/components/status/admin-action-button.tsx` — generic action dispatcher (the main one).
  - Any bespoke `fetch("/api/admin/...", { method: "POST" })` calls in admin section files: search with `Grep(pattern="fetch\\(.*admin", path="src/", output_mode="files_with_matches")` before shipping; likely zero today, but re-check. If a bespoke caller exists (candidate: discovery-candidate dismiss modal), add the header there too.

  ```typescript
  headers.set("X-Pharos-Admin", "1");
  headers.set(
    "Idempotency-Key",
    // existing code …
  );
  ```

- [ ] **Step 5: CORS allow-headers update.** The CORS response builder lives at `worker/src/handlers/http/cors.ts`. Open it, find the `Access-Control-Allow-Headers` value, add `X-Pharos-Admin` to the list (alphabetical or co-located with `Idempotency-Key`). Update any existing CORS test assertion: `worker/src/__tests__/index.fetch.test.ts` has an assertion on the allow-headers string — bring it in sync in the same commit to keep merge gate green.

- [ ] **Step 6: Run tests**

Run: `cd worker && npx vitest run src/api/__tests__/admin-actions.test.ts`
Expected: PASS.

- [ ] **Step 7: Type-check**

Run: `cd worker && npx tsc --noEmit`
Run: `npx tsc --noEmit` (root)

- [ ] **Step 8: Commit**

```bash
git add worker/src/lib/route-wrappers.ts worker/src/api/__tests__/admin-actions.test.ts src/components/status/admin-action-button.tsx worker/src/lib/<cors-file>
git commit -m "feat(admin): require X-Pharos-Admin header on mutating admin endpoints (CSRF hardening)"
```

---

## Task 4: Add `discrepancyReason` enum to `StatusDiscrepancy`

**Files:**
- Modify: `shared/types/status.ts` (extend `StatusDiscrepancy` + Zod if present)
- Modify: `worker/src/lib/status-discrepancy-view.ts` (populate `discrepancyReason`)
- Test: `worker/src/lib/__tests__/status-discrepancy-view.test.ts` (extend or add)
- Modify: `src/components/status/system-diagnostics.tsx` (surface the new enum)

**Context:** The frontend renders `discrepancy.details: string | null` but cannot condition UX on the failure mode. Adding `discrepancyReason: "probe-stale" | "probe-disagrees" | "probe-missing" | "in-sync"` lets operators filter notices, lets tests assert the reason rather than the human string, and lets the public `/status` page future-proof a reason-specific callout (Task 15).

**Implementation note:** `buildDiscrepancy` (`worker/src/lib/status-discrepancy-view.ts:17-27`) has an early return when `probe.status === "unknown" || probe.timestamp == null`. That branch must also populate `discrepancyReason: "probe-missing"`. The remaining branch uses `STATUS_SYSTEM_FRESHNESS_SEC` (already imported at the top of the file) as the freshness window — do NOT introduce a second `PROBE_STALE_WINDOW_SEC` constant; reuse the existing one so `hasDivergence` and `discrepancyReason` stay in lockstep.

- [ ] **Step 1: Extend the type**

```typescript
// shared/types/status.ts (near the StatusDiscrepancy interface)
export type StatusDiscrepancyReason = "in-sync" | "probe-stale" | "probe-disagrees" | "probe-missing";

export interface StatusDiscrepancy {
  hasDivergence: boolean;
  severityDelta: number;
  statusSeverity: number;
  probeSeverity: number;
  details: string | null;
  probeAgeSeconds: number | null;
  consecutiveDivergent: number;
  /**
   * Machine-readable classification. UI and alert logic should branch on
   * this enum rather than parsing `details`. Added 2026-04 to disambiguate
   * "probe never ran" from "probe ran but disagrees" from "probe is stale".
   */
  discrepancyReason: StatusDiscrepancyReason;
}
```

- [ ] **Step 2: Write the failing test** at `worker/src/lib/__tests__/status-discrepancy-view.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildDiscrepancy } from "../status-discrepancy-view";

describe("buildDiscrepancy — discrepancyReason", () => {
  it("returns in-sync when severities match and probe is fresh", () => {
    const d = buildDiscrepancy(
      "healthy",
      { timestamp: 1000, status: "healthy", sampleCount: 50, passCount: 50, failCount: 0, p95LatencyMs: 100 },
      1010,
      0,
    );
    expect(d.discrepancyReason).toBe("in-sync");
  });

  it("returns probe-missing when probe.timestamp is null", () => {
    const d = buildDiscrepancy("healthy", { timestamp: null, status: "unknown", sampleCount: 0, passCount: 0, failCount: 0, p95LatencyMs: null }, 1010, 0);
    expect(d.discrepancyReason).toBe("probe-missing");
  });

  it("returns probe-stale when probe age exceeds STATUS_SYSTEM_FRESHNESS_SEC (1800s)", () => {
    // probe.timestamp = 1000, now = 1000 + 1801 → age = 1801 > 1800
    const d = buildDiscrepancy("healthy", { timestamp: 1000, status: "healthy", sampleCount: 50, passCount: 50, failCount: 0, p95LatencyMs: 100 }, 1000 + 1801, 0);
    expect(d.discrepancyReason).toBe("probe-stale");
  });

  it("returns probe-disagrees when both sides are fresh but severity differs", () => {
    const d = buildDiscrepancy("healthy", { timestamp: 1000, status: "degraded", sampleCount: 50, passCount: 40, failCount: 10, p95LatencyMs: 1000 }, 1010, 1);
    expect(d.discrepancyReason).toBe("probe-disagrees");
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd worker && npx vitest run src/lib/__tests__/status-discrepancy-view.test.ts`

- [ ] **Step 4: Implement** — open `worker/src/lib/status-discrepancy-view.ts` and modify `buildDiscrepancy` (lines 11-45) so both branches populate `discrepancyReason`. Reuse the existing `STATUS_SYSTEM_FRESHNESS_SEC` import (line 7) — no new constant.

```typescript
export function buildDiscrepancy(
  overallStatus: StatusLevel,
  probe: StatusProbeSummary,
  now: number,
  consecutiveDivergent: number,
): StatusDiscrepancy {
  // Probe absent / never ran / unknown → "probe-missing".
  if (probe.status === "unknown" || probe.timestamp == null) {
    return {
      hasDivergence: false,
      severityDelta: 0,
      statusSeverity: SEVERITY[overallStatus],
      probeSeverity: -1,
      details: null,
      probeAgeSeconds: null,
      consecutiveDivergent,
      discrepancyReason: "probe-missing",
    };
  }

  const probeAgeSeconds = Math.max(0, now - probe.timestamp);
  const statusSeverity = SEVERITY[overallStatus];
  const probeSeverity = SEVERITY[probe.status];
  const severityDelta = statusSeverity - probeSeverity;
  // Reuse the same freshness window that gates hasDivergence, so the two
  // fields stay in lockstep. See STATUS_SYSTEM_FRESHNESS_SEC import.
  const freshProbe = probeAgeSeconds <= STATUS_SYSTEM_FRESHNESS_SEC;
  const hasDivergence = freshProbe && Math.abs(severityDelta) >= 1;

  const discrepancyReason: StatusDiscrepancyReason = !freshProbe
    ? "probe-stale"
    : hasDivergence
      ? "probe-disagrees"
      : "in-sync";

  return {
    hasDivergence,
    severityDelta,
    statusSeverity,
    probeSeverity,
    details: hasDivergence ? `status=${overallStatus}, probe=${probe.status}, probeAge=${probeAgeSeconds}s` : null,
    probeAgeSeconds,
    consecutiveDivergent,
    discrepancyReason,
  };
}
```

- [ ] **Step 5: Frontend usage** — in `src/components/status/system-diagnostics.tsx` (or whichever component renders the discrepancy), switch on `discrepancy.discrepancyReason` to produce a tailored microcopy alongside the existing `details` string. Do NOT remove `details` — it is still the human sentence.

- [ ] **Step 6: Type-check**

Run: `cd worker && npx tsc --noEmit && npx vitest run src/lib/__tests__/status-discrepancy-view.test.ts`
Run: `npx tsc --noEmit` (root)
Run: `npm test` (root — should cover any frontend unit tests).

- [ ] **Step 7: Commit**

```bash
git add shared/types/status.ts worker/src/lib/status-discrepancy-view.ts worker/src/lib/__tests__/status-discrepancy-view.test.ts src/components/status/system-diagnostics.tsx
git commit -m "feat(status): add discrepancyReason enum to StatusDiscrepancy"
```

---

## Task 5: Name the degraded→stale threshold

**Files:**
- Modify: `worker/src/lib/status-reliability-shared.ts` (add export)
- Modify: `worker/src/lib/status-reliability-decision.ts` (line 25)
- Modify: `worker/src/lib/__tests__/status-reliability.test.ts` (new assertion)

**Context:** Line 25 of `status-reliability-decision.ts` hardcodes `counters.stale >= 2`, while the healthy→stale path (line 19) uses `policy.escalateToStale`. The asymmetry is intentional (stricter when already degraded — prevents flap-through) but undocumented. We preserve the behavior exactly — the literal `2` stays, default policy is unchanged — and simply name the constant so the intent is legible to future readers.

- [ ] **Step 1: Export the constant** from `worker/src/lib/status-reliability-shared.ts`:

```typescript
/**
 * Consecutive-stale readings required to transition degraded → stale.
 * Intentionally stricter than `STATUS_HYSTERESIS.escalateToStale` (the
 * healthy → stale path). Rationale: once the system has already acknowledged
 * degradation, we want two consecutive stale samples before escalating,
 * preventing flap-through from a single noisy probe.
 */
export const STATUS_DEGRADED_TO_STALE_THRESHOLD = 2 as const;
```

- [ ] **Step 2: Write the test**

```typescript
// worker/src/lib/__tests__/status-reliability.test.ts
import { STATUS_DEGRADED_TO_STALE_THRESHOLD, STATUS_HYSTERESIS } from "../status-reliability-shared";
import { decideNextStatus } from "../status-reliability-decision";

it("degraded → stale transition respects STATUS_DEGRADED_TO_STALE_THRESHOLD", () => {
  const counterBelow = { healthy: 0, degraded: 0, stale: STATUS_DEGRADED_TO_STALE_THRESHOLD - 1 };
  const counterAt = { healthy: 0, degraded: 0, stale: STATUS_DEGRADED_TO_STALE_THRESHOLD };
  expect(decideNextStatus("degraded", "stale", counterBelow, 500, STATUS_HYSTERESIS).changed).toBe(false);
  expect(decideNextStatus("degraded", "stale", counterAt, 500, STATUS_HYSTERESIS).changed).toBe(true);
});
```

- [ ] **Step 3: Replace the literal** on `worker/src/lib/status-reliability-decision.ts:25`:

```typescript
import { STATUS_DEGRADED_TO_STALE_THRESHOLD } from "./status-reliability-shared";
// …
  if (current === "degraded" && raw === "stale" && counters.stale >= STATUS_DEGRADED_TO_STALE_THRESHOLD) {
    return { next: "stale", changed: true, reason: "raw-stale-consecutive-threshold" };
  }
```

- [ ] **Step 4: Run tests**

Run: `cd worker && npx vitest run src/lib/__tests__/status-reliability.test.ts`
Expected: PASS. All prior reliability tests remain green — behavior is unchanged, only naming.

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/status-reliability-decision.ts worker/src/lib/status-reliability-shared.ts worker/src/lib/__tests__/status-reliability.test.ts
git commit -m "refactor(status): name STATUS_DEGRADED_TO_STALE_THRESHOLD"
```

---

# PHASE 2 — Operator controls

> **Ordering note:** Tasks 8–11 reference `logAdminAction` from Task 12. Two safe sequences:
> 1. **Preferred:** land Task 12 first, then Tasks 8–11 in any order. This is the default assumed by the code snippets below.
> 2. **Alternative:** if Task 12 slips, add a no-op stub to the top of `worker/src/lib/admin-action-audit.ts` (`export async function logAdminAction() { /* stub — replaced by Task 12 */ }`) so Tasks 8–11 compile and ship independently. Task 12 replaces the stub with the real implementation.
> Both sequences produce identical final state. Do NOT land Tasks 8–11 with an unresolved `logAdminAction` import.

---

## Task 6: Section-level error boundaries in `/admin`

**Files:**
- Create: `src/app/admin/section-error-boundary.tsx`
- Modify: `src/app/admin/client.tsx` (wrap each `sectionNodes` entry)
- Test: `src/app/admin/__tests__/section-error-boundary.test.tsx` (new)

**Context:** Today any section component that throws takes down the entire admin page (the top-level `error.tsx` catches it but shows a generic page error). With a section boundary, a crash in `CronsSection` leaves the rest of the operator view intact — including recommended actions they need during an incident.

- [ ] **Step 1: Write the component**

```tsx
// src/app/admin/section-error-boundary.tsx
"use client";

import { Component, type ReactNode } from "react";

interface SectionErrorBoundaryProps {
  section: string;
  children: ReactNode;
}

interface SectionErrorBoundaryState {
  error: Error | null;
}

export class SectionErrorBoundary extends Component<SectionErrorBoundaryProps, SectionErrorBoundaryState> {
  state: SectionErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): SectionErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    // Observability hook: Cloudflare Pages does not run this code, so this
    // only captures client-side logs. Keep minimal to avoid PII leakage.
    console.error(`[admin] section "${this.props.section}" crashed:`, error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <section
          role="alert"
          aria-live="polite"
          className="rounded-2xl border border-red-500/30 bg-red-500/10 p-6 text-red-700 shadow-[0_10px_32px_oklch(0_0_0_/0.12)] dark:text-red-300"
        >
          <div className="text-sm font-semibold">Section failed to render: {this.props.section}</div>
          <p className="mt-2 text-sm leading-relaxed">
            {this.state.error.message}
          </p>
          <p className="mt-2 text-xs text-red-700/80 dark:text-red-300/80">
            Other sections continue to work. Refresh or sign out if the issue persists.
          </p>
        </section>
      );
    }
    return this.props.children;
  }
}
```

- [ ] **Step 2: Write the failing test** at `src/app/admin/__tests__/section-error-boundary.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SectionErrorBoundary } from "../section-error-boundary";

function Bomb(): JSX.Element {
  throw new Error("boom");
}

describe("SectionErrorBoundary", () => {
  it("renders children when no error", () => {
    render(
      <SectionErrorBoundary section="overview">
        <div>child-ok</div>
      </SectionErrorBoundary>
    );
    expect(screen.getByText("child-ok")).toBeInTheDocument();
  });

  it("renders fallback with section name and error message on crash", () => {
    const originalError = console.error;
    console.error = () => undefined; // silence jsdom's default error spam
    try {
      render(
        <SectionErrorBoundary section="crons">
          <Bomb />
        </SectionErrorBoundary>
      );
      expect(screen.getByRole("alert")).toHaveTextContent("Section failed to render: crons");
      expect(screen.getByRole("alert")).toHaveTextContent("boom");
    } finally {
      console.error = originalError;
    }
  });
});
```

- [ ] **Step 3: Run tests to verify they pass once the component exists**

Run: `npm test -- src/app/admin/__tests__/section-error-boundary.test.tsx`

- [ ] **Step 4: Wire into `admin/client.tsx`** — wrap each section node:

```tsx
import { SectionErrorBoundary } from "./section-error-boundary";

// In sectionNodes (lines 191-253), wrap each entry:
overview: (
  <SectionErrorBoundary section="overview">
    <OverviewSection {/* existing props */} />
  </SectionErrorBoundary>
),
pipeline: (
  <SectionErrorBoundary section="pipeline">
    <PipelineSection {/* existing props */} />
  </SectionErrorBoundary>
),
// …same for reliability, crons, control, history.
```

- [ ] **Step 5: Run the existing admin client test**

Run: `npm test -- src/app/admin/__tests__/client.test.tsx`
Expected: PASS (no behavior change on happy path).

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`

- [ ] **Step 7: Commit**

```bash
git add src/app/admin/section-error-boundary.tsx src/app/admin/__tests__/section-error-boundary.test.tsx src/app/admin/client.tsx
git commit -m "feat(admin): per-section error boundaries"
```

---

## Task 7: Move hardcoded latency thresholds to `shared/lib/status-thresholds.ts`

**Files:**
- Modify: `shared/lib/status-thresholds.ts` (add constants)
- Modify: `worker/src/cron/status-self-check.ts` (use imports)
- Modify: `worker/src/cron/__tests__/status-self-check.test.ts` (assert threshold via import not literal)

**Context:** Probe classification thresholds (`5000ms` healthy p95 ceiling, `8000ms` degraded p95 ceiling, `10%` degraded fail-ratio cap) are latency/quality SLOs and belong in `shared/lib/status-thresholds.ts` alongside the cache thresholds already there. Co-locating makes threshold drift visible in one place and unlocks future tuning via a single PR.

- [ ] **Step 1: Add to `shared/lib/status-thresholds.ts`**:

```typescript
export const STATUS_PROBE_THRESHOLDS = {
  /** p95 latency (ms) at or below which probes are classified healthy (given fail cap). */
  healthyP95MaxMs: 5000,
  /** p95 latency (ms) at or below which probes are classified degraded (given fail ratio cap). */
  degradedP95MaxMs: 8000,
  /** Max failures tolerated for "healthy" classification (absolute). */
  healthyMaxFailCount: 1,
  /** Max fail ratio tolerated for "degraded" classification (fraction of sample). */
  degradedMaxFailRatio: 0.1,
} as const;
```

- [ ] **Step 2: Write the failing test** (or adapt existing) in `worker/src/cron/__tests__/status-self-check.test.ts`:

```typescript
import { STATUS_PROBE_THRESHOLDS } from "@shared/lib/status-thresholds";

it("classifyProbeStatus reflects STATUS_PROBE_THRESHOLDS", () => {
  // If classifyProbeStatus is not currently exported, export it for testing.
  expect(classifyProbeStatus(10, 0, STATUS_PROBE_THRESHOLDS.healthyP95MaxMs)).toBe("healthy");
  expect(classifyProbeStatus(10, 0, STATUS_PROBE_THRESHOLDS.healthyP95MaxMs + 1)).toBe("degraded");
  expect(classifyProbeStatus(10, 1, STATUS_PROBE_THRESHOLDS.healthyP95MaxMs)).toBe("healthy"); // healthyMaxFailCount
  expect(classifyProbeStatus(10, 2, STATUS_PROBE_THRESHOLDS.degradedP95MaxMs)).toBe("degraded"); // 2/10 == 20% > 10%? depends on flooring
});
```

Adjust assertions so they clearly reflect the constants — the point is to lock the link, not re-test the math.

- [ ] **Step 3: Export `classifyProbeStatus` from the cron module** (currently module-private). Add `export` to the `function classifyProbeStatus` at line 123.

- [ ] **Step 4: Replace literals in `classifyProbeStatus`**:

```typescript
import { STATUS_PROBE_THRESHOLDS } from "@shared/lib/status-thresholds";

function classifyProbeStatus(sampleCount: number, failCount: number, p95LatencyMs: number): StatusLevel {
  if (sampleCount === 0) return "stale";
  const { healthyMaxFailCount, healthyP95MaxMs, degradedMaxFailRatio, degradedP95MaxMs } = STATUS_PROBE_THRESHOLDS;
  if (failCount <= healthyMaxFailCount && p95LatencyMs <= healthyP95MaxMs) return "healthy";
  const degradedFailCap = Math.max(healthyMaxFailCount, Math.floor(sampleCount * degradedMaxFailRatio));
  if (failCount <= degradedFailCap && p95LatencyMs <= degradedP95MaxMs) return "degraded";
  return "stale";
}
```

- [ ] **Step 5: Run tests + type-check**

Run: `cd worker && npx vitest run src/cron/__tests__/status-self-check.test.ts && npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add shared/lib/status-thresholds.ts worker/src/cron/status-self-check.ts worker/src/cron/__tests__/status-self-check.test.ts
git commit -m "refactor(status): move probe classification thresholds to shared/lib/status-thresholds.ts"
```

---

## Task 8: Operator control — Reset cron lease (endpoint + UI button)

**Files:**
- Create: `worker/src/api/admin-reset-cron-lease.ts`
- Modify: `worker/src/router.ts` (wire the new endpoint)
- Modify: `shared/lib/api-endpoints.ts` (add to `StatusPageAction`s if that's the registry path) — **OR** expose via a new inline card in `control-section.tsx` if the action registry isn't the right fit for per-cron actions.
- Test: `worker/src/api/__tests__/admin-reset-cron-lease.test.ts` (new)
- Modify: `src/app/admin/sections/crons-section.tsx` (add per-cron "Reset lease" button for crons with `recentRuns` showing `skipped_locked`)

**Context:** When a cron's lease row in `cron_leases` remains held after a worker restart / crash / isolate timeout, subsequent schedules report `skipped_locked` and the job is effectively stuck. Today the fix is `wrangler d1 execute stablecoin-db --command "DELETE FROM cron_leases WHERE job_id = '<job>'"`. We add a UI button on crons showing ≥2 consecutive `skipped_locked` runs.

Confirm the `cron_leases` table exists and whether the primary key is `job_id` or `job`. If absent, this task becomes "not applicable — remove from plan and document reason in audit" — don't fabricate a table.

- [ ] **Step 1: Confirm schema.** Grep:

```
Grep(pattern="cron_leases", path="worker/migrations")
Grep(pattern="cron_leases", path="worker/src")
```

Note the exact column name for the job key. Assume `job` for this plan; swap to actual if different.

- [ ] **Step 2: Write the failing test** at `worker/src/api/__tests__/admin-reset-cron-lease.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { handleResetCronLease } from "../admin-reset-cron-lease";

describe("handleResetCronLease", () => {
  it("deletes the lease row for the named job and returns the row count", async () => {
    const { db, seed } = makeDbWithLease("sync-mint-burn");
    const url = new URL("https://ops-api.pharos.watch/api/reset-cron-lease?job=sync-mint-burn");
    const req = new Request(url, { method: "POST", headers: { "X-Pharos-Admin": "1", "Idempotency-Key": "t1" } });
    const res = await handleResetCronLease({ db, url, request: req, trustedAdmin: true });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; cleared: number };
    expect(body.ok).toBe(true);
    expect(body.cleared).toBe(1);
    // Sanity: row is gone
    const row = await db.prepare("SELECT * FROM cron_leases WHERE job = ?").bind("sync-mint-burn").first();
    expect(row).toBeNull();
  });

  it("rejects missing job param with 400", async () => {
    const url = new URL("https://ops-api.pharos.watch/api/reset-cron-lease");
    const req = new Request(url, { method: "POST", headers: { "X-Pharos-Admin": "1" } });
    const res = await handleResetCronLease({ db: mockDb, url, request: req, trustedAdmin: true });
    expect(res.status).toBe(400);
  });

  it("accepts whitelist of job names only (guard against free-text SQL injection attempts)", async () => {
    const url = new URL("https://ops-api.pharos.watch/api/reset-cron-lease?job='; DROP TABLE;--");
    const req = new Request(url, { method: "POST", headers: { "X-Pharos-Admin": "1" } });
    const res = await handleResetCronLease({ db: mockDb, url, request: req, trustedAdmin: true });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 3: Implement the endpoint**

```typescript
// worker/src/api/admin-reset-cron-lease.ts
import { makeIdempotentAdminRoute } from "../lib/route-wrappers";
import { jsonResponse } from "../lib/api-utils";
import { CRON_JOB_DEFINITIONS } from "@shared/lib/cron-jobs";
import { logAdminAction } from "../lib/admin-action-audit"; // from Task 12. See Phase 2 intro note for ordering.

interface AdminRouteContext {
  db: D1Database;
  url: URL;
  request: Request;
  trustedAdmin: boolean;
}

const VALID_JOB_IDS = new Set(CRON_JOB_DEFINITIONS.map((def) => def.job));

export const handleResetCronLease = makeIdempotentAdminRoute<AdminRouteContext>(
  "route-reset-cron-lease",
  "reset-cron-lease",
  async ({ db, url, request }) => {
    const job = url.searchParams.get("job")?.trim();
    if (!job) {
      return jsonResponse({ error: "Missing required query param: job" }, { status: 400, noStore: true });
    }
    if (!VALID_JOB_IDS.has(job)) {
      return jsonResponse({ error: `Unknown cron job: ${job}` }, { status: 400, noStore: true });
    }
    const result = await db.prepare("DELETE FROM cron_leases WHERE job = ?").bind(job).run();
    const cleared = result.meta?.changes ?? 0;
    await logAdminAction(db, { action: "reset-cron-lease", target: job, result: "ok", details: { cleared } }, request);
    return jsonResponse({ ok: true, cleared }, { status: 200, noStore: true });
  },
);
```

- [ ] **Step 4: Wire the route** in `worker/src/router.ts` — find the existing admin route wiring (grep for `reset-blacklist-sync` to locate the block) and add a sibling entry for `/api/reset-cron-lease` matching only `POST`.

- [ ] **Step 5: Frontend — add the button.** In `src/app/admin/sections/crons-section.tsx` (or a shared `CronCard`), conditionally render a small "Reset lease" button when the cron has `recentRuns` with `status === "skipped_locked"` for ≥2 consecutive entries AND the cron is on the list where lease-reset is a sensible remediation. Use `AdminActionButton` with a dynamically-built `StatusPageAction` or a new variant component that takes a callable fetch — whichever is cleaner.

Simplest path: a thin wrapper component `CronLeaseResetButton` that calls `fetch("/api/reset-cron-lease?job=<job>", { method: "POST", headers: { "X-Pharos-Admin": "1", "Idempotency-Key": crypto.randomUUID() } })` with a confirmation modal.

- [ ] **Step 6: Tests + type-check + commit**

```bash
cd worker && npx vitest run src/api/__tests__/admin-reset-cron-lease.test.ts && npx tsc --noEmit
npm test
git add worker/src/api/admin-reset-cron-lease.ts worker/src/router.ts worker/src/api/__tests__/admin-reset-cron-lease.test.ts src/app/admin/sections/crons-section.tsx src/components/status/<new or modified files>
git commit -m "feat(admin): reset stuck cron leases from the UI"
```

---

## Task 9: Operator control — Reset circuit breaker (endpoint + UI button)

**Files:**
- Create: `worker/src/api/admin-reset-circuit-breaker.ts`
- Modify: `worker/src/router.ts`
- Test: `worker/src/api/__tests__/admin-reset-circuit-breaker.test.ts` (new)
- Modify: `src/components/status/circuit-breaker-table.tsx` (add "Reset" button on open/half-open rows, admin path only)

**Context:** Breaker state is stored in the cache table used by `public-health-assessment`. Today, an opened breaker must wait its full recovery window (or be cleared by hand). We add a narrow endpoint that takes a `circuit` query param (whitelisted) and clears the record. The circuit-breaker-table is currently used on BOTH `/status` (public) and `/admin` — wrap the reset button in a conditional so it renders only when the consumer is the admin variant. Easiest: pass an `onReset?: (circuit: string) => void` prop, absent = no button.

- [ ] **Step 1: Confirm where breaker state is persisted** (grep for `circuits` key in `setCache` / `putCircuitState`). Assume the storage mechanism is `db-cache` with key prefix `circuit:`. If different, adjust the `DELETE` to match the real table.

- [ ] **Step 2: Write the failing test:**

```typescript
// worker/src/api/__tests__/admin-reset-circuit-breaker.test.ts
it("deletes the cached circuit record and returns 200", async () => {
  const { db } = await seedCircuit("binance-tickers", { state: "open", consecutiveFailures: 10 });
  const url = new URL("https://ops-api.pharos.watch/api/reset-circuit-breaker?circuit=binance-tickers");
  const req = new Request(url, { method: "POST", headers: { "X-Pharos-Admin": "1", "Idempotency-Key": "t1" } });
  const res = await handleResetCircuitBreaker({ db, url, request: req, trustedAdmin: true });
  expect(res.status).toBe(200);
  const reread = await readCircuit(db, "binance-tickers");
  expect(reread).toBeNull();
});
```

- [ ] **Step 3: Implement** — structurally parallel to Task 8. Use `makeIdempotentAdminRoute<AdminRouteContext>("route-reset-circuit-breaker", "reset-circuit-breaker", …)`. Enumerate allowed circuit names from wherever the circuit source registry lives (search `CIRCUIT_SOURCE` in `worker/src/lib/` to locate the enum/const). Whitelist-only. Call `logAdminAction` on success.

- [ ] **Step 4: Frontend prop** — add `onReset?: (circuit: string) => Promise<void>` to `CircuitBreakerTable`; render a small "Reset" button next to each open/half-open row only when `onReset` is provided. On `/status` (public), the caller omits the prop → no button. On admin's Reliability section, the caller provides it.

- [ ] **Step 5: Tests + type-check + commit**

```bash
git add worker/src/api/admin-reset-circuit-breaker.ts worker/src/router.ts worker/src/api/__tests__/admin-reset-circuit-breaker.test.ts src/components/status/circuit-breaker-table.tsx src/app/admin/sections/reliability-section.tsx
git commit -m "feat(admin): reset open circuit breakers from the UI"
```

---

## Task 10: Operator control — Kill stale in-flight cron

**Files:**
- Create: `worker/src/api/admin-kill-cron-in-flight.ts`
- Modify: `worker/src/router.ts`
- Test: new
- Modify: `src/components/status/cron-card.tsx` (button only visible when `inFlight.stale === true`)

**Context:** When a cron is recorded with `inFlight.stale === true` (heartbeat exceeded the expected-interval bound in `cron-health` logic), the job row is presumed hung. Killing it clears the `cron_run_progress` and `cron_leases` rows for that job. Structural parallel to Task 8.

**Schema confirmed (2026-04-17):** `worker/migrations/0000_baseline.sql:320-345` defines `cron_leases(job PRIMARY KEY, lease_owner, lease_until, heartbeat_at, updated_at)` and `cron_run_progress(job PRIMARY KEY, started_at, updated_at, stage, items_done, items_total, message, lease_owner, metadata)`. Both tables key on `job`, both store `lease_owner` so the lease-match guard applies to both.

- [ ] **Step 1: (Skip — schema verified above.)**

- [ ] **Step 2: Implement** with `makeIdempotentAdminRoute<AdminRouteContext>("route-kill-cron-in-flight", "kill-cron-in-flight", …)` and a lease-match guard (kill only the specific `leaseOwner` observed from the status payload; prevents racing a legitimate replacement):

```typescript
// Query contract: POST /api/kill-cron-in-flight?job=X&leaseOwner=Y
// Both required; leaseOwner guard prevents racing a legitimate replacement.
const job = url.searchParams.get("job")?.trim();
const leaseOwner = url.searchParams.get("leaseOwner")?.trim();
if (!job || !leaseOwner) {
  return jsonResponse({ error: "Missing required params: job, leaseOwner" }, { status: 400, noStore: true });
}
if (!VALID_JOB_IDS.has(job)) {
  return jsonResponse({ error: `Unknown cron job: ${job}` }, { status: 400, noStore: true });
}
// Conditional delete: only if the stored lease_owner matches.
const result = await db
  .prepare("DELETE FROM cron_leases WHERE job = ? AND lease_owner = ?")
  .bind(job, leaseOwner)
  .run();
const cleared = result.meta?.changes ?? 0;
if (cleared === 0) {
  await logAdminAction(db, { action: "kill-cron-in-flight", target: job, result: "error", details: { leaseOwner, reason: "lease-owner-mismatch-or-absent" } }, request);
  return jsonResponse({ error: "Lease owner no longer matches or lease already released." }, { status: 409, noStore: true });
}
// Also clear the in-flight progress row — same lease-owner guard.
await db.prepare("DELETE FROM cron_run_progress WHERE job = ? AND lease_owner = ?").bind(job, leaseOwner).run();
await logAdminAction(db, { action: "kill-cron-in-flight", target: job, result: "ok", details: { leaseOwner, cleared } }, request);
return jsonResponse({ ok: true, cleared }, { status: 200, noStore: true });
```

- [ ] **Step 3: Test** both paths:

```typescript
it("kills the in-flight run when lease_owner matches", async () => {
  const { db } = await seedInFlightCron(db, "sync-mint-burn", { leaseOwner: "worker-abc" });
  const url = new URL("https://ops-api.pharos.watch/api/kill-cron-in-flight?job=sync-mint-burn&leaseOwner=worker-abc");
  const req = new Request(url, { method: "POST", headers: { "X-Pharos-Admin": "1", "Idempotency-Key": "t1" } });
  const res = await handleKillCronInFlight({ db, url, request: req, trustedAdmin: true });
  expect(res.status).toBe(200);
});

it("returns 409 when lease_owner does not match (race with replacement)", async () => {
  await seedInFlightCron(db, "sync-mint-burn", { leaseOwner: "worker-xyz" });
  const url = new URL("https://ops-api.pharos.watch/api/kill-cron-in-flight?job=sync-mint-burn&leaseOwner=worker-abc");
  const req = new Request(url, { method: "POST", headers: { "X-Pharos-Admin": "1", "Idempotency-Key": "t2" } });
  const res = await handleKillCronInFlight({ db, url, request: req, trustedAdmin: true });
  expect(res.status).toBe(409);
});
```

- [ ] **Step 4: Frontend** — `cron-card.tsx` renders a "Kill in-flight" button when `inFlight?.stale === true`; confirmation modal warns "In-flight progress will be lost." Pass `inFlight.leaseOwner` in the request. If the response is 409, display "Lease owner no longer matches — likely already replaced." and auto-refresh.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(admin): kill stale in-flight cron runs from the UI"
```

---

## Task 11: Operator control — Bulk-dismiss discovery candidates

**Files:**
- Create: `worker/src/api/admin-bulk-dismiss-discovery-candidates.ts`
- Modify: `worker/src/router.ts`
- Test: new
- Modify: `src/components/status/discovery-candidates.tsx` (add "Dismiss all" button beside existing per-row dismiss)

**Context:** Today dismissing a candidate requires a per-row modal. During backlog clean-up (e.g. a bad DefiLlama burst) this is tedious. Bulk-dismiss takes an optional `ids` array (comma-separated in query) or dismisses all non-dismissed candidates if omitted — require **explicit** `all=true` for the blanket case to avoid fat-fingered mass actions.

- [ ] **Step 1: Test the happy path**

```typescript
it("dismisses all non-dismissed candidates when all=true", async () => {
  await seedCandidates(db, [{ id: 1, dismissed: false }, { id: 2, dismissed: false }, { id: 3, dismissed: true }]);
  const url = new URL("https://ops-api.pharos.watch/api/bulk-dismiss-discovery-candidates?all=true");
  const req = new Request(url, { method: "POST", headers: { "X-Pharos-Admin": "1", "Idempotency-Key": "t1" } });
  const res = await handleBulkDismissDiscoveryCandidates({ db, url, request: req, trustedAdmin: true });
  expect(res.status).toBe(200);
  const body = await res.json() as { ok: boolean; dismissed: number };
  expect(body.dismissed).toBe(2);
});

it("rejects when neither ids nor all=true is provided", async () => {
  const url = new URL("https://ops-api.pharos.watch/api/bulk-dismiss-discovery-candidates");
  const req = new Request(url, { method: "POST", headers: { "X-Pharos-Admin": "1" } });
  const res = await handleBulkDismissDiscoveryCandidates({ db, url, request: req, trustedAdmin: true });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Implement** with `makeIdempotentAdminRoute<AdminRouteContext>("route-bulk-dismiss-discovery-candidates", "bulk-dismiss-discovery-candidates", …)`. Mirror Task 8 pattern. Audit-log the action via `logAdminAction`.

- [ ] **Step 3: Frontend** — add a "Dismiss all" button in `discovery-candidates.tsx`. Confirmation modal shows the count and explicit "Yes, dismiss N candidates" button.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(admin): bulk-dismiss discovery candidates"
```

---

## Task 12: Persist admin action audit log

**Files:**
- Create: `worker/migrations/0098_admin_action_audit_log.sql`
- Create: `worker/src/lib/admin-action-audit.ts`
- Create: `worker/src/api/admin-action-log.ts` (GET endpoint for dashboard)
- Modify: `worker/src/router.ts`
- Modify: Each admin mutation handler to call `logAdminAction` on success and failure (handlers touched in Tasks 8–11 plus existing: `trigger-digest`, `reset-blacklist-sync`, `debug-sync-state` (read-only), discovery-candidate-dismiss, plus backfill handlers).
- Test: new
- Modify: `src/app/admin/sections/control-section.tsx` (replace ephemeral client-side action log with a query over the new endpoint)

**Context:** The current admin Action History is a `useState` array inside the client component — reloading the page wipes it. An audit of "who did what" requires Cloudflare logs and cross-referencing. A D1 table indexed by timestamp gives the operator a persistent trail and is easier to scan during retrospectives.

- [ ] **Step 1: Migration**

```sql
-- worker/migrations/0098_admin_action_audit_log.sql
CREATE TABLE IF NOT EXISTS admin_action_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  actor TEXT NOT NULL,                 -- CF Access email, or "internal" for trustedAdmin
  action TEXT NOT NULL,                -- e.g. "reset-blacklist-sync", "reset-cron-lease"
  target TEXT,                         -- e.g. job name, circuit name, null for global actions
  result TEXT NOT NULL CHECK (result IN ('ok', 'error')),
  http_status INTEGER,
  details_json TEXT                    -- JSON: structured details; truncate at 4 KiB
);

CREATE INDEX IF NOT EXISTS idx_admin_action_audit_created_at
  ON admin_action_audit (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_action_audit_actor_action
  ON admin_action_audit (actor, action, created_at DESC);
```

- [ ] **Step 2: Helper**

```typescript
// worker/src/lib/admin-action-audit.ts
export interface AdminActionLogEntry {
  action: string;
  target?: string | null;
  result: "ok" | "error";
  httpStatus?: number;
  details?: Record<string, unknown>;
  actor?: string; // caller may override; default pulled from CF Access header
}

const DETAILS_MAX_LEN = 4096;

export async function logAdminAction(
  db: D1Database,
  entry: AdminActionLogEntry,
  request?: Request,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const actor = entry.actor
    ?? request?.headers.get("Cf-Access-Authenticated-User-Email")
    ?? "internal";
  const detailsJson = entry.details ? JSON.stringify(entry.details).slice(0, DETAILS_MAX_LEN) : null;
  try {
    await db
      .prepare(
        "INSERT INTO admin_action_audit (created_at, actor, action, target, result, http_status, details_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(now, actor, entry.action, entry.target ?? null, entry.result, entry.httpStatus ?? null, detailsJson)
      .run();
  } catch (err) {
    // Audit failures must not break the action itself — log and continue.
    console.warn(`[admin-action-audit] write failed for action=${entry.action}:`, err);
  }
}
```

- [ ] **Step 3: GET endpoint**

```typescript
// worker/src/api/admin-action-log.ts
import { makeAdminRoute } from "../lib/route-wrappers";
import { jsonResponse } from "../lib/api-utils";

export const handleAdminActionLog = makeAdminRoute(
  "route-admin-action-log",
  async ({ db, url }) => {
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") ?? "50")));
    const rows = await db
      .prepare(
        "SELECT id, created_at, actor, action, target, result, http_status, details_json FROM admin_action_audit ORDER BY created_at DESC LIMIT ?",
      )
      .bind(limit)
      .all<{
        id: number; created_at: number; actor: string; action: string;
        target: string | null; result: "ok" | "error"; http_status: number | null;
        details_json: string | null;
      }>();
    const entries = (rows.results ?? []).map((r) => ({
      id: r.id,
      at: r.created_at,
      actor: r.actor,
      action: r.action,
      target: r.target,
      result: r.result,
      httpStatus: r.http_status,
      details: r.details_json ? safeJsonParse(r.details_json) : null,
    }));
    return jsonResponse({ entries }, { noStore: true });
  },
);

function safeJsonParse(json: string): unknown {
  try { return JSON.parse(json); } catch { return null; }
}
```

- [ ] **Step 4: Wire `logAdminAction` into every admin mutation**

Find every handler exported from `worker/src/api/admin-actions.ts` and from Task 8/9/10/11 new endpoints. Wrap the action body so `logAdminAction` is called on both success (with `result: "ok"`, `httpStatus: 200/202`) and on any thrown error (with `result: "error"` + `httpStatus` from the response). The wrapper should not require touching every handler — add a small helper:

```typescript
// In route-wrappers.ts (or admin-action-audit.ts)
export async function runWithAudit<T extends Response>(
  db: D1Database,
  request: Request | undefined,
  action: string,
  target: string | null,
  run: () => Promise<T>,
): Promise<Response> {
  try {
    const res = await run();
    await logAdminAction(db, { action, target, result: res.ok ? "ok" : "error", httpStatus: res.status }, request);
    return res;
  } catch (err) {
    await logAdminAction(db, { action, target, result: "error", details: { message: String(err) } }, request);
    throw err;
  }
}
```

Retrofit the handlers to call `runWithAudit(db, request, "trigger-digest", null, async () => { /* existing body */ })`.

- [ ] **Step 5: Test** the helper + endpoint. Three cases:

```typescript
it("records actor from Cf-Access-Authenticated-User-Email header", async () => {
  const req = new Request("https://ops-api.pharos.watch/api/reset-blacklist-sync", {
    method: "POST",
    headers: { "X-Pharos-Admin": "1", "Cf-Access-Authenticated-User-Email": "alice@pharos.watch" },
  });
  await logAdminAction(db, { action: "reset-blacklist-sync", result: "ok" }, req);
  const row = await db.prepare("SELECT actor FROM admin_action_audit ORDER BY id DESC LIMIT 1").first<{ actor: string }>();
  expect(row?.actor).toBe("alice@pharos.watch");
});

it("records actor as 'internal' for trustedAdmin calls (no CF Access header)", async () => {
  await logAdminAction(db, { action: "reset-blacklist-sync", result: "ok" });
  const row = await db.prepare("SELECT actor FROM admin_action_audit ORDER BY id DESC LIMIT 1").first<{ actor: string }>();
  expect(row?.actor).toBe("internal");
});

it("caps details_json at DETAILS_MAX_LEN (4096) characters", async () => {
  const huge = { blob: "x".repeat(10_000) };
  await logAdminAction(db, { action: "backfill", result: "ok", details: huge });
  const row = await db.prepare("SELECT details_json FROM admin_action_audit ORDER BY id DESC LIMIT 1").first<{ details_json: string }>();
  expect(row?.details_json?.length).toBeLessThanOrEqual(4096);
});
```

Also cover the GET endpoint: `limit` clamping (1..200) and ordering (newest first).

- [ ] **Step 6: Frontend** — in `control-section.tsx`, replace the client-state `actionHistory` array with a TanStack Query hook `useAdminActionLog({ limit: 20 })` and optimistically append after a successful action (query invalidation).

- [ ] **Step 7: Commit**

```bash
git add worker/migrations/0098_admin_action_audit_log.sql worker/src/lib/admin-action-audit.ts worker/src/api/admin-action-log.ts worker/src/router.ts worker/src/api/admin-actions.ts worker/src/api/__tests__/*.test.ts src/app/admin/sections/control-section.tsx src/hooks/use-admin-action-log.ts
git commit -m "feat(admin): persistent admin action audit log"
```

---

# PHASE 3 — Informativeness & UX

---

## Task 13: Prominent freshness indicator on public `/status`

**Files:**
- Create: `src/components/status/freshness-indicator.tsx`
- Modify: `src/components/status/public-status-hero.tsx`
- Modify: `src/app/status/client.tsx`
- Test: `src/components/status/__tests__/freshness-indicator.test.tsx` (new)

**Context:** Freshness is currently surfaced only as an absolute datetime in small footer text. A relative "X seconds ago" pill (that updates every second) placed next to the status badge gives users and API consumers instant legibility and signals when the client is waiting on the next 60s refresh. Also add a UTC-offset tooltip so ambiguous timezone labels like "IST" become explicit.

- [ ] **Step 1: Write the test**

```tsx
// src/components/status/__tests__/freshness-indicator.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { FreshnessIndicator } from "../freshness-indicator";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("FreshnessIndicator", () => {
  it("renders '— just now' when updatedAt is within 5s", () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    render(<FreshnessIndicator updatedAtMs={1_700_000_000_000 - 2000} staleAfterMs={120_000} />);
    expect(screen.getByText(/just now/i)).toBeInTheDocument();
  });
  it("renders 'Xs ago' between 5s and 60s", () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    render(<FreshnessIndicator updatedAtMs={1_700_000_000_000 - 42_000} staleAfterMs={120_000} />);
    expect(screen.getByText(/42s ago/i)).toBeInTheDocument();
  });
  it("renders 'Xm ago' above 60s", () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    render(<FreshnessIndicator updatedAtMs={1_700_000_000_000 - 180_000} staleAfterMs={120_000} />);
    expect(screen.getByText(/3m ago/i)).toBeInTheDocument();
  });
  it("marks stale when age exceeds staleAfterMs", () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    render(<FreshnessIndicator updatedAtMs={1_700_000_000_000 - 180_000} staleAfterMs={120_000} />);
    expect(screen.getByRole("status")).toHaveAttribute("data-stale", "true");
  });
  it("increments live via internal timer", () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    const { rerender } = render(<FreshnessIndicator updatedAtMs={1_700_000_000_000 - 30_000} staleAfterMs={120_000} />);
    expect(screen.getByText(/30s ago/i)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.getByText(/35s ago/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Implement**

```tsx
// src/components/status/freshness-indicator.tsx
"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

interface FreshnessIndicatorProps {
  updatedAtMs: number;
  staleAfterMs: number;
  className?: string;
}

function formatAge(ageMs: number): string {
  if (ageMs < 5000) return "just now";
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1000)}s ago`;
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  return `${Math.floor(ageMs / 3_600_000)}h ago`;
}

export function FreshnessIndicator({ updatedAtMs, staleAfterMs, className }: FreshnessIndicatorProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const ageMs = Math.max(0, now - updatedAtMs);
  const isStale = ageMs > staleAfterMs;
  const absolute = new Date(updatedAtMs).toLocaleString(undefined, {
    timeZoneName: "long", // more descriptive than "short"
  });
  return (
    <span
      role="status"
      data-stale={isStale ? "true" : "false"}
      title={`Refreshed at ${absolute}`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
        isStale
          ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
          : "border-border/60 bg-background/60 text-muted-foreground",
        className,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", isStale ? "bg-amber-400" : "bg-emerald-400")} aria-hidden="true" />
      {formatAge(ageMs)}
    </span>
  );
}
```

- [ ] **Step 3: Wire into `PublicStatusHero`** — place the indicator next to the status badge, not in the footer:

```tsx
<FreshnessIndicator updatedAtMs={lastUpdated} staleAfterMs={180_000} />
```

Keep the footer absolute-time line for users who want precision.

- [ ] **Step 4: Wire into `StatusDashboard`** (admin) — same indicator next to the Refresh Countdown.

- [ ] **Step 5: Run tests + type-check**

Run: `npm test && npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add src/components/status/freshness-indicator.tsx src/components/status/__tests__/freshness-indicator.test.tsx src/components/status/public-status-hero.tsx src/app/status/client.tsx src/app/admin/client.tsx
git commit -m "feat(status): prominent FreshnessIndicator on public /status and admin"
```

---

## Task 14: Cache source attribution

**Files:**
- Modify: `shared/types/status.ts` (`CacheStatus.upstreamProvider?: string | null`)
- Modify: `worker/src/lib/public-health-assessment.ts` (populate the field when known)
- Modify: `src/components/status/cache-freshness-table.tsx` (render the column)
- Test: extend existing cache-related tests

**Context:** The cache table labels each cache by its internal key ("binance-tickers", "coingecko-simple-price") but does not call out the upstream provider for users unfamiliar with the taxonomy. Attribution makes "Binance is down → all these caches are degraded" a one-glance read.

- [ ] **Step 1: Add field to `CacheStatus`**

```typescript
export interface CacheStatus {
  // …existing…
  /** Human-friendly upstream provider (Binance, CoinGecko, DefiLlama, on-chain RPC, …). */
  upstreamProvider?: string | null;
}
```

Update `CacheStatusSchema` Zod to `upstreamProvider: z.string().nullable().optional()`.

- [ ] **Step 2: Build a key→provider map** in `shared/lib/status-metadata.ts` (or inline in `public-health-assessment.ts` if single-use). Keep the map adjacent to cache-key canonical source:

```typescript
export const CACHE_UPSTREAM_PROVIDER: Record<string, string> = {
  "binance-tickers": "Binance",
  "coingecko-simple-price": "CoinGecko",
  "defillama-protocol-tvl": "DefiLlama",
  // …enumerate remaining via a Grep for setCache keys and the source-registry.
};
```

- [ ] **Step 3: Populate during assessment** — wherever `CacheStatus` objects are constructed, merge in `upstreamProvider` from the map (null if unknown).

- [ ] **Step 4: Render the column** in `cache-freshness-table.tsx` — add a "Source" column between "Cache" and "Age" showing `cache.upstreamProvider ?? "—"`.

- [ ] **Step 5: Test** — extend the existing assessment test (`worker/src/lib/__tests__/public-health-assessment*.test.ts` if present; else add a narrow test for the enrichment):

```typescript
it("tags binance-tickers cache with upstreamProvider = 'Binance'", async () => {
  // existing assessment setup
  expect(result.caches["binance-tickers"].upstreamProvider).toBe("Binance");
});
```

- [ ] **Step 6: Commit**

```bash
git add shared/types/status.ts shared/lib/status-metadata.ts worker/src/lib/public-health-assessment.ts src/components/status/cache-freshness-table.tsx
git commit -m "feat(status): surface upstream provider attribution on cache freshness table"
```

---

## Task 15: Public divergence callout — `healthData.status` vs `probeSummary.status`

**Files:**
- Modify: `src/app/status/client.tsx` (add a notice when the two differ)
- Modify: `src/lib/status/public-status.ts` (add helper if needed)
- Test: extend the existing status page tests or add a narrow component test

**Context:** On the public page today, `healthData.status` drives the hero tone while `probeSummary.status` is one of five tiles; they can silently disagree. When they do, users should see a single-line explainer that tells them which signal is likely correct.

- [ ] **Step 1: Extract a pure helper**

```typescript
// src/lib/status/public-status.ts
export type PublicDivergenceNotice =
  | { kind: "in-sync" }
  | { kind: "health-degraded-probes-ok"; detail: string }
  | { kind: "probes-degraded-health-ok"; detail: string }
  | { kind: "both-degraded-different-severity"; detail: string };

export function getPublicDivergenceNotice(
  healthStatus: "healthy" | "degraded" | "stale",
  probeStatus: "healthy" | "degraded" | "stale",
): PublicDivergenceNotice {
  const SEV = { healthy: 0, degraded: 1, stale: 2 } as const;
  const h = SEV[healthStatus];
  const p = SEV[probeStatus];
  if (h === p) return { kind: "in-sync" };
  if (h > 0 && p === 0) {
    return { kind: "health-degraded-probes-ok", detail: `Health endpoint reports ${healthStatus}, but browser probes are green. A data-quality or ingestion issue likely, not an API outage.` };
  }
  if (p > 0 && h === 0) {
    return { kind: "probes-degraded-health-ok", detail: `Browser probes report ${probeStatus}, but health endpoint is green. Your network path may be the issue; refresh or try another network.` };
  }
  return { kind: "both-degraded-different-severity", detail: `Health: ${healthStatus}. Probes: ${probeStatus}.` };
}
```

- [ ] **Step 2: Test**

Append the test to the existing `src/lib/__tests__/public-status.test.ts` file (verified to exist). Do **not** create a parallel `src/lib/__tests__/status/public-status.test.ts` — that would split coverage across two files for one module.

```typescript
// src/lib/__tests__/public-status.test.ts — additions
import { describe, it, expect } from "vitest";
import { getPublicDivergenceNotice } from "../status/public-status";

describe("getPublicDivergenceNotice", () => {
  it("in-sync when equal", () => {
    expect(getPublicDivergenceNotice("healthy", "healthy").kind).toBe("in-sync");
    expect(getPublicDivergenceNotice("degraded", "degraded").kind).toBe("in-sync");
  });
  it("health-degraded-probes-ok when health > probes and probes healthy", () => {
    expect(getPublicDivergenceNotice("degraded", "healthy").kind).toBe("health-degraded-probes-ok");
  });
  it("probes-degraded-health-ok in the inverse", () => {
    expect(getPublicDivergenceNotice("healthy", "degraded").kind).toBe("probes-degraded-health-ok");
  });
  it("both-degraded-different-severity when both degraded but different", () => {
    expect(getPublicDivergenceNotice("degraded", "stale").kind).toBe("both-degraded-different-severity");
  });
});
```

- [ ] **Step 3: Render** — in `src/app/status/client.tsx`, insert the callout **after** the `<NoticeRail notices={notices} />` block (`src/app/status/client.tsx:176`) and **before** the first `<StatusSection id="overview" …>` (line 178). Match the NoticeRail tone (`border-amber-500/30 bg-amber-500/10`). Render conditionally on `divergence.kind !== "in-sync"`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/status/public-status.ts src/lib/__tests__/public-status.test.ts src/app/status/client.tsx
git commit -m "feat(status): surface health-vs-probes divergence to public /status users"
```

---

## Task 16: Visual cron in-flight progress bar

**Files:**
- Create: `src/components/status/cron-in-flight-progress.tsx`
- Modify: `src/components/status/cron-card.tsx` (replace text-only progress with the new component)
- Test: new

**Context:** `itemsDone / itemsTotal` is rendered as plain text; a `<progress>` element or a styled bar communicates progress instantly and shows when progress has stalled (combined with the stale flag).

- [ ] **Step 1: Test**

```tsx
import { render, screen } from "@testing-library/react";
import { CronInFlightProgress } from "../cron-in-flight-progress";

it("renders an accessible progress bar with the correct ratio", () => {
  render(<CronInFlightProgress itemsDone={50} itemsTotal={200} stale={false} />);
  const bar = screen.getByRole("progressbar");
  expect(bar).toHaveAttribute("aria-valuenow", "50");
  expect(bar).toHaveAttribute("aria-valuemax", "200");
});

it("renders indeterminate when itemsTotal is 0", () => {
  render(<CronInFlightProgress itemsDone={0} itemsTotal={0} stale={false} />);
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
});

it("applies stale tone when stale=true", () => {
  render(<CronInFlightProgress itemsDone={50} itemsTotal={200} stale={true} />);
  expect(screen.getByRole("progressbar")).toHaveAttribute("data-stale", "true");
});
```

- [ ] **Step 2: Implement**

```tsx
// src/components/status/cron-in-flight-progress.tsx
"use client";

import { cn } from "@/lib/utils";

interface CronInFlightProgressProps {
  itemsDone: number;
  itemsTotal: number;
  stale: boolean;
  className?: string;
}

export function CronInFlightProgress({ itemsDone, itemsTotal, stale, className }: CronInFlightProgressProps) {
  const safeTotal = Math.max(itemsTotal, 0);
  const safeDone = Math.max(0, Math.min(itemsDone, safeTotal));
  const pct = safeTotal > 0 ? (safeDone / safeTotal) * 100 : 0;
  return (
    <div
      role="progressbar"
      aria-valuenow={safeDone}
      aria-valuemin={0}
      aria-valuemax={safeTotal}
      aria-label={`Cron progress: ${safeDone} of ${safeTotal}`}
      data-stale={stale ? "true" : "false"}
      className={cn(
        "relative h-1.5 w-full overflow-hidden rounded-full bg-muted/40",
        className,
      )}
    >
      <div
        className={cn(
          "h-full transition-[width] duration-500 ease-out",
          stale ? "bg-amber-500" : "bg-emerald-500",
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
```

- [ ] **Step 3: Use in `cron-card.tsx`** — replace the text-only progress line with this component plus a numeric caption.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(admin): visual cron in-flight progress bar"
```

---

## Task 17: Per-probe history endpoint

**Files:**
- Create: `worker/src/api/status-probe-history.ts`
- Modify: `worker/src/router.ts`
- Test: new
- Create: `src/hooks/use-probe-history.ts`
- Modify: `src/app/admin/sections/reliability-section.tsx` (add drill-down link per probe)

**Context:** `status_probe_runs.details_json` already stores per-run slowest/failed probes; we expose a query that slices the last N days by endpoint path and returns pass/fail/latency summaries. Bounded query (`limit`, whitelisted `path`).

- [ ] **Step 1: Test**

```typescript
it("returns last 7d of runs touching /api/usds-status, newest first", async () => {
  await seedProbeRuns(db, [
    { createdAt: now - 1, details: { failed: [{ path: "/api/usds-status", status: 503 }] } },
    { createdAt: now - 1000, details: { failed: [] } },
  ]);
  const url = new URL("https://ops-api.pharos.watch/api/status-probe-history?path=/api/usds-status&days=7");
  const req = new Request(url, { method: "GET" });
  const res = await handleStatusProbeHistory({ db, url, request: req, trustedAdmin: true });
  const body = await res.json() as { runs: { at: number; failed: boolean; httpStatus?: number }[] };
  expect(body.runs[0].failed).toBe(true);
  expect(body.runs[1].failed).toBe(false);
});

it("rejects unknown path with 400", async () => {
  const url = new URL("https://ops-api.pharos.watch/api/status-probe-history?path=/api/bogus");
  const req = new Request(url, { method: "GET" });
  const res = await handleStatusProbeHistory({ db, url, request: req, trustedAdmin: true });
  expect(res.status).toBe(400);
});
```

**Implementation note — timestamp units:** `status_probe_runs.created_at` is stored as Unix seconds (confirmed via `worker/src/lib/status-probe-store.ts` and the `writeStatusProbeRun` insert path, which uses `now` from `Math.floor(Date.now() / 1000)`). The `since` calculation below is in seconds accordingly.

**Implementation note — module path:** `@shared/lib/api-endpoints` resolves via the directory barrel (`shared/lib/api-endpoints/index.ts`) which re-exports `getProbePaths`. Greps for a literal `api-endpoints.ts` file will come up empty; use `Grep(pattern="export.*getProbePaths", path="shared/lib/api-endpoints")` to locate the definition.

- [ ] **Step 2: Implement**

```typescript
// worker/src/api/status-probe-history.ts
import { makeAdminRoute } from "../lib/route-wrappers";
import { jsonResponse } from "../lib/api-utils";
import { getProbePaths } from "@shared/lib/api-endpoints";

const MAX_DAYS = 30;
const DEFAULT_DAYS = 7;

export const handleStatusProbeHistory = makeAdminRoute(
  "route-status-probe-history",
  async ({ db, url }) => {
    const path = url.searchParams.get("path");
    const allowedPaths = new Set([...getProbePaths("public"), ...getProbePaths("admin")]);
    if (!path || !allowedPaths.has(path)) {
      return jsonResponse({ error: "Missing or unknown path" }, { status: 400, noStore: true });
    }
    const days = Math.max(1, Math.min(MAX_DAYS, Number(url.searchParams.get("days") ?? DEFAULT_DAYS)));
    const since = Math.floor(Date.now() / 1000) - days * 86_400;
    const rows = await db
      .prepare(
        "SELECT created_at, status, details_json FROM status_probe_runs WHERE created_at >= ? ORDER BY created_at DESC LIMIT 500",
      )
      .bind(since)
      .all<{ created_at: number; status: "healthy" | "degraded" | "stale"; details_json: string | null }>();
    const runs = (rows.results ?? [])
      .map((row) => {
        const details = row.details_json ? safeJsonParse(row.details_json) as { failed?: Array<{ path?: string; status?: number; error?: string | null }> } : null;
        const matching = (details?.failed ?? []).find((f) => f.path === path);
        return {
          at: row.created_at,
          overallProbeStatus: row.status,
          failed: matching != null,
          httpStatus: matching?.status ?? null,
          error: matching?.error ?? null,
        };
      });
    const summary = {
      sampleCount: runs.length,
      failCount: runs.filter((r) => r.failed).length,
      windowDays: days,
    };
    return jsonResponse({ path, summary, runs }, { noStore: true });
  },
);

function safeJsonParse(s: string): unknown { try { return JSON.parse(s); } catch { return null; } }
```

- [ ] **Step 3: Frontend hook + Reliability drill-down link** — add a small link next to each failing probe in the endpoint-health-grid that opens a modal or navigates to a dedicated drill-down view showing the last 7 days.

- [ ] **Step 4: Commit**

```bash
git add worker/src/api/status-probe-history.ts worker/src/router.ts worker/src/api/__tests__/status-probe-history.test.ts src/hooks/use-probe-history.ts src/app/admin/sections/reliability-section.tsx src/components/status/endpoint-health-grid.tsx
git commit -m "feat(status): per-probe history endpoint + admin drill-down"
```

---

## Task 18a: Admin UX micro-fixes (cover audit items 10, 11, 13)

**Files:**
- Modify: `src/app/admin/client.tsx` or `src/app/admin/status-dashboard.tsx` (after Task 19 lands)
- Modify: `src/lib/status-dashboard-model.ts` (or its post-Task-20 split target) — raise `topCauses` cap
- Test: extend `src/app/admin/__tests__/client.test.tsx`

**Context:** Three small admin-UX issues called out in the audit summary that do not deserve their own workstream but must be addressed to keep scope faithful:
- Audit item 10: "Recovery hold — raw degraded" label is cryptic.
- Audit item 11: top-fold shows only `topCauses.slice(0, 3)` with no way to see more blockers.
- Audit item 13: `useSyncExternalStore` + `isOpsUiHost()` pair is overkill for the client-only host check.

- [ ] **Step 1: Add a tooltip for "recovery hold"** — wrap the existing `<span className="… rounded-full border border-amber-500/30 …">recovery hold — raw {rawStatus}</span>` in a `<Tooltip>` primitive (shadcn `tooltip.tsx` is in `src/components/ui/`):

```tsx
<Tooltip>
  <TooltipTrigger asChild>
    <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
      recovery hold — raw {data.rawOverallStatus}
    </span>
  </TooltipTrigger>
  <TooltipContent>
    The state machine is holding at a higher severity than the raw signal so
    that improvements must hold for {data.state.minDwellSec}s before the overall
    status is downgraded. Prevents flap.
  </TooltipContent>
</Tooltip>
```

- [ ] **Step 2: "+N more" indicator below top-fold blockers** — in the blockers card (currently `topCauses.slice(0, 3)`), add a disclosure line when `overallCauseCount > 3`:

```tsx
{overallCauseCount > 3 && (
  <button
    type="button"
    onClick={() => setIsBlockersExpanded((v) => !v)}
    className="pharos-focus-ring mt-2 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
  >
    {isBlockersExpanded ? "Show top 3" : `+${overallCauseCount - 3} more`}
  </button>
)}
```

When expanded, render `topCauses.slice(0, overallCauseCount)` (not all causes — keep to `getBlockerCauses`, which already excludes `info`). Add `useState(false)` for `isBlockersExpanded`.

- [ ] **Step 3: Simplify the ops-host gate** — replace the `useSyncExternalStore` pattern (`src/app/admin/client.tsx:47-51`) with a standard `useEffect` + `useState`:

```tsx
const [opsUi, setOpsUi] = useState<boolean | null>(null);
useEffect(() => { setOpsUi(isOpsUiHost()); }, []);
```

Server render returns `null` (loading state), first client effect resolves. Functionally equivalent but simpler for the next reader.

- [ ] **Step 4: Test** — in `client.test.tsx`, assert that:
  - When `overallCauseCount = 5`, the "+2 more" button appears.
  - Clicking expands to show all 5 blockers.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(admin): tooltip on recovery hold; blockers expand-all; simplify ops-host gate"
```

---

## Task 18: Runbook links on `StatusCause` (opt-in)

**Files:**
- Modify: `shared/types/status.ts` (add optional `runbookUrl`)
- Modify: `worker/src/lib/status/evaluation-causes.ts` (populate for known codes)
- Modify: `src/components/status/recommended-action-strip.tsx` (render "Runbook →" link when present)
- Test: existing tests should still pass; add one that asserts a known cause has a runbook set

**Context:** Operators facing `data_quality_skipped_db_unhealthy` or `raw-stale-immediate-escalation` can guess the remedy, but a direct runbook link trims minutes off triage.

- [ ] **Step 1: Extend type**

```typescript
export interface StatusCause {
  // …existing fields…
  /** Optional runbook URL or anchor (`/docs/runbooks/X`). Populated for well-understood codes only. */
  runbookUrl?: string;
}
```

- [ ] **Step 2: Map** — a tight enum-coded table of runbook URLs lives in `worker/src/lib/status/evaluation-causes.ts`:

```typescript
const RUNBOOK_BY_CODE: Record<string, string> = {
  db_unhealthy: "/docs/runbooks/db-connectivity",
  data_quality_skipped_db_unhealthy: "/docs/runbooks/db-connectivity",
  // Populate for the ~10 most common codes — do NOT populate all.
};

// When constructing a StatusCause, merge:
const cause: StatusCause = {
  code,
  layer,
  severity,
  message,
  ...(RUNBOOK_BY_CODE[code] ? { runbookUrl: RUNBOOK_BY_CODE[code] } : {}),
};
```

- [ ] **Step 3: Frontend** — `recommended-action-strip.tsx` (or `overview-section.tsx` where blockers are rendered) checks for `cause.runbookUrl` and renders an inline "Runbook →" link.

- [ ] **Step 4: Docs** — create placeholder runbook pages under `docs/runbooks/` (markdown stubs are acceptable; the production pages can be filled in later). If these pages don't exist yet, fail the build or log a warning? — Do **not** fail the build. Render the link even if the page is thin; it's an entry point.

- [ ] **Step 5: Test**

```typescript
it("populates runbookUrl for db_unhealthy cause", () => {
  const causes = buildAvailabilityCauses({ publicHealth: { dbHealthy: false /* …*/ } /* …*/ });
  const cause = causes.find((c) => c.code === "db_unhealthy");
  expect(cause?.runbookUrl).toBe("/docs/runbooks/db-connectivity");
});
```

- [ ] **Step 6: Commit**

```bash
git add shared/types/status.ts worker/src/lib/status/evaluation-causes.ts worker/src/lib/__tests__/evaluation-causes.test.ts src/components/status/recommended-action-strip.tsx docs/runbooks/db-connectivity.md
git commit -m "feat(status): opt-in runbook URLs on StatusCause"
```

---

# PHASE 4 — Code health & testing

---

## Task 19: Extract `StatusDashboard` + `cron-severity` from `admin/client.tsx`

**Files:**
- Create: `src/app/admin/status-dashboard.tsx` (~302 LOC moved)
- Create: `src/app/admin/cron-severity.ts` (~8 LOC moved)
- Modify: `src/app/admin/client.tsx` (shrinks to ~100 LOC — just the gate + shell)
- Modify: `src/app/admin/__tests__/client.test.tsx` (imports update; tests that exercise the dashboard move to `__tests__/status-dashboard.test.tsx`)

**Context:** 402 LOC with a 302-line inline component is at the upper end. Splitting into a gate (`client.tsx`) + a dashboard (`status-dashboard.tsx`) + a tiny helper module clarifies responsibilities and reduces rebuild churn.

- [ ] **Step 1: Move `getCronSeverity`** from `client.tsx:32-37` to new `src/app/admin/cron-severity.ts` verbatim. Export as `getCronSeverity`. Update the `import` in `client.tsx` / the new `status-dashboard.tsx`.

- [ ] **Step 2: Move `StatusDashboard`** function from `client.tsx:100-401` to new `src/app/admin/status-dashboard.tsx`. Export default. Update `client.tsx` to import it.

- [ ] **Step 3: Trim `client.tsx`** to just the ops-host gate, the lead-paragraphs fork, and the `FeaturePageShell` return — roughly the current lines 1-98 plus a slim `StatusDashboard` invocation at line 90.

- [ ] **Step 4: Move component tests** — anything in `__tests__/client.test.tsx` that asserts on the dashboard (data flow, autoexpand, section ordering) moves to `__tests__/status-dashboard.test.tsx`. Gate tests stay in `client.test.tsx`.

- [ ] **Step 5: Run tests**

Run: `npm test -- src/app/admin`

- [ ] **Step 6: Type-check + commit**

```bash
git add src/app/admin/status-dashboard.tsx src/app/admin/cron-severity.ts src/app/admin/client.tsx src/app/admin/__tests__/
git commit -m "refactor(admin): split client.tsx into gate + status dashboard"
```

---

## Task 20: Split `status-dashboard-model.ts`

**Files:**
- Create: `src/lib/status/admin-status-model.ts` (all admin-only derivations: `buildStatusDashboardData`, section types, priority/ordering, notice builder)
- Create: `src/lib/status/status-formatting.ts` (timestamps, tone/severity color helpers, label utilities)
- Modify: `src/lib/status-dashboard-model.ts` → re-exports for backwards-compat during rollout, then remove after imports are updated
- Modify: every importer of `status-dashboard-model` (many files) — update paths to new location

**Context:** 484 LOC with mixed concerns (public helpers + admin derivation + formatting). Splitting by audience makes each file focused.

- [ ] **Step 1: Move public-facing helpers** (`buildBrowserProbeSummary`, `formatTimestampSeconds`, `formatTimestampMs`, `formatTransitionLabel`, `getStatusTone`, `getSeverityBadgeClass`, `getNoticeTone`) to `src/lib/status/status-formatting.ts`.

- [ ] **Step 2: Move admin-specific helpers** (`buildStatusDashboardData`, all types: `DashboardSection`, `DashboardSectionId`, `DashboardNotice`, `DashboardQuerySync`, plus `getBlockerCauses`, `getWatchCauses`, `getTopCauses`, `dedupeCauses`) to `src/lib/status/admin-status-model.ts`.

- [ ] **Step 3: Keep `status-dashboard-model.ts` as a re-export shim** for one release cycle:

```typescript
// src/lib/status-dashboard-model.ts — re-exports only
export * from "./status/status-formatting";
export * from "./status/admin-status-model";
```

- [ ] **Step 4: Run full test suite + type-check** — all imports should still resolve via the shim.

Run: `npm test && npx tsc --noEmit`

- [ ] **Step 5: Immediately follow-up commit** — update all known importers to the new paths (codemod with Grep+Edit). Then delete the shim.

Identify importers with:
```
Grep(pattern="from \"@/lib/status-dashboard-model\"", output_mode="files_with_matches")
```

Apply Edit to each (path replace `@/lib/status-dashboard-model` → `@/lib/status/status-formatting` or `@/lib/status/admin-status-model` depending on named import).

- [ ] **Step 6: Commit twice**

```bash
# Commit A (introduce split + shim)
git add src/lib/status/admin-status-model.ts src/lib/status/status-formatting.ts src/lib/status-dashboard-model.ts
git commit -m "refactor(status): split status-dashboard-model into formatting + admin model"

# Commit B (migrate importers + delete shim)
git add -u
git commit -m "refactor(status): migrate importers off status-dashboard-model shim"
```

---

## Task 21: Replace inline severity class strings with `getSeverityBadgeClass`

**Files:**
- Modify: `src/components/status/admin-actions-panel.tsx:101-107`
- Modify: `src/components/status/recommended-action-strip.tsx:43-50`
- Modify: any other file flagged by a grep for `bg-red-500/15 text-red-700`

**Context:** `getSeverityBadgeClass` already exists in `status-formatting.ts` (after Task 20). Using it consistently prevents drift and simplifies future theming.

- [ ] **Step 1: Grep** for `bg-red-500/15` and `bg-amber-500/15` across `src/components/status/`. Each match that branches on a severity is a candidate.

- [ ] **Step 2: Replace** inline ternaries with `getSeverityBadgeClass(severity)` import.

- [ ] **Step 3: Run tests + type-check**

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(admin): use getSeverityBadgeClass uniformly across status components"
```

---

## Task 22: Verify `status_probe_runs.created_at` index exists (no-op)

**Status:** **Verified 2026-04-17 — no action needed.** `worker/migrations/0000_baseline.sql:712` already defines `idx_status_probe_runs_created_at ON status_probe_runs(created_at DESC)`. This task is retained as a documentation placeholder so the audit-to-task map is traceable; no migration file and no commit.

- [ ] **Step 1: Grep to confirm** (sanity check before closing the task):

```
Grep(pattern="idx_status_probe_runs", path="worker/migrations")
```

Expected: match on line 712 of `0000_baseline.sql`. If absent (future-proofing), land a follow-up migration as originally spec'd; until then, no work.

No commit.

---

## Task 23: Parallelize `computeRawStatus` D1 loads

**Files:**
- Modify: `worker/src/lib/status-evaluation.ts` (lines 133-225)

**Context:** The five D1-backed calls (`assessPublicHealth`, `loadCronHealth`, `getDataQuality`, `loadSupplementalStatusSections`, `countRecentStatusTransitions`) currently run sequentially. Four of them are independent (`getDataQuality` depends on `assessPublicHealth.blacklistMetrics`), so a small `Promise.all` grouping cuts the wall-time substantially.

- [ ] **Step 1: Verify caller context.** `computeRawStatus` is invoked from (a) `handleStatus` (HTTP request path) and (b) `evaluateStatusAndPersist` → `runStatusSelfCheck` (cron). The HTTP path has no shared connection pool with other work. The cron path has the 6-connection `ctx.waitUntil` pool documented in CLAUDE.md ("Worker cron jobs share Cloudflare's per-trigger 6-connection pool across all `ctx.waitUntil()` work"), but status-self-check does not spawn `waitUntil` work — its D1 calls are direct `await`, so the pool-sharing rule does not apply. Four parallel reads are safe on both paths.

- [ ] **Step 2: Refactor**

```typescript
export async function computeRawStatus(db: D1Database, now: number): Promise<RawStatusComputation> {
  const publicHealth = await assessPublicHealth(db, now, { logPrefix: "status" });
  if (!publicHealth.dbHealthy) {
    return buildDbUnavailableRawStatus();
  }

  // Four independent loads run in parallel. D1's per-request concurrency is
  // effectively unconstrained up to the Worker CPU budget; the 6-connection
  // ctx.waitUntil pool documented in CLAUDE.md does not apply here because
  // none of these calls are scheduled via waitUntil.
  const [cronHealth, dataQuality, supplements, transitionsLast24h] = await Promise.all([
    loadCronHealth(db, now),
    getDataQuality(db, now, { blacklistMetrics: publicHealth.blacklistMetrics }),
    loadSupplementalStatusSections(db, now),
    countRecentStatusTransitions(db, now),
  ]);

  // Destructure after resolution — must reproduce every name used by the
  // pure-CPU derivations below. BEFORE the refactor these came from inline
  // `await` calls; AFTER, they come from the variables above. No semantic
  // change.
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
  } = cronHealth;
  const {
    sectionErrors,
    telegramBot,
    datasetFreshness,
    reserveComposition,
    reserveCompositionQueryFailed,
  } = supplements;

  // …remaining pure-CPU derivations unchanged: deriveStatusAssessmentInputs(dataQuality),
  // deriveReserveCompositionStatus, countDiagnosticIssues, deriveAvailabilityStatus,
  // deriveDataQualityStatus, buildAvailabilityCauses, buildDataQualityCauses,
  // scoreStatusConfidence.
}
```

- [ ] **Step 3: Run the full status test suite** to make sure nothing relied on sequential ordering.

Run: `cd worker && npx vitest run`

- [ ] **Step 4: Commit**

```bash
git commit -m "perf(status): parallelize independent computeRawStatus D1 loads"
```

---

## Task 24: Merge read+write in `handleStatus` (post-Task 2)

**Files:**
- Modify: `worker/src/api/status.ts`

**Context:** After Task 2, `handleStatus` already made the reconcile call read-only; this task is now just about ensuring we issue **one** snapshot read and not two. Double-check the function after Task 2 to confirm no redundant `getStatusStateSnapshot` call remains. If so, nothing to do here; mark Task 24 as a verification step.

- [ ] **Step 1: Re-read `handleStatus`** after Task 2. Confirm snapshot is read exactly once.
- [ ] **Step 2: If redundant read found, remove it.** Otherwise close the task as "verified; no action needed" and document in a commit:

```bash
# Only commit if changes were made
git commit -m "perf(status): dedupe snapshot read in handleStatus"
```

---

## Task 25: Admin section unit tests

**Files:**
- Create: `src/app/admin/sections/__tests__/overview-section.test.tsx`
- Create: `src/app/admin/sections/__tests__/reliability-section.test.tsx`
- Create: `src/app/admin/sections/__tests__/crons-section.test.tsx`
- Create: `src/app/admin/sections/__tests__/control-section.test.tsx`
- (History + Pipeline can wait one release — low churn, low risk.)

**Context:** Each section has prop-driven branches (auto-expand, empty states, degraded states). Tests lock the contract so Task 19/20 refactors don't silently regress.

- [ ] **Step 1: For each section**, write a minimum of three tests:
  - Renders happy-path label/summary given a "healthy" `StatusResponse` fixture.
  - Renders the degraded badge/notice given a fixture where the relevant indicator is unhealthy.
  - Renders the auto-expand state correctly when the expand signal is truthy.

Fixture reuse: add `src/app/admin/__tests__/fixtures/status-response.ts` with one healthy baseline + helpers to mutate (`degraded()`, `stale()`) — this keeps each test file short.

- [ ] **Step 2: Run** `npm test -- src/app/admin`

- [ ] **Step 3: Commit**

```bash
git commit -m "test(admin): unit tests for overview/reliability/crons/control sections"
```

---

## Task 26: Public-status derivation tests

**Files:**
- Modify: `src/lib/__tests__/public-status.test.ts` (the existing file, not a new subdirectory file — see Task 15 note)

**Context:** `getPublicWorstCacheSummary`, `getImpactedPublicSurfaces`, `getPublicMintBurnStatus` drive the public page hero and card copy. Lock their outputs on representative fixtures.

- [ ] **Step 1: Write tests** — one per helper, each with ≥3 fixtures (all-healthy, worst-degraded, worst-stale). Append to the existing file to keep all public-status coverage co-located.

- [ ] **Step 2: Commit**

```bash
git commit -m "test(status): unit tests for public-status derivation helpers"
```

---

# PHASE 5 — Schema hygiene & retention

---

## Task 27: TTL cron for `status_probe_runs`

**Files:**
- Create: `worker/src/cron/prune-status-probe-runs.ts`
- Modify: `worker/src/handlers/scheduled/` — register the handler
- Modify: `shared/lib/cron-jobs.ts` — add a new job id + schedule entry
- Modify: `worker/wrangler.toml` — add the cron trigger (e.g., `0 3 * * *` — daily at 03:00 UTC)
- Test: new

**Context:** `status_probe_runs` is append-only at 15-min cadence → ~35k rows/year. We retain only 90 days and prune nightly. Conservative batch size (10k rows) keeps the statement under the 30s per-statement D1 limit.

- [ ] **Step 1: Test** the pruning function (time-based boundary, batch cap):

```typescript
it("deletes rows older than cutoffSec and stops at batchSize", async () => {
  const now = Math.floor(Date.now() / 1000);
  const cutoffSec = now - 90 * 86_400;
  // Seed: 150 rows 91 days ago (all should be candidates), 10 rows from today
  // (should be untouched). Concrete seeds let the executor reproduce exactly.
  await seedProbeRuns(db, {
    count: 150,
    createdAt: now - 91 * 86_400,
    statusRotation: ["healthy", "degraded", "stale"],
  });
  await seedProbeRuns(db, {
    count: 10,
    createdAt: now - 300,
    statusRotation: ["healthy"],
  });
  // First pass: batchSize=100 caps the deletion, leaving 50 eligible rows.
  const first = await pruneStatusProbeRuns(db, { cutoffSec, batchSize: 100 });
  expect(first.deleted).toBe(100);
  // Second pass finishes the backlog.
  const second = await pruneStatusProbeRuns(db, { cutoffSec, batchSize: 100 });
  expect(second.deleted).toBe(50);
  // Recent rows survive.
  const remaining = await db.prepare("SELECT COUNT(*) AS cnt FROM status_probe_runs").first<{ cnt: number }>();
  expect(remaining?.cnt).toBe(10);
});
```

`seedProbeRuns` is a small fixture helper the executor creates at the top of the test file (or reuses if it exists). Minimum shape:

```typescript
async function seedProbeRuns(
  db: D1Database,
  opts: { count: number; createdAt: number; statusRotation: Array<"healthy" | "degraded" | "stale"> },
) {
  for (let i = 0; i < opts.count; i++) {
    const status = opts.statusRotation[i % opts.statusRotation.length];
    await db
      .prepare("INSERT INTO status_probe_runs (status, sample_count, pass_count, fail_count, p95_latency_ms, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(status, 50, 50, 0, 100, "{}", opts.createdAt)
      .run();
  }
}
```

- [ ] **Step 2: Implement**

```typescript
// worker/src/cron/prune-status-probe-runs.ts
export async function pruneStatusProbeRuns(
  db: D1Database,
  opts: { cutoffSec: number; batchSize: number },
): Promise<{ deleted: number }> {
  const res = await db
    .prepare("DELETE FROM status_probe_runs WHERE created_at < ? AND id IN (SELECT id FROM status_probe_runs WHERE created_at < ? ORDER BY created_at ASC LIMIT ?)")
    .bind(opts.cutoffSec, opts.cutoffSec, opts.batchSize)
    .run();
  return { deleted: res.meta?.changes ?? 0 };
}

export async function runPruneStatusProbeRuns(db: D1Database): Promise<CronResult> {
  const cutoffSec = Math.floor(Date.now() / 1000) - 90 * 86_400;
  const { deleted } = await pruneStatusProbeRuns(db, { cutoffSec, batchSize: 10_000 });
  return {
    status: "ok",
    itemCount: deleted,
    metadata: JSON.stringify({ cutoffSec, deleted }),
  };
}
```

- [ ] **Step 3: Register** the job in `shared/lib/cron-jobs.ts` (new entry with `statusImpact: "watch"`) and add the scheduled handler to the dispatcher. Pick a schedule that does not collide with existing `cron_slot_executions` usage — `0 3 * * *` daily.

- [ ] **Step 4: Add the wrangler cron**

```toml
[triggers]
crons = [
  # …existing…
  "0 3 * * *",  # prune-status-probe-runs (Task 27)
]
```

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(status): nightly prune of status_probe_runs older than 90d"
```

---

# PHASE 6 — Docs, close-out & methodology

---

## Task 28: Docs, changelog & close-out

**Files:**
- Modify: `docs/architecture.md` (new admin surfaces: reset-cron-lease, reset-circuit-breaker, kill-cron-in-flight, bulk-dismiss, audit log; state notifier read/write separation)
- Modify: `docs/api-reference.md` (enumerate new endpoints; update `/api/status` to note read-only semantics)
- Modify: `docs/worker-and-api-limits.md` (audit log retention; probe run TTL)
- Modify: `CLAUDE.md` if any new CI or config patterns introduced
- Modify: `README.md` if admin controls warrant a bullet
- **Methodology:** NO bump — this plan does not touch PegScore / DEWS / LiquidityScore / PSI / Chain Health / Report Cards. Confirm by re-reading `docs/methodology.md` vs changes made.

**Context:** Update the verified documentation corpus to match reality. Leave `/methodology` alone.

- [ ] **Step 1: Diff docs** against the new endpoints and write concise paragraphs (2-4 lines per addition).

- [ ] **Step 2: Docs count guard** — run `npm run check:doc-counts` to verify stablecoin counts still match. This task should not change any counts; guard is a sanity check.

- [ ] **Step 3: Pre-push merge gate**

Run: `npm run test:merge-gate`

- [ ] **Step 4: Open PR**

```bash
git push -u origin feat/status-admin-notifier-remediation
gh pr create --title "Status notifier + /status + /admin: correctness, controls, UX" --body "$(cat <<'EOF'
## Summary
- Correctness: health-JSON classification, remove API↔cron reconcile race, CSRF header on admin mutations, discrepancyReason enum, decision threshold alignment.
- Controls: reset-cron-lease, reset-circuit-breaker, kill-cron-in-flight, bulk-dismiss-discovery-candidates, persisted admin action audit log.
- Informativeness: freshness indicator, upstream-provider cache attribution, health-vs-probes divergence callout, visual cron progress, per-probe history endpoint, runbook URLs on causes.
- Code health: split admin/client.tsx, split status-dashboard-model.ts, shared severity class helper, section error boundaries, missing unit tests.
- Performance & schema: parallel computeRawStatus, status_probe_runs index + 90d TTL.

## Test plan
- [ ] `npm run test:merge-gate`
- [ ] Deploy to staging; verify admin actions produce audit-log rows
- [ ] Deploy to staging; verify reset-cron-lease clears a manually-seeded stuck lease
- [ ] Smoke: `/status` freshness indicator updates every second
- [ ] Smoke: corrupt `/api/health` (temporarily, on staging) and confirm probe status classifies as stale

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Commit docs & tag**

```bash
git add docs/ CLAUDE.md README.md
git commit -m "docs(status): update architecture / api-reference / worker-and-api-limits for status remediation"
```

---

# Appendix A — Explicitly de-scoped items

The following ideas surfaced during audit but are **intentionally out of scope** for this plan:

1. **Timezone UTC offset tooltip on the public page** beyond `timeZoneName: "long"` already applied in Task 13. Further UTC toggle = feature work.
2. **Cache ratio threshold labels on the public page.** Thresholds are stable; adding them clutters the hero tile.
3. **SLA compliance view on admin.** Requires new aggregation + agreement on what the SLA numerically is.
4. **Keyboard shortcuts on admin.** Nice-to-have; no operator has requested; YAGNI.
5. **Mobile keyboard-navigation audit.** Not on the critical path; admin is desktop-first.
6. **Adaptive probe polling during incidents.** Current 60s cadence is acceptable.
7. **Cron dependency graph in admin.** Would need `dependsOn` metadata on every cron job; substantial content work.
8. **Automated incident dwell-time tracker.** Signal already present (`state.lastChangedAt`); a dedicated visualizer isn't the bottleneck.
9. **Confidence score operational integration (alert suppression at low confidence).** Not requested; out of scope for this pass.
10. **Off-by-one `percentile95` fix.** 95th-percentile computation in `status-self-check.ts:81-94` has a minor floor-vs-ceil choice that slightly inflates the reported p95 on small sample sets (≤20). Impact on classification is negligible. Not fixed here; note for a future focused PR.
11. **Manual status override for maintenance windows.** Useful but distinct feature; needs separate spec.
12. **Audit item 4: `buildFallbackStatusState` on first-ever seed persistence failure drops the `init` transition.** Scoped to the single "database write fails on the very first status evaluation after cold boot" edge case. The next successful cron re-seeds cleanly. Impact is a missing bootstrap transition row, not a runtime bug. Fixing would require a second write-retry loop adding complexity disproportionate to the failure mode. Revisit only if the bootstrap gap ever surfaces as a concrete operator pain.
13. **Audit item 22: confidence score UI tooltip + documentation.** The score (`state.confidence`, 0.1–1.0) is persisted, returned in `/api/status`, and partially rendered in the admin Overview header. Meaning is derivable from `scoreStatusConfidence` (`worker/src/lib/status/evaluation-state.ts`). A docs/tooltip pass (pointing to that function's JSDoc) is a nice polish but does not affect correctness or actionability. Revisit when docs next get a dedicated pass.

# Appendix B — Task dependency summary

- **Task 3** (CSRF header) lands before any new mutating endpoint (Tasks 8–12) so they inherit the wrapper-level guard without new scaffolding.
- **Task 12** (audit log) MUST land before Tasks 8/9/10/11 *in the main branch history*. The Phase 2 intro note covers the two safe sequences (Task 12 first, or stub `logAdminAction` then replace).
- **Task 18a** depends on Task 19 being merged (the blockers expand-all changes are easier to write against the extracted `status-dashboard.tsx`).
- **Task 19** (extract `StatusDashboard`) before **Task 20** (split `status-dashboard-model`) to minimise merge-conflict surface.
- **Task 21** depends on Task 20 being merged (imports the relocated `getSeverityBadgeClass`).
- **Task 24** (merge reads) depends on **Task 2** already landing.
- **Task 23** (parallel `computeRawStatus`) can land independently of Task 2; however, the parallel fan-out changes error-observation order (e.g., `cronHistoryQueryFailed` vs `loadSupplementalStatusSections` errors now interleave). Audit existing order-sensitive tests before landing; none are known today but re-check.
- **Task 27**'s `0 3 * * *` schedule is collision-free against current wrangler crons (`worker/wrangler.toml:34-51` has 08:00 and 06:00 nightly jobs only).

# Appendix C — Rollout staging

- **Backend-safe batch (deploy first):** Tasks 1, 2, 4, 5, 7, 22, 23. No behavior change for end users.
- **Control plane batch (deploy second):** Tasks 3, 12, 8, 9, 10, 11. Introduces the CSRF header and new endpoints.
- **UX batch (deploy third):** Tasks 6, 13, 14, 15, 16, 17, 18, 18a.
- **Code health batch (deploy last):** Tasks 19, 20, 21, 25, 26, 27, 28.

Each batch is PR-sized; four PRs total if the team prefers smaller review units over one big PR.

