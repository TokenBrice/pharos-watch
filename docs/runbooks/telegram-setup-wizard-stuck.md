# Runbook: Telegram Setup Wizard Stuck

## Symptom

Users report that the `/start` setup wizard does not progress: tapping a branch button (Recommended / Custom / Skip) either re-renders the intro keyboard or returns "Setup expired. Send /start to begin again."

Detection signals:

- Users open `/start`, tap a branch button, and see no state change in the chat.
- The chat is on a fresh slash command but the dispatcher behaves as if a non-expired `telegram_pending_disambiguation` row with `action_type = "setup-step"` still owns the flow.
- The chat has no other pending state (no bulk confirm, no ticker disambiguation), yet a non-expired `setup-step` row still owns the flow. Any slash command from the initiating user clears the wizard, except on the `awaiting-ticker` step, where a single-token slash reply such as `/USDC` — or `/help` — is consumed as ticker input and leaves the row in place (`/cancel` and `/start` stay command escapes there). Only `/cancel` clears the wizard with an explicit "Setup cancelled." reply.

The wizard persists state in `telegram_pending_disambiguation` with `action_type = "setup-step"` and a 5-minute TTL. Ingress ignores expired rows; the scheduled `telegram-disambiguation-cleanup` job removes them only after an additional grace window so cleanup does not race slow users.

## Quick Diagnostic Checklist

1. **Is the cleanup pass running?** `crons["telegram-disambiguation-cleanup"].lastRun` should be recent (within the 5-minute slot). The pass emits `disambiguationRowsCleaned` in its metadata.
2. **Is the row genuinely still active?** A row with `expires_at < unixepoch()` should be ignored by the wizard. Active rows (`expires_at > unixepoch()`) can still own the setup flow until they expire or `/start` clears them.
3. **Is the user spamming `/start`?** Each `/start` from the user who owns the pending row clears wizard state and re-issues the intro, so a single stuck user is usually a stale row, not a race. A `/start` from a different user while that row is still live gets the pending-ownership conflict reply instead and leaves the row untouched.

## Operator Commands

Find stuck setup-step rows:

```sql
SELECT chat_id, action_type, expires_at, action_payload
FROM telegram_pending_disambiguation
WHERE action_type = 'setup-step'
  AND expires_at < unixepoch() - 600
ORDER BY expires_at ASC;
```

Confirm the disambiguation cleanup is current:

```bash
curl -sS -H "CF-Access-Client-Id: $CF_ID" \
        -H "CF-Access-Client-Secret: $CF_SECRET" \
        https://ops-api.pharos.watch/api/status \
  | jq '.crons["telegram-disambiguation-cleanup"]'
```

Inspect the wizard handler if behavior diverges from the documented flow:

```bash
worker/src/api/telegram-webhook-setup.ts
# Specifically: sendWizardIntro, wizard branch/target/confirm callbacks
```

## Remediation

1. **Stale rows past TTL.** Delete the stuck row for the affected chat. The wizard will re-issue a fresh intro on the next `/start`:

   ```sql
   DELETE FROM telegram_pending_disambiguation
   WHERE chat_id = '<chat_id>'
     AND action_type = 'setup-step'
     AND expires_at < unixepoch() - 600;
   ```

   Use `wrangler d1 execute` with the Worker D1 binding. This is the same cleanup the scheduled pass performs; running it manually is safe and idempotent.

2. **Cleanup pass failing.** If multiple chats are stuck and the cleanup pass shows `status = "error"` or has not run recently, force a single sweep via the next cron tick (no separate admin endpoint exists) and follow [`telegram-no-delivery.md`](./telegram-no-delivery.md) for the cron lane.

3. **User reports per-chat lockup with no stale row.** Suspect a bug in the wizard branch dispatcher rather than a stuck row. Capture the chat ID, the `action_payload` JSON, and a Wrangler tail snippet of the failing webhook delivery before clearing the row, and file a follow-up so the bug can be reproduced.

## Cross-References

- [`docs/telegram-alerts.md`](../telegram-alerts.md) section "Setup Wizard" — wizard state, callback namespace, TTL.
- [`docs/telegram-mini-app.md`](../telegram-mini-app.md) — Mini App `setup_recommended` payload and the equivalent `recommended-setup` mutation.
- [`telegram-operator-queries.md`](./telegram-operator-queries.md) — D1 queries for pending rows, jobs, and dead letters.
- [`telegram-no-delivery.md`](./telegram-no-delivery.md) — cron lane diagnostics.
