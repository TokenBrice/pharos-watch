# Runbook: Telegram Group Admin Gating Rollback

## Symptom

The group admin gate is too aggressive in production: legitimate group admins are being refused on `/subscribe`, `/unsubscribe`, `/set`, `/settings`, `/mute`, `/unmutehours`, `/unsnooze`, or `/timezone`, or the fresh `getChatMember` admin lookup is failing closed across many groups.

The gate's enforcement mode lives behind the `TELEGRAM_GROUP_ADMIN_GATING` env toggle in `worker/src/api/telegram-webhook.ts`. The two modes are documented in [`docs/telegram-alerts.md`](../telegram-alerts.md#group-admin-gating); summary:

- **Hard (default, env unset):** non-admin invocations are refused; the dispatch does not run.
- **Soft (emergency rollback):** non-admin invocations get the same warning copy but the command still runs.

Both modes emit a `group_admin_denial` usage event in `telegram_usage_daily` with `outcome = "denied"` (hard) or `outcome = "warned"` (soft) so the rollback toggle is observable from the audit log.

## When to Flip to Soft

Flip to `"soft"` only when:

- A bug in `getChatMember` admin classification (or a Telegram-side outage of the admin-lookup API) is denying real admins across many distinct groups, and
- The fresh-lookup path cannot be fixed in the deploy window, and
- The cost of running mutations from non-admins (a chat member overwriting subscription state) is judged smaller than the cost of every gated command failing.

The soft mode is an escape hatch, not a feature. The expected return path is to fix the upstream cause and flip the gate back to hard within one deploy cycle.

## Operator Commands

Confirm the current mode is what production is running:

```bash
cd worker
npx wrangler secret list
# TELEGRAM_GROUP_ADMIN_GATING set to "soft" → soft mode.
# Unset or any other value → hard mode (default).
```

Confirm the audit-log split before and after the flip:

```sql
SELECT day, outcome, COUNT(*) AS events
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

1. **Flip to soft.** Set the env secret, then follow the standard Worker Versions release flow documented in [deployment-process.md](../deployment-process.md) so the candidate is uploaded, preview-smoked, promoted, and triggers are deployed through the normal path.

   ```bash
   cd worker
   npx wrangler secret put TELEGRAM_GROUP_ADMIN_GATING
   # paste: soft
   ```

   Verify the next gated command in a non-admin group produces a `warned` row in `telegram_usage_daily` and that the command actually ran (subscribe row written, settings panel rendered, etc.).

2. **Flip back to hard.** Once the upstream cause is fixed, remove the env secret and use the same Worker Versions release flow.

   ```bash
   cd worker
   npx wrangler secret delete TELEGRAM_GROUP_ADMIN_GATING
   ```

   Confirm that the next gated command from a non-admin produces a `denied` row in `telegram_usage_daily` and that the command did not run.

3. **Audit during the soft window.** Pull the `group_admin_denial` events with `outcome = "warned"` to see which non-admins ran mutations during the rollback, in case any subscriber rows need a manual reset.

## Cross-References

- [`docs/telegram-alerts.md`](../telegram-alerts.md) section "Group Admin Gating" — full contract for both modes and the fresh `getChatMember` check.
- [`docs/telegram-mini-app.md`](../telegram-mini-app.md) — group/supergroup read-only behavior in the Mini App.
- [`telegram-operator-queries.md`](./telegram-operator-queries.md) — D1 queries for usage analytics.
- [`telegram-no-delivery.md`](./telegram-no-delivery.md) — broader Telegram dispatch diagnostics.
