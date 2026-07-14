# Runbook: Telegram Group Admin Gating Rollback

## Symptom

The group admin gate is too aggressive in production: legitimate group admins are being refused on `/subscribe`, `/unsubscribe`, `/set`, `/mute`, `/pause`, `/unmutehours`, `/unsnooze`, `/import`, or `/timezone <tz>` (`/timezone` is only gated when given a timezone argument; bare `/timezone` reads are not) after a fresh `getChatMember` admin lookup fails closed across many groups. (Note: the soft toggle below only relaxes these gated commands. Mutating `/settings` inline callbacks are always hard-gated for non-admins regardless of the toggle, and require a separate code change to relax.)

The gate's enforcement mode is currently a code-level toggle in `worker/src/api/telegram-webhook.ts`, not a production env binding. The two modes are documented in [`docs/telegram-alerts.md`](../telegram-alerts.md#group-admin-gating); summary:

- **Hard (current code default):** non-admin invocations are refused; the dispatch does not run.
- **Soft (emergency rollback):** non-admin invocations get the same warning copy but the command still runs.

For gated commands, hard mode emits a `group_admin_denial` usage event in `telegram_usage_daily` with `outcome = "denied"`, and soft mode emits the same event with `outcome = "warned"`, so the rollback toggle is observable from the audit log. (Settings-callback denials always emit `outcome = "denied"` regardless of the toggle.)

## When to Flip to Soft

Flip to `"soft"` only when:

- A bug in `getChatMember` admin classification (or a Telegram-side outage of the admin-lookup API) is denying real admins across many distinct groups, and
- The fresh-lookup path cannot be fixed in the deploy window, and
- The cost of running mutations from non-admins (a chat member overwriting subscription state) is judged smaller than the cost of every gated command failing.

The soft mode is an escape hatch, not a feature. The expected return path is to fix the upstream cause and flip the gate back to hard within one deploy cycle.

## Operator Commands

Confirm the audit-log split before and after the flip:

```sql
SELECT day, outcome, SUM(count) AS events
FROM telegram_usage_daily
WHERE event_type = 'group_admin_denial'
  AND day >= date('now', '-7 days')
GROUP BY day, outcome
ORDER BY day DESC, outcome ASC;
```

Hard mode emits `outcome = "denied"`; soft mode emits `outcome = "warned"`. After the flip, expect the same rows to show the new outcome.

Tail the Worker during the rollback window to confirm the new mode is taking effect:

```bash
cd worker
npx wrangler tail stablecoin-api --format pretty
```

## Remediation

1. **Flip to soft.** Patch the group-admin gating mode in `worker/src/api/telegram-webhook.ts`, then follow the standard protected release flow documented in [deployment-process.md](../deployment-process.md). That workflow applies migrations, deploys the Worker once with the checked-in configuration, and verifies full activation. A Wrangler secret change alone will not affect production because no `TELEGRAM_GROUP_ADMIN_GATING` env binding is read today.

   Verify the next gated command in a non-admin group produces a `warned` row in `telegram_usage_daily` and that the command actually ran (subscribe row written, settings panel rendered, etc.).

2. **Flip back to hard.** Once the upstream cause is fixed, restore the code-level mode to hard/default and use the same protected release flow.

   Confirm that the next gated command from a non-admin produces a `denied` row in `telegram_usage_daily` and that the command did not run.

3. **Audit during the soft window.** Pull the `group_admin_denial` events with `outcome = "warned"` to see which non-admins ran mutations during the rollback, in case any subscriber rows need a manual reset.

## Cross-References

- [`docs/telegram-alerts.md`](../telegram-alerts.md) section "Group Admin Gating" — full contract for both modes and the fresh `getChatMember` check.
- [`docs/telegram-mini-app.md`](../telegram-mini-app.md) — group/supergroup read-only behavior in the Mini App.
- [`telegram-operator-queries.md`](./telegram-operator-queries.md) — D1 queries for usage analytics.
- [`telegram-no-delivery.md`](./telegram-no-delivery.md) — broader Telegram dispatch diagnostics.
