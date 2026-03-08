---
title: "Wire dispatch cron into scheduled handler + register in cron-schedule"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "medium"
done: false
---

## Goal

Add `dispatch-telegram-alerts` to both the quarter-hourly and daily cron triggers in `scheduled.ts`, positioned last in each slot. Also register the job in `cron-schedule.ts` for health monitoring.

## Task

1. **`worker/src/lib/cron-schedule.ts`** — Add the dispatch job to `CRON_JOB_DEFINITIONS` (after `status-self-check`, before the closing `] as const`):

```typescript
{ job: "dispatch-telegram-alerts", intervalSec: 900, schedule: CRON_SCHEDULES.quarterHourly },
```

Note: The job also runs on the daily `0 8` trigger, but `CRON_JOB_DEFINITIONS` only supports one schedule per job. Use the quarter-hourly schedule since that's the primary trigger. The daily run is a bonus pass, not separately tracked.

2. **`worker/src/handlers/scheduled.ts`**:

   a. Add import at the top (after other cron imports, around line 18):
   ```typescript
   import { dispatchTelegramAlerts } from "../cron/dispatch-telegram-alerts";
   ```

   b. **Quarter-hourly slot** (line ~156, after the `status-self-check` job and before the staleness alert block):

   Add this after `await runQuarterHourlyJob("status-self-check", ...)`:
   ```typescript
   // Telegram alert dispatch — must run LAST, after sync-stablecoins + compute-dews
   if (env.TELEGRAM_BOT_TOKEN) {
     await runQuarterHourlyJob("dispatch-telegram-alerts", (signal) =>
       dispatchTelegramAlerts(db, env.TELEGRAM_BOT_TOKEN!, signal),
     );
   }
   ```

   c. **Daily 08:00 UTC slot** (line ~273, inside the `daily0800Utc` case):

   The existing `snapshot-safety-grade-history` call needs restructuring to capture its promise so the alert dispatch can chain after it. Find the existing line:
   ```typescript
   ctx.waitUntil(runLeasedCron("snapshot-safety-grade-history", (signal) => snapshotSafetyGradeHistory(db, signal)));
   ```

   Replace it with:
   ```typescript
   const safetyGradePromise = runLeasedCron("snapshot-safety-grade-history", (signal) => snapshotSafetyGradeHistory(db, signal));
   ctx.waitUntil(safetyGradePromise);
   if (env.TELEGRAM_BOT_TOKEN) {
     ctx.waitUntil(safetyGradePromise.then(() =>
       runLeasedCron("dispatch-telegram-alerts-daily", (signal) =>
         dispatchTelegramAlerts(db, env.TELEGRAM_BOT_TOKEN!, signal),
       ),
     ));
   }
   ```

   **Key points:** The safety grade snapshot always runs (unconditionally). Only the dispatch is gated by `env.TELEGRAM_BOT_TOKEN`. The dispatch chains after the snapshot via `.then()` to ensure grades are computed before alert diffing.

## Acceptance Criteria

- `grep -c 'dispatch-telegram-alerts' worker/src/lib/cron-schedule.ts` returns 1
- `grep -c 'dispatchTelegramAlerts' worker/src/handlers/scheduled.ts` returns at least 3 (import + 2 usages)
- `grep -c 'dispatch-telegram-alerts' worker/src/handlers/scheduled.ts` returns at least 2
- The quarter-hourly dispatch is inside `if (env.TELEGRAM_BOT_TOKEN)` guard
- The daily dispatch chains after `safetyGradePromise`
- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
