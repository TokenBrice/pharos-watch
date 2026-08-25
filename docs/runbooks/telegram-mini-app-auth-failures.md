# Runbook: Telegram Mini App Auth Failures

## Symptom

`mini_app_session_invalid` usage events spike in `telegram_usage_daily`, or users report that the Mini App opens but every mutation fails with "session expired, please relaunch from Telegram".

Detection signals:

- `telegram_usage_daily` shows authenticated `event_type = 'mini_app_session_invalid'` rows climbing relative to the prior day's baseline. Those rows come from the session-read endpoint; the `outcome` column distinguishes `stale-auth` (expired but signature-valid sessions) from `rate_limited` (per-user cooldown exceeded). A stale-but-signed **mutation** attempt is written as `mini_app_mutation_denied` with `failure_class = 'stale-auth'` and a normalized operation label in `action_detail` (`coin`, `preset`, `quiet_hours`, `chat`, `recap`, …, not the raw operation kind), keeping the TGB-022 stale-auth mutation-denial ratio separable from session-read expiry. Repeat stale attempts inside the 5-second per-user auth-failure cooldown return `429 rate-limited` with no D1 write, so these counts undercount total stale attempts during a spike. Body-size (`413`) and schema (`400 validation-error`) failures return immediately without a D1 write and are visible only in Worker logs. Invalid signatures and malformed signed auth are intentionally not written to usage analytics because no trusted Telegram user or chat context exists yet.
- The Mini App pulse strip (`/api/telegram-pulse`) shows `miniAppSessionsToday` flat or falling. Its `miniAppDeniedToday` counter tracks post-auth mutation denials (`mini_app_mutation_denied`, including the `stale-auth` failure class) and does not move for a session-read auth-failure spike; use the `event_type = 'mini_app_session_invalid'` query below for that signal.
- A high share of `mini_app_mutation_denied` rows with `failure_class = 'rate_limited'` means authenticated users or scripts exhausted the Pharos mutation budget. The server allows 12 mutation attempts per Telegram user in a 30-second window anchored to the first admitted write; this signal is distinct from Telegram Bot API delivery rate limits.
- Cloudflare logs for `POST /api/telegram-mini-app/mutate` return `401` with `code = "stale-auth"` across many distinct user IDs in a short window.
- Wrangler tail shows `POST /api/telegram-mini-app/session` or `/mutate` returning `401` for `stale-auth` or `validation-error` repeatedly.

## Quick Diagnostic Checklist

1. **Bot token rotation gap?** Cross-check with [`telegram-secret-rotation.md`](./telegram-secret-rotation.md). If `TELEGRAM_BOT_TOKEN` was rotated and `TELEGRAM_BOT_TOKEN_PREVIOUS` is unset or wrong, prior-token `initData` fails signature validation before any trusted user context exists. Expect `401` responses and Worker-log evidence, but no increase in `mini_app_session_invalid` analytics from those rejected signatures.
2. **Stale clients?** A flat 5-minute spike across a single coin or alert that just dispatched usually means many users tapped a long-lived deep link whose `auth_date` is older than 5 minutes. Mutations require a fresh launch; reads still work. The Mini App's "relaunch from Telegram" affordance is the intended remedy.
3. **Invalid signatures?** Use Worker logs and HTTP response codes, not `telegram_usage_daily`, for invalid-signature / invalid-auth volume. Those failures point to malformed launch data, token mismatch outside a rotation overlap, or tampered payloads; no mutation reaches D1 before HMAC validation succeeds.
4. **Mini App request path degraded?** Inspect the session/mutation HTTP handlers and Pages pulse proxy separately. Telegram dispatch health does not authenticate Mini App requests and is not an auth remediation step.

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

Measure stale-auth mutation denials by operation kind (TGB-022):

```sql
SELECT
  day,
  action_detail,
  SUM(count) AS denials
FROM telegram_usage_daily
WHERE event_type = 'mini_app_mutation_denied'
  AND failure_class = 'stale-auth'
  AND day >= date('now', '-7 days')
GROUP BY day, action_detail
ORDER BY day DESC, denials DESC;
```

Measure the aggregate Pharos mutation-limit ratio before changing the budget:

```sql
WITH mini_app_writes AS (
  SELECT
    SUM(CASE
      WHEN event_type = 'mini_app_mutation_denied'
       AND failure_class = 'rate_limited'
      THEN count ELSE 0 END) AS rate_limited,
    SUM(CASE
      WHEN (
        event_type IN (
          'mini_app_mutation',
          'mini_app_recommended_setup',
          'mini_app_coin_add',
          'mini_app_coin_remove',
          'mini_app_quiet_hours',
          'mini_app_recap',
          'mini_app_snooze',
          'mini_app_coin_snooze',
          'mini_app_forget'
        )
        OR (
          event_type IN ('timezone_change', 'unsubscribe')
          AND source_category IN ('startapp', 'menu_or_main_app')
        )
      ) AND outcome = 'success'
      THEN count ELSE 0 END) AS successful
  FROM telegram_usage_daily
  WHERE day >= date('now', '-7 days')
)
SELECT
  rate_limited,
  successful,
  ROUND(100.0 * rate_limited / NULLIF(rate_limited + successful, 0), 2) AS rate_limited_pct
FROM mini_app_writes;
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
2. **Stale clients.** No operator action. The Mini App's stale-auth banner offers a one-tap "Relaunch and keep this panel" button (a `?startapp=` deep link back to the user's current panel) when `openTelegramLink` is available, and close-and-reopen copy otherwise; relaunching from Telegram is the intended recovery path.
3. **Invalid signatures or malformed auth.** No mutation lands in D1 before HMAC validation succeeds. If the count persists outside a rotation window, inspect recent launch-link changes and Telegram client reports before changing backend auth rules.
4. **Request-path or pulse degradation.** Diagnose the Mini App session/mutation endpoints and the pulse loader independently. Follow [`telegram-no-delivery.md`](./telegram-no-delivery.md) only when alert delivery is also failing; dispatcher recovery does not make an invalid or stale Mini App session valid.

## Cross-References

- [`docs/telegram-mini-app.md`](../telegram-mini-app.md) — auth model, freshness windows, and mutation burst budget.
- [`telegram-secret-rotation.md`](./telegram-secret-rotation.md) — bot-token and webhook-secret rotation contract.
- [`telegram-no-delivery.md`](./telegram-no-delivery.md) — broader Telegram dispatch diagnostics.
- [`telegram-operator-queries.md`](./telegram-operator-queries.md) — D1 query patterns for usage analytics.
