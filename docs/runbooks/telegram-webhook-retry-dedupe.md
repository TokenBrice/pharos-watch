# Runbook: Telegram Webhook Retry and Dedupe Incidents

## Symptom

A user sends a command or taps a callback, Telegram retries the webhook, but the command appears to disappear or a group setup flow loses state.

Detection signals:

- User reports a missing `/subscribe`, `/settings`, setup wizard, or callback action.
- Cloudflare logs show `POST /api/telegram-webhook` for the chat around the incident.
- The webhook returned `200 ok`, but the expected D1 mutation is absent.
- The webhook returned `503 retry` with `Retry-After` for an update already being processed.
- `telegram_processed_updates` shows a row stuck in `processing` or repeated `failed` state for the reported `update_id`.

## Current Dedupe Model

The webhook stores per-update claims in `telegram_processed_updates`. It inserts a `processing` row before command handling and marks it `processed` only after successful or terminal handled completion. Duplicate processed updates are ignored with `200 ok`, while failed or stale `processing` rows can be reclaimed without a global high-watermark drop.

If Telegram redelivers the same update while the original invocation is still fresh and `processing`, the webhook returns `503 retry` plus `Retry-After` instead of acknowledging it. This keeps Telegram's retry loop alive if the original invocation dies before marking the row `processed` or `failed`. Logs use the `processed-update-dedupe` action for these in-flight duplicates.

Processed-update rows are retained for 7 days. Claimed webhook traffic opportunistically runs a cache-guarded prune at most every 6 hours under `telegram:processed-updates:prune:last-run`; successful passes log `processed-update-prune` with the row count.

## Quick Diagnostic Checklist

1. **Confirm webhook auth.** Invalid `X-Telegram-Bot-Api-Secret-Token` requests intentionally return `200 ok` without side effects. Check logs for secret-validation failures.
2. **Inspect the processed-update row.**

   ```bash
   npx wrangler d1 execute stablecoin-db --remote --command \
     "SELECT update_id, received_at, processed_at, update_type, chat_id, status, error_class FROM telegram_processed_updates WHERE update_id = <updateId>;"
   ```

3. **Check pending command state for the chat.**

   ```bash
   curl -H "CF-Access-Client-Id: $CF_ID" \
        -H "CF-Access-Client-Secret: $CF_SECRET" \
        -H "X-Pharos-Admin: 1" \
        https://ops-api.pharos.watch/api/admin-telegram-chat/<chatId>
   ```

4. **Determine whether retry is safe.** Subscribe/unsubscribe/settings commands are idempotent enough for the user to resend. Ambiguous ticker replies and setup wizard callbacks may require clearing stale `telegram_pending_disambiguation` state first. A recent `processing` row should be left alone until its five-minute stale window expires unless you know the original Worker invocation has crashed.

## Remediation

1. **Ask the user to resend when possible.** This is safest for ambiguous flows because Telegram will issue or retry a concrete update while the command state is fresh.
2. **Clear stale pending state only for the affected chat** if the user is stuck in a disambiguation or setup flow. Use the admin chat view to confirm the stale row before deleting through a targeted D1 command.
3. **Repair a stuck claim narrowly.** If a row is stuck in `processing` after the Worker failed before terminal handling, wait for the stale window when possible. If manual repair is needed, mark that specific `update_id` as `failed` or delete that one row so Telegram/user retry can process it. Do not clear the whole table.
4. **Watch logs for duplicate command effects.** If duplicates occur, repair the affected chat state directly rather than broad-clearing subscriber data.

## Cross-References

- [`docs/telegram-alerts.md`](../telegram-alerts.md) section Update Deduplication.
- [`telegram-no-delivery.md`](./telegram-no-delivery.md) for alert-delivery incidents.
- [`../incident-response/telegram-secret-rotation.md`](../incident-response/telegram-secret-rotation.md) for secret overlap issues.
