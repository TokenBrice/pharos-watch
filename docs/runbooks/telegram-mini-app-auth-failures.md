# Runbook: Telegram Mini App Auth Failures

## Symptom

`mini_app_session_invalid` usage events spike in `telegram_usage_daily`, or users report that the Mini App opens but every mutation fails with "session expired, please relaunch from Telegram".

Detection signals:

- `telegram_usage_daily` shows authenticated `event_type = 'mini_app_session_invalid'` rows climbing relative to the prior day's baseline. The `outcome` column distinguishes `stale-auth` (expired but signature-valid sessions) from `rate_limited` (per-user cooldown exceeded); these are the only two outcomes written as `mini_app_session_invalid` rows. Body-size (`413`) and schema (`400 validation-error`) failures return immediately without a D1 write and are visible only in Worker logs. Invalid signatures and malformed signed auth are intentionally not written to usage analytics because no trusted Telegram user or chat context exists yet.
- The Mini App pulse strip (`/api/telegram-pulse`) shows `miniAppSessionsToday` flat or falling. Its `miniAppDeniedToday` counter tracks post-auth mutation denials (`mini_app_mutation_denied`) only and does not move for a session/auth-failure spike; use the `event_type = 'mini_app_session_invalid'` query below for that signal.
- Cloudflare logs for `POST /api/telegram-mini-app/mutate` return `401` with `code = "stale-auth"` across many distinct user IDs in a short window.
- Wrangler tail shows `POST /api/telegram-mini-app/session` or `/mutate` returning `401` for `stale-auth` or `validation-error` repeatedly.

## Quick Diagnostic Checklist

1. **Bot token rotation gap?** Cross-check with [`telegram-secret-rotation.md`](./telegram-secret-rotation.md). If `TELEGRAM_BOT_TOKEN` was rotated in the last 24 hours and `TELEGRAM_BOT_TOKEN_PREVIOUS` is unset or wrong, `initData` signed by the prior token will fail validation for the rest of its 24-hour read window. This is the single most common cause of a sudden `mini_app_session_invalid` spike.
2. **Stale clients?** A flat 5-minute spike across a single coin or alert that just dispatched usually means many users tapped a long-lived deep link whose `auth_date` is older than 5 minutes. Mutations require a fresh launch; reads still work. The Mini App's "relaunch from Telegram" affordance is the intended remedy.
3. **Invalid signatures?** Use Worker logs and HTTP response codes, not `telegram_usage_daily`, for invalid-signature / invalid-auth volume. Those failures point to malformed launch data, token mismatch outside a rotation overlap, or tampered payloads; no mutation reaches D1 before HMAC validation succeeds.
4. **Worker degradation?** Confirm the `dispatch-telegram-alerts` lane is healthy via [`telegram-no-delivery.md`](./telegram-no-delivery.md). A failing Mini App pulse loader can present as auth failures in the UI when the page never receives a fresh state.

## Operator Commands

Read the per-outcome event split:

```sql
SELECT
  day,
  outcome,
  failure_class,
  SUM(count) AS events
FROM telegram_usage_daily
WHERE event_type = 'mini_app_session_invalid'
  AND day >= date('now', '-7 days')
GROUP BY day, outcome, failure_class
ORDER BY day DESC, events DESC;
```

Confirm the bot-token rotation state:

```bash
cd worker
npx wrangler secret list
# Expect TELEGRAM_BOT_TOKEN and (during overlap) TELEGRAM_BOT_TOKEN_PREVIOUS.
```

If `TELEGRAM_BOT_TOKEN_PREVIOUS` is missing during a rotation overlap, set it to the prior token and redeploy per [`telegram-secret-rotation.md`](./telegram-secret-rotation.md).

Check the Mini App pulse and Worker cron health:

```bash
curl -sS -H "Referer: https://pharos.watch/" https://pharos.watch/_site-data/telegram-pulse | jq '{miniAppSessionsToday, miniAppMutationsToday, miniAppDeniedToday, miniAppReplayClaimsToday}'
curl -sS -H "CF-Access-Client-Id: $CF_ID" \
        -H "CF-Access-Client-Secret: $CF_SECRET" \
        https://ops-api.pharos.watch/api/status | jq '.telegramBot'
```

Tail the Worker for live signal:

```bash
cd worker
npx wrangler tail stablecoin-api --format pretty
```

## Remediation

1. **Bot-token rotation gap.** Set `TELEGRAM_BOT_TOKEN_PREVIOUS` to the prior token and redeploy. Sessions signed by either token will validate during the overlap.
2. **Stale clients.** No operator action. The Mini App's existing "session expired" UI tells users to relaunch from Telegram, which is the intended recovery path.
3. **Invalid signatures or malformed auth.** No mutation lands in D1 before HMAC validation succeeds. If the count persists outside a rotation window, inspect recent launch-link changes and Telegram client reports before changing backend auth rules.
4. **Worker degradation.** Follow [`telegram-no-delivery.md`](./telegram-no-delivery.md); auth failures should clear once the dispatcher recovers and the Mini App pulse loader returns fresh state.

## Cross-References

- [`docs/telegram-mini-app.md`](../telegram-mini-app.md) — auth model, freshness windows, mutation cooldowns.
- [`telegram-secret-rotation.md`](./telegram-secret-rotation.md) — bot-token and webhook-secret rotation contract.
- [`telegram-no-delivery.md`](./telegram-no-delivery.md) — broader Telegram dispatch diagnostics.
- [`telegram-operator-queries.md`](./telegram-operator-queries.md) — D1 query patterns for usage analytics.
