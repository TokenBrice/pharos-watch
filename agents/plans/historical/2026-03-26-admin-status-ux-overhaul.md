# Admin & Status Page UX Overhaul

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/admin/` and `/status/` pages surface critical information first, collapse healthy items into disclosures, move rarely-used admin actions to the bottom, and bring lightweight telegram delivery stats to the public `/status/` page.

**Architecture:** Five independent changes: (1) CircuitBreakerTable gets issues-first rendering with collapsible healthy rows, (2) CacheFreshnessTable gets the same treatment, (3) the admin dashboard model pins the "control" section to the very bottom, (4) the worker health endpoint gains a lightweight `telegramSummary` field, and (5) the status page renders a new telegram delivery card using that field.

**Tech Stack:** React 19, TypeScript strict, Tailwind CSS v4, Cloudflare Workers + D1, Vitest, Zod.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `shared/types/status.ts` | Modify | Add `telegramSummary` to `HealthResponse` + Zod schema |
| `worker/src/api/health.ts` | Modify | Query lightweight telegram stats, include in response |
| `worker/src/api/__tests__/health.test.ts` | Modify | Test telegram summary presence and graceful fallback |
| `src/components/status/circuit-breaker-table.tsx` | Modify | Issues-first with collapsible healthy rows |
| `src/components/status/cache-freshness-table.tsx` | Modify | Issues-first with collapsible healthy rows |
| `src/lib/status-dashboard-model.ts` | Modify | Pin "control" section to bottom (after history) |
| `src/app/status/client.tsx` | Modify | Add telegram delivery summary card |
| `src/app/admin/client.tsx` | Modify | Remove telegram from control, render in dedicated section or update description |

---

### Task 1: Add `telegramSummary` to `HealthResponse` type and Zod schema

**Files:**
- Modify: `shared/types/status.ts:403-459`

- [ ] **Step 1: Add the interface and extend HealthResponse**

In `shared/types/status.ts`, add a `TelegramHealthSummary` interface and an optional `telegramSummary` field to `HealthResponse`. Place the interface just above the `HealthResponse` definition (before line 403):

```typescript
export interface TelegramHealthSummary {
  totalChats: number;
  pendingDeliveries: number;
  lastDispatchAt: number | null;
  lastDispatchStatus: string | null;
}
```

Then add to the `HealthResponse` interface (after the `circuits` field on line 429):

```typescript
  telegramSummary?: TelegramHealthSummary | null;
```

- [ ] **Step 2: Extend the Zod schema**

In the `HealthResponseSchema` (after the `circuits` line at ~line 458), add:

```typescript
  telegramSummary: z.object({
    totalChats: z.number(),
    pendingDeliveries: z.number(),
    lastDispatchAt: z.number().nullable(),
    lastDispatchStatus: z.string().nullable(),
  }).nullable().optional(),
```

- [ ] **Step 3: Verify types compile**

Run: `cd worker && npx tsc --noEmit`
Expected: Clean exit (0 errors)

- [ ] **Step 4: Commit**

```bash
git add shared/types/status.ts
git commit -m "feat(types): add telegramSummary to HealthResponse"
```

---

### Task 2: Query lightweight telegram stats in health endpoint

**Files:**
- Modify: `worker/src/api/health.ts:190-217`
- Modify: `worker/src/api/__tests__/health.test.ts`

- [ ] **Step 1: Write the failing test — telegram summary present**

Add a new test case at the end of the `describe("handleHealth")` block in `worker/src/api/__tests__/health.test.ts`:

```typescript
  it("includes telegramSummary when telegram tables exist", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "mint_burn_hourly", rows: [], first: { total: 0 } },
      { match: "SELECT status", rows: [], first: { status: "ok" } },
      { match: "status = 'ok'", rows: [], first: { started_at: now - 300 } },
      { match: "telegram_subscribers", rows: [], first: { n: 42 } },
      { match: "telegram_pending_alerts", rows: [], first: { n: 3 } },
      { match: "dispatch-telegram-alerts", rows: [], first: { started_at: now - 120, status: "ok" } },
    ]);
    const res = await handleHealth(db);
    const body = (await res.json()) as { telegramSummary: { totalChats: number; pendingDeliveries: number; lastDispatchAt: number | null; lastDispatchStatus: string | null } | null };
    expect(body.telegramSummary).toEqual({
      totalChats: 42,
      pendingDeliveries: 3,
      lastDispatchAt: now - 120,
      lastDispatchStatus: "ok",
    });
  });
