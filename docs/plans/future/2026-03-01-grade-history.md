# Safety Score Grade History — Autonomous Execution Runbook (Context-Reset Safe)

> Status: Execution-ready  
> Original draft date: March 1, 2026  
> Runbook refresh date: March 5, 2026  
> Scope: Worker (D1 + cron + API), frontend stablecoin detail UI, docs, tests

## Mission

Record and expose **Safety Score** letter-grade transitions for every tracked live stablecoin, then render that history on each stablecoin detail page.

This feature tracks **Pharos Safety Scores** (Risk Lab report cards), not Bluechip `dateLastChange`.

---

## Definition of Done

All conditions must be true:

1. A D1 table persists seed and grade-change events with methodology version.
2. A daily cron job snapshots grades and inserts only seed/change rows (idempotent per day).
3. A public endpoint returns per-coin grade history with input validation and freshness headers.
4. Stablecoin detail page renders a grade history timeline under the Safety Score section.
5. Router + endpoint policy contracts remain aligned.
6. Tests and build checks pass.
7. Documentation is updated to match implementation.

---

## Autonomous Agent Contract

Execute end-to-end without additional user prompts unless a hard blocker occurs.

Hard blockers that justify stopping:

1. Required secrets/env are missing and cannot be mocked for local verification.
2. Migration numbering conflict cannot be resolved safely.
3. Existing uncommitted changes in touched files are semantically incompatible.

If blocked, report:

1. Exact blocker.
2. The command/file that exposed it.
3. The minimal decision needed from the user.

---

## Context Rehydration (Run First After Any Context Clear)

Run these commands before editing:

```bash
pwd
date -u
git rev-parse --short HEAD
git status --short
ls -la worker/migrations | tail -n 40
rg -n "safety_grade_history|snapshot-safety-grade-history|safety-score-history|use-safety-score-history" worker src shared docs -S
rg -n "handleReportCards|computeSafetyScoresSnapshot|daily0800Utc|CRON_JOB_DEFINITIONS|ENDPOINT_DEFINITIONS" worker/src shared/lib -S
```

Interpretation:

1. Expect no existing production implementation for this feature.
2. Confirm current anchor files still exist:
   - `worker/src/api/report-cards.ts`
   - `worker/src/lib/safety-scores.ts`
   - `worker/src/handlers/scheduled.ts`
   - `worker/src/lib/cron-schedule.ts`
   - `worker/src/router.ts`
   - `shared/lib/api-endpoints.ts`
   - `src/app/stablecoin/[id]/client.tsx`
3. If any anchor moved, adapt paths first, then continue with same architecture.

---

## Locked Decisions

1. **Scoring source of truth:** grade history must be produced from the same pipeline as `/api/report-cards`.
2. **Cadence:** daily snapshot at existing `0 8 * * *` slot.
3. **Storage model:** event log (seed row + grade changes), not full daily snapshots.
4. **Versioning:** every event stores `methodology_version`.
5. **Public endpoint path:** `GET /api/safety-score-history?stablecoin=<id>&days=<n>`.
6. **UI scope v1:** timeline only on `/stablecoin/[id]`.
7. **No new external data sources.**

---

## Non-Goals

1. No historical backfill before feature launch date.
2. No global timeline page.
3. No scoring methodology change.
4. No new admin endpoint for manual reseeding.

---

## Runtime Values to Resolve at Execution Time

Resolve these dynamically during implementation:

1. **Migration filename prefix:** choose next available sequence in `worker/migrations/`.
   - Recommended target today: `0048_*` if still free.
2. **Methodology version:** source from `shared/lib/safety-score-version.ts`, never hardcode.
3. **Probe sample stablecoin ID:** use `"1"` unless that contract changes.

---

## Phase 0 — Preflight and Safety

1. Verify workspace status and touched files before edits.
2. Do not revert unrelated dirty changes.
3. Keep edits minimal and isolated to this feature.

Preflight commands:

```bash
npm run lint
cd worker && npx tsc --noEmit
```

If lint has existing warnings, do not widen scope to unrelated cleanup.

---

## Phase 1 — Extract Shared Report-Card Snapshot Builder

### Goal

Eliminate scoring drift risk by giving API + cron one shared snapshot path.

### Files

