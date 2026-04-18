# Telegram Bot Comprehensive Audit Remediation + Enhancements

> **For agentic workers:** Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the PharosWatchBot Telegram implementation, fix verified audit findings, polish user-facing copy, fill gaps on the `/telegram` landing page, and add a `/status <ticker>` command plus additive inline-keyboard UX (snooze + discovery aids).

**Architecture:**
- **Hardening + copy + docs** are in-place edits. No behavior change where not explicitly called out.
- **`/status`** reuses existing D1 reads (`stress_signals`, `safety_grade_history`, `depeg_events`, `price_cache`) and the existing ticker-resolution flow. No new tables.
- **Inline keyboards** are additive. A new `callback_query` branch in the webhook handles button taps. Snooze adds one nullable column to `telegram_subscribers`; the dispatcher checks it during subscriber filtering. Existing text commands remain canonical — buttons merely fire the same server-side primitives.

**Tech Stack:** TypeScript, Cloudflare Workers + D1, Next.js 16 static export, Vitest.

**Out of scope (deliberate):** `/pause`, `/history`, `/mute` toggle, dynamic smart-subscribe (Option B), reactive wizard redesign of `/subscribe`, one-time re-engagement DM, dispatcher refactor, new alert triggers.

---

## File Structure

### Modified
- `worker/src/api/telegram-webhook.ts` — add `callback_query` branch; `handleStatus`; replace `/cancel` "cleared" wording; wire up `handleMute`/`handleUnmuteHours` to use the new helper.
- `worker/src/api/telegram-webhook-store.ts` — extract `upsertSubscriberRow` helper; refactor four call-sites.
- `worker/src/api/telegram-webhook-shared.ts` — update `START_MESSAGE` + `HELP_MESSAGE`; new `ParsedStatusCommand` + `/status` entry.
- `worker/src/api/telegram-webhook-parsing.ts` — recognize `/status`; parse `callback_query` data strings.
- `worker/src/api/telegram-webhook-messages.ts` — `buildStatusMessage`, `buildSnoozeAckMessage`; update `formatQuietHours`.
- `worker/src/lib/telegram-alerts.ts` — copy updates for DEWS signals, depeg triggered/worsening; append snooze reply markup per alert.
- `worker/src/lib/telegram.ts` — add optional `replyMarkup` param to `sendToChat` + `sendBatch`; `answerCallbackQuery`.
- `worker/src/cron/dispatch-telegram-routing.ts` — filter out chats whose `alert_snooze_until_ts > now`.
- `scripts/register-telegram-webhook.sh` — robust JSON parsing, URL validation, include `callback_query` in `allowed_updates`.
- `docs/telegram-alerts.md` — document `/status`, callback flow, snooze column, new copy samples.
- `src/app/telegram/page.tsx` — add missing `/set` examples; "How it works" section; DEWS bands explainer; JSON-LD; fix hardcoded `hover:text-sky-500`; drop unused `common` field.

### Created
- `worker/migrations/0098_telegram_alert_snooze.sql` — `ALTER TABLE telegram_subscribers ADD COLUMN alert_snooze_until_ts INTEGER`. (Latest existing migration in tree is `0097_mbe_flow_type_ts_index.sql`.)
- `worker/src/api/telegram-webhook-callbacks.ts` — callback_query router.
- `worker/src/api/telegram-webhook-status.ts` — `/status` command handler, data loader.
- `worker/src/api/__tests__/telegram-webhook-callbacks.test.ts`
- `worker/src/api/__tests__/telegram-webhook-status.test.ts`

---

## Phase 1 — Hardening

### Task 1: Extract `upsertSubscriberRow` helper (DRY fix for 4 duplicated call-sites)

**Why:** Four different functions in `telegram-webhook-store.ts` re-implement similar "INSERT INTO telegram_subscribers ... ON CONFLICT ..." blocks. Each one covers a slightly different subset of columns, which is brittle — when the next column is added (e.g. `alert_snooze_until_ts`, Task 18), we want one place to edit.

**Files:**
- Modify: `worker/src/api/telegram-webhook-store.ts:91-395`
- Modify: `worker/src/api/telegram-webhook.ts:523-574`
- Test: `worker/src/lib/__tests__/telegram.test.ts` — no changes
- Test: `worker/src/api/__tests__/telegram-webhook.test.ts` — existing integration tests must still pass

- [ ] **Step 1: Write the failing test for `upsertSubscriberRow` isolation**

Create `worker/src/api/__tests__/telegram-webhook-store.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { upsertSubscriberRow } from "../telegram-webhook-store";

describe("upsertSubscriberRow", () => {
  it("updates only quiet-hours columns on a mute-only call", async () => {
    const db = mockD1([]);
    await upsertSubscriberRow(db, {
      chatId: "42",
      username: "alice",
      nowSec: 1700000000,
      quietHours: { enabled: true, startHourUtc: 22, endHourUtc: 7 },
    });
    const [entry] = db.getHistory();
    expect(entry.sql).toContain("ON CONFLICT(chat_id)");
    expect(entry.sql).toContain("quiet_hours_enabled = excluded.quiet_hours_enabled");
    expect(entry.sql).not.toContain("alert_dews = excluded.alert_dews");
    expect(entry.sql).not.toContain("global_alert_dews = excluded.global_alert_dews");
  });

  it("bumps alert flags via MAX when perCoinAlertBumps is set", async () => {
    const db = mockD1([]);
    await upsertSubscriberRow(db, {
      chatId: "42",
      username: null,
      nowSec: 1700000000,
      perCoinAlertBumps: { dews: 1, depeg: 1 },
    });
    const [entry] = db.getHistory();
    expect(entry.sql).toContain(
      "alert_dews = MAX(telegram_subscribers.alert_dews, excluded.alert_dews)",
    );
    expect(entry.sql).toContain(
      "alert_depeg = MAX(telegram_subscribers.alert_depeg, excluded.alert_depeg)",
    );
    expect(entry.sql).not.toContain("alert_safety = MAX");
  });
});
```

- [ ] **Step 2: Run the test — expect import error**

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard
npm test -- worker/src/api/__tests__/telegram-webhook-store.test.ts
```

Expected: `Cannot find module` or `upsertSubscriberRow is not exported`.

- [ ] **Step 3: Implement `upsertSubscriberRow`**

Insert at top of `worker/src/api/telegram-webhook-store.ts`, below the imports:

```typescript
export interface UpsertSubscriberInput {
  chatId: string;
  username: string | null;
  nowSec: number;
  perCoinAlertBumps?: { dews?: 0 | 1; depeg?: 0 | 1; safety?: 0 | 1; launch?: 0 | 1 };
  globalAlertBumps?: { dews?: 0 | 1; depeg?: 0 | 1; safety?: 0 | 1; launch?: 0 | 1 };
  globalAlertOverrides?: { dews?: 0 | 1; depeg?: 0 | 1; safety?: 0 | 1; launch?: 0 | 1 };
  quietHours?:
    | { enabled: true; startHourUtc: number; endHourUtc: number }
    | { enabled: false };
}

/**
 * Upserts a telegram_subscribers row. Any field left undefined preserves
 * existing values on conflict and defaults to 0/NULL on initial insert.
 *
 * - `perCoinAlertBumps` / `globalAlertBumps` use MAX(...) so per-coin actions
 *   never downgrade a flag.
 * - `globalAlertOverrides` replaces the value (used by `/set all ... off`).
 * - `quietHours` replaces unconditionally.
 */