```

- [ ] **Step 2: Write the failing test — graceful fallback when tables missing**

Add another test case:

```typescript
  it("returns null telegramSummary when telegram tables do not exist", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "mint_burn_hourly", rows: [], first: { total: 0 } },
      { match: "SELECT status", rows: [], first: { status: "ok" } },
      { match: "status = 'ok'", rows: [], first: { started_at: now - 300 } },
      { match: "telegram_subscribers", rows: [], throwError: new Error("no such table: telegram_subscribers") },
    ]);
    const res = await handleHealth(db);
    const body = (await res.json()) as { telegramSummary: unknown };
    expect(body.telegramSummary).toBeNull();
  });
```

- [ ] **Step 3: Run the tests to confirm they fail**

Run: `cd worker && npx vitest run src/api/__tests__/health.test.ts`
Expected: 2 new tests FAIL (telegramSummary not in response)

- [ ] **Step 4: Implement the telegram summary query in health.ts**

In `worker/src/api/health.ts`, add the import for the new type at the top (update the existing import from `@shared/types/status`):

```typescript
import type { HealthResponse, TelegramHealthSummary } from "@shared/types/status";
```

Then, after the circuit breaker block (after line 209, before the `const status` line), add:

```typescript
  // Lightweight telegram summary — silently null if tables are not migrated
  let telegramSummary: TelegramHealthSummary | null = null;
  if (dbHealthy) {
    try {
      const [chatCount, pendingCount, lastDispatch] = await Promise.all([
        db.prepare("SELECT COUNT(*) AS n FROM telegram_subscribers").first<{ n: number }>(),
        db.prepare("SELECT COUNT(*) AS n FROM telegram_pending_alerts").first<{ n: number }>(),
        db
          .prepare(
            "SELECT started_at, status FROM cron_runs WHERE job = 'dispatch-telegram-alerts' ORDER BY started_at DESC LIMIT 1",
          )
          .first<{ started_at: number; status: string }>(),
      ]);
      telegramSummary = {
        totalChats: chatCount?.n ?? 0,
        pendingDeliveries: pendingCount?.n ?? 0,
        lastDispatchAt: lastDispatch?.started_at ?? null,
        lastDispatchStatus: lastDispatch?.status ?? null,
      };
    } catch {
      // Telegram tables may not be migrated yet — silently null
    }
  }