1. Create `worker/src/lib/report-cards-snapshot.ts`
2. Modify `worker/src/api/report-cards.ts`
3. Add `worker/src/lib/__tests__/report-cards-snapshot.test.ts`

### Required Contract

Create a helper similar to:

```ts
export interface ReportCardsSnapshot {
  cards: ReportCard[];
  methodology: {
    version: string;
    weights: Record<DimensionKey, number>;
    pegMultiplierExponent: number;
    thresholds: { grade: ReportCardGrade; min: number }[];
  };
  dependencyGraph: { edges: { from: string; to: string }[] };
  updatedAt: number;
}

export async function buildReportCardsSnapshot(db: D1Database): Promise<ReportCardsSnapshot> { ... }
```

Implementation rules:

1. Preserve existing API output shape and ordering.
2. Keep all DB/cache reads in worker lib (not `shared/lib`).
3. Keep cemetery card behavior unchanged.
4. Keep dependency ordering/topological behavior unchanged.

### Exit Criteria

1. `/api/report-cards` still passes existing tests.
2. New snapshot helper has focused tests for output parity.

Verification:

```bash
npm test -- worker/src/api/__tests__/report-cards.test.ts worker/src/lib/__tests__/report-cards-snapshot.test.ts
```

---

## Phase 2 — D1 Migration: `safety_grade_history`

### Files

1. Create `worker/migrations/<NEXT>_safety_grade_history.sql`

### Schema (Authoritative)

```sql
CREATE TABLE safety_grade_history (
  stablecoin_id TEXT NOT NULL,
  recorded_at INTEGER NOT NULL, -- UTC day bucket, unix seconds at 00:00:00
  grade TEXT NOT NULL,
  score REAL,
  prev_grade TEXT,
  prev_score REAL,
  methodology_version TEXT NOT NULL,
  PRIMARY KEY (stablecoin_id, recorded_at),
  CHECK (grade IN ('A+','A','A-','B+','B','B-','C+','C','C-','D','F','NR')),
  CHECK (prev_grade IS NULL OR prev_grade IN ('A+','A','A-','B+','B','B-','C+','C','C-','D','F','NR')),
  CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  CHECK (prev_score IS NULL OR (prev_score >= 0 AND prev_score <= 100))
);

CREATE INDEX idx_safety_grade_history_coin
  ON safety_grade_history(stablecoin_id, recorded_at DESC);

CREATE INDEX idx_safety_grade_history_recorded_at
  ON safety_grade_history(recorded_at DESC);
```

### Notes

1. Composite PK guarantees one row per coin/day and enables idempotent reruns.
2. `score` and `prev_score` can be `NULL` for `NR`.
3. No surrogate `id` needed.

### Exit Criteria

Migration applies cleanly locally:

```bash
cd worker && npx wrangler d1 migrations apply stablecoin-db --local
```

---

## Phase 3 — Daily Cron Snapshot Job

### Files

1. Create `worker/src/cron/snapshot-safety-grade-history.ts`
2. Modify `worker/src/handlers/scheduled.ts`
3. Modify `worker/src/lib/cron-schedule.ts`
4. Add `worker/src/cron/__tests__/snapshot-safety-grade-history.test.ts`

### Cron Function Contract

```ts
export async function snapshotSafetyGradeHistory(
  db: D1Database,
  signal?: AbortSignal,
): Promise<CronResult> { ... }
```

### Algorithm

1. Compute `snapshotDay = Math.floor(nowSec / 86400) * 86400`.
2. Build live cards via `buildReportCardsSnapshot(db)`.
3. Exclude `isDefunct === true`.
4. Fetch latest row per stablecoin from `safety_grade_history`.
5. For each live coin:
   - If no prior row: insert seed row (`prev_grade`, `prev_score` = `NULL`).
   - If prior grade differs: insert transition row with `prev_*`.
   - Else: skip.
6. Use `INSERT OR IGNORE` batched statements via `batchExecute(...)`.
7. Return `CronResult` metadata JSON with:
   - `snapshotDay`
   - `methodologyVersion`
   - `seeded`
   - `changed`
   - `skipped`

### Scheduler Wiring