export async function upsertSubscriberRow(
  db: D1Database,
  input: UpsertSubscriberInput,
): Promise<void> {
  const quietEnabled = input.quietHours?.enabled;
  const quietStart =
    input.quietHours?.enabled ? input.quietHours.startHourUtc : null;
  const quietEnd = input.quietHours?.enabled ? input.quietHours.endHourUtc : null;

  const updates: string[] = [
    "username = COALESCE(excluded.username, telegram_subscribers.username)",
    "last_active_at = excluded.last_active_at",
  ];

  const bindBumps = (
    kind: "alert" | "global_alert",
    bumps?: UpsertSubscriberInput["perCoinAlertBumps"],
  ): number[] => {
    if (!bumps) return [0, 0, 0, 0];
    for (const key of ["dews", "depeg", "safety", "launch"] as const) {
      const col = kind === "alert" ? `alert_${key}` : `global_alert_${key}`;
      if (bumps[key] != null) {
        updates.push(
          `${col} = MAX(telegram_subscribers.${col}, excluded.${col})`,
        );
      }
    }
    return [
      bumps.dews ?? 0,
      bumps.depeg ?? 0,
      bumps.safety ?? 0,
      bumps.launch ?? 0,
    ];
  };

  const perCoinRow = bindBumps("alert", input.perCoinAlertBumps);
  const globalRow = bindBumps("global_alert", input.globalAlertBumps);
  if (input.globalAlertOverrides) {
    for (const key of ["dews", "depeg", "safety", "launch"] as const) {
      if (input.globalAlertOverrides[key] != null) {
        updates.push(`global_alert_${key} = excluded.global_alert_${key}`);
        globalRow[["dews", "depeg", "safety", "launch"].indexOf(key)] =
          input.globalAlertOverrides[key] ?? 0;
      }
    }
  }

  if (input.quietHours != null) {
    updates.push(
      "quiet_hours_enabled = excluded.quiet_hours_enabled",
      "quiet_hours_start_utc = excluded.quiet_hours_start_utc",
      "quiet_hours_end_utc = excluded.quiet_hours_end_utc",
    );
  }

  await db
    .prepare(`
      INSERT INTO telegram_subscribers (
        chat_id, username,
        alert_dews, alert_depeg, alert_safety, alert_launch,
        global_alert_dews, global_alert_depeg, global_alert_safety, global_alert_launch,
        quiet_hours_enabled, quiet_hours_start_utc, quiet_hours_end_utc,
        created_at, last_active_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET ${updates.join(", ")}
    `)
    .bind(
      input.chatId,
      input.username,
      ...perCoinRow,
      ...globalRow,
      quietEnabled == null ? 0 : quietEnabled ? 1 : 0,
      quietStart,
      quietEnd,
      input.nowSec,
      input.nowSec,
    )
    .run();
}
```

- [ ] **Step 4: Run new test — expect PASS**

```bash
npm test -- worker/src/api/__tests__/telegram-webhook-store.test.ts
```

Expected: 1 pass.

- [ ] **Step 5: Replace `upsertGlobalAlertTypes` body (lines 91-134) with the helper**

```typescript
export async function upsertGlobalAlertTypes(
  db: D1Database,
  chatId: string,
  username: string | null,
  alertTypes: Set<string>,
): Promise<void> {
  await upsertSubscriberRow(db, {
    chatId,
    username,
    nowSec: unixNow(),
    globalAlertBumps: {
      dews: alertTypes.has("dews") ? 1 : 0,
      depeg: alertTypes.has("depeg") ? 1 : 0,
      safety: alertTypes.has("safety") ? 1 : 0,
      launch: alertTypes.has("launch") ? 1 : 0,
    },
  });
}
```

- [ ] **Step 6: Replace the subscriber INSERT inside `upsertSubscriberAndSubscriptions` (lines 158-192)**

Keep the subscription loop and batch as-is; replace only the subscriber statement. Split into two `db.batch()` calls is not acceptable — D1's batch is atomic per call, so:

```typescript
export async function upsertSubscriberAndSubscriptions(
  db: D1Database,
  chatId: string,
  username: string | null,
  alertTypes: Set<string>,
  stablecoinIds: string[],
  options?: { clearPending?: boolean },
): Promise<void> {
  const now = unixNow();
  const alertDews = alertTypes.has("dews") ? 1 : 0;
  const alertDepeg = alertTypes.has("depeg") ? 1 : 0;
  const alertSafety = alertTypes.has("safety") ? 1 : 0;
  const alertLaunch = alertTypes.has("launch") ? 1 : 0;
  const uniqueStablecoinIds = Array.from(new Set(stablecoinIds));

  // The subscriber row cannot share a batch with subscriptions because the helper
  // uses a single .run(); run it first, then batch the subscriptions.
  await upsertSubscriberRow(db, {
    chatId,
    username,
    nowSec: now,
    perCoinAlertBumps: {
      dews: alertDews,
      depeg: alertDepeg,
      safety: alertSafety,
      launch: alertLaunch,
    },
  });

  const statements: D1PreparedStatement[] = [];
  if (options?.clearPending) {
    statements.push(
      db.prepare("DELETE FROM telegram_pending_disambiguation WHERE chat_id = ?").bind(chatId),
    );
  }
  for (const stablecoinId of uniqueStablecoinIds) {
    statements.push(
      db.prepare(`
        INSERT INTO telegram_subscriptions (
          chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, alert_launch
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
          alert_dews = MAX(telegram_subscriptions.alert_dews, excluded.alert_dews),
          alert_depeg = MAX(telegram_subscriptions.alert_depeg, excluded.alert_depeg),
          alert_safety = MAX(telegram_subscriptions.alert_safety, excluded.alert_safety),
          alert_launch = MAX(telegram_subscriptions.alert_launch, excluded.alert_launch)
      `).bind(chatId, stablecoinId, alertDews, alertDepeg, alertSafety, alertLaunch),
    );
  }
  if (statements.length > 0) await db.batch(statements);
}
```

- [ ] **Step 7: Replace subscriber INSERT inside `applySettingToSubscriptions` (lines 226-268)**

```typescript
export async function applySettingToSubscriptions(
  db: D1Database,
  chatId: string,
  username: string | null,
  coins: ResolvedCoin[],
  command: ParsedSetCommand,
): Promise<void> {
  const now = unixNow();
  const perCoinAlertBumps: UpsertSubscriberInput["perCoinAlertBumps"] = {};
  if (command.setting === "dews" && command.enabled) perCoinAlertBumps.dews = 1;
  if (command.setting === "depeg" && command.enabled) perCoinAlertBumps.depeg = 1;
  if (command.setting === "depeg-step") perCoinAlertBumps.depeg = 1;
  if (command.setting === "safety" && command.enabled) perCoinAlertBumps.safety = 1;

  await upsertSubscriberRow(db, {
    chatId,
    username,
    nowSec: now,
    perCoinAlertBumps,
  });

  const statements: D1PreparedStatement[] = [];
  for (const coin of coins) {
    // ...keep existing switch block unchanged (lines 270-324)
  }
  if (statements.length > 0) await db.batch(statements);
}
```

(Keep the existing `switch (command.setting)` block verbatim.)

- [ ] **Step 8: Replace `applyGlobalSetting` body (lines 343-395)**

```typescript
export async function applyGlobalSetting(
  db: D1Database,
  chatId: string,
  username: string | null,
  command: ParsedSetCommand,
): Promise<void> {
  const key = command.setting === "depeg-step"
    ? (() => { throw new Error("Global depeg-step is not supported"); })()
    : command.setting;
  const override: 0 | 1 = command.enabled ? 1 : 0;

  await upsertSubscriberRow(db, {
    chatId,
    username,
    nowSec: unixNow(),
    globalAlertOverrides: { [key]: override } as Record<string, 0 | 1>,
  });
}
```

- [ ] **Step 9: Replace `handleMute` and `handleUnmuteHours` in `telegram-webhook.ts:510-574`**

```typescript
async function handleMute(
  db: D1Database,
  chatId: string,
  username: string | null,
  args: string,
  botToken: string,
): Promise<void> {
  const parsed = parseQuietHours(args);
  if ("error" in parsed) {
    await replyToChat(chatId, escapeHtml(parsed.error), botToken);
    return;
  }
  await upsertSubscriberRow(db, {
    chatId,
    username,
    nowSec: unixNow(),
    quietHours: {
      enabled: true,
      startHourUtc: parsed.startHourUtc,
      endHourUtc: parsed.endHourUtc,
    },
  });
  await replyToChat(
    chatId,
    escapeHtml(
      `Quiet hours enabled: ${formatQuietHours(parsed.startHourUtc, parsed.endHourUtc)}.\n` +
        `Messages still arrive, but Telegram notifications are silenced in that window.`,
    ),
    botToken,
  );
}

async function handleUnmuteHours(
  db: D1Database,
  chatId: string,
  username: string | null,
  botToken: string,
): Promise<void> {
  await upsertSubscriberRow(db, {
    chatId,
    username,
    nowSec: unixNow(),
    quietHours: { enabled: false },
  });
  await replyToChat(chatId, "Quiet hours disabled.", botToken);
}
```

Add the import at the top of `telegram-webhook.ts`:

```typescript
import { upsertSubscriberRow } from "./telegram-webhook-store";
```

- [ ] **Step 10: Run full webhook test suite**

```bash
npm test -- worker/src/api/__tests__/telegram-webhook
```

Expected: all existing tests still pass. If any fail, they are almost certainly asserting on internal SQL shape; update them to assert on observable behavior instead.

- [ ] **Step 11: Worker type-check**

```bash
cd worker && npx tsc --noEmit && cd -
```

Expected: 0 errors.

- [ ] **Step 12: Commit**

```bash
git add worker/src/api/telegram-webhook-store.ts worker/src/api/telegram-webhook.ts worker/src/api/__tests__/telegram-webhook-store.test.ts
git commit -m "refactor(telegram): extract upsertSubscriberRow helper

Removes four duplicated subscriber INSERT blocks in
telegram-webhook-store.ts and centralizes mute/unmute through the same
path. Behavior unchanged; makes the upcoming snooze column a one-site
addition."
```

---

### Task 2: Rename `/cancel` reply from "cleared" to "cancelled"

**Files:**
- Modify: `worker/src/api/telegram-webhook.ts:144, 204`
- Test: `worker/src/api/__tests__/telegram-webhook.test.ts`

- [ ] **Step 1: Update the two reply strings**

`worker/src/api/telegram-webhook.ts` line 144:
```typescript
await reply("Pending selection cancelled.");
```
`worker/src/api/telegram-webhook.ts` line 204:
```typescript
await reply("No pending selection to cancel.");  // already correct
```

- [ ] **Step 2: Update existing tests that assert on this copy**

```bash
grep -rn "Pending selection cleared" worker/src
```
Replace each occurrence with `Pending selection cancelled`.

- [ ] **Step 3: Run tests and commit**

```bash
npm test -- worker/src/api/__tests__/telegram-webhook
git add worker/src/api/telegram-webhook.ts worker/src/api/__tests__/
git commit -m "chore(telegram): align /cancel reply wording"
```

---

### Task 3: Harden `scripts/register-telegram-webhook.sh`

**Why:** Current grep-based parsing is brittle; script also does not declare `allowed_updates` which is required so Telegram only forwards messages + callback_queries (we'll add callback_query support in Phase 4).

**Files:**
- Modify: `scripts/register-telegram-webhook.sh`

- [ ] **Step 1: Rewrite the script**

Full replacement for `scripts/register-telegram-webhook.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Register the Telegram webhook URL for the Pharos alert bot.
# Usage: TELEGRAM_BOT_TOKEN=xxx TELEGRAM_WEBHOOK_SECRET=yyy ./scripts/register-telegram-webhook.sh

command -v jq >/dev/null 2>&1 || {
  echo "Error: jq is required (brew install jq / apt install jq)" >&2
  exit 1
}

: "${TELEGRAM_BOT_TOKEN:?Error: TELEGRAM_BOT_TOKEN is required}"
: "${TELEGRAM_WEBHOOK_SECRET:?Error: TELEGRAM_WEBHOOK_SECRET is required}"

WEBHOOK_BASE_URL="${WEBHOOK_BASE_URL:-https://api.pharos.watch}"
WEBHOOK_URL="${WEBHOOK_BASE_URL}/api/telegram-webhook"

