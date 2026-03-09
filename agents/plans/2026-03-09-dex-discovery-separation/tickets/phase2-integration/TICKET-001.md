---
title: "Register discovery cron on 20-min trigger + bump methodology to v3.3"
agent: codex
model: gpt-5.3-codex
reasoning_effort: medium
done: false
---

## Goal

Wire `syncDexDiscovery` into the 20-minute cron trigger and register methodology version 3.3.

## Task

1. Read these files:
   - `worker/src/handlers/scheduled.ts` — the cron dispatcher. Focus on lines 191-240 (the `twentyMinuteOffset` case block). Note: `runLeasedCron` is a local closure defined at line 67 inside `handleScheduledEvent` — it is NOT imported, it's available in scope.
   - `worker/src/lib/cron-schedule.ts` — the `CRON_JOB_DEFINITIONS` array and `CRON_SCHEDULES` constants
   - `worker/src/cron/dex-discovery/index.ts` — the `syncDexDiscovery` export
   - `shared/lib/liquidity-score-version.ts` — uses `createMethodologyVersion()` from `./methodology-version`

2. In `worker/src/lib/cron-schedule.ts`, add a new entry to the `CRON_JOB_DEFINITIONS` array:

```typescript
{ job: "sync-dex-discovery", intervalSec: 1200, schedule: CRON_SCHEDULES.twentyMinuteOffset },
```

Add it after the existing `sync-mint-burn` entry (line ~25).

3. In `worker/src/handlers/scheduled.ts`:

Add import at top of file:
```typescript
import { syncDexDiscovery } from "../cron/dex-discovery";
```

In the `twentyMinuteOffset` case block (around line 193), add the discovery cron as an independent `ctx.waitUntil()` call. Place it after the mint-burn block, before the `break`:

```typescript
// DEX pool discovery — no circuit breaker, sequential fetches (1 connection)
ctx.waitUntil(
  runLeasedCron("sync-dex-discovery", (signal) =>
    syncDexDiscovery(db, env.COINGECKO_API_KEY ?? null, signal)
  )
);
```

Note: No circuit breaker gating — discovery uses CG/GT/DexScreener which have their own per-source error handling. The cron runs fully independently via `ctx.waitUntil()`, parallel with blacklist and mint-burn.

4. In `shared/lib/liquidity-score-version.ts`:

Update `currentVersion` from `"3.2"` to `"3.3"` on line 6:
```typescript
currentVersion: "3.3",
```

Add a new entry at the TOP of the `changelog` array (before the v3.2 entry, around line 9):
```typescript
{
  version: "3.3",
  title: "Separated discovery pipeline with staged pool confidence decay",
  date: "2026-03-09",
  effectiveAt: Math.floor(Date.now() / 1000),  // set to deploy timestamp
  summary:
    "Discovery sources (CG Onchain, GeckoTerminal, DexScreener, CG Tickers) now run on an independent 20-minute cron with 3x more budget. Staged pools merged into scoring with freshness confidence decay and explicit defaults contract.",
  impact: [
    "Discovery cron runs independently on 20-min trigger with ~15 min budget (was 5 min shared)",
    "Staged pools receive confidence decay: max(0.5, 1 - ageHours/48), excluded after 24h",
    "Chain-aware source routing reduces wasted API calls by skipping irrelevant chains",
    "Tiered priority with exponential backoff prevents looping on pool-less coins",
  ],
  commits: [],  // fill after merge
  reconstructed: false,
},
```

**Important:** Match the exact schema used by `createMethodologyVersion()`. Look at existing entries for the required fields: `version`, `title`, `date`, `effectiveAt`, `summary`, `impact`, `commits`, `reconstructed`.

5. Verify that `worker/src/cron/dex-liquidity/persistence.ts` imports `LIQUIDITY_METHODOLOGY_VERSION` from the shared module (`@shared/lib/liquidity-score-version`). If it's hardcoded as `"3.2"` anywhere, update the import.

## Acceptance Criteria

- `cd worker && npx tsc --noEmit` exits 0
- `npm run build` exits 0 (full build including frontend)
- `grep -c "syncDexDiscovery" worker/src/handlers/scheduled.ts` returns >= 1
- `grep -c "sync-dex-discovery" worker/src/lib/cron-schedule.ts` returns >= 1
- `grep 'currentVersion' shared/lib/liquidity-score-version.ts` shows `"3.3"`
- The discovery cron uses `ctx.waitUntil()` — verify: `grep -A2 "sync-dex-discovery" worker/src/handlers/scheduled.ts` shows `ctx.waitUntil`
- `grep -c '"3.3"' shared/lib/liquidity-score-version.ts` returns >= 2 (currentVersion + changelog entry)
- The changelog entry has all required fields (version, title, date, effectiveAt, summary, impact, commits, reconstructed)
- `npm test` exits 0 (no regressions)
- `npm run lint` exits 0