1. Add `snapshot-safety-grade-history` to `CRON_JOB_DEFINITIONS` with:
   - `intervalSec: 86400`
   - `schedule: CRON_SCHEDULES.daily0800Utc`
2. In `handleScheduledEvent` daily branch, add:
   - `ctx.waitUntil(runLeasedCron("snapshot-safety-grade-history", ...))`

Keep it independent from `daily-digest`.

### Exit Criteria

1. Job appears in `CRON_INTERVALS`.
2. Status endpoint will automatically include it.
3. Cron unit tests cover idempotency and change detection.

Verification:

```bash
npm test -- worker/src/cron/__tests__/snapshot-safety-grade-history.test.ts
```

---

## Phase 4 — Public API Endpoint

### Files

1. Create `worker/src/api/safety-score-history.ts`
2. Modify `worker/src/router.ts`
3. Modify `shared/lib/api-endpoints.ts`
4. Add `worker/src/api/__tests__/safety-score-history.test.ts`
5. Update `worker/src/api/__tests__/router-contract.test.ts` as needed
6. Update `worker/src/__tests__/index.fetch.test.ts` as needed

### Endpoint Contract

Path:

1. `GET /api/safety-score-history`

Query params:

1. `stablecoin` required
2. `days` optional, default `365`, bounds `1..3650`

Response shape (ascending by date):

```json
[
  {
    "date": 1771977600,
    "grade": "B+",
    "score": 78,
    "prevGrade": "B",
    "prevScore": 74,
    "methodologyVersion": "5.5"
  }
]
```

Implementation rules:

1. Reuse `parseStablecoinHistoryQuery(...)`.
2. SQL filter by `stablecoin_id` and cutoff.
3. Return empty array on no rows (not 404).
4. Set `Cache-Control` to `CACHE_PROFILES.slow`.
5. Add freshness headers using latest successful `snapshot-safety-grade-history` run timestamp.

### Endpoint Registry Rules

1. Add path in `ENDPOINT_DEFINITIONS` with `methods: ["GET"]`.
2. Add router handler entry in `STATIC_ROUTE_HANDLERS`.
3. If using status probes, provide `probePath: "/api/safety-score-history?stablecoin=1"`.

### Exit Criteria

1. Method guard, router dispatch, and endpoint definitions are all consistent.
2. Tests cover:
   - missing `stablecoin` => 400
   - invalid stablecoin => 400
   - valid request => 200 with typed rows
   - headers include `X-Data-Age`

Verification:

```bash
npm test -- worker/src/api/__tests__/safety-score-history.test.ts worker/src/api/__tests__/router-contract.test.ts worker/src/__tests__/index.fetch.test.ts
```

---

## Phase 5 — Shared Types + Frontend Integration

### Files

1. Modify `shared/types/index.ts`
2. Create `src/hooks/use-safety-score-history.ts`
3. Create `src/components/stablecoin-detail/safety-score-history-section.tsx`
4. Modify `src/app/stablecoin/[id]/client.tsx`
5. Optional: modify `src/hooks/use-prefetch-stablecoin.ts`
6. Add tests:
   - `src/hooks/__tests__/use-safety-score-history.test.ts` (or equivalent hook contract test)
   - `src/components/__tests__/safety-score-history-section.test.tsx`

### Type Additions

Add a new response schema pair in `shared/types/index.ts`, for example:

```ts
export const SafetyScoreHistoryPointSchema = z.object({
  date: z.number(),
  grade: z.string(),
  score: z.number().nullable(),
  prevGrade: z.string().nullable(),
  prevScore: z.number().nullable(),
  methodologyVersion: z.string(),
});

export const SafetyScoreHistoryResponseSchema = z.array(SafetyScoreHistoryPointSchema);
```

Add matching narrow TS interfaces with `ReportCardGrade` where useful.

### Hook Contract

`use-safety-score-history.ts` should:

1. Call `/api/safety-score-history?stablecoin=<id>&days=3650`.
2. Use `useApiQuery`.
3. Use `CRON_24H` polling policy.
4. Include runtime schema validation via `SafetyScoreHistoryResponseSchema`.

### UI Contract

Render timeline inside Safety Score section on detail page.

Behavior:

1. Loading state visible.
2. Empty state visible.
3. Event rows show date + badge + transition summary.
4. Seed row text: `Initial grade`.
5. Transition row text: `<prev> -> <current>`.