if [[ ! "${WEBHOOK_URL}" =~ ^https:// ]]; then
  echo "Error: WEBHOOK_URL must use https:// (got: ${WEBHOOK_URL})" >&2
  exit 1
fi

# Secret is passed only in the JSON body; URL is safe to log.
echo "Registering webhook: ${WEBHOOK_URL}"

# allowed_updates explicitly lists accepted update types so Telegram does not
# forward unrelated activity (chat_join_request, poll_answer, etc.). The bot
# uses message for commands and callback_query for inline-keyboard buttons.
PAYLOAD=$(jq -n \
  --arg url "${WEBHOOK_URL}" \
  --arg secret "${TELEGRAM_WEBHOOK_SECRET}" \
  '{url: $url, secret_token: $secret, allowed_updates: ["message", "callback_query"]}')

RESPONSE=$(curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "${PAYLOAD}")

OK=$(echo "${RESPONSE}" | jq -r '.ok // false')
if [ "${OK}" = "true" ]; then
  DESC=$(echo "${RESPONSE}" | jq -r '.description // "registered"')
  echo "OK: ${DESC}"
else
  echo "Error: webhook registration failed." >&2
  echo "${RESPONSE}" | jq . >&2 || echo "${RESPONSE}" >&2
  exit 1
fi
```

- [ ] **Step 2: Lint the script**

```bash
shellcheck scripts/register-telegram-webhook.sh 2>/dev/null || echo "(shellcheck not installed; skip)"
bash -n scripts/register-telegram-webhook.sh
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add scripts/register-telegram-webhook.sh
git commit -m "chore(telegram): harden register-telegram-webhook.sh

- require jq; drop grep-based JSON parsing
- validate WEBHOOK_URL is https://
- explicit allowed_updates=[message, callback_query] so Telegram only
  forwards update types we handle
- printable error output via jq when Telegram rejects the call"
```

---

### Task 4: Fill test coverage gaps flagged in the audit

**Files:**
- Modify: `worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts`
- Modify: `worker/src/api/__tests__/telegram-webhook.test.ts`

- [ ] **Step 1: Add depeg direction reversal test**

Use the real helpers in the file:
- `mockD1([{ match, rows, first }])` for DB data
- `mockGetCache` / `mockSetCache` for snapshots
- `mockSendBatch` / `mockSendToChat` for delivery

Model your test on one of the existing direction/worsening tests in `worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts`. Append:

```typescript
it("treats direction reversal as resolve + new trigger (not worsening)", async () => {
  // Prior snapshot: USDC below peg at 50 bps (id=1).
  // Current: id=1 has ended; id=2 is a new above-peg event at 100 bps.
  mockGetCache.mockImplementation(async (_db, key: string) => {
    if (key === "alert:depeg-snapshot") {
      return JSON.stringify({
        updatedAt: Math.floor(Date.now() / 1000) - 60,
        events: [{
          id: 1, stablecoinId: "usdc-circle", direction: "below",
          deviationBps: 50, price: 0.995, pegReference: 1.0, startedAt: 1700000000,
        }],
      });
    }
    if (key === "alert:dews-snapshot" || key === "alert:dews-alertable-snapshot") {
      return JSON.stringify({ updatedAt: Math.floor(Date.now() / 1000) - 60, events: [] });
    }
    if (key === "alert:safety-snapshot") {
      return JSON.stringify({ updatedAt: Math.floor(Date.now() / 1000) - 60, events: [] });
    }
    if (key === "alert:launch-snapshot") {
      return JSON.stringify({ updatedAt: Math.floor(Date.now() / 1000) - 60, events: [] });
    }
    return null;
  });

  const db = mockD1([
    { match: "FROM stress_signals", rows: [] },
    { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [
      { id: 2, stablecoin_id: "usdc-circle", direction: "above", deviation_bps: 100, price: 1.01, peg_reference: 1.0, started_at: 1700001000 },
    ] },
    // Resolved-event loader: the real SQL selects
    //   FROM depeg_events event JOIN (SELECT stablecoin_id, MAX(ended_at) ... FROM depeg_events WHERE ended_at IS NOT NULL ...)
    // Match on the distinctive JOIN-subquery fragment.
    { match: "FROM depeg_events event", rows: [
      { stablecoin_id: "usdc-circle", symbol: "USDC", peak_deviation_bps: 50, started_at: 1700000000, ended_at: 1700000500, recovery_price: 1.0 },
    ] },
    { match: "FROM safety_grade_history", rows: [] },
    { match: "FROM telegram_subscriptions", rows: [] },
    // Task 14's top-of-dispatch snooze snapshot + per-type global subscribers.
    { match: "WHERE alert_snooze_until_ts IS NOT NULL", rows: [] },
    { match: "SELECT chat_id, last_active_at", rows: [] },
    { match: "FROM telegram_pending_alerts", rows: [] },
  ]);

  const result = await dispatchTelegramAlerts(db, "bot-token");
  const meta = JSON.parse(result.metadata);
  expect(meta.eventsDetected.depegResolved).toBe(1);
  expect(meta.eventsDetected.depegTriggered).toBe(1);
  expect(meta.eventsDetected.depegWorsening ?? 0).toBe(0);
});
```

(All fixture `match` substrings above are grounded against the real SQL: `stress_signals` rows via `"FROM stress_signals"` — line 268 of the dispatcher; active depegs via `"FROM depeg_events WHERE ended_at IS NULL"` — line 278; closed depegs via `"FROM depeg_events event"` — line 414; subscribers via the distinctive snippets added in Task 14.)

- [ ] **Step 2: Run the test and confirm it passes**

```bash
npm test -- worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Add safety UNKNOWN→grade cold-start test**

Append (follow the same `mockGetCache` + `mockD1` pattern as Step 1). The cache should return a `safety-snapshot` with an empty `events` array and `updatedAt` earlier than the `recorded_at` of the new row so the cold-start filter does not drop the alert:

```typescript
it("alerts on UNKNOWN → grade transition when coin missing from snapshot", async () => {
  const oldSnapshotTs = 1699900000;
  mockGetCache.mockImplementation(async (_db, key: string) => {
    if (key === "alert:safety-snapshot") {
      return JSON.stringify({ updatedAt: oldSnapshotTs, events: [] });
    }
    if (key === "alert:dews-snapshot" || key === "alert:dews-alertable-snapshot") {
      return JSON.stringify({ updatedAt: oldSnapshotTs, events: [] });
    }
    if (key === "alert:depeg-snapshot" || key === "alert:launch-snapshot") {
      return JSON.stringify({ updatedAt: oldSnapshotTs, events: [] });
    }
    return null;
  });

  const db = mockD1([
    { match: "FROM stress_signals", rows: [] },
    { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
    { match: "FROM safety_grade_history", rows: [
      { stablecoin_id: "bold-liquity", grade: "B", prev_grade: "A", recorded_at: 1700000000, methodology_version: "v6.0" },
    ] },
    { match: "FROM telegram_subscriptions", rows: [] },
    { match: "WHERE alert_snooze_until_ts IS NOT NULL", rows: [] },
    { match: "SELECT chat_id, last_active_at", rows: [] },
    { match: "FROM telegram_pending_alerts", rows: [] },
  ]);

  const result = await dispatchTelegramAlerts(db, "bot-token");
  const meta = JSON.parse(result.metadata);
  expect(meta.eventsDetected.safety).toBe(1);
});
```

- [ ] **Step 4: Add 403 dedup test**

Model after `mockSendBatch` behaviour: configure it to return a 403 for chat `42` across every batch call, and verify `disableBlockedSubscriber` (real or mocked through the wire) is only invoked once for that chat.

```typescript
it("deduplicates 403 cleanup for a chat hit by multiple chunks in one run", async () => {
  // One subscriber with a lot of per-coin alerts so the consolidated message
  // splits into >1 chunks for chat 42.
  const manyCoins = Array.from({ length: 5 }, (_, i) => ({ stablecoin_id: `coin-${i}`, band: "ALERT", score: 50 }));

  mockGetCache.mockImplementation(async (_db, key: string) => {
    return JSON.stringify({ updatedAt: Math.floor(Date.now() / 1000) - 60, events: [] });
  });

  const db = mockD1([
    { match: "FROM stress_signals", rows: manyCoins.map((c) => ({
      stablecoin_id: c.stablecoin_id, score: c.score, band: c.band, signals_json: "[]",
    })) },
    { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
    { match: "FROM safety_grade_history", rows: [] },
    { match: "FROM telegram_subscriptions", rows: [] },
    // Top-of-dispatch snooze snapshot (Task 14) — empty so nobody is skipped.
    { match: "WHERE alert_snooze_until_ts IS NOT NULL", rows: [] },
    { match: "SELECT chat_id, last_active_at", rows: [
      { chat_id: "42", last_active_at: 0, quiet_hours_enabled: 0, quiet_hours_start_utc: null, quiet_hours_end_utc: null },
    ] },
    { match: "FROM telegram_pending_alerts", rows: [] },
  ]);

  mockSendBatch.mockImplementation(async (messages) => {
    return messages.map((m) => ({
      chatId: m.chatId, ok: false, blocked: true, retryable: false,
      permanentFailure: true, statusCode: 403, errorClass: "blocked",
      delivery: "blocked", retryAfterSec: null,
    }));
  });

  // disableBlockedSubscriber (worker/src/cron/telegram-pending-queue.ts:30-64)
  // emits two statements per call via db.batch: an UPDATE on telegram_subscribers
  // zeroing all alert_* / global_alert_* flags, and an UPDATE on telegram_subscriptions
  // zeroing the four alert_* flags. Count how many times each fires for chat 42.
  await dispatchTelegramAlerts(db, "bot-token");
  const subscriberCleanups = db.getHistory().filter((h) =>
    /UPDATE telegram_subscribers\s+SET alert_dews=0/.test(h.sql) && h.binds.includes("42"),
  );
  const subscriptionCleanups = db.getHistory().filter((h) =>
    /UPDATE telegram_subscriptions\s+SET alert_dews=0/.test(h.sql) && h.binds.includes("42"),
  );
  expect(subscriberCleanups).toHaveLength(1);
  expect(subscriptionCleanups).toHaveLength(1);
});
```

- [ ] **Step 5: Add `/mute preserves alert flags` webhook test**

Append to `worker/src/api/__tests__/telegram-webhook.test.ts`:

```typescript
it("/mute does not overwrite alert flags on ON CONFLICT", async () => {
  const db = mockD1([
    { match: "SELECT action_type, action_payload", rows: [], first: null },
    // no subscriber row exists yet → INSERT path; we only care that the UPDATE
    // clause does not mention alert columns
  ]);
  const res = await handleTelegramWebhook(
    db,
    makeWebhookRequest(42, "/mute 22-07"),
    "test-secret",
    "bot-token",
  );
  expect(res.status).toBe(200);
  const subscriberUpsert = db.getHistory().find((h) =>
    /INSERT INTO telegram_subscribers/.test(h.sql) && /ON CONFLICT\(chat_id\)/.test(h.sql),
  );
  expect(subscriberUpsert).toBeDefined();
  const updateClause = subscriberUpsert!.sql.split("DO UPDATE SET")[1] ?? "";
  expect(updateClause).not.toContain("alert_dews");
  expect(updateClause).not.toContain("alert_depeg");
  expect(updateClause).not.toContain("global_alert_safety");
  expect(updateClause).toContain("quiet_hours_enabled");
});
```

- [ ] **Step 6: Add presets-unavailable error-path test**

```typescript
it("replies with retry message when preset resolution cache is missing", async () => {
  const db = mockD1([
    { match: "SELECT action_type, action_payload", rows: [], first: null },
    // No stablecoins cache → preset resolution fails closed
    { match: "FROM cache WHERE key = ?", matchBinds: ["stablecoins"], rows: [], first: null },
  ]);
  const res = await handleTelegramWebhook(
    db,
    makeWebhookRequest(42, "/subscribe dews usd-top25"),
    "test-secret",
    "bot-token",
  );
  expect(res.status).toBe(200);
  expect(sentMessageBody().text).toContain("temporarily unavailable");
});
```

(If preset resolution reads its cache key via a different helper than `cache` table SELECT, adjust the mock accordingly — read `worker/src/lib/telegram-presets.ts` for the exact source.)

- [ ] **Step 7: Run full webhook + dispatch test suites**

```bash
npm test -- worker/src/api/__tests__/telegram-webhook worker/src/cron/__tests__/dispatch-telegram-alerts
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add worker/src/api/__tests__ worker/src/cron/__tests__
git commit -m "test(telegram): cover depeg-reversal, safety UNKNOWN, 403 dedup, mute-preserves, presets-unavailable"
```

---

## Phase 2 — Copy polish

### Task 5: DEWS signal values as percentages

**Files:**
- Modify: `worker/src/lib/telegram-alerts.ts:257-263`
- Test: `worker/src/lib/__tests__/telegram-alerts.test.ts`

- [ ] **Step 1: Write failing test**

Append to `worker/src/lib/__tests__/telegram-alerts.test.ts`:

```typescript
it("renders DEWS sub-signals as percentages", () => {
  const line = formatDewsLine({
    stablecoinId: "usdt-tether",
    symbol: "USDT",
    oldBand: "WATCH",
    newBand: "ALERT",
    score: 42,
    topSignals: [
      { name: "pool_balance_drift", value: 0.61 },
      { name: "supply_velocity", value: 0.48 },
    ],
  });
  expect(line).toContain("pool_balance_drift (61%)");
  expect(line).toContain("supply_velocity (48%)");
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npm test -- worker/src/lib/__tests__/telegram-alerts.test.ts
```

- [ ] **Step 3: Update `formatDewsLine`**

Replace lines 257-263 of `worker/src/lib/telegram-alerts.ts`:

```typescript
export function formatDewsLine(e: DewsChange): string {
  const signals = e.topSignals
    .slice(0, 2)
    .map((s) => `${s.name} (${Math.round(s.value * 100)}%)`)
    .join(", ");
  return `<b>${escapeHtml(e.symbol)}</b> — ${e.oldBand} → ${e.newBand} (score: ${e.score})${signals ? `\nTop signals: ${signals}` : ""}`;
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
npm test -- worker/src/lib/__tests__/telegram-alerts.test.ts
```

- [ ] **Step 5: Update existing test assertions that hardcoded `0.61` / decimal form**

```bash
grep -rn "(0\.[0-9]*)" worker/src/lib/__tests__/telegram-alerts.test.ts worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts | grep -i "signal\|top"
```

Update each matching assertion to the `%`-form.

- [ ] **Step 6: Commit**

```bash
git add worker/src/lib/telegram-alerts.ts worker/src/lib/__tests__/telegram-alerts.test.ts worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts
git commit -m "feat(telegram): render DEWS sub-signals as percentages"
```

---

### Task 6: Collapse depeg-triggered message to a single line + add worsening delta

**Files:**
- Modify: `worker/src/lib/telegram-alerts.ts:265-278`
- Test: `worker/src/lib/__tests__/telegram-alerts.test.ts`

- [ ] **Step 1: Write failing tests**

Append:

```typescript
it("depeg triggered uses 'below peg by X% (Y bps)' phrasing", () => {
  const line = formatDepegTriggeredLine({
    stablecoinId: "usdc-circle",
    symbol: "USDC",
    direction: "below",
    deviationBps: 112,
    price: 0.9888,
    pegReference: 1.0,
  });
  expect(line).toContain("USDC");
  expect(line).toContain("below peg by 1.1% (112 bps)");
  expect(line).toContain("Price: $0.9888 (peg: $1.00)");
});

it("depeg worsening includes the delta in parens", () => {
  const line = formatDepegWorseningLine({
    stablecoinId: "usdc-circle",
    symbol: "USDC",
    direction: "below",
    previousDeviationBps: 100,
    currentDeviationBps: 200,
    price: 0.98,
    pegReference: 1.0,
  });
  expect(line).toContain("1.0% → 2.0% (+1.0%)");
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Update both formatters**

Replace lines 265-278 of `worker/src/lib/telegram-alerts.ts`:

```typescript
export function formatDepegTriggeredLine(e: DepegAlertPayload): string {
  const pct = (e.deviationBps / 100).toFixed(1);
  return `<b>${escapeHtml(e.symbol)}</b> — ${e.direction} peg by ${pct}% (${e.deviationBps} bps)\nPrice: $${e.price.toFixed(4)} (peg: $${e.pegReference.toFixed(2)})`;
}

export function formatDepegResolvedLine(e: DepegResolved): string {
  const hours = Math.floor(e.durationMinutes / 60);
  const mins = e.durationMinutes % 60;
  const duration = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
  return `<b>${escapeHtml(e.symbol)}</b>\nDuration: ${duration}\nPeak deviation: ${(e.peakDeviationBps / 100).toFixed(1)}%\nRecovery price: $${e.recoveryPrice.toFixed(4)}`;
}

export function formatDepegWorseningLine(e: DepegWorsening): string {
  const prev = (e.previousDeviationBps / 100).toFixed(1);
  const curr = (e.currentDeviationBps / 100).toFixed(1);
  const deltaBps = e.currentDeviationBps - e.previousDeviationBps;
  const deltaPct = (deltaBps / 100).toFixed(1);
  const deltaStr = deltaBps >= 0 ? `+${deltaPct}%` : `${deltaPct}%`;
  return `<b>${escapeHtml(e.symbol)}</b> — ${e.direction} peg worsening\nDeviation: ${prev}% → ${curr}% (${deltaStr})\nPrice: $${e.price.toFixed(4)} (peg: $${e.pegReference.toFixed(2)})`;
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Update alert examples on the /telegram page to match new copy**

Modify `src/app/telegram/page.tsx:44-52`:

```tsx
  {
    key: "depeg",
    label: "Depeg Events",
    tagline: "trigger, worsening milestones, and resolution with price context",
    content: `Depeg Detected

USDC — below peg by 1.1% (112 bps)
Price: $0.9888 (peg: $1.00)

View on Pharos: pharos.watch/stablecoin/usdc-circle`,
    time: "09:43",
  },
```

- [ ] **Step 6: Commit**

```bash
git add worker/src/lib/telegram-alerts.ts worker/src/lib/__tests__/telegram-alerts.test.ts src/app/telegram/page.tsx
git commit -m "feat(telegram): tighter depeg trigger line + worsening delta"
```

---

### Task 7: Quiet-hours format "22:00–07:00 UTC"

**Files:**
- Modify: `worker/src/api/telegram-webhook-messages.ts:252-255`
- Test: `worker/src/lib/__tests__/telegram.test.ts` or a new small test file alongside the messages module

- [ ] **Step 1: Update `formatQuietHours`**

Replace lines 252-255:

```typescript
export function formatQuietHours(startHourUtc: number | null | undefined, endHourUtc: number | null | undefined): string {
  if (startHourUtc == null || endHourUtc == null) return "Off";
  const pad = (h: number) => String(h).padStart(2, "0");
  return `${pad(startHourUtc)}:00–${pad(endHourUtc)}:00 UTC`;
}
```

Note: the " UTC" suffix is now inside `formatQuietHours`; remove the redundant ` UTC` concatenation in `buildGlobalAlertSummaryMessage` (lines 101-104) and `buildListMessage` (lines 119-123):

```typescript
// buildGlobalAlertSummaryMessage
`Quiet hours: ${
  subscriber?.quiet_hours_enabled
    ? formatQuietHours(subscriber.quiet_hours_start_utc, subscriber.quiet_hours_end_utc)
    : "Off"
}`,
```

Also remove the " UTC" trailing in `handleMute`'s reply (now handled by formatter).

- [ ] **Step 2: Update any test asserting on `22-07`**

```bash
grep -rn '"22-07"' worker/src
```

Update each to `22:00–07:00 UTC`.

- [ ] **Step 3: Run tests and commit**

```bash
npm test -- worker
git add worker/src/api/telegram-webhook-messages.ts worker/src/api/telegram-webhook.ts worker/src/api/__tests__/
git commit -m "feat(telegram): quiet-hours display as HH:00–HH:00 UTC"
```

---

### Task 8: START_MESSAGE callouts for underused features

**Why:** Audit shows launch=1.1%, quiet-hours=2.1%, global-alerts=3.5% adoption. Surface these discreetly in `/start` rather than push notifications.

**Files:**
- Modify: `worker/src/api/telegram-webhook-shared.ts:4-25`

- [ ] **Step 1: Replace `START_MESSAGE`**

Replace lines 4-25:

```typescript
export const START_MESSAGE = `<b>Welcome to PharosWatchBot</b>

I send opt-in alerts for the stablecoins you follow, preset watchlists, or all tracked stablecoins by alert type.

Join <a href="https://t.me/pharoswatch">@pharoswatch</a> for Pharos updates and <a href="https://t.me/pharoswatchers">@pharoswatchers</a> for community discussion.

<b>Alert types</b>
- <b>dews</b> — DEWS reaches ALERT, WARNING, or DANGER
- <b>depeg</b> — Depeg triggered, worsened, or resolved
- <b>safety</b> — Safety grade changes
- <b>launch</b> — Pre-launch stablecoin goes live on Pharos

<b>Quick start</b>
<code>/subscribe dews depeg USDC BOLD</code>
<code>/subscribe dews usd-top25</code>
<code>/subscribe safety mcap-ge-1b</code>
<code>/subscribe launch USDPT</code>  ← pre-launch watch
<code>/subscribe safety all</code>
<code>/set USDC depeg-step 250</code>
<code>/mute 22-07</code>  ← quiet hours in UTC

<b>Also useful</b>
<code>/status USDC</code> — one-shot peg + DEWS + safety snapshot
<code>/set all dews on</code> — global alerts across every tracked coin
Inline buttons on each alert let you snooze 1h / 4h / 24h.

Use /help for commands and /presets for preset watchlists.`;
```

- [ ] **Step 2: Update the `/start` snapshot / reply test if one exists**

```bash
grep -rn "Welcome to PharosWatchBot" worker/src/api/__tests__/
```
Update assertions as needed.

- [ ] **Step 3: Commit**

```bash
git add worker/src/api/telegram-webhook-shared.ts worker/src/api/__tests__/
git commit -m "feat(telegram): surface snooze / status / global alerts in /start"
```

---

## Phase 3 — Frontend `/telegram` page

### Task 9: Add missing `/set` examples + remove dead `common` field

**Files:**
- Modify: `src/app/telegram/page.tsx:79-92, 340-355`

- [ ] **Step 1: Expand the Getting Started grid with two new `/set` examples**

Replace the block at `src/app/telegram/page.tsx:347-354` with:

```tsx
                  <div>
                    <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono">/set USDT dews WARNING</code>
                    <p className="mt-1 text-xs text-muted-foreground">Only alert when DEWS reaches WARNING or DANGER</p>
                  </div>
                  <div>
                    <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono">/set DAI safety downgrade-only</code>
                    <p className="mt-1 text-xs text-muted-foreground">Silence upgrades; fire only on safety-grade regressions</p>
                  </div>
                  <div>
                    <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono">/set USDC depeg-step 250</code>
                    <p className="mt-1 text-xs text-muted-foreground">Worsening-depeg milestones every 250 bps</p>
                  </div>
                  <div>
                    <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono">/mute 22-07</code>
                    <p className="mt-1 text-xs text-muted-foreground">Quiet hours overnight (UTC)</p>
                  </div>
```

- [ ] **Step 2: Improve `/set` descriptions in the COMMANDS table + delete unused `common` field**

Replace lines 79-92 with:

```tsx
const COMMANDS = [
  { command: "/subscribe <types> all", description: "Enable alert types across all tracked stablecoins", example: "/subscribe depeg,safety all" },
  { command: "/subscribe <types> <targets>", description: "Enable alert types for coins or preset watchlists", example: "/subscribe dews,depeg USDT,USDC" },
  { command: "/status <ticker>", description: "Current peg, DEWS band, and safety grade for one coin — no subscription needed", example: "/status USDC" },
  { command: "/presets", description: "Show preset watchlists like usd-top25 or mcap-ge-1b", example: "/presets" },
  { command: "/unsubscribe <targets>", description: "Remove specific coin subscriptions or preset-expanded coins", example: "/unsubscribe usd-top25" },
  { command: "/unsubscribe all", description: "Clear all per-coin and all-stablecoin subscriptions", example: null },
  { command: "/set <ticker> <setting> <value>", description: "DEWS floor (WARNING/DANGER), safety direction (downgrade-only/upgrade-only), or depeg-step (100/250/500 bps)", example: "/set USDT dews WARNING" },
  { command: "/set all <setting> <value>", description: "Toggle dews, depeg, safety, or launch across every tracked coin", example: "/set all depeg off" },
  { command: "/mute <start>-<end>", description: "Silence Telegram notifications during UTC quiet hours", example: "/mute 22-07" },
  { command: "/unmutehours", description: "Disable quiet hours", example: null },
  { command: "/list", description: "Show global alerts, subscribed coins, settings, and quiet hours", example: null },
  { command: "/cancel", description: "Cancel a pending disambiguation prompt", example: null },
  { command: "/help", description: "Show command reference", example: null },
] as const;
```

- [ ] **Step 3: Commit**

```bash
git add src/app/telegram/page.tsx
git commit -m "docs(telegram-page): complete /set examples, add /status, drop unused common flag"
```

---

### Task 10: Add "How it works" section (cadence, volume, privacy, DEWS bands)

**Files:**
- Modify: `src/app/telegram/page.tsx` — insert a new section between "What You Get" and "Getting Started"

- [ ] **Step 1: Insert new section after line ~301 (end of What You Get)**

Add before the Getting Started section:

```tsx
        {/* ================================================================= */}
        {/*  HOW IT WORKS (cadence, volume, privacy)                          */}
        {/* ================================================================= */}
        <section className="mt-12" id="how-it-works">
          <h2 className="pharos-section-title">How It Works</h2>
          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Card className="rounded-xl py-0">
              <CardContent className="p-5">
                <p className="text-sm font-semibold">Cadence</p>
                <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
                  The dispatcher runs every 5 minutes. DEWS and depeg alerts arrive within one cycle.
                  Safety grades shift once daily after the safety snapshot, and launch alerts fire
                  within 5 minutes of a pre-launch asset going live.
                </p>
              </CardContent>
            </Card>
            <Card className="rounded-xl py-0">
              <CardContent className="p-5">
                <p className="text-sm font-semibold">Volume</p>
                <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
                  Expect zero alerts on a calm day, a handful during volatility. Dipping
                  back into and out of the same DEWS band in the same cycle is suppressed so
                  you are not paged twice for the same event. Every alert includes snooze
                  buttons (1h / 4h / 24h).
                </p>
              </CardContent>
            </Card>
            <Card className="rounded-xl py-0">
              <CardContent className="p-5">
                <p className="text-sm font-semibold">Privacy</p>
                <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
                  We store your Telegram chat ID and the coins you follow — nothing else.
                  No personal data beyond a username if you have one. Run{" "}
                  <code className="rounded bg-muted px-1 py-0.5 text-[11px] font-mono">/unsubscribe all</code>{" "}
                  at any time to clear your row.
                </p>
              </CardContent>
            </Card>
          </div>

          <div className="mt-5 rounded-lg border border-border/60 bg-muted/30 p-4">
            <p className="text-sm font-semibold">DEWS bands</p>
            <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">
              Pharos scores each coin on five bands. Alerts fire when a coin enters{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px] font-mono">ALERT</code>,{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px] font-mono">WARNING</code>, or{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px] font-mono">DANGER</code>.
              Use <code className="rounded bg-muted px-1 py-0.5 text-[11px] font-mono">/set USDT dews WARNING</code>{" "}
              to raise the floor. See{" "}
              <Link href="/methodology#pegscore-dews-methodology" className="underline underline-offset-4 hover:text-foreground transition-colors">
                the DEWS methodology
              </Link>{" "}
              for scoring details.
            </p>
          </div>
        </section>
```

- [ ] **Step 2: Run dev and eyeball the page**

```bash
npm run dev
```
Open `http://localhost:3000/telegram` and verify layout on mobile and desktop; no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/telegram/page.tsx
git commit -m "feat(telegram-page): add How It Works section with cadence, volume, privacy, DEWS bands"
```

---

### Task 11: Replace hardcoded `hover:text-sky-500` and drop the `#1e3a5f` literal

**Why:** `hover:text-sky-500` is a primitive color. Per `docs/design-tokens.md`, interactive/accent text should use the two-theme pattern or the `--interactive-hover` token. The AlertBubble hex values are intentional (they mimic the Telegram chat bubble) and stay — but the TelegramLink hover is app UI and should follow site conventions.

**Files:**
- Modify: `src/app/telegram/page.tsx:121-134`, `src/app/telegram/page.tsx:240` (the "Browse archive" link)

- [ ] **Step 1: Update `TelegramLink` hover class**

Replace line 127 with:

```tsx
      className="inline-flex items-center gap-1 text-foreground underline underline-offset-4 hover:text-sky-600 dark:hover:text-sky-400 transition-colors"
```

- [ ] **Step 2: Update the inline `Browse archive →` link (line 240)**

```tsx
                <Link href="/digest" className="underline underline-offset-4 hover:text-sky-600 dark:hover:text-sky-400 transition-colors">
                  Browse archive &rarr;
                </Link>
```

- [ ] **Step 3: Commit**

```bash
git add src/app/telegram/page.tsx
git commit -m "style(telegram-page): use light/dark pair for link hover per design tokens"
```

---

### Task 12: JSON-LD `SoftwareApplication` schema + doc link

**Files:**
- Modify: `src/app/telegram/page.tsx`

- [ ] **Step 1: Add a JSON-LD script and a docs link at the page end**

Before the `</FeaturePageShell>` closing tag (around line 459), insert:

```tsx
        <p className="mt-8 text-xs text-muted-foreground">
          Building something on top? See the{" "}
          <Link href="/methodology" className="underline underline-offset-4 hover:text-foreground transition-colors">
            methodology page
          </Link>{" "}
          for scoring details and the <code className="rounded bg-muted px-1 py-0.5 text-[11px] font-mono">/telegram-alerts</code>{" "}
          technical reference in-repo.
        </p>

        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "SoftwareApplication",
              name: "PharosWatchBot",
              applicationCategory: "FinanceApplication",
              operatingSystem: "Telegram",
              offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
              url: `${SITE_URL}/telegram/`,
              description: "Opt-in Telegram bot for stablecoin peg, DEWS, safety, and launch alerts.",
              publisher: { "@type": "Organization", name: "Pharos Watch", url: SITE_URL },
            }),
          }}
        />
```

- [ ] **Step 2: Verify no hydration mismatch**

```bash
npm run dev
```
Open `http://localhost:3000/telegram`, open DevTools console, refresh — expect no hydration warnings.

- [ ] **Step 3: Commit**

```bash
git add src/app/telegram/page.tsx
git commit -m "feat(telegram-page): JSON-LD SoftwareApplication schema + methodology link"
```

---

## Phase 4 — `/status` command + inline keyboards (snooze)

### Task 13: D1 migration for `alert_snooze_until_ts`

**Files:**
- Create: `worker/migrations/0098_telegram_alert_snooze.sql`
- Modify: `worker/migrations/MANIFEST.md`

- [ ] **Step 1: Write the migration**

Create `worker/migrations/0098_telegram_alert_snooze.sql`:

```sql
-- rollout-safety: backward-compatible
-- Add per-chat temporary alert snooze. NULL means no active snooze.
-- When alert_snooze_until_ts > unixepoch(), dispatcher skips fan-out for this chat.
ALTER TABLE telegram_subscribers ADD COLUMN alert_snooze_until_ts INTEGER;
```

- [ ] **Step 2: Append a MANIFEST.md entry**

Add a row to `worker/migrations/MANIFEST.md`:

```markdown
| 0098 | 2026-04-17 | telegram alert snooze | Adds `alert_snooze_until_ts` to `telegram_subscribers` for per-chat temporary snooze from inline-keyboard buttons. |
```

(Match the table format in the file.)

- [ ] **Step 3: Dry-run the migration locally**

```bash
cd worker && npx wrangler d1 migrations apply stablecoin-db --local && cd -
```

Expected: 0098 reports applied.

- [ ] **Step 4: Update `SubscriberRow` type**

`worker/src/api/telegram-webhook-shared.ts:106-118` — add field:

```typescript
export interface SubscriberRow {
  // ... existing fields
  quiet_hours_end_utc: number | null;
  alert_snooze_until_ts: number | null;
}
```

Also update the `SELECT` in `loadSubscriberByChat` (`telegram-webhook-store.ts:66-89`) to read the new column.

- [ ] **Step 5: Commit**

```bash
git add worker/migrations/0098_telegram_alert_snooze.sql worker/migrations/MANIFEST.md worker/src/api/telegram-webhook-shared.ts worker/src/api/telegram-webhook-store.ts
git commit -m "feat(telegram): migration 0098 adds alert_snooze_until_ts column"
```

---

### Task 14: Dispatcher respects snooze (new subscriber filter)

**Files:**
- Modify: `worker/src/cron/dispatch-telegram-alerts.ts:167-249` — two subscriber-loading functions
- Modify: `worker/src/cron/dispatch-telegram-alerts.ts` — extend result metadata
- Modify: `worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts`

Note: the subscriber SELECTs live in `dispatch-telegram-alerts.ts` (`loadSubscriberRowsBatch` at line 167, `loadGlobalSubscriberRows` at line 217). `dispatch-telegram-routing.ts` is an in-memory router and does not touch D1.

- [ ] **Step 1: Write failing test**

Append to `dispatch-telegram-alerts.test.ts`:

```typescript
it("skips a chat whose alert_snooze_until_ts is in the future", async () => {
  const now = Math.floor(Date.now() / 1000);
  mockGetCache.mockImplementation(async (_db, key: string) => {
    return JSON.stringify({ updatedAt: now - 60, events: [] });
  });

  const db = mockD1([
    { match: "FROM stress_signals", rows: [
      { stablecoin_id: "usdc-circle", score: 50, band: "ALERT", signals_json: "[]" },
    ] },
    { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
    { match: "FROM safety_grade_history", rows: [] },
    { match: "FROM telegram_subscriptions", rows: [] },
    // The top-of-dispatch snooze snapshot (the one-shot query added by this task).
    // Matches by the unique substring: WHERE alert_snooze_until_ts IS NOT NULL.
    { match: "WHERE alert_snooze_until_ts IS NOT NULL", rows: [{ chat_id: "A" }] },
    // The per-type global subscriber SELECT now includes the snooze clause.
    // Matches the chat_id + last_active_at projection plus the appended snooze filter.
    { match: "SELECT chat_id, last_active_at", rows: [
      { chat_id: "B", last_active_at: now, quiet_hours_enabled: 0, quiet_hours_start_utc: null, quiet_hours_end_utc: null },
    ] },
    { match: "FROM telegram_pending_alerts", rows: [] },
  ]);

  const result = await dispatchTelegramAlerts(db, "bot-token");
  const meta = JSON.parse(result.metadata);
  expect(meta.messagesSent).toBe(1);
  expect(meta.chatsSuppressedBySnooze).toBe(1);
});
```

- [ ] **Step 2: Add snooze filter to `loadSubscriberRowsBatch` (line 182-197)**

Replace the SELECT in `loadSubscriberRowsBatch`:

```typescript
const result = await db
  .prepare(
    `SELECT sub.stablecoin_id,
            sub.chat_id,
            u.last_active_at,
            sub.dews_min_band,
            sub.safety_mode,
            sub.depeg_worsening_bps_step,
            u.quiet_hours_enabled,
            u.quiet_hours_start_utc,
            u.quiet_hours_end_utc
       FROM telegram_subscriptions sub
       JOIN telegram_subscribers u ON u.chat_id = sub.chat_id
      WHERE sub.stablecoin_id IN (${placeholders})
        AND sub.${alertColumn} = 1
        AND (u.alert_snooze_until_ts IS NULL OR u.alert_snooze_until_ts <= ?)`,
  )
  .bind(...stablecoinIds, Math.floor(Date.now() / 1000))
  .all<SubscriberRow & { stablecoin_id: string }>();
```

- [ ] **Step 3: Add snooze filter to `loadGlobalSubscriberRows` (line 225-237)**

```typescript
const nowSec = Math.floor(Date.now() / 1000);
const baseline = await db
  .prepare(`SELECT COUNT(*) AS n FROM telegram_subscribers WHERE ${alertColumn} = 1`)
  .first<{ n: number }>();
const baselineCount = baseline?.n ?? 0;

const result = await db
  .prepare(
    `SELECT chat_id,
            last_active_at,
            quiet_hours_enabled,
            quiet_hours_start_utc,
            quiet_hours_end_utc
       FROM telegram_subscribers
      WHERE ${alertColumn} = 1
        AND (alert_snooze_until_ts IS NULL OR alert_snooze_until_ts <= ?)`,
  )
  .bind(nowSec)
  .all<SubscriberRow>();

const rows = (result.results ?? []).map((row) => ({
  chat_id: row.chat_id,
  last_active_at: row.last_active_at,
  dews_min_band: null,
  safety_mode: null,
  depeg_worsening_bps_step: null,
  quiet_hours_enabled: row.quiet_hours_enabled ?? 0,
  quiet_hours_start_utc: row.quiet_hours_start_utc ?? null,
  quiet_hours_end_utc: row.quiet_hours_end_utc ?? null,
}));

return rows;
```

Keep the return type of `loadGlobalSubscriberRows` as `Promise<SubscriberRow[]>`; just append the snooze clause to the SELECT and rely on a separate top-level count for the metric.

Final implementation (use this concrete version):

```typescript
// 1. In dispatchTelegramAlerts, after the circuit-breaker check, take a
//    single snapshot of currently-snoozed chats for the run:
const nowSec = Math.floor(Date.now() / 1000);
const snoozedRows = await db
  .prepare(
    "SELECT chat_id FROM telegram_subscribers WHERE alert_snooze_until_ts IS NOT NULL AND alert_snooze_until_ts > ?",
  )
  .bind(nowSec)
  .all<{ chat_id: string }>();
const chatsSuppressedBySnooze = (snoozedRows.results ?? []).length;

// 2. loadSubscriberRowsBatch appends `AND (u.alert_snooze_until_ts IS NULL
//    OR u.alert_snooze_until_ts <= ?)` to the JOIN SELECT, bound to nowSec.
//
// 3. loadGlobalSubscriberRows appends
//    `AND (alert_snooze_until_ts IS NULL OR alert_snooze_until_ts <= ?)`
//    to the global SELECT, bound to nowSec.
//
// 4. buildResult / metadata: include chatsSuppressedBySnooze alongside
//    existing counters.
```

- [ ] **Step 4: Update `docs/telegram-alerts.md`**

Under "Subscriber Filtering", add a bullet:

```markdown
- Chats with `alert_snooze_until_ts > now` are fully skipped for the run. The count surfaces as `chatsSuppressedBySnooze` in dispatch metadata.
```

- [ ] **Step 5: Run tests and commit**

```bash
npm test -- worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts
cd worker && npx tsc --noEmit && cd -
git add worker/src/cron/ docs/telegram-alerts.md
git commit -m "feat(telegram): dispatcher honors alert_snooze_until_ts"
```

---

### Task 15: `/status <ticker>` command — data loader

**Schema note:** There is no `safety_grade_current` or `price_snapshots` table. The real sources are:
- `safety_grade_history` — query the latest row per coin with `ORDER BY recorded_at DESC LIMIT 1`
- `price_cache` — `(asset_id, price, updated_at, ...)` — no peg reference stored; peg math is derived
- `depeg_events` — full peg detail (`direction`, `deviation_bps`, `price`, `peg_reference`, `peak_deviation_bps`, `started_at`) for active events only

The loader returns the active depeg row when present, otherwise just the current price from `price_cache`. It does NOT recompute peg reference in-line — if users want live deviation context on a stable coin, they tap the "View on Pharos" link.

**Files:**
- Create: `worker/src/api/telegram-webhook-status.ts`
- Create: `worker/src/api/__tests__/telegram-webhook-status.test.ts`

- [ ] **Step 1: Write the data-loader test**

`worker/src/api/__tests__/telegram-webhook-status.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { loadStatusForCoin } from "../telegram-webhook-status";

describe("loadStatusForCoin", () => {
  it("returns DEWS + safety + depeg=stable when no active event", async () => {
    const db = mockD1([
      { match: "FROM stress_signals", rows: [{ band: "ALERT", score: 42, recorded_at: 1700000000 }] },
      { match: "FROM safety_grade_history", rows: [{ grade: "B+", score: 66, recorded_at: 1700000000 }] },
      { match: "FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL", rows: [] },
      { match: "FROM price_cache WHERE asset_id = ?", rows: [{ price: 0.9997, updated_at: 1700000000 }] },
    ]);
    const status = await loadStatusForCoin(db, "usdc-circle");
    expect(status.dews?.band).toBe("ALERT");
    expect(status.safety?.grade).toBe("B+");
    expect(status.depeg.status).toBe("stable");
    expect(status.priceUsd).toBeCloseTo(0.9997);
  });

  it("surfaces an active depeg event with direction and deviation", async () => {
    const db = mockD1([
      { match: "FROM stress_signals", rows: [{ band: "WATCH", score: 30, recorded_at: 1700000000 }] },
      { match: "FROM safety_grade_history", rows: [{ grade: "A", score: 80, recorded_at: 1700000000 }] },
      { match: "FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL", rows: [
        { direction: "below", peak_deviation_bps: 180, started_at: 1700000000, peg_reference: 1.0 },
      ] },
      { match: "FROM price_cache WHERE asset_id = ?", rows: [{ price: 0.982, updated_at: 1700000500 }] },
    ]);
    const status = await loadStatusForCoin(db, "usdc-circle");
    expect(status.depeg.status).toBe("active");
    if (status.depeg.status === "active") {
      expect(status.depeg.direction).toBe("below");
      expect(status.depeg.peakDeviationBps).toBe(180);
    }
  });

  it("handles a fully unseeded coin gracefully (null everywhere)", async () => {
    const db = mockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL", rows: [] },
      { match: "FROM price_cache WHERE asset_id = ?", rows: [] },
    ]);
    const status = await loadStatusForCoin(db, "newcoin-xyz");
    expect(status.dews).toBeNull();
    expect(status.safety).toBeNull();
    expect(status.priceUsd).toBeNull();
    expect(status.depeg.status).toBe("stable");
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module not found)**

```bash
npm test -- worker/src/api/__tests__/telegram-webhook-status.test.ts
```

- [ ] **Step 3: Implement `loadStatusForCoin`**

`worker/src/api/telegram-webhook-status.ts`:

```typescript
export interface StatusForCoin {
  stablecoinId: string;
  priceUsd: number | null;
  priceUpdatedAt: number | null;
  dews: { band: string; score: number; recordedAt: number } | null;
  safety: { grade: string; score: number | null; recordedAt: number } | null;
  depeg:
    | { status: "stable" }
    | {
        status: "active";
        direction: "above" | "below";
        peakDeviationBps: number;
        pegReference: number;
        startedAt: number;
      };
}

export async function loadStatusForCoin(
  db: D1Database,
  stablecoinId: string,
): Promise<StatusForCoin> {
  const dewsRow = await db
    .prepare(
      "SELECT band, score, recorded_at FROM stress_signals WHERE stablecoin_id = ? ORDER BY recorded_at DESC LIMIT 1",
    )
    .bind(stablecoinId)
    .first<{ band: string; score: number; recorded_at: number }>();

  const safetyRow = await db
    .prepare(
      "SELECT grade, score, recorded_at FROM safety_grade_history WHERE stablecoin_id = ? ORDER BY recorded_at DESC LIMIT 1",
    )
    .bind(stablecoinId)
    .first<{ grade: string; score: number | null; recorded_at: number }>();

  const depegRow = await db
    .prepare(
      "SELECT direction, peak_deviation_bps, peg_reference, started_at FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
    )
    .bind(stablecoinId)
    .first<{
      direction: "above" | "below";
      peak_deviation_bps: number;
      peg_reference: number;
      started_at: number;
    }>();

  const priceRow = await db
    .prepare("SELECT price, updated_at FROM price_cache WHERE asset_id = ?")
    .bind(stablecoinId)
    .first<{ price: number; updated_at: number }>();

  return {
    stablecoinId,
    priceUsd: priceRow?.price ?? null,
    priceUpdatedAt: priceRow?.updated_at ?? null,
    dews: dewsRow
      ? { band: dewsRow.band, score: dewsRow.score, recordedAt: dewsRow.recorded_at }
      : null,
    safety: safetyRow
      ? { grade: safetyRow.grade, score: safetyRow.score, recordedAt: safetyRow.recorded_at }
      : null,
    depeg: depegRow
      ? {
          status: "active",
          direction: depegRow.direction,
          peakDeviationBps: depegRow.peak_deviation_bps,
          pegReference: depegRow.peg_reference,
          startedAt: depegRow.started_at,
        }
      : { status: "stable" },
  };
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npm test -- worker/src/api/__tests__/telegram-webhook-status.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add worker/src/api/telegram-webhook-status.ts worker/src/api/__tests__/telegram-webhook-status.test.ts
git commit -m "feat(telegram): loadStatusForCoin data loader for /status"
```

---

### Task 16: `/status` command — message formatter + handler

**Files:**
- Modify: `worker/src/api/telegram-webhook-parsing.ts` — recognize `/status`
- Modify: `worker/src/api/telegram-webhook-messages.ts` — add `buildStatusMessage`
- Modify: `worker/src/api/telegram-webhook.ts` — route `/status` to new handler
- Modify: `worker/src/api/telegram-webhook-shared.ts:27-63` — add `/status` to HELP_MESSAGE

- [ ] **Step 1: Recognize `/status` in `parseCommand`**

Add `/status` to the list of recognized commands in `worker/src/api/telegram-webhook-parsing.ts`. (Same pattern as `/subscribe`, `/list`, etc.)

- [ ] **Step 2: Add formatter**

Append to `worker/src/api/telegram-webhook-messages.ts`:

```typescript
import type { StatusForCoin } from "./telegram-webhook-status";

export function buildStatusMessage(symbol: string, s: StatusForCoin): string {
  const priceLine =
    s.priceUsd != null
      ? `Price: $${s.priceUsd.toFixed(4)}`
      : "Price: no recent quote";
  const dewsLine = s.dews
    ? `DEWS: ${s.dews.band} (score ${s.dews.score})`
    : "DEWS: no recent signal";
  const safetyLine = s.safety
    ? `Safety: ${s.safety.grade}${s.safety.score != null ? ` (${s.safety.score})` : ""}`
    : "Safety: UNKNOWN";
  const depegLine =
    s.depeg.status === "active"
      ? `Depeg: ACTIVE — ${s.depeg.direction} peg, peak ${(s.depeg.peakDeviationBps / 100).toFixed(1)}%`
      : "Depeg: stable";
  const lines = [
    `<b>${escapeHtml(symbol)}</b>`,
    priceLine,
    dewsLine,
    safetyLine,
    depegLine,
    `<a href="https://pharos.watch/stablecoin/${s.stablecoinId}">View on Pharos</a>`,
  ];
  return lines.join("\n");
}
```

- [ ] **Step 3: Wire the handler**

In `worker/src/api/telegram-webhook.ts`, add the switch case in the main command switch (around line 203):

```typescript
        case "/status":
          await handleStatus(db, chatId, parsedCommand.args, botToken);
          break;
```

And implement `handleStatus` near the other handlers:

```typescript
async function handleStatus(
  db: D1Database,
  chatId: string,
  args: string,
  botToken: string,
): Promise<void> {
  const trimmed = args.trim();
  if (!trimmed) {
    await replyToChat(chatId, "Usage: /status <ticker>", botToken);
    return;
  }
  const resolution = resolveTicker(trimmed);
  if (resolution.status === "not_found") {
    await replyToChat(chatId, buildNotFoundMessage(trimmed, resolution.suggestion), botToken);
    return;
  }
  if (resolution.status === "ambiguous") {
    // /status is read-only — do not set pending disambiguation state.
    // Present the candidate list so the user can re-run with a coin ID.
    await replyToChat(chatId, escapeHtml(formatDisambiguation(trimmed, resolution.matches)), botToken);
    return;
  }
  const coin = resolution.matches[0];
  const status = await loadStatusForCoin(db, coin.id);
  await replyToChat(chatId, buildStatusMessage(coin.symbol, status), botToken);
}
```

Add the imports at the top of `telegram-webhook.ts`:

```typescript
import { loadStatusForCoin } from "./telegram-webhook-status";
import { buildStatusMessage } from "./telegram-webhook-messages";
```

- [ ] **Step 4: Extend HELP_MESSAGE**

In `worker/src/api/telegram-webhook-shared.ts:27-63`, add before `/mute`:

```typescript
<code>/status &lt;ticker&gt;</code>
Current peg, DEWS band, and safety grade for one coin — no subscription needed

```

- [ ] **Step 5: Integration test for `/status`**

Append to `worker/src/api/__tests__/telegram-webhook.test.ts` (uses the file's existing `mockD1`, `makeWebhookRequest`, `handleTelegramWebhook`, and `sentMessageBody` helpers):

```typescript
it("/status USDC replies with a compact card", async () => {
  const db = mockD1([
    { match: "SELECT action_type, action_payload", rows: [], first: null },
    { match: "FROM stress_signals", rows: [
      { band: "CALM", score: 15, recorded_at: 1700000000 },
    ] },
    { match: "FROM safety_grade_history", rows: [
      { grade: "A", score: 85, recorded_at: 1700000000 },
    ] },
    { match: "FROM price_cache WHERE asset_id = ?", rows: [
      { price: 0.9999, updated_at: 1700000000 },
    ] },
    { match: "FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL", rows: [] },
  ]);
  const res = await handleTelegramWebhook(
    db,
    makeWebhookRequest(1, "/status USDC"),
    "test-secret",
    "bot-token",
  );
  expect(res.status).toBe(200);
  const body = sentMessageBody().text;
  expect(body).toContain("USDC");
  expect(body).toContain("CALM");
  expect(body).toContain("Safety: A");
  expect(body).toContain("Depeg: stable");
  expect(body).toContain("Price: $0.9999");
});
```

- [ ] **Step 6: Run all tests and commit**

```bash
npm test -- worker
cd worker && npx tsc --noEmit && cd -
git add worker/src/api/
git commit -m "feat(telegram): /status <ticker> ad-hoc coin snapshot"
```

---

### Task 17: `callback_query` handler (inline keyboard plumbing)

**Files:**
- Create: `worker/src/api/telegram-webhook-callbacks.ts`
- Create: `worker/src/api/__tests__/telegram-webhook-callbacks.test.ts`
- Modify: `worker/src/api/telegram-webhook.ts` — add `callback_query` branch
- Modify: `worker/src/api/telegram-webhook-shared.ts` — extend `TelegramWebhookUpdate` type
- Modify: `worker/src/lib/telegram.ts` — add `answerCallbackQuery`, optional `reply_markup` on sends

- [ ] **Step 1: Extend the update type**

`worker/src/api/telegram-webhook-shared.ts:75-84`:

```typescript
export interface TelegramWebhookUpdate {
  update_id?: number;
  message?: {
    chat?: { id?: number; username?: string };
    text?: string;
  };
  callback_query?: {
    id: string;
    data?: string;
    from?: { username?: string };
    message?: { chat?: { id?: number }; message_id?: number };
  };
}
```

- [ ] **Step 2: Add `answerCallbackQuery` + thread `replyMarkup` through the existing send path**

Existing shape confirmed by inspection (`worker/src/lib/telegram.ts:196-243, 245-269`):

- `sendToChat(chatId, text, botToken, opts?: SendToChatOpts)` — `opts` has `disableWebPagePreview`, `disableNotification`, and similar toggles.
- `BatchMessage { chatId, html, disableNotification }` — `sendBatch(messages, botToken, batchSize)` — third arg is the batch size.

So: add `replyMarkup?: unknown` to `SendToChatOpts`, forward it to the `sendMessage` body, and extend `BatchMessage` with `replyMarkup?: unknown`. `sendBatch` passes the per-message markup to `sendToChat`.

In `worker/src/lib/telegram.ts`, extend the `SendToChatOpts` interface (search for it near the top of the file). Adjust the body builder inside `sendToChat` to include `reply_markup` when present:

```typescript
body: JSON.stringify({
  chat_id: chatId,
  text,
  parse_mode: "HTML",
  ...(opts?.disableWebPagePreview && { disable_web_page_preview: true }),
  ...(opts?.disableNotification && { disable_notification: true }),
  ...(opts?.replyMarkup != null && { reply_markup: opts.replyMarkup }),
}),
```

Extend `BatchMessage`:

```typescript
export interface BatchMessage {
  chatId: string;
  html: string;
  disableNotification: boolean;
  replyMarkup?: unknown;
}
```

Update `sendBatch`'s inner call to thread the markup per message (line ~275):

```typescript
const result = await sendToChat(msg.chatId, msg.html, botToken, {
  disableWebPagePreview: true,
  disableNotification: msg.disableNotification,
  replyMarkup: msg.replyMarkup,
});
```

Add `answerCallbackQuery` at the bottom of the file:

```typescript
export async function answerCallbackQuery(
  callbackQueryId: string,
  botToken: string,
  options: { text?: string; showAlert?: boolean } = {},
): Promise<void> {
  const res = await fetch(
    `https://api.telegram.org/bot${botToken}/answerCallbackQuery`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text: options.text,
        show_alert: options.showAlert ?? false,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  await drainResponseBody(res);
}
```

(Reuse the file's existing `drainResponseBody` helper — it is what every other send path calls to stay under the Workers 6-connection cap. Do NOT use `.then((r) => r.body?.cancel())` — `drainResponseBody` is canonical.)

- [ ] **Step 3: Write the callback-router test**

`worker/src/api/__tests__/telegram-webhook-callbacks.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";
import { handleCallbackQuery } from "../telegram-webhook-callbacks";

describe("handleCallbackQuery", () => {
  let db: D1Database;
  let run: ReturnType<typeof vi.fn>;
  let bind: ReturnType<typeof vi.fn>;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    run = vi.fn().mockResolvedValue({});
    bind = vi.fn().mockReturnValue({ run });
    db = { prepare: vi.fn().mockReturnValue({ bind }) } as unknown as D1Database;
    fetchSpy = vi.fn().mockResolvedValue({ body: { cancel: vi.fn() } });
    vi.stubGlobal("fetch", fetchSpy);
  });

  it("snooze:1h sets alert_snooze_until_ts ~1h in the future", async () => {
    vi.setSystemTime(new Date("2026-04-17T12:00:00Z"));
    await handleCallbackQuery(db, "fake-token", {
      id: "cb1",
      data: "snooze:1h",
      from: { username: "alice" },
      message: { chat: { id: 42 }, message_id: 999 },
    });
    // UPDATE telegram_subscribers SET alert_snooze_until_ts = ? WHERE chat_id = ?
    const sqlCall = (db.prepare as ReturnType<typeof vi.fn>).mock.calls.find((c) => String(c[0]).includes("alert_snooze_until_ts"));
    expect(sqlCall).toBeDefined();
    const ttl = (bind as ReturnType<typeof vi.fn>).mock.calls.find((c) => typeof c[0] === "number" && c[0] > 1776384000)?.[0];
    expect(ttl).toBeGreaterThan(Math.floor(Date.now() / 1000) + 3500);
    // answerCallbackQuery should be called
    const ackCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
    expect(ackCall).toBeDefined();
  });

  it("unknown callback data returns a graceful ack", async () => {
    await handleCallbackQuery(db, "fake-token", {
      id: "cb2",
      data: "garbage:whatever",
      message: { chat: { id: 42 }, message_id: 999 },
    });
    const ackCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes("answerCallbackQuery"));
    expect(ackCall).toBeDefined();
  });
});
```

- [ ] **Step 4: Implement the callback router**

`worker/src/api/telegram-webhook-callbacks.ts`:

```typescript
import { answerCallbackQuery } from "../lib/telegram";
import { upsertSubscriberRow } from "./telegram-webhook-store";
import { unixNow } from "./telegram-webhook-store";

const SNOOZE_SECONDS: Record<string, number> = {
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
  "24h": 24 * 60 * 60,
};

interface CallbackQuery {
  id: string;
  data?: string;
  from?: { username?: string };
  message?: { chat?: { id?: number }; message_id?: number };
}

/**
 * Routes inline-keyboard callback_query events. Data format: `action:arg`.
 * Currently: `snooze:1h|4h|24h`. Unknown codes receive a silent ack.
 */
export async function handleCallbackQuery(
  db: D1Database,
  botToken: string,
  cb: CallbackQuery,
): Promise<void> {
  const chatId = cb.message?.chat?.id?.toString();
  const data = cb.data ?? "";
  const username = cb.from?.username ?? null;

  if (!chatId) {
    await answerCallbackQuery(cb.id, botToken);
    return;
  }

  const [action, arg] = data.split(":");
  if (action === "snooze" && arg in SNOOZE_SECONDS) {
    const now = unixNow();
    const until = now + SNOOZE_SECONDS[arg];
    // Ensure subscriber row exists, then update snooze column.
    await upsertSubscriberRow(db, { chatId, username, nowSec: now });
    await db
      .prepare(
        "UPDATE telegram_subscribers SET alert_snooze_until_ts = ?, last_active_at = ? WHERE chat_id = ?",
      )
      .bind(until, now, chatId)
      .run();
    await answerCallbackQuery(cb.id, botToken, {
      text: `Snoozed for ${arg}. Use /list to verify or tap a longer window.`,
    });
    return;
  }

  await answerCallbackQuery(cb.id, botToken, { text: "Action not recognized." });
}
```

- [ ] **Step 5: Wire `callback_query` into the webhook**

In `worker/src/api/telegram-webhook.ts`, after the `chatId / text` check at line 113, add:

```typescript
    if (update.callback_query) {
      try {
        await handleCallbackQuery(db, botToken, update.callback_query);
      } catch (err) {
        console.error("[telegram-webhook] callback_query failed:", err);
      }
      return ok();
    }
```

Add the import:

```typescript
import { handleCallbackQuery } from "./telegram-webhook-callbacks";
```

- [ ] **Step 6: Run tests and commit**

```bash
npm test -- worker/src/api/__tests__/telegram-webhook-callbacks.test.ts worker/src/api/__tests__/telegram-webhook.test.ts
cd worker && npx tsc --noEmit && cd -
git add worker/src/api/ worker/src/lib/telegram.ts
git commit -m "feat(telegram): callback_query router + /snooze buttons backend"
```

---

### Task 18: Append snooze buttons to every fan-out alert

**Files:**
- Modify: `worker/src/lib/telegram-alerts.ts` — add helper returning the reply_markup
- Modify: `worker/src/cron/dispatch-telegram-routing.ts` (or wherever `sendBatch` is called for fresh alerts) — pass `replyMarkup` through
- Modify: `worker/src/cron/telegram-pending-queue.ts` — pending queue drains must also include the markup (store the serialized markup alongside `message_html` OR reconstruct at drain time; cheaper + simpler: reconstruct at drain time since markup is constant)

- [ ] **Step 1: Define the markup constant**

Add to `worker/src/lib/telegram-alerts.ts`:

```typescript
export const SNOOZE_REPLY_MARKUP = {
  inline_keyboard: [[
    { text: "Snooze 1h", callback_data: "snooze:1h" },
    { text: "4h", callback_data: "snooze:4h" },
    { text: "24h", callback_data: "snooze:24h" },
  ]],
} as const;
```

- [ ] **Step 2: Attach `replyMarkup` to each `BatchMessage` that goes to a subscriber**

`sendBatch`'s third arg is `batchSize`, not an options object. The markup travels on each `BatchMessage` item instead. Find where `BatchMessage[]` arrays are constructed for fresh fan-out (likely inside `dispatch-telegram-routing.ts`'s `expandSubscriberChunks`-style helper and inside `telegram-pending-queue.ts`'s pending-drain builder) and set `replyMarkup: SNOOZE_REPLY_MARKUP` on each item:

```typescript
const messages: BatchMessage[] = chunks.map((html) => ({
  chatId: routed.chatId,
  html,
  disableNotification: routed.disableNotification,
  replyMarkup: SNOOZE_REPLY_MARKUP,
}));
await sendBatch(messages, botToken, SEND_BATCH_SIZE);
```

Do NOT add the markup to digest posting (`postDigestToTelegram`) — that's a channel post where users can't individually snooze.

- [ ] **Step 3: Pending-queue drain carries markup too**

In `worker/src/cron/telegram-pending-queue.ts` wherever the pending row is re-sent, set `replyMarkup: SNOOZE_REPLY_MARKUP` on the `BatchMessage`. The pending D1 row only stores `message_html`; markup is applied at send time, not stored, so no schema change is needed.

- [ ] **Step 4: Update test to assert the markup is included**

Add to `worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts`:

```typescript
it("includes the snooze inline keyboard on subscriber alerts", async () => {
  mockGetCache.mockImplementation(async (_db, _key: string) =>
    JSON.stringify({ updatedAt: Math.floor(Date.now() / 1000) - 60, events: [] }),
  );
  const db = mockD1([
    { match: "FROM stress_signals", rows: [
      { stablecoin_id: "usdc-circle", score: 50, band: "ALERT", signals_json: "[]" },
    ] },
    { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
    { match: "FROM safety_grade_history", rows: [] },
    { match: "FROM telegram_subscriptions", rows: [] },
    { match: "WHERE alert_snooze_until_ts IS NOT NULL", rows: [] },
    { match: "SELECT chat_id, last_active_at", rows: [
      { chat_id: "42", last_active_at: 0, quiet_hours_enabled: 0, quiet_hours_start_utc: null, quiet_hours_end_utc: null },
    ] },
    { match: "FROM telegram_pending_alerts", rows: [] },
  ]);

  await dispatchTelegramAlerts(db, "bot-token");

  // sendBatch(messages, botToken, batchSize) — inspect the BatchMessage array
  // to confirm per-message replyMarkup is set.
  const [messages] = mockSendBatch.mock.calls.at(-1) ?? [];
  expect(messages?.[0]?.replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data).toBe("snooze:1h");
});
```

- [ ] **Step 5: Run tests and commit**

```bash
npm test -- worker/src/cron/__tests__ worker/src/lib/__tests__/telegram
cd worker && npx tsc --noEmit && cd -
git add worker/src/lib/telegram-alerts.ts worker/src/cron/
git commit -m "feat(telegram): snooze inline keyboard on every subscriber alert"
```

---

### Task 19: Documentation sync

**Files:**
- Modify: `docs/telegram-alerts.md`

- [ ] **Step 1: Add new sections**

Update `docs/telegram-alerts.md`:

1. Under "Supported Commands" (line 95), add a row:
   ```markdown
   | `/status <ticker>` | Returns a compact snapshot: current peg, DEWS band, safety grade, and active-depeg state for the given coin. No subscription required. |
   ```

2. Under "D1 Schema" (the `telegram_subscribers` row), append `alert_snooze_until_ts` to the key fields list.

3. Add a new section "Inline Keyboards (Callback Queries)" after "Webhook Command Flow":
   ```markdown
   ## Inline Keyboards (Callback Queries)

   Every subscriber alert sent from the dispatcher carries an inline keyboard
   `[Snooze 1h | 4h | 24h]`. Tapping a button yields a Telegram `callback_query`
   update, routed to `worker/src/api/telegram-webhook-callbacks.ts`. The handler
   writes `alert_snooze_until_ts = unixepoch() + <seconds>` and answers the
   callback with a short confirmation toast.

   The callback data format is `action:arg` (≤64 bytes, the Bot API limit).
   Current actions:
   - `snooze:1h | 4h | 24h`

   Unknown action codes receive a silent ack; they are not treated as errors
   so the bot remains forward-compatible with future keyboards.

   Registration script `scripts/register-telegram-webhook.sh` declares
   `allowed_updates = ["message", "callback_query"]` so Telegram forwards only
   update types the bot handles.
   ```

4. Under "Subscriber Filtering", confirm the bullet added in Task 14 is present.

- [ ] **Step 2: Update webhook registration docs**

Under "Operational Notes":

```markdown
- The webhook `setWebhook` call declares `allowed_updates=["message","callback_query"]` so Telegram does not forward unrelated update types. After deploying Phase 4 for the first time, re-run `scripts/register-telegram-webhook.sh` (or wait for the five-minute reconciliation lane) so the `callback_query` subscription takes effect.
```

- [ ] **Step 3: Verify doc-count drift guard still passes**

```bash
npm run check:doc-counts 2>/dev/null || echo "(guard not in this repo; skip)"
```

- [ ] **Step 4: Commit**

```bash
git add docs/telegram-alerts.md
git commit -m "docs(telegram): document /status, callback_query, snooze, allowed_updates"
```

---

## Phase-wide sanity + release gate

### Task 20: Run the full merge-gate before opening a PR

- [ ] **Step 1: Run tests + type-check + lint**

```bash
npm run lint
npm test
cd worker && npx tsc --noEmit && cd -
npm run test:merge-gate
```

Expected: all green.

- [ ] **Step 2: Smoke-test a dispatch run locally**

```bash
cd worker && npx wrangler dev
```

Trigger a cron from another terminal:

```bash
curl -sS "http://localhost:8787/__scheduled?cron=2%20*%20*%20*%20*"
```

Expected: no errors in the logs; `snapshotSeeded` true on the first invocation.

- [ ] **Step 3: Manual chat smoke test (local)**

Open `@PharosWatchBot` in a test account and run:

- `/start` — should see new copy including `/status` callout
- `/status USDC` — should return the compact card
- `/subscribe dews USDC` — should subscribe; on the next dispatch, the DM should carry snooze buttons
- Tap `Snooze 1h` — should see toast, `/list` should show no snoozed state but the next cron run should be skipped
- `/mute 22-07` — reply should read `22:00–07:00 UTC`
- `/cancel` after a pending ticker — reply should read "Pending selection cancelled."

Document any anomalies back in this plan file as a follow-up.

- [ ] **Step 4: Deploy to production**

Follow the project's standard wrangler deploy flow. After deploy, re-run the webhook registration:

```bash
TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... scripts/register-telegram-webhook.sh
```

Expected: `OK: Webhook was set`.

- [ ] **Step 5: Post-deploy verification**

```bash
curl -sS "https://api.pharos.watch/api/telegram-pulse" | jq .
```

Then open `/status` in the admin dashboard and verify the `telegramBot` block shows `chatsSuppressedBySnooze` among the new metrics (it will usually be 0 until users start using buttons).

- [ ] **Step 6: Final commit for any follow-up notes**

```bash
git add agents/plans/2026-04-17-telegram-bot-comprehensive-audit-plan.md
git commit -m "chore(plan): record post-deploy findings"
```

---

## Verification Matrix

| Phase | Ship gate |
|-------|-----------|
| 1 | `npm test -- worker` passes; `cd worker && npx tsc --noEmit`; no user-visible change except `/cancel` wording and script output |
| 2 | Snapshot tests updated; manual eyeball of one DEWS / depeg / safety alert in test chat |
| 3 | `npm run dev` renders `/telegram` without console warnings; Lighthouse accessibility ≥ prior |
| 4 | `/status USDC` returns a complete card; snooze buttons fire a callback and persist `alert_snooze_until_ts`; migration 0098 applied; dispatcher suppresses snoozed chats |

## Not in scope (reminder)

- `/pause`, `/history`, `/mute` toggle
- Dynamic smart-subscribe (Option B from feasibility research)
- Reactive wizard redesign of `/subscribe`
- One-time re-engagement DM
- Any dispatcher refactor beyond the snooze filter