```

Then update the response body construction (line 214) to include the new field:

```typescript
  const body: HealthResponse = { status, timestamp: now, warnings, caches, blacklist, mintBurn, circuits, telegramSummary };
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `cd worker && npx vitest run src/api/__tests__/health.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: Clean exit

- [ ] **Step 7: Commit**

```bash
git add worker/src/api/health.ts worker/src/api/__tests__/health.test.ts shared/types/status.ts
git commit -m "feat(health): add lightweight telegramSummary to public health endpoint"
```

---

### Task 3: CircuitBreakerTable — issues-first with collapsible healthy rows

**Files:**
- Modify: `src/components/status/circuit-breaker-table.tsx`

- [ ] **Step 1: Rewrite CircuitBreakerTable with issues-first rendering**

Replace the entire `CircuitBreakerTable` component body. The new logic:
1. Partition circuits into `tripped` (open or half-open) and `healthy` (closed).
2. Render tripped circuits in a normal table.
3. Render healthy circuits inside a `<details>` disclosure with a count label.
4. If all circuits are healthy, the entire table body is inside the disclosure.
5. If all circuits are tripped, no disclosure is rendered.

```tsx
export function CircuitBreakerTable({ circuits }: CircuitBreakerTableProps) {
  if (!circuits || Object.keys(circuits).length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Circuit Breakers</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No circuit breakers registered</p>
        </CardContent>
      </Card>
    );
  }

  const entries = Object.entries(circuits);
  const tripped = entries.filter(([, c]) => c.state !== "closed");
  const healthy = entries.filter(([, c]) => c.state === "closed");

  const renderRow = ([name, circuit]: [string, CircuitRecord]) => (
    <tr key={name} className="border-b last:border-0">
      <td className="py-2 font-mono text-xs">{name}</td>
      <td className="py-2">
        {circuit.state === "closed" && (
          <Badge className="bg-green-500/15 text-xs text-green-700 dark:text-green-400">closed</Badge>
        )}
        {circuit.state === "half-open" && (
          <Badge className="bg-amber-500/15 text-xs text-amber-700 dark:text-amber-400">half-open</Badge>
        )}
        {circuit.state === "open" && (
          <Badge className="bg-red-500/15 text-xs text-red-700 dark:text-red-400">open</Badge>
        )}
      </td>
      <td className="py-2 font-mono tabular-nums">{circuit.consecutiveFailures}</td>
      <td className="py-2 text-muted-foreground">
        {circuit.lastFailureAt ? new Date(circuit.lastFailureAt * 1000).toLocaleString() : "—"}
      </td>
      <td className="py-2 text-muted-foreground">
        {circuit.lastSuccessAt ? new Date(circuit.lastSuccessAt * 1000).toLocaleString() : "—"}
      </td>
    </tr>
  );

  const tableHead = (
    <thead>
      <tr className="border-b text-left text-muted-foreground">
        <th scope="col" className="pb-2 font-medium">Name</th>
        <th scope="col" className="pb-2 font-medium">State</th>
        <th scope="col" className="pb-2 font-medium">Failures</th>
        <th scope="col" className="pb-2 font-medium">Last Failure</th>
        <th scope="col" className="pb-2 font-medium">Last Success</th>
      </tr>
    </thead>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Circuit Breakers</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          {tripped.length > 0 && (
            <table className="w-full text-sm">
              {tableHead}
              <tbody>{tripped.map(renderRow)}</tbody>
            </table>
          )}
          {healthy.length > 0 && (
            <details className={tripped.length > 0 ? "mt-4" : undefined}>
              <summary className="cursor-pointer text-sm text-muted-foreground">
                {healthy.length} healthy breaker{healthy.length !== 1 ? "s" : ""}
              </summary>
              <table className="mt-2 w-full text-sm">
                {tripped.length === 0 && tableHead}
                <tbody>{healthy.map(renderRow)}</tbody>
              </table>
            </details>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
```

Note: The `CircuitRecord` type import is already present (line 1). No new imports needed.

- [ ] **Step 2: Verify the build compiles**

Run: `npm run build`
Expected: Clean build with no type errors

- [ ] **Step 3: Commit**

```bash
git add src/components/status/circuit-breaker-table.tsx
git commit -m "feat(status): circuit breaker table shows tripped breakers first, folds healthy"
```

---

### Task 4: CacheFreshnessTable — issues-first with collapsible healthy rows

**Files:**
- Modify: `src/components/status/cache-freshness-table.tsx`

- [ ] **Step 1: Rewrite CacheFreshnessTable with issues-first rendering**

The logic mirrors Task 3:
1. Partition sorted cache entries into `unhealthy` (stale or degraded) and `healthy` (ok/missing).
2. Render unhealthy rows in a visible table.
3. Collapse healthy rows into a `<details>` disclosure.

Replace the component body. Existing imports stay the same. Replace the return statement content (starting at the `return (` on line 57) with:

```tsx
  const unhealthy = sorted.filter(([, cache]) => {
    const status = getCacheFreshnessStatus(cache);
    return status === "stale" || status === "degraded";
  });
  const ok = sorted.filter(([, cache]) => {
    const status = getCacheFreshnessStatus(cache);
    return status !== "stale" && status !== "degraded";
  });

  const renderRow = ([key, cache]: [string, CacheStatus]) => {
    const band = describeBand(cache);
    const modeLabel = cache.mode ?? "live";
    const noteParts = [
      cache.warning,
      cache.consecutiveFallbackRuns != null && cache.consecutiveFallbackRuns > 0
        ? `${cache.consecutiveFallbackRuns} fallback run(s)`
        : null,
    ].filter((part): part is string => !!part);

    return (
      <tr key={key} className="border-b last:border-0">
        <td className="py-2 align-top">
          <div className="font-mono text-xs">{key}</div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            target {formatElapsedSeconds(cache.maxAge)}
          </div>
        </td>
        <td className="py-2 align-top">
          <div>{cache.ageSeconds != null ? formatElapsedSeconds(cache.ageSeconds) : "—"}</div>
          <div className="mt-1 font-mono text-xs text-muted-foreground">
            {band.ratio != null ? `${band.ratio.toFixed(2)}x` : "—"}
          </div>
        </td>
        <td className="py-2 align-top">{describeSource(cache)}</td>
        <td className="py-2 align-top">
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
              modeLabel === "cached-fallback"
                ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                : "bg-muted text-muted-foreground"
            }`}
          >
            {modeLabel}
          </span>
        </td>
        <td className="py-2 align-top">
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${band.className}`}>
            {band.label}
          </span>
        </td>
        <td className="py-2 align-top text-xs leading-relaxed text-muted-foreground">
          {noteParts.length > 0 ? noteParts.join(" · ") : "No extra warning"}
        </td>
      </tr>
    );
  };

  const tableHead = (
    <thead>
      <tr className="border-b text-left text-muted-foreground">
        <th scope="col" className="pb-2 font-medium">Lane</th>
        <th scope="col" className="pb-2 font-medium">Cache</th>
        <th scope="col" className="pb-2 font-medium">Source</th>
        <th scope="col" className="pb-2 font-medium">Mode</th>
        <th scope="col" className="pb-2 font-medium">Band</th>
        <th scope="col" className="pb-2 font-medium">Actionable Note</th>
      </tr>
    </thead>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Cache Freshness</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="mb-3 text-xs text-muted-foreground">
          Availability uses cache ratio thresholds of {">"}{STATUS_CACHE_RATIO_THRESHOLDS.degraded.toFixed(2)}x (degraded) and {">"}{STATUS_CACHE_RATIO_THRESHOLDS.stale.toFixed(2)}x (stale).
        </div>
        <div className="overflow-x-auto">
          {unhealthy.length > 0 && (
            <table className="w-full text-sm">
              {tableHead}
              <tbody>{unhealthy.map(renderRow)}</tbody>
            </table>
          )}
          {ok.length > 0 && (
            <details className={unhealthy.length > 0 ? "mt-4" : undefined}>
              <summary className="cursor-pointer text-sm text-muted-foreground">
                {ok.length} healthy cache{ok.length !== 1 ? "s" : ""}
              </summary>
              <table className="mt-2 w-full text-sm">
                {unhealthy.length === 0 && tableHead}
                <tbody>{ok.map(renderRow)}</tbody>
              </table>
            </details>
          )}
        </div>
      </CardContent>
    </Card>
  );
```

- [ ] **Step 2: Verify the build compiles**

Run: `npm run build`
Expected: Clean build with no type errors

- [ ] **Step 3: Commit**

```bash
git add src/components/status/cache-freshness-table.tsx
git commit -m "feat(status): cache freshness table shows degraded/stale first, folds healthy"
```

---

### Task 5: Pin admin "control" section to the bottom

**Files:**
- Modify: `src/lib/status-dashboard-model.ts:326-417`
- Modify: `src/app/admin/client.tsx:469-506`

- [ ] **Step 1: Update section sort to pin "control" below "history"**

In `src/lib/status-dashboard-model.ts`, the current sort logic (lines 407-417) pins `overview` first and `history` last. Change it to pin `overview` first, then `control` last, then `history` second-to-last:

Replace lines 407-417:
```typescript
  const sections = [...baseSections].sort((a, b) => {
    if (a.id === "overview") return -1;
    if (b.id === "overview") return 1;
    if (a.id === "history") return 1;
    if (b.id === "history") return -1;

    const priorityDelta = sectionPriority[b.id] - sectionPriority[a.id];
    if (priorityDelta !== 0) return priorityDelta;

    return sectionOrder.indexOf(a.id) - sectionOrder.indexOf(b.id);
  });
```

With:
```typescript
  const sections = [...baseSections].sort((a, b) => {
    if (a.id === "overview") return -1;
    if (b.id === "overview") return 1;
    if (a.id === "control") return 1;
    if (b.id === "control") return -1;
    if (a.id === "history") return 1;
    if (b.id === "history") return -1;

    const priorityDelta = sectionPriority[b.id] - sectionPriority[a.id];
    if (priorityDelta !== 0) return priorityDelta;

    return sectionOrder.indexOf(a.id) - sectionOrder.indexOf(b.id);
  });
```

This pins the order: `overview` (first) ... dynamic middle ... `history` (second-to-last) `control` (last).

- [ ] **Step 2: Update the control section description**

In `src/lib/status-dashboard-model.ts`, update the control section's `description` (line 389) to reflect its new position:

```typescript
      description: "Rarely-used recovery actions and operator controls. Positioned last since these are only needed during active incidents.",
```

- [ ] **Step 3: Update control section rendering description in admin client**

In `src/app/admin/client.tsx`, update the description in the `control` section node (line 474):

```typescript
        description="Rarely-used recovery actions and operator controls. Positioned last since these are only needed during active incidents."
```

- [ ] **Step 4: Update the operationalSections filter to also exclude "control"**

In `src/app/admin/client.tsx`, the `operationalSections` variable (line 221) filters sections for the priority lane links in the top fold. Since control is now pinned last (not dynamically sorted), exclude it from the dynamic list:

Replace line 221:
```typescript
  const operationalSections = sections.filter((section) => section.id !== "overview" && section.id !== "history");
```
With:
```typescript
  const operationalSections = sections.filter((section) => section.id !== "overview" && section.id !== "history" && section.id !== "control");
```

- [ ] **Step 5: Verify the build compiles**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 6: Commit**

```bash
git add src/lib/status-dashboard-model.ts src/app/admin/client.tsx
git commit -m "feat(admin): pin operations/control section to bottom of page"
```

---

### Task 6: Add telegram delivery summary to /status/ page

**Files:**
- Modify: `src/app/status/client.tsx`

- [ ] **Step 1: Add telegram summary card to the status page**

In `src/app/status/client.tsx`, add a new `PublicSignalCard` for telegram delivery health inside the "overview" `StatusSection` (after the existing blacklist card, around line 295, before the `</div>` that closes the `xl:grid-cols-2` grid and before the "Surface Impact" card).

First, extract the telegram summary from `healthData` after the existing derived values (after line 172):

```typescript
  const telegramSummary = healthData.telegramSummary ?? null;
```

Then, after the closing `</PublicSignalCard>` for the blacklist card (line 295) and after the closing `</div>` of the 2-col grid (line 296), add a new card before the "Surface Impact" card:

```tsx
          {telegramSummary && (
            <PublicSignalCard
              kicker="Alert Delivery"
              title="Telegram Bot Health"
              description="Aggregate delivery stats for the Pharos Telegram alert bot. Detailed dispatch telemetry is on the operator admin page."
              badges={
                <div className="flex flex-wrap gap-2">
                  <SummaryBadge label="Subscribers" value={String(telegramSummary.totalChats)} />
                  <SummaryBadge
                    label="Pending"
                    value={String(telegramSummary.pendingDeliveries)}
                    className={telegramSummary.pendingDeliveries > 0 ? getStatusTone("degraded").badgeClassName : undefined}
                  />
                  {telegramSummary.lastDispatchStatus && (
                    <SummaryBadge
                      label="Last Dispatch"
                      value={telegramSummary.lastDispatchStatus}
                      className={telegramSummary.lastDispatchStatus !== "ok" ? getStatusTone("stale").badgeClassName : undefined}
                    />
                  )}
                </div>
              }
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-[1rem] border border-border/60 bg-background/78 p-3 shadow-[inset_0_1px_0_oklch(1_0_0_/0.58)] dark:bg-background/35 dark:shadow-none">
                  <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Subscribers</div>
                  <div className="mt-2 font-mono text-sm text-foreground">{telegramSummary.totalChats} chats registered</div>
                </div>
                <div className="rounded-[1rem] border border-border/60 bg-background/78 p-3 shadow-[inset_0_1px_0_oklch(1_0_0_/0.58)] dark:bg-background/35 dark:shadow-none">
                  <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Last Dispatch</div>
                  <div className="mt-2 font-mono text-sm text-foreground">
                    {telegramSummary.lastDispatchAt
                      ? formatTimestampSeconds(telegramSummary.lastDispatchAt)
                      : "No dispatch recorded"}
                  </div>
                </div>
              </div>
              {telegramSummary.pendingDeliveries > 0 && (
                <div className="rounded-[1rem] border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
                  {telegramSummary.pendingDeliveries} alert{telegramSummary.pendingDeliveries !== 1 ? "s" : ""} pending delivery
                </div>
              )}
            </PublicSignalCard>
          )}
```

- [ ] **Step 2: Add telegramSummary badge to the hero section**

In the status page hero section, add a telegram delivery badge to the overview `StatusSection` summary badges (around line 206-214). After the existing `SummaryBadge` for "Major Mint/Burn Stale", add:

```tsx
              {telegramSummary && (
                <SummaryBadge
                  label="Alert Queue"
                  value={String(telegramSummary.pendingDeliveries)}
                  className={telegramSummary.pendingDeliveries > 0 ? getStatusTone("degraded").badgeClassName : undefined}
                />
              )}
```

- [ ] **Step 3: Verify the build compiles**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 4: Commit**

```bash
git add src/app/status/client.tsx
git commit -m "feat(status): add telegram delivery summary card to public status page"
```

---

### Task 7: Final verification

- [ ] **Step 1: Run the full merge gate**

Run: `npm run test:merge-gate`
Expected: All checks pass (lint, type-check, tests, coverage, worker typecheck)

- [ ] **Step 2: Visual verification**

Run `npm run dev` and check:
1. `/status/` — circuit breakers fold healthy, cache table folds healthy, telegram card appears when data exists
2. `/admin/` — "Operations" section is now the last section on the page, circuit breakers and cache tables fold healthy items

- [ ] **Step 3: Commit any remaining fixups**

If the merge gate flagged anything, fix and commit each fix separately.