No new section in `DETAIL_SECTIONS` nav (stays within existing `report-card` section).

### Exit Criteria

1. Detail page builds and renders without hydration issues.
2. Hook query keys include stablecoin ID to avoid cache collisions.

Verification:

```bash
npm test -- src/hooks/__tests__/query-polling-policy.test.ts
npm run build
```

---

## Phase 6 — Documentation Sync

Update these docs in same PR:

1. `docs/api-reference.md`
2. `docs/architecture.md`
3. `docs/report-cards.md`
4. `docs/worker-infrastructure.md`
5. `docs/testing.md` (if new suites/patterns need explicit mention)

Notes:

1. No `/about` data-source update required.
2. This is feature extension using existing internal data.

---

## Full Verification Matrix (Run Before Merge)

```bash
# Type checks
npm run lint
npm run build
cd worker && npx tsc --noEmit

# Worker unit tests
npm test -- worker/src/api/__tests__/report-cards.test.ts
npm test -- worker/src/lib/__tests__/report-cards-snapshot.test.ts
npm test -- worker/src/cron/__tests__/snapshot-safety-grade-history.test.ts
npm test -- worker/src/api/__tests__/safety-score-history.test.ts
npm test -- worker/src/api/__tests__/router-contract.test.ts worker/src/__tests__/index.fetch.test.ts

# Frontend/unit tests (targeted)
npm test -- src/hooks/__tests__/query-polling-policy.test.ts
npm test -- src/hooks/__tests__/use-safety-score-history.test.ts src/components/__tests__/safety-score-history-section.test.tsx

# Migration
cd worker && npx wrangler d1 migrations apply stablecoin-db --local
```

---

## Manual QA Checklist

1. Start worker locally and hit:
   - `/api/report-cards`
   - `/api/safety-score-history?stablecoin=1&days=3650`
2. Confirm endpoint returns `[]` before first snapshot and 200 status.
3. Trigger or run snapshot job locally, then recheck endpoint.
4. Open `/stablecoin/1` and confirm timeline appears under Safety Score.
5. Confirm stablecoins with no history still render graceful empty state.

---

## Rollout Strategy

1. Deploy migration + code together.
2. Allow first daily snapshot to seed rows.
3. After first run, validate API payload and UI rendering on a few major coins.

---

## Rollback Strategy

If regression occurs:

1. Keep migration (non-breaking additive table).
2. Disable usage path by:
   - removing cron wiring
   - removing endpoint route entry
   - hiding detail-page timeline component
3. Revert code-only changes; table can remain unused safely.

---

## Failure Playbook

Use these diagnostics if behavior is wrong:

```bash
rg -n "snapshot-safety-grade-history|safety-score-history|safety_grade_history" worker/src shared src -S
cd worker && npx wrangler d1 execute stablecoin-db --local --command "SELECT stablecoin_id, recorded_at, grade, prev_grade, methodology_version FROM safety_grade_history ORDER BY recorded_at DESC LIMIT 20;"
cd worker && npx wrangler d1 execute stablecoin-db --local --command "SELECT job, started_at, status, metadata FROM cron_runs WHERE job='snapshot-safety-grade-history' ORDER BY started_at DESC LIMIT 10;"
```

Look for:

1. Duplicate rows per coin/day (should not happen due PK + insert-ignore).
2. Missing cron runs in `cron_runs`.
3. Missing route registration mismatch between router and endpoint definitions.

---

## Risks and Mitigations

1. **Scoring drift** between API and cron.
   - Mitigation: shared snapshot helper in Phase 1.
2. **Idempotency gaps** on reruns.
   - Mitigation: `(stablecoin_id, recorded_at)` PK + `INSERT OR IGNORE`.
3. **Contract drift** between router and endpoint policy map.
   - Mitigation: update both `worker/src/router.ts` and `shared/lib/api-endpoints.ts` in same commit.
4. **Status observability gap** if cron interval map is not updated.
   - Mitigation: add job to `CRON_JOB_DEFINITIONS`.

---

## Completion Output Format (For Autonomous Agent)

When implementation is done, report:

1. Files changed.
2. Commands run.
3. Test/build results.
4. Any residual risks or follow-up tasks.

