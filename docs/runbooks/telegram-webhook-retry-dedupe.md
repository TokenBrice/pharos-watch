# Runbook: Telegram Webhook Retry and Dedupe Incidents

## Symptom

A user sends a command or taps a callback, Telegram retries the webhook, but the command appears to disappear or a group setup flow loses state.

Detection signals:

- User reports a missing `/subscribe`, `/settings`, setup wizard, or callback action.
- Sampled Cloudflare request logs show `POST /api/telegram-webhook` near the reported time; chat/update association comes from D1, not custom Telegram logs.
- The webhook returned `200 ok`, but the expected D1 mutation is absent.
- The webhook returned `503 retry` with `Retry-After` for an update already being processed.
- `telegram_processed_updates` shows a row stuck in `processing` or repeated `failed` state for the reported `update_id`.

## Current Dedupe Model

The webhook stores per-update claims and a versioned normalized intent in `telegram_processed_updates`. Replay-safe D1 mutation and the `telegram_webhook_operation_mutations` marker commit in one batch. `effect_state = 'started'` is written only immediately before a Bot API call; a post-fence failure becomes `execution_unknown` and is never replayed automatically. Duplicate processed updates are ignored with `200 ok`, while failed or stale `unstarted`/`planned` work can be reclaimed without a global high-watermark drop.

If Telegram redelivers the same update while the original invocation is still fresh and `processing`, the webhook returns `503 retry` plus `Retry-After` instead of acknowledging it. This keeps Telegram's retry loop alive if the original invocation dies before marking the row `processed` or `failed`. Logs use the `processed-update-dedupe` action for these in-flight duplicates.

Ordinary processed-update rows are retained for 7 days; `started` and `execution_unknown` evidence remains for 90 days. Cleanup is owned by the daily `telegram-retention-cleanup` cron, which runs the capped processed-update prune with the rest of Telegram retention; webhook traffic does not run retention work.

## Quick Diagnostic Checklist

1. **Confirm webhook auth.** Invalid `X-Telegram-Bot-Api-Secret-Token` requests intentionally return `200 ok` without side effects. Check logs for secret-validation failures.
2. **Inspect the processed-update row.** Use [Processed Update](./telegram-operator-queries.md#processed-update) for the reported `update_id`, preserving its normalized-intent, mutation, and effect-fence fields.
3. **Check pending command state for the chat.** `GET /api/admin-telegram-chat/:chatId` was retired on 2026-08-09; use [Pending Command State](./telegram-operator-queries.md#pending-command-state) to read the disambiguation row it surfaced.

4. **Determine whether retry is safe.** A `failed` `unstarted`/`planned` row is reclaimed on the next redelivery; one still `processing` is reclaimed only after the five-minute stale window. Planned work uses its stored normalized intent. Never force-retry a `started` or `execution_unknown` row. First reconcile Telegram/user-visible state and the exact intent/mutation marker.

## Remediation

1. **Ask the user to resend when possible.** This is safest for ambiguous flows because Telegram will issue or retry a concrete update while the command state is fresh.
2. **Clear stale pending state only for the affected chat** if the user is stuck in a disambiguation or setup flow. Use the disambiguation query above to confirm the stale row before deleting through a targeted D1 command.
3. **Repair a stuck claim narrowly.** If an `unstarted`/`planned` row is stuck after the Worker failed before terminal handling, wait for stale takeover. Only delete or fail that one row when you have proven no effect started. Do not alter or delete `started`/`execution_unknown` evidence to make it replay, and do not clear the whole table.
4. **Watch logs for duplicate command effects.** If duplicates occur, repair the affected chat state directly rather than broad-clearing subscriber data.

## Cross-References

- [`docs/telegram-alerts.md`](../telegram-alerts.md) section Update Deduplication.
- [`telegram-no-delivery.md`](./telegram-no-delivery.md) for alert-delivery incidents.
