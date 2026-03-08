---
title: "Create alert dispatch cron job"
agent: "codex"
model: "gpt-5.4"
reasoning_effort: "high"
done: false
---

## Goal

Create the cron job that detects DEWS/depeg/safety state changes and dispatches consolidated alert messages to subscribers.

## Context

**Design document:** Read `agents/plans/2026-03-08-telegram-alert-bot-design.md` sections 4 (Alert Dispatch) for full specification: detection logic, fan-out, consolidation, guardrails, message templates, observability metadata.

**Key dependencies (already merged):**
- `worker/src/lib/telegram.ts` exports `sendToChat(chatId, text, botToken, opts)`
- `worker/src/lib/telegram-alerts.ts` exports: `isDewsAlertable`, `isDewsDeescalation`, `formatConsolidatedMessage`, `splitMessage`, type `ConsolidatedAlerts`, `DewsChange`, `DepegEvent`, `DepegResolved`, `SafetyChange`
- `worker/src/lib/db.ts` exports `getCache`, `setCache`
- `worker/src/lib/circuit-breaker.ts` exports `shouldAttemptFetch`, `recordOutcome`
- `worker/src/lib/constants.ts` exports `CIRCUIT_SOURCE` with `TELEGRAM_API`
- D1 tables: `telegram_subscribers`, `telegram_subscriptions`, `stress_signals`, `depeg_events`, `safety_grade_history`, `cache`

## Task

1. **Create `worker/src/cron/dispatch-telegram-alerts.ts`**:

```typescript
import { getCache, setCache } from "../lib/db";
import { sendToChat } from "../lib/telegram";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../lib/constants";
import {
  isDewsAlertable,
  isDewsDeescalation,
  formatConsolidatedMessage,
  splitMessage,
  type ConsolidatedAlerts,
  type DewsChange,
  type DepegEvent,
  type DepegResolved,
  type SafetyChange,
} from "../lib/telegram-alerts";

interface DispatchResult {
  eventsDetected: { dews: number; depeg: number; safety: number };
  subscribersNotified: number;
  messagesSent: number;
  blockedUsersCleanedUp: number;
  cappedAtLimit: boolean;
  snapshotSeeded: boolean;
}

const MAX_MESSAGES_PER_RUN = 50;
const SNAPSHOT_MAX_AGE_SEC = 86400; // 24h

export async function dispatchTelegramAlerts(
  db: D1Database,
  botToken: string,
  signal?: AbortSignal,
): Promise<{ itemCount: number; metadata: string }> {
  // ... implementation below
}
```

2. **Implement the function body** with these sections:

**a. Circuit breaker gate:**
```typescript
const allowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.TELEGRAM_API);
if (!allowed) {
  return { itemCount: 0, metadata: JSON.stringify({ skipped: "circuit-open" }) };
}
```

**b. Snapshot loading + first-run seeding:**
- Load `alert:dews-snapshot`, `alert:depeg-snapshot`, `alert:safety-snapshot` from cache via `getCache()`
- If any snapshot is missing or older than `SNAPSHOT_MAX_AGE_SEC`, seed ALL snapshots with current state and return early with `snapshotSeeded: true`
- Parse snapshots as JSON maps

**c. DEWS detection:**
- Query the most recent score per coin:
  ```sql
  SELECT stablecoin_id, score, band, signals_json
  FROM stress_signals s1
  WHERE computed_at = (SELECT MAX(computed_at) FROM stress_signals s2 WHERE s2.stablecoin_id = s1.stablecoin_id)
  ```
- Diff each coin's `band` against the snapshot
- Only include changes where `isDewsAlertable(newBand)` returns true

**d. Depeg detection:**
- Query `SELECT stablecoin_id, symbol, direction, peak_deviation_bps, start_price, peg_reference FROM depeg_events WHERE ended_at IS NULL`
- Compare active set against snapshot: new entries = triggered, missing entries = resolved
- For resolved events (entries in previous snapshot no longer in active set), query the just-closed event:
  ```sql
  SELECT stablecoin_id, symbol, peak_deviation_bps, started_at, ended_at, recovery_price
  FROM depeg_events
  WHERE stablecoin_id = ? AND ended_at IS NOT NULL
  ORDER BY ended_at DESC LIMIT 1
  ```
  Calculate duration as `ended_at - started_at` (in seconds, convert to minutes). Use `recovery_price` as `recoveryPrice`.

**e. Safety detection:**
- Query the latest grade per coin. Note: `safety_grade_history` snapshots are taken once daily at the same `recorded_at`, so the simple form works here:
  ```sql
  SELECT stablecoin_id, grade, score
  FROM safety_grade_history
  WHERE recorded_at = (SELECT MAX(recorded_at) FROM safety_grade_history)
  ```
- Diff `grade` against snapshot

**f. Fan-out:**
- Collect all changed coin IDs across all alert types
- For each changed coin + type, query subscribers:
  ```sql
  SELECT s.chat_id FROM telegram_subscriptions s
  JOIN telegram_subscribers u ON u.chat_id = s.chat_id
  WHERE s.stablecoin_id = ? AND u.alert_{type} = 1
  ```
- Group all events per `chat_id` into a `ConsolidatedAlerts` object
- Sort subscribers by `last_active_at DESC` (most engaged first)
- For each subscriber (up to `MAX_MESSAGES_PER_RUN`):
  - Build message with `formatConsolidatedMessage`
  - Split if needed with `splitMessage`
  - Determine if any event is a de-escalation (for `disable_notification`)
  - Send via `sendToChat` with `disableWebPagePreview: true`
  - If blocked (403), deactivate: `UPDATE telegram_subscribers SET alert_dews=0, alert_depeg=0, alert_safety=0 WHERE chat_id=?`

**g. Snapshot update:**
- After all sends, write updated snapshots to cache via `setCache()`
- Record circuit breaker outcome

**h. Return metadata:**
```typescript
const result: DispatchResult = {
  eventsDetected: { dews: dewsChanges.length, depeg: depegTriggered.length + depegResolved.length, safety: safetyChanges.length },
  subscribersNotified,
  messagesSent,
  blockedUsersCleanedUp,
  cappedAtLimit: subscriberQueue.length > MAX_MESSAGES_PER_RUN,
  snapshotSeeded: false,
};
return { itemCount: messagesSent, metadata: JSON.stringify(result) };
```

## Acceptance Criteria

- `worker/src/cron/dispatch-telegram-alerts.ts` exists
- `grep -c 'export async function dispatchTelegramAlerts' worker/src/cron/dispatch-telegram-alerts.ts` returns 1
- `grep -c 'shouldAttemptFetch' worker/src/cron/dispatch-telegram-alerts.ts` returns at least 1
- `grep -c 'MAX_MESSAGES_PER_RUN' worker/src/cron/dispatch-telegram-alerts.ts` returns at least 1
- `grep -c 'snapshotSeeded' worker/src/cron/dispatch-telegram-alerts.ts` returns at least 1
- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
