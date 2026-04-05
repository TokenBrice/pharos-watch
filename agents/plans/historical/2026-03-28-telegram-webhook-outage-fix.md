# Telegram Webhook Outage Fix Plan

## Problem

Production outbound Telegram delivery is healthy, but inbound webhook activity appears stalled:

- `cache("telegram:last-update-id")` last updated at `2026-03-25 21:01:36 UTC`
- `telegram_subscribers.last_active_at` has the same latest timestamp
- `/api/health` still reports recent `telegram-api` success and recent alert dispatches

This points to a webhook ingress/registration problem rather than a Telegram send failure.

## Most Likely Root Cause

Telegram webhook secret drift. If Telegram is still posting updates with an old `secret_token` while the Worker secret changed, the webhook handler intentionally returns `200 ok` with no side effects. That leaves the bot silent without surfacing a Telegram delivery error.

## Fix

1. Add a Worker-side webhook reconciliation helper that periodically calls Telegram `setWebhook` using the live `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, and `SELF_URL`.
2. Run that reconciliation from the dedicated five-minute Telegram cron lane with a cache-backed TTL so it self-heals secret/url drift after deploy without manual operator intervention.
3. Add focused tests around the reconciliation guardrails.
4. Update Telegram docs to reflect the new self-healing webhook registration behavior.
